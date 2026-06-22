// Maps browser `KeyboardEvent.code` (physical, layout-independent) to RDP
// PC/AT Set 1 scancodes for the IronRDP scancode keyboard path.
//
// Extended keys carry the 0xE000 prefix, which IronRDP's `Scancode::from_u16`
// detects via `code & 0xE000 == 0xE000`.
//
// Printable character keys are intentionally included so modifier shortcuts
// (Ctrl+C, Alt+F4, etc.) can be sent as scancodes. When NO Ctrl/Alt/Meta is held,
// the workspace routes printable input through the Unicode/IME text path
// instead (see `isCharacterCode`), matching KKTerm's canvas input model.

const EXTENDED = 0xe000;

export const RDP_SCANCODES: Readonly<Record<string, number>> = {
  // Letters (physical US positions).
  KeyA: 0x1e, KeyB: 0x30, KeyC: 0x2e, KeyD: 0x20, KeyE: 0x12, KeyF: 0x21,
  KeyG: 0x22, KeyH: 0x23, KeyI: 0x17, KeyJ: 0x24, KeyK: 0x25, KeyL: 0x26,
  KeyM: 0x32, KeyN: 0x31, KeyO: 0x18, KeyP: 0x19, KeyQ: 0x10, KeyR: 0x13,
  KeyS: 0x1f, KeyT: 0x14, KeyU: 0x16, KeyV: 0x2f, KeyW: 0x11, KeyX: 0x2d,
  KeyY: 0x15, KeyZ: 0x2c,

  // Number row.
  Digit1: 0x02, Digit2: 0x03, Digit3: 0x04, Digit4: 0x05, Digit5: 0x06,
  Digit6: 0x07, Digit7: 0x08, Digit8: 0x09, Digit9: 0x0a, Digit0: 0x0b,

  // Punctuation / symbols.
  Minus: 0x0c, Equal: 0x0d, BracketLeft: 0x1a, BracketRight: 0x1b,
  Backslash: 0x2b, Semicolon: 0x27, Quote: 0x28, Backquote: 0x29,
  Comma: 0x33, Period: 0x34, Slash: 0x35, IntlBackslash: 0x56,

  // Whitespace / editing.
  Space: 0x39, Enter: 0x1c, Tab: 0x0f, Backspace: 0x0e, Escape: 0x01,

  // Modifiers.
  ControlLeft: 0x1d, ControlRight: EXTENDED | 0x1d,
  ShiftLeft: 0x2a, ShiftRight: 0x36,
  AltLeft: 0x38, AltRight: EXTENDED | 0x38,
  MetaLeft: EXTENDED | 0x5b, MetaRight: EXTENDED | 0x5c,
  ContextMenu: EXTENDED | 0x5d,
  CapsLock: 0x3a, NumLock: 0x45, ScrollLock: 0x46,

  // Function keys.
  F1: 0x3b, F2: 0x3c, F3: 0x3d, F4: 0x3e, F5: 0x3f, F6: 0x40, F7: 0x41,
  F8: 0x42, F9: 0x43, F10: 0x44, F11: 0x57, F12: 0x58,

  // Navigation cluster (extended).
  Insert: EXTENDED | 0x52, Delete: EXTENDED | 0x53, Home: EXTENDED | 0x47,
  End: EXTENDED | 0x4f, PageUp: EXTENDED | 0x49, PageDown: EXTENDED | 0x51,
  ArrowUp: EXTENDED | 0x48, ArrowDown: EXTENDED | 0x50,
  ArrowLeft: EXTENDED | 0x4b, ArrowRight: EXTENDED | 0x4d,
  PrintScreen: EXTENDED | 0x37,

  // Numpad.
  Numpad0: 0x52, Numpad1: 0x4f, Numpad2: 0x50, Numpad3: 0x51, Numpad4: 0x4b,
  Numpad5: 0x4c, Numpad6: 0x4d, Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49,
  NumpadDecimal: 0x53, NumpadAdd: 0x4e, NumpadSubtract: 0x4a,
  NumpadMultiply: 0x37, NumpadDivide: EXTENDED | 0x35, NumpadEnter: EXTENDED | 0x1c,
};

/** RDP scancode for a `KeyboardEvent.code`, or `undefined` if unmapped. */
export function scancodeForCode(code: string): number | undefined {
  return RDP_SCANCODES[code];
}

const PRINTABLE_KEY_CODES: Readonly<Record<string, string>> = {
  '0': 'Digit0',
  '1': 'Digit1',
  '2': 'Digit2',
  '3': 'Digit3',
  '4': 'Digit4',
  '5': 'Digit5',
  '6': 'Digit6',
  '7': 'Digit7',
  '8': 'Digit8',
  '9': 'Digit9',
  ' ': 'Space',
  '-': 'Minus',
  '_': 'Minus',
  '=': 'Equal',
  '+': 'Equal',
  '[': 'BracketLeft',
  '{': 'BracketLeft',
  ']': 'BracketRight',
  '}': 'BracketRight',
  '\\': 'Backslash',
  '|': 'Backslash',
  ';': 'Semicolon',
  ':': 'Semicolon',
  "'": 'Quote',
  '"': 'Quote',
  '`': 'Backquote',
  '~': 'Backquote',
  ',': 'Comma',
  '<': 'Comma',
  '.': 'Period',
  '>': 'Period',
  '/': 'Slash',
  '?': 'Slash',
  '!': 'Digit1',
  '@': 'Digit2',
  '#': 'Digit3',
  '$': 'Digit4',
  '%': 'Digit5',
  '^': 'Digit6',
  '&': 'Digit7',
  '*': 'Digit8',
  '(': 'Digit9',
  ')': 'Digit0',
};

export function scancodeForPrintableKey(key: string): number | undefined {
  if (key.length !== 1) return undefined;
  const lowerKey = key.toLowerCase();
  if (lowerKey >= 'a' && lowerKey <= 'z') {
    return RDP_SCANCODES[`Key${lowerKey.toUpperCase()}`];
  }
  const code = PRINTABLE_KEY_CODES[key];
  return code ? RDP_SCANCODES[code] : undefined;
}

/**
 * True for keys that produce a printable character. These are routed through
 * the Unicode/IME text path when unmodified, and through the scancode path when
 * combined with Ctrl/Alt/Meta shortcuts.
 */
export function isCharacterCode(code: string): boolean {
  return (
    code.startsWith('Key') ||
    code.startsWith('Digit') ||
    code.startsWith('Numpad') ||
    code === 'Space' ||
    code === 'Minus' ||
    code === 'Equal' ||
    code === 'BracketLeft' ||
    code === 'BracketRight' ||
    code === 'Backslash' ||
    code === 'Semicolon' ||
    code === 'Quote' ||
    code === 'Backquote' ||
    code === 'Comma' ||
    code === 'Period' ||
    code === 'Slash' ||
    code === 'IntlBackslash'
  );
}
