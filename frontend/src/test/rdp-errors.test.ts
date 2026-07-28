import { describe, expect, it } from 'vitest';
import type { TranslationKey } from '@/i18n/translations';
import {
  activeXExtendedDisconnectError,
  friendlyRdpError,
  isNonRecoverableRdpError,
  reconnectingRdpError,
  reconnectFailedRdpError,
} from '@/lib/rdp-errors';

const testTranslations = {
  rdpErrUnknown: '无法连接。请检查服务器地址、网络连接和代理设置后重试。',
  rdpErrLoginFailed: '登录失败 — 用户名或密码不正确。',
  rdpErrNegotiationClosed: '远程计算机已中断连接。',
  rdpErrAccountDisabled: '登录失败 — 该账户已被禁用。',
  rdpErrAccountLocked: '登录失败 — 账户因多次尝试失败已被锁定。',
  rdpErrPasswordExpired: '登录失败 — 密码已过期。',
  rdpErrAccountExpired: '登录失败 — 账户已过期。',
  rdpErrPasswordMustChange: '登录失败 — 首次登录前需要更改密码。',
  rdpErrAccessDenied: '登录失败 — 该账户没有使用远程桌面的权限。',
  rdpErrLoginTimeout: '登录验证超时 — 请检查用户名、密码、账户权限，并确认服务器允许远程桌面登录。',
  rdpErrCredSsp: '认证失败 — 请检查用户名和密码。',
  rdpErrTls: 'TLS/SSL 错误 — 无法建立安全连接。',
  rdpErrDns: '连接失败 — 无法解析主机名。',
  rdpErrRefused: '连接被拒绝 — 目标主机可能未运行 RDP 服务。',
  rdpErrUnreachable: '无法连接服务器 — 当前网络无法到达目标主机。',
  rdpErrTimeout: '连接超时 — 主机不可达或响应过慢。',
  rdpErrProxy: '连接失败 — 网络加速服务未就绪。请重启核心引擎后重试。',
  rdpErrDisplayStartup: '连接失败 — 远程画面启动失败。请重试或重启应用。',
  rdpErrNoResponse: '无法连接远程服务器。请确认服务器在线、地址和端口正确，并检查网络或代理设置。',
  rdpErrWsClosed: '连接中断 — WebSocket 通道已关闭。',
  rdpErrCanvas: '显示错误 — 画布元素未就绪，请重试。',
  rdpErrAnotherUser: '已断开 — 另一用户登录了远程计算机。',
  rdpErrAdmin: '已断开 — 会话已被管理员终止。',
  rdpErrIdleTimeout: '已断开 — 会话因空闲超时已断开。',
  rdpErrCloudAuth: '云端授权已失效，请在设置中重新授权设备。',
  rdpErrCloudRelayUnavailable: '无法选择可用云端线路。请稍后重试，或检查目标服务器是否允许 RDP 连接。',
  rdpErrCloudGatewayOutdated: 'Cloud Gateway 版本过旧，请更新面板插件后重试。',
  rdpErrSessionLimit: '已断开 — 远程会话已达到服务器设置的时长限制。',
  rdpErrRemoteLogoff: '已断开 — 远程用户已退出该会话。',
  rdpErrRemoteDisconnect: '已断开 — 远程服务器已结束该会话。',
  rdpReconnectFailedDetailed: '连接中断\n自动重连已在 {max} 次尝试后失败\n原因：{reason}',
  rdpReconnectingDetailed: '正在重连 ({count}/{max})...\n原因：{reason}',
} as const;

const t = (key: TranslationKey, params?: Record<string, string | number>) => {
  let message: string = testTranslations[key as keyof typeof testTranslations] ?? key;
  Object.entries(params ?? {}).forEach(([name, value]) => {
    message = message.replace(`{${name}}`, String(value));
  });
  return message;
};

describe('isNonRecoverableRdpError', () => {
  it('treats RDPGFX H.264 negotiation failure as non-recoverable', () => {
    expect(isNonRecoverableRdpError(
      'Session error: [RDPGFX] reason: RDPGFX H.264 test mode is active, but the server did not negotiate AVC420/H.264',
    )).toBe(true);
  });

  it('keeps generic transport failures recoverable', () => {
    expect(isNonRecoverableRdpError('read frame timed out')).toBe(false);
  });
});

describe('friendlyRdpError', () => {
  it.each([
    'Connect failed: [TCP connect direct] custom error',
    'Session error: [RDPGFX] reason: server did not negotiate AVC420/H.264',
    'IronRDP connector returned an internal transport error',
  ])('does not expose renderer or transport internals: %s', (raw) => {
    const message = friendlyRdpError(raw, t);

    expect(message.toLowerCase()).not.toMatch(/rdpgfx|h\.264|h264|avc420|ironrdp/);
  });

  it('maps cloud candidate failures to route unavailable copy', () => {
    expect(friendlyRdpError('cloud_all_candidates_failed', t)).toBe(testTranslations.rdpErrCloudRelayUnavailable);
    expect(friendlyRdpError('candidate_apply_timeout', t)).toBe(testTranslations.rdpErrCloudRelayUnavailable);
  });

  it('maps unsupported prepare API to gateway outdated copy', () => {
    expect(friendlyRdpError('cloud_prepare_unsupported', t)).toBe(testTranslations.rdpErrCloudGatewayOutdated);
  });

  it('maps native login-finalization timeout to an actionable authentication hint', () => {
    const raw = 'RDP connect_finalize timed out after 25s: credential_check_timeout: server did not complete RDP login finalization';
    expect(friendlyRdpError(raw, t)).toBe(testTranslations.rdpErrLoginTimeout);
    expect(isNonRecoverableRdpError(raw)).toBe(true);
  });

  it('maps an unreachable network to a specific server reachability error', () => {
    expect(friendlyRdpError(
      'TCP connect to 203.0.113.10:3389 failed: Network is unreachable (os error 51)',
      t,
    )).toBe(testTranslations.rdpErrUnreachable);
  });

  it.each([
    'The logon attempt failed',
    'Invalid credentials supplied by the remote server',
    'Incorrect username or password',
  ])('maps common authentication messages to an explicit username or password error: %s', raw => {
    expect(friendlyRdpError(raw, t)).toBe(testTranslations.rdpErrLoginFailed);
    expect(isNonRecoverableRdpError(raw)).toBe(true);
  });

  it('reports an RDP negotiation close accurately and stops automatic retries', () => {
    const raw = 'RDP connect failed: RDP connect_begin failed: [read frame by hint @ connector/src/lib.rs:416] custom error: not enough bytes';

    expect(friendlyRdpError(raw, t)).toBe(testTranslations.rdpErrNegotiationClosed);
    expect(isNonRecoverableRdpError(raw)).toBe(true);
  });

  it('accepts the stable backend token for an RDP negotiation close', () => {
    const raw = 'RDP connect failed: rdp_negotiation_closed: server closed the connection before authentication';

    expect(friendlyRdpError(raw, t)).toBe(testTranslations.rdpErrNegotiationClosed);
    expect(isNonRecoverableRdpError(raw)).toBe(true);
  });

  it.each([
    [
      'remote_disconnect: The disconnection was initiated by an administrative tool on the server in another session',
      testTranslations.rdpErrAdmin,
    ],
    [
      'remote_disconnect: The idle session limit timer on the server has elapsed',
      testTranslations.rdpErrIdleTimeout,
    ],
    [
      'remote_disconnect: The active session limit timer on the server has elapsed',
      testTranslations.rdpErrSessionLimit,
    ],
    [
      'remote_user_initiated_disconnect: user initiated disconnect',
      testTranslations.rdpErrRemoteLogoff,
    ],
    [
      'remote_server_initiated_disconnect: server initiated disconnect',
      testTranslations.rdpErrRemoteDisconnect,
    ],
  ])('maps graceful server disconnect details to a specific user-facing reason: %s', (raw, expected) => {
    expect(friendlyRdpError(raw, t)).toBe(expected);
  });
});

describe('reconnectingRdpError', () => {
  it('keeps the first actionable failure visible while an automatic retry is pending', () => {
    expect(reconnectingRdpError(
      'TCP connect to 203.0.113.10:3389 failed: Network is unreachable (os error 51)',
      1,
      5,
      t,
    )).toBe('正在重连 (1/5)...\n原因：无法连接服务器 — 当前网络无法到达目标主机。');
  });
});

describe('reconnectFailedRdpError', () => {
  it('keeps the last actionable connection reason when automatic retries are exhausted', () => {
    expect(reconnectFailedRdpError('Connection refused by remote host', 5, t)).toBe(
      '连接中断\n自动重连已在 5 次尝试后失败\n原因：连接被拒绝 — 目标主机可能未运行 RDP 服务。',
    );
  });
});

describe('activeXExtendedDisconnectError', () => {
  it.each([
    [768, 'status_logon_failure'],
    [3, 'idle timeout'],
    [5, 'another user connected'],
    [7, 'server denied connection'],
  ])('maps ActiveX extended disconnect reason %s to an actionable token', (code, expected) => {
    expect(activeXExtendedDisconnectError(code)).toContain(expected);
  });

  it('ignores the no-information reason', () => {
    expect(activeXExtendedDisconnectError(0)).toBeNull();
  });

  it('maps ActiveX idle and logon timeouts before the generic network timeout rule', () => {
    expect(friendlyRdpError(activeXExtendedDisconnectError(3)!, t)).toBe(
      testTranslations.rdpErrIdleTimeout,
    );
    expect(friendlyRdpError(activeXExtendedDisconnectError(4)!, t)).toBe(
      testTranslations.rdpErrLoginTimeout,
    );
  });
});
