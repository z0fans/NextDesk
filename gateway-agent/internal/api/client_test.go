package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestHeartbeatDeclaresBackwardCompatibleCapabilities(t *testing.T) {
	var payload map[string]any
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/connect/agent/heartbeat" {
			t.Fatalf("unexpected heartbeat path %q", r.URL.Path)
		}
		if r.Header.Get("X-Agent-Id") != "agt_test" {
			t.Fatalf("missing agent identity header")
		}
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode heartbeat: %v", err)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"data":{"status":"ok","probe_task_key":"derived-key"}}`))
	}))
	defer server.Close()

	client := New(server.URL, "agt_test", "secret")
	heartbeat, err := client.Heartbeat(map[string]any{"active_bindings": 2})
	if err != nil {
		t.Fatalf("heartbeat failed: %v", err)
	}
	if heartbeat.ProbeTaskKey != "derived-key" {
		t.Fatalf("missing heartbeat probe key: %#v", heartbeat)
	}

	if payload["version"] != "0.4.0" {
		t.Fatalf("unexpected version: %#v", payload["version"])
	}
	capabilities, ok := payload["capabilities"].(map[string]any)
	if !ok {
		t.Fatalf("capabilities missing: %#v", payload)
	}
	if capabilities["schema_version"] != float64(1) {
		t.Fatalf("unexpected capability schema: %#v", capabilities)
	}
	if !reflect.DeepEqual(capabilities["task_types"], []any{"create_binding", "delete_binding", "probe_target", "cancel_probe"}) {
		t.Fatalf("unexpected task types: %#v", capabilities["task_types"])
	}
	if !reflect.DeepEqual(capabilities["forwarding_protocols"], []any{"tcp", "udp"}) {
		t.Fatalf("unexpected forwarding protocols: %#v", capabilities["forwarding_protocols"])
	}
}
