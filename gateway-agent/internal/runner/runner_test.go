package runner

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"nextdesk/gateway-agent/internal/api"
	"nextdesk/gateway-agent/internal/config"
	"nextdesk/gateway-agent/internal/probe"
	"nextdesk/gateway-agent/internal/realm"
)

func TestRejectedTaskPreservesExistingBindingAndContinuesBatch(t *testing.T) {
	for _, tc := range []struct {
		name     string
		task     api.Task
		wantAcks []string
	}{
		{name: "unknown_action", task: api.Task{Action: "unsupported_action", BindingID: "bnd_live"}, wantAcks: []string{"bnd_new:active"}},
		{name: "invalid_update", task: api.Task{Action: "create_binding", BindingID: "bnd_live"}, wantAcks: []string{"bnd_live:failed", "bnd_new:active"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var acknowledgements []string
			expiresAt := time.Now().Add(time.Minute).UTC().Format(time.RFC3339)
			controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch request.URL.Path {
				case "/api/v1/connect/agent/heartbeat":
					_, _ = io.WriteString(w, `{"data":{"status":"ok"}}`)
				case "/api/v1/connect/agent/poll":
					_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"tasks": []api.Task{
						tc.task,
						{Action: "create_binding", BindingID: "bnd_new", ListenPort: 42032, TargetHost: "203.0.113.11", TargetPort: 22, Protocols: []string{"tcp"}, ExpiresAt: expiresAt},
					}}})
				case "/api/v1/connect/agent/ack":
					var acknowledgement struct {
						BindingID string `json:"binding_id"`
						Status    string `json:"status"`
					}
					if err := json.NewDecoder(request.Body).Decode(&acknowledgement); err != nil {
						t.Errorf("decode ack: %v", err)
					}
					acknowledgements = append(acknowledgements, acknowledgement.BindingID+":"+acknowledgement.Status)
					_, _ = io.WriteString(w, `{"data":{"ok":true}}`)
				default:
					http.NotFound(w, request)
				}
			}))
			defer controlPlane.Close()
			runner, err := New(config.Config{
				BaseURL: controlPlane.URL, AgentID: "agt_runner", AgentToken: "secret", RealmProfile: "cg",
				PortRange: "42000-42999", DryRunRoot: t.TempDir(),
			}, true)
			if err != nil {
				t.Fatal(err)
			}
			if err := realm.Apply(context.Background(), runner.Profile, realm.Rule{
				BindingID: "bnd_live", ListenPort: 42031, TargetHost: "203.0.113.10",
				TargetPort: 3389, Protocols: []string{"tcp", "udp"}, ExpiresAt: expiresAt,
			}); err != nil {
				t.Fatal(err)
			}
			original := map[string][]byte{}
			for _, path := range []string{
				filepath.Join(runner.Profile.RulesDir, "cg-bnd_live.json"),
				filepath.Join(runner.Profile.InstancesDir, "bnd_live", "config.json"),
			} {
				raw, err := os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
				original[path] = raw
			}
			if err := runner.Once(context.Background()); err != nil {
				t.Fatal(err)
			}
			for path, before := range original {
				after, err := os.ReadFile(path)
				if err != nil || !bytes.Equal(before, after) {
					t.Errorf("rejected task changed existing binding at %s: %v", path, err)
				}
			}
			if count := realm.CountRules(runner.Profile); count != 2 {
				t.Errorf("expected preserved and new bindings, got %d", count)
			}
			if !reflect.DeepEqual(acknowledgements, tc.wantAcks) {
				t.Errorf("unexpected acknowledgements: %v", acknowledgements)
			}

		})
	}
}

func TestProbeTaskUsesFakeControlPlaneWithoutCreatingRealmRule(t *testing.T) {
	ssh, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ssh.Close()
	go func() {
		conn, acceptErr := ssh.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		_, _ = io.WriteString(conn, "SSH-2.0-RunnerTest\r\n")
		buffer := make([]byte, 128)
		_, _ = conn.Read(buffer)
	}()

	const key = "runner-derived-probe-key"
	now := time.Now().UTC()
	port := ssh.Addr().(*net.TCPAddr).Port
	task := probe.Task{
		ProbeID: "prb_runner_01", TargetHost: "127.0.0.1", TargetPort: port, ServiceKind: "ssh",
		Stages: []string{"tcp", "ssh_identification"}, IssuedAt: now.Format(time.RFC3339),
		DeadlineAt: now.Add(4 * time.Second).Format(time.RFC3339), ExpiresAt: now.Add(10 * time.Second).Format(time.RFC3339),
		PolicyRevision: "routing-test", SignatureVersion: probe.SignatureVersion,
	}
	task.Signature = probe.SignTask("agt_runner", key, task)
	results := make(chan probe.Result, 1)
	controlPlane := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch request.URL.Path {
		case "/api/v1/connect/agent/heartbeat":
			_, _ = w.Write([]byte(`{"data":{"status":"ok","probe_task_key":"` + key + `"}}`))
		case "/api/v1/connect/agent/poll":
			_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"tasks": []any{map[string]any{"action": "probe_target", "probe": task}}}})
		case "/api/v1/connect/agent/probe-result":
			var result probe.Result
			if err := json.NewDecoder(request.Body).Decode(&result); err != nil {
				t.Errorf("decode result: %v", err)
			}
			results <- result
			_, _ = w.Write([]byte(`{"data":{"ok":true}}`))
		default:
			http.NotFound(w, request)
		}
	}))
	defer controlPlane.Close()

	cfg := config.Config{
		BaseURL: controlPlane.URL, AgentID: "agt_runner", AgentToken: "secret", RealmProfile: "cg",
		PollIntervalSeconds: 1, PortRange: "42000-42999", DryRunRoot: t.TempDir(),
		ProbeAllowedPorts: []int{port}, ProbeMaxConcurrency: 1, ProbeTimeoutSeconds: 3,
		ProbeTargetMinIntervalMillis: 100, ProbeCacheSeconds: 10,
	}
	runner, err := New(cfg, true)
	if err != nil {
		t.Fatal(err)
	}
	if err := runner.Once(context.Background()); err != nil {
		t.Fatal(err)
	}
	select {
	case result := <-results:
		if result.Status != "success" || result.ProbeID != task.ProbeID {
			t.Fatalf("unexpected probe result: %+v", result)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for probe result")
	}
	if rules := realm.CountRules(runner.Profile); rules != 0 {
		t.Fatalf("probe task must not create realm rules, got %d", rules)
	}
}
