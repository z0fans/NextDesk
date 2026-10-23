package probe

import (
	"bufio"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/tls"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"time"
)

const SignatureVersion = "hmac-sha256-v1"
const maxSSHBannerBytes = 8 * 1024

var rdpX224ConnectionRequest = []byte{
	0x03, 0x00, 0x00, 0x13, 0x0e, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00, 0x08, 0x00, 0x03,
	0x00, 0x00, 0x00,
}

type Task struct {
	ProbeID          string   `json:"probe_id"`
	TargetHost       string   `json:"target_host"`
	TargetPort       int      `json:"target_port"`
	ServiceKind      string   `json:"service_kind"`
	Stages           []string `json:"stages"`
	IssuedAt         string   `json:"issued_at"`
	DeadlineAt       string   `json:"deadline_at"`
	ExpiresAt        string   `json:"expires_at"`
	PolicyRevision   string   `json:"policy_revision"`
	SignatureVersion string   `json:"signature_version"`
	Signature        string   `json:"signature"`
}

type Result struct {
	ProbeID          string           `json:"probe_id"`
	Status           string           `json:"status"`
	OutcomeCategory  string           `json:"outcome_category"`
	StartedAt        string           `json:"started_at"`
	CompletedAt      string           `json:"completed_at"`
	StageDurationsMS map[string]int64 `json:"stage_durations_ms"`
	DiagnosticCode   string           `json:"diagnostic_code,omitempty"`
}

type Policy struct {
	AllowedPorts      map[int]bool
	MaxConcurrency    int
	Timeout           time.Duration
	MinTargetInterval time.Duration
	CacheTTL          time.Duration
}

func CanonicalTask(agentID string, task Task) string {
	return strings.Join([]string{
		"probe-task-v1",
		agentID,
		task.ProbeID,
		strings.ToLower(task.ServiceKind),
		task.TargetHost,
		strconv.Itoa(task.TargetPort),
		strings.Join(task.Stages, ","),
		task.IssuedAt,
		task.DeadlineAt,
		task.ExpiresAt,
		task.PolicyRevision,
	}, "\n")
}

func SignTask(agentID, key string, task Task) string {
	mac := hmac.New(sha256.New, []byte(key))
	_, _ = mac.Write([]byte(CanonicalTask(agentID, task)))
	return hex.EncodeToString(mac.Sum(nil))
}

func VerifyTask(task Task, agentID, key string, allowedPorts map[int]bool, now time.Time) error {
	if key == "" || task.SignatureVersion != SignatureVersion {
		return errors.New("invalid_signature")
	}
	if !validIdentifier(task.ProbeID) {
		return errors.New("invalid_probe_id")
	}
	if !validTargetHost(task.TargetHost) {
		return errors.New("invalid_target")
	}
	if !allowedPorts[task.TargetPort] {
		return errors.New("port_not_allowed")
	}
	if !validStages(task.ServiceKind, task.Stages) {
		return errors.New("unsupported_protocol")
	}
	issuedAt, err := time.Parse(time.RFC3339, task.IssuedAt)
	if err != nil || issuedAt.After(now.Add(30*time.Second)) {
		return errors.New("invalid_issued_at")
	}
	deadlineAt, err := time.Parse(time.RFC3339, task.DeadlineAt)
	if err != nil || !deadlineAt.After(now) || deadlineAt.After(now.Add(15*time.Second)) {
		return errors.New("invalid_deadline")
	}
	expiresAt, err := time.Parse(time.RFC3339, task.ExpiresAt)
	if err != nil || !expiresAt.After(now) || expiresAt.Before(deadlineAt) {
		return errors.New("probe_expired")
	}
	expected := SignTask(agentID, key, task)
	provided, err := hex.DecodeString(task.Signature)
	if err != nil {
		return errors.New("invalid_signature")
	}
	expectedBytes, _ := hex.DecodeString(expected)
	if !hmac.Equal(provided, expectedBytes) {
		return errors.New("invalid_signature")
	}
	return nil
}

func validIdentifier(value string) bool {
	if len(value) < 4 || len(value) > 96 {
		return false
	}
	for _, ch := range value {
		if (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch == '_' || ch == '-' {
			continue
		}
		return false
	}
	return true
}

func validTargetHost(value string) bool {
	if value == "" || len(value) > 253 || strings.TrimSpace(value) != value {
		return false
	}
	for _, ch := range value {
		if ch <= 0x20 || ch == 0x7f || ch == '/' || ch == '\\' {
			return false
		}
	}
	return true
}

func validStages(serviceKind string, stages []string) bool {
	expected := []string{"tcp", "ssh_identification"}
	if strings.ToLower(serviceKind) == "rdp" {
		expected = []string{"tcp", "x224", "tls"}
	} else if strings.ToLower(serviceKind) != "ssh" {
		return false
	}
	if len(stages) != len(expected) {
		return false
	}
	for index := range expected {
		if stages[index] != expected[index] {
			return false
		}
	}
	return true
}

func Execute(parent context.Context, task Task, timeout time.Duration) Result {
	started := time.Now().UTC()
	result := Result{
		ProbeID:          task.ProbeID,
		Status:           "failed",
		OutcomeCategory:  "protocol_error",
		StartedAt:        started.Format(time.RFC3339Nano),
		StageDurationsMS: map[string]int64{},
	}
	deadline, _ := time.Parse(time.RFC3339, task.DeadlineAt)
	if timeoutDeadline := started.Add(timeout); deadline.IsZero() || timeoutDeadline.Before(deadline) {
		deadline = timeoutDeadline
	}
	ctx, cancel := context.WithDeadline(parent, deadline)
	defer cancel()

	address := net.JoinHostPort(task.TargetHost, strconv.Itoa(task.TargetPort))
	tcpStarted := time.Now()
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", address)
	result.StageDurationsMS["tcp"] = durationMS(tcpStarted)
	if err != nil {
		return finishFailure(result, err, "tcp_connect_failed")
	}
	defer conn.Close()
	_ = conn.SetDeadline(deadline)
	cancelWatch := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			_ = conn.Close()
		case <-cancelWatch:
		}
	}()
	defer close(cancelWatch)

	if strings.ToLower(task.ServiceKind) == "ssh" {
		stageStarted := time.Now()
		err = probeSSH(conn)
		result.StageDurationsMS["ssh_identification"] = durationMS(stageStarted)
		if err != nil {
			if ctx.Err() != nil {
				err = ctx.Err()
			}
			return finishFailure(result, err, "ssh_identification_failed")
		}
	} else {
		stageStarted := time.Now()
		err = probeX224(conn)
		result.StageDurationsMS["x224"] = durationMS(stageStarted)
		if err != nil {
			if ctx.Err() != nil {
				err = ctx.Err()
			}
			return finishFailure(result, err, "x224_negotiation_failed")
		}
		stageStarted = time.Now()
		tlsConfig := &tls.Config{InsecureSkipVerify: true, MinVersion: tls.VersionTLS12} // Metrics only; no credentials are sent.
		if net.ParseIP(task.TargetHost) == nil {
			tlsConfig.ServerName = task.TargetHost
		}
		tlsConn := tls.Client(conn, tlsConfig)
		err = tlsConn.HandshakeContext(ctx)
		result.StageDurationsMS["tls"] = durationMS(stageStarted)
		if err != nil {
			if ctx.Err() != nil {
				err = ctx.Err()
			}
			return finishFailure(result, err, "tls_handshake_failed")
		}
		_ = tlsConn.Close()
	}

	result.Status = "success"
	result.OutcomeCategory = "success"
	result.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
	return result
}

func probeSSH(conn net.Conn) error {
	reader := bufio.NewReaderSize(io.LimitReader(conn, maxSSHBannerBytes+1), maxSSHBannerBytes)
	total := 0
	for lineCount := 0; lineCount < 50; lineCount++ {
		line, err := reader.ReadString('\n')
		total += len(line)
		if total > maxSSHBannerBytes {
			return errors.New("ssh_banner_too_large")
		}
		if err != nil {
			return err
		}
		line = strings.TrimRight(line, "\r\n")
		if strings.HasPrefix(line, "SSH-2.0-") {
			_, err = io.WriteString(conn, "SSH-2.0-NextDeskGatewayProbe_1.0\r\n")
			return err
		}
		if strings.HasPrefix(line, "SSH-") {
			return errors.New("ssh_version_unsupported")
		}
	}
	return errors.New("ssh_identification_missing")
}

func probeX224(conn net.Conn) error {
	if _, err := conn.Write(rdpX224ConnectionRequest); err != nil {
		return err
	}
	header := make([]byte, 4)
	if _, err := io.ReadFull(conn, header); err != nil {
		return err
	}
	if header[0] != 0x03 || header[1] != 0x00 {
		return errors.New("invalid_tpkt_response")
	}
	length := int(header[2])<<8 | int(header[3])
	if length < 11 || length > 4096 {
		return errors.New("invalid_tpkt_length")
	}
	body := make([]byte, length-4)
	if _, err := io.ReadFull(conn, body); err != nil {
		return err
	}
	if len(body) < 15 || body[7] != 0x02 {
		return errors.New("rdp_tls_not_selected")
	}
	return nil
}

func durationMS(started time.Time) int64 {
	return max(0, time.Since(started).Milliseconds())
}

func finishFailure(result Result, err error, fallbackCode string) Result {
	result.CompletedAt = time.Now().UTC().Format(time.RFC3339Nano)
	result.DiagnosticCode = sanitizeCode(fallbackCode)
	if errors.Is(err, context.Canceled) {
		result.Status = "cancelled"
		result.OutcomeCategory = "cancelled"
		result.DiagnosticCode = "probe_cancelled"
		return result
	}
	if errors.Is(err, context.DeadlineExceeded) {
		result.OutcomeCategory = "network_timeout"
		result.DiagnosticCode = "probe_deadline_exceeded"
		return result
	}
	if networkError, ok := err.(net.Error); ok && networkError.Timeout() {
		result.OutcomeCategory = "network_timeout"
		result.DiagnosticCode = "network_timeout"
		return result
	}
	var operationError *net.OpError
	if errors.As(err, &operationError) {
		result.OutcomeCategory = "network_unreachable"
	}
	return result
}

func sanitizeCode(code string) string {
	switch code {
	case "tcp_connect_failed", "ssh_identification_failed", "x224_negotiation_failed", "tls_handshake_failed",
		"probe_deadline_exceeded", "probe_cancelled", "network_timeout", "invalid_signature", "invalid_probe_id",
		"invalid_target", "port_not_allowed", "unsupported_protocol", "invalid_issued_at", "invalid_deadline",
		"probe_expired", "probe_rate_limited", "probe_concurrency_limited":
		return code
	default:
		return "probe_failed"
	}
}

func RejectedResult(probeID string, err error) Result {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	code := sanitizeCode(err.Error())
	outcome := "policy_rejected"
	if code == "probe_rate_limited" || code == "probe_concurrency_limited" {
		outcome = "resource_limited"
	}
	return Result{
		ProbeID: probeID, Status: "rejected", OutcomeCategory: outcome,
		StartedAt: now, CompletedAt: now, StageDurationsMS: map[string]int64{}, DiagnosticCode: code,
	}
}

type cachedResult struct {
	result    Result
	expiresAt time.Time
}

type activeProbe struct {
	task    Task
	cancel  context.CancelFunc
	aliases map[string]struct{}
}

type Executor struct {
	agentID string
	policy  Policy
	sem     chan struct{}
	mu      sync.Mutex
	wg      sync.WaitGroup
	closed  bool
	active  map[string]*activeProbe
	byID    map[string]*activeProbe
	cache   map[string]cachedResult
	lastRun map[string]time.Time
}

func NewExecutor(agentID string, policy Policy) *Executor {
	if policy.MaxConcurrency < 1 {
		policy.MaxConcurrency = 1
	}
	return &Executor{
		agentID: agentID, policy: policy, sem: make(chan struct{}, policy.MaxConcurrency),
		active: map[string]*activeProbe{}, byID: map[string]*activeProbe{}, cache: map[string]cachedResult{}, lastRun: map[string]time.Time{},
	}
}

func (executor *Executor) Submit(parent context.Context, task Task, signingKey string, report func(Result)) error {
	executor.mu.Lock()
	if err := parent.Err(); err != nil {
		executor.mu.Unlock()
		return err
	}
	if executor.closed {
		executor.mu.Unlock()
		return context.Canceled
	}
	executor.wg.Add(1)
	executor.mu.Unlock()
	defer executor.wg.Done()
	now := time.Now().UTC()
	if err := VerifyTask(task, executor.agentID, signingKey, executor.policy.AllowedPorts, now); err != nil {
		report(RejectedResult(task.ProbeID, err))
		return nil
	}
	key := taskKey(task)
	executor.mu.Lock()
	if err := parent.Err(); err != nil {
		executor.mu.Unlock()
		return err
	}
	if executor.closed {
		executor.mu.Unlock()
		return context.Canceled
	}
	for cacheKey, cached := range executor.cache {
		if !cached.expiresAt.After(now) {
			delete(executor.cache, cacheKey)
		}
	}
	if cached, ok := executor.cache[key]; ok {
		executor.mu.Unlock()
		result := cached.result
		result.ProbeID = task.ProbeID
		report(result)
		return nil
	}
	if active, ok := executor.active[key]; ok {
		active.aliases[task.ProbeID] = struct{}{}
		executor.byID[task.ProbeID] = active
		executor.mu.Unlock()
		return nil
	}
	if last := executor.lastRun[key]; !last.IsZero() && now.Sub(last) < executor.policy.MinTargetInterval {
		executor.mu.Unlock()
		report(RejectedResult(task.ProbeID, errors.New("probe_rate_limited")))
		return nil
	}
	ctx, cancel := context.WithCancel(parent)
	active := &activeProbe{task: task, cancel: cancel, aliases: map[string]struct{}{task.ProbeID: {}}}
	executor.active[key] = active
	executor.byID[task.ProbeID] = active
	executor.lastRun[key] = now
	executor.wg.Add(1)
	executor.mu.Unlock()

	go executor.run(ctx, key, active, report)
	return nil
}

func (executor *Executor) run(ctx context.Context, key string, active *activeProbe, report func(Result)) {
	defer executor.wg.Done()
	defer active.cancel()
	deadline, _ := time.Parse(time.RFC3339, active.task.DeadlineAt)
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	select {
	case executor.sem <- struct{}{}:
		defer func() { <-executor.sem }()
	case <-ctx.Done():
		executor.complete(key, active, finishFailure(Result{ProbeID: active.task.ProbeID, Status: "failed", OutcomeCategory: "cancelled", StartedAt: time.Now().UTC().Format(time.RFC3339Nano), StageDurationsMS: map[string]int64{}}, ctx.Err(), "probe_cancelled"), report)
		return
	case <-timer.C:
		executor.complete(key, active, RejectedResult(active.task.ProbeID, errors.New("probe_concurrency_limited")), report)
		return
	}
	result := Execute(ctx, active.task, executor.policy.Timeout)
	executor.complete(key, active, result, report)
}

func (executor *Executor) complete(key string, active *activeProbe, result Result, report func(Result)) {
	now := time.Now()
	executor.mu.Lock()
	delete(executor.active, key)
	aliases := make([]string, 0, len(active.aliases))
	for probeID := range active.aliases {
		aliases = append(aliases, probeID)
		delete(executor.byID, probeID)
	}
	if executor.policy.CacheTTL > 0 && result.Status != "cancelled" {
		executor.cache[key] = cachedResult{result: result, expiresAt: now.Add(executor.policy.CacheTTL)}
	}
	executor.mu.Unlock()
	for _, probeID := range aliases {
		aliasResult := result
		aliasResult.ProbeID = probeID
		report(aliasResult)
	}
}

// Wait includes result delivery. The caller must finish submitting before waiting.
func (executor *Executor) Wait() {
	executor.wg.Wait()
}

// Close rejects further submissions and cancels and joins all accepted work.
// Report callbacks must honor the parent context and use bounded I/O.
func (executor *Executor) Close() {
	executor.mu.Lock()
	executor.closed = true
	for _, active := range executor.active {
		active.cancel()
	}
	executor.mu.Unlock()
	executor.wg.Wait()
}

func (executor *Executor) Cancel(probeID string) bool {
	executor.mu.Lock()
	active := executor.byID[probeID]
	executor.mu.Unlock()
	if active == nil {
		return false
	}
	active.cancel()
	return true
}

func taskKey(task Task) string {
	return strings.ToLower(task.ServiceKind) + "|" + strings.ToLower(task.TargetHost) + "|" + strconv.Itoa(task.TargetPort)
}

func (task Task) String() string {
	return fmt.Sprintf("%s:%s/%s", task.TargetHost, strconv.Itoa(task.TargetPort), task.ServiceKind)
}
