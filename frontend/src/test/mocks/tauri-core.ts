export async function invoke(_cmd: string, _args?: Record<string, unknown>): Promise<unknown> {
  return null;
}

export class Channel<T = unknown> {
  onmessage: (message: T) => void = () => {};

  constructor(onmessage?: (message: T) => void) {
    if (onmessage) this.onmessage = onmessage;
  }
}
