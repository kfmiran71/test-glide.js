export const SUCCESSOR_OCCUPANCY_RELEASE_REASON =
  "SUCCESSOR_STOPPED_AT_TARGET";

export const STOPPED_AT = 1;
export const DEFAULT_FRESHNESS_SECONDS = 90;

function numberValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function evidenceIsFresh(evidence, nowMs, freshnessSeconds) {
  const feedTimestamp = numberValue(evidence?.feedTimestamp);
  if (feedTimestamp === null) return false;
  const ageSeconds = nowMs / 1000 - feedTimestamp;
  return ageSeconds >= -60 && ageSeconds <= freshnessSeconds;
}

function freshExplicitStoppedAtTarget(
  evidence,
  targetStop,
  nowMs,
  freshnessSeconds
) {
  return Boolean(
    evidence?.identityKey &&
    evidenceIsFresh(evidence, nowMs, freshnessSeconds) &&
    evidence.vehiclePositionPresent &&
    !evidence.vehiclePositionAmbiguous &&
    evidence.vehicle?.stopId === targetStop &&
    evidence.vehicle?.currentStatusExplicit &&
    numberValue(evidence.vehicle.currentStatus) === STOPPED_AT
  );
}

function freshVehicleStillNamesTarget(
  evidence,
  targetStop,
  nowMs,
  freshnessSeconds
) {
  return Boolean(
    evidenceIsFresh(evidence, nowMs, freshnessSeconds) &&
    evidence?.vehiclePositionPresent &&
    !evidence?.vehiclePositionAmbiguous &&
    evidence?.vehicle?.stopId === targetStop
  );
}

export function classifySuccessorOccupancyRelease({
  lock,
  lockedEvidence,
  allEvidence,
  nowMs,
  freshnessSeconds = DEFAULT_FRESHNESS_SECONDS
}) {
  const targetStop =
    String(lock?.platformId || lock?.selectedStop || "");
  const base = {
    enabled: true,
    targetStop,
    lockedIdentityKey: lock?.identityKey || null,
    freshnessSeconds,
    outcome: "UNKNOWN",
    reason: "NO_AFFIRMATIVE_SUCCESSOR_OCCUPANCY"
  };

  if (!targetStop || !lock?.identityKey) {
    return base;
  }

  if (
    freshVehicleStillNamesTarget(
      lockedEvidence,
      targetStop,
      nowMs,
      freshnessSeconds
    )
  ) {
    return {
      ...base,
      outcome: "NEGATIVE",
      reason: "LOCKED_VEHICLE_STILL_NAMES_TARGET"
    };
  }

  const successors = (allEvidence || [])
    .filter(evidence =>
      evidence.identityKey !== lock.identityKey &&
      freshExplicitStoppedAtTarget(
        evidence,
        targetStop,
        nowMs,
        freshnessSeconds
      )
    )
    .sort((a, b) =>
      String(a.identityKey).localeCompare(String(b.identityKey))
    );

  if (successors.length !== 1) {
    return {
      ...base,
      outcome: successors.length > 1 ? "UNKNOWN" : base.outcome,
      reason:
        successors.length > 1
          ? "SUCCESSOR_OCCUPANCY_AMBIGUOUS"
          : base.reason,
      successorIdentityKeys:
        successors.map(successor => successor.identityKey)
    };
  }

  const successor = successors[0];
  return {
    ...base,
    outcome: "AFFIRMATIVE",
    reason: SUCCESSOR_OCCUPANCY_RELEASE_REASON,
    successorIdentityKey: successor.identityKey,
    successorTripId: successor.tripId || null,
    successorStartDate: successor.startDate || "",
    successorRoute: successor.route || null,
    successorVehicle: { ...successor.vehicle },
    successorFeedTimestamp: successor.feedTimestamp
  };
}
