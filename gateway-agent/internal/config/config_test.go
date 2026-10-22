package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadAppliesRestrictedProbeDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	raw := []byte(`{"base_url":"https://panel.example","agent_id":"agt_test","agent_token":"secret","port_range":"42000-42999"}`)
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	ports := cfg.ProbeAllowedPortSet()
	if !ports[22] || !ports[3389] || len(ports) != 2 {
		t.Fatalf("unexpected default probe ports: %#v", ports)
	}
	if cfg.ProbeMaxConcurrency != 4 || cfg.ProbeTimeoutSeconds != 5 || cfg.ProbeCacheSeconds != 45 {
		t.Fatalf("unexpected probe defaults: %+v", cfg)
	}
}

func TestLoadRejectsUnsafeProbePolicy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	raw := []byte(`{"base_url":"https://panel.example","agent_id":"agt_test","agent_token":"secret","port_range":"42000-42999","probe_allowed_ports":[0,22]}`)
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("expected invalid probe port to be rejected")
	}
}
