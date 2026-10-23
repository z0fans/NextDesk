package runner

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"nextdesk/gateway-agent/internal/api"
	"nextdesk/gateway-agent/internal/config"
	"nextdesk/gateway-agent/internal/probe"
	"nextdesk/gateway-agent/internal/realm"
)

type Runner struct {
	Config  config.Config
	Client  api.Client
	Profile realm.Profile
	Probes  *probe.Executor
}

func New(cfg config.Config, dryRun bool) (Runner, error) {
	profile, err := realm.NewProfile(cfg.RealmProfile, cfg.DryRunRoot, dryRun)
	if err != nil {
		return Runner{}, err
	}
	return Runner{
		Config:  cfg,
		Client:  api.New(cfg.BaseURL, cfg.AgentID, cfg.AgentToken),
		Profile: profile,
		Probes: probe.NewExecutor(cfg.AgentID, probe.Policy{
			AllowedPorts:      cfg.ProbeAllowedPortSet(),
			MaxConcurrency:    cfg.ProbeMaxConcurrency,
			Timeout:           time.Duration(cfg.ProbeTimeoutSeconds) * time.Second,
			MinTargetInterval: time.Duration(cfg.ProbeTargetMinIntervalMillis) * time.Millisecond,
			CacheTTL:          time.Duration(cfg.ProbeCacheSeconds) * time.Second,
		}),
	}, nil
}

func (r *Runner) Run(parent context.Context) error {
	ctx, cancel := context.WithCancel(parent)
	defer func() {
		cancel()
		r.Probes.Close()
	}()
	ticker := time.NewTicker(r.Config.PollInterval())
	defer ticker.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := r.cycle(ctx, func(result probe.Result) { _ = r.report(ctx, result) }); err != nil {
			log.Printf("gateway-agent cycle failed: %v", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (r *Runner) Once(parent context.Context) error {
	ctx, cancel := context.WithCancel(parent)
	defer func() {
		cancel()
		r.Probes.Close()
	}()
	var mu sync.Mutex
	var deliveryErr error
	cycleErr := r.cycle(ctx, func(result probe.Result) {
		if err := r.report(ctx, result); err != nil {
			mu.Lock()
			if deliveryErr == nil {
				deliveryErr = err
			}
			mu.Unlock()
		}
	})
	r.Probes.Wait()
	return errors.Join(cycleErr, ctx.Err(), deliveryErr)
}

func (r *Runner) report(ctx context.Context, result probe.Result) error {
	if err := r.Client.ProbeResult(ctx, result); err != nil {
		err = fmt.Errorf("probe result %s delivery failed: %w", result.ProbeID, err)
		log.Printf("gateway-agent %v", err)
		return err
	}
	return nil
}

func (r *Runner) cycle(ctx context.Context, report func(probe.Result)) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	removed, err := realm.CleanupExpired(ctx, r.Profile, time.Now())
	if err != nil {
		log.Printf("gateway-agent local expiry cleanup failed: %v", err)
	}
	if len(removed) > 0 {
		log.Printf("gateway-agent removed %d expired bindings", len(removed))
	}
	if err := realm.Reconcile(ctx, r.Profile); err != nil {
		log.Printf("gateway-agent reconcile failed: %v", err)
	}
	heartbeat, err := r.Client.Heartbeat(ctx, r.metrics())
	if err != nil {
		return err
	}
	tasks, err := r.Client.Poll(ctx)
	if err != nil {
		return err
	}
	var errs []error
	for _, task := range tasks {
		if err := ctx.Err(); err != nil {
			return errors.Join(append(errs, err)...)
		}
		if task.Action == "probe_target" {
			if task.Probe == nil {
				log.Printf("gateway-agent rejected malformed probe task")
				continue
			}
			if err := r.Probes.Submit(ctx, *task.Probe, heartbeat.ProbeTaskKey, report); err != nil {
				return errors.Join(append(errs, err)...)
			}
			continue
		}
		if task.Action == "cancel_probe" {
			if task.Probe != nil && !r.Probes.Cancel(task.Probe.ProbeID) {
				// A restarted Agent has no task to cancel; still acknowledge the requested terminal state.
				now := time.Now().UTC().Format(time.RFC3339Nano)
				report(probe.Result{
					ProbeID: task.Probe.ProbeID, Status: "cancelled", OutcomeCategory: "cancelled",
					StartedAt: now, CompletedAt: now, StageDurationsMS: map[string]int64{},
					DiagnosticCode: "probe_cancelled",
				})
			}
			continue
		}
		if task.Action != "create_binding" && task.Action != "delete_binding" {
			log.Printf("gateway-agent ignored unsupported task action %q", task.Action)
			continue
		}
		status, code, message := "active", "", ""
		if err := r.apply(ctx, task); err != nil {
			log.Printf("gateway-agent %s %s failed: %v", task.Action, task.BindingID, err)
			if ctx.Err() != nil {
				return errors.Join(append(errs, err)...)
			}
			if task.Action == "delete_binding" {
				errs = append(errs, err)
				continue
			}
			status, code, message = "failed", "apply_failed", err.Error()
		} else if task.Action == "delete_binding" {
			status = "closed"
		}
		if err := r.Client.Ack(ctx, task.BindingID, status, code, message); err != nil {
			err = fmt.Errorf("ack %s delivery failed: %w", task.BindingID, err)
			log.Printf("gateway-agent %v", err)
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (r *Runner) metrics() map[string]any {
	metrics := map[string]any{
		"profile":         r.Profile.Name,
		"active_bindings": realm.CountRules(r.Profile),
		"cpu_count":       runtime.NumCPU(),
		"goroutines":      runtime.NumGoroutine(),
	}
	if raw, err := os.ReadFile("/proc/loadavg"); err == nil {
		fields := strings.Fields(string(raw))
		if len(fields) >= 3 {
			if value, err := strconv.ParseFloat(fields[0], 64); err == nil {
				metrics["load_1m"] = value
			}
			if value, err := strconv.ParseFloat(fields[1], 64); err == nil {
				metrics["load_5m"] = value
			}
		}
	}
	if raw, err := os.ReadFile("/proc/meminfo"); err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			if !strings.HasPrefix(line, "MemAvailable:") {
				continue
			}
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				if value, err := strconv.ParseUint(fields[1], 10, 64); err == nil {
					metrics["memory_available_bytes"] = value * 1024
				}
			}
			break
		}
	}
	return metrics
}

func (r *Runner) apply(ctx context.Context, task api.Task) error {
	if task.Action == "delete_binding" {
		return realm.Delete(ctx, r.Profile, task.BindingID)
	}
	if task.Action != "create_binding" {
		return fmt.Errorf("unsupported binding action %q", task.Action)
	}
	return realm.Apply(ctx, r.Profile, realm.Rule{
		BindingID:  task.BindingID,
		ListenPort: task.ListenPort,
		TargetHost: task.TargetHost,
		TargetPort: task.TargetPort,
		Protocols:  task.Protocols,
		ExpiresAt:  task.ExpiresAt,
	})
}
