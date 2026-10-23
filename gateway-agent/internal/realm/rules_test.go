package realm

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
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
	if err := Apply(context.Background(), profile, rule); err != nil {
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

func TestApplyWritesSshTcpOnlyInstance(t *testing.T) {
	profile := testProfile(t)
	rule := Rule{
		BindingID:  "bnd_ssh",
		ListenPort: 42022,
		TargetHost: "203.0.113.22",
		TargetPort: 22,
		Protocols:  []string{"tcp"},
		ExpiresAt:  time.Now().Add(time.Minute).UTC().Format(time.RFC3339),
	}
	if err := Apply(context.Background(), profile, rule); err != nil {
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
	if cfg.Network.NoTCP || cfg.Network.UseUDP {
		t.Fatalf("SSH binding must be TCP-only: %+v", cfg.Network)
	}
	if len(cfg.Endpoints) != 1 || cfg.Endpoints[0].Remote != "203.0.113.22:22" {
		t.Fatalf("unexpected SSH endpoint: %+v", cfg.Endpoints)
	}
}

func TestApplyKeepsBindingsInSeparateInstances(t *testing.T) {
	profile := testProfile(t)
	expiresAt := time.Now().Add(time.Minute).UTC().Format(time.RFC3339)
	for _, rule := range []Rule{
		{BindingID: "bnd_a", ListenPort: 42031, TargetHost: "203.0.113.10", TargetPort: 3389, Protocols: []string{"tcp"}, ExpiresAt: expiresAt},
		{BindingID: "bnd_b", ListenPort: 42032, TargetHost: "203.0.113.11", TargetPort: 3389, Protocols: []string{"tcp", "udp"}, ExpiresAt: expiresAt},
	} {
		if err := Apply(context.Background(), profile, rule); err != nil {
			t.Fatal(err)
		}
	}
	if CountRules(profile) != 2 {
		t.Fatalf("expected two independent rules, got %d", CountRules(profile))
	}
	if err := Delete(context.Background(), profile, "bnd_a"); err != nil {
		t.Fatal(err)
	}
	if CountRules(profile) != 1 {
		t.Fatalf("deleting one binding should leave the other active, got %d", CountRules(profile))
	}
	if _, err := os.Stat(filepath.Join(profile.InstancesDir, "bnd_b", "config.json")); err != nil {
		t.Fatalf("second binding was disturbed: %v", err)
	}
}

func TestInvalidBindingIDsCannotModifyProfile(t *testing.T) {
	for _, bindingID := range []string{"", ".", "..", "../bnd_live", "bnd/live", "bnd\\live"} {
		t.Run(bindingID, func(t *testing.T) {
			profile := testProfile(t)
			rule := Rule{
				BindingID: "bnd.live-01", ListenPort: 42031, TargetHost: "203.0.113.10",
				TargetPort: 3389, Protocols: []string{"tcp"},
				ExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339),
			}
			if err := Apply(context.Background(), profile, rule); err != nil {
				t.Fatal(err)
			}
			paths := []string{
				filepath.Join(profile.RulesDir, "cg-"+rule.BindingID+".json"),
				filepath.Join(profile.InstancesDir, rule.BindingID, "config.json"),
			}
			original := make(map[string][]byte, len(paths))
			for _, path := range paths {
				raw, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				original[path] = raw
			}
			rule.BindingID = bindingID
			if err := Apply(context.Background(), profile, rule); err == nil {
				t.Errorf("Apply accepted unsafe binding ID %q", bindingID)
			}
			if err := Delete(context.Background(), profile, bindingID); err == nil {
				t.Errorf("Delete accepted unsafe binding ID %q", bindingID)
			}
			for path, before := range original {
				after, err := os.ReadFile(path)
				if err != nil || !bytes.Equal(before, after) {
					t.Errorf("existing binding changed at %s: %v", path, err)
				}
			}
			if count := CountRules(profile); count != 1 {
				t.Errorf("expected one unchanged rule, got %d", count)
			}
			for _, path := range []string{
				filepath.Join(profile.ConfigDir, "config.json"),
				filepath.Join(profile.InstancesDir, "config.json"),
			} {
				if _, err := os.Stat(path); !os.IsNotExist(err) {
					t.Errorf("unsafe binding wrote outside its instance: %s (%v)", path, err)
				}
			}
		})
	}
}

func TestCleanupExpiredRemovesOnlyExpiredBindings(t *testing.T) {
	profile := testProfile(t)
	now := time.Now().UTC()
	for _, rule := range []Rule{
		{BindingID: "bnd_expired", ListenPort: 42031, TargetHost: "203.0.113.10", TargetPort: 3389, Protocols: []string{"tcp"}, ExpiresAt: now.Add(-time.Second).Format(time.RFC3339)},
		{BindingID: "bnd_live", ListenPort: 42032, TargetHost: "203.0.113.11", TargetPort: 3389, Protocols: []string{"tcp"}, ExpiresAt: now.Add(time.Minute).Format(time.RFC3339)},
	} {
		if err := Apply(context.Background(), profile, rule); err != nil {
			t.Fatal(err)
		}
	}
	removed, err := CleanupExpired(context.Background(), profile, now)
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

func testRule(id string) Rule {
	return Rule{BindingID: id, ListenPort: 42031, TargetHost: "203.0.113.10", TargetPort: 3389,
		Protocols: []string{"tcp"}, ExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339)}
}

func fakeSystemctl(t *testing.T, script string) string {
	t.Helper()
	bin := t.TempDir()
	logPath := filepath.Join(bin, "calls")
	t.Setenv("CG_TEST_STATE", bin)
	t.Setenv("CG_TEST_LOG", logPath)
	t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
	if err := os.WriteFile(filepath.Join(bin, "systemctl"), []byte("#!/bin/sh\nprintf '%s\\n' \"$*\" >> \"$CG_TEST_LOG\"\n"+script), 0700); err != nil {
		t.Fatal(err)
	}
	return logPath
}

func TestApplyFailureRestoresExistingBinding(t *testing.T) {
	for _, failure := range []string{"config_write", "rule_commit", "restart", "health_check"} {
		t.Run(failure, func(t *testing.T) {
			profile := testProfile(t)
			rule := testRule("bnd_live")
			if err := Apply(context.Background(), profile, rule); err != nil {
				t.Fatal(err)
			}
			paths := []string{rulePath(profile, rule.BindingID), filepath.Join(instanceDir(profile, rule.BindingID), "config.json")}
			original := map[string][]byte{}
			for _, path := range paths {
				raw, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				original[path] = raw
			}
			var logPath string
			if failure == "config_write" || failure == "rule_commit" {
				blocked := paths[0]
				if failure == "config_write" {
					blocked = paths[1]
				}
				if err := os.Mkdir(blocked+".tmp", 0700); err != nil {
					t.Fatal(err)
				}
			} else {
				profile.DryRun = false
				t.Setenv("CG_TEST_FAILURE", failure)
				logPath = fakeSystemctl(t, `case "$1" in
is-active)
  if [ "$CG_TEST_FAILURE" = health_check ] && [ -f "$CG_TEST_STATE/applied" ] && [ ! -f "$CG_TEST_STATE/restored" ]; then exit 3; fi
  ;;
restart)
  if [ -f "$CG_TEST_STATE/applied" ]; then touch "$CG_TEST_STATE/restored"; else
    touch "$CG_TEST_STATE/applied"
    if [ "$CG_TEST_FAILURE" = restart ]; then exit 1; fi
  fi
  ;;
esac
exit 0
`)
			}
			rule.TargetHost = "203.0.113.99"
			if err := Apply(context.Background(), profile, rule); err == nil {
				t.Fatal("expected injected apply failure")
			}
			for path, before := range original {
				after, err := os.ReadFile(path)
				if err != nil || !bytes.Equal(before, after) {
					t.Errorf("failed update changed %s: %v", path, err)
				}
			}
			if logPath != "" {
				calls, err := os.ReadFile(logPath)
				if err != nil || strings.Count(string(calls), "restart realm-cg@bnd_live.service") != 2 {
					t.Errorf("old instance was not restarted after rollback: %s (%v)", calls, err)
				}
			}
		})
	}
}

func TestFailedNewBindingCleansOnlyItsOwnFiles(t *testing.T) {
	profile := testProfile(t)
	other := testRule("bnd_other")
	if err := Apply(context.Background(), profile, other); err != nil {
		t.Fatal(err)
	}
	logPath := fakeSystemctl(t, `case "$1" in
is-active) exit 3 ;;
start) exit 1 ;;
esac
exit 0
`)
	profile.DryRun = false
	if err := Apply(context.Background(), profile, testRule("bnd_new")); err == nil {
		t.Fatal("expected start failure")
	}
	for _, path := range []string{rulePath(profile, "bnd_new"), filepath.Join(instanceDir(profile, "bnd_new"), "config.json")} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Errorf("new binding left a file: %s (%v)", path, err)
		}
	}
	if _, err := os.Stat(rulePath(profile, other.BindingID)); err != nil {
		t.Fatalf("unrelated binding was removed: %v", err)
	}
	calls, err := os.ReadFile(logPath)
	if err != nil || !strings.Contains(string(calls), "stop realm-cg@bnd_new.service") {
		t.Errorf("failed new instance was not stopped: %s (%v)", calls, err)
	}
}

func TestDeletePreservesRuleWhenInstanceRemovalFails(t *testing.T) {
	profile := testProfile(t)
	rule := testRule("bnd_live")
	if err := Apply(context.Background(), profile, rule); err != nil {
		t.Fatal(err)
	}
	blocked := filepath.Join(t.TempDir(), "not-a-directory")
	if err := os.WriteFile(blocked, []byte("block"), 0600); err != nil {
		t.Fatal(err)
	}
	profile.InstancesDir = blocked
	if err := Delete(context.Background(), profile, rule.BindingID); err == nil {
		t.Fatal("expected instance removal failure")
	}
	if _, err := os.Stat(rulePath(profile, rule.BindingID)); err != nil {
		t.Fatalf("failed delete lost persisted rule: %v", err)
	}
}

func TestDeletePreservesFilesOnSystemctlError(t *testing.T) {
	for _, failure := range []string{"is-active", "stop"} {
		t.Run(failure, func(t *testing.T) {
			profile := testProfile(t)
			rule := testRule("bnd_live")
			if err := Apply(context.Background(), profile, rule); err != nil {
				t.Fatal(err)
			}
			t.Setenv("CG_TEST_FAILURE", failure)
			fakeSystemctl(t, `if [ "$1" = "$CG_TEST_FAILURE" ]; then exit 1; fi
exit 0
`)
			profile.DryRun = false
			if err := Delete(context.Background(), profile, rule.BindingID); err == nil {
				t.Fatal("expected systemctl error")
			}
			for _, path := range []string{rulePath(profile, rule.BindingID), filepath.Join(instanceDir(profile, rule.BindingID), "config.json")} {
				if _, err := os.Stat(path); err != nil {
					t.Errorf("failed delete removed %s: %v", path, err)
				}
			}
		})
	}
}

func TestApplyReportsRollbackFailureAndKeepsOriginalFiles(t *testing.T) {
	profile := testProfile(t)
	rule := testRule("bnd_live")
	if err := Apply(context.Background(), profile, rule); err != nil {
		t.Fatal(err)
	}
	fakeSystemctl(t, `if [ "$1" = restart ]; then exit 1; fi
exit 0
`)
	profile.DryRun = false
	rule.TargetHost = "203.0.113.99"
	if err := Apply(context.Background(), profile, rule); err == nil || !strings.Contains(err.Error(), "restore instance") {
		t.Fatalf("rollback failure was not reported: %v", err)
	}
	for _, path := range []string{rulePath(profile, rule.BindingID), filepath.Join(instanceDir(profile, rule.BindingID), "config.json")} {
		raw, err := os.ReadFile(path)
		if err != nil || !bytes.Contains(raw, []byte("203.0.113.10")) || bytes.Contains(raw, []byte("203.0.113.99")) {
			t.Errorf("original files not retained at %s: %v", path, err)
		}
	}
}

func TestDamagedRulesDoNotBlockCleanupOrRestoreExpiredBindings(t *testing.T) {
	profile := testProfile(t)
	now := time.Now().UTC()
	live, expired := testRule("bnd_live"), testRule("bnd_expired")
	expired.ExpiresAt = now.Add(-time.Minute).Format(time.RFC3339)
	for _, rule := range []Rule{live, expired} {
		if err := Apply(context.Background(), profile, rule); err != nil {
			t.Fatal(err)
		}
	}
	badPath := filepath.Join(profile.RulesDir, "cg-aaa-broken.json")
	if err := os.WriteFile(badPath, []byte("{"), 0640); err != nil {
		t.Fatal(err)
	}
	// A corrupt record must not use another binding's ID to delete its files.
	wrongID := expired
	wrongID.BindingID = live.BindingID
	raw, _ := json.Marshal(wrongID)
	if err := os.WriteFile(filepath.Join(profile.RulesDir, "cg-aab-mismatch.json"), raw, 0640); err != nil {
		t.Fatal(err)
	}
	removed, err := CleanupExpired(context.Background(), profile, now)
	if err == nil || len(removed) != 1 || removed[0] != expired.BindingID {
		t.Errorf("cleanup did not isolate corrupt records: removed=%v err=%v", removed, err)
	}
	if _, err := os.Stat(rulePath(profile, live.BindingID)); err != nil {
		t.Fatalf("corrupt record removed healthy binding: %v", err)
	}
	// Leave an expired record, as if its previous deletion had failed.
	raw, _ = json.Marshal(expired)
	if err := os.WriteFile(rulePath(profile, expired.BindingID), raw, 0640); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(instanceDir(profile, live.BindingID)); err != nil {
		t.Fatal(err)
	}
	if err := Reconcile(context.Background(), profile); err == nil {
		t.Fatal("expected corrupt record to be reported")
	}
	if _, err := os.Stat(filepath.Join(instanceDir(profile, live.BindingID), "config.json")); err != nil {
		t.Errorf("healthy binding was not reconciled: %v", err)
	}
	if _, err := os.Stat(instanceDir(profile, expired.BindingID)); !os.IsNotExist(err) {
		t.Errorf("expired binding was recreated: %v", err)
	}
	if raw, err := os.ReadFile(badPath); err != nil || string(raw) != "{" {
		t.Errorf("damaged source record was modified: %v", err)
	}
}
