package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"nextdesk/gateway-agent/internal/probe"
)

type Client struct {
	BaseURL    string
	AgentID    string
	AgentToken string
	HTTP       *http.Client
}

type PollResponse struct {
	Data struct {
		Tasks []Task `json:"tasks"`
	} `json:"data"`
}

type Task struct {
	Action     string      `json:"action"`
	BindingID  string      `json:"binding_id"`
	ListenPort int         `json:"listen_port"`
	TargetHost string      `json:"target_host"`
	TargetPort int         `json:"target_port"`
	Protocols  []string    `json:"protocols"`
	ExpiresAt  string      `json:"expires_at"`
	Probe      *probe.Task `json:"probe,omitempty"`
}

type HeartbeatConfig struct {
	ProbeTaskKey string `json:"probe_task_key"`
}

type heartbeatResponse struct {
	Data struct {
		Status       string `json:"status"`
		ProbeTaskKey string `json:"probe_task_key"`
	} `json:"data"`
}

const Version = "0.4.1"
const maxResponseBytes = 1 << 20

func AgentCapabilities() map[string]any {
	return map[string]any{
		"schema_version":       1,
		"task_types":           []string{"create_binding", "delete_binding", "probe_target", "cancel_probe"},
		"forwarding_protocols": []string{"tcp", "udp"},
		"features":             []string{"heartbeat_capabilities", "target_probe_v1"},
	}
}

func New(baseURL, agentID, agentToken string) Client {
	return Client{
		BaseURL:    strings.TrimRight(baseURL, "/"),
		AgentID:    agentID,
		AgentToken: agentToken,
		HTTP:       &http.Client{Timeout: 15 * time.Second},
	}
}

func (c Client) Heartbeat(ctx context.Context, metrics map[string]any) (HeartbeatConfig, error) {
	var response heartbeatResponse
	err := c.post(ctx, "/api/v1/connect/agent/heartbeat", map[string]any{
		"version":      Version,
		"metrics":      metrics,
		"capabilities": AgentCapabilities(),
	}, &response)
	return HeartbeatConfig{ProbeTaskKey: response.Data.ProbeTaskKey}, err
}

func (c Client) Poll(ctx context.Context) ([]Task, error) {
	var out PollResponse
	if err := c.post(ctx, "/api/v1/connect/agent/poll", map[string]any{}, &out); err != nil {
		return nil, err
	}
	return out.Data.Tasks, nil
}

func (c Client) Ack(ctx context.Context, bindingID, status, code, message string) error {
	return c.post(ctx, "/api/v1/connect/agent/ack", map[string]any{
		"binding_id":    bindingID,
		"status":        bindingIDStatus(status),
		"error_code":    code,
		"error_message": message,
	}, nil)
}

func (c Client) ProbeResult(ctx context.Context, result probe.Result) error {
	return c.post(ctx, "/api/v1/connect/agent/probe-result", result, nil)
}

func bindingIDStatus(status string) string {
	if status == "" {
		return "failed"
	}
	return status
}

func (c Client) post(ctx context.Context, path string, payload any, out any) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+c.AgentToken)
	req.Header.Set("X-Agent-Id", c.AgentID)

	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBytes+1))
	if err != nil {
		return fmt.Errorf("read connect gateway %s response: %w", path, err)
	}
	if len(raw) > maxResponseBytes {
		return fmt.Errorf("connect gateway %s response exceeds %d bytes", path, maxResponseBytes)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("connect gateway %s returned %d: %s", path, resp.StatusCode, string(raw))
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}
