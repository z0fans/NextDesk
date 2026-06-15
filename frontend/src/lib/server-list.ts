import type { ProxyGroup, Server } from '@/api';

export type DelayScope =
  | { type: 'all' }
  | { type: 'group'; groupName: string };

export type DelayStatus = 'unknown' | 'testing' | 'timeout' | 'good' | 'medium' | 'slow';

export type ServerNodeSort = 'default' | 'delay' | 'name';

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

export function uniqueDelayNodesForGroups(
  groupNames: string[],
  groups: ProxyGroup[],
  servers: Server[],
): string[] {
  const nodes = new Set<string>();
  groupNames.forEach((groupName) => {
    const group = groups.find((item) => item.name === groupName);
    if (!group) {
      return;
    }
    groupRealNodes(group, servers).forEach((node) => nodes.add(node));
  });
  return [...nodes];
}

export function markDelayNodesAsTesting(
  previous: Record<string, number>,
  nodes: string[],
): Record<string, number> {
  return {
    ...previous,
    ...Object.fromEntries(nodes.map((node) => [node, 0])),
  };
}

export function markUnresolvedDelayNodesAsTimeout(
  previous: Record<string, number>,
  nodes: string[],
): Record<string, number> {
  const next = { ...previous };
  nodes.forEach((node) => {
    if (next[node] === undefined || next[node] === 0) {
      next[node] = -1;
    }
  });
  return next;
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
    const aRank = aDelay === undefined
      ? Number.MAX_SAFE_INTEGER
      : aDelay === -1
        ? Number.MAX_SAFE_INTEGER - 1
        : aDelay;
    const bRank = bDelay === undefined
      ? Number.MAX_SAFE_INTEGER
      : bDelay === -1
        ? Number.MAX_SAFE_INTEGER - 1
        : bDelay;

    return aRank - bRank || a.localeCompare(b);
  });
}
