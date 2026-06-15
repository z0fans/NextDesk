export type OfficialWebGfxFallbackInput = {
  type: string;
  codec?: string;
  detail?: string;
  bitmapHexPrefix?: string;
  payloadHexPrefix?: string;
};

export type OfficialWebGfxFallbackDecision = {
  shouldFallback: boolean;
  reason: string | null;
};

export function describeOfficialWebGfxFallback(
  input: OfficialWebGfxFallbackInput,
): OfficialWebGfxFallbackDecision {
  if (input.type === 'unsupported_codec') {
    return {
      shouldFallback: true,
      reason: `unsupported_codec:${input.codec || 'unknown'}`,
    };
  }

  if (input.type === 'decode_error') {
    return {
      shouldFallback: true,
      reason: `decode_error:${input.detail || 'unknown'}`,
    };
  }

  return {
    shouldFallback: false,
    reason: null,
  };
}
