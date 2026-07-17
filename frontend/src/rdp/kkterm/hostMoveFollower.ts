export interface KktermHostMoveFollower {
  request: () => void;
  dispose: () => void;
}

export function createKktermHostMoveFollower(
  followHostWindow: () => Promise<void>,
  onError: (error: unknown) => void = () => undefined,
): KktermHostMoveFollower {
  let active = true;
  let inFlight = false;
  let pending = false;

  const request = () => {
    if (!active) return;
    if (inFlight) {
      pending = true;
      return;
    }

    inFlight = true;
    let operation: Promise<void>;
    try {
      operation = followHostWindow();
    } catch (error) {
      operation = Promise.reject(error);
    }

    void operation
      .catch(onError)
      .finally(() => {
        inFlight = false;
        if (!active) {
          pending = false;
          return;
        }
        if (pending) {
          pending = false;
          request();
        }
      });
  };

  return {
    request,
    dispose: () => {
      active = false;
      pending = false;
    },
  };
}
