# Cloud Mode (云端模式) Implementation Plan

> **For Antigravity:** REQUIRED WORKFLOW: Use `.agent/workflows/execute-plan.md` to execute this plan in single-flow mode.

**Goal:** Add "Cloud Mode" to NextDesk — a third connection mode that automatically syncs relay rules from Dashboard and dynamically creates forwarding rules on-demand when users connect to new RDP targets.

**Architecture:** Two-layer design: (1) Dashboard gains a `POST /api/relay/routes/auto` endpoint that accepts `target_host:port`, auto-creates Target+Route, deploys to Realm, returns relay endpoint. (2) NextDesk gains `relay.rs` module that calls Dashboard API — first checks cached endpoints, if no match calls auto-create, then connects through returned `relay_host:listen_port`. All existing Builtin/Reuse modes remain untouched.

**Tech Stack:** Dashboard: Next.js API Routes, better-sqlite3, ssh2. NextDesk: Rust (reqwest, serde, tokio), React 19 + TypeScript, Tauri 2.

---

## Task Overview

| # | Task | Location | Files |
|---|------|----------|-------|
| 1 | Dashboard: Auto-create API endpoint | Dashboard | `route.ts` (new), `relay.ts` |
| 2 | NextDesk: AppState + Config fields | NextDesk | `state.rs`, `config.rs` |
| 3 | NextDesk: Relay API client | NextDesk | `relay.rs` (new) |
| 4 | NextDesk: Tauri commands | NextDesk | `lib.rs` |
| 5 | NextDesk: rdp_proxy cloud branch | NextDesk | `rdp_proxy.rs` |
| 6 | NextDesk: Frontend API + types | NextDesk | `api.ts` |
| 7 | NextDesk: Settings UI | NextDesk | `App.tsx` |
| 8 | NextDesk: Dashboard cloud view | NextDesk | `App.tsx` |
| 9 | NextDesk: i18n | NextDesk | `translations.ts` |
| 10 | Verification | Both | compile + build |

---

### Task 1: Dashboard — Auto-Create Relay Route API

**Files:** Create `dashboard/src/app/api/relay/routes/auto/route.ts`

**What it does:** NextDesk POSTs `{ target_host, target_port }` → Dashboard checks if route exists → if not, creates Target + Route + allocates port + deploys to Realm → returns `{ host, port }`.

**Key logic:**
- Auth via `authorizeRelayApiKey`
- Port allocation: scan `relay_routes` for server, pick first unused in 10000-60000
- Pick relay server with least routes (`ORDER BY route_count ASC`)
- Call existing `deployRealmConfig(serverId)` after creating route
- If route already exists for same target, return it without re-creating

**Verify:** `cd dashboard && npx next build 2>&1 | tail -10`

---

### Task 2: NextDesk — AppState + Config

**Files:** Modify `state.rs`, `config.rs`

- Add `RelayEndpoint` struct (id, name, host, port, protocol, server_name)
- Add `cloud_mode/dashboard_url/relay_api_key/relay_endpoints` to AppState
- Extend `RunMode` with `cloud_mode: bool, dashboard_url: String`
- Extend `SavedConfig` with cloud fields (all `#[serde(default)]`)

**Verify:** `cargo check --manifest-path src-tauri/Cargo.toml`

---

### Task 3: NextDesk — Relay API Client (`relay.rs`)

**Files:** Create `src-tauri/src/relay.rs`, add `mod relay;` in `lib.rs`

Three functions:
1. `fetch_endpoints(url, key)` — GET `/api/relay/endpoints`
2. `auto_create_route(url, key, host, port)` — POST `/api/relay/routes/auto`
3. `find_relay_for_dest(endpoints, host, port)` — cache lookup by name pattern

**Verify:** `cargo check`

---

### Task 4: NextDesk — Tauri Commands

**Files:** Modify `lib.rs`

- `set_cloud_mode(enabled, url, key)` — save + fetch endpoints
- `refresh_relay_endpoints()` — re-fetch from Dashboard
- `get_relay_endpoints()` — return cached list
- Update `get_run_mode` to return cloud fields
- Load saved config in `run()`
- Pass cloud state to `rdp_proxy::start_proxy()`
- Register in `generate_handler![]`

**Verify:** `cargo check`

---

### Task 5: rdp_proxy Cloud Branch

**Files:** Modify `rdp_proxy.rs`

- Add cloud args to `start_proxy/handle_client/handle_inner`
- Extract X.224→TLS→relay into `handle_normal_path()` helper
- After tube check, add cloud branch:
  1. Try `find_relay_for_dest()` on cache
  2. If no match → `auto_create_route()` (Dashboard auto-creates + deploys)
  3. TCP connect to `relay_host:relay_port`
  4. `handle_normal_path()` with relay TCP
  5. Fallback to SOCKS5 on error

**Verify:** `cargo check`

---

### Task 6: Frontend API (`api.ts`)

Add `RelayEndpoint` type, update `RunMode`, add `setCloudMode/refreshRelayEndpoints/getRelayEndpoints`

### Task 7: Settings UI (`App.tsx`)

Cloud Mode card: toggle + URL/Key inputs + Save & Sync + endpoint count

### Task 8: Dashboard View (`App.tsx`)

Relay endpoint list card when cloud mode active + refresh button

### Task 9: i18n (`translations.ts`)

Keys: cloudMode, enableCloudMode, saveAndSync, endpointsSynced, cloudRelay, noEndpoints, autoCreateInfo (en + zh)

---

### Task 10: Verification

1. `cd dashboard && npx next build`
2. `cargo check --manifest-path src-tauri/Cargo.toml`
3. `cd frontend && npx tsc --noEmit`
4. `cd frontend && npm run build`
