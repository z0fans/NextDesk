export class NativePressedKeyTracker {
  private readonly pressed = new Set<number>();

  press(scancode: number): void {
    this.pressed.add(scancode);
  }

  release(scancode: number): void {
    this.pressed.delete(scancode);
  }

  releaseAll(sendRelease: (scancode: number) => void): void {
    const scancodes = Array.from(this.pressed);
    this.pressed.clear();
    for (const scancode of scancodes) {
      sendRelease(scancode);
    }
  }
}
