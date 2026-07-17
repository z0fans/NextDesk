import { describe, expect, it, vi } from 'vitest';
import { createKktermHostMoveFollower } from '@/rdp/kkterm/hostMoveFollower';

describe('KKTerm Windows host move follower', () => {
  it('coalesces repeated move events into one latest follow-up while a move is in flight', async () => {
    let resolveFirst!: () => void;
    const firstMove = new Promise<void>(resolve => {
      resolveFirst = resolve;
    });
    const followHostWindow = vi.fn()
      .mockReturnValueOnce(firstMove)
      .mockResolvedValue(undefined);
    const follower = createKktermHostMoveFollower(followHostWindow);

    follower.request();
    follower.request();
    follower.request();

    expect(followHostWindow).toHaveBeenCalledTimes(1);

    resolveFirst();
    await vi.waitFor(() => expect(followHostWindow).toHaveBeenCalledTimes(2));
  });

  it('stops issuing native follow requests after disposal', async () => {
    const followHostWindow = vi.fn().mockResolvedValue(undefined);
    const follower = createKktermHostMoveFollower(followHostWindow);

    follower.dispose();
    follower.request();
    await Promise.resolve();

    expect(followHostWindow).not.toHaveBeenCalled();
  });
});
