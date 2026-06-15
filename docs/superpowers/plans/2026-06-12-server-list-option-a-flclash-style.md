# Server List Option A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current fold-dependent server list with a FlClash-inspired, NextDesk-specific server group selector and stable delay-test panel.

**Architecture:** Move server-list derivation and delay-target calculation into pure helpers, then render one active group detail panel instead of duplicating top cards plus expanded cards. Delay testing is explicit by scope: current group or all RDP real nodes; it must never depend on UI expansion state.

**Tech Stack:** React 19, TypeScript, Tailwind CSS v4, Vitest, Testing Library, Tauri invoke API through `frontend/src/api.ts`.

---

## File Structure

- Modify: `frontend/src/App.tsx`
  - Replace `expandedGroups`-driven server page rendering with `activeServerGroupName`.
  - Replace `handleTestConnectivity()` with scoped delay testing.
  - Render top group selector cards and one active group node list.
- Create: `frontend/src/lib/server-list.ts`
  - Pure helper functions for selectable RDP groups, node filtering, active group fallback, delay text, delay color, and delay target resolution.
- Create: `frontend/src/lib/server-list.test.ts`
  - Unit tests for helper behavior, especially “folded UI does not affect delay target”.
- Optional modify: `frontend/src/i18n/translations.ts`
  - Only if new visible labels are not already covered by existing translation keys.
- Keep: `docs/superpowers/mockups/server-list-option-a-demo.html`
  - Visual reference only; it must not be imported by the app.

## Non-Goals

- Do not change Rust/Tauri delay APIs.
- Do not change subscription format, Mihomo config generation, or node parsing.
- Do not add generic Clash proxy features outside the RDP-focused NextDesk page.
- Do not push or tag until the user explicitly asks.

## Data Model Rules

- `servers` is the source of real RDP proxy node names.
- `proxyGroups` may contain select groups, fallback groups, subgroups, and `DIRECT`.
- Only nodes whose names exist in `servers.map(server => server.name)` are real RDP nodes for delay display.
- `nodeDelays` remains a global map keyed by proxy name.
- `activeServerGroupName` controls visible detail panel only.
- Delay test target is resolved from explicit scope:
  - `{ type: 'all' }` -> all selectable server groups containing real RDP nodes.
  - `{ type: 'group', groupName }` -> that group only, if it contains real RDP nodes.

---

### Task 1: Add Pure Server List Helpers

**Files:**
- Create: `frontend/src/lib/server-list.ts`
- Create: `frontend/src/lib/server-list.test.ts`

- [ ] **Step 1: Create helper module**

Create `frontend/src/lib/server-list.ts`:

```ts
import type { ProxyGroup, Server } from '@/api';

export type DelayScope =
  | { type: 'all' }
  | { type: 'group'; groupName: string };

export type DelayStatus = 'unknown' | 'testing' | 'timeout' | 'good' | 'medium' | 'slow';

export function realProxyNameSet(servers: Server[]): Set<string> {
  return new Set(servers.map((server) => server.name));
}

export function isSelectableServerGroup(group: ProxyGroup, realProxyNames: Set<string>): boolean {
  return group.type.toLowerCase().includes('select')
    && group.proxies.some((proxy) => realProxyNames.has(proxy));
}

export function selectableServerGroups(groups: ProxyGroup[], servers: Server[]): ProxyGroup[] {
  const realProxyNames = realProxyNameSet(servers);
  return groups.filter((group) => isSelectableServerGroup(group, realProxyNames));
}

export function groupRealNodes(group: ProxyGroup, servers: Server[]): string[] {
  const realProxyNames = realProxyNameSet(servers);
  return group.proxies.filter((proxy) => realProxyNames.has(proxy));
}

export function resolveActiveServerGroupName(
  current: string | null,
  groups: ProxyGroup[],
  servers: Server[],
): string | null {
  const selectable = selectableServerGroups(groups, servers);
  if (selectable.length === 0) {
    return null;
  }
  if (current && selectable.some((group) => group.name === current)) {
    return current;
  }
  return selectable[0].name;
}

export function resolveDelayTargetGroups(
  scope: DelayScope,
  groups: ProxyGroup[],
  servers: Server[],
): string[] {
  const selectable = selectableServerGroups(groups, servers);
  if (scope.type === 'all') {
    return selectable.map((group) => group.name);
  }
  return selectable.some((group) => group.name === scope.groupName)
    ? [scope.groupName]
    : [];
}

export function delayStatus(delay: number | undefined): DelayStatus {
  if (delay === undefined) return 'unknown';
  if (delay === 0) return 'testing';
  if (delay === -1) return 'timeout';
  if (delay < 100) return 'good';
  if (delay < 300) return 'medium';
  return 'slow';
}

export function delayText(delay: number | undefined): string | null {
  if (delay === undefined) return null;
  if (delay === 0) return '...';
  if (delay === -1) return '--';
  return `${delay}ms`;
}
```

- [ ] **Step 2: Add helper tests**

Create `frontend/src/lib/server-list.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ProxyGroup, Server } from '@/api';
import {
  delayStatus,
  delayText,
  groupRealNodes,
  resolveActiveServerGroupName,
  resolveDelayTargetGroups,
  selectableServerGroups,
} from './server-list';

const servers: Server[] = [
  { id: '1', name: 'US Server Only 01', host: 'us1.example.com', port: 3389, status: 'unknown' },
  { id: '2', name: 'US Server Only 02', host: 'us2.example.com', port: 3389, status: 'unknown' },
  { id: '3', name: 'HK Server Only 01', host: 'hk1.example.com', port: 3389, status: 'unknown' },
];

const groups: ProxyGroup[] = [
  {
    name: 'Server-Americas',
    type: 'Select',
    now: 'US Server Only 01',
    proxies: ['Auto-Americas', 'US Server Only 01', 'US Server Only 02', 'DIRECT'],
  },
  {
    name: 'Server-Asia',
    type: 'Select',
    now: 'HK Server Only 01',
    proxies: ['Auto-Asia', 'HK Server Only 01', 'DIRECT'],
  },
  {
    name: 'Auto-Americas',
    type: 'Fallback',
    now: 'US Server Only 01',
    proxies: ['US Server Only 01', 'US Server Only 02'],
  },
];

describe('server list helpers', () => {
  it('returns only select groups that contain real RDP nodes', () => {
    expect(selectableServerGroups(groups, servers).map((group) => group.name)).toEqual([
      'Server-Americas',
      'Server-Asia',
    ]);
  });

  it('filters subgroup and DIRECT entries from group nodes', () => {
    expect(groupRealNodes(groups[0], servers)).toEqual([
      'US Server Only 01',
      'US Server Only 02',
    ]);
  });

  it('keeps active group if it is still selectable', () => {
    expect(resolveActiveServerGroupName('Server-Asia', groups, servers)).toBe('Server-Asia');
  });

  it('falls back to first selectable group when active group disappears', () => {
    expect(resolveActiveServerGroupName('Missing', groups, servers)).toBe('Server-Americas');
  });

  it('resolves all delay targets without reading expansion state', () => {
    expect(resolveDelayTargetGroups({ type: 'all' }, groups, servers)).toEqual([
      'Server-Americas',
      'Server-Asia',
    ]);
  });

  it('resolves a single delay target by explicit group scope', () => {
    expect(resolveDelayTargetGroups({ type: 'group', groupName: 'Server-Asia' }, groups, servers)).toEqual([
      'Server-Asia',
    ]);
  });

  it('returns no delay target for non-selectable groups', () => {
    expect(resolveDelayTargetGroups({ type: 'group', groupName: 'Auto-Americas' }, groups, servers)).toEqual([]);
  });

  it('formats delay states consistently', () => {
    expect(delayText(undefined)).toBeNull();
    expect(delayText(0)).toBe('...');
    expect(delayText(-1)).toBe('--');
    expect(delayText(168)).toBe('168ms');
    expect(delayStatus(undefined)).toBe('unknown');
    expect(delayStatus(0)).toBe('testing');
    expect(delayStatus(-1)).toBe('timeout');
    expect(delayStatus(47)).toBe('good');
    expect(delayStatus(168)).toBe('medium');
    expect(delayStatus(420)).toBe('slow');
  });
});
```

- [ ] **Step 3: Run helper tests**

Run:

```bash
cd frontend
npm run test -- src/lib/server-list.test.ts
```

Expected:

```text
PASS  src/lib/server-list.test.ts
```

- [ ] **Step 4: Commit helper task**

```bash
git add frontend/src/lib/server-list.ts frontend/src/lib/server-list.test.ts
git commit -m "test(servers): 增加服务器列表测速目标测试"
```

---

### Task 2: Replace Fold-Driven Delay Target Logic

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Import helpers**

At the top of `frontend/src/App.tsx`, add:

```ts
import {
  delayStatus,
  delayText,
  groupRealNodes,
  resolveActiveServerGroupName,
  resolveDelayTargetGroups,
  selectableServerGroups,
  type DelayScope,
} from '@/lib/server-list';
```

- [ ] **Step 2: Replace expansion state**

Replace:

```ts
const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
```

with:

```ts
const [activeServerGroupName, setActiveServerGroupName] = useState<string | null>(null);
const [testingGroups, setTestingGroups] = useState<Set<string>>(new Set());
```

Remove `toggleGroupExpansion` if it is no longer used after Task 3.

- [ ] **Step 3: Add derived active group effect**

Add after state declarations or near other derived state effects:

```ts
useEffect(() => {
  setActiveServerGroupName((current) =>
    resolveActiveServerGroupName(current, proxyGroups, servers)
  );
}, [proxyGroups, servers]);
```

- [ ] **Step 4: Replace `handleTestConnectivity`**

Replace the existing `handleTestConnectivity` body with:

```ts
const handleTestConnectivity = async (scope: DelayScope = { type: 'all' }) => {
  const targetGroupNames = resolveDelayTargetGroups(scope, proxyGroups, servers);

  if (targetGroupNames.length === 0) {
    return;
  }

  const setGroupDelayState = (groupName: string, value: number) => {
    const group = proxyGroups.find((item) => item.name === groupName);
    if (!group) {
      return;
    }

    const entries = groupRealNodes(group, servers);
    if (entries.length === 0) {
      return;
    }

    setNodeDelays((prev) => ({
      ...prev,
      ...Object.fromEntries(entries.map((proxy) => [proxy, value])),
    }));
  };

  setTestingConnectivity(true);
  setTestingGroups((prev) => new Set([...prev, ...targetGroupNames]));

  try {
    await ensureEngineRunningForDelayTest();
    for (const groupName of targetGroupNames) {
      setGroupDelayState(groupName, 0);
      try {
        const delays = await api.testGroupDelays(groupName);
        setNodeDelays((prev) => ({ ...prev, ...delays }));
      } catch (error) {
        setGroupDelayState(groupName, -1);
        console.error(`Failed to test connectivity for ${groupName}`, error);
      }
    }
  } catch (error) {
    console.error('Failed to test connectivity', error);
  } finally {
    setTestingConnectivity(false);
    setTestingGroups((prev) => {
      const next = new Set(prev);
      targetGroupNames.forEach((groupName) => next.delete(groupName));
      return next;
    });
  }
};
```

- [ ] **Step 5: Run targeted frontend build**

Run:

```bash
cd frontend
npm run build
```

Expected:

```text
✓ built in ...
```

- [ ] **Step 6: Commit delay logic task**

```bash
git add frontend/src/App.tsx
git commit -m "fix(servers): 解耦节点测速与折叠状态"
```

---

### Task 3: Implement Option A Server Page Layout

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Add derived values inside servers tab render**

Inside the `activeTab === 'servers'` render block, before `return`, define:

```ts
const realGroups = selectableServerGroups(proxyGroups, servers);
const activeGroup = realGroups.find((group) => group.name === activeServerGroupName) ?? realGroups[0];
const activeGroupNodes = activeGroup ? groupRealNodes(activeGroup, servers) : [];
```

- [ ] **Step 2: Keep the existing `getGroupMeta` shape**

Reuse the existing `getGroupMeta(group.name)` function. Do not change translation keys unless the UI needs a new label.

- [ ] **Step 3: Replace top cards with group selector cards**

Render only `realGroups.map(...)`, not all `proxyGroups.map(...)`.

Each card must:

```tsx
<button
  key={group.name}
  type="button"
  onClick={() => setActiveServerGroupName(group.name)}
  className={cn(
    "relative bg-card/80 backdrop-blur-sm border rounded-2xl overflow-hidden text-left transition-all duration-200",
    "hover:border-border/80 hover:shadow-[0_8px_32px_rgba(0,0,0,0.18)]",
    `border-l-4 ${meta.accentBg}`,
    activeGroup?.name === group.name
      ? "border-border shadow-[0_10px_32px_rgba(15,23,42,0.12)]"
      : "border-border/70"
  )}
>
  ...
</button>
```

Card behavior:

- No expand/collapse button.
- Show `group.now || selectedProxies[group.name] || first real node`.
- Show selected node delay if available via `nodeDelays[selectedProxy]`.
- Show `...` if the group is currently in `testingGroups`.

- [ ] **Step 4: Replace expanded duplicate sections with one active group panel**

Render one panel for `activeGroup`.

Panel header:

- group icon
- display name
- description
- current selected node
- `测速当前分组` icon button
- sort segmented control can be static initially: default / delay / name, with only default active unless sorting is implemented in Task 4.

Node grid:

```tsx
activeGroupNodes.map((proxy) => {
  const isSelected = selectedProxy === proxy;
  const delay = nodeDelays[proxy];
  const status = delayStatus(delay);
  const text = delayText(delay);
  ...
});
```

Node button behavior:

- `onClick={() => handleProxySelect(activeGroup.name, proxy)}`
- shows delay text if present
- shows `...` while testing
- shows `--` on timeout

- [ ] **Step 5: Update header buttons**

In the server page header:

- Primary action: `测速全部`
- Secondary action: `测速当前分组`
- Both actions live in normal header flow, not fixed positioning.

Use:

```tsx
onClick={() => handleTestConnectivity({ type: 'all' })}
```

and:

```tsx
onClick={() => activeGroup && handleTestConnectivity({ type: 'group', groupName: activeGroup.name })}
```

- [ ] **Step 6: Run build**

```bash
cd frontend
npm run build
```

Expected:

```text
✓ built in ...
```

- [ ] **Step 7: Commit layout task**

```bash
git add frontend/src/App.tsx
git commit -m "refactor(servers): 改为单分组节点列表设计"
```

---

### Task 4: Add Sorting Without Changing Delay Scope

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/lib/server-list.ts`
- Modify: `frontend/src/lib/server-list.test.ts`

- [ ] **Step 1: Add sort state**

In `App.tsx`:

```ts
const [serverNodeSort, setServerNodeSort] = useState<'default' | 'delay' | 'name'>('default');
```

- [ ] **Step 2: Add helper function**

Append to `frontend/src/lib/server-list.ts`:

```ts
export type ServerNodeSort = 'default' | 'delay' | 'name';

export function sortServerNodes(
  nodes: string[],
  delays: Record<string, number>,
  sort: ServerNodeSort,
): string[] {
  if (sort === 'default') {
    return nodes;
  }

  return [...nodes].sort((a, b) => {
    if (sort === 'name') {
      return a.localeCompare(b);
    }

    const aDelay = delays[a];
    const bDelay = delays[b];
    const aRank = aDelay === undefined ? Number.MAX_SAFE_INTEGER : aDelay === -1 ? Number.MAX_SAFE_INTEGER - 1 : aDelay;
    const bRank = bDelay === undefined ? Number.MAX_SAFE_INTEGER : bDelay === -1 ? Number.MAX_SAFE_INTEGER - 1 : bDelay;
    return aRank - bRank || a.localeCompare(b);
  });
}
```

- [ ] **Step 3: Add sorting tests**

Append to `frontend/src/lib/server-list.test.ts`:

```ts
import { sortServerNodes } from './server-list';

it('sorts nodes by delay without mutating original order', () => {
  const nodes = ['US Server Only 01', 'US Server Only 02', 'HK Server Only 01'];
  const sorted = sortServerNodes(nodes, {
    'US Server Only 01': 168,
    'US Server Only 02': -1,
    'HK Server Only 01': 47,
  }, 'delay');

  expect(sorted).toEqual(['HK Server Only 01', 'US Server Only 01', 'US Server Only 02']);
  expect(nodes).toEqual(['US Server Only 01', 'US Server Only 02', 'HK Server Only 01']);
});

it('keeps default node order when sort is default', () => {
  const nodes = ['US Server Only 02', 'US Server Only 01'];
  expect(sortServerNodes(nodes, {}, 'default')).toBe(nodes);
});
```

- [ ] **Step 4: Use sorted nodes in App**

Replace:

```ts
const activeGroupNodes = activeGroup ? groupRealNodes(activeGroup, servers) : [];
```

with:

```ts
const activeGroupNodes = activeGroup
  ? sortServerNodes(groupRealNodes(activeGroup, servers), nodeDelays, serverNodeSort)
  : [];
```

Import `sortServerNodes` and `type ServerNodeSort`.

- [ ] **Step 5: Wire segmented buttons**

Each segmented button must call:

```tsx
setServerNodeSort('default')
setServerNodeSort('delay')
setServerNodeSort('name')
```

The active button is based on `serverNodeSort`.

- [ ] **Step 6: Run tests and build**

```bash
cd frontend
npm run test -- src/lib/server-list.test.ts
npm run build
```

Expected:

```text
PASS  src/lib/server-list.test.ts
✓ built in ...
```

- [ ] **Step 7: Commit sorting task**

```bash
git add frontend/src/App.tsx frontend/src/lib/server-list.ts frontend/src/lib/server-list.test.ts
git commit -m "feat(servers): 增加节点排序控制"
```

---

### Task 5: Responsive and Visual QA

**Files:**
- Modify: `frontend/src/App.tsx` if visual issues are found
- Modify: `frontend/src/index.css` only if reusable scrollbar or overflow utilities are needed

- [ ] **Step 1: Start app in development mode**

```bash
npx tauri dev
```

Expected:

```text
Local: http://localhost:5173/
```

- [ ] **Step 2: Manual desktop checks**

At desktop width:

- Header buttons must not overlay any group card.
- Cards must not extend under the right edge or scrollbar.
- Long node names must truncate inside their container.
- `测速全部` must show `...` for all real nodes, then values or `--`.
- `测速当前分组` must affect only the active group.
- Switching group during or after testing must not clear delay values.

- [ ] **Step 3: Manual narrow width checks**

At narrow width:

- Group cards stack vertically.
- Toolbar wraps without overlapping title.
- Node list is one column.
- No horizontal scrollbar.
- Current node pill text truncates cleanly.

- [ ] **Step 4: Verify app build**

```bash
cd frontend
npm run build
```

Expected:

```text
✓ built in ...
```

- [ ] **Step 5: Commit visual QA task if code changed**

```bash
git add frontend/src/App.tsx frontend/src/index.css
git commit -m "fix(servers): 优化服务器列表响应式布局"
```

If no code changed, skip commit.

---

### Task 6: Runtime Delay Verification on macOS and Windows

**Files:**
- No code changes unless verification finds a bug.

- [ ] **Step 1: macOS dev app verification**

Run `npx tauri dev`, open server page, and test:

- `测速全部`
- `测速当前分组`
- switch between Americas / Asia / Global
- stop/start core if needed

Expected:

- Node delay values appear for real RDP nodes.
- No delay test depends on folded UI state, because no folded node state exists in the target path.

- [ ] **Step 2: macOS log check**

Check:

```bash
tail -n 120 /tmp/nextdesk_debug.log
```

Expected healthy markers:

```text
Internal Clash API ready
```

No repeated `test_group_delays` panic or front-end invoke error.

- [ ] **Step 3: Windows x64 or ARM64 remote check**

Use the existing diagnostic tunnel or local Windows machine:

```powershell
$cfg="$env:APPDATA\NextDesk\runtime_clash.yaml"
$api = (Select-String -Path $cfg -Pattern "^external-controller:" |
  ForEach-Object { ($_ -split ":")[-1].Trim() })
Invoke-RestMethod "http://127.0.0.1:$api/proxies" | Out-Null
```

Expected:

- Controller API is reachable.
- Server page delay test returns values through UI.
- Restarting NextDesk does not revert to `--` because of UI state.

- [ ] **Step 4: Windows package parity check before release**

Before pushing a release tag, install the CI-built package on Windows ARM64 and Windows x64 if available.

Expected:

- App launches correct sidecar.
- Server page delay values appear.
- `测速全部` and `测速当前分组` both work after app restart.

- [ ] **Step 5: Final verification commands**

```bash
cd frontend
npm run test -- src/lib/server-list.test.ts
npm run build
cd ../src-tauri
cargo test runtime_port_patch
```

Expected:

```text
PASS  src/lib/server-list.test.ts
✓ built in ...
test result: ok
```

---

## Acceptance Criteria

- Server page no longer uses `expandedGroups` to decide delay test targets.
- There is no duplicate expanded-card renderer for server nodes.
- Top cards select a group; they do not expand/collapse nodes.
- One active group panel displays selectable real RDP nodes.
- `测速全部` tests all selectable RDP server groups.
- `测速当前分组` tests only active group.
- Delay values persist visually when switching groups.
- Sorting by delay never changes what gets tested.
- Desktop and narrow layouts have no overlay, horizontal overflow, or text collision.
- macOS dev verification passes.
- Windows package verification passes before any release tag.

## Rollback Plan

If the UI refactor introduces a blocker:

1. Revert only the commits from Task 2 onward.
2. Keep Task 1 helpers and tests if they still pass and are unused safely.
3. Restore the previous server render block from git.
4. Keep the already-applied non-overlap layout fixes only if they are independent.

## Execution Options

1. **Subagent-Driven (recommended)**  
   Use one subagent for helper/tests, one for App UI refactor, then final integration review in this session.

2. **Inline Execution**  
   Execute tasks in this session with checkpoints after Task 2, Task 4, and Task 6.

