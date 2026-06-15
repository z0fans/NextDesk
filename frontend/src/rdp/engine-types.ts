export type RdpTabId = string;

export type RdpConnectionParams = {
  tabId: RdpTabId;
  host: string;
  port: number;
  username: string;
  password: string;
  domain?: string;
  width: number;
  height: number;
  canvas: HTMLCanvasElement;
};

export type RdpResizeParams = {
  tabId: RdpTabId;
  width: number;
  height: number;
};

export type RdpKeyboardEvent = {
  tabId: RdpTabId;
  scancode: number;
  isPressed: boolean;
};

export type RdpMouseButtonEvent = {
  tabId: RdpTabId;
  x: number;
  y: number;
  button: number;
  isDown: boolean;
};

export type RdpWheelEvent = {
  tabId: RdpTabId;
  x: number;
  y: number;
  delta: number;
  isHorizontal: boolean;
};

export type RdpStatusKind =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'
  | 'error';

export type RdpStatusUpdate = {
  tabId: RdpTabId;
  status: RdpStatusKind;
  message?: string;
};

export type RdpFrameUpdate = {
  tabId: RdpTabId;
  desktopWidth?: number;
  desktopHeight?: number;
};

export type RdpEngineCallbacks = {
  onStatus(update: RdpStatusUpdate): void;
  onFrame?(update: RdpFrameUpdate): void;
};

export type RdpEngineSession = {
  tabId: RdpTabId;
  disconnect(): Promise<void>;
  resize(params: RdpResizeParams): Promise<void>;
  sendKey(event: RdpKeyboardEvent): void;
  sendMouseButton(event: RdpMouseButtonEvent): void;
  sendWheel(event: RdpWheelEvent): void;
};

export type RdpEngine = {
  readonly name: 'ironrdp-web' | 'native-experimental';
  connect(params: RdpConnectionParams, callbacks: RdpEngineCallbacks): Promise<RdpEngineSession>;
};
