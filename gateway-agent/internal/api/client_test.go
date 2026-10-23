package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"nextdesk/gateway-agent/internal/probe"
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
	heartbeat, err := client.Heartbeat(context.Background(), map[string]any{"active_bindings": 2})
	if err != nil {
		t.Fatalf("heartbeat failed: %v", err)
	}
	if heartbeat.ProbeTaskKey != "derived-key" {
		t.Fatalf("missing heartbeat probe key: %#v", heartbeat)
	}

	if payload["version"] != "0.4.1" {
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

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

type countedBody struct {
	reader io.Reader
	read   int
	closed bool
}

func (body *countedBody) Read(p []byte) (int, error) {
	n, err := body.reader.Read(p)
	body.read += n
	return n, err
}

func (body *countedBody) Close() error {
	body.closed = true
	return nil
}

func TestClientBoundsEveryResponseBeforeReadingItAll(t *testing.T) {
	for _, endpoint := range []struct {
		name string
		call func(Client) error
	}{
		{"heartbeat", func(c Client) error { _, err := c.Heartbeat(context.Background(), nil); return err }},
		{"poll", func(c Client) error { _, err := c.Poll(context.Background()); return err }},
		{"ack", func(c Client) error { return c.Ack(context.Background(), "bnd_test", "active", "", "") }},
		{"probe-result", func(c Client) error { return c.ProbeResult(context.Background(), probe.Result{ProbeID: "prb_test"}) }},
	} {
		for _, status := range []int{http.StatusOK, http.StatusBadGateway} {
			for _, declaredLength := range []int64{-1, 2 * maxResponseBytes} {
				t.Run(fmt.Sprintf("%s/%d/%d", endpoint.name, status, declaredLength), func(t *testing.T) {
					body := &countedBody{reader: strings.NewReader(strings.Repeat("x", 2*maxResponseBytes))}
					client := New("https://panel.example", "agt_test", "secret")
					client.HTTP.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
						return &http.Response{StatusCode: status, Body: body, ContentLength: declaredLength}, nil
					})
					if err := endpoint.call(client); err == nil || !strings.Contains(err.Error(), "exceeds") {
						t.Error("oversized response did not return the size-limit error")
					}
					if body.read > maxResponseBytes+1 {
						t.Errorf("read %d bytes before rejecting, limit is %d plus one sentinel byte", body.read, maxResponseBytes)
					}
					if !body.closed {
						t.Error("response body was not closed")
					}
				})
			}
		}
	}
}

type brokenReader struct{}

func (brokenReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }

func TestClientPropagatesResponseReadFailure(t *testing.T) {
	body := &countedBody{reader: brokenReader{}}
	client := New("https://panel.example", "agt_test", "secret")
	client.HTTP.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: body}, nil
	})
	if err := client.Ack(context.Background(), "bnd_test", "active", "", ""); !errors.Is(err, io.ErrUnexpectedEOF) {
		t.Errorf("response read error was swallowed: %v", err)
	}
	if !body.closed {
		t.Error("response body was not closed")
	}
}

func TestClientAcceptsResponseAtLimit(t *testing.T) {
	payload := `{"data":{"status":"ok","probe_task_key":"test-key"}}`
	body := &countedBody{reader: strings.NewReader(payload + strings.Repeat(" ", maxResponseBytes-len(payload)))}
	client := New("https://panel.example", "agt_test", "secret")
	client.HTTP.Transport = roundTripFunc(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: body}, nil
	})
	response, err := client.Heartbeat(context.Background(), nil)
	if err != nil || response.ProbeTaskKey != "test-key" || body.read != maxResponseBytes || !body.closed {
		t.Fatalf("response at limit was not accepted: response=%+v read=%d closed=%v err=%v", response, body.read, body.closed, err)
	}
}
