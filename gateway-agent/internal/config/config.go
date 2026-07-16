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
	BaseURL             string `json:"base_url"`
	AgentID             string `json:"agent_id"`
	AgentToken          string `json:"agent_token"`
	RealmProfile        string `json:"realm_profile"`
	PollIntervalSeconds int    `json:"poll_interval_seconds"`
	PublicHost          string `json:"public_host"`
	PortRange           string `json:"port_range"`
	DryRunRoot          string `json:"dry_run_root"`
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
	if cfg.BaseURL == "" || cfg.AgentID == "" || cfg.AgentToken == "" {
		return Config{}, fmt.Errorf("base_url, agent_id and agent_token are required")
	}
	if _, _, err := cfg.PortBounds(); err != nil {
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
