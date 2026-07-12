# NextDesk Cloud-Only Authorization Mode Design

**Date:** 2026-07-12

## Goal

Convert NextDesk from a subscription and Clash/Mihomo based acceleration client into an RDP client with two connection paths only:

- authorized cloud relay acceleration;
- local direct connection.

The client no longer accepts subscription URLs, downloads proxy nodes, manages proxy groups, starts a bundled Clash/Mihomo process, or exposes node switching and delay testing.

## Product Decisions

- Remove subscriptions completely rather than hiding them.
- Remove the bundled Clash/Mihomo engine and its sidecars.
- Do not create or display standalone acceleration nodes.
- Add a dedicated Account page for browser authorization and device status.
- Remove the Cloud Mode switch. Authorization state determines whether the client attempts cloud acceleration.
- Keep saved RDP destinations and session management. They are user connection records, not acceleration nodes.
- Keep the Logs page for application, RDP, authorization, relay, fallback, clipboard, file, and audio diagnostics.
- Remove only Clash API connection lists, proxy traffic statistics, proxy switching logs, and other node-specific diagnostics.

## Navigation And UI

The main navigation contains:

1. Dashboard
2. Remote Desktop
3. Account
4. Logs
5. Settings

The existing Servers and Subscription/Proxy entries are removed.

### Account Page

The Account page owns the complete authorization workflow and has three explicit states.

#### Signed Out

- Show a primary action to sign in and authorize the current device.
- Explain account availability through status text from the cloud service, without exposing implementation details or subscription terminology.

#### Authorizing

- Show that browser authorization is in progress.
- Prevent duplicate authorization attempts.
- Allow the attempt to time out cleanly and be started again.

#### Signed In

- Show account display name.
- Show account entitlement expiration, when present.
- Show device authorization expiration, when present.
- Provide refresh-status and sign-out actions.
- Do not show a Cloud Mode toggle.

### Connection Route Status

Each RDP session exposes the route actually used:

- Cloud Accelerated
- LAN Direct
- Local Direct
- Cloud Unavailable, Fell Back To Direct

The UI must never label a direct connection as cloud accelerated.

### Dashboard

The Dashboard retains account authorization summary, RDP session summary, updater state, and general application status. It removes Clash process status, proxy node counts, subscription state, proxy traffic, and delay-test information.

### Logs

The Logs page remains available for troubleshooting and includes:

- application lifecycle logs;
- RDP connection and disconnection logs;
- cloud authorization and account-status logs;
- relay selection, binding, renewal, and close logs;
- cloud failure and direct-fallback decisions;
- clipboard, file transfer, audio, and renderer errors;
- refresh, clear, and diagnostic-bundle actions.

Device tokens, authorization codes, credentials, cookies, and complete sensitive request payloads must not be logged.

## Architecture

All RDP engines use one connection-resolution boundary before opening a transport:

```text
RDP connection request
  -> classify destination
     -> private, loopback, or local destination: direct connection
     -> public destination
        -> authorized: request and probe cloud relay binding
           -> cloud route available: connect through relay
           -> cloud route unavailable: local direct connection
        -> not authorized: local direct connection
```

### Retained Modules

- `cloud_auth.rs` owns browser authorization, callback validation, device-token storage, status refresh, and sign-out.
- `cloud_gateway.rs` owns cloud account, prepare, probe, commit, bind, renew, abort, and close API calls.
- `cloud_probe.rs` owns candidate reachability probing.
- `connection_resolver.rs` owns destination classification, cloud-first routing, cached binding reuse, and direct fallback.
- RDP session, rendering, clipboard, file, audio, updater, configuration, and diagnostic logging modules remain.

### Removed Modules And Surfaces

- subscription loading and parsing;
- subscription authorization markers and metadata nodes;
- subscription auto-update scheduler and events;
- proxy server and proxy-group state;
- Clash/Mihomo lifecycle management and REST API calls;
- node switching and delay testing;
- legacy Dashboard API-key relay endpoint flow;
- bundled Mihomo sidecars, permissions, packaging entries, and dependencies used only by that engine.

The legacy `relay.rs` API-key endpoint flow is removed in favor of the authenticated `cloud_gateway.rs` binding flow.

### Unified RDP Routing

Native RDP, WASM RDP, and KKTerm must call the same resolver or consume an equivalent resolved-target contract. No engine may independently decide to use Clash, a SOCKS port, or a legacy relay endpoint.

The resolved target contains at least:

- effective host and port;
- route kind;
- optional cloud binding ID;
- fallback reason, when applicable;
- whether transport must connect directly without a local proxy.

## Connection Rules

### LAN And Local Destinations

Private IPv4 ranges, private IPv6 ranges, loopback addresses, link-local addresses, and recognized local hostnames connect directly. They do not request a cloud binding.

### Public Destinations While Signed In

The resolver requests cloud candidates, probes them within a bounded timeout, commits the selected route, and returns the relay endpoint. Existing reusable bindings may be reused when still valid.

### Public Destinations While Signed Out

The resolver immediately returns the original public host and port as a local direct route. Authorization is optional for basic RDP connectivity and required only for cloud acceleration.

### Cloud Failure

Cloud discovery, status, preparation, probe, commit, bind, or entitlement failures fall back to the original public destination. The fallback is visible in both session status and logs.

Cloud attempts must use short bounded timeouts so an unavailable control plane does not make local RDP appear hung.

### Authorization Failure

- Temporary network errors preserve the stored device token and signed-in metadata.
- Explicit `401`, `403`, revoked-device, or expired-device responses mark the device unauthorized.
- Account entitlement expiration is displayed on the Account page and causes public RDP connections to use local direct routing.

### Existing Sessions

A transient binding-renewal failure does not proactively close a working TCP session. A later reconnect runs resolution again and may select cloud relay or direct fallback.

## Configuration Migration

Old configuration files remain readable during upgrade.

- Removed subscription, server-node, proxy-group, auto-update, Clash, and legacy relay fields are ignored.
- Saved RDP connection records remain untouched in their existing owner module.
- Cloud device ID, authorization metadata, and securely stored device token remain available.
- The next successful configuration write omits obsolete fields, naturally cleaning the file without a destructive migration.
- Migration must not delete user RDP credentials, connection groups, display settings, or session preferences.

## Error Presentation

User-visible errors distinguish authorization from routing:

- authorization required for acceleration;
- authorization expired;
- account entitlement expired;
- cloud route unavailable, using local direct connection;
- cloud route failed and local direct connection also failed;
- ordinary RDP authentication and transport failures.

A successful direct fallback is a warning/status event, not a connection failure.

## Testing

### Rust Tests

- private and loopback destinations always resolve directly;
- public signed-out destinations resolve directly without cloud requests;
- public authorized destinations use a successful cloud binding;
- cloud timeout, no candidates, probe failure, commit failure, and entitlement failure resolve directly;
- `401/403` invalidates authorization while transient network errors do not;
- binding reuse and renewal preserve expected route labels;
- all RDP engines consume the unified resolved-target behavior;
- old configuration with subscription and Clash fields loads without losing retained data.

### Frontend Tests

- Account page renders signed-out, authorizing, signed-in, expired, and error states;
- duplicate authorization attempts are blocked;
- refresh and sign-out update the page correctly;
- route labels accurately represent cloud, LAN direct, local direct, and fallback states;
- Dashboard contains no subscription or Clash metrics;
- Logs retains diagnostic actions and contains no proxy-node controls;
- removed navigation entries and translations are absent.

### Static And Packaging Checks

- no registered subscription scheduler or subscription Tauri commands;
- no proxy-node, proxy-group, switch-proxy, or delay-test frontend calls;
- no Mihomo sidecars in Tauri platform configuration;
- no obsolete permissions or engine-only dependencies;
- no remaining user-visible subscription terminology.

### Build And Runtime Verification

- run targeted frontend tests and the full frontend build;
- run targeted Rust tests and the applicable Cargo test suite;
- run formatting and diff checks;
- start the repository-local Tauri development build;
- verify browser authorization and account refresh;
- verify a public RDP connection through cloud relay;
- make the cloud service unavailable and verify visible direct fallback;
- verify an unauthorized public RDP connection uses local direct routing;
- verify a LAN RDP connection never requests cloud routing;
- inspect repository-local logs to confirm the active runtime and route decisions.

Windows-only behavior that cannot be exercised locally must be marked `Not Verified` and accompanied by a manual acceptance script.

## Acceptance Criteria

- No subscription URL or subscription-management UI remains.
- No standalone acceleration-node list remains.
- NextDesk does not start or package Clash/Mihomo.
- The Account page is the only cloud authorization control surface.
- Authorization automatically enables cloud acceleration attempts without a separate switch.
- Signed-out, expired, or cloud-unavailable public connections fall back to local direct routing.
- LAN connections remain direct.
- Every session reports the route actually used.
- Troubleshooting logs and diagnostic-bundle controls remain available.
- Existing RDP connection records and cloud authorization data survive upgrade.
