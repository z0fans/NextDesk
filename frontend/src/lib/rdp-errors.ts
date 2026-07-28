import type { TranslationKey } from '@/i18n/translations';

type RdpErrorTranslator = (
  key: TranslationKey,
  params?: Record<string, string | number>,
) => string;

const NON_RECOVERABLE_RDP_ERROR_TOKENS = [
  'another user connected',
  'forcing the disconnection',
  'administrative tool',
  'idle session limit',
  'active session limit',
  'logon timeout',
  'remote_user_initiated_disconnect',
  'logon_failure',
  'invalid credentials',
  'invalid username or password',
  'incorrect username or password',
  'wrong username or password',
  'logon attempt failed',
  'account_disabled',
  'account_locked',
  'account_expired',
  'password_expired',
  'access_denied',
  'administratively',
  'license',
  'idle timeout',
  'credssp',
  'credential_check_timeout',
  'connect_finalize',
  'certificate',
];

function isRdpNegotiationClosed(message: string): boolean {
  return message.includes('rdp_negotiation_closed') || (message.includes('connect_begin failed')
    && (message.includes('read frame by hint') || message.includes('read frame'))
    && message.includes('not enough bytes'));
}

export function isNonRecoverableRdpError(message: string): boolean {
  const lowerMessage = message.toLowerCase();
  if (isRdpNegotiationClosed(lowerMessage)) {
    return true;
  }
  if (NON_RECOVERABLE_RDP_ERROR_TOKENS.some(token => lowerMessage.includes(token))) {
    return true;
  }

  return lowerMessage.includes('rdpgfx')
    && (lowerMessage.includes('avc420')
      || lowerMessage.includes('h.264')
      || lowerMessage.includes('h264')
      || lowerMessage.includes('did not negotiate'));
}

/** Convert the Windows RDP control's extended disconnect code into a stable diagnostic token. */
export function activeXExtendedDisconnectError(code?: number | null): string | null {
  if (!code) return null;

  const suffix = `disconnect code ${code}`;
  switch (code) {
    case 3:
      return `idle timeout (${suffix})`;
    case 4:
      return `logon timeout (${suffix})`;
    case 5:
      return `another user connected (${suffix})`;
    case 6:
      return `server out of memory (${suffix})`;
    case 7:
      return `server denied connection (${suffix})`;
    case 8:
      return `server denied connection fips security (${suffix})`;
    case 9:
      return `access_denied insufficient privileges (${suffix})`;
    case 10:
      return `credssp fresh credentials required (${suffix})`;
    case 768:
      return `status_logon_failure (${suffix})`;
    default:
      if (code >= 256 && code <= 267) {
        return `rdp license error (${suffix})`;
      }
      if (code >= 4096 && code <= 32767) {
        return `rdp protocol error (${suffix})`;
      }
      return `remote desktop disconnected (${suffix})`;
  }
}

/** Map raw backend/RDP errors to user-facing copy without exposing renderer/protocol internals. */
export function friendlyRdpError(raw: string, t: RdpErrorTranslator): string {
  const r = raw.toLowerCase();
  if (!r.trim()) {
    return t('rdpErrUnknown');
  }
  if (
    r.includes('cloud_authorization_expired')
    || (r.includes('cloud') && (r.includes('401') || r.includes('403') || r.includes('unauthorized')))
  ) {
    return t('rdpErrCloudAuth');
  }
  if (r.includes('cloud_prepare_unsupported')) {
    return t('rdpErrCloudGatewayOutdated');
  }
  if (
    r.includes('cloud_all_candidates_failed')
    || r.includes('cloud_no_candidates')
    || r.includes('candidate_apply_timeout')
    || r.includes('not_enough_candidates')
  ) {
    return t('rdpErrCloudRelayUnavailable');
  }
  if (
    r.includes('status_logon_failure')
    || r.includes('0xc000006d')
    || r.includes('invalid credentials')
    || r.includes('invalid username or password')
    || r.includes('incorrect username or password')
    || r.includes('wrong username or password')
    || r.includes('logon attempt failed')
  ) {
    return t('rdpErrLoginFailed');
  }
  if (isRdpNegotiationClosed(r)) {
    return t('rdpErrNegotiationClosed');
  }
  if (r.includes('status_account_disabled') || r.includes('0xc0000072')) {
    return t('rdpErrAccountDisabled');
  }
  if (r.includes('status_account_locked') || r.includes('0xc0000234')) {
    return t('rdpErrAccountLocked');
  }
  if (r.includes('status_password_expired') || r.includes('0xc0000071')) {
    return t('rdpErrPasswordExpired');
  }
  if (r.includes('status_account_expired') || r.includes('0xc0000193')) {
    return t('rdpErrAccountExpired');
  }
  if (r.includes('status_password_must_change') || r.includes('0xc0000224')) {
    return t('rdpErrPasswordMustChange');
  }
  if (r.includes('access_denied') || r.includes('insufficient privileges')) {
    return t('rdpErrAccessDenied');
  }
  if (
    r.includes('credential_check_timeout')
    || r.includes('connect_finalize timed out')
    || r.includes('server did not complete rdp login finalization')
    || r.includes('logon timeout')
  ) {
    return t('rdpErrLoginTimeout');
  }
  if (r.includes('another user connected') || r.includes('forcing the disconnection')) {
    return t('rdpErrAnotherUser');
  }
  if (r.includes('administratively') || r.includes('administrative tool')) {
    return t('rdpErrAdmin');
  }
  if (r.includes('idle timeout') || r.includes('idle session limit')) {
    return t('rdpErrIdleTimeout');
  }
  if (r.includes('active session limit')) {
    return t('rdpErrSessionLimit');
  }
  if (r.includes('remote_user_initiated_disconnect') || r.includes('user logging off')) {
    return t('rdpErrRemoteLogoff');
  }
  if (r.includes('remote_server_initiated_disconnect')) {
    return t('rdpErrRemoteDisconnect');
  }
  if (r.includes('credssp')) {
    return t('rdpErrCredSsp');
  }
  if (r.includes('tls') || r.includes('ssl') || r.includes('certificate')) {
    return t('rdpErrTls');
  }
  if (r.includes('dns') || r.includes('resolve')) {
    return t('rdpErrDns');
  }
  if (
    r.includes('network is unreachable')
    || r.includes('network unreachable')
    || r.includes('host is unreachable')
    || r.includes('host unreachable')
    || r.includes('no route to host')
  ) {
    return t('rdpErrUnreachable');
  }
  if (r.includes('refused') || r.includes('reset') || r.includes('server denied connection')) {
    return t('rdpErrRefused');
  }
  if (r.includes('timeout') || r.includes('timed out')) {
    return t('rdpErrTimeout');
  }
  if (r.includes('socks') || r.includes('proxy') || r.includes('internal clash api')) {
    return t('rdpErrProxy');
  }
  if (r.includes('read frame by hint') || r.includes('not enough bytes') || r.includes('read frame')) {
    return t('rdpErrNoResponse');
  }
  if (r.includes('out of memory') || r.includes('ran out of available memory')) {
    return t('rdpErrServerResources');
  }
  if (r.includes('license')) {
    return t('rdpErrLicense');
  }
  if (r.includes('protocol error')) {
    return t('rdpErrProtocol');
  }
  if (r.includes('renderer')) {
    return t('rdpErrDisplayStartup');
  }
  if (r.includes('rdpgfx') || r.includes('h.264') || r.includes('h264') || r.includes('avc420')) {
    return t('rdpErrDisplayStartup');
  }
  if (r.includes('ironrdp')) {
    return t('rdpErrUnknown');
  }
  if (r.includes('rdcleanpath')) {
    return t('rdpErrWsClosed');
  }
  if (r.includes('websocket') || r.includes('ws://')) {
    return t('rdpErrWsClosed');
  }
  if (r.includes('canvas')) {
    return t('rdpErrCanvas');
  }
  return t('rdpErrUnknown');
}

/** Keep the actionable cause visible while an automatic reconnect is pending. */
export function reconnectingRdpError(
  raw: string,
  attempt: number,
  maxAttempts: number,
  t: RdpErrorTranslator,
): string {
  return t('rdpReconnectingDetailed', {
    count: attempt,
    max: maxAttempts,
    reason: friendlyRdpError(raw, t),
  });
}

/** Keep the final actionable reason visible after automatic reconnect gives up. */
export function reconnectFailedRdpError(
  raw: string,
  maxAttempts: number,
  t: RdpErrorTranslator,
): string {
  return t('rdpReconnectFailedDetailed', {
    max: maxAttempts,
    reason: friendlyRdpError(raw, t),
  });
}
