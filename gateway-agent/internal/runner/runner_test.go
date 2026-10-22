package runner

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"nextdesk/gateway-agent/internal/config"
	"nextdesk/gateway-agent/internal/probe"
	"nextdesk/gateway-agent/internal/realm"
)

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
	if err := runner.Once(); err != nil {
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
