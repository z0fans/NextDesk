import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KktermRdpSurface } from '@/rdp/kkterm/KktermRdpSurface';
import type { ServerEntry } from '@/lib/rdp-types';

const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn());
const readTextMock = vi.hoisted(() => vi.fn());
const cursorDataUrlMock = 'data:image/png;base64,cursor';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock('@tauri-apps/plugin-clipboard-manager', () => ({
  readText: (...args: unknown[]) => readTextMock(...args),
}));

const server: ServerEntry = {
  id: 'server-public',
  name: '64.20.10.254',
  host: '64.20.10.254',
  port: 3389,
  username: 'administrator',
  password: 'secret',
  domain: 'ACME',
  groupId: 'default',
  isFavorite: false,
  colorTag: '',
};

describe('KktermRdpSurface', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
    readTextMock.mockReset();
    listenMock.mockResolvedValue(() => undefined);
    invokeMock.mockResolvedValue({ tabId: 'tab-public' });
    readTextMock.mockResolvedValue('clipboard text');
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      putImageData: vi.fn(),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.toDataURL = vi.fn(() => cursorDataUrlMock);
    if (!globalThis.ImageData) {
      Object.defineProperty(globalThis, 'ImageData', {
        configurable: true,
        value: class {
          data: Uint8ClampedArray;
          width: number;
          height: number;

          constructor(data: Uint8ClampedArray, width: number, height: number) {
            this.data = data;
            this.width = width;
            this.height = height;
          }
        },
      });
    }
    Object.defineProperty(window, '__TAURI_INTERNALS__', {
      configurable: true,
      value: {},
    });
  });

  afterEach(() => {
    delete (window as typeof window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    window.localStorage.clear();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('starts through kkterm_rdp_start with NextDesk shell state only', async () => {
    render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1600, height: 900 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_start', {
        request: expect.objectContaining({
          tabId: 'tab-public',
          host: '64.20.10.254',
          port: 3389,
          username: 'administrator',
          password: 'secret',
          domain: 'ACME',
          desktopWidth: 1600,
          desktopHeight: 900,
          scaleFactor: window.devicePixelRatio || 1,
        }),
      });
    });
  });

  it('delegates connection feedback to the parent RDP chrome', () => {
    render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1600, height: 900 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    expect(screen.queryByText('正在连接 64.20.10.254...')).not.toBeInTheDocument();
  });

  it('reports a connection timeout instead of spinning forever when native start does not return', async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    invokeMock.mockImplementation((command: string) => {
      if (command === 'kkterm_rdp_start') {
        return new Promise(() => undefined);
      }
      return Promise.resolve(undefined);
    });

    render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1600, height: 900 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={onError}
      />,
    );

    await act(async () => {
      vi.advanceTimersByTime(45_000);
    });

    expect(onError).toHaveBeenCalledWith(
      'tab-public',
      'RDP connection timed out before the remote server responded',
    );
    expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_disconnect', {
      request: { tabId: 'tab-public' },
    });
  });

  it('retries transient cloud startup failures before surfacing an error', async () => {
    vi.useFakeTimers();
    invokeMock.mockImplementation((command: string, payload: unknown) => {
      if (command === 'kkterm_rdp_start') {
        const startCalls = invokeMock.mock.calls.filter(([name]) => name === 'kkterm_rdp_start').length;
        if (startCalls === 1) {
          return Promise.reject(new Error('cloud prepare rejected: 429 Too Many Requests'));
        }
        return Promise.resolve({ tabId: 'tab-public' });
      }
      if (command === 'kkterm_rdp_disconnect') {
        return Promise.resolve(undefined);
      }
      return Promise.resolve(payload);
    });

    render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1600, height: 900 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_start', {
      request: expect.objectContaining({ reuseCloudBinding: false }),
    });

    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
      await Promise.resolve();
    });

    const startCalls = invokeMock.mock.calls.filter(([name]) => name === 'kkterm_rdp_start');
    expect(startCalls).toHaveLength(2);
    expect(startCalls[1]?.[1]).toEqual({
      request: expect.objectContaining({ reuseCloudBinding: false }),
    });
  });

  it('does not restart the native KKTerm session when parent callbacks change identity', async () => {
    const firstConnected = vi.fn();
    const firstDisconnected = vi.fn();
    const firstError = vi.fn();
    const { rerender } = render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1600, height: 900 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={firstConnected}
        onDisconnected={firstDisconnected}
        onError={firstError}
      />,
    );

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_start', expect.anything());
    });
    invokeMock.mockClear();

    rerender(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1600, height: 900 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(invokeMock).not.toHaveBeenCalledWith('kkterm_rdp_disconnect', expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith('kkterm_rdp_start', expect.anything());
  });

  it('keeps the native KKTerm session alive while its session tab is inactive', async () => {
    const props = {
      tabId: 'tab-public',
      server,
      desktopSize: { width: 1600, height: 900 },
      cadSignal: 0,
      winSignal: 0,
      textSignal: null,
      onConnected: vi.fn(),
      onDisconnected: vi.fn(),
      onError: vi.fn(),
    };
    const { rerender } = render(<KktermRdpSurface {...props} active={true} />);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_start', expect.anything());
    });
    invokeMock.mockClear();

    rerender(<KktermRdpSurface {...props} active={false} />);
    rerender(<KktermRdpSurface {...props} active={true} />);

    expect(invokeMock).not.toHaveBeenCalledWith('kkterm_rdp_start', expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith('kkterm_rdp_disconnect', expect.anything());
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('RDP display'));
    });
  });

  it('captures keyboard focus on pointer down and sends text through KKTerm Unicode input', async () => {
    vi.stubEnv('VITE_NEXTDESK_KKTERM_KEYBOARD_MODE', 'kkterm-text');
    render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1280, height: 800 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const display = await screen.findByLabelText('RDP display');
    fireEvent.pointerDown(display, { clientX: 10, clientY: 20, button: 0 });
    fireEvent(display, new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: 'a',
    }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_text', {
        request: { tabId: 'tab-public', text: 'a' },
      });
    });
  });

  it('maps pointer coordinates through the resized canvas backing store', async () => {
    const { container } = render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1920, height: 1080 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    canvas!.width = 1920;
    canvas!.height = 1080;
    vi.spyOn(canvas!, 'getBoundingClientRect').mockReturnValue({
      x: 100,
      y: 50,
      left: 100,
      top: 50,
      right: 1060,
      bottom: 590,
      width: 960,
      height: 540,
      toJSON: () => ({}),
    });
    invokeMock.mockClear();

    fireEvent.pointerDown(canvas!, { clientX: 580, clientY: 320, button: 0 });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_pointer', {
        request: { tabId: 'tab-public', x: 960, y: 540, buttonMask: 1 },
      });
    });
  });

  it('lets printable keys flow through KKTerm input text instead of keydown scancodes', async () => {
    vi.stubEnv('VITE_NEXTDESK_KKTERM_KEYBOARD_MODE', 'kkterm-text');
    render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1280, height: 800 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const display = await screen.findByLabelText('RDP display');
    invokeMock.mockClear();
    fireEvent.keyDown(display, {
      code: 'KeyA',
      key: 'a',
    });
    fireEvent.keyUp(display, {
      code: 'KeyA',
      key: 'a',
    });

    expect(invokeMock).not.toHaveBeenCalledWith('kkterm_rdp_text', expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith('kkterm_rdp_key', expect.anything());

    fireEvent(display, new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: 'a',
    }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_text', {
        request: { tabId: 'tab-public', text: 'a' },
      });
    });
  });

  it('defaults to remote scancode input so English keys stay inside RDP', async () => {
    const { container } = render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1280, height: 800 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const input = await screen.findByLabelText('RDP display');
    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    expect(canvas).toHaveAttribute('tabindex', '-1');
    expect(input).toHaveAttribute('tabindex', '0');

    invokeMock.mockClear();
    fireEvent.pointerDown(canvas!, { clientX: 10, clientY: 20, button: 0 });
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, {
      code: 'KeyA',
      key: 'a',
    });
    fireEvent.keyUp(input, {
      code: 'KeyA',
      key: 'a',
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_key', {
        request: { tabId: 'tab-public', scancode: 0x1e, down: true },
      });
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_key', {
        request: { tabId: 'tab-public', scancode: 0x1e, down: false },
      });
    });
    expect(invokeMock).not.toHaveBeenCalledWith('kkterm_rdp_text', expect.anything());
  });

  it('sends macOS IME composition text in the default remote scancode mode', async () => {
    render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1280, height: 800 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const display = await screen.findByLabelText('RDP display');
    invokeMock.mockClear();
    fireEvent.compositionStart(display);
    fireEvent.compositionEnd(display, { data: '中文输入' });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_text', {
        request: { tabId: 'tab-public', text: '中文输入' },
      });
    });
    expect(invokeMock).not.toHaveBeenCalledWith('kkterm_rdp_key', expect.anything());
  });

  it('does not leak WebKit IME keyCode 229 events into the remote scancode stream', async () => {
    render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1280, height: 800 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const display = await screen.findByLabelText('RDP display');
    invokeMock.mockClear();
    fireEvent.keyDown(display, {
      code: 'KeyZ',
      key: 'Unidentified',
      isComposing: true,
      keyCode: 229,
    });
    fireEvent.keyUp(display, {
      code: 'KeyZ',
      key: 'Unidentified',
      isComposing: true,
      keyCode: 229,
    });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(invokeMock).not.toHaveBeenCalledWith('kkterm_rdp_key', expect.anything());
  });

  it('anchors the macOS IME target inside the visible RDP surface', async () => {
    render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1280, height: 800 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const display = await screen.findByLabelText('RDP display');
    expect(window.getComputedStyle(display).left).toBe('8px');
  });

  it('maps Ctrl+Alt+End to the dedicated remote Ctrl+Alt+Delete command', async () => {
    render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1280, height: 800 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const display = await screen.findByLabelText('RDP display');
    invokeMock.mockClear();
    fireEvent.keyDown(display, {
      code: 'End',
      key: 'End',
      ctrlKey: true,
      altKey: true,
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_ctrl_alt_delete', {
        request: { tabId: 'tab-public' },
      });
    });
    expect(invokeMock).not.toHaveBeenCalledWith('kkterm_rdp_key', expect.objectContaining({
      request: expect.objectContaining({ scancode: 0xe04f }),
    }));
  });

  it('lets shifted printable symbols flow through KKTerm input text', async () => {
    vi.stubEnv('VITE_NEXTDESK_KKTERM_KEYBOARD_MODE', 'kkterm-text');
    render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1280, height: 800 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const display = await screen.findByLabelText('RDP display');
    invokeMock.mockClear();
    fireEvent.keyDown(display, {
      code: 'Digit2',
      key: '@',
      shiftKey: true,
    });

    expect(invokeMock).not.toHaveBeenCalledWith('kkterm_rdp_text', expect.anything());
    expect(invokeMock).not.toHaveBeenCalledWith('kkterm_rdp_key', expect.anything());

    fireEvent(display, new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: '@',
    }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_text', {
        request: { tabId: 'tab-public', text: '@' },
      });
    });
  });

  it('keeps non-printable keys on the KKTerm scancode path', async () => {
    vi.stubEnv('VITE_NEXTDESK_KKTERM_KEYBOARD_MODE', 'kkterm-text');
    render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1280, height: 800 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const display = await screen.findByLabelText('RDP display');
    fireEvent.keyDown(display, {
      code: 'Enter',
      key: 'Enter',
    });
    fireEvent.keyUp(display, {
      code: 'Enter',
      key: 'Enter',
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_key', {
        request: { tabId: 'tab-public', scancode: 0x1c, down: true },
      });
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_key', {
        request: { tabId: 'tab-public', scancode: 0x1c, down: false },
      });
    });
  });

  it('maps macOS paste to KKTerm text input instead of local browser paste', async () => {
    vi.stubEnv('VITE_NEXTDESK_KKTERM_KEYBOARD_MODE', 'kkterm-text');
    render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1280, height: 800 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const display = await screen.findByLabelText('RDP display');
    fireEvent.keyDown(display, {
      code: 'KeyV',
      key: 'v',
      metaKey: true,
    });

    await waitFor(() => {
      expect(readTextMock).toHaveBeenCalled();
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_text', {
        request: { tabId: 'tab-public', text: 'clipboard text' },
      });
    });
  });

  it('lets the dev env force KKTerm text mode over a stale stored scancode mode', async () => {
    vi.stubEnv('VITE_NEXTDESK_KKTERM_KEYBOARD_MODE', 'kkterm-text');
    window.localStorage.setItem('nextdesk_kkterm_keyboard_mode', 'remote-scancode');
    render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1280, height: 800 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const display = await screen.findByLabelText('RDP display');
    expect(display).toHaveAttribute('tabindex', '0');
    fireEvent.pointerDown(display, { clientX: 10, clientY: 20, button: 0 });
    fireEvent(display, new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: 'a',
    }));

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_text', {
        request: { tabId: 'tab-public', text: 'a' },
      });
    });
  });

  it('does not send the remote Windows key for macOS editing shortcuts in KKTerm text mode', async () => {
    vi.stubEnv('VITE_NEXTDESK_KKTERM_KEYBOARD_MODE', 'kkterm-text');
    const keyCalls = () => invokeMock.mock.calls.filter(([command]) => command === 'kkterm_rdp_key');
    render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1280, height: 800 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const display = await screen.findByLabelText('RDP display');
    invokeMock.mockClear();
    fireEvent.keyDown(display, {
      code: 'MetaLeft',
      key: 'Meta',
      metaKey: true,
    });
    fireEvent.keyDown(display, {
      code: 'KeyC',
      key: 'c',
      metaKey: true,
    });
    fireEvent.keyUp(display, {
      code: 'KeyC',
      key: 'c',
      metaKey: true,
    });
    fireEvent.keyUp(display, {
      code: 'MetaLeft',
      key: 'Meta',
    });
    fireEvent.keyDown(display, {
      code: 'KeyA',
      key: 'a',
    });

    await waitFor(() => {
      expect(keyCalls()).toContainEqual([
        'kkterm_rdp_key',
        { request: { tabId: 'tab-public', scancode: 0x1d, down: true } },
      ]);
      expect(keyCalls()).toContainEqual([
        'kkterm_rdp_key',
        { request: { tabId: 'tab-public', scancode: 0x2e, down: true } },
      ]);
    });
    const calls = keyCalls();
    const winKeyCalls = calls.filter(([, args]) => {
      const request = (args as { request: { scancode: number; down: boolean } }).request;
      return request.scancode === 0xe05b;
    });
    expect(winKeyCalls).toHaveLength(0);
  });

  it('maps macOS copy and paste shortcuts to remote Windows Ctrl shortcuts in remote scancode mode', async () => {
    window.localStorage.setItem('nextdesk_kkterm_keyboard_mode', 'remote-scancode');
    const { container } = render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1280, height: 800 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    invokeMock.mockClear();
    fireEvent.keyDown(canvas!, {
      code: 'KeyC',
      key: 'c',
      metaKey: true,
    });
    fireEvent.keyDown(canvas!, {
      code: 'KeyV',
      key: 'v',
      metaKey: true,
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_key', {
        request: { tabId: 'tab-public', scancode: 0x1d, down: true },
      });
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_key', {
        request: { tabId: 'tab-public', scancode: 0x2e, down: true },
      });
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_key', {
        request: { tabId: 'tab-public', scancode: 0x2f, down: true },
      });
    });
    expect(readTextMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith('kkterm_rdp_text', expect.anything());
  });

  it('serializes remote Ctrl shortcut key IPC calls', async () => {
    window.localStorage.setItem('nextdesk_kkterm_keyboard_mode', 'remote-scancode');
    const keyResolvers: Array<() => void> = [];
    invokeMock.mockImplementation((command: string) => {
      if (command === 'kkterm_rdp_key') {
        return new Promise<void>(resolve => {
          keyResolvers.push(resolve);
        });
      }
      return Promise.resolve({ tabId: 'tab-public' });
    });
    const keyCalls = () => invokeMock.mock.calls.filter(([command]) => command === 'kkterm_rdp_key');
    const { container } = render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1280, height: 800 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    invokeMock.mockClear();
    fireEvent.keyDown(canvas!, {
      code: 'KeyV',
      key: 'v',
      metaKey: true,
    });

    await waitFor(() => expect(keyCalls()).toHaveLength(1));
    expect(keyCalls()[0]?.[1]).toEqual({
      request: { tabId: 'tab-public', scancode: 0x1d, down: true },
    });

    keyResolvers.shift()?.();
    await waitFor(() => expect(keyCalls()).toHaveLength(2));
    expect(keyCalls()[1]?.[1]).toEqual({
      request: { tabId: 'tab-public', scancode: 0x2f, down: true },
    });

    keyResolvers.shift()?.();
    await waitFor(() => expect(keyCalls()).toHaveLength(3));
    expect(keyCalls()[2]?.[1]).toEqual({
      request: { tabId: 'tab-public', scancode: 0x2f, down: false },
    });

    keyResolvers.shift()?.();
    await waitFor(() => expect(keyCalls()).toHaveLength(4));
    expect(keyCalls()[3]?.[1]).toEqual({
      request: { tabId: 'tab-public', scancode: 0x1d, down: false },
    });
  });

  it('does not send the remote Windows key for macOS editing shortcuts in remote scancode mode', async () => {
    window.localStorage.setItem('nextdesk_kkterm_keyboard_mode', 'remote-scancode');
    const keyCalls = () => invokeMock.mock.calls.filter(([command]) => command === 'kkterm_rdp_key');
    const { container } = render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1280, height: 800 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    invokeMock.mockClear();
    fireEvent.keyDown(canvas!, {
      code: 'MetaLeft',
      key: 'Meta',
      metaKey: true,
    });
    fireEvent.keyDown(canvas!, {
      code: 'KeyV',
      key: 'v',
      metaKey: true,
    });
    fireEvent.keyUp(canvas!, {
      code: 'KeyV',
      key: 'v',
      metaKey: true,
    });
    fireEvent.keyUp(canvas!, {
      code: 'MetaLeft',
      key: 'Meta',
    });
    fireEvent.keyDown(canvas!, {
      code: 'KeyA',
      key: 'a',
    });

    await waitFor(() => {
      expect(keyCalls()).toContainEqual([
        'kkterm_rdp_key',
        { request: { tabId: 'tab-public', scancode: 0x1e, down: true } },
      ]);
    });
    const calls = keyCalls();
    const winKeyCalls = calls.filter(([, args]) => {
      const request = (args as { request: { scancode: number; down: boolean } }).request;
      return request.scancode === 0xe05b;
    });
    expect(winKeyCalls).toHaveLength(0);
  });

  it('keeps local macOS clipboard text injection available with Cmd+Shift+V in remote scancode mode', async () => {
    window.localStorage.setItem('nextdesk_kkterm_keyboard_mode', 'remote-scancode');
    const { container } = render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1280, height: 800 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    invokeMock.mockClear();
    fireEvent.keyDown(canvas!, {
      code: 'KeyV',
      key: 'v',
      metaKey: true,
      shiftKey: true,
    });

    await waitFor(() => {
      expect(readTextMock).toHaveBeenCalled();
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_text', {
        request: { tabId: 'tab-public', text: 'clipboard text' },
      });
    });
  });

  it('focuses the IME input and routes printable keys as scancodes in remote mode', async () => {
    window.localStorage.setItem('nextdesk_kkterm_keyboard_mode', 'remote-scancode');
    const { container } = render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1280, height: 800 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const display = await screen.findByLabelText('RDP display');
    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    invokeMock.mockClear();
    fireEvent.pointerDown(canvas!, { clientX: 10, clientY: 20, button: 0 });
    expect(document.activeElement).toBe(display);

    fireEvent.keyDown(display, {
      code: 'KeyA',
      key: 'a',
    });
    fireEvent.keyUp(display, {
      code: 'KeyA',
      key: 'a',
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_key', {
        request: { tabId: 'tab-public', scancode: 0x1e, down: true },
      });
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_key', {
        request: { tabId: 'tab-public', scancode: 0x1e, down: false },
      });
    });
    expect(invokeMock).not.toHaveBeenCalledWith('kkterm_rdp_text', expect.anything());
  });

  it('restores focus to the active KKTerm IME input after the app regains focus', async () => {
    vi.useFakeTimers();
    window.localStorage.setItem('nextdesk_kkterm_keyboard_mode', 'remote-scancode');
    const { container } = render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1280, height: 800 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const display = screen.getByLabelText('RDP display');
    expect(container.querySelector('canvas')).not.toBeNull();
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    expect(document.activeElement).toBe(display);

    const button = document.createElement('button');
    document.body.appendChild(button);
    button.focus();
    expect(document.activeElement).toBe(button);

    window.dispatchEvent(new Event('focus'));
    await act(async () => {
      vi.runOnlyPendingTimers();
    });

    expect(document.activeElement).toBe(display);
    button.remove();
  });

  it('uses the macOS produced printable key instead of the physical key position in remote scancode mode', async () => {
    window.localStorage.setItem('nextdesk_kkterm_keyboard_mode', 'remote-scancode');
    const { container } = render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1280, height: 800 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    invokeMock.mockClear();
    fireEvent.keyDown(canvas!, {
      code: 'KeyQ',
      key: 'a',
    });
    fireEvent.keyUp(canvas!, {
      code: 'KeyQ',
      key: 'a',
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_key', {
        request: { tabId: 'tab-public', scancode: 0x1e, down: true },
      });
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_key', {
        request: { tabId: 'tab-public', scancode: 0x1e, down: false },
      });
    });
    expect(invokeMock).not.toHaveBeenCalledWith('kkterm_rdp_key', {
      request: { tabId: 'tab-public', scancode: 0x10, down: true },
    });
  });

  it('releases the same scancode that was pressed when macOS keyup reports a different printable key', async () => {
    window.localStorage.setItem('nextdesk_kkterm_keyboard_mode', 'remote-scancode');
    const { container } = render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1280, height: 800 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    invokeMock.mockClear();
    fireEvent.keyDown(canvas!, {
      code: 'KeyQ',
      key: 'a',
    });
    fireEvent.keyUp(canvas!, {
      code: 'KeyQ',
      key: 'q',
    });

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_key', {
        request: { tabId: 'tab-public', scancode: 0x1e, down: true },
      });
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_key', {
        request: { tabId: 'tab-public', scancode: 0x1e, down: false },
      });
    });
    expect(invokeMock).not.toHaveBeenCalledWith('kkterm_rdp_key', {
      request: { tabId: 'tab-public', scancode: 0x10, down: false },
    });
  });

  it('releases pressed remote scancodes when the RDP canvas loses focus', async () => {
    window.localStorage.setItem('nextdesk_kkterm_keyboard_mode', 'remote-scancode');
    const { container } = render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1280, height: 800 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    invokeMock.mockClear();
    fireEvent.keyDown(canvas!, {
      code: 'KeyA',
      key: 'a',
    });
    fireEvent.blur(canvas!);

    await waitFor(() => {
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_key', {
        request: { tabId: 'tab-public', scancode: 0x1e, down: true },
      });
      expect(invokeMock).toHaveBeenCalledWith('kkterm_rdp_key', {
        request: { tabId: 'tab-public', scancode: 0x1e, down: false },
      });
    });
  });

  it('applies KKTerm cursor bitmap events to the canvas cursor', async () => {
    const canvasEventHandlers: Array<(event: { payload: unknown }) => void> = [];
    listenMock.mockImplementation((_eventName: string, handler: (event: { payload: unknown }) => void) => {
      canvasEventHandlers.push(handler);
      return Promise.resolve(() => undefined);
    });

    render(
      <KktermRdpSurface
        tabId="tab-public"
        server={server}
        active={true}
        desktopSize={{ width: 1280, height: 800 }}
        cadSignal={0}
        winSignal={0}
        textSignal={null}
        onConnected={vi.fn()}
        onDisconnected={vi.fn()}
        onError={vi.fn()}
      />,
    );

    const display = await screen.findByLabelText('RDP display');
    await waitFor(() => {
      expect(canvasEventHandlers.length).toBe(1);
    });
    const [emitCanvasEvent] = canvasEventHandlers;

    emitCanvasEvent({
      payload: {
        kind: 'setCursor',
        sessionId: 'rdp-tab-public',
        width: 1,
        height: 1,
        hotX: 0,
        hotY: 0,
        rgba: btoa(String.fromCharCode(255, 255, 255, 255)),
      },
    });

    await waitFor(() => {
      expect(display.parentElement?.querySelector('canvas')?.style.cursor).toBe(
        `url(${cursorDataUrlMock}) 0 0, auto`,
      );
    });
  });
});
