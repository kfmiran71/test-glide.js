const DEFAULTS = Object.freeze({
  minimumObservationSeconds: 180,
  maximumObservationSeconds: 600,
  segmentFraction: 0.5
});

function finiteOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function describeDepartureCorridor(pattern = [], targetStop = "") {
  const targetIndexes = pattern
    .map((stop, index) => stop?.stopId === targetStop ? index : -1)
    .filter(index => index >= 0);
  if (targetIndexes.length !== 1) return null;
  const targetIndex = targetIndexes[0];
  const target = pattern[targetIndex];
  const next = pattern[targetIndex + 1];
  if (!next?.stopId) return null;
  const targetTime = finiteOrNull(target.eventTime);
  const nextTime = finiteOrNull(next.eventTime);
  const predictedTravelSeconds = targetTime !== null && nextTime !== null && nextTime > targetTime
    ? nextTime - targetTime
    : null;
  return {
    targetStop,
    nextServedStop: next.stopId,
    targetStopSequence: finiteOrNull(target.stopSequence),
    nextStopSequence: finiteOrNull(next.stopSequence),
    predictedTravelSeconds,
    // GTFS-RT lists served stops, not physical track geometry. A gap in stop
    // sequence is recorded but never interpreted as a count of skipped stops.
    skippedStopCount: null
  };
}

export function evaluateLonghaulDeparture(input = {}, configuration = {}) {
  const options = { ...DEFAULTS, ...configuration };
  const nowMs = finiteOrNull(input.nowMs);
  const lockedAt = finiteOrNull(input.lockedAt);
  const corridor = input.corridor || null;
  const segmentSeconds = finiteOrNull(corridor?.predictedTravelSeconds);
  const observationSeconds = Math.max(
    options.minimumObservationSeconds,
    Math.min(
      options.maximumObservationSeconds,
      segmentSeconds === null
        ? options.minimumObservationSeconds
        : Math.round(segmentSeconds * options.segmentFraction)
    )
  );
  const elapsedSeconds = nowMs === null || lockedAt === null
    ? null
    : Math.max(0, Math.round((nowMs - lockedAt) / 1000));
  const overdue = elapsedSeconds !== null && elapsedSeconds >= observationSeconds;
  const freshExplicitStoppedAtTarget = Boolean(
    input.vehicle?.present &&
    input.vehicle?.fresh &&
    input.vehicle?.position === "TARGET" &&
    input.vehicle?.currentStatusExplicit &&
    input.vehicle?.currentStatus === 1
  );
  const corroborators = {
    targetMissingFromTripUpdate: Boolean(input.tripUpdatePresent && !input.targetPresent),
    targetPredictionExpired: Boolean(
      finiteOrNull(input.lastTargetTime) !== null &&
      nowMs !== null &&
      nowMs / 1000 > Number(input.lastTargetTime)
    ),
    exactVehicleUnavailable: Boolean(!input.vehicle?.present || !input.vehicle?.fresh)
  };
  const corroboratorCount = Object.values(corroborators).filter(Boolean).length;
  const wouldRelease = Boolean(
    input.departureLocked &&
    corridor &&
    overdue &&
    !freshExplicitStoppedAtTarget &&
    corroboratorCount >= 2
  );
  return {
    mode: "SHADOW",
    wouldRelease,
    reason: wouldRelease
      ? "LONGHAUL_CORROBORATED_DEPARTURE"
      : freshExplicitStoppedAtTarget
        ? "FRESH_EXPLICIT_STOPPED_VETO"
        : !corridor
          ? "CORRIDOR_UNRESOLVED"
          : !overdue
            ? "OBSERVATION_WINDOW_ACTIVE"
            : "INSUFFICIENT_CORROBORATION",
    corridor,
    elapsedSeconds,
    observationSeconds,
    corroborators,
    corroboratorCount,
    boardEffect: false
  };
}

export const __test = Object.freeze({ DEFAULTS });
