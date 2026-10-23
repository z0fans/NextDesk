package probe

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"io"
	"math/big"
	"net"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const testSigningKey = "test-derived-probe-key"

type bannerConn struct {
	net.Conn
	reader    io.Reader
	readBytes int
	written   bytes.Buffer
}

func (conn *bannerConn) Read(p []byte) (int, error) {
	n, err := conn.reader.Read(p)
	conn.readBytes += n
	return n, err
}

func (conn *bannerConn) Write(p []byte) (int, error) { return conn.written.Write(p) }

func TestSSHBannerReadIsBounded(t *testing.T) {
	const identification = "SSH-2.0-TestServer\r\n"
	for _, tc := range []struct {
		name    string
		payload string
		tooBig  bool
	}{
		{"normal", identification, false},
		{"unterminated_line", strings.Repeat("x", 2*maxSSHBannerBytes), true},
		{"cumulative_lines", strings.Repeat(strings.Repeat("x", 349)+"\n", 30) + identification, true},
		{"exact_limit", strings.Repeat("x", maxSSHBannerBytes-len(identification)-1) + "\n" + identification, false},
		{"one_over_limit", strings.Repeat("x", maxSSHBannerBytes-len(identification)) + "\n" + identification, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			conn := &bannerConn{reader: strings.NewReader(tc.payload)}
			err := probeSSH(conn)
			if conn.readBytes > maxSSHBannerBytes+1 {
				t.Errorf("read %d bytes before rejecting the banner", conn.readBytes)
			}
			if tc.tooBig {
				if err == nil || err.Error() != "ssh_banner_too_large" {
					t.Errorf("expected size-limit error, got %v", err)
				}
				if conn.written.Len() != 0 {
					t.Error("sent identification after rejecting an oversized banner")
				}
			} else if err != nil || conn.written.String() != "SSH-2.0-NextDeskGatewayProbe_1.0\r\n" {
				t.Errorf("valid identification failed: %v", err)
			}
		})
	}
}

func signedTask(t *testing.T, service string, port int) Task {
	t.Helper()
	now := time.Now().UTC()
	stages := []string{"tcp", "ssh_identification"}
	if service == "rdp" {
		stages = []string{"tcp", "x224", "tls"}
	}
	task := Task{
		ProbeID: "prb_test_01", TargetHost: "127.0.0.1", TargetPort: port, ServiceKind: service,
		Stages: stages, IssuedAt: now.Format(time.RFC3339), DeadlineAt: now.Add(4 * time.Second).Format(time.RFC3339),
		ExpiresAt: now.Add(10 * time.Second).Format(time.RFC3339), PolicyRevision: "routing-test",
		SignatureVersion: SignatureVersion,
	}
	task.Signature = SignTask("agt_test", testSigningKey, task)
	return task
}

func TestVerifyTaskRejectsTamperingAndUnsafePolicy(t *testing.T) {
	task := signedTask(t, "ssh", 22)
	if err := VerifyTask(task, "agt_test", testSigningKey, map[int]bool{22: true}, time.Now()); err != nil {
		t.Fatalf("valid task rejected: %v", err)
	}
	if err := VerifyTask(task, "agt_other", testSigningKey, map[int]bool{22: true}, time.Now()); err == nil || err.Error() != "invalid_signature" {
		t.Fatalf("task could be replayed to another Agent: %v", err)
	}
	tampered := task
	tampered.TargetHost = "127.0.0.2"
	if err := VerifyTask(tampered, "agt_test", testSigningKey, map[int]bool{22: true}, time.Now()); err == nil || err.Error() != "invalid_signature" {
		t.Fatalf("tampered task not rejected: %v", err)
	}
	if err := VerifyTask(task, "agt_test", testSigningKey, map[int]bool{3389: true}, time.Now()); err == nil || err.Error() != "port_not_allowed" {
		t.Fatalf("non-whitelisted port not rejected: %v", err)
	}
	unknown := task
	unknown.ServiceKind = "http"
	unknown.Signature = SignTask("agt_test", testSigningKey, unknown)
	if err := VerifyTask(unknown, "agt_test", testSigningKey, map[int]bool{22: true}, time.Now()); err == nil || err.Error() != "unsupported_protocol" {
		t.Fatalf("unknown protocol not rejected: %v", err)
	}
	expired := task
	expired.DeadlineAt = time.Now().Add(-2 * time.Second).UTC().Format(time.RFC3339)
	expired.ExpiresAt = time.Now().Add(-time.Second).UTC().Format(time.RFC3339)
	expired.Signature = SignTask("agt_test", testSigningKey, expired)
	if err := VerifyTask(expired, "agt_test", testSigningKey, map[int]bool{22: true}, time.Now()); err == nil {
		t.Fatal("expired task was accepted")
	}
}

func TestTaskSignatureMatchesControlPlaneFixture(t *testing.T) {
	task := Task{
		ProbeID: "prb_fixture_01", TargetHost: "203.0.113.22", TargetPort: 22, ServiceKind: "ssh",
		Stages: []string{"tcp", "ssh_identification"}, IssuedAt: "2026-08-10T00:00:00+00:00",
		DeadlineAt: "2026-08-10T00:00:05+00:00", ExpiresAt: "2026-08-10T00:00:10+00:00",
		PolicyRevision: "routing-v1",
	}
	const expected = "e3fc14776f1485a61481e348f4fa4423db85430d92c12f2b11c2eed54a6170a9"
	if signature := SignTask("agt_test", "fixture-derived-key", task); signature != expected {
		t.Fatalf("control-plane signature mismatch: %s", signature)
	}
}

func TestExecuteSSHOnlyExchangesIdentification(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	clientLine := make(chan string, 1)
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		_, _ = io.WriteString(conn, "notice\r\nSSH-2.0-TestServer_1.0\r\n")
		buffer := make([]byte, 128)
		n, _ := conn.Read(buffer)
		clientLine <- string(buffer[:n])
	}()
	port := listener.Addr().(*net.TCPAddr).Port
	task := signedTask(t, "ssh", port)
	result := Execute(context.Background(), task, 3*time.Second)
	if result.Status != "success" || result.OutcomeCategory != "success" {
		t.Fatalf("SSH probe failed: %+v", result)
	}
	select {
	case line := <-clientLine:
		if line != "SSH-2.0-NextDeskGatewayProbe_1.0\r\n" {
			t.Fatalf("unexpected client identification %q", line)
		}
	case <-time.After(time.Second):
		t.Fatal("SSH probe did not send identification")
	}
}

func TestExecuteRDPStopsAfterX224AndTLS(t *testing.T) {
	certificate := testCertificate(t)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		request := make([]byte, len(rdpX224ConnectionRequest))
		if _, readErr := io.ReadFull(conn, request); readErr != nil {
			return
		}
		response := []byte{0x03, 0x00, 0x00, 0x13, 0x0e, 0xd0, 0x00, 0x00, 0x12, 0x34, 0x00, 0x02, 0x00, 0x08, 0x00, 0x01, 0x00, 0x00, 0x00}
		if _, writeErr := conn.Write(response); writeErr != nil {
			return
		}
		tlsConn := tls.Server(conn, &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12})
		_ = tlsConn.Handshake()
		_ = tlsConn.Close()
	}()
	port := listener.Addr().(*net.TCPAddr).Port
	task := signedTask(t, "rdp", port)
	result := Execute(context.Background(), task, 3*time.Second)
	if result.Status != "success" || result.StageDurationsMS["x224"] < 0 || result.StageDurationsMS["tls"] < 0 {
		t.Fatalf("RDP probe failed: %+v", result)
	}
}

func TestExecutorSharesInflightAndShortCache(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	var accepts atomic.Int32
	go func() {
		for {
			conn, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			accepts.Add(1)
			go func() {
				defer conn.Close()
				time.Sleep(80 * time.Millisecond)
				_, _ = io.WriteString(conn, "SSH-2.0-TestServer_1.0\r\n")
				buffer := make([]byte, 128)
				_, _ = conn.Read(buffer)
			}()
		}
	}()
	port := listener.Addr().(*net.TCPAddr).Port
	policy := Policy{AllowedPorts: map[int]bool{port: true}, MaxConcurrency: 1, Timeout: time.Second, MinTargetInterval: time.Second, CacheTTL: time.Second}
	executor := NewExecutor("agt_test", policy)
	results := make(chan Result, 3)
	first := signedTask(t, "ssh", port)
	second := first
	second.ProbeID = "prb_test_02"
	second.Signature = SignTask("agt_test", testSigningKey, second)
	executor.Submit(context.Background(), first, testSigningKey, func(result Result) { results <- result })
	executor.Submit(context.Background(), second, testSigningKey, func(result Result) { results <- result })
	seen := map[string]bool{}
	for len(seen) < 2 {
		select {
		case result := <-results:
			seen[result.ProbeID] = result.Status == "success"
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for shared probe results")
		}
	}
	third := first
	third.ProbeID = "prb_test_03"
	third.Signature = SignTask("agt_test", testSigningKey, third)
	executor.Submit(context.Background(), third, testSigningKey, func(result Result) { results <- result })
	select {
	case result := <-results:
		if result.Status != "success" || result.ProbeID != third.ProbeID {
			t.Fatalf("unexpected cached result: %+v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for cached result")
	}
	if accepts.Load() != 1 {
		t.Fatalf("expected one network probe, got %d", accepts.Load())
	}
}

func TestExecutorCancellationInterruptsActiveProbe(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan struct{}, 1)
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		accepted <- struct{}{}
		buffer := make([]byte, 1)
		_, _ = conn.Read(buffer)
	}()
	port := listener.Addr().(*net.TCPAddr).Port
	executor := NewExecutor("agt_test", Policy{
		AllowedPorts: map[int]bool{port: true}, MaxConcurrency: 1, Timeout: 5 * time.Second,
		MinTargetInterval: 100 * time.Millisecond, CacheTTL: time.Second,
	})
	task := signedTask(t, "ssh", port)
	results := make(chan Result, 1)
	executor.Submit(context.Background(), task, testSigningKey, func(result Result) { results <- result })
	select {
	case <-accepted:
	case <-time.After(time.Second):
		t.Fatal("probe did not connect")
	}
	if !executor.Cancel(task.ProbeID) {
		t.Fatal("active probe was not cancellable")
	}
	select {
	case result := <-results:
		if result.Status != "cancelled" || result.DiagnosticCode != "probe_cancelled" {
			t.Fatalf("unexpected cancellation result: %+v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation did not interrupt active probe")
	}
}

func TestExecutorEnforcesPerTargetRateLimitWithoutNetworkRetry(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	go func() {
		conn, acceptErr := listener.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		_, _ = io.WriteString(conn, "SSH-2.0-RateTest\r\n")
		buffer := make([]byte, 128)
		_, _ = conn.Read(buffer)
	}()
	port := listener.Addr().(*net.TCPAddr).Port
	executor := NewExecutor("agt_test", Policy{
		AllowedPorts: map[int]bool{port: true}, MaxConcurrency: 1, Timeout: time.Second,
		MinTargetInterval: 5 * time.Second, CacheTTL: 0,
	})
	results := make(chan Result, 2)
	first := signedTask(t, "ssh", port)
	executor.Submit(context.Background(), first, testSigningKey, func(result Result) { results <- result })
	select {
	case result := <-results:
		if result.Status != "success" {
			t.Fatalf("initial probe failed: %+v", result)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("initial probe timed out")
	}
	second := first
	second.ProbeID = "prb_rate_02"
	second.Signature = SignTask("agt_test", testSigningKey, second)
	executor.Submit(context.Background(), second, testSigningKey, func(result Result) { results <- result })
	select {
	case result := <-results:
		if result.DiagnosticCode != "probe_rate_limited" || result.OutcomeCategory != "resource_limited" {
			t.Fatalf("unexpected rate-limit result: %+v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("rate limit did not return a result")
	}
}

func TestExecutorEnforcesConcurrencyBeforeDialingSecondTarget(t *testing.T) {
	firstListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer firstListener.Close()
	secondListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer secondListener.Close()
	firstAccepted := make(chan struct{}, 1)
	go func() {
		conn, acceptErr := firstListener.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		firstAccepted <- struct{}{}
		buffer := make([]byte, 1)
		_, _ = conn.Read(buffer)
	}()
	secondAccepted := make(chan struct{}, 1)
	go func() {
		conn, acceptErr := secondListener.Accept()
		if acceptErr != nil {
			return
		}
		defer conn.Close()
		secondAccepted <- struct{}{}
	}()
	firstPort := firstListener.Addr().(*net.TCPAddr).Port
	secondPort := secondListener.Addr().(*net.TCPAddr).Port
	executor := NewExecutor("agt_test", Policy{
		AllowedPorts: map[int]bool{firstPort: true, secondPort: true}, MaxConcurrency: 1,
		Timeout: 5 * time.Second, MinTargetInterval: 100 * time.Millisecond, CacheTTL: time.Second,
	})
	results := make(chan Result, 2)
	first := signedTask(t, "ssh", firstPort)
	executor.Submit(context.Background(), first, testSigningKey, func(result Result) { results <- result })
	select {
	case <-firstAccepted:
	case <-time.After(time.Second):
		t.Fatal("first probe did not consume concurrency slot")
	}
	second := signedTask(t, "ssh", secondPort)
	second.ProbeID = "prb_concurrency_02"
	now := time.Now().UTC()
	second.IssuedAt = now.Format(time.RFC3339Nano)
	second.DeadlineAt = now.Add(250 * time.Millisecond).Format(time.RFC3339Nano)
	second.ExpiresAt = now.Add(time.Second).Format(time.RFC3339Nano)
	second.Signature = SignTask("agt_test", testSigningKey, second)
	executor.Submit(context.Background(), second, testSigningKey, func(result Result) { results <- result })
	select {
	case result := <-results:
		if result.ProbeID != second.ProbeID || result.DiagnosticCode != "probe_concurrency_limited" || result.OutcomeCategory != "resource_limited" {
			t.Fatalf("unexpected concurrency result: %+v", result)
		}
	case <-time.After(time.Second):
		t.Fatal("second probe did not respect concurrency deadline")
	}
	select {
	case <-secondAccepted:
		t.Fatal("second target was dialed despite exhausted concurrency")
	default:
	}
	if !executor.Cancel(first.ProbeID) {
		t.Fatal("failed to cancel first probe")
	}
}

func testCertificate(t *testing.T) tls.Certificate {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	template := x509.Certificate{
		SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "localhost"},
		NotBefore: time.Now().Add(-time.Minute), NotAfter: time.Now().Add(time.Hour),
		KeyUsage:    x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	certificate, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		t.Fatal(err)
	}
	return certificate
}
