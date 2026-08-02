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
  PRE_ENTRY_CUSTODY: "PRE_ENTRY_CUSTODY",
  EXACT_STOPPED_AT_TARGET: "EXACT_STOPPED_AT_TARGET",
  REPEATED_TARGET_ZERO: "REPEATED_TARGET_ZERO",
  DEPARTURE_PROOF_HOLD: "DEPARTURE_PROOF_HOLD",
  EXACT_VEHICLE_DOWNSTREAM: "EXACT_VEHICLE_DOWNSTREAM",
  EXACT_TRIP_UPDATE_DOWNSTREAM: "EXACT_TRIP_UPDATE_DOWNSTREAM",
  EXACT_TRIP_UPDATE_PROGRESSION: "EXACT_TRIP_UPDATE_PROGRESSION",
  EXACT_DOWNSTREAM_PATTERN_OVERRIDES_TARGET: "EXACT_DOWNSTREAM_PATTERN_OVERRIDES_TARGET",
  EXPLICIT_TRIP_CANCELLED: "EXPLICIT_TRIP_CANCELLED",
  TERMINAL_CURRENT_PREDICTION: "TERMINAL_CURRENT_PREDICTION",
  TERMINAL_TRIP_COMPLETED: "TERMINAL_TRIP_COMPLETED",
  ORIGIN_DEPARTURE_PREDICTION: "ORIGIN_DEPARTURE_PREDICTION",
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
    realtimeIndex: index
  })).filter(stop => stop.stopId);
}

function serviceRole(pattern, previousPattern, targetStop, vehicle = null) {
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
  return SERVICE_ROLES.UNRESOLVED;
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
  const targetTime = numberOrNull(targetUpdate?.eventTime);
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
    rawCountdown,
    pattern,
    previousPattern,
    serviceRole: serviceRole(pattern, previousPattern, platform, raw.vehicle),
    cancelled: Boolean(raw.cancelled),
    tripUpdatePresent: Boolean(raw.tripUpdatePresent),
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
    admitted: false,
    departureLocked: false,
    departureLockedAt: null,
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

function updateRecord(previous, observation, nowMs, options) {
  const record = previous ? { ...previous } : createRecord(observation, nowMs);
  const wasDepartureLocked = Boolean(previous?.departureLocked);
  const distinctSnapshot = observation.feedTimestamp !== null &&
    observation.feedTimestamp !== record.lastDistinctFeedTimestamp;
  const vehicle = observation.vehicleEvidence;
  const countdown = observation.rawCountdown;
  let decisionReason = DECISION_REASONS.CURRENT_PREDICTION;

  record.route = observation.routeId || record.route;
  record.destination = observation.destination || record.destination;
  record.direction = observation.direction || record.direction;
  if (
    (!record.serviceRole || record.serviceRole === SERVICE_ROLES.UNRESOLVED) &&
    observation.serviceRole !== SERVICE_ROLES.UNRESOLVED
  ) {
    record.serviceRole = observation.serviceRole;
  }
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
  const downstreamPatternOverridesTarget = record.departureLocked &&
    options.downstreamProofMonitorEnabled &&
    freshVehicleStillAtTarget &&
    (tripUpdateDownstream || tripUpdateProgressed);

  if (observation.cancelled) {
    record.movementState = MOVEMENT_STATES.WITHDRAWN;
    record.released = true;
    record.releaseReason = DECISION_REASONS.EXPLICIT_TRIP_CANCELLED;
    record.departureLocked = false;
    decisionReason = DECISION_REASONS.EXPLICIT_TRIP_CANCELLED;
  } else if (vehicle.present && vehicle.fresh && vehicle.position === "DOWNSTREAM") {
    record.movementState = MOVEMENT_STATES.CONFIRMED_DOWNSTREAM;
    record.released = true;
    record.releaseReason = DECISION_REASONS.EXACT_VEHICLE_DOWNSTREAM;
    record.departureLocked = false;
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
    decisionReason = DECISION_REASONS.EXACT_DOWNSTREAM_PATTERN_OVERRIDES_TARGET;
  } else if (record.departureLocked && tripUpdateDownstream && !freshVehicleStillAtTarget) {
    record.movementState = MOVEMENT_STATES.CONFIRMED_DOWNSTREAM;
    record.released = true;
    record.releaseReason = DECISION_REASONS.EXACT_TRIP_UPDATE_DOWNSTREAM;
    record.departureLocked = false;
    decisionReason = DECISION_REASONS.EXACT_TRIP_UPDATE_DOWNSTREAM;
  } else if (record.departureLocked && tripUpdateProgressed && !freshVehicleStillAtTarget) {
    record.movementState = MOVEMENT_STATES.CONFIRMED_DOWNSTREAM;
    record.released = true;
    record.releaseReason = DECISION_REASONS.EXACT_TRIP_UPDATE_PROGRESSION;
    record.departureLocked = false;
    decisionReason = DECISION_REASONS.EXACT_TRIP_UPDATE_PROGRESSION;
  } else {
    const eligiblePrediction = observation.targetPresent && countdown !== null &&
      countdown <= options.boardWindowMinutes;
    if (eligiblePrediction && countdown >= 0) record.admitted = true;

    if (record.serviceRole === SERVICE_ROLES.ORIGIN_DEPARTURE) {
      record.departureLocked = false;
      record.consecutiveTargetZeroSnapshots = 0;
      if (eligiblePrediction && countdown >= 0) {
        record.admitted = true;
        record.movementState = countdown <= 1
          ? MOVEMENT_STATES.APPROACHING
          : MOVEMENT_STATES.MOVING_UPSTREAM;
        record.lastDisplayedCountdown = Math.max(countdown, 1);
        decisionReason = DECISION_REASONS.ORIGIN_DEPARTURE_PREDICTION;
      } else {
        record.admitted = false;
        decisionReason = DECISION_REASONS.OUTSIDE_BOARD_WINDOW;
      }
    } else if (record.serviceRole === SERVICE_ROLES.TERMINAL_ARRIVAL) {
      record.departureLocked = false;
      record.consecutiveTargetZeroSnapshots = 0;
      if (observation.targetPresent && countdown !== null && countdown <= options.boardWindowMinutes) {
        record.admitted = true;
        const atTerminal = countdown <= 0 ||
          vehicle.present && vehicle.fresh && vehicle.position === "TARGET";
        record.movementState = atTerminal
          ? MOVEMENT_STATES.STOPPED_AT_TARGET
          : countdown <= 1
            ? MOVEMENT_STATES.APPROACHING
            : MOVEMENT_STATES.MOVING_UPSTREAM;
        record.lastDisplayedCountdown = atTerminal ? 0 : Math.max(countdown, 1);
        decisionReason = DECISION_REASONS.TERMINAL_CURRENT_PREDICTION;
      } else {
        record.admitted = false;
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
      record.decisionReason === DECISION_REASONS.PRE_ENTRY_CUSTODY,
    departureProofLocked: record.departureLocked
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
      if (
        record.serviceRole === SERVICE_ROLES.TERMINAL_ARRIVAL ||
        record.serviceRole === SERVICE_ROLES.ORIGIN_DEPARTURE
      ) {
        const completed = {
          ...record,
          admitted: false,
          departureLocked: false,
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
