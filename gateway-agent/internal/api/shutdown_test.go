package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"nextdesk/gateway-agent/internal/probe"
)

func TestCancellationInterruptsEveryRequest(t *testing.T) {
	for _, endpoint := range []struct {
		name string
		call func(context.Context, Client) error
	}{
		{"heartbeat", func(ctx context.Context, c Client) error { _, err := c.Heartbeat(ctx, nil); return err }},
		{"poll", func(ctx context.Context, c Client) error { _, err := c.Poll(ctx); return err }},
		{"ack", func(ctx context.Context, c Client) error { return c.Ack(ctx, "bnd_test", "active", "", "") }},
		{"probe-result", func(ctx context.Context, c Client) error {
			return c.ProbeResult(ctx, probe.Result{ProbeID: "prb_test"})
		}},
	} {
		for _, streaming := range []bool{false, true} {
			name := endpoint.name + "/headers"
			if streaming {
				name = endpoint.name + "/body"
			}
			t.Run(name, func(t *testing.T) {
				entered := make(chan struct{})
				var requests atomic.Int32
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					requests.Add(1)
					_, _ = io.Copy(io.Discard, r.Body)
					if streaming {
						w.WriteHeader(http.StatusOK)
						_, _ = io.WriteString(w, "{")
						w.(http.Flusher).Flush()
					}
					close(entered)
					<-r.Context().Done()
				}))
				defer server.Close()
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				client := New(server.URL, "agt_test", "test-token")
				done := make(chan error, 1)
				go func() { done <- endpoint.call(ctx, client) }()
				select {
				case <-entered:
				case <-time.After(time.Second):
					t.Fatal("request did not reach server")
				}
				cancel()
				select {
				case err := <-done:
					if !errors.Is(err, context.Canceled) {
						t.Fatalf("cancellation lost: %v", err)
					}
				case <-time.After(time.Second):
					t.Fatal("request did not stop on cancellation")
				}
				if err := endpoint.call(ctx, client); !errors.Is(err, context.Canceled) {
					t.Fatalf("accepted cancelled request: %v", err)
				}
				if requests.Load() != 1 {
					t.Fatal("sent a new request after cancellation")
				}
			})
		}
	}
}
