import { describe, expect, it } from 'vitest';
import type { TranslationKey } from '@/i18n/translations';
import { friendlyRdpError, isNonRecoverableRdpError } from '@/lib/rdp-errors';

const testTranslations = {
  rdpErrUnknown: '无法连接。请检查服务器地址、网络连接和代理设置后重试。',
  rdpErrLoginFailed: '登录失败 — 用户名或密码不正确。',
  rdpErrAccountDisabled: '登录失败 — 该账户已被禁用。',
  rdpErrAccountLocked: '登录失败 — 账户因多次尝试失败已被锁定。',
  rdpErrPasswordExpired: '登录失败 — 密码已过期。',
  rdpErrAccountExpired: '登录失败 — 账户已过期。',
  rdpErrPasswordMustChange: '登录失败 — 首次登录前需要更改密码。',
  rdpErrCredSsp: '认证失败 — 请检查用户名和密码。',
  rdpErrTls: 'TLS/SSL 错误 — 无法建立安全连接。',
  rdpErrDns: '连接失败 — 无法解析主机名。',
  rdpErrRefused: '连接被拒绝 — 目标主机可能未运行 RDP 服务。',
  rdpErrTimeout: '连接超时 — 主机不可达或响应过慢。',
  rdpErrProxy: '连接失败 — 网络加速服务未就绪。请重启核心引擎后重试。',
  rdpErrDisplayStartup: '连接失败 — 远程画面启动失败。请重试或重启应用。',
  rdpErrNoResponse: '无法连接远程服务器。请确认服务器在线、地址和端口正确，并检查网络或代理设置。',
  rdpErrWsClosed: '连接中断 — WebSocket 通道已关闭。',
  rdpErrCanvas: '显示错误 — 画布元素未就绪，请重试。',
  rdpErrAnotherUser: '已断开 — 另一用户登录了远程计算机。',
  rdpErrAdmin: '已断开 — 会话已被管理员终止。',
  rdpErrIdleTimeout: '已断开 — 会话因空闲超时已断开。',
} as const;

const t = (key: TranslationKey) => testTranslations[key as keyof typeof testTranslations] ?? key;

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
    'FreeRDP sidecar exited immediately with status exit status: 20',
    'Connect failed: [TCP connect SOCKS5] custom error',
    'Session error: [RDPGFX] reason: server did not negotiate AVC420/H.264',
    'IronRDP connector returned an internal transport error',
  ])('does not expose renderer or transport internals: %s', (raw) => {
    const message = friendlyRdpError(raw, t);

    expect(message.toLowerCase()).not.toMatch(/freerdp|sidecar|socks5|rdpgfx|h\.264|h264|avc420|ironrdp/);
  });
});
