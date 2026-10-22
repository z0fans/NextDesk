package runner

import (
	"context"
	"fmt"
	"log"
	"os"
	"runtime"
	"strconv"
	"strings"
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

func (r *Runner) Run(ctx context.Context) error {
	ticker := time.NewTicker(r.Config.PollInterval())
	defer ticker.Stop()
	for {
		if err := r.Once(); err != nil {
			log.Printf("gateway-agent cycle failed: %v", err)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

func (r *Runner) Once() error {
	removed, err := realm.CleanupExpired(r.Profile, time.Now())
	if err != nil {
		log.Printf("gateway-agent local expiry cleanup failed: %v", err)
	}
	if len(removed) > 0 {
		log.Printf("gateway-agent removed %d expired bindings", len(removed))
	}
	if err := realm.Reconcile(r.Profile); err != nil {
		log.Printf("gateway-agent reconcile failed: %v", err)
	}
	heartbeat, err := r.Client.Heartbeat(r.metrics())
	if err != nil {
		return err
	}
	tasks, err := r.Client.Poll()
	if err != nil {
		return err
	}
	for _, task := range tasks {
		if task.Action == "probe_target" {
			if task.Probe == nil {
				log.Printf("gateway-agent rejected malformed probe task")
				continue
			}
			r.Probes.Submit(*task.Probe, heartbeat.ProbeTaskKey, func(result probe.Result) {
				if err := r.Client.ProbeResult(result); err != nil {
					log.Printf("gateway-agent probe result %s delivery failed: %v", result.ProbeID, err)
				}
			})
			continue
		}
		if task.Action == "cancel_probe" {
			if task.Probe != nil && !r.Probes.Cancel(task.Probe.ProbeID) {
				log.Printf("gateway-agent probe %s was not active when cancellation arrived", task.Probe.ProbeID)
			}
			continue
		}
		if err := r.apply(task); err != nil {
			if task.Action == "delete_binding" {
				log.Printf("gateway-agent delete binding %s failed: %v", task.BindingID, err)
				continue
			}
			_ = realm.Delete(r.Profile, task.BindingID)
			_ = r.Client.Ack(task.BindingID, "failed", "apply_failed", err.Error())
			continue
		}
		if task.Action == "delete_binding" {
			_ = r.Client.Ack(task.BindingID, "closed", "", "")
		} else {
			_ = r.Client.Ack(task.BindingID, "active", "", "")
		}
	}
	return nil
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

func (r *Runner) apply(task api.Task) error {
	if task.Action == "delete_binding" {
		return realm.Delete(r.Profile, task.BindingID)
	}
	if task.Action != "create_binding" {
		return fmt.Errorf("unsupported binding action %q", task.Action)
	}
	return realm.Apply(r.Profile, realm.Rule{
		BindingID:  task.BindingID,
		ListenPort: task.ListenPort,
		TargetHost: task.TargetHost,
		TargetPort: task.TargetPort,
		Protocols:  task.Protocols,
		ExpiresAt:  task.ExpiresAt,
	})
}
