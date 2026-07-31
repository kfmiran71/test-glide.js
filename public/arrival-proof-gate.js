import {
  COMPATIBILITY_CLASSIFICATIONS,
  conclusiveRealtimePattern,
  downstreamStopDecision,
  exactEvidenceIdentityMatches,
  freshExactVehicle,
  newerConclusivePattern,
  reconcileCompatibilityState,
  reconcileExactIdentityRoute,
  realtimeStoppingPattern,
  staticRealtimeSequenceMismatch
} from "./station-state-proof.js";

export const GATE_STATES = Object.freeze({
  PREARMED_AT_2: "PREARMED_AT_2",
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

function exactCurrentArrival(arrivals, identityKey) {
  return (arrivals || []).find(item =>
    item?.identityKey === identityKey &&
    item?.tripId &&
    Number.isFinite(finiteNumber(item.time))
  ) || null;
}

function exactTargetPredictionTimestamp(subject, evidence) {
  if (
    !exactEvidenceIdentityMatches(subject, evidence) ||
    !evidence?.tripUpdatePresent ||
    !evidence.targetStopPresent
  ) {
    return null;
  }
  const matches = (evidence.stopUpdates || []).filter(stop =>
    stop.stopId === subject.targetStop
  );
  if (matches.length !== 1) return null;
  return finiteNumber(matches[0].eventTime);
}

function retainedCountdown(targetTimestamp, nowMs) {
  const timestamp = finiteNumber(targetTimestamp);
  if (timestamp === null) return null;
  return Math.round((timestamp * 1000 - nowMs) / 60000);
}

function hasUsableTargetEvidence(arrival, evidence, stationStateProofEnabled) {
  if (
    !arrival?.identityKey ||
    !arrival.tripId ||
    !evidence?.tripUpdatePresent ||
    evidence.tripUpdateRouteAmbiguous ||
    evidence.routeIdMismatch ||
    !evidence.targetStop ||
    !evidence.targetStopPresent
  ) {
    return false;
  }
  return Boolean(
    finiteNumber(evidence.targetStopSequence) !== null ||
    (
      stationStateProofEnabled &&
      conclusiveRealtimePattern(arrival, evidence)
    )
  );
}

function legacyVehicleClassification(gate, evidence) {
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
    vehicle.stopId !== gate.targetStop &&
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

function adaptiveVehicleClassification(gate, evidence) {
  if (
    gate?.compatibilityState?.classification ===
      COMPATIBILITY_CLASSIFICATIONS.COMPATIBLE
  ) {
    const result = legacyVehicleClassification(gate, evidence);
    return {
      ...result,
      decision: {
        predicate: "ARRIVAL_PROOF_ENTRY",
        mode: "DEPLOYED_COMPATIBLE",
        compatibilityState: gate.compatibilityState,
        outcome:
          result.type === "ENTRY_CONFIRMED"
            ? "AFFIRMATIVE"
            : result.type === "DOWNSTREAM"
              ? "AFFIRMATIVE_DOWNSTREAM"
              : "UNKNOWN",
        reason:
          result.type === "ENTRY_CONFIRMED"
            ? "COMPATIBLE_DEPLOYED_ENTRY_PREDICATE"
            : result.type === "DOWNSTREAM"
              ? "COMPATIBLE_DEPLOYED_DOWNSTREAM_PREDICATE"
              : "COMPATIBLE_DEPLOYED_EVIDENCE_INSUFFICIENT"
      }
    };
  }
  const result = correctedVehicleClassification(gate, evidence);
  return {
    ...result,
    decision: {
      ...result.decision,
      mode: "STRICT_STATION_STATE_PROOF",
      compatibilityState: gate?.compatibilityState || null
    }
  };
}

function correctedVehicleClassification(gate, evidence) {
  const currentRealtimeStoppingPattern =
    realtimeStoppingPattern(evidence);
  const pattern =
    newerConclusivePattern(
      gate,
      evidence,
      gate.lastConclusiveStoppingPattern
    );
  const vehicle = freshExactVehicle(gate, evidence);
  const baseDecision = {
    predicate: "ARRIVAL_PROOF_ENTRY",
    currentRealtimeStoppingPattern,
    pattern,
    staticRealtimeSequenceMismatch:
      staticRealtimeSequenceMismatch(gate, evidence),
    evidenceRejectedAsAmbiguous:
      Boolean(evidence?.vehiclePositionAmbiguous) ||
      Boolean(
        currentRealtimeStoppingPattern &&
        !currentRealtimeStoppingPattern.targetUnique
      )
  };

  if (!exactEvidenceIdentityMatches(gate, evidence)) {
    return {
      type: "UNKNOWN",
      vehicle,
      decision: {
        ...baseDecision,
        outcome: "UNKNOWN",
        reason: "EXACT_IDENTITY_EVIDENCE_UNAVAILABLE"
      }
    };
  }
  if (!vehicle) {
    return {
      type: "UNKNOWN",
      vehicle,
      decision: {
        ...baseDecision,
        outcome: "UNKNOWN",
        reason: "FRESH_UNAMBIGUOUS_VEHICLE_UNAVAILABLE"
      }
    };
  }
  if (!currentRealtimeStoppingPattern?.targetUnique) {
    return {
      type: "UNKNOWN",
      vehicle,
      timestamp: vehicle.timestamp,
      decision: {
        ...baseDecision,
        outcome: "UNKNOWN",
        reason: "TARGET_OCCURRENCE_AMBIGUOUS"
      }
    };
  }
  if (!vehicle.currentStopSequenceExplicit) {
    return {
      type: "UNKNOWN",
      vehicle,
      timestamp: vehicle.timestamp,
      decision: {
        ...baseDecision,
        outcome: "UNKNOWN",
        reason: "CURRENT_STOP_SEQUENCE_NOT_EXPLICIT"
      }
    };
  }
  if (vehicle.stopId === gate.targetStop) {
    if (!vehicle.currentStatusExplicit) {
      return {
        type: "UNKNOWN",
        vehicle,
        timestamp: vehicle.timestamp,
        decision: {
          ...baseDecision,
          outcome: "UNKNOWN",
          reason: "CURRENT_STATUS_NOT_EXPLICIT"
        }
      };
    }
    if (vehicle.currentStatus === VEHICLE_STATUSES.STOPPED_AT) {
      return {
        type: "ENTRY_CONFIRMED",
        vehicle,
        timestamp: vehicle.timestamp,
        decision: {
          ...baseDecision,
          outcome: "AFFIRMATIVE",
          reason: "FRESH_EXACT_TARGET_STOPPED_AT"
        }
      };
    }
    return {
      type:
        vehicle.currentStatus === VEHICLE_STATUSES.INCOMING_AT
          ? "INCOMING_AT"
          : vehicle.currentStatus === VEHICLE_STATUSES.IN_TRANSIT_TO
            ? "IN_TRANSIT_TO"
            : "UNKNOWN",
      vehicle,
      timestamp: vehicle.timestamp,
      decision: {
        ...baseDecision,
        outcome: "NEGATIVE",
        reason:
          vehicle.currentStatus === VEHICLE_STATUSES.INCOMING_AT
            ? "INCOMING_AT_IS_APPROACH_EVIDENCE"
            : vehicle.currentStatus === VEHICLE_STATUSES.IN_TRANSIT_TO
              ? "IN_TRANSIT_TO_IS_APPROACH_EVIDENCE"
              : "STATUS_IS_NOT_STOPPED_AT"
      }
    };
  }

  if (!vehicle.currentStatusExplicit) {
    return {
      type: "UNKNOWN",
      vehicle,
      timestamp: vehicle.timestamp,
      decision: {
        ...baseDecision,
        outcome: "UNKNOWN",
        reason: "CURRENT_STATUS_NOT_EXPLICIT"
      }
    };
  }

  const downstream =
    downstreamStopDecision(pattern, vehicle.stopId);
  return {
    type: downstream.outcome === "AFFIRMATIVE" ? "DOWNSTREAM" : "UNKNOWN",
    vehicle,
    timestamp: vehicle.timestamp,
    decision: {
      ...baseDecision,
      ...downstream
    }
  };
}

export function initialArrivalProofGateState() {
  return cloneState(null);
}

export function reconcileArrivalProofGates(
  state,
  snapshot,
  nowMs,
  { stationStateProofEnabled = false } = {}
) {
  const next = cloneState(state);
  const evidenceByIdentity = new Map(
    (snapshot?.evidence || []).map(item => [item.identityKey, item])
  );

  for (const arrival of snapshot?.arrivals || []) {
    const evidence = evidenceByIdentity.get(arrival.identityKey);
    const rawCountdown = finiteNumber(arrival.time);
    const prearmEligible =
      stationStateProofEnabled &&
      rawCountdown !== null &&
      rawCountdown >= 0 &&
      rawCountdown <= 2;
    const prearmTargetTimestamp =
      prearmEligible && rawCountdown > 1
        ? exactTargetPredictionTimestamp(
            {
              identityKey: arrival.identityKey,
              tripId: arrival.tripId,
              startDate: arrival.startDate || "",
              targetStop: evidence?.targetStop
            },
            evidence
          )
        : null;
    const legacyGateEligible =
      rawCountdown !== null &&
      rawCountdown >= 0 &&
      rawCountdown <= 1;
    if (
      !next.active[arrival.identityKey] &&
      !next.tombstones[arrival.identityKey] &&
      !next.suppressionTombstones[arrival.identityKey] &&
      arrival.identityKey &&
      arrival.tripId &&
      (prearmEligible || legacyGateEligible) &&
      (
        !prearmEligible ||
        rawCountdown <= 1 ||
        prearmTargetTimestamp !== null
      ) &&
      hasUsableTargetEvidence(
        arrival,
        evidence,
        stationStateProofEnabled
      )
    ) {
      const initialState =
        prearmEligible && rawCountdown > 1
          ? GATE_STATES.PREARMED_AT_2
          : GATE_STATES.GATED_AT_ONE;
      const initialPattern =
        stationStateProofEnabled
          ? conclusiveRealtimePattern(arrival, evidence)
          : null;
      const targetPredictionTimestamp =
        prearmTargetTimestamp ??
        exactTargetPredictionTimestamp(
          {
            identityKey: arrival.identityKey,
            tripId: arrival.tripId,
            startDate: arrival.startDate || "",
            targetStop: evidence.targetStop
          },
          evidence
        );
      next.active[arrival.identityKey] = {
        identityKey: arrival.identityKey,
        tripId: arrival.tripId,
        startDate: arrival.startDate || "",
        route: arrival.route,
        platformId: arrival.platformId,
        targetStop: evidence.targetStop,
        targetStopSequence: finiteNumber(evidence.targetStopSequence),
        prearmedAt:
          initialState === GATE_STATES.PREARMED_AT_2
            ? new Date(nowMs).toISOString()
            : null,
        gatedAt:
          initialState === GATE_STATES.GATED_AT_ONE
            ? new Date(nowMs).toISOString()
            : null,
        rawComputedCountdown: rawCountdown,
        displayedCountdown:
          initialState === GATE_STATES.PREARMED_AT_2
            ? rawCountdown
            : 1,
        state: initialState,
        lastTransitionReason:
          initialState === GATE_STATES.PREARMED_AT_2
            ? "ADMITTED_CANDIDATE_PREARMED_AT_2"
            : "COUNTDOWN_REACHED_GATE",
        lastAcceptedTargetPredictionTimestamp:
          targetPredictionTimestamp,
        lastTripUpdateEvidence: evidence,
        latestVehiclePositionEvidence: evidence.vehicle || null,
        ...(stationStateProofEnabled
          ? {
              compatibilityState:
                reconcileCompatibilityState(null, evidence),
              lastConclusiveStoppingPattern:
                initialPattern,
              stationStateProofEnabled: true,
              entryDecision: null
            }
          : {}),
        lastVehicleTimestamp: null,
        transferredToDepartureProofLock: false,
        arrival: {
          ...arrival,
          time:
            initialState === GATE_STATES.PREARMED_AT_2
              ? String(rawCountdown)
              : "1",
          arrivalProofPrearmed:
            initialState === GATE_STATES.PREARMED_AT_2,
          arrivalProofGated:
            initialState === GATE_STATES.GATED_AT_ONE
        }
      };
    }
  }

  for (const [identityKey, gate] of Object.entries(next.active)) {
    const evidence = evidenceByIdentity.get(identityKey);
    const currentArrival =
      exactCurrentArrival(snapshot?.arrivals, identityKey);
    const currentCountdown =
      finiteNumber(currentArrival?.time);
    const currentNonnegative =
      currentCountdown !== null && currentCountdown >= 0;
    const candidateTargetTimestamp =
      currentNonnegative
        ? exactTargetPredictionTimestamp(gate, evidence)
        : null;
    const previousTargetTimestamp =
      finiteNumber(gate.lastAcceptedTargetPredictionTimestamp);
    const acceptedTargetTimestamp =
      candidateTargetTimestamp !== null &&
      (
        previousTargetTimestamp === null ||
        candidateTargetTimestamp > previousTargetTimestamp
      )
        ? candidateTargetTimestamp
        : previousTargetTimestamp;
    const retained =
      retainedCountdown(acceptedTargetTimestamp, nowMs);
    const shouldDisplayCurrentAboveGate =
      currentNonnegative && currentCountdown > 1;
    const nextState =
      shouldDisplayCurrentAboveGate
        ? GATE_STATES.PREARMED_AT_2
        : (
            currentNonnegative && currentCountdown <= 1
          ) || (
            !currentNonnegative &&
            retained !== null &&
            retained <= 1
          )
          ? GATE_STATES.GATED_AT_ONE
          : gate.state;
    const displayedCountdown =
      nextState === GATE_STATES.GATED_AT_ONE
        ? 1
        : currentNonnegative
          ? currentCountdown
          : retained !== null
            ? Math.max(2, retained)
            : finiteNumber(gate.displayedCountdown) ?? 2;
    const routeDecision =
      reconcileExactIdentityRoute(
        gate,
        evidence,
        snapshot?.arrivals || []
      );
    const compatibilityState =
      stationStateProofEnabled
        ? reconcileCompatibilityState(
            gate.compatibilityState,
            evidence
          )
        : null;
    const classification =
      stationStateProofEnabled
        ? adaptiveVehicleClassification(
            { ...gate, compatibilityState },
            evidence
          )
        : legacyVehicleClassification(gate, evidence);
    const updated = {
      ...gate,
      route: routeDecision.route,
      routeDecision,
      rawComputedCountdown:
        currentCountdown ?? gate.rawComputedCountdown,
      lastAcceptedTargetPredictionTimestamp:
        acceptedTargetTimestamp,
      lastTripUpdateEvidence: evidence?.tripUpdatePresent
        ? evidence
        : gate.lastTripUpdateEvidence,
      latestVehiclePositionEvidence: evidence?.vehiclePositionPresent
        ? evidence.vehicle
        : gate.latestVehiclePositionEvidence,
      ...(stationStateProofEnabled
        ? {
            lastConclusiveStoppingPattern:
              newerConclusivePattern(
                gate,
                evidence,
                gate.lastConclusiveStoppingPattern
              ),
            stationStateProofEnabled: true,
            compatibilityState,
            entryDecision: classification.decision
          }
        : {}),
      lastVehicleTimestamp:
        (
          nextState === GATE_STATES.GATED_AT_ONE ||
          classification.type === "DOWNSTREAM"
        )
          ? classification.timestamp ?? gate.lastVehicleTimestamp
          : gate.lastVehicleTimestamp
    };
    updated.arrival = {
      ...updated.arrival,
      ...(currentNonnegative ? currentArrival : {}),
      route: routeDecision.route,
      time: String(displayedCountdown),
      arrivalProofPrearmed:
        nextState === GATE_STATES.PREARMED_AT_2,
      arrivalProofGated:
        nextState === GATE_STATES.GATED_AT_ONE
    };

    if (
      nextState === GATE_STATES.GATED_AT_ONE &&
      classification.type === "ENTRY_CONFIRMED"
    ) {
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
          arrivalProofEntryConfirmed: true,
          stationStateCompatibility:
            updated.compatibilityState || null
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
      displayedCountdown,
      state: nextState,
      gatedAt:
        nextState === GATE_STATES.GATED_AT_ONE
          ? gate.gatedAt || new Date(nowMs).toISOString()
          : gate.gatedAt,
      lastTransitionReason:
        nextState === GATE_STATES.PREARMED_AT_2
          ? (
              currentNonnegative
                ? "PREARMED_CURRENT_PREDICTION"
                : "PREARMED_RETAINED_PREDICTION"
            )
          : classification.type === "INCOMING_AT"
            ? "INCOMING_AT_IS_APPROACH_EVIDENCE"
            : classification.type === "IN_TRANSIT_TO"
              ? "EXPLICIT_IN_TRANSIT_TO_TARGET"
              : "ENTRY_EVIDENCE_UNKNOWN",
      arrival: { ...updated.arrival }
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
      const aProtected =
        Boolean(a.arrivalProofGated) ||
        Boolean(a.arrivalProofPrearmed);
      const bProtected =
        Boolean(b.arrivalProofGated) ||
        Boolean(b.arrivalProofPrearmed);
      if (aProtected !== bProtected) {
        return aProtected ? -1 : 1;
      }
      return Number(a.time) - Number(b.time);
    });
    const protectedItems = routeItems.filter(item =>
      item.arrivalProofGated || item.arrivalProofPrearmed
    );
    const ordinary = routeItems.filter(item =>
      !item.arrivalProofGated && !item.arrivalProofPrearmed
    );
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

export function createArrivalProofDiagnostics(
  states,
  stationStateProofEnabled = true
) {
  return Object.freeze({
    inspect() {
      const combined = {
        enabled: true,
        ...(stationStateProofEnabled
          ? { stationStateProofEnabled: true }
          : {}),
        activeGates: [],
        confirmedEntries: [],
        bypassDispositions: [],
        tombstones: [],
        suppressed: [],
        suppressionTombstones: []
      };
      for (const state of states.values()) {
        const inspected = inspectArrivalProofState(state);
        for (const key of Object.keys(inspected)) {
          combined[key].push(...inspected[key]);
        }
      }
      return deepFreeze(combined);
    }
  });
}
