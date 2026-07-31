import {
  downstreamStopDecision,
  exactEvidenceIdentityMatches,
  freshExactVehicle,
  newerConclusivePattern,
  realtimeStoppingPattern,
  staticRealtimeSequenceMismatch
} from "./station-state-proof.js";

export const RELEASE_REASONS = Object.freeze({
  VEHICLE_DOWNSTREAM: "VEHICLE_DOWNSTREAM",
  TRIP_UPDATE_DOWNSTREAM: "TRIP_UPDATE_DOWNSTREAM",
  TARGET_STOP_REMOVED_WITH_DOWNSTREAM_EVIDENCE:
    "TARGET_STOP_REMOVED_WITH_DOWNSTREAM_EVIDENCE"
});

function numberValue(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "object" && typeof value.toNumber === "function") {
    return value.toNumber();
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function eventSeconds(update) {
  return numberValue(
    update?.departure?.time ??
    update?.arrival?.time
  );
}

export function exactTripIdentity(descriptor = {}) {
  const tripId = String(descriptor.tripId || "").trim();
  if (!tripId) return null;
  const startDate = String(descriptor.startDate || "").trim();
  return {
    identityKey: `${tripId}|${startDate}`,
    tripId,
    startDate
  };
}

function normalizeStopUpdate(update = {}) {
  const sequenceExplicit =
    Object.prototype.hasOwnProperty.call(update, "stopSequence");
  return {
    stopId: String(update.stopId || ""),
    stopSequence: sequenceExplicit
      ? numberValue(update.stopSequence)
      : null,
    stopSequenceExplicit: sequenceExplicit,
    eventTime: eventSeconds(update)
  };
}

export function buildGtfsEvidence(
  entities,
  targetStop,
  feedTimestamp,
  resolveTargetStopSequence = () => null
) {
  const tripUpdates = new Map();
  const vehicles = new Map();

  for (const entity of entities || []) {
    if (entity.tripUpdate) {
      const identity = exactTripIdentity(entity.tripUpdate.trip);
      if (identity) {
        tripUpdates.set(identity.identityKey, {
          identity,
          trip: entity.tripUpdate.trip,
          progressionStopSequence:
            Object.prototype.hasOwnProperty.call(
              entity.tripUpdate,
              "currentStopSequence"
            )
              ? numberValue(entity.tripUpdate.currentStopSequence)
              : null,
          stopUpdates: (entity.tripUpdate.stopTimeUpdate || [])
            .map(normalizeStopUpdate)
        });
      }
    }

    if (entity.vehicle) {
      const identity = exactTripIdentity(entity.vehicle.trip);
      if (identity) {
        const existing = vehicles.get(identity.identityKey);
        const statusExplicit =
          Object.prototype.hasOwnProperty.call(
            entity.vehicle,
            "currentStatus"
          );
        const sequenceExplicit =
          Object.prototype.hasOwnProperty.call(
            entity.vehicle,
            "currentStopSequence"
          );
        const vehicle = {
          stopId: String(entity.vehicle.stopId || ""),
          currentStopSequence: numberValue(entity.vehicle.currentStopSequence),
          currentStopSequenceExplicit: sequenceExplicit,
          currentStatus: statusExplicit
            ? numberValue(entity.vehicle.currentStatus)
            : null,
          currentStatusExplicit: statusExplicit,
          timestamp: numberValue(entity.vehicle.timestamp)
        };
        vehicles.set(
          identity.identityKey,
          existing ? { ambiguous: true, vehicle: null } : { ambiguous: false, vehicle }
        );
      }
    }
  }

  const identityKeys = new Set([...tripUpdates.keys(), ...vehicles.keys()]);
  return [...identityKeys].map(identityKey => {
    const update = tripUpdates.get(identityKey);
    const vehicleMatch = vehicles.get(identityKey);
    const targetUpdate = update?.stopUpdates
      .find(stop => stop.stopId === targetStop) || null;

    return {
      identityKey,
      tripId: update?.identity.tripId ||
        exactTripIdentity(update?.trip || {})?.tripId ||
        identityKey.split("|")[0],
      startDate: update?.identity.startDate || identityKey.split("|")[1] || "",
      route: String(update?.trip?.routeId || ""),
      targetStop,
      targetStopPresent: Boolean(targetUpdate),
      targetStopSequence:
        targetUpdate?.stopSequence ??
        resolveTargetStopSequence(
          update?.identity.tripId || identityKey.split("|")[0],
          targetStop
        ),
      tripUpdatePresent: Boolean(update),
      tripUpdateProgressionSequence:
        update?.progressionStopSequence ?? null,
      stopUpdates: update?.stopUpdates || [],
      vehiclePositionPresent: Boolean(vehicleMatch?.vehicle),
      vehiclePositionAmbiguous: Boolean(vehicleMatch?.ambiguous),
      vehicle: vehicleMatch?.vehicle || null,
      feedTimestamp: numberValue(feedTimestamp)
    };
  });
}

function legacyReleaseClassification(lock, evidence) {
  if (!evidence) return { classification: "EVIDENCE_UNAVAILABLE", releaseReason: null };

  const targetSequence = numberValue(lock.targetStopSequence);
  if (targetSequence === null) {
    return { classification: "UNKNOWN", releaseReason: null };
  }

  if (
    evidence.vehiclePositionPresent &&
    !evidence.vehiclePositionAmbiguous &&
    numberValue(evidence.vehicle?.currentStopSequence) > targetSequence
  ) {
    return {
      classification: RELEASE_REASONS.VEHICLE_DOWNSTREAM,
      releaseReason: RELEASE_REASONS.VEHICLE_DOWNSTREAM
    };
  }

  const downstream = (evidence.stopUpdates || [])
    .filter(stop => numberValue(stop.stopSequence) > targetSequence);

  if (
    evidence.tripUpdatePresent &&
    numberValue(evidence.tripUpdateProgressionSequence) > targetSequence
  ) {
    return {
      classification: RELEASE_REASONS.TRIP_UPDATE_DOWNSTREAM,
      releaseReason: RELEASE_REASONS.TRIP_UPDATE_DOWNSTREAM
    };
  }

  if (
    evidence.tripUpdatePresent &&
    !evidence.targetStopPresent &&
    downstream.length
  ) {
    return {
      classification: RELEASE_REASONS.TARGET_STOP_REMOVED_WITH_DOWNSTREAM_EVIDENCE,
      releaseReason: RELEASE_REASONS.TARGET_STOP_REMOVED_WITH_DOWNSTREAM_EVIDENCE
    };
  }

  return {
    classification: evidence.tripUpdatePresent || evidence.vehiclePositionPresent
      ? "AT_OR_BEFORE_TARGET"
      : "EVIDENCE_UNAVAILABLE",
    releaseReason: null
  };
}

function correctedReleaseClassification(lock, evidence) {
  const currentRealtimeStoppingPattern =
    realtimeStoppingPattern(evidence);
  const lastConclusiveStoppingPattern =
    newerConclusivePattern(
      lock,
      evidence,
      lock.lastConclusiveStoppingPattern
    );
  const mismatch =
    staticRealtimeSequenceMismatch(lock, evidence);
  const base = {
    stationStateProofEnabled: true,
    staticRealtimeSequenceMismatch: mismatch,
    sequenceOnlyEvidenceRejected: mismatch,
    currentRealtimeStoppingPattern,
    lastConclusiveStoppingPattern,
    proposedDownstreamStop: evidence?.vehicle?.stopId || null,
    evidenceRejectedAsAmbiguous:
      Boolean(evidence?.vehiclePositionAmbiguous) ||
      Boolean(
        currentRealtimeStoppingPattern &&
        !currentRealtimeStoppingPattern.targetUnique
      )
  };
  const evaluatedPredicates = [
    {
      predicate: RELEASE_REASONS.TRIP_UPDATE_DOWNSTREAM,
      outcome: "UNKNOWN",
      reason: "NO_EXPLICIT_SAME_DOMAIN_TRIP_UPDATE_PROGRESSION"
    },
    {
      predicate:
        RELEASE_REASONS.TARGET_STOP_REMOVED_WITH_DOWNSTREAM_EVIDENCE,
      outcome: "UNKNOWN",
      reason:
        "TARGET_REMOVAL_AND_FUTURE_PREDICTIONS_ARE_NOT_PROGRESSION"
    }
  ];

  if (
    evidence?.vehicle?.stopId &&
    evidence.vehicle.stopId === lock.targetStop
  ) {
    return {
      classification: "AT_TARGET",
      releaseReason: null,
      lastConclusiveStoppingPattern,
      releaseDecision: {
        ...base,
        predicate: RELEASE_REASONS.VEHICLE_DOWNSTREAM,
        outcome: "NEGATIVE",
        reason: "VEHICLE_STILL_NAMES_TARGET",
        evaluatedPredicates
      }
    };
  }
  if (
    currentRealtimeStoppingPattern &&
    currentRealtimeStoppingPattern.targetIndexes.length > 1
  ) {
    return {
      classification: "UNKNOWN",
      releaseReason: null,
      lastConclusiveStoppingPattern,
      releaseDecision: {
        ...base,
        predicate: RELEASE_REASONS.VEHICLE_DOWNSTREAM,
        outcome: "UNKNOWN",
        reason: "TARGET_OCCURRENCE_AMBIGUOUS",
        evaluatedPredicates
      }
    };
  }
  if (!exactEvidenceIdentityMatches(lock, evidence)) {
    return {
      classification: "EVIDENCE_UNAVAILABLE",
      releaseReason: null,
      lastConclusiveStoppingPattern,
      releaseDecision: {
        ...base,
        predicate: RELEASE_REASONS.VEHICLE_DOWNSTREAM,
        outcome: "UNKNOWN",
        reason: "EXACT_IDENTITY_EVIDENCE_UNAVAILABLE",
        evaluatedPredicates
      }
    };
  }

  const vehicle = freshExactVehicle(lock, evidence);
  if (!vehicle) {
    return {
      classification: "EVIDENCE_UNAVAILABLE",
      releaseReason: null,
      lastConclusiveStoppingPattern,
      releaseDecision: {
        ...base,
        predicate: RELEASE_REASONS.VEHICLE_DOWNSTREAM,
        outcome: "UNKNOWN",
        reason: "FRESH_UNAMBIGUOUS_VEHICLE_UNAVAILABLE",
        evaluatedPredicates
      }
    };
  }
  if (!vehicle.currentStopSequenceExplicit) {
    return {
      classification: "UNKNOWN",
      releaseReason: null,
      lastConclusiveStoppingPattern,
      releaseDecision: {
        ...base,
        predicate: RELEASE_REASONS.VEHICLE_DOWNSTREAM,
        outcome: "UNKNOWN",
        reason: "CURRENT_STOP_SEQUENCE_NOT_EXPLICIT",
        evaluatedPredicates
      }
    };
  }
  if (!vehicle.currentStatusExplicit) {
    return {
      classification: "UNKNOWN",
      releaseReason: null,
      lastConclusiveStoppingPattern,
      releaseDecision: {
        ...base,
        predicate: RELEASE_REASONS.VEHICLE_DOWNSTREAM,
        outcome: "UNKNOWN",
        reason: "CURRENT_STATUS_NOT_EXPLICIT",
        evaluatedPredicates
      }
    };
  }

  const downstream =
    downstreamStopDecision(
      lastConclusiveStoppingPattern,
      vehicle.stopId
    );
  if (downstream.outcome === "AFFIRMATIVE") {
    return {
      classification: RELEASE_REASONS.VEHICLE_DOWNSTREAM,
      releaseReason: RELEASE_REASONS.VEHICLE_DOWNSTREAM,
      lastConclusiveStoppingPattern,
      releaseDecision: {
        ...base,
        ...downstream,
        predicate: RELEASE_REASONS.VEHICLE_DOWNSTREAM,
        evaluatedPredicates
      }
    };
  }

  return {
    classification: "UNKNOWN",
    releaseReason: null,
    lastConclusiveStoppingPattern,
    releaseDecision: {
      ...base,
      ...downstream,
      predicate: RELEASE_REASONS.VEHICLE_DOWNSTREAM,
      evaluatedPredicates
    }
  };
}

function cloneState(state) {
  return {
    active: { ...(state?.active || {}) },
    released: [...(state?.released || [])],
    tombstones: { ...(state?.tombstones || {}) },
    suppressed: [...(state?.suppressed || [])],
    suppressionTombstones: { ...(state?.suppressionTombstones || {}) }
  };
}

export function reconcileDepartureProofLocks(
  state,
  snapshot,
  nowMs,
  { stationStateProofEnabled = false } = {}
) {
  const next = cloneState(state);
  const evidenceByIdentity = new Map(
    (snapshot?.evidence || []).map(evidence => [evidence.identityKey, evidence])
  );
  const arrivals = snapshot?.arrivals || [];
  for (const arrival of arrivals) {
    const evidence = evidenceByIdentity.get(arrival.identityKey);
    if (
      !next.active[arrival.identityKey] &&
      !next.tombstones[arrival.identityKey] &&
      !next.suppressionTombstones[arrival.identityKey] &&
      Number(arrival.time) === 0 &&
      evidence?.tripUpdatePresent &&
      evidence.targetStopPresent &&
      numberValue(evidence.targetStopSequence) !== null
    ) {
      next.active[arrival.identityKey] = {
        identityKey: arrival.identityKey,
        tripId: arrival.tripId,
        startDate: arrival.startDate || "",
        route: arrival.route,
        direction: arrival.direction,
        platformId: arrival.platformId,
        selectedStop: arrival.platformId,
        targetStopSequence: evidence.targetStopSequence,
        ...(stationStateProofEnabled
          ? {
              stationStateProofEnabled: true,
              targetStop: evidence.targetStop,
              lastConclusiveStoppingPattern:
                newerConclusivePattern(arrival, evidence, null),
              releaseDecision: null
            }
          : {}),
        lockedAt: new Date(nowMs).toISOString(),
        lastSupportingEvidence: {
          observedAt: new Date(nowMs).toISOString(),
          feedTimestamp: evidence.feedTimestamp ?? null,
          targetStopPresent: true,
          stopUpdates: evidence.stopUpdates || [],
          vehicle: evidence.vehicle || null
        },
        tripUpdatePresent: true,
        vehiclePositionPresent: Boolean(evidence.vehiclePositionPresent),
        evidenceClassification: "TARGET_AT_ZERO",
        releaseReason: null,
        arrival: { ...arrival, time: "0", departureProofLocked: true }
      };
    }
  }

  for (const [identityKey, lock] of Object.entries(next.active)) {
    const evidence = evidenceByIdentity.get(identityKey);
    const classification =
      stationStateProofEnabled
        ? correctedReleaseClassification(lock, evidence)
        : legacyReleaseClassification(lock, evidence);
    const updated = {
      ...lock,
      tripUpdatePresent: Boolean(evidence?.tripUpdatePresent),
      vehiclePositionPresent: Boolean(evidence?.vehiclePositionPresent),
      evidenceClassification: classification.classification,
      ...(stationStateProofEnabled
        ? {
            stationStateProofEnabled: true,
            lastConclusiveStoppingPattern:
              classification.lastConclusiveStoppingPattern,
            releaseDecision: classification.releaseDecision
          }
        : {}),
      lastSupportingEvidence:
        evidence?.tripUpdatePresent || evidence?.vehiclePositionPresent
          ? {
              observedAt: new Date(nowMs).toISOString(),
              feedTimestamp: evidence.feedTimestamp ?? null,
              targetStopPresent: Boolean(evidence.targetStopPresent),
              stopUpdates: evidence.stopUpdates || [],
              vehicle: evidence.vehicle || null
            }
          : lock.lastSupportingEvidence
    };

    if (classification.releaseReason) {
      updated.releaseReason = classification.releaseReason;
      updated.releasedAt = new Date(nowMs).toISOString();
      next.released.push(updated);
      next.tombstones[identityKey] = {
        identityKey,
        tripId: updated.tripId,
        startDate: updated.startDate,
        releaseReason: classification.releaseReason,
        releasedAt: updated.releasedAt
      };
      delete next.active[identityKey];
    } else {
      next.active[identityKey] = updated;
    }
  }

  return next;
}

export function suppressDepartureProofLocks(
  state,
  platformEvidence,
  nowMs
) {
  const next =
    cloneState(state);

  for (const [identityKey, lock] of Object.entries(next.active)) {
    const matchingEvidence =
      (platformEvidence || []).find(evidence =>
        evidence.suppressionApplied &&
        evidence.route === lock.route &&
        evidence.resolvedPlatform === lock.platformId
      );

    if (!matchingEvidence) {
      continue;
    }

    const suppressedAt =
      new Date(nowMs).toISOString();
    const suppressed = {
      ...lock,
      disposition: "PLATFORM_UNAVAILABLE",
      suppressedAt,
      platformEvidence: matchingEvidence
    };

    next.suppressed.push(suppressed);
    next.suppressionTombstones[identityKey] = {
      identityKey,
      tripId: lock.tripId,
      startDate: lock.startDate,
      disposition: "PLATFORM_UNAVAILABLE",
      suppressedAt,
      alertId: matchingEvidence.alertId,
      route: matchingEvidence.route,
      platformId: matchingEvidence.resolvedPlatform
    };
    delete next.active[identityKey];
  }

  return next;
}

export function experimentalBoardArrivals(state, arrivals) {
  const normal = (arrivals || [])
    .filter(arrival => Number(arrival.time) >= 0)
    .map(arrival => ({ ...arrival }));
  const byIdentity = new Map(normal.map(arrival => [arrival.identityKey, arrival]));

  for (const lock of Object.values(state?.active || {})) {
    byIdentity.set(lock.identityKey, {
      ...lock.arrival,
      time: "0",
      departureProofLocked: true
    });
  }

  const byRoute = new Map();
  for (const arrival of byIdentity.values()) {
    if (!byRoute.has(arrival.route)) byRoute.set(arrival.route, []);
    byRoute.get(arrival.route).push(arrival);
  }

  const result = [];
  for (const routeArrivals of byRoute.values()) {
    routeArrivals.sort((a, b) => {
      if (Boolean(a.departureProofLocked) !== Boolean(b.departureProofLocked)) {
        return a.departureProofLocked ? -1 : 1;
      }
      if (Boolean(a.arrivalProofGated) !== Boolean(b.arrivalProofGated)) {
        return a.arrivalProofGated ? -1 : 1;
      }
      return Number(a.time) - Number(b.time);
    });
    const locked = routeArrivals.filter(arrival =>
      arrival.departureProofLocked || arrival.arrivalProofGated
    );
    const unlocked = routeArrivals.filter(arrival =>
      !arrival.departureProofLocked && !arrival.arrivalProofGated
    );
    result.push(...locked, ...unlocked.slice(0, Math.max(0, 3 - locked.length)));
  }

  return result.sort((a, b) => Number(a.time) - Number(b.time));
}

function detachedCopy(value) {
  if (Array.isArray(value)) {
    return value.map(detachedCopy);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, detachedCopy(nested)])
    );
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

export function inspectDepartureProofState(state) {
  return deepFreeze(detachedCopy({
    active: Object.values(state?.active || {}),
    released: state?.released || [],
    tombstones: Object.values(state?.tombstones || {}),
    suppressed: state?.suppressed || [],
    suppressionTombstones:
      Object.values(state?.suppressionTombstones || {})
  }));
}

export function createDepartureProofDiagnostics(
  states,
  stationStateProofEnabled = true
) {
  return Object.freeze({
    inspect() {
      const active = [];
      const released = [];
      const tombstones = [];
      const suppressed = [];
      const suppressionTombstones = [];

      for (const state of states.values()) {
        const inspected = inspectDepartureProofState(state);
        active.push(...inspected.active);
        released.push(...inspected.released);
        tombstones.push(...inspected.tombstones);
        suppressed.push(...inspected.suppressed);
        suppressionTombstones.push(...inspected.suppressionTombstones);
      }

      return deepFreeze({
        enabled: true,
        ...(stationStateProofEnabled
          ? { stationStateProofEnabled: true }
          : {}),
        active,
        released,
        tombstones,
        suppressed,
        suppressionTombstones
      });
    }
  });
}

export async function runGlideMutationIfBaseline(
  departureProofLockEnabled,
  mutate
) {
  if (departureProofLockEnabled) {
    return { skipped: true };
  }
  return {
    skipped: false,
    result: await mutate()
  };
}
