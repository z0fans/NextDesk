package realm

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func testProfile(t *testing.T) Profile {
	t.Helper()
	root := t.TempDir()
	profile, err := NewProfile("cg", root, true)
	if err != nil {
		t.Fatal(err)
	}
	return profile
}

func TestApplyWritesIndependentTcpUdpInstance(t *testing.T) {
	profile := testProfile(t)
	rule := Rule{
		BindingID:  "bnd_test",
		ListenPort: 42031,
		TargetHost: "203.0.113.10",
		TargetPort: 3389,
		Protocols:  []string{"tcp", "udp"},
		ExpiresAt:  time.Now().Add(time.Minute).UTC().Format(time.RFC3339),
	}
	if err := Apply(profile, rule); err != nil {
		t.Fatal(err)
	}

	raw, err := os.ReadFile(filepath.Join(profile.InstancesDir, rule.BindingID, "config.json"))
	if err != nil {
		t.Fatal(err)
	}
	var cfg configFile
	if err := json.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	if cfg.Network.NoTCP || !cfg.Network.UseUDP {
		t.Fatalf("unexpected network flags: %+v", cfg.Network)
	}
	if len(cfg.Endpoints) != 1 || cfg.Endpoints[0].Listen != "0.0.0.0:42031" || cfg.Endpoints[0].Remote != "203.0.113.10:3389" {
		t.Fatalf("unexpected endpoints: %+v", cfg.Endpoints)
	}
}

func TestApplyKeepsBindingsInSeparateInstances(t *testing.T) {
	profile := testProfile(t)
	expiresAt := time.Now().Add(time.Minute).UTC().Format(time.RFC3339)
	for _, rule := range []Rule{
		{BindingID: "bnd_a", ListenPort: 42031, TargetHost: "203.0.113.10", TargetPort: 3389, Protocols: []string{"tcp"}, ExpiresAt: expiresAt},
		{BindingID: "bnd_b", ListenPort: 42032, TargetHost: "203.0.113.11", TargetPort: 3389, Protocols: []string{"tcp", "udp"}, ExpiresAt: expiresAt},
	} {
		if err := Apply(profile, rule); err != nil {
			t.Fatal(err)
		}
	}
	if CountRules(profile) != 2 {
		t.Fatalf("expected two independent rules, got %d", CountRules(profile))
	}
	if err := Delete(profile, "bnd_a"); err != nil {
		t.Fatal(err)
	}
	if CountRules(profile) != 1 {
		t.Fatalf("deleting one binding should leave the other active, got %d", CountRules(profile))
	}
	if _, err := os.Stat(filepath.Join(profile.InstancesDir, "bnd_b", "config.json")); err != nil {
		t.Fatalf("second binding was disturbed: %v", err)
	}
}

func TestCleanupExpiredRemovesOnlyExpiredBindings(t *testing.T) {
	profile := testProfile(t)
	now := time.Now().UTC()
	for _, rule := range []Rule{
		{BindingID: "bnd_expired", ListenPort: 42031, TargetHost: "203.0.113.10", TargetPort: 3389, Protocols: []string{"tcp"}, ExpiresAt: now.Add(-time.Second).Format(time.RFC3339)},
		{BindingID: "bnd_live", ListenPort: 42032, TargetHost: "203.0.113.11", TargetPort: 3389, Protocols: []string{"tcp"}, ExpiresAt: now.Add(time.Minute).Format(time.RFC3339)},
	} {
		if err := Apply(profile, rule); err != nil {
			t.Fatal(err)
		}
	}
	removed, err := CleanupExpired(profile, now)
	if err != nil {
		t.Fatal(err)
	}
	if len(removed) != 1 || removed[0] != "bnd_expired" {
		t.Fatalf("unexpected removed bindings: %v", removed)
	}
	if CountRules(profile) != 1 {
		t.Fatalf("expected one live binding, got %d", CountRules(profile))
	}
}
