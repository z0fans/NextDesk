import type { RdpConnectionParams, RdpEngine, RdpEngineCallbacks } from './engine-types';

export function createNativeExperimentalEngine(): RdpEngine {
  return {
    name: 'native-experimental',
    async connect(_params: RdpConnectionParams, callbacks: RdpEngineCallbacks) {
      callbacks.onStatus({
        tabId: _params.tabId,
        status: 'error',
        message: 'Native RDP engine is experimental and has not been moved behind the engine facade yet.',
      });
      throw new Error('Native RDP engine is experimental and not available through the facade yet');
    },
  };
}
