const NON_RECOVERABLE_RDP_ERROR_TOKENS = [
  'another user connected',
  'forcing the disconnection',
  'logon_failure',
  'account_disabled',
  'account_locked',
  'account_expired',
  'password_expired',
  'access_denied',
  'administratively',
  'license',
  'idle timeout',
  'credssp',
  'certificate',
];

export function isNonRecoverableRdpError(message: string): boolean {
  const lowerMessage = message.toLowerCase();
  if (NON_RECOVERABLE_RDP_ERROR_TOKENS.some(token => lowerMessage.includes(token))) {
    return true;
  }

  return lowerMessage.includes('rdpgfx')
    && (lowerMessage.includes('avc420')
      || lowerMessage.includes('h.264')
      || lowerMessage.includes('h264')
      || lowerMessage.includes('did not negotiate'));
}
