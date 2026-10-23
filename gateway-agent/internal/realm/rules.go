package realm

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"time"
)

type Rule struct {
	BindingID  string   `json:"binding_id"`
	ListenPort int      `json:"listen_port"`
	TargetHost string   `json:"target_host"`
	TargetPort int      `json:"target_port"`
	Protocols  []string `json:"protocols"`
	ExpiresAt  string   `json:"expires_at"`
}

type endpoint struct {
	Listen string `json:"listen"`
	Remote string `json:"remote"`
}

type configFile struct {
	Network struct {
		NoTCP  bool `json:"no_tcp"`
		UseUDP bool `json:"use_udp"`
	} `json:"network"`
	Endpoints []endpoint `json:"endpoints"`
}

var bindingIDPattern = regexp.MustCompile(`\A[A-Za-z0-9_.-]+\z`)

func Apply(ctx context.Context, profile Profile, rule Rule) (resultErr error) {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := validateRule(rule); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(rule, "", "  ")
	if err != nil {
		return err
	}
	cfgRaw, err := json.MarshalIndent(configForRule(rule), "", "  ")
	if err != nil {
		return err
	}
	configPath := filepath.Join(instanceDir(profile, rule.BindingID), "config.json")
	previous, err := os.ReadFile(configPath)
	hadConfig := err == nil
	if err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("read previous instance config: %w", err)
	}
	changed := !hadConfig || !bytes.Equal(previous, cfgRaw)
	service := serviceName(profile, rule.BindingID)
	wasActive := false
	if !profile.DryRun {
		wasActive, err = serviceIsActive(ctx, service)
		if err != nil {
			return err
		}
		if wasActive && !hadConfig {
			return fmt.Errorf("cannot update active %s without its previous config", service)
		}
	}
	configWritten, serviceTouched := false, false
	defer func() {
		if resultErr == nil {
			return
		}
		// Rollback must survive shutdown, but must not delay exit indefinitely.
		cleanupCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), rollbackTimeout)
		defer cancel()
		if serviceTouched && !wasActive {
			if err := runSystemctl(cleanupCtx, "stop", service); err != nil {
				resultErr = errors.Join(resultErr, fmt.Errorf("stop failed new instance %s: %w", service, err))
			}
		}
		var restoreErr error
		if configWritten {
			if hadConfig {
				restoreErr = writeAtomic(configPath, previous, 0640)
			} else {
				restoreErr = os.Remove(configPath)
				if os.IsNotExist(restoreErr) {
					restoreErr = nil
				}
			}
			if restoreErr != nil {
				resultErr = errors.Join(resultErr, fmt.Errorf("restore instance config %s: %w", service, restoreErr))
			}
		}
		if serviceTouched && wasActive && restoreErr == nil {
			if err := runSystemctl(cleanupCtx, "restart", service); err != nil {
				resultErr = errors.Join(resultErr, fmt.Errorf("restore instance %s: %w", service, err))
			} else if active, err := serviceIsActive(cleanupCtx, service); err != nil || !active {
				resultErr = errors.Join(resultErr, fmt.Errorf("restored instance %s is not active: %v", service, err))
			}
		}
	}()
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.MkdirAll(profile.RulesDir, 0750); err != nil {
		return err
	}
	if err := os.MkdirAll(instanceDir(profile, rule.BindingID), 0750); err != nil {
		return err
	}
	if changed {
		if err := writeAtomic(configPath, cfgRaw, 0640); err != nil {
			return err
		}
		configWritten = true
	}
	if !profile.DryRun && (changed || !wasActive) {
		action := "start"
		if wasActive {
			action = "restart"
		}
		serviceTouched = true
		if err := runSystemctl(ctx, action, service); err != nil {
			return fmt.Errorf("systemctl %s %s: %w", action, service, err)
		}
		if active, err := serviceIsActive(ctx, service); err != nil {
			return err
		} else if !active {
			return fmt.Errorf("systemctl %s did not activate %s", action, service)
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	// Commit the desired rule only after the instance accepts its configuration.
	return writeAtomic(rulePath(profile, rule.BindingID), raw, 0640)
}

const systemctlTimeout = 10 * time.Second
const rollbackTimeout = 15 * time.Second

func runSystemctl(parent context.Context, args ...string) error {
	ctx, cancel := context.WithTimeout(parent, systemctlTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "systemctl", args...)
	cmd.WaitDelay = time.Second
	err := cmd.Run()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return err
}

func serviceIsActive(ctx context.Context, service string) (bool, error) {
	err := runSystemctl(ctx, "is-active", "--quiet", service)
	if err == nil {
		return true, nil
	}
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) && (exitErr.ExitCode() == 3 || exitErr.ExitCode() == 4) {
		return false, nil
	}
	return false, fmt.Errorf("systemctl is-active %s: %w", service, err)
}

func Delete(ctx context.Context, profile Profile, bindingID string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := validateBindingID(bindingID); err != nil {
		return err
	}
	if !profile.DryRun {
		service := serviceName(profile, bindingID)
		active, err := serviceIsActive(ctx, service)
		if err != nil {
			return err
		}
		if active {
			if err := runSystemctl(ctx, "stop", service); err != nil {
				return fmt.Errorf("systemctl stop %s: %w", service, err)
			}
		}
		_ = runSystemctl(ctx, "reset-failed", service)
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := os.RemoveAll(instanceDir(profile, bindingID)); err != nil {
		return err
	}
	if err := os.Remove(rulePath(profile, bindingID)); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func readRule(profile Profile, path string) (Rule, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Rule{}, err
	}
	var rule Rule
	if err := json.Unmarshal(raw, &rule); err != nil {
		return Rule{}, fmt.Errorf("decode %s: %w", path, err)
	}
	if err := validateRule(rule); err != nil {
		return Rule{}, fmt.Errorf("invalid rule %s: %w", path, err)
	}
	if path != rulePath(profile, rule.BindingID) {
		return Rule{}, fmt.Errorf("binding id does not match rule file %s", path)
	}
	return rule, nil
}

func CleanupExpired(ctx context.Context, profile Profile, now time.Time) ([]string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	files, err := filepath.Glob(filepath.Join(profile.RulesDir, "cg-*.json"))
	if err != nil {
		return nil, err
	}
	var removed []string
	var errs []error
	for _, file := range files {
		if err := ctx.Err(); err != nil {
			errs = append(errs, err)
			break
		}
		rule, err := readRule(profile, file)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		expiresAt, _ := time.Parse(time.RFC3339, rule.ExpiresAt)
		if now.Before(expiresAt) {
			continue
		}
		if err := Delete(ctx, profile, rule.BindingID); err != nil {
			errs = append(errs, fmt.Errorf("delete expired %s: %w", rule.BindingID, err))
			continue
		}
		removed = append(removed, rule.BindingID)
	}
	sort.Strings(removed)
	return removed, errors.Join(errs...)
}

func Reconcile(ctx context.Context, profile Profile) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	files, err := filepath.Glob(filepath.Join(profile.RulesDir, "cg-*.json"))
	if err != nil {
		return err
	}
	var errs []error
	for _, file := range files {
		if err := ctx.Err(); err != nil {
			errs = append(errs, err)
			break
		}
		rule, err := readRule(profile, file)
		if err != nil {
			errs = append(errs, err)
			continue
		}
		expiresAt, _ := time.Parse(time.RFC3339, rule.ExpiresAt)
		if !time.Now().Before(expiresAt) {
			continue
		}
		if err := Apply(ctx, profile, rule); err != nil {
			errs = append(errs, fmt.Errorf("reconcile %s: %w", rule.BindingID, err))
		}
	}
	return errors.Join(errs...)
}

func CountRules(profile Profile) int {
	files, _ := filepath.Glob(filepath.Join(profile.RulesDir, "cg-*.json"))
	return len(files)
}

func configForRule(rule Rule) configFile {
	var cfg configFile
	cfg.Network.NoTCP = !containsProtocol(rule.Protocols, "tcp")
	cfg.Network.UseUDP = containsProtocol(rule.Protocols, "udp")
	cfg.Endpoints = []endpoint{{
		Listen: fmt.Sprintf("0.0.0.0:%d", rule.ListenPort),
		Remote: fmt.Sprintf("%s:%d", rule.TargetHost, rule.TargetPort),
	}}
	return cfg
}

func containsProtocol(protocols []string, wanted string) bool {
	for _, protocol := range protocols {
		if protocol == wanted {
			return true
		}
	}
	return false
}

func validateBindingID(bindingID string) error {
	if bindingID == "." || bindingID == ".." || !bindingIDPattern.MatchString(bindingID) {
		return fmt.Errorf("invalid binding id %q", bindingID)
	}
	return nil
}

func validateRule(rule Rule) error {
	if err := validateBindingID(rule.BindingID); err != nil {
		return err
	}
	if rule.ListenPort < 1 || rule.ListenPort > 65535 || rule.TargetPort < 1 || rule.TargetPort > 65535 {
		return fmt.Errorf("invalid port for binding %s", rule.BindingID)
	}
	if rule.TargetHost == "" {
		return fmt.Errorf("target host is required for binding %s", rule.BindingID)
	}
	if _, err := time.Parse(time.RFC3339, rule.ExpiresAt); err != nil {
		return fmt.Errorf("invalid expiry for binding %s: %w", rule.BindingID, err)
	}
	if !containsProtocol(rule.Protocols, "tcp") && !containsProtocol(rule.Protocols, "udp") {
		return fmt.Errorf("binding %s has no supported protocols", rule.BindingID)
	}
	return nil
}

func writeAtomic(path string, raw []byte, mode os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, mode); err != nil {
		return err
	}
	defer os.Remove(tmp)
	if err := os.Chmod(tmp, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func rulePath(profile Profile, bindingID string) string {
	return filepath.Join(profile.RulesDir, "cg-"+bindingID+".json")
}

func instanceDir(profile Profile, bindingID string) string {
	return filepath.Join(profile.InstancesDir, bindingID)
}

func serviceName(profile Profile, bindingID string) string {
	return profile.ServicePrefix + bindingID + ".service"
}
