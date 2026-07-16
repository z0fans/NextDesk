package realm

import (
	"bytes"
	"encoding/json"
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

func Apply(profile Profile, rule Rule) error {
	if err := validateRule(rule); err != nil {
		return err
	}
	if err := os.MkdirAll(profile.RulesDir, 0750); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(rule, "", "  ")
	if err != nil {
		return err
	}
	if err := writeAtomic(rulePath(profile, rule.BindingID), raw, 0640); err != nil {
		return err
	}

	cfg := configForRule(rule)
	cfgRaw, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	instanceDir := instanceDir(profile, rule.BindingID)
	if err := os.MkdirAll(instanceDir, 0750); err != nil {
		return err
	}
	configPath := filepath.Join(instanceDir, "config.json")
	previous, _ := os.ReadFile(configPath)
	changed := !bytes.Equal(previous, cfgRaw)
	if changed {
		if err := writeAtomic(configPath, cfgRaw, 0640); err != nil {
			return err
		}
	}
	if profile.DryRun {
		return nil
	}

	service := serviceName(profile, rule.BindingID)
	if !changed && exec.Command("systemctl", "is-active", "--quiet", service).Run() == nil {
		return nil
	}
	action := "start"
	if exec.Command("systemctl", "is-active", "--quiet", service).Run() == nil {
		action = "restart"
	}
	if err := exec.Command("systemctl", action, service).Run(); err != nil {
		return fmt.Errorf("systemctl %s %s: %w", action, service, err)
	}
	return exec.Command("systemctl", "is-active", "--quiet", service).Run()
}

func Delete(profile Profile, bindingID string) error {
	if !bindingIDPattern.MatchString(bindingID) {
		return fmt.Errorf("invalid binding id %q", bindingID)
	}
	var stopErr error
	if !profile.DryRun {
		service := serviceName(profile, bindingID)
		if exec.Command("systemctl", "is-active", "--quiet", service).Run() == nil {
			if err := exec.Command("systemctl", "stop", service).Run(); err != nil {
				stopErr = fmt.Errorf("systemctl stop %s: %w", service, err)
			}
		}
		_ = exec.Command("systemctl", "reset-failed", service).Run()
	}
	if stopErr != nil {
		return stopErr
	}
	_ = os.Remove(rulePath(profile, bindingID))
	_ = os.RemoveAll(instanceDir(profile, bindingID))
	return nil
}

func CleanupExpired(profile Profile, now time.Time) ([]string, error) {
	files, err := filepath.Glob(filepath.Join(profile.RulesDir, "cg-*.json"))
	if err != nil {
		return nil, err
	}
	var removed []string
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			return removed, err
		}
		var rule Rule
		if err := json.Unmarshal(raw, &rule); err != nil {
			return removed, fmt.Errorf("decode %s: %w", file, err)
		}
		expiresAt, err := time.Parse(time.RFC3339, rule.ExpiresAt)
		if err != nil {
			return removed, fmt.Errorf("invalid expiry for %s: %w", rule.BindingID, err)
		}
		if now.Before(expiresAt) {
			continue
		}
		if err := Delete(profile, rule.BindingID); err != nil {
			return removed, err
		}
		removed = append(removed, rule.BindingID)
	}
	sort.Strings(removed)
	return removed, nil
}

func Reconcile(profile Profile) error {
	files, err := filepath.Glob(filepath.Join(profile.RulesDir, "cg-*.json"))
	if err != nil {
		return err
	}
	for _, file := range files {
		raw, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		var rule Rule
		if err := json.Unmarshal(raw, &rule); err != nil {
			return fmt.Errorf("decode %s: %w", file, err)
		}
		if err := Apply(profile, rule); err != nil {
			return err
		}
	}
	return nil
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

func validateRule(rule Rule) error {
	if !bindingIDPattern.MatchString(rule.BindingID) {
		return fmt.Errorf("invalid binding id %q", rule.BindingID)
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
	if err := os.Chmod(tmp, mode); err != nil {
		_ = os.Remove(tmp)
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
