package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
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
	Action     string   `json:"action"`
	BindingID  string   `json:"binding_id"`
	ListenPort int      `json:"listen_port"`
	TargetHost string   `json:"target_host"`
	TargetPort int      `json:"target_port"`
	Protocols  []string `json:"protocols"`
	ExpiresAt  string   `json:"expires_at"`
}

const agentVersion = "0.2.0"

func New(baseURL, agentID, agentToken string) Client {
	return Client{
		BaseURL:    strings.TrimRight(baseURL, "/"),
		AgentID:    agentID,
		AgentToken: agentToken,
		HTTP:       &http.Client{Timeout: 15 * time.Second},
	}
}

func (c Client) Heartbeat(metrics map[string]any) error {
	return c.post("/api/v1/connect/agent/heartbeat", map[string]any{
		"version": agentVersion,
		"metrics": metrics,
	}, nil)
}

func (c Client) Poll() ([]Task, error) {
	var out PollResponse
	if err := c.post("/api/v1/connect/agent/poll", map[string]any{}, &out); err != nil {
		return nil, err
	}
	return out.Data.Tasks, nil
}

func (c Client) Ack(bindingID, status, code, message string) error {
	return c.post("/api/v1/connect/agent/ack", map[string]any{
		"binding_id":    bindingID,
		"status":        bindingIDStatus(status),
		"error_code":    code,
		"error_message": message,
	}, nil)
}

func bindingIDStatus(status string) string {
	if status == "" {
		return "failed"
	}
	return status
}

func (c Client) post(path string, payload any, out any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, c.BaseURL+path, bytes.NewReader(body))
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
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("connect gateway %s returned %d: %s", path, resp.StatusCode, string(raw))
	}
	if out == nil {
		return nil
	}
	return json.Unmarshal(raw, out)
}
