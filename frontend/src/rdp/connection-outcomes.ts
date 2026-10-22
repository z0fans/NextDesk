import type { ConnectionOutcomeInput, ConnectionOutcomeStage, ConnectionOutcomeStatus } from '@/api';

export type RdpFailure = { message: string; outcomeReported: boolean };

export function readRdpFailure(error: unknown): RdpFailure {
  if (error && typeof error === 'object') {
    const value = error as { message?: unknown; outcomeReported?: unknown; backtrace?: unknown };
    const message = typeof value.backtrace === 'function' ? value.backtrace() : value.message;
    if (typeof message === 'string') {
      return { message, outcomeReported: value.outcomeReported === true };
    }
  }
  return { message: String(error), outcomeReported: false };
}

export type RdpOutcomeOptions = {
  error?: unknown;
  userInitiated?: boolean;
  sourceAttemptId?: string;
  sourceRouteLeaseId?: number;
  useCurrentRoute?: boolean;
};

type Attempt = {
  id: string;
  startedAt: number;
  connectedAt?: number;
  stage?: ConnectionOutcomeStage;
  enteredAt: number;
  durations: Partial<Record<ConnectionOutcomeStage, number>>;
  terminal: boolean;
  firstInteractive: boolean;
};

export class RdpConnectionOutcomes {
  private attempts = new Map<string, Attempt>();
  private send: (input: ConnectionOutcomeInput) => void;

  constructor(send: (input: ConnectionOutcomeInput) => void) {
    this.send = send;
  }

  begin(tabId: string, attemptId: string): void {
    const now = Date.now();
    this.attempts.set(tabId, {
      id: attemptId, startedAt: now, enteredAt: now, durations: {},
      terminal: false, firstInteractive: false,
    });
  }

  attemptId(tabId: string): string | undefined {
    return this.attempts.get(tabId)?.id;
  }

  dispose(): void {
    this.attempts.clear();
  }

  forget(tabId: string): void {
    this.attempts.delete(tabId);
  }

  report(tabId: string, status: ConnectionOutcomeStatus, stage: ConnectionOutcomeStage,
    options: RdpOutcomeOptions = {}): void {
    const attempt = this.attempts.get(tabId);
    if (!attempt || attempt.terminal ||
        (options.sourceAttemptId && options.sourceAttemptId !== attempt.id)) return;
    if (stage === 'first_interactive_result') {
      if (attempt.firstInteractive) return;
      attempt.firstInteractive = true;
    }
    const failure = options.error === undefined ? undefined : readRdpFailure(options.error);
    const terminal = status === 'failed' || status === 'disconnected';
    if (terminal) attempt.terminal = true;
    // Native startup owns its failure report even when its delivery is still pending.
    if (failure?.outcomeReported) return;
    const now = Date.now();
    if (status === 'connected' && stage === 'session_established') {
      attempt.connectedAt ??= now;
    }
    if (attempt.stage && attempt.stage !== stage) {
      attempt.durations[attempt.stage] = (attempt.durations[attempt.stage] ?? 0)
        + Math.max(0, now - attempt.enteredAt);
    }
    if (attempt.stage !== stage) attempt.enteredAt = now;
    attempt.stage = stage;
    if (terminal) {
      attempt.durations[stage] = (attempt.durations[stage] ?? 0)
        + Math.max(0, now - attempt.enteredAt);
    }
    this.send({
      sessionId: tabId, serviceKind: 'rdp', status, stage,
      routeLeaseId: options.useCurrentRoute === false ? undefined : options.sourceRouteLeaseId,
      useCurrentRoute: options.useCurrentRoute,
      attemptId: attempt.id, eventId: `${attempt.id}-${status}-${stage}`,
      errorCode: failure ? rdpOutcomeErrorCode(failure.message) : undefined,
      durationMs: status === 'disconnected' ? undefined : Math.max(0, now - attempt.startedAt),
      sessionDurationMs: status === 'disconnected' && attempt.connectedAt !== undefined
        ? Math.max(0, now - attempt.connectedAt) : undefined,
      userInitiated: options.userInitiated ?? false,
      stageDurationsMs: { ...attempt.durations },
    });
  }
}

function rdpOutcomeErrorCode(message: string): string {
  const value = message.toLowerCase();
  if (value.includes('password') || value.includes('credential') || value.includes('authentication')) {
    return 'rdp_authentication_rejected';
  }
  if (value.includes('certificate') || value.includes('untrusted')) {
    return 'rdp_host_identity_untrusted';
  }
  if (value.includes('refused')) return 'rdp_connection_refused';
  if (value.includes('reset')) return 'rdp_connection_reset';
  if (value.includes('timeout') || value.includes('timed out')) return 'rdp_transport_timeout';
  if (value.includes('cancel')) return 'rdp_user_cancelled';
  if (value.includes('disconnect') || value.includes('closed')) return 'rdp_session_interrupted';
  return 'rdp_connection_failed';
}

export function rdpOutcomeStage(message: string): 'transport' | 'protocol_handshake' | 'authentication' | 'host_identity' | 'failed' {
  const code = rdpOutcomeErrorCode(message);
  if (code.includes('authentication')) return 'authentication';
  if (code.includes('host_identity')) return 'host_identity';
  if (code.includes('transport') || code.includes('refused') || code.includes('reset')) return 'transport';
  const value = message.toLowerCase();
  if (value.includes('handshake') || value.includes('tls')) return 'protocol_handshake';
  return 'failed';
}
