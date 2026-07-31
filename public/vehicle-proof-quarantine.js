export const VEHICLE_PROOF_QUARANTINE_REASON =
  "NEAR_ARRIVAL_WITHOUT_FRESH_EXACT_VEHICLE";

export const VEHICLE_PROOF_ADMISSION_REASONS = Object.freeze({
  OUTSIDE_QUARANTINE_WINDOW: "OUTSIDE_QUARANTINE_WINDOW",
  CURRENT_FRESH_EXACT_VEHICLE: "CURRENT_FRESH_EXACT_VEHICLE",
  HISTORICAL_FRESH_EXACT_VEHICLE: "HISTORICAL_FRESH_EXACT_VEHICLE"
});

export const VEHICLE_PROOF_WINDOW_MINUTES = 5;
export const VEHICLE_FRESHNESS_SECONDS = 120;

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
    everFresh: { ...(state?.everFresh || {}) },
    admitted: { ...(state?.admitted || {}) },
    quarantined: { ...(state?.quarantined || {}) },
    currentDisposition: { ...(state?.currentDisposition || {}) },
    transitions: [...(state?.transitions || [])]
  };
}

function exactIdentityMatchesEvidence(arrival, evidence) {
  return Boolean(
    arrival?.identityKey &&
    arrival.identityKey === evidence?.identityKey &&
    arrival.tripId &&
    arrival.tripId === evidence?.tripId &&
    String(arrival.startDate || "") === String(evidence?.startDate || "")
  );
}

export function hasFreshQualifyingVehicle(evidence) {
  const timestamp = finiteNumber(evidence?.vehicle?.timestamp);
  const age = finiteNumber(evidence?.vehicleAgeSeconds);
  return Boolean(
    evidence?.vehiclePositionPresent &&
    !evidence?.vehiclePositionAmbiguous &&
    !evidence?.tripUpdateRouteAmbiguous &&
    !evidence?.routeIdMismatch &&
    evidence?.vehicle &&
    timestamp !== null &&
    age !== null &&
    age >= 0 &&
    age <= VEHICLE_FRESHNESS_SECONDS &&
    evidence?.feedSucceeded &&
    !evidence?.feedStale
  );
}

export function initialVehicleProofQuarantineState() {
  return cloneState(null);
}

function transitionRecord(
  identityKey,
  previous,
  current,
  reason,
  arrival,
  evidence,
  nowMs
) {
  return {
    identityKey,
    from: previous || null,
    to: current,
    reason,
    at: new Date(nowMs).toISOString(),
    rawCountdown: finiteNumber(arrival?.time),
    evidence: evidence || null
  };
}

export function reconcileVehicleProofQuarantine(state, snapshot, nowMs) {
  const next = cloneState(state);
  const evidenceByIdentity = new Map(
    (snapshot?.evidence || []).map(evidence => [evidence.identityKey, evidence])
  );
  const admitted = {};
  const quarantined = {};
  const currentDisposition = {};

  const arrivalsByIdentity = new Map();
  for (const arrival of snapshot?.arrivals || []) {
    if (!arrival?.identityKey) continue;
    if (!arrivalsByIdentity.has(arrival.identityKey)) {
      arrivalsByIdentity.set(arrival.identityKey, []);
    }
    arrivalsByIdentity.get(arrival.identityKey).push(arrival);
  }

  for (const identityArrivals of arrivalsByIdentity.values()) {
    const observedRoutes = [
      ...new Set(
        identityArrivals
          .map(arrival => String(arrival.route || ""))
          .filter(Boolean)
      )
    ].sort();
    const previousRecord =
      next.admitted[identityArrivals[0].identityKey] ||
      next.quarantined[identityArrivals[0].identityKey];
    const routeAmbiguous = observedRoutes.length > 1;
    const selectedRoute =
      routeAmbiguous
        ? String(previousRecord?.route || observedRoutes[0] || "")
        : observedRoutes[0] || "";
    const arrival = {
      ...identityArrivals[0],
      route: selectedRoute
    };
    const countdown = finiteNumber(arrival.time);
    if (countdown === null || countdown < 0) continue;

    const evidence = evidenceByIdentity.get(arrival.identityKey);
    const currentFresh =
      !routeAmbiguous &&
      exactIdentityMatchesEvidence(arrival, evidence) &&
      hasFreshQualifyingVehicle(evidence);

    if (currentFresh) {
      next.everFresh[arrival.identityKey] = {
        identityKey: arrival.identityKey,
        tripId: arrival.tripId,
        startDate: arrival.startDate || "",
        firstObservedAt:
          next.everFresh[arrival.identityKey]?.firstObservedAt ||
          new Date(nowMs).toISOString(),
        latestObservedAt: new Date(nowMs).toISOString(),
        latestEvidence: evidence
      };
    }

    const previouslyFresh = Boolean(next.everFresh[arrival.identityKey]);
    const outsideWindow = countdown > VEHICLE_PROOF_WINDOW_MINUTES;
    const isAdmitted = outsideWindow || currentFresh || previouslyFresh;
    const reason = outsideWindow
      ? VEHICLE_PROOF_ADMISSION_REASONS.OUTSIDE_QUARANTINE_WINDOW
      : currentFresh
        ? VEHICLE_PROOF_ADMISSION_REASONS.CURRENT_FRESH_EXACT_VEHICLE
        : previouslyFresh
          ? VEHICLE_PROOF_ADMISSION_REASONS.HISTORICAL_FRESH_EXACT_VEHICLE
          : VEHICLE_PROOF_QUARANTINE_REASON;
    const disposition = isAdmitted ? "ADMITTED" : "QUARANTINED";
    const record = {
      identityKey: arrival.identityKey,
      tripId: arrival.tripId,
      startDate: arrival.startDate || "",
      route: arrival.route,
      routeAmbiguous,
      observedRoutes,
      platformId: arrival.platformId,
      rawCountdown: countdown,
      disposition,
      reason,
      currentFreshVehicle: currentFresh,
      previouslyFreshVehicle: previouslyFresh,
      evidence: evidence || null,
      arrival: { ...arrival }
    };

    if (isAdmitted) admitted[arrival.identityKey] = record;
    else quarantined[arrival.identityKey] = record;
    currentDisposition[arrival.identityKey] = disposition;

    if (next.currentDisposition[arrival.identityKey] !== disposition) {
      next.transitions.push(
        transitionRecord(
          arrival.identityKey,
          next.currentDisposition[arrival.identityKey],
          disposition,
          reason,
          arrival,
          evidence,
          nowMs
        )
      );
    }
  }

  return {
    ...next,
    admitted,
    quarantined,
    currentDisposition
  };
}

export function vehicleProofCandidateArrivals(state) {
  return Object.values(state?.admitted || {}).map(record => ({
    ...record.arrival
  }));
}

export function inspectVehicleProofQuarantineState(state) {
  return deepFreeze(detachedCopy({
    everFreshIdentities: Object.values(state?.everFresh || {}),
    admittedIdentities: Object.values(state?.admitted || {}),
    quarantinedIdentities: Object.values(state?.quarantined || {}),
    transitions: state?.transitions || []
  }));
}

export function createVehicleProofQuarantineDiagnostics(states) {
  return Object.freeze({
    inspect() {
      const combined = {
        enabled: true,
        everFreshIdentities: [],
        admittedIdentities: [],
        quarantinedIdentities: [],
        transitions: []
      };
      for (const state of states.values()) {
        const inspected = inspectVehicleProofQuarantineState(state);
        for (const key of Object.keys(combined)) {
          if (key !== "enabled") combined[key].push(...inspected[key]);
        }
      }
      return deepFreeze(combined);
    }
  });
}
