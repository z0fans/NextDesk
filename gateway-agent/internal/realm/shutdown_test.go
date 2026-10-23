package realm

import (
	"bytes"
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func waitForFile(t *testing.T, path string) {
	t.Helper()
	deadline := time.NewTimer(2 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		if _, err := os.Stat(path); err == nil {
			return
		}
		select {
		case <-deadline.C:
			t.Fatalf("command did not start: %s", path)
		case <-ticker.C:
		}
	}
}

func TestCancelledApplyStillRollsBack(t *testing.T) {
	for _, existing := range []bool{false, true} {
		name := "new"
		if existing {
			name = "update"
		}
		t.Run(name, func(t *testing.T) {
			profile := testProfile(t)
			rule := testRule("bnd_cancel")
			var previous []byte
			configPath := filepath.Join(instanceDir(profile, rule.BindingID), "config.json")
			if existing {
				if err := Apply(context.Background(), profile, rule); err != nil {
					t.Fatal(err)
				}
				previous, _ = os.ReadFile(configPath)
			}
			t.Setenv("CG_TEST_EXISTING", name)
			callsPath := fakeSystemctl(t, `case "$1" in
is-active) [ "$CG_TEST_EXISTING" = update ] && exit 0; exit 3 ;;
start|restart)
 if [ ! -f "$CG_TEST_STATE/started" ]; then
  touch "$CG_TEST_STATE/started"
  exec sleep 60
 fi
 ;;
esac
exit 0
`)
			profile.DryRun = false
			rule.TargetHost = "203.0.113.99"
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() { done <- Apply(ctx, profile, rule) }()
			waitForFile(t, filepath.Join(filepath.Dir(callsPath), "started"))
			cancel()
			select {
			case err := <-done:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("missing cancellation: %v", err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("apply did not stop and roll back")
			}
			calls, _ := os.ReadFile(callsPath)
			after, err := os.ReadFile(configPath)
			if existing {
				if err != nil || !bytes.Equal(previous, after) {
					t.Fatalf("old config not restored: %v", err)
				}
				persisted, err := readRule(profile, rulePath(profile, rule.BindingID))
				if err != nil || persisted.TargetHost != "203.0.113.10" {
					t.Fatalf("old rule not retained: %+v %v", persisted, err)
				}
				if strings.Count(string(calls), "restart realm-cg@bnd_cancel.service") != 2 {
					t.Fatalf("rollback restart skipped: %s", calls)
				}
			} else {
				if !os.IsNotExist(err) {
					t.Fatalf("cancelled new instance kept its config: %v", err)
				}
				if _, err := os.Stat(rulePath(profile, rule.BindingID)); !os.IsNotExist(err) {
					t.Fatalf("cancelled binding committed: %v", err)
				}
				if !strings.Contains(string(calls), "stop realm-cg@bnd_cancel.service") {
					t.Fatalf("rollback stop skipped: %s", calls)
				}
			}
		})
	}
}

func TestRollbackCommandTimeoutStillRestoresConfig(t *testing.T) {
	profile := testProfile(t)
	rule := testRule("bnd_timeout")
	if err := Apply(context.Background(), profile, rule); err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(instanceDir(profile, rule.BindingID), "config.json")
	previous, _ := os.ReadFile(configPath)
	callsPath := fakeSystemctl(t, `if [ "$1" = restart ]; then touch "$CG_TEST_STATE/started"; exec sleep 60; fi
exit 0
`)
	profile.DryRun = false
	rule.TargetHost = "203.0.113.99"
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- Apply(ctx, profile, rule) }()
	waitForFile(t, filepath.Join(filepath.Dir(callsPath), "started"))
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) || !errors.Is(err, context.DeadlineExceeded) || !strings.Contains(err.Error(), "restore instance") {
			t.Fatalf("rollback timeout not returned with cancellation: %v", err)
		}
	case <-time.After(rollbackTimeout + 2*time.Second):
		t.Fatal("rollback exceeded cleanup budget")
	}
	after, err := os.ReadFile(configPath)
	if err != nil || !bytes.Equal(previous, after) {
		t.Fatalf("timeout lost old config: %v", err)
	}
}

func TestSystemctlCancellationAndDeadline(t *testing.T) {
	for _, deadline := range []bool{false, true} {
		name := "cancel"
		if deadline {
			name = "deadline"
		}
		t.Run(name, func(t *testing.T) {
			callsPath := fakeSystemctl(t, "exec sleep 60\n")
			ctx, cancel := context.WithCancel(context.Background())
			expected := context.Canceled
			if deadline {
				cancel()
				ctx, cancel = context.WithTimeout(context.Background(), 100*time.Millisecond)
				expected = context.DeadlineExceeded
			}
			defer cancel()
			done := make(chan error, 1)
			go func() { done <- runSystemctl(ctx, "is-active", "test.service") }()
			if !deadline {
				waitForFile(t, callsPath)
				cancel()
			}
			select {
			case err := <-done:
				if !errors.Is(err, expected) {
					t.Fatalf("unexpected command result: %v", err)
				}
			case <-time.After(time.Second):
				t.Fatal("systemctl did not stop")
			}
		})
	}
}

func TestCancelledRealmOperationsDoNotStartWork(t *testing.T) {
	profile := testProfile(t)
	rule := testRule("bnd_live")
	if err := Apply(context.Background(), profile, rule); err != nil {
		t.Fatal(err)
	}
	callsPath := fakeSystemctl(t, "exit 0\n")
	profile.DryRun = false
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, err := range []error{
		Apply(ctx, profile, testRule("bnd_new")),
		Delete(ctx, profile, rule.BindingID),
		Reconcile(ctx, profile),
	} {
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled operation accepted: %v", err)
		}
	}
	if _, err := CleanupExpired(ctx, profile, time.Now().Add(time.Hour)); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled cleanup accepted: %v", err)
	}
	if _, err := os.Stat(callsPath); !os.IsNotExist(err) {
		t.Fatalf("started systemctl after cancellation: %v", err)
	}
	if CountRules(profile) != 1 {
		t.Fatal("cancelled operation modified rules")
	}
}
