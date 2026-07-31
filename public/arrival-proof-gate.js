export const GATE_STATES = Object.freeze({
  GATED_AT_ONE: "GATED_AT_ONE",
  ENTRY_CONFIRMED: "ENTRY_CONFIRMED",
  BYPASSED_OR_DOWNSTREAM: "BYPASSED_OR_DOWNSTREAM",
  PLATFORM_UNAVAILABLE: "PLATFORM_UNAVAILABLE"
});

export const GATE_DISPOSITIONS = Object.freeze({
  TARGET_PASSED_WITHOUT_ENTRY_CONFIRMATION:
    "TARGET_PASSED_WITHOUT_ENTRY_CONFIRMATION",
  PLATFORM_UNAVAILABLE: "PLATFORM_UNAVAILABLE"
});

export const VEHICLE_STATUSES = Object.freeze({
  INCOMING_AT: 0,
  STOPPED_AT: 1,
  IN_TRANSIT_TO: 2
});

const VEHICLE_FRESHNESS_SECONDS = 120;

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function detachedCopy(value) {
  if (Array.isArray(value)) return value.map(detachedCopy);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, detachedCopy(nested)])
    );
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function cloneState(state) {
  return {
    active: { ...(state?.active || {}) },
    pendingConfirmed: {},
    confirmed: [...(state?.confirmed || [])],
    bypassed: [...(state?.bypassed || [])],
    tombstones: { ...(state?.tombstones || {}) },
    suppressed: [...(state?.suppressed || [])],
    suppressionTombstones: { ...(state?.suppressionTombstones || {}) }
  };
}

function evidenceIsFresh(evidence, vehicle) {
  const feedTimestamp = finiteNumber(evidence?.feedTimestamp);
  const vehicleTimestamp = finiteNumber(vehicle?.timestamp);
  if (
    !evidence?.feedSucceeded ||
    evidence?.feedStale ||
    feedTimestamp === null ||
    vehicleTimestamp === null
  ) {
    return false;
  }
  const age = feedTimestamp - vehicleTimestamp;
  return age >= -15 && age <= VEHICLE_FRESHNESS_SECONDS;
}

function vehicleClassification(gate, evidence) {
  const vehicle = evidence?.vehicle;
  if (
    !evidence?.vehiclePositionPresent ||
    evidence?.vehiclePositionAmbiguous ||
    !vehicle ||
    !evidenceIsFresh(evidence, vehicle)
  ) {
    return { type: "UNKNOWN", vehicle };
  }
  const timestamp = finiteNumber(vehicle.timestamp);
  if (
    timestamp === null ||
    timestamp <= finiteNumber(gate.lastVehicleTimestamp)
  ) {
    return { type: "UNKNOWN", vehicle };
  }
  const sequence = finiteNumber(vehicle.currentStopSequence);
  if (
    vehicle.currentStopSequenceExplicit &&
    sequence !== null &&
    sequence > gate.targetStopSequence
  ) {
    return { type: "DOWNSTREAM", vehicle, timestamp };
  }
  const exactTarget =
    vehicle.stopId === gate.targetStop &&
    vehicle.currentStopSequenceExplicit &&
    sequence === gate.targetStopSequence;
  if (
    exactTarget &&
    vehicle.currentStatusExplicit &&
    (
      vehicle.currentStatus === VEHICLE_STATUSES.INCOMING_AT ||
      vehicle.currentStatus === VEHICLE_STATUSES.STOPPED_AT
    )
  ) {
    return { type: "ENTRY_CONFIRMED", vehicle, timestamp };
  }
  if (
    exactTarget &&
    vehicle.currentStatusExplicit &&
    vehicle.currentStatus === VEHICLE_STATUSES.IN_TRANSIT_TO
  ) {
    return { type: "IN_TRANSIT_TO", vehicle, timestamp };
  }
  return { type: "UNKNOWN", vehicle, timestamp };
}

export function initialArrivalProofGateState() {
  return cloneState(null);
}

export function reconcileArrivalProofGates(state, snapshot, nowMs) {
  const next = cloneState(state);
  const evidenceByIdentity = new Map(
    (snapshot?.evidence || []).map(item => [item.identityKey, item])
  );

  for (const arrival of snapshot?.arrivals || []) {
    const evidence = evidenceByIdentity.get(arrival.identityKey);
    if (
      !next.active[arrival.identityKey] &&
      !next.tombstones[arrival.identityKey] &&
      !next.suppressionTombstones[arrival.identityKey] &&
      arrival.identityKey &&
      arrival.tripId &&
      Number(arrival.time) >= 0 &&
      Number(arrival.time) <= 1 &&
      evidence?.tripUpdatePresent &&
      evidence.targetStopPresent &&
      finiteNumber(evidence.targetStopSequence) !== null
    ) {
      next.active[arrival.identityKey] = {
        identityKey: arrival.identityKey,
        tripId: arrival.tripId,
        startDate: arrival.startDate || "",
        route: arrival.route,
        platformId: arrival.platformId,
        targetStop: evidence.targetStop,
        targetStopSequence: finiteNumber(evidence.targetStopSequence),
        gatedAt: new Date(nowMs).toISOString(),
        rawComputedCountdown: Number(arrival.time),
        displayedCountdown: 1,
        state: GATE_STATES.GATED_AT_ONE,
        lastTransitionReason: "COUNTDOWN_REACHED_GATE",
        lastTripUpdateEvidence: evidence,
        latestVehiclePositionEvidence: evidence.vehicle || null,
        lastVehicleTimestamp: null,
        transferredToDepartureProofLock: false,
        arrival: { ...arrival, time: "1", arrivalProofGated: true }
      };
    }
  }

  for (const [identityKey, gate] of Object.entries(next.active)) {
    const evidence = evidenceByIdentity.get(identityKey);
    const classification = vehicleClassification(gate, evidence);
    const updated = {
      ...gate,
      rawComputedCountdown:
        finiteNumber(
          (snapshot?.arrivals || [])
            .find(item => item.identityKey === identityKey)?.time
        ) ?? gate.rawComputedCountdown,
      lastTripUpdateEvidence: evidence?.tripUpdatePresent
        ? evidence
        : gate.lastTripUpdateEvidence,
      latestVehiclePositionEvidence: evidence?.vehiclePositionPresent
        ? evidence.vehicle
        : gate.latestVehiclePositionEvidence,
      lastVehicleTimestamp:
        classification.timestamp ?? gate.lastVehicleTimestamp
    };

    if (classification.type === "ENTRY_CONFIRMED") {
      const confirmed = {
        ...updated,
        state: GATE_STATES.ENTRY_CONFIRMED,
        displayedCountdown: 0,
        confirmedAt: new Date(nowMs).toISOString(),
        lastTransitionReason: "EXACT_TARGET_VEHICLE_ENTRY_CONFIRMED",
        transferredToDepartureProofLock: true,
        arrival: {
          ...updated.arrival,
          time: "0",
          arrivalProofGated: false,
          arrivalProofEntryConfirmed: true
        }
      };
      next.confirmed.push(confirmed);
      next.pendingConfirmed[identityKey] = confirmed;
      next.tombstones[identityKey] = {
        identityKey,
        disposition: GATE_STATES.ENTRY_CONFIRMED,
        at: confirmed.confirmedAt
      };
      delete next.active[identityKey];
      continue;
    }

    if (classification.type === "DOWNSTREAM") {
      const bypassed = {
        ...updated,
        state: GATE_STATES.BYPASSED_OR_DOWNSTREAM,
        disposition:
          GATE_DISPOSITIONS.TARGET_PASSED_WITHOUT_ENTRY_CONFIRMATION,
        bypassedAt: new Date(nowMs).toISOString(),
        lastTransitionReason:
          GATE_DISPOSITIONS.TARGET_PASSED_WITHOUT_ENTRY_CONFIRMATION
      };
      next.bypassed.push(bypassed);
      next.tombstones[identityKey] = {
        identityKey,
        disposition: bypassed.disposition,
        at: bypassed.bypassedAt
      };
      delete next.active[identityKey];
      continue;
    }

    next.active[identityKey] = {
      ...updated,
      displayedCountdown: 1,
      state: GATE_STATES.GATED_AT_ONE,
      lastTransitionReason:
        classification.type === "IN_TRANSIT_TO"
          ? "EXPLICIT_IN_TRANSIT_TO_TARGET"
          : "ENTRY_EVIDENCE_UNKNOWN",
      arrival: { ...updated.arrival, time: "1", arrivalProofGated: true }
    };
  }
  return next;
}

export function suppressArrivalProofGates(state, platformEvidence, nowMs) {
  const next = cloneState(state);
  for (const [identityKey, gate] of Object.entries(next.active)) {
    const match = (platformEvidence || []).find(item =>
      item.suppressionApplied &&
      item.route === gate.route &&
      item.resolvedPlatform === gate.platformId
    );
    if (!match) continue;
    const suppressedAt = new Date(nowMs).toISOString();
    const suppressed = {
      ...gate,
      state: GATE_STATES.PLATFORM_UNAVAILABLE,
      disposition: GATE_DISPOSITIONS.PLATFORM_UNAVAILABLE,
      suppressedAt,
      platformEvidence: match
    };
    next.suppressed.push(suppressed);
    next.suppressionTombstones[identityKey] = {
      identityKey,
      disposition: GATE_DISPOSITIONS.PLATFORM_UNAVAILABLE,
      at: suppressedAt
    };
    delete next.active[identityKey];
  }
  return next;
}

export function arrivalProofBoardArrivals(state, arrivals) {
  const byIdentity = new Map(
    (arrivals || [])
      .filter(item => Number(item.time) > 1)
      .map(item => [item.identityKey, { ...item }])
  );
  for (const gate of Object.values(state?.active || {})) {
    byIdentity.set(gate.identityKey, { ...gate.arrival });
  }
  for (const confirmed of Object.values(state?.pendingConfirmed || {})) {
    byIdentity.set(confirmed.identityKey, { ...confirmed.arrival });
  }
  const byRoute = new Map();
  for (const item of byIdentity.values()) {
    if (!byRoute.has(item.route)) byRoute.set(item.route, []);
    byRoute.get(item.route).push(item);
  }
  const output = [];
  for (const routeItems of byRoute.values()) {
    routeItems.sort((a, b) => {
      if (Boolean(a.arrivalProofGated) !== Boolean(b.arrivalProofGated)) {
        return a.arrivalProofGated ? -1 : 1;
      }
      return Number(a.time) - Number(b.time);
    });
    const protectedItems = routeItems.filter(item => item.arrivalProofGated);
    const ordinary = routeItems.filter(item => !item.arrivalProofGated);
    output.push(
      ...protectedItems,
      ...ordinary.slice(0, Math.max(0, 3 - protectedItems.length))
    );
  }
  return output.sort((a, b) => Number(a.time) - Number(b.time));
}

export function inspectArrivalProofState(state) {
  return deepFreeze(detachedCopy({
    activeGates: Object.values(state?.active || {}),
    confirmedEntries: state?.confirmed || [],
    bypassDispositions: state?.bypassed || [],
    tombstones: Object.values(state?.tombstones || {}),
    suppressed: state?.suppressed || [],
    suppressionTombstones:
      Object.values(state?.suppressionTombstones || {})
  }));
}

export function createArrivalProofDiagnostics(states) {
  return Object.freeze({
    inspect() {
      const combined = {
        enabled: true,
        activeGates: [],
        confirmedEntries: [],
        bypassDispositions: [],
        tombstones: [],
        suppressed: [],
        suppressionTombstones: []
      };
      for (const state of states.values()) {
        const inspected = inspectArrivalProofState(state);
        for (const key of Object.keys(combined)) {
          if (key !== "enabled") combined[key].push(...inspected[key]);
        }
      }
      return deepFreeze(combined);
    }
  });
}
