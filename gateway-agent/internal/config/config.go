package config

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	BaseURL                      string `json:"base_url"`
	AgentID                      string `json:"agent_id"`
	AgentToken                   string `json:"agent_token"`
	RealmProfile                 string `json:"realm_profile"`
	PollIntervalSeconds          int    `json:"poll_interval_seconds"`
	PublicHost                   string `json:"public_host"`
	PortRange                    string `json:"port_range"`
	DryRunRoot                   string `json:"dry_run_root"`
	ProbeAllowedPorts            []int  `json:"probe_allowed_ports"`
	ProbeMaxConcurrency          int    `json:"probe_max_concurrency"`
	ProbeTimeoutSeconds          int    `json:"probe_timeout_seconds"`
	ProbeTargetMinIntervalMillis int    `json:"probe_target_min_interval_ms"`
	ProbeCacheSeconds            int    `json:"probe_cache_seconds"`
}

func Load(path string) (Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return Config{}, err
	}
	if cfg.PollIntervalSeconds <= 0 {
		cfg.PollIntervalSeconds = 2
	}
	if cfg.RealmProfile == "" {
		cfg.RealmProfile = "cg"
	}
	if cfg.DryRunRoot == "" {
		cfg.DryRunRoot = "/tmp/connect-gateway-agent"
	}
	if len(cfg.ProbeAllowedPorts) == 0 {
		cfg.ProbeAllowedPorts = []int{22, 3389}
	}
	if cfg.ProbeMaxConcurrency <= 0 {
		cfg.ProbeMaxConcurrency = 4
	}
	if cfg.ProbeTimeoutSeconds <= 0 {
		cfg.ProbeTimeoutSeconds = 5
	}
	if cfg.ProbeTargetMinIntervalMillis <= 0 {
		cfg.ProbeTargetMinIntervalMillis = 1000
	}
	if cfg.ProbeCacheSeconds <= 0 {
		cfg.ProbeCacheSeconds = 45
	}
	if cfg.BaseURL == "" || cfg.AgentID == "" || cfg.AgentToken == "" {
		return Config{}, fmt.Errorf("base_url, agent_id and agent_token are required")
	}
	if _, _, err := cfg.PortBounds(); err != nil {
		return Config{}, err
	}
	if err := cfg.validateProbePolicy(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) PollInterval() time.Duration {
	return time.Duration(c.PollIntervalSeconds) * time.Second
}

func (c Config) PortBounds() (int, int, error) {
	parts := strings.Split(c.PortRange, "-")
	if len(parts) != 2 {
		return 0, 0, fmt.Errorf("port_range must look like 42000-42999")
	}
	start, err := strconv.Atoi(parts[0])
	if err != nil {
		return 0, 0, err
	}
	end, err := strconv.Atoi(parts[1])
	if err != nil {
		return 0, 0, err
	}
	if start < 1 || end > 65535 || start > end {
		return 0, 0, fmt.Errorf("invalid port_range %q", c.PortRange)
	}
	return start, end, nil
}

func (c Config) ProbeAllowedPortSet() map[int]bool {
	ports := make(map[int]bool, len(c.ProbeAllowedPorts))
	for _, port := range c.ProbeAllowedPorts {
		ports[port] = true
	}
	return ports
}

func (c Config) validateProbePolicy() error {
	for _, port := range c.ProbeAllowedPorts {
		if port < 1 || port > 65535 {
			return fmt.Errorf("invalid probe_allowed_ports entry %d", port)
		}
	}
	if c.ProbeMaxConcurrency < 1 || c.ProbeMaxConcurrency > 32 {
		return fmt.Errorf("probe_max_concurrency must be between 1 and 32")
	}
	if c.ProbeTimeoutSeconds < 1 || c.ProbeTimeoutSeconds > 15 {
		return fmt.Errorf("probe_timeout_seconds must be between 1 and 15")
	}
	if c.ProbeTargetMinIntervalMillis < 100 || c.ProbeTargetMinIntervalMillis > 60000 {
		return fmt.Errorf("probe_target_min_interval_ms must be between 100 and 60000")
	}
	if c.ProbeCacheSeconds < 1 || c.ProbeCacheSeconds > 300 {
		return fmt.Errorf("probe_cache_seconds must be between 1 and 300")
	}
	return nil
}
