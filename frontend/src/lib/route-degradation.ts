import type { RouteHealthAssessment } from "@/api";

export interface RouteDegradationTracker {
  candidateKey?: string;
  firstObservedAt?: number;
  advantageObservations: number;
  recoveryObservations: number;
  visible?: RouteHealthAssessment;
}

export const EMPTY_ROUTE_DEGRADATION_TRACKER: RouteDegradationTracker = {
  advantageObservations: 0,
  recoveryObservations: 0,
};

export function routeHealthCandidateKey(assessment: RouteHealthAssessment): string | undefined {
  const candidate = assessment.alternative;
  if (!candidate) return undefined;
  return [
    candidate.candidateRef ?? candidate.routeLabel,
    candidate.countryCode ?? "",
    candidate.subregion ?? "",
  ].join(":");
}

export function updateRouteDegradationTracker(
  current: RouteDegradationTracker,
  assessment: RouteHealthAssessment,
  observedAt: number,
): RouteDegradationTracker {
  const candidateKey = routeHealthCandidateKey(assessment);
  if (!assessment.supported || !assessment.recommendation || !candidateKey) {
    const recoveryObservations = current.recoveryObservations + 1;
    if (current.visible && recoveryObservations < assessment.recoveryObservations) {
      return { ...current, recoveryObservations };
    }
    return EMPTY_ROUTE_DEGRADATION_TRACKER;
  }

  const sameCandidate = current.candidateKey === candidateKey;
  const advantageObservations = sameCandidate ? current.advantageObservations + 1 : 1;
  const firstObservedAt = sameCandidate && current.firstObservedAt !== undefined
    ? current.firstObservedAt
    : observedAt;
  const stable = advantageObservations >= assessment.requiredObservations
    || observedAt - firstObservedAt >= assessment.checkIntervalMs;

  return {
    candidateKey,
    firstObservedAt,
    advantageObservations,
    recoveryObservations: 0,
    visible: stable ? assessment : sameCandidate ? current.visible : undefined,
  };
}
