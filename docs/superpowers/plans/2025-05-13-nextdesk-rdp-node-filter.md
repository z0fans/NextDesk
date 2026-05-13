# NextDesk RDP Node Filter — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Protect RDP-dedicated acceleration nodes from being used by non-NextDesk clients, by filtering subscription responses based on User-Agent.

**Architecture:** XBoard plugin hooks into `client.subscribe.servers` filter to hide `rdp-only` tagged nodes from non-NextDesk clients. NextDesk client sends a custom User-Agent to identify itself.

**Tech Stack:** PHP 8.2 (XBoard plugin), Rust (NextDesk client UA change)

---

## File Structure

| File | Action | Responsibility |
|:---|:---|:---|
| `plugins/NextDeskFilter/config.json` | ✅ Created | Plugin metadata and configurable settings |
| `plugins/NextDeskFilter/Plugin.php` | ✅ Created | Core filter logic with fail-open safety |
| `plugins/NextDeskFilter/README.md` | ✅ Created | Installation and usage documentation |
| `src-tauri/src/subscription.rs` | ✅ Modified | User-Agent changed to `NextDesk/{version}` |
| `docs/superpowers/specs/2025-05-13-nextdesk-rdp-node-filter-design.md` | ✅ Created | Design specification |

**Status: All code is already implemented.** The remaining tasks are verification, testing, and commit.

---

### Task 1: Verify Rust Compilation

**Files:**
- Verify: `src-tauri/src/subscription.rs:56`

- [ ] **Step 1: Run cargo check**

```bash
cd src-tauri && cargo check
```

Expected: `Finished` with no errors (warnings are acceptable).

- [ ] **Step 2: Verify the UA string resolves correctly**

```bash
cd src-tauri && cargo build 2>&1 | grep -i error
```

Expected: No errors. The `concat!("NextDesk/", env!("CARGO_PKG_VERSION"), " (rdp-accelerator)")` macro resolves at compile time to `NextDesk/1.0.95 (rdp-accelerator)`.

- [ ] **Step 3: Commit the client-side change**

```bash
git add src-tauri/src/subscription.rs
git commit -m "feat(subscription): use NextDesk-specific User-Agent for XBoard node filtering"
```

---

### Task 2: Validate PHP Plugin Syntax and Structure

**Files:**
- Verify: `plugins/NextDeskFilter/Plugin.php`
- Verify: `plugins/NextDeskFilter/config.json`

- [ ] **Step 1: PHP syntax check**

```bash
php -l plugins/NextDeskFilter/Plugin.php
```

Expected: `No syntax errors detected`

- [ ] **Step 2: Validate config.json is valid JSON**

```bash
python3 -c "import json; json.load(open('plugins/NextDeskFilter/config.json')); print('OK')"
```

Expected: `OK`

- [ ] **Step 3: Verify plugin directory structure matches XBoard convention**

Required structure:
```
plugins/NextDeskFilter/
├── Plugin.php      ← namespace Plugin\NextDeskFilter, extends AbstractPlugin
├── config.json     ← "code": "nextdesk_filter"
└── README.md
```

Verify the `code` field in config.json matches the directory name convention (PascalCase dir → snake_case code):
- Directory: `NextDeskFilter`
- Code: `nextdesk_filter`

- [ ] **Step 4: Commit the plugin**

```bash
git add plugins/NextDeskFilter/
git commit -m "feat(plugin): add NextDeskFilter XBoard plugin for RDP node protection"
```

---

### Task 3: Commit Design Documentation

**Files:**
- Commit: `docs/superpowers/specs/2025-05-13-nextdesk-rdp-node-filter-design.md`
- Commit: `docs/superpowers/plans/2025-05-13-nextdesk-rdp-node-filter.md`

- [ ] **Step 1: Commit spec and plan**

```bash
git add docs/superpowers/
git commit -m "docs: add RDP node filter design spec and implementation plan"
```

---

### Task 4: Create Deployment Verification Script

**Files:**
- Create: `plugins/NextDeskFilter/verify.sh`

This script can be run on the XBoard server after deployment to verify the plugin is working.

- [ ] **Step 1: Write the verification script**

```bash
#!/bin/bash
# Verify NextDeskFilter plugin deployment on XBoard server.
# Run from the XBoard project root.

set -e

echo "=== NextDeskFilter Deployment Verification ==="

# 1. Check plugin files exist
echo -n "[1/4] Plugin files... "
if [ -f "plugins/NextDeskFilter/Plugin.php" ] && [ -f "plugins/NextDeskFilter/config.json" ]; then
    echo "OK"
else
    echo "FAIL - Plugin files missing"
    exit 1
fi

# 2. PHP syntax check
echo -n "[2/4] PHP syntax... "
php -l plugins/NextDeskFilter/Plugin.php 2>/dev/null | grep -q "No syntax errors"
echo "OK"

# 3. JSON validity
echo -n "[3/4] config.json... "
php -r "json_decode(file_get_contents('plugins/NextDeskFilter/config.json'), true); echo json_last_error() === 0 ? 'OK' : 'FAIL';"
echo ""

# 4. Check hook availability (requires XBoard artisan)
echo -n "[4/4] Hook system... "
if command -v php &> /dev/null && [ -f "artisan" ]; then
    php artisan hook:list 2>/dev/null | grep -q "client.subscribe" && echo "OK" || echo "SKIP (hook not listed, may still work)"
else
    echo "SKIP (not in XBoard root)"
fi

echo ""
echo "=== Deployment verification complete ==="
echo ""
echo "Next steps:"
echo "  1. Enable plugin in XBoard admin panel"
echo "  2. Add 'rdp-only' tag to RDP-dedicated nodes"
echo "  3. Test with: curl -H 'User-Agent: NextDesk/1.0.95' YOUR_SUBSCRIBE_URL"
echo "  4. Test with: curl -H 'User-Agent: clash-verge/v2.0' YOUR_SUBSCRIBE_URL"
echo "  5. Compare: NextDesk response should have more nodes than Clash response"
```

- [ ] **Step 2: Make it executable and commit**

```bash
chmod +x plugins/NextDeskFilter/verify.sh
git add plugins/NextDeskFilter/verify.sh
git commit -m "feat(plugin): add deployment verification script"
```

---

### Task 5: Manual Integration Test (Post-Deployment)

This task is performed after deploying the plugin to your XBoard server.

**Prerequisites:**
- XBoard server accessible
- At least one node with `rdp-only` tag configured
- Plugin enabled in XBoard admin

- [ ] **Step 1: Test NextDesk UA — should see rdp-only nodes**

```bash
# Replace with your actual subscribe URL
SUBSCRIBE_URL="https://your-xboard.com/api/v1/client/subscribe?token=YOUR_TOKEN"

curl -s -H "User-Agent: NextDesk/1.0.95 (rdp-accelerator)" "$SUBSCRIBE_URL" > /tmp/nextdesk_sub.yaml
echo "NextDesk nodes:"
grep -c "name:" /tmp/nextdesk_sub.yaml
```

Expected: Shows all nodes including rdp-only ones.

- [ ] **Step 2: Test Clash Verge UA — should NOT see rdp-only nodes**

```bash
curl -s -H "User-Agent: clash-verge/v2.0.0" "$SUBSCRIBE_URL" > /tmp/clash_sub.yaml
echo "Clash nodes:"
grep -c "name:" /tmp/clash_sub.yaml
```

Expected: Fewer nodes than Step 1 (rdp-only nodes filtered out).

- [ ] **Step 3: Test with flag parameter**

```bash
curl -s "$SUBSCRIBE_URL&flag=nextdesk" > /tmp/flag_sub.yaml
echo "Flag=nextdesk nodes:"
grep -c "name:" /tmp/flag_sub.yaml
```

Expected: Same count as Step 1 (flag parameter also triggers NextDesk detection).

- [ ] **Step 4: Verify fail-open — disable plugin and confirm subscription still works**

Temporarily disable the plugin in XBoard admin, then:

```bash
curl -s -H "User-Agent: NextDesk/1.0.95" "$SUBSCRIBE_URL" | head -5
```

Expected: Subscription still returns valid content (all nodes, since plugin is disabled).

Re-enable the plugin after verification.

---

## Summary

| Task | Status | Description |
|:---|:---|:---|
| Task 1 | Code done, needs commit | Rust UA change verification |
| Task 2 | Code done, needs commit | PHP plugin validation |
| Task 3 | Written, needs commit | Documentation |
| Task 4 | Needs creation | Deployment verification script |
| Task 5 | Post-deployment | Manual integration testing |

**Total estimated time:** 15-20 minutes (Tasks 1-4 are local, Task 5 requires XBoard server access).
