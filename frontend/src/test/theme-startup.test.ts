import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-dom/client', () => ({
  createRoot: vi.fn(() => ({
    render: vi.fn(),
  })),
}));

vi.mock('../App.tsx', () => ({
  default: () => null,
}));

describe('theme startup', () => {
  beforeEach(() => {
    vi.resetModules();
    document.documentElement.className = '';
    document.body.innerHTML = '<div id="root"></div>';
  });

  it('does not force dark mode after the preload theme script has selected light', async () => {
    await import('../main');

    expect(document.documentElement).not.toHaveClass('dark');
  });
});
