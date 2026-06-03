import { describe, expect, it } from 'vitest';
import { gfxRectToDrawRect } from '@/lib/h264-overlay';

describe('H.264 overlay placement', () => {
  it('uses full decoded frame size when no RDPGFX rect is provided', () => {
    expect(gfxRectToDrawRect(undefined, 1920, 1080)).toEqual({
      x: 0,
      y: 0,
      width: 1920,
      height: 1080,
    });
  });

  it('converts RDPGFX destination rectangles to drawImage coordinates', () => {
    expect(
      gfxRectToDrawRect(
        { left: 10, top: 20, right: 630, bottom: 470 },
        1920,
        1080,
      ),
    ).toEqual({
      x: 10,
      y: 20,
      width: 620,
      height: 450,
    });
  });
});
