package probe

import (
	"context"
	"errors"
	"io"
	"net"
	"sync"
	"testing"
	"time"
)

func TestExecutorShutdownCancelsActiveAndQueuedProbes(t *testing.T) {
	for _, viaParent := range []bool{true, false} {
		name := "close"
		if viaParent {
			name = "parent"
		}
		t.Run(name, func(t *testing.T) {
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
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			executor := NewExecutor("agt_test", Policy{AllowedPorts: map[int]bool{port: true}, MaxConcurrency: 1, Timeout: 10 * time.Second})
			defer executor.Close()
			results := make(chan Result, 2)
			task := signedTask(t, "ssh", port)
			report := func(result Result) { results <- result }
			if err := executor.Submit(ctx, task, testSigningKey, report); err != nil {
				t.Fatal(err)
			}
			var conn net.Conn
			select {
			case conn = <-accepted:
			case <-time.After(time.Second):
				t.Fatal("probe did not start")
			}
			defer conn.Close()
			queued := task
			queued.ProbeID = "prb_queued"
			queued.ServiceKind = "rdp"
			queued.Stages = []string{"tcp", "x224", "tls"}
			queued.Signature = SignTask("agt_test", testSigningKey, queued)
			if err := executor.Submit(ctx, queued, testSigningKey, report); err != nil {
				t.Fatal(err)
			}
			stopped := make(chan struct{})
			if viaParent {
				cancel()
			}
			go func() { executor.Close(); close(stopped) }()
			select {
			case <-stopped:
			case <-time.After(time.Second):
				t.Fatal("executor shutdown did not join its tasks")
			}
			for range []int{0, 1} {
				select {
				case result := <-results:
					if result.Status != "cancelled" {
						t.Fatalf("task escaped cancellation: %+v", result)
					}
				default:
					t.Fatal("shutdown returned before result delivery")
				}
			}
			_ = conn.SetReadDeadline(time.Now().Add(time.Second))
			var one [1]byte
			if n, err := conn.Read(one[:]); n != 0 || err != io.EOF {
				t.Fatalf("active socket not closed: n=%d err=%v", n, err)
			}
			if err := executor.Submit(context.Background(), task, testSigningKey, report); !errors.Is(err, context.Canceled) {
				t.Fatalf("closed executor accepted work: %v", err)
			}
			executor.mu.Lock()
			remaining := len(executor.active) + len(executor.byID)
			executor.mu.Unlock()
			if remaining != 0 {
				t.Fatal("shutdown retained active work")
			}
			_ = listener.(*net.TCPListener).SetDeadline(time.Now().Add(30 * time.Millisecond))
			if extra, err := listener.Accept(); err == nil {
				extra.Close()
				t.Fatal("queued target was dialed after shutdown")
			}
		})
	}
}

func TestExecutorRejectsCancelledSubmissionsBeforeReporting(t *testing.T) {
	executor := NewExecutor("agt_test", Policy{AllowedPorts: map[int]bool{22: true}, MaxConcurrency: 1})
	defer executor.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	for _, task := range []Task{signedTask(t, "ssh", 22), {ProbeID: "invalid"}} {
		if err := executor.Submit(ctx, task, testSigningKey, func(Result) { t.Error("cancelled submission ran callback") }); !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled submission accepted: %v", err)
		}
	}
}

func TestExecutorCloseWaitsForAcceptedReport(t *testing.T) {
	executor := NewExecutor("agt_test", Policy{MaxConcurrency: 1})
	entered, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	submitted := make(chan error, 1)
	go func() {
		submitted <- executor.Submit(context.Background(), Task{ProbeID: "invalid"}, "", func(Result) { close(entered); <-release })
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("report not started")
	}
	closed := make(chan struct{})
	go func() { executor.Close(); close(closed) }()
	select {
	case <-closed:
		t.Fatal("close returned while accepted report was active")
	case <-time.After(30 * time.Millisecond):
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("close did not join report")
	}
	if err := <-submitted; err != nil {
		t.Fatal(err)
	}
}
