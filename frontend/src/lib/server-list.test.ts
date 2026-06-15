import { describe, expect, it } from 'vitest';
import type { ProxyGroup, Server } from '@/api';
import {
  delayStatus,
  delayText,
  groupRealNodes,
  markDelayNodesAsTesting,
  markUnresolvedDelayNodesAsTimeout,
  resolveActiveServerGroupName,
  resolveDelayTargetGroups,
  selectableServerGroups,
  sortServerNodes,
  uniqueDelayNodesForGroups,
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

  it('sorts nodes by name when requested', () => {
    expect(sortServerNodes(['US Server Only 02', 'HK Server Only 01'], {}, 'name')).toEqual([
      'HK Server Only 01',
      'US Server Only 02',
    ]);
  });

  it('deduplicates delay nodes across overlapping groups', () => {
    expect(uniqueDelayNodesForGroups(['Server-Americas', 'Server-Asia', 'Server-Americas'], groups, servers)).toEqual([
      'US Server Only 01',
      'US Server Only 02',
      'HK Server Only 01',
    ]);
  });

  it('marks nodes as testing once for the current delay run', () => {
    expect(markDelayNodesAsTesting({ 'US Server Only 01': 168 }, [
      'US Server Only 01',
      'HK Server Only 01',
    ])).toEqual({
      'US Server Only 01': 0,
      'HK Server Only 01': 0,
    });
  });

  it('does not overwrite successful delay values when a later overlapping group fails', () => {
    expect(markUnresolvedDelayNodesAsTimeout({
      'US Server Only 01': 168,
      'US Server Only 02': 0,
    }, [
      'US Server Only 01',
      'US Server Only 02',
      'HK Server Only 01',
    ])).toEqual({
      'US Server Only 01': 168,
      'US Server Only 02': -1,
      'HK Server Only 01': -1,
    });
  });
});
