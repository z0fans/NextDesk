import { describe, expect, it } from 'vitest';
import { describeOfficialWebGfxFallback } from '@/rdp/gfx-fallback';

describe('official-web GFX fallback decisions', () => {
  it('falls back when IronRDP reports an unsupported GFX codec', () => {
    expect(describeOfficialWebGfxFallback({
      type: 'unsupported_codec',
      codec: 'clearcodec',
      detail: 'server selected ClearCodec',
    })).toEqual({
      shouldFallback: true,
      reason: 'unsupported_codec:clearcodec',
    });
  });

  it('falls back when WebCodecs reports a decode error', () => {
    expect(describeOfficialWebGfxFallback({
      type: 'decode_error',
      detail: 'EncodingError',
    })).toEqual({
      shouldFallback: true,
      reason: 'decode_error:EncodingError',
    });
  });

  it('does not fall back for H.264 codec diagnostics', () => {
    expect(describeOfficialWebGfxFallback({
      type: 'gfx_codec',
      codec: 'h264',
      detail: 'Avc420',
    })).toEqual({
      shouldFallback: false,
      reason: null,
    });
  });

  it('does not fall back for ClearCodec diagnostic frames', () => {
    expect(describeOfficialWebGfxFallback({
      type: 'clearcodec_frame',
      codec: 'clearcodec',
      detail: 'metadata only',
    })).toEqual({
      shouldFallback: false,
      reason: null,
    });
  });

  it('does not fall back for decoded ClearCodec RGBA patches', () => {
    expect(describeOfficialWebGfxFallback({
      type: 'clearcodec_rgba_patch',
      codec: 'clearcodec',
      detail: 'decoded patch',
    })).toEqual({
      shouldFallback: false,
      reason: null,
    });
  });
});
