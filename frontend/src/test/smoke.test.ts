import { describe, it, expect } from 'vitest';

/**
 * Smoke test — 验证测试框架是否正确安装和配置
 */
describe('测试框架 Smoke Test', () => {
  it('基本断言正常', () => {
    expect(1 + 1).toBe(2);
    expect('NextDesk').toContain('Desk');
  });

  it('jest-dom matchers 可用', () => {
    const div = document.createElement('div');
    div.textContent = 'Hello NextDesk';
    document.body.appendChild(div);

    expect(div).toBeInTheDocument();
    expect(div).toHaveTextContent('Hello NextDesk');

    document.body.removeChild(div);
  });

  it('jsdom 环境正常', () => {
    expect(typeof window).toBe('object');
    expect(typeof document).toBe('object');
    expect(typeof document.createElement).toBe('function');
  });

  it('ResizeObserver mock 已安装', () => {
    const observer = new ResizeObserver(() => {});
    expect(observer.observe).toBeDefined();
    expect(observer.disconnect).toBeDefined();
  });
});
