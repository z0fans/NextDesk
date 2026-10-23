package runner

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"nextdesk/gateway-agent/internal/api"
	"nextdesk/gateway-agent/internal/config"
	"nextdesk/gateway-agent/internal/probe"
	"nextdesk/gateway-agent/internal/realm"
)

func shutdownRunner(t *testing.T, url string, ports ...int) Runner {
	t.Helper()
	r, err := New(config.Config{
		BaseURL: url, AgentID: "agt_runner", AgentToken: "test-token", RealmProfile: "cg",
		DryRunRoot: t.TempDir(), PollIntervalSeconds: 1, ProbeAllowedPorts: ports,
		ProbeMaxConcurrency: 1, ProbeTimeoutSeconds: 10,
	}, true)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func shutdownProbe(t *testing.T, port int) probe.Task {
	t.Helper()
	now := time.Now().UTC()
	task := probe.Task{
		ProbeID: "prb_shutdown", TargetHost: "127.0.0.1", TargetPort: port, ServiceKind: "ssh",
		Stages: []string{"tcp", "ssh_identification"}, IssuedAt: now.Format(time.RFC3339),
		DeadlineAt: now.Add(10 * time.Second).Format(time.RFC3339), ExpiresAt: now.Add(12 * time.Second).Format(time.RFC3339),
		PolicyRevision: "test", SignatureVersion: probe.SignatureVersion,
	}
	task.Signature = probe.SignTask("agt_runner", "test-key", task)
	return task
}

func TestOnceWaitsForProbeDeliveryAndReturnsFailure(t *testing.T) {
	for _, mode := range []string{"success", "failure", "cancel"} {
		t.Run(mode, func(t *testing.T) {
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			go func() {
				conn, err := listener.Accept()
				if err != nil {
					return
				}
				defer conn.Close()
				_ = conn.SetDeadline(time.Now().Add(2 * time.Second))
				_, _ = io.WriteString(conn, "SSH-2.0-OnceTest\r\n")
				_, _ = io.Copy(io.Discard, conn)
			}()
			port := listener.Addr().(*net.TCPAddr).Port
			task := shutdownProbe(t, port)
			received, release := make(chan probe.Result, 1), make(chan struct{})
			var releaseOnce sync.Once
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				switch request.URL.Path {
				case "/api/v1/connect/agent/heartbeat":
					_, _ = io.WriteString(w, `{"data":{"probe_task_key":"test-key"}}`)
				case "/api/v1/connect/agent/poll":
					_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"tasks": []api.Task{{Action: "probe_target", Probe: &task}}}})
				case "/api/v1/connect/agent/probe-result":
					var result probe.Result
					if err := json.NewDecoder(request.Body).Decode(&result); err != nil {
						t.Error(err)
					}
					received <- result
					select {
					case <-release:
					case <-request.Context().Done():
						return
					}
					if mode == "failure" {
						http.Error(w, "test delivery failure", http.StatusServiceUnavailable)
						return
					}
					_, _ = io.WriteString(w, `{}`)
				default:
					t.Errorf("unexpected request: %s", request.URL.Path)
				}
			}))
			defer server.Close()
			defer releaseOnce.Do(func() { close(release) })
			r := shutdownRunner(t, server.URL, port)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() { done <- r.Once(ctx) }()
			select {
			case result := <-received:
				if result.Status != "success" {
					t.Fatalf("probe failed before delivery: %+v", result)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("probe result did not reach server")
			}
			select {
			case err := <-done:
				t.Fatalf("once returned before delivery completed: %v", err)
			case <-time.After(30 * time.Millisecond):
			}
			if mode == "cancel" {
				cancel()
			} else {
				releaseOnce.Do(func() { close(release) })
			}
			select {
			case err := <-done:
				switch mode {
				case "success":
					if err != nil {
						t.Fatal(err)
					}
				case "failure":
					if err == nil || !strings.Contains(err.Error(), "delivery failed") {
						t.Fatalf("delivery failure lost: %v", err)
					}
				case "cancel":
					if !errors.Is(err, context.Canceled) {
						t.Fatalf("delivery cancellation lost: %v", err)
					}
				}
			case <-time.After(time.Second):
				t.Fatal("once did not finish after delivery response or cancellation")
			}
			if realm.CountRules(r.Profile) != 0 {
				t.Fatal("probe created a realm rule")
			}
			if err := r.Probes.Submit(context.Background(), task, "test-key", func(probe.Result) { t.Error("accepted probe after once stopped") }); !errors.Is(err, context.Canceled) {
				t.Fatalf("executor still accepts tasks: %v", err)
			}
		})
	}
}

func TestRunCancellationStopsHTTPAndRemainingBatch(t *testing.T) {
	for _, phase := range []string{"heartbeat", "poll", "ack"} {
		t.Run(phase, func(t *testing.T) {
			entered := make(chan struct{})
			var requests atomic.Int32
			ruleTask := api.Task{Action: "create_binding", BindingID: "bnd_first", ListenPort: 42031, TargetHost: "203.0.113.10", TargetPort: 22, Protocols: []string{"tcp"}, ExpiresAt: time.Now().Add(time.Minute).UTC().Format(time.RFC3339)}
			secondTask := ruleTask
			secondTask.BindingID = "bnd_second"
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				requests.Add(1)
				_, _ = io.Copy(io.Discard, request.Body)
				if strings.HasSuffix(request.URL.Path, "/"+phase) {
					close(entered)
					<-request.Context().Done()
					return
				}
				switch request.URL.Path {
				case "/api/v1/connect/agent/heartbeat":
					_, _ = io.WriteString(w, `{"data":{}}`)
				case "/api/v1/connect/agent/poll":
					_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"tasks": []api.Task{ruleTask, secondTask}}})
				default:
					t.Errorf("unexpected request: %s", request.URL.Path)
				}
			}))
			defer server.Close()
			r := shutdownRunner(t, server.URL)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			done := make(chan error, 1)
			go func() { done <- r.Run(ctx) }()
			select {
			case <-entered:
			case <-time.After(time.Second):
				t.Fatal("runner did not reach blocking HTTP phase")
			}
			cancel()
			select {
			case err := <-done:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("cancellation lost: %v", err)
				}
			case <-time.After(time.Second):
				t.Fatal("runner ignored HTTP cancellation")
			}
			if _, err := os.Stat(filepath.Join(r.Profile.RulesDir, "cg-bnd_second.json")); !os.IsNotExist(err) {
				t.Fatal("processed a new binding after cancellation")
			}
			before := requests.Load()
			if err := r.Once(ctx); !errors.Is(err, context.Canceled) {
				t.Fatalf("cancelled once accepted work: %v", err)
			}
			if requests.Load() != before {
				t.Fatal("sent another request with cancelled context")
			}
		})
	}
}

func TestRunCancellationJoinsActiveProbeWhileWaitingForNextPoll(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := listener.Accept()
		if err == nil {
			accepted <- conn
		}
	}()
	port := listener.Addr().(*net.TCPAddr).Port
	task := shutdownProbe(t, port)
	var polls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/v1/connect/agent/heartbeat":
			_, _ = io.WriteString(w, `{"data":{"probe_task_key":"test-key"}}`)
		case "/api/v1/connect/agent/poll":
			polls.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]any{"tasks": []api.Task{{Action: "probe_target", Probe: &task}}}})
		default:
			t.Errorf("sent result request after cancellation: %s", request.URL.Path)
		}
	}))
	defer server.Close()
	r := shutdownRunner(t, server.URL, port)
	r.Config.PollIntervalSeconds = 60
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- r.Run(ctx) }()
	var conn net.Conn
	select {
	case conn = <-accepted:
	case <-time.After(time.Second):
		t.Fatal("probe did not start")
	}
	defer conn.Close()
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancellation lost: %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("runner did not join its probe")
	}
	_ = conn.SetReadDeadline(time.Now().Add(time.Second))
	var one [1]byte
	if n, err := conn.Read(one[:]); n != 0 || err != io.EOF {
		t.Fatalf("probe socket still active: n=%d err=%v", n, err)
	}
	if polls.Load() != 1 {
		t.Fatalf("unexpected poll count: %d", polls.Load())
	}
}

func TestOnceReturnsAckDeliveryFailure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		switch request.URL.Path {
		case "/api/v1/connect/agent/heartbeat":
			_, _ = io.WriteString(w, `{"data":{}}`)
		case "/api/v1/connect/agent/poll":
			_, _ = io.WriteString(w, `{"data":{"tasks":[{"action":"create_binding","binding_id":"bnd_invalid"}]}}`)
		case "/api/v1/connect/agent/ack":
			http.Error(w, "test delivery failure", http.StatusServiceUnavailable)
		}
	}))
	defer server.Close()
	r := shutdownRunner(t, server.URL)
	if err := r.Once(context.Background()); err == nil || !strings.Contains(err.Error(), "ack bnd_invalid delivery failed") {
		t.Fatalf("ACK failure lost: %v", err)
	}
}
