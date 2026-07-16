import { describe, expect, it } from 'vitest';
import { scancodeForCode } from '@/rdp/kkterm/rdpScancodes';

describe('KKTerm RDP scancode map', () => {
  it.each([
    ['F1', 0x3b],
    ['F2', 0x3c],
    ['F3', 0x3d],
    ['F4', 0x3e],
    ['F5', 0x3f],
    ['F6', 0x40],
    ['F7', 0x41],
    ['F8', 0x42],
    ['F9', 0x43],
    ['F10', 0x44],
    ['F11', 0x57],
    ['F12', 0x58],
  ])('maps %s to PC/AT set 1 scancode %#i', (code, expected) => {
    expect(scancodeForCode(code)).toBe(expected);
  });

  it.each([
    ['Delete', 0xe053],
    ['Home', 0xe047],
    ['End', 0xe04f],
    ['PageUp', 0xe049],
    ['PageDown', 0xe051],
  ])('maps %s to the extended navigation scancode %#i', (code, expected) => {
    expect(scancodeForCode(code)).toBe(expected);
  });
});
