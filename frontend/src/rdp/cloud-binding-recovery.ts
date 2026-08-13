export type CloudBindingKeepaliveAction = 'retain-route' | 'replace-route';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function cloudBindingKeepaliveAction(error: unknown): CloudBindingKeepaliveAction {
  return errorMessage(error).toLowerCase().includes('cloud_binding_gone')
    ? 'replace-route'
    : 'retain-route';
}

export function recoverGoneCloudBinding(
  error: unknown,
  actions: { stopKeepalive: () => void; replaceRoute: () => void },
): boolean {
  if (cloudBindingKeepaliveAction(error) !== 'replace-route') {
    return false;
  }
  actions.stopKeepalive();
  actions.replaceRoute();
  return true;
}
