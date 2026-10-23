package runner

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"nextdesk/gateway-agent/internal/config"
	"nextdesk/gateway-agent/internal/probe"
)

func TestOnceAcknowledgesCancellationAfterRestart(t *testing.T) {
	for _, status := range []int{http.StatusOK, http.StatusBadGateway} {
		t.Run(fmt.Sprint(status), func(t *testing.T) {
			var results []probe.Result
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/api/v1/connect/agent/heartbeat":
					fmt.Fprint(w, `{"data":{"status":"ok"}}`)
				case "/api/v1/connect/agent/poll":
					fmt.Fprint(w, `{"data":{"tasks":[{"action":"cancel_probe","probe":{"probe_id":"prb_previous_process"}}]}}`)
				case "/api/v1/connect/agent/probe-result":
					var result probe.Result
					if err := json.NewDecoder(r.Body).Decode(&result); err != nil {
						t.Error(err)
					}
					results = append(results, result)
					w.WriteHeader(status)
					fmt.Fprint(w, `{"data":{"ok":true}}`)
				default:
					t.Errorf("unexpected request %s", r.URL.Path)
				}
			}))
			defer server.Close()
			r, err := New(config.Config{BaseURL: server.URL, AgentID: "agt_fixture", AgentToken: "fixture", RealmProfile: "cg", DryRunRoot: t.TempDir()}, true)
			if err != nil {
				t.Fatal(err)
			}
			err = r.Once(context.Background())
			if (err != nil) != (status != http.StatusOK) {
				t.Fatalf("delivery status %d returned %v", status, err)
			}
			if len(results) != 1 {
				t.Fatalf("got %d results", len(results))
			}
			result := results[0]
			if result.ProbeID != "prb_previous_process" || result.Status != "cancelled" || result.OutcomeCategory != "cancelled" || result.DiagnosticCode != "probe_cancelled" || result.StartedAt == "" || result.CompletedAt == "" {
				t.Fatalf("invalid cancellation result: %+v", result)
			}
		})
	}
}
