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
  EXPLICIT_TRIP_CANCELLED: "EXPLICIT_TRIP_CANCELLED",
  OUTSIDE_BOARD_WINDOW: "OUTSIDE_BOARD_WINDOW"
});

const DEFAULTS = Object.freeze({
  boardWindowMinutes: 60,
  custodyWindowMinutes: 10,
  vehicleFreshSeconds: 90,
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

function vehicleEvidence(observation, nowSeconds, options) {
  const vehicle = observation.vehicle;
  if (!vehicle || observation.vehicleAmbiguous) {
    return { present: false, fresh: false, ageSeconds: null, position: "UNKNOWN" };
  }
  const timestamp = numberOrNull(vehicle.timestamp);
  const ageSeconds = timestamp === null ? null : Math.max(0, nowSeconds - timestamp);
  const fresh = ageSeconds !== null && ageSeconds <= options.vehicleFreshSeconds;
  const pattern = observation.pattern.length
    ? observation.pattern
    : observation.previousPattern || [];
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
    movementState: MOVEMENT_STATES.OBSERVED,
    firstObservedAt: nowMs,
    lastObservedAt: nowMs,
    lastDistinctFeedTimestamp: null,
    consecutiveTargetZeroSnapshots: 0,
    admitted: false,
    departureLocked: false,
    released: false,
    releaseReason: null,
    lastDisplayedCountdown: null,
    lastRawCountdown: null,
    lastPattern: [],
    history: []
  };
}

function appendHistory(record, event) {
  const history = [...record.history, event];
  return history.slice(-24);
}

function updateRecord(previous, observation, nowMs, options) {
  const record = previous ? { ...previous } : createRecord(observation, nowMs);
  const distinctSnapshot = observation.feedTimestamp !== null &&
    observation.feedTimestamp !== record.lastDistinctFeedTimestamp;
  const vehicle = observation.vehicleEvidence;
  const countdown = observation.rawCountdown;
  let decisionReason = DECISION_REASONS.CURRENT_PREDICTION;

  record.route = observation.routeId || record.route;
  record.destination = observation.destination || record.destination;
  record.direction = observation.direction || record.direction;
  record.lastObservedAt = nowMs;
  record.lastRawCountdown = countdown;
  if (observation.pattern.length) record.lastPattern = observation.pattern;
  if (distinctSnapshot) record.lastDistinctFeedTimestamp = observation.feedTimestamp;

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
  } else {
    const eligiblePrediction = observation.targetPresent && countdown !== null &&
      countdown <= options.boardWindowMinutes;
    if (eligiblePrediction && countdown >= 0) record.admitted = true;

    if (vehicle.present && vehicle.fresh && vehicle.position === "TARGET" &&
      vehicle.currentStatusExplicit && vehicle.currentStatus === 1) {
      record.movementState = MOVEMENT_STATES.STOPPED_AT_TARGET;
      record.departureLocked = true;
      record.admitted = true;
      record.lastDisplayedCountdown = 0;
      decisionReason = DECISION_REASONS.EXACT_STOPPED_AT_TARGET;
    } else if (observation.targetPresent && countdown !== null && countdown <= 0) {
      if (distinctSnapshot) record.consecutiveTargetZeroSnapshots += 1;
      if (record.consecutiveTargetZeroSnapshots >= options.zeroConfirmationSnapshots) {
        record.movementState = MOVEMENT_STATES.STOPPED_AT_TARGET;
        record.departureLocked = true;
        record.admitted = true;
        record.lastDisplayedCountdown = 0;
        decisionReason = DECISION_REASONS.REPEATED_TARGET_ZERO;
      } else {
        record.movementState = MOVEMENT_STATES.ENTRY_UNCONFIRMED;
        record.lastDisplayedCountdown = 1;
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
      record.lastDisplayedCountdown <= options.custodyWindowMinutes) {
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
      registry.set(identityKey, updateRecord(previous, observation, nowMs, options));
    }
    for (const [identityKey, record] of registry) {
      if (rawByIdentity.has(identityKey) || record.released) continue;
      const custodyEligible = record.departureLocked ||
        record.admitted && record.lastDisplayedCountdown !== null &&
        record.lastDisplayedCountdown <= options.custodyWindowMinutes;
      const preserved = {
        ...record,
        admitted: custodyEligible,
        decisionReason: record.departureLocked
          ? DECISION_REASONS.DEPARTURE_PROOF_HOLD
          : custodyEligible
            ? DECISION_REASONS.PRE_ENTRY_CUSTODY
            : DECISION_REASONS.OUTSIDE_BOARD_WINDOW
      };
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

export const __test = Object.freeze({ relativePosition, composeBoard, exactIdentity });
