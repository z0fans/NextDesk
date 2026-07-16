# Connect Gateway Agent

`gateway-agent` runs on each edge server, polls the Xboard `ConnectGateway` plugin, and applies TCP+UDP realm-xwPF bindings under the isolated `cg` profile. Each binding uses an independent `realm-cg@<binding>.service` instance, so route churn does not restart unrelated RDP sessions.

## Config

Default path:

```text
/etc/connect-gateway-agent/config.json
```

Example:

```json
{
  "base_url": "https://panel.example.com",
  "agent_id": "agt_xxx",
  "agent_token": "agt_secret_xxx",
  "realm_profile": "cg",
  "poll_interval_seconds": 2,
  "public_host": "edge.example.net",
  "port_range": "42000-42999"
}
```

## Dry Run

```bash
connect-gateway-agent --config ./config.json --dry-run --once
```

Dry-run writes per-binding realm configs under `/tmp/connect-gateway-agent` and does not call `systemctl`.

The agent reconciles persisted rules after restart and removes locally expired bindings even if the control plane is temporarily unavailable.
