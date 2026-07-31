export const STATION_STATE_VEHICLE_FRESHNESS_SECONDS = 120;

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function exactEvidenceIdentityMatches(subject, evidence) {
  return Boolean(
    subject?.identityKey &&
    subject.identityKey === evidence?.identityKey &&
    subject.tripId &&
    subject.tripId === evidence?.tripId &&
    String(subject.startDate || "") === String(evidence?.startDate || "")
  );
}

export function freshExactVehicle(subject, evidence) {
  if (
    !exactEvidenceIdentityMatches(subject, evidence) ||
    !evidence?.vehiclePositionPresent ||
    evidence?.vehiclePositionAmbiguous ||
    !evidence?.vehicle ||
    !evidence.feedSucceeded ||
    evidence.feedStale
  ) {
    return null;
  }

  const timestamp = finiteNumber(evidence.vehicle.timestamp);
  const reportedAge = finiteNumber(evidence.vehicleAgeSeconds);
  const feedTimestamp = finiteNumber(evidence.feedTimestamp);
  const calculatedAge =
    feedTimestamp !== null && timestamp !== null
      ? feedTimestamp - timestamp
      : null;
  const age = reportedAge ?? calculatedAge;

  if (
    timestamp === null ||
    age === null ||
    age < -15 ||
    age > STATION_STATE_VEHICLE_FRESHNESS_SECONDS
  ) {
    return null;
  }

  return {
    ...evidence.vehicle,
    timestamp,
    ageSeconds: age
  };
}

export function realtimeStoppingPattern(evidence) {
  if (
    !evidence?.tripUpdatePresent ||
    !evidence?.identityKey ||
    !evidence?.tripId
  ) {
    return null;
  }

  const stopIds = (evidence.stopUpdates || [])
    .map(stop => String(stop?.stopId || ""))
    .filter(Boolean);
  const targetStop = String(evidence.targetStop || "");
  const targetIndexes = [];

  stopIds.forEach((stopId, index) => {
    if (stopId === targetStop) targetIndexes.push(index);
  });

  const targetUnique = targetIndexes.length === 1;
  return {
    identityKey: evidence.identityKey,
    tripId: evidence.tripId,
    startDate: String(evidence.startDate || ""),
    targetStop,
    stopIds,
    targetIndexes,
    targetIndex: targetUnique ? targetIndexes[0] : null,
    targetUnique,
    feedTimestamp: finiteNumber(evidence.feedTimestamp),
    feedAgeSeconds: finiteNumber(evidence.feedAgeSeconds),
    feedStale: Boolean(evidence.feedStale)
  };
}

export function conclusiveRealtimePattern(subject, evidence) {
  if (!exactEvidenceIdentityMatches(subject, evidence)) return null;
  const pattern = realtimeStoppingPattern(evidence);
  if (
    !pattern ||
    !pattern.targetUnique ||
    pattern.feedStale ||
    pattern.feedTimestamp === null
  ) {
    return null;
  }
  return pattern;
}

export function newerConclusivePattern(subject, evidence, previousPattern) {
  const candidate = conclusiveRealtimePattern(subject, evidence);
  if (!candidate) return previousPattern || null;

  const previousTimestamp = finiteNumber(previousPattern?.feedTimestamp);
  if (
    previousPattern &&
    previousTimestamp !== null &&
    candidate.feedTimestamp <= previousTimestamp
  ) {
    return previousPattern;
  }
  return candidate;
}

export function downstreamStopDecision(pattern, proposedStop) {
  const stopId = String(proposedStop || "");
  if (!pattern?.targetUnique || !stopId) {
    return {
      outcome: "UNKNOWN",
      reason: "NO_CONCLUSIVE_REALTIME_PATTERN"
    };
  }
  if (stopId === pattern.targetStop) {
    return {
      outcome: "NEGATIVE",
      reason: "VEHICLE_STILL_NAMES_TARGET"
    };
  }

  const occurrences = [];
  pattern.stopIds.forEach((patternStop, index) => {
    if (patternStop === stopId) occurrences.push(index);
  });
  if (!occurrences.length) {
    return {
      outcome: "UNKNOWN",
      reason: "VEHICLE_STOP_NOT_IN_REALTIME_PATTERN"
    };
  }
  if (occurrences.some(index => index <= pattern.targetIndex)) {
    return {
      outcome: "UNKNOWN",
      reason: "DOWNSTREAM_STOP_OCCURRENCE_AMBIGUOUS"
    };
  }
  return {
    outcome: "AFFIRMATIVE",
    reason: "FRESH_EXACT_VEHICLE_NAMES_REALTIME_DOWNSTREAM_STOP",
    proposedDownstreamStop: stopId,
    downstreamIndexes: occurrences
  };
}

export function staticRealtimeSequenceMismatch(subject, evidence) {
  const staticTargetSequence = finiteNumber(subject?.targetStopSequence);
  const realtimeSequence = finiteNumber(
    evidence?.vehicle?.currentStopSequence
  );
  return Boolean(
    evidence?.vehicle?.stopId === subject?.targetStop &&
    staticTargetSequence !== null &&
    realtimeSequence !== null &&
    staticTargetSequence !== realtimeSequence
  );
}
