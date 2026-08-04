import {
  describeDepartureCorridor,
  evaluateLonghaulDeparture
} from "./longhaul-fallback.js";

export const ENGINE_MODES = Object.freeze({
  LEGACY: "legacy",
  SHADOW: "shadow",
  FOREVER: "forever"
});

export const MOVEMENT_STATES = Object.freeze({
  OBSERVED: "OBSERVED",
  MOVING_UPSTREAM: "MOVING_UPSTREAM",
  APPROACHING: "APPROACHING",
  ENTRY_UNCONFIRMED: "ENTRY_UNCONFIRMED",
  STOPPED_AT_TARGET: "STOPPED_AT_TARGET",
  DEPARTURE_UNCONFIRMED: "DEPARTURE_UNCONFIRMED",
  CONFIRMED_DOWNSTREAM: "CONFIRMED_DOWNSTREAM",
  WITHDRAWN: "WITHDRAWN"
});

export const DECISION_REASONS = Object.freeze({
  CURRENT_PREDICTION: "CURRENT_PREDICTION",
  RECOVERED_FEED_CONSISTENT_FUTURE: "RECOVERED_FEED_CONSISTENT_FUTURE",
  RECOVERED_PERSISTENT_FUTURE: "RECOVERED_PERSISTENT_FUTURE",
  SUPPRESSED_ORPHAN_TRIP_UPDATE: "SUPPRESSED_ORPHAN_TRIP_UPDATE",
  SUPPRESSED_CANCELED_OR_NO_DATA: "SUPPRESSED_CANCELED_OR_NO_DATA",
  PRE_ENTRY_CUSTODY: "PRE_ENTRY_CUSTODY",
  EXACT_STOPPED_AT_TARGET: "EXACT_STOPPED_AT_TARGET",
  REPEATED_TARGET_ZERO: "REPEATED_TARGET_ZERO",
  DEPARTURE_PROOF_HOLD: "DEPARTURE_PROOF_HOLD",
  FIRST_MISSING_EXACT_VEHICLE_POSITION: "FIRST_MISSING_EXACT_VEHICLE_POSITION",
  EXACT_VEHICLE_DOWNSTREAM: "EXACT_VEHICLE_DOWNSTREAM",
  EXACT_TRIP_UPDATE_DOWNSTREAM: "EXACT_TRIP_UPDATE_DOWNSTREAM",
  EXACT_TRIP_UPDATE_PROGRESSION: "EXACT_TRIP_UPDATE_PROGRESSION",
  EXACT_DOWNSTREAM_PATTERN_OVERRIDES_TARGET: "EXACT_DOWNSTREAM_PATTERN_OVERRIDES_TARGET",
  EXPLICIT_TRIP_CANCELLED: "EXPLICIT_TRIP_CANCELLED",
  TERMINAL_CURRENT_PREDICTION: "TERMINAL_CURRENT_PREDICTION",
  TERMINAL_TRIP_COMPLETED: "TERMINAL_TRIP_COMPLETED",
  ORIGIN_DEPARTURE_PREDICTION: "ORIGIN_DEPARTURE_PREDICTION",
  ORIGIN_DEPARTURE_CUSTODY: "ORIGIN_DEPARTURE_CUSTODY",
  ORIGIN_DEPARTURE_HOLD: "ORIGIN_DEPARTURE_HOLD",
  OUTSIDE_BOARD_WINDOW: "OUTSIDE_BOARD_WINDOW"
});

export const SERVICE_ROLES = Object.freeze({
  INTERMEDIATE: "INTERMEDIATE",
  TERMINAL_ARRIVAL: "TERMINAL_ARRIVAL",
  ORIGIN_DEPARTURE: "ORIGIN_DEPARTURE",
  UNRESOLVED: "UNRESOLVED"
});

const DEFAULTS = Object.freeze({
  boardWindowMinutes: 60,
  custodyWindowMinutes: 10,
  nearArrivalStrictWindowMinutes: 5,
  futureObservationMaxAgeMs: 3 * 60 * 1000,
  futureObservationPurgeAgeMs: 10 * 60 * 1000,
  futureObservationMaxTimeShiftSeconds: 3 * 60,
  realtimeFeedFreshnessSeconds: 3 * 60,
  preEntryMissingSnapshotLimit: 2,
  preEntryPredictionGraceSeconds: 45,
  vehicleFreshSeconds: 90,
  downstreamProofMonitorEnabled: true,
  routeLimit: 3,
  zeroConfirmationSnapshots: 2,
  maxRegistryRecords: 5000
});

function numberOrNull(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function exactIdentity(trip = {}) {
  const tripId = String(trip.tripId || "").trim();
  if (!tripId) return null;
  const startDate = String(trip.startDate || "").trim();
  return {
    identityKey: `${tripId}|${startDate}`,
    tripId,
    startDate
  };
}

function uniqueIndex(pattern, stopId) {
  const indexes = [];
  for (let index = 0; index < (pattern || []).length; index += 1) {
    if (pattern[index].stopId === stopId) indexes.push(index);
  }
  return indexes.length === 1 ? indexes[0] : null;
}

function relativePosition(pattern, targetStop, observedStop) {
  if (!observedStop) return "UNKNOWN";
  if (observedStop === targetStop) return "TARGET";
  const targetIndex = uniqueIndex(pattern, targetStop);
  const observedIndex = uniqueIndex(pattern, observedStop);
  if (targetIndex === null || observedIndex === null) return "UNKNOWN";
  if (observedIndex < targetIndex) return "UPSTREAM";
  if (observedIndex > targetIndex) return "DOWNSTREAM";
  return "TARGET";
}

function normalizedPattern(stopUpdates = []) {
  return stopUpdates.map((stop, index) => ({
    stopId: String(stop.stopId || ""),
    stopSequence: numberOrNull(stop.stopSequence),
    eventTime: numberOrNull(stop.eventTime),
    arrivalTime: numberOrNull(stop.arrivalTime),
    departureTime: numberOrNull(stop.departureTime),
    confidenceTime: numberOrNull(stop.arrivalTime ?? stop.departureTime ?? stop.eventTime),
    realtimeIndex: index
  })).filter(stop => stop.stopId);
}

function coherentStopTimeOrdering(pattern = []) {
  let previousTime = null;
  for (const stop of pattern) {
    if (stop.confidenceTime === null) continue;
    if (previousTime !== null && stop.confidenceTime < previousTime) return false;
    previousTime = stop.confidenceTime;
  }
  return true;
}

function timestampFresh(timestamp, nowSeconds, freshnessSeconds) {
  return timestamp !== null &&
    Math.abs(nowSeconds - timestamp) <= freshnessSeconds;
}

function serviceRole(
  pattern,
  previousPattern,
  targetStop,
  vehicle = null,
  staticOriginStop = ""
) {
  const candidates = [pattern, previousPattern]
    .filter(candidate => Array.isArray(candidate) && candidate.length > 1)
    .sort((a, b) => b.length - a.length);
  for (const candidate of candidates) {
    const targetIndex = uniqueIndex(candidate, targetStop);
    if (targetIndex === null) continue;
    if (targetIndex === 0) {
      const targetSequence = numberOrNull(candidate[targetIndex]?.stopSequence);
      const vehicleSequence = vehicle?.stopId === targetStop &&
        vehicle?.currentStopSequenceExplicit
        ? numberOrNull(vehicle.currentStopSequence)
        : null;
      // Realtime arrays shed served stops, so target-first is not proof that
      // this trip originated here. An explicit sequence above one proves the
      // train was already in progress; only an explicit first sequence proves
      // origin behavior without an earlier conclusive pattern.
      if ((targetSequence !== null && targetSequence > 1) ||
          (vehicleSequence !== null && vehicleSequence > 1)) {
        return SERVICE_ROLES.INTERMEDIATE;
      }
      if ((targetSequence !== null && targetSequence <= 1) ||
          (vehicleSequence !== null && vehicleSequence <= 1)) {
        return SERVICE_ROLES.ORIGIN_DEPARTURE;
      }
      continue;
    }
    if (targetIndex === candidate.length - 1) return SERVICE_ROLES.TERMINAL_ARRIVAL;
    return SERVICE_ROLES.INTERMEDIATE;
  }
  // Route-level first-stop data remains diagnostic context only. It is not
  // exact-trip proof and therefore cannot manufacture an origin role.
  return SERVICE_ROLES.UNRESOLVED;
}

function selectTargetTimestamp(targetUpdate, role) {
  const arrivalTime = numberOrNull(targetUpdate?.arrivalTime);
  const departureTime = numberOrNull(targetUpdate?.departureTime);
  const fallbackTime = numberOrNull(targetUpdate?.eventTime);
  const dwellSeconds = arrivalTime !== null && departureTime !== null
    ? Math.max(0, departureTime - arrivalTime)
    : null;
  if (role === SERVICE_ROLES.ORIGIN_DEPARTURE && departureTime !== null) {
    return {
      arrivalTime,
      departureTime,
      dwellSeconds,
      selectedEventType: "DEPARTURE",
      selectedEventTime: departureTime,
      timestampSelectionReason: "ORIGIN_DEPARTURE_DEPARTURE_TIME"
    };
  }
  if (arrivalTime !== null) {
    return {
      arrivalTime,
      departureTime,
      dwellSeconds,
      selectedEventType: "ARRIVAL",
      selectedEventTime: arrivalTime,
      timestampSelectionReason: role === SERVICE_ROLES.INTERMEDIATE
        ? "INTERMEDIATE_ARRIVAL_TIME"
        : role === SERVICE_ROLES.TERMINAL_ARRIVAL
          ? "TERMINAL_ARRIVAL_ARRIVAL_TIME"
          : "UNRESOLVED_ARRIVAL_TIME"
    };
  }
  return {
    arrivalTime,
    departureTime,
    dwellSeconds,
    selectedEventType: departureTime !== null ? "DEPARTURE" : "UNKNOWN",
    selectedEventTime: departureTime ?? fallbackTime,
    timestampSelectionReason: departureTime !== null
      ? `${role}_DEPARTURE_FALLBACK`
      : "LEGACY_EVENT_TIME_FALLBACK"
  };
}

function targetConclusivePattern(pattern, previousPattern, targetStop) {
  if (uniqueIndex(pattern, targetStop) !== null) return pattern;
  if (uniqueIndex(previousPattern, targetStop) !== null) return previousPattern;
  return [];
}

function tripUpdateProvesDownstream(observation, conclusivePattern) {
  if (!observation.tripUpdatePresent || observation.targetPresent || !observation.pattern.length) {
    return false;
  }
  // GTFS-RT commonly emits only the remaining suffix after a served stop. The
  // first remaining occurrence is affirmative downstream evidence only when
  // the last target-containing pattern locates it uniquely after the target.
  return relativePosition(
    conclusivePattern,
    observation.targetStop,
    observation.pattern[0].stopId
  ) === "DOWNSTREAM";
}

function tripUpdateSuffixAdvanced(previousPattern, currentPattern, targetStop) {
  if (!previousPattern.length || !currentPattern.length) return false;
  if (uniqueIndex(previousPattern, targetStop) !== null ||
      uniqueIndex(currentPattern, targetStop) !== null) return false;
  const currentFirstInPrevious = uniqueIndex(previousPattern, currentPattern[0].stopId);
  if (currentFirstInPrevious === null || currentFirstInPrevious <= 0) return false;
  return currentPattern.every((stop, index) =>
    uniqueIndex(currentPattern, stop.stopId) !== null &&
    previousPattern[currentFirstInPrevious + index]?.stopId === stop.stopId
  );
}

function vehicleEvidence(observation, nowSeconds, options) {
  const vehicle = observation.vehicle;
  if (!vehicle || observation.vehicleAmbiguous) {
    return { present: false, fresh: false, ageSeconds: null, position: "UNKNOWN" };
  }
  const timestamp = numberOrNull(vehicle.timestamp);
  const ageSeconds = timestamp === null ? null : Math.max(0, nowSeconds - timestamp);
  const fresh = ageSeconds !== null && ageSeconds <= options.vehicleFreshSeconds;
  // Realtime stop updates commonly shed stops after the train serves them. A
  // target-free suffix cannot locate a VehiclePosition relative to the target,
  // so retain the last exact pattern that contained the target instead.
  const pattern = targetConclusivePattern(
    observation.pattern,
    observation.previousPattern || [],
    observation.targetStop
  );
  return {
    present: true,
    fresh,
    ageSeconds,
    position: relativePosition(pattern, observation.targetStop, vehicle.stopId),
    stopId: vehicle.stopId,
    currentStopSequence: numberOrNull(vehicle.currentStopSequence),
    currentStatus: numberOrNull(vehicle.currentStatus),
    currentStopSequenceExplicit: Boolean(vehicle.currentStopSequenceExplicit),
    currentStatusExplicit: Boolean(vehicle.currentStatusExplicit)
  };
}

function makeObservation(raw, platform, nowSeconds, previousPattern, options) {
  const identity = exactIdentity(raw.trip);
  if (!identity) return null;
  const pattern = normalizedPattern(raw.stopUpdates);
  const targetUpdates = pattern.filter(stop => stop.stopId === platform);
  const targetUpdate = targetUpdates.length === 1 ? targetUpdates[0] : null;
  const role = serviceRole(
    pattern,
    previousPattern,
    platform,
    raw.vehicle,
    String(raw.originStopId || "")
  );
  const timestampSelection = selectTargetTimestamp(targetUpdate, role);
  const targetTime = numberOrNull(timestampSelection.selectedEventTime);
  const confidenceTargetTime = numberOrNull(targetUpdate?.confidenceTime);
  const rawCountdown = targetTime === null
    ? null
    : Math.round((targetTime - nowSeconds) / 60);
  const observation = {
    ...identity,
    routeId: String(raw.trip.routeId || ""),
    targetStop: platform,
    destination: String(raw.destination || ""),
    direction: String(raw.direction || ""),
    targetPresent: Boolean(targetUpdate),
    targetAmbiguous: targetUpdates.length > 1,
    targetTime,
    confidenceTargetTime,
    rawCountdown,
    pattern,
    previousPattern,
    serviceRole: role,
    arrivalTime: timestampSelection.arrivalTime,
    departureTime: timestampSelection.departureTime,
    dwellSeconds: timestampSelection.dwellSeconds,
    selectedEventType: timestampSelection.selectedEventType,
    selectedEventTime: timestampSelection.selectedEventTime,
    timestampSelectionReason: timestampSelection.timestampSelectionReason,
    staticOriginStop: String(raw.originStopId || ""),
    cancelled: Boolean(raw.cancelled),
    targetScheduleRelationship: numberOrNull(
      raw.stopUpdates?.find(stop => stop.stopId === platform)?.scheduleRelationship
    ),
    tripUpdatePresent: Boolean(raw.tripUpdatePresent),
    tripUpdateTimestamp: numberOrNull(raw.tripUpdateTimestamp),
    tripUpdateVehicleId: String(raw.tripUpdateVehicleId || ""),
    vehiclePositionMatched: raw.vehiclePositionMatched === undefined
      ? Boolean(raw.vehicle && !raw.vehicleAmbiguous)
      : Boolean(raw.vehiclePositionMatched),
    vehicle: raw.vehicle || null,
    vehicleAmbiguous: Boolean(raw.vehicleAmbiguous),
    feedTimestamp: numberOrNull(raw.feedTimestamp)
  };
  observation.vehicleEvidence = vehicleEvidence(observation, nowSeconds, options);
  return observation;
}

function createRecord(observation, nowMs) {
  return {
    identityKey: observation.identityKey,
    tripId: observation.tripId,
    startDate: observation.startDate,
    platformId: observation.targetStop,
    route: observation.routeId,
    destination: observation.destination,
    direction: observation.direction,
    serviceRole: observation.serviceRole,
    arrivalTime: observation.arrivalTime,
    departureTime: observation.departureTime,
    dwellSeconds: observation.dwellSeconds,
    selectedEventType: observation.selectedEventType,
    selectedEventTime: observation.selectedEventTime,
    timestampSelectionReason: observation.timestampSelectionReason,
    staticOriginStop: observation.staticOriginStop,
    movementState: MOVEMENT_STATES.OBSERVED,
    firstObservedAt: nowMs,
    lastObservedAt: nowMs,
    lastDistinctFeedTimestamp: null,
    lastTargetTime: null,
    preEntryMissingSnapshots: 0,
    lastPreEntryMissingFeedTimestamp: null,
    consecutiveTargetZeroSnapshots: 0,
    approachContinuityEstablished: false,
    freshVehicleContinuityEstablished: false,
    futureObservationConsecutiveSeenCount: 0,
    futureObservationFirstSeenAt: null,
    futureObservationLastArrivalTimestamp: null,
    futureObservationLastFeedTimestamp: null,
    futureObservationLastSeenAt: null,
    hasRecoveredFutureConfidence: false,
    admitted: false,
    departureLocked: false,
    departureLockedAt: null,
    originDepartureCustody: false,
    originDepartureCustodyAt: null,
    released: false,
    releaseReason: null,
    lastDisplayedCountdown: null,
    lastRawCountdown: null,
    lastPattern: [],
    lastRealtimePattern: [],
    history: []
  };
}

function appendHistory(record, event) {
  const history = [...record.history, event];
  return history.slice(-24);
}

function recoveredFutureConfidence(record, observation, nowMs, options) {
  if (!observation.targetPresent || observation.confidenceTargetTime === null ||
      !observation.tripUpdatePresent || !observation.tripId) return null;

  if (record.futureObservationLastSeenAt !== null &&
      nowMs - record.futureObservationLastSeenAt > options.futureObservationPurgeAgeMs) {
    record.futureObservationConsecutiveSeenCount = 0;
    record.futureObservationFirstSeenAt = null;
    record.futureObservationLastArrivalTimestamp = null;
    record.futureObservationLastFeedTimestamp = null;
    record.futureObservationLastSeenAt = null;
    record.hasRecoveredFutureConfidence = false;
  }

  const nowSeconds = Math.floor(nowMs / 1000);
  const countdown = Math.floor(
    (observation.confidenceTargetTime * 1000 - nowMs) / 60000
  );
  const priorRecoveryFresh = record.hasRecoveredFutureConfidence &&
    record.futureObservationLastSeenAt !== null &&
    nowMs - record.futureObservationLastSeenAt <= options.futureObservationPurgeAgeMs;

  if (countdown <= options.nearArrivalStrictWindowMinutes && !priorRecoveryFresh) {
    return null;
  }
  if (!timestampFresh(
    observation.feedTimestamp,
    nowSeconds,
    options.realtimeFeedFreshnessSeconds
  )) return null;
  if (observation.tripUpdateTimestamp !== null && !timestampFresh(
    observation.tripUpdateTimestamp,
    nowSeconds,
    options.realtimeFeedFreshnessSeconds
  )) return null;
  // A TripUpdate may retain a vehicle assignment while the corresponding
  // VehiclePosition is temporarily absent. That assignment is not, by itself,
  // evidence that a coherent future prediction is false. Near-arrival trips
  // still require exact VP or previously established recovery.
  if (!coherentStopTimeOrdering(observation.pattern)) {
    return null;
  }

  const lastSeenAt = record.futureObservationLastSeenAt;
  const lastArrival = record.futureObservationLastArrivalTimestamp;
  const stablePrediction = lastArrival === null ||
    Math.abs(observation.confidenceTargetTime - lastArrival) <=
      options.futureObservationMaxTimeShiftSeconds;
  const consecutive = lastSeenAt !== null &&
    nowMs - lastSeenAt <= options.futureObservationMaxAgeMs &&
    observation.feedTimestamp !== record.futureObservationLastFeedTimestamp &&
    stablePrediction;
  const sameFeed = lastSeenAt !== null &&
    record.futureObservationConsecutiveSeenCount > 0 &&
    observation.feedTimestamp === record.futureObservationLastFeedTimestamp;

  record.futureObservationConsecutiveSeenCount = consecutive
    ? record.futureObservationConsecutiveSeenCount + 1
    : sameFeed
      ? record.futureObservationConsecutiveSeenCount
      : 1;
  record.futureObservationFirstSeenAt ??= nowMs;
  record.futureObservationLastArrivalTimestamp = observation.confidenceTargetTime;
  record.futureObservationLastFeedTimestamp = observation.feedTimestamp;
  record.futureObservationLastSeenAt = nowMs;
  if (record.futureObservationConsecutiveSeenCount >= 2) {
    record.hasRecoveredFutureConfidence = true;
  }

  return record.hasRecoveredFutureConfidence
    ? DECISION_REASONS.RECOVERED_PERSISTENT_FUTURE
    : countdown > options.nearArrivalStrictWindowMinutes
      ? DECISION_REASONS.RECOVERED_FEED_CONSISTENT_FUTURE
      : null;
}

function updateRecord(previous, observation, nowMs, options) {
  const record = previous ? { ...previous } : createRecord(observation, nowMs);
  const wasDepartureLocked = Boolean(previous?.departureLocked);
  const hadOriginDepartureCustody = Boolean(previous?.originDepartureCustody);
  const distinctSnapshot = observation.feedTimestamp !== null &&
    observation.feedTimestamp !== record.lastDistinctFeedTimestamp;
  const vehicle = observation.vehicleEvidence;
  const countdown = observation.rawCountdown;
  let decisionReason = DECISION_REASONS.CURRENT_PREDICTION;

  record.route = observation.routeId || record.route;
  record.destination = observation.destination || record.destination;
  record.direction = observation.direction || record.direction;
  if (observation.serviceRole !== SERVICE_ROLES.UNRESOLVED) {
    record.serviceRole = observation.serviceRole;
  }
  record.arrivalTime = observation.arrivalTime;
  record.departureTime = observation.departureTime;
  record.dwellSeconds = observation.dwellSeconds;
  record.selectedEventType = observation.selectedEventType;
  record.selectedEventTime = observation.selectedEventTime;
  record.timestampSelectionReason = observation.timestampSelectionReason;
  const terminalOriginConfidence = observation.targetPresent &&
    observation.pattern[0]?.stopId === observation.targetStop;
  const recoveredConfidence = !observation.vehiclePositionMatched &&
    !terminalOriginConfidence
    ? recoveredFutureConfidence(record, observation, nowMs, options)
    : null;
  const orphanTripUpdate = !record.departureLocked &&
    observation.targetPresent && countdown !== null && countdown >= 0 &&
    !observation.vehiclePositionMatched && !terminalOriginConfidence &&
    !recoveredConfidence;
  record.lastObservedAt = nowMs;
  record.lastRawCountdown = countdown;
  if (observation.targetPresent && countdown !== null && countdown >= 0) {
    record.approachContinuityEstablished = true;
  }
  if (vehicle.present && vehicle.fresh) {
    record.freshVehicleContinuityEstablished = true;
  }
  const previousRealtimePattern = record.lastRealtimePattern || [];
  if (uniqueIndex(observation.pattern, observation.targetStop) !== null) {
    record.lastPattern = observation.pattern;
  }
  if (observation.pattern.length) record.lastRealtimePattern = observation.pattern;
  if (distinctSnapshot) record.lastDistinctFeedTimestamp = observation.feedTimestamp;
  if (observation.targetPresent && observation.targetTime !== null) {
    record.lastTargetTime = observation.targetTime;
    record.preEntryMissingSnapshots = 0;
    record.lastPreEntryMissingFeedTimestamp = null;
  } else if (!record.departureLocked && distinctSnapshot) {
    record.preEntryMissingSnapshots = (record.preEntryMissingSnapshots || 0) + 1;
    record.lastPreEntryMissingFeedTimestamp = observation.feedTimestamp;
  }

  const tripUpdateDownstream = distinctSnapshot &&
    tripUpdateProvesDownstream(observation, record.lastPattern);
  const tripUpdateProgressed = distinctSnapshot && observation.tripUpdatePresent &&
    tripUpdateSuffixAdvanced(
      previousRealtimePattern,
      observation.pattern,
      observation.targetStop
    );
  const freshVehicleStillAtTarget = vehicle.present && vehicle.fresh &&
    vehicle.position === "TARGET";
  const downstreamPatternOverridesTarget =
    (record.departureLocked || record.originDepartureCustody) &&
    options.downstreamProofMonitorEnabled &&
    freshVehicleStillAtTarget &&
    (tripUpdateDownstream || tripUpdateProgressed);

  if (observation.cancelled) {
    record.movementState = MOVEMENT_STATES.WITHDRAWN;
    record.released = true;
    record.releaseReason = DECISION_REASONS.EXPLICIT_TRIP_CANCELLED;
    record.departureLocked = false;
    record.originDepartureCustody = false;
    decisionReason = DECISION_REASONS.EXPLICIT_TRIP_CANCELLED;
  } else if (wasDepartureLocked && !vehicle.present) {
    // Experimental emergency key: once an exact identity is already in
    // departure custody, the first refresh without its exact VehiclePosition
    // releases it. A stale but still exact VehiclePosition remains present and
    // does not satisfy this rule.
    record.movementState = MOVEMENT_STATES.CONFIRMED_DOWNSTREAM;
    record.released = true;
    record.releaseReason = DECISION_REASONS.FIRST_MISSING_EXACT_VEHICLE_POSITION;
    record.departureLocked = false;
    decisionReason = DECISION_REASONS.FIRST_MISSING_EXACT_VEHICLE_POSITION;
  } else if (!record.departureLocked && [1, 2].includes(
    observation.targetScheduleRelationship
  )) {
    record.admitted = false;
    record.consecutiveTargetZeroSnapshots = 0;
    record.lastDisplayedCountdown = null;
    record.movementState = MOVEMENT_STATES.WITHDRAWN;
    decisionReason = DECISION_REASONS.SUPPRESSED_CANCELED_OR_NO_DATA;
  } else if (vehicle.present && vehicle.fresh && vehicle.position === "DOWNSTREAM") {
    record.movementState = MOVEMENT_STATES.CONFIRMED_DOWNSTREAM;
    record.released = true;
    record.releaseReason = DECISION_REASONS.EXACT_VEHICLE_DOWNSTREAM;
    record.departureLocked = false;
    record.originDepartureCustody = false;
    decisionReason = DECISION_REASONS.EXACT_VEHICLE_DOWNSTREAM;
  } else if (downstreamPatternOverridesTarget) {
    // Some realtime feeds lag VehiclePosition at the platform after the exact
    // TripUpdate has already advanced to an unambiguous downstream suffix.
    // This applies only to the same identity after it has entered departure
    // custody; target disappearance, time, and successor pressure are never
    // sufficient on their own.
    record.movementState = MOVEMENT_STATES.CONFIRMED_DOWNSTREAM;
    record.released = true;
    record.releaseReason = DECISION_REASONS.EXACT_DOWNSTREAM_PATTERN_OVERRIDES_TARGET;
    record.departureLocked = false;
    record.originDepartureCustody = false;
    decisionReason = DECISION_REASONS.EXACT_DOWNSTREAM_PATTERN_OVERRIDES_TARGET;
  } else if ((record.departureLocked || record.originDepartureCustody) &&
    tripUpdateDownstream && !freshVehicleStillAtTarget) {
    record.movementState = MOVEMENT_STATES.CONFIRMED_DOWNSTREAM;
    record.released = true;
    record.releaseReason = DECISION_REASONS.EXACT_TRIP_UPDATE_DOWNSTREAM;
    record.departureLocked = false;
    record.originDepartureCustody = false;
    decisionReason = DECISION_REASONS.EXACT_TRIP_UPDATE_DOWNSTREAM;
  } else if ((record.departureLocked || record.originDepartureCustody) &&
    tripUpdateProgressed && !freshVehicleStillAtTarget) {
    record.movementState = MOVEMENT_STATES.CONFIRMED_DOWNSTREAM;
    record.released = true;
    record.releaseReason = DECISION_REASONS.EXACT_TRIP_UPDATE_PROGRESSION;
    record.departureLocked = false;
    record.originDepartureCustody = false;
    decisionReason = DECISION_REASONS.EXACT_TRIP_UPDATE_PROGRESSION;
  } else if (orphanTripUpdate) {
    // The native classifier is transferred as a complete unit: current
    // VehiclePosition correlation, terminal-origin evidence, or validated
    // future recovery is required before a TripUpdate-only prediction reaches
    // the board.
    record.admitted = false;
    record.departureLocked = false;
    record.consecutiveTargetZeroSnapshots = 0;
    record.lastDisplayedCountdown = null;
    record.movementState = MOVEMENT_STATES.OBSERVED;
    decisionReason = DECISION_REASONS.SUPPRESSED_ORPHAN_TRIP_UPDATE;
  } else {
    const eligiblePrediction = observation.targetPresent && countdown !== null &&
      countdown <= options.boardWindowMinutes;
    if (eligiblePrediction && countdown >= 0) record.admitted = true;

    if (record.serviceRole === SERVICE_ROLES.ORIGIN_DEPARTURE) {
      record.departureLocked = false;
      record.consecutiveTargetZeroSnapshots = 0;
      const exactStoppedAtOrigin = vehicle.present && vehicle.fresh &&
        vehicle.position === "TARGET" &&
        vehicle.currentStatusExplicit && vehicle.currentStatus === 1;
      if (exactStoppedAtOrigin) {
        record.originDepartureCustody = true;
        record.originDepartureCustodyAt ??= nowMs;
        record.admitted = true;
        record.movementState = MOVEMENT_STATES.STOPPED_AT_TARGET;
        record.lastDisplayedCountdown = 0;
        decisionReason = DECISION_REASONS.ORIGIN_DEPARTURE_CUSTODY;
      } else if (record.originDepartureCustody) {
        // A scheduled clock and missing/stale position cannot prove that a
        // train physically observed at its origin has departed.
        record.admitted = true;
        record.movementState = MOVEMENT_STATES.DEPARTURE_UNCONFIRMED;
        record.lastDisplayedCountdown = 0;
        decisionReason = DECISION_REASONS.ORIGIN_DEPARTURE_HOLD;
      } else if (eligiblePrediction && countdown >= 0) {
        record.admitted = true;
        record.movementState = countdown <= 1
          ? MOVEMENT_STATES.APPROACHING
          : MOVEMENT_STATES.MOVING_UPSTREAM;
        record.lastDisplayedCountdown = Math.max(countdown, 1);
        decisionReason = recoveredConfidence ||
          DECISION_REASONS.ORIGIN_DEPARTURE_PREDICTION;
      } else {
        record.admitted = false;
        decisionReason = DECISION_REASONS.OUTSIDE_BOARD_WINDOW;
      }
    } else if (record.serviceRole === SERVICE_ROLES.TERMINAL_ARRIVAL) {
      record.departureLocked = false;
      record.consecutiveTargetZeroSnapshots = 0;
      const freshVehicleAtTerminal = vehicle.present && vehicle.fresh &&
        vehicle.position === "TARGET";
      const currentTerminalPrediction = observation.targetPresent &&
        countdown !== null && countdown >= 0 &&
        countdown <= options.boardWindowMinutes;
      if (freshVehicleAtTerminal || currentTerminalPrediction) {
        record.admitted = true;
        const atTerminal = freshVehicleAtTerminal;
        record.movementState = atTerminal
          ? MOVEMENT_STATES.STOPPED_AT_TARGET
          : countdown <= 1
            ? MOVEMENT_STATES.APPROACHING
            : MOVEMENT_STATES.MOVING_UPSTREAM;
        record.lastDisplayedCountdown = atTerminal ? 0 : Math.max(countdown, 1);
        decisionReason = recoveredConfidence ||
          DECISION_REASONS.TERMINAL_CURRENT_PREDICTION;
      } else {
        record.admitted = false;
        record.lastDisplayedCountdown = null;
        decisionReason = DECISION_REASONS.OUTSIDE_BOARD_WINDOW;
      }
    } else if (vehicle.present && vehicle.fresh && vehicle.position === "TARGET" &&
      vehicle.currentStatusExplicit && vehicle.currentStatus === 1) {
      record.movementState = MOVEMENT_STATES.STOPPED_AT_TARGET;
      record.departureLocked = true;
      record.admitted = true;
      record.lastDisplayedCountdown = 0;
      decisionReason = DECISION_REASONS.EXACT_STOPPED_AT_TARGET;
    } else if (observation.targetPresent && countdown !== null && countdown <= 0) {
      const predictionEntryEligible =
        record.approachContinuityEstablished &&
        record.freshVehicleContinuityEstablished &&
        !(vehicle.present && vehicle.fresh && vehicle.position === "UPSTREAM");
      if (distinctSnapshot && predictionEntryEligible) {
        record.consecutiveTargetZeroSnapshots += 1;
      } else if (!predictionEntryEligible) {
        record.consecutiveTargetZeroSnapshots = 0;
      }
      if (record.consecutiveTargetZeroSnapshots >= options.zeroConfirmationSnapshots) {
        record.movementState = MOVEMENT_STATES.STOPPED_AT_TARGET;
        record.departureLocked = true;
        record.admitted = true;
        record.lastDisplayedCountdown = 0;
        decisionReason = DECISION_REASONS.REPEATED_TARGET_ZERO;
      } else {
        record.movementState = MOVEMENT_STATES.ENTRY_UNCONFIRMED;
        record.lastDisplayedCountdown = 1;
        // A current zero prediction may remain visible at one while entry is
        // unresolved. Once that prediction is negative, lack of qualifying
        // exact movement continuity means uncertainty—not station entry—and
        // the identity must yield its board slot until current evidence returns.
        record.admitted = predictionEntryEligible || countdown === 0;
      }
    } else if (record.departureLocked) {
      record.movementState = MOVEMENT_STATES.DEPARTURE_UNCONFIRMED;
      record.lastDisplayedCountdown = 0;
      decisionReason = DECISION_REASONS.DEPARTURE_PROOF_HOLD;
    } else if (eligiblePrediction) {
      record.consecutiveTargetZeroSnapshots = 0;
      record.movementState = countdown <= 1
        ? MOVEMENT_STATES.APPROACHING
        : MOVEMENT_STATES.MOVING_UPSTREAM;
      record.lastDisplayedCountdown = Math.max(countdown, 1);
      decisionReason = recoveredConfidence || DECISION_REASONS.CURRENT_PREDICTION;
    } else if (record.admitted && record.lastDisplayedCountdown !== null &&
      record.lastDisplayedCountdown <= options.custodyWindowMinutes &&
      record.preEntryMissingSnapshots <= options.preEntryMissingSnapshotLimit &&
      record.lastTargetTime !== null &&
      nowMs <= record.lastTargetTime * 1000 + options.preEntryPredictionGraceSeconds * 1000) {
      decisionReason = DECISION_REASONS.PRE_ENTRY_CUSTODY;
    } else {
      record.admitted = false;
      decisionReason = DECISION_REASONS.OUTSIDE_BOARD_WINDOW;
    }
  }

  record.history = appendHistory(record, {
    observedAt: nowMs,
    feedTimestamp: observation.feedTimestamp,
    rawCountdown: countdown,
    displayedCountdown: record.lastDisplayedCountdown,
    targetPresent: observation.targetPresent,
    tripUpdatePresent: observation.tripUpdatePresent,
    vehicle: clone(vehicle),
    movementState: record.movementState,
    decisionReason
  });
  if (record.departureLocked && !wasDepartureLocked) record.departureLockedAt = nowMs;
  if (record.originDepartureCustody && !hadOriginDepartureCustody) {
    record.originDepartureCustodyAt = nowMs;
  }
  const corridor = describeDepartureCorridor(
    record.lastPattern,
    observation.targetStop
  );
  record.longhaulFallback = evaluateLonghaulDeparture({
    nowMs,
    lockedAt: record.departureLockedAt,
    departureLocked: record.departureLocked,
    corridor,
    vehicle,
    tripUpdatePresent: observation.tripUpdatePresent,
    targetPresent: observation.targetPresent,
    lastTargetTime: record.lastTargetTime
  });
  record.decisionReason = decisionReason;
  return record;
}

function arrivalFromRecord(record) {
  if (!record.admitted || record.released || record.lastDisplayedCountdown === null) return null;
  return {
    platformId: record.platformId,
    route: record.route,
    time: String(record.departureLocked ? 0 : record.lastDisplayedCountdown),
    station: record.destination,
    direction: record.direction,
    identityKey: record.identityKey,
    tripId: record.tripId,
    startDate: record.startDate,
    foreverEngineState: record.movementState,
    foreverEngineProtected: record.departureLocked ||
      record.originDepartureCustody ||
      record.decisionReason === DECISION_REASONS.PRE_ENTRY_CUSTODY,
    departureProofLocked: record.departureLocked,
    originDepartureCustody: record.originDepartureCustody
  };
}

function composeBoard(records, options) {
  const arrivals = records.map(arrivalFromRecord).filter(Boolean);
  const deduplicated = [...new Map(arrivals.map(item => [item.identityKey, item])).values()];
  deduplicated.sort((a, b) => Number(a.time) - Number(b.time) ||
    a.identityKey.localeCompare(b.identityKey));
  const protectedArrivals = deduplicated.filter(item => item.foreverEngineProtected);
  const ordinaryArrivals = deduplicated.filter(item => !item.foreverEngineProtected);
  const board = [...protectedArrivals];
  const routeCounts = Object.fromEntries(protectedArrivals.map(item => [
    item.route,
    protectedArrivals.filter(candidate => candidate.route === item.route).length
  ]));
  for (const arrival of ordinaryArrivals) {
    const count = routeCounts[arrival.route] || 0;
    if (count >= options.routeLimit) continue;
    board.push(arrival);
    routeCounts[arrival.route] = count + 1;
  }
  return board.sort((a, b) => Number(a.time) - Number(b.time) ||
    a.identityKey.localeCompare(b.identityKey));
}

export function createForeverEngine(configuration = {}) {
  const options = { ...DEFAULTS, ...configuration };
  const platforms = new Map();
  const platformFeedTimestamps = new Map();

  function resultFor(platform, records, observedAt, extra = {}) {
    const board = composeBoard(records, options);
    return {
      schemaVersion: 1,
      engine: "forever",
      platform,
      observedAt,
      arrivals: clone(board),
      diagnostics: {
        ...extra,
        active: clone(records.filter(record => record.admitted && !record.released)),
        suppressed: clone(records.filter(record =>
          !record.admitted && !record.released &&
          record.decisionReason === DECISION_REASONS.SUPPRESSED_ORPHAN_TRIP_UPDATE
        )),
        released: clone(records.filter(record => record.released)),
        counts: {
          registry: records.length,
          active: records.filter(record => record.admitted && !record.released).length,
          board: board.length
        }
      }
    };
  }

  function reconcile(snapshot = {}) {
    const nowMs = numberOrNull(snapshot.observedAt) ?? Date.now();
    const nowSeconds = Math.floor(nowMs / 1000);
    const platform = String(snapshot.platform || "");
    if (!platform) throw new Error("Forever Engine requires an exact platform");
    const registry = platforms.get(platform) || new Map();
    const incomingFeedTimestamp = numberOrNull(snapshot.feedTimestamp);
    const lastFeedTimestamp = platformFeedTimestamps.get(platform) ?? null;
    if (
      incomingFeedTimestamp !== null &&
      lastFeedTimestamp !== null &&
      incomingFeedTimestamp < lastFeedTimestamp
    ) {
      return resultFor(platform, [...registry.values()], nowMs, {
        staleSnapshotRejected: true,
        incomingFeedTimestamp,
        lastFeedTimestamp
      });
    }
    if (incomingFeedTimestamp !== null) {
      platformFeedTimestamps.set(
        platform,
        Math.max(lastFeedTimestamp ?? incomingFeedTimestamp, incomingFeedTimestamp)
      );
    }
    const rawByIdentity = new Map();
    const observations = new Map();
    for (const raw of snapshot.trips || []) {
      const identity = exactIdentity(raw.trip);
      if (identity) rawByIdentity.set(identity.identityKey, raw);
    }
    for (const [identityKey, raw] of rawByIdentity) {
      const previous = registry.get(identityKey);
      const observation = makeObservation(
        raw,
        platform,
        nowSeconds,
        previous?.lastPattern || [],
        options
      );
      if (!observation) continue;
      observations.set(identityKey, observation);
      registry.set(identityKey, updateRecord(previous, observation, nowMs, options));
    }
    for (const [identityKey, record] of registry) {
      if (rawByIdentity.has(identityKey) || record.released) continue;
      if (record.serviceRole === SERVICE_ROLES.ORIGIN_DEPARTURE &&
        record.originDepartureCustody) {
        const preserved = {
          ...record,
          admitted: true,
          departureLocked: false,
          released: false,
          movementState: MOVEMENT_STATES.DEPARTURE_UNCONFIRMED,
          decisionReason: DECISION_REASONS.ORIGIN_DEPARTURE_HOLD
        };
        preserved.history = appendHistory(preserved, {
          observedAt: nowMs,
          feedTimestamp: numberOrNull(snapshot.feedTimestamp),
          rawCountdown: null,
          displayedCountdown: 0,
          targetPresent: false,
          tripUpdatePresent: false,
          vehicle: { present: false, fresh: false, ageSeconds: null, position: "UNKNOWN" },
          movementState: preserved.movementState,
          decisionReason: preserved.decisionReason
        });
        registry.set(identityKey, preserved);
        continue;
      }
      if (
        record.serviceRole === SERVICE_ROLES.TERMINAL_ARRIVAL ||
        record.serviceRole === SERVICE_ROLES.ORIGIN_DEPARTURE
      ) {
        const completed = {
          ...record,
          admitted: false,
          departureLocked: false,
          originDepartureCustody: false,
          released: true,
          movementState: MOVEMENT_STATES.WITHDRAWN,
          releaseReason: DECISION_REASONS.TERMINAL_TRIP_COMPLETED,
          decisionReason: DECISION_REASONS.TERMINAL_TRIP_COMPLETED
        };
        completed.history = appendHistory(completed, {
          observedAt: nowMs,
          feedTimestamp: numberOrNull(snapshot.feedTimestamp),
          rawCountdown: null,
          displayedCountdown: completed.lastDisplayedCountdown,
          targetPresent: false,
          tripUpdatePresent: false,
          vehicle: { present: false, fresh: false, ageSeconds: null, position: "UNKNOWN" },
          movementState: completed.movementState,
          decisionReason: completed.decisionReason
        });
        registry.set(identityKey, completed);
        continue;
      }
      if (record.departureLocked) {
        const released = {
          ...record,
          admitted: false,
          departureLocked: false,
          released: true,
          movementState: MOVEMENT_STATES.CONFIRMED_DOWNSTREAM,
          releaseReason: DECISION_REASONS.FIRST_MISSING_EXACT_VEHICLE_POSITION,
          decisionReason: DECISION_REASONS.FIRST_MISSING_EXACT_VEHICLE_POSITION
        };
        released.history = appendHistory(released, {
          observedAt: nowMs,
          feedTimestamp: numberOrNull(snapshot.feedTimestamp),
          rawCountdown: null,
          displayedCountdown: released.lastDisplayedCountdown,
          targetPresent: false,
          tripUpdatePresent: false,
          vehicle: { present: false, fresh: false, ageSeconds: null, position: "UNKNOWN" },
          movementState: released.movementState,
          decisionReason: released.decisionReason
        });
        registry.set(identityKey, released);
        continue;
      }
      const missingFeedTimestamp = numberOrNull(snapshot.feedTimestamp);
      const missingSnapshotAdvanced = !record.departureLocked &&
        missingFeedTimestamp !== null &&
        missingFeedTimestamp !== record.lastPreEntryMissingFeedTimestamp;
      const preEntryMissingSnapshots = missingSnapshotAdvanced
        ? (record.preEntryMissingSnapshots || 0) + 1
        : (record.preEntryMissingSnapshots || 0);
      const preEntryCustodyEligible = record.admitted &&
        record.lastDisplayedCountdown !== null &&
        record.lastDisplayedCountdown <= options.custodyWindowMinutes &&
        preEntryMissingSnapshots <= options.preEntryMissingSnapshotLimit &&
        record.lastTargetTime !== null &&
        nowMs <= record.lastTargetTime * 1000 + options.preEntryPredictionGraceSeconds * 1000;
      const custodyEligible = record.departureLocked || preEntryCustodyEligible;
      const preserved = {
        ...record,
        preEntryMissingSnapshots,
        lastPreEntryMissingFeedTimestamp: missingSnapshotAdvanced
          ? missingFeedTimestamp
          : record.lastPreEntryMissingFeedTimestamp,
        admitted: custodyEligible,
        decisionReason: record.departureLocked
          ? DECISION_REASONS.DEPARTURE_PROOF_HOLD
          : custodyEligible
            ? DECISION_REASONS.PRE_ENTRY_CUSTODY
            : DECISION_REASONS.OUTSIDE_BOARD_WINDOW
      };
      preserved.longhaulFallback = evaluateLonghaulDeparture({
        nowMs,
        lockedAt: preserved.departureLockedAt,
        departureLocked: preserved.departureLocked,
        corridor: describeDepartureCorridor(
          preserved.lastPattern,
          preserved.platformId
        ),
        vehicle: { present: false, fresh: false, position: "UNKNOWN" },
        tripUpdatePresent: false,
        targetPresent: false,
        lastTargetTime: preserved.lastTargetTime
      });
      preserved.history = appendHistory(preserved, {
        observedAt: nowMs,
        feedTimestamp: numberOrNull(snapshot.feedTimestamp),
        rawCountdown: null,
        displayedCountdown: preserved.lastDisplayedCountdown,
        targetPresent: false,
        tripUpdatePresent: false,
        vehicle: { present: false, fresh: false, ageSeconds: null, position: "UNKNOWN" },
        movementState: preserved.movementState,
        decisionReason: preserved.decisionReason
      });
      registry.set(identityKey, preserved);
    }
    if (registry.size > options.maxRegistryRecords) {
      const removable = [...registry.values()]
        .filter(record => record.released || !record.admitted)
        .sort((a, b) => a.lastObservedAt - b.lastObservedAt);
      while (registry.size > options.maxRegistryRecords && removable.length) {
        registry.delete(removable.shift().identityKey);
      }
    }
    platforms.set(platform, registry);
    const records = [...registry.values()];
    return resultFor(platform, records, nowMs, {
      staleSnapshotRejected: false,
      incomingFeedTimestamp,
      lastFeedTimestamp: platformFeedTimestamps.get(platform) ?? null
    });
  }

  function inspect(platform = null) {
    const selected = platform
      ? [[platform, platforms.get(platform) || new Map()]]
      : [...platforms.entries()];
    return clone(Object.fromEntries(selected.map(([key, registry]) => [
      key,
      [...registry.values()]
    ])));
  }

  function clear() {
    platforms.clear();
    platformFeedTimestamps.clear();
  }

  return Object.freeze({ reconcile, inspect, clear, options: Object.freeze({ ...options }) });
}

export const __test = Object.freeze({ relativePosition, serviceRole, composeBoard, exactIdentity });
