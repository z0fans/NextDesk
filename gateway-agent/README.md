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
  "port_range": "42000-42999",
  "probe_allowed_ports": [22, 3389],
  "probe_max_concurrency": 4,
  "probe_timeout_seconds": 5,
  "probe_target_min_interval_ms": 1000,
  "probe_cache_seconds": 45
}
```

## Dry Run

```bash
connect-gateway-agent --config ./config.json --dry-run --once
```

Dry-run writes per-binding realm configs under `/tmp/connect-gateway-agent` and does not call `systemctl`.

The agent reconciles persisted rules after restart and removes locally expired bindings even if the control plane is temporarily unavailable.

Restricted target probes use a separate in-memory executor and never call realm, systemd, or the binding listener path. The local `probe_allowed_ports` list is an independent safety boundary: a signed task for any other port is rejected before a TCP connection is attempted. SSH probes stop after identification exchange, while RDP probes stop after X.224 and TLS; no user credential is available to or sent by the probe executor.

## Capability heartbeat

Version 0.4.0 adds the optional `probe_target` and `cancel_probe` task types plus the `target_probe_v1` feature. Older agents may omit these declarations and continue processing only the existing `create_binding` and `delete_binding` tasks; ConnectGateway does not send probe tasks to them.

Country, subregion, China-optimized line tags, carrier/ASN reachability and failure-domain metadata are configured by an administrator in ConnectGateway. They describe this individual Agent and are not inferred from a `JP` or `MY` label.

The carrier-affinity and failure-domain shadow scheduler still runs entirely in ConnectGateway. Target probes add raw observations for later policy stages; they do not let the Agent choose a route or change the live candidate and winner.
