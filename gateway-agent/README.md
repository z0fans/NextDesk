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

Binding IDs are validated before any realm filesystem or systemd operation; `.` and `..` are rejected to protect the shared instance and profile directories. Unsupported task actions are ignored without deleting or acknowledging existing bindings, and the remaining tasks in the poll batch continue.

Apply commits the persisted rule after the instance configuration and service checks succeed. A failed update retains the previous rule, restores the previous instance configuration, and attempts to restart an instance that was previously active; rollback errors are returned to the caller. A failed new instance is stopped and its new configuration is removed. This handles reported operation failures, not process crashes or power loss between files. Deletion reports service and filesystem errors instead of acknowledging success; instance cleanup failure retains the rule for retry. Damaged or mismatched rule records are reported individually without blocking healthy records, and reconciliation never restarts expired bindings.

Restricted target probes use a separate in-memory executor and never call realm, systemd, or the binding listener path. The local `probe_allowed_ports` list is an independent safety boundary: a signed task for any other port is rejected before a TCP connection is attempted. SSH probes stop after identification exchange, while RDP probes stop after X.224 and TLS; no user credential is available to or sent by the probe executor.

All control-plane response bodies, including errors and responses without `Content-Length`, are limited to 1 MiB. SSH identification and pre-banner lines share an 8 KiB budget. Both readers consume at most one extra byte to detect overflow before rejecting the input; they do not drain an oversized stream. Response read failures are returned even for ACKs.

## 0.4.1 compatibility

Upgrade ConnectGateway to 0.1.48 before deploying this Agent. Failed applies can leave a restored old listener alive; the plugin retains its port and sends the existing `delete_binding` task until deletion is acknowledged. A failed update is still reported as `failed`, not as a successful lease renewal. The plugin also ignores ACKs that do not match the current binding state.

Cancellation of an unknown probe (for example after an Agent restart) returns a `cancelled` result through the existing probe-result endpoint. Active probes report cancellation when they finish. The plugin finalizes abandoned cancellation on expiry for older Agents as well. No new task type or required request field is introduced. Run `connect-gateway-agent --version` to inspect the binary without reading configuration.

## Shutdown and one-shot execution

SIGINT and SIGTERM cancel both normal polling and `--once`. The same context reaches heartbeat, poll, ACK, probe-result requests, realm commands, queued probes, and active probe sockets. The runner stops accepting the remaining batch after cancellation and joins accepted probe work, including result callbacks, before returning. Each Runner is used for one `Run` or `Once` invocation; its probe executor closes on exit.

HTTP keeps its 15-second request timeout. Each `systemctl` command has a 10-second deadline and a one-second process wait allowance. An interrupted realm mutation still restores its previous configuration and attempts the necessary stop or restart under a separate 15-second rollback budget, even when the main context is cancelled. Rollback failures remain visible in returned errors and logs. Successfully committed bindings retain their normal independent service lifecycle.

`--once` waits for all accepted probes and their result requests to finish; a result-delivery or ACK failure makes the invocation fail. During shutdown, cancelled delivery attempts are reported explicitly and are not retried. The Agent has no durable delivery queue. ConnectGateway 0.1.48 reissues unacknowledged binding and probe tasks, reserves ports until cleanup is confirmed, and deduplicates terminal probe results. The existing protocol has no task revision: it rejects incompatible state transitions but cannot distinguish two overlapping applies in the same pending state. Run only one Agent process per Agent identity. Killing the Agent process or losing power can still interrupt rollback; local tests use fake systemctl and HTTP servers rather than a live control plane or systemd host.

## Capability heartbeat

Version 0.4.0 adds the optional `probe_target` and `cancel_probe` task types plus the `target_probe_v1` feature. Older agents may omit these declarations and continue processing only the existing `create_binding` and `delete_binding` tasks; ConnectGateway does not send probe tasks to them.

Country, subregion, China-optimized line tags, carrier/ASN reachability and failure-domain metadata are configured by an administrator in ConnectGateway. They describe this individual Agent and are not inferred from a `JP` or `MY` label.

The carrier-affinity and failure-domain shadow scheduler still runs entirely in ConnectGateway. Target probes add raw observations for later policy stages; they do not let the Agent choose a route or change the live candidate and winner.
