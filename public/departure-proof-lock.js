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
  return {
    stopId: String(update.stopId || ""),
    stopSequence: numberValue(update.stopSequence),
    eventTime: eventSeconds(update)
  };
}

export function buildGtfsEvidence(entities, targetStop, feedTimestamp) {
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
            numberValue(entity.tripUpdate.currentStopSequence),
          stopUpdates: (entity.tripUpdate.stopTimeUpdate || [])
            .map(normalizeStopUpdate)
        });
      }
    }

    if (entity.vehicle) {
      const identity = exactTripIdentity(entity.vehicle.trip);
      if (identity) {
        const existing = vehicles.get(identity.identityKey);
        const vehicle = {
          stopId: String(entity.vehicle.stopId || ""),
          currentStopSequence: numberValue(entity.vehicle.currentStopSequence),
          currentStatus: numberValue(entity.vehicle.currentStatus)
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
      targetStopSequence: targetUpdate?.stopSequence ?? null,
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

function releaseClassification(lock, evidence) {
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

function cloneState(state) {
  return {
    active: { ...(state?.active || {}) },
    released: [...(state?.released || [])]
  };
}

export function reconcileDepartureProofLocks(state, snapshot, nowMs) {
  const next = cloneState(state);
  const evidenceByIdentity = new Map(
    (snapshot?.evidence || []).map(evidence => [evidence.identityKey, evidence])
  );
  const arrivals = snapshot?.arrivals || [];
  for (const arrival of arrivals) {
    const evidence = evidenceByIdentity.get(arrival.identityKey);
    if (
      !next.active[arrival.identityKey] &&
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
    const classification = releaseClassification(lock, evidence);
    const updated = {
      ...lock,
      tripUpdatePresent: Boolean(evidence?.tripUpdatePresent),
      vehiclePositionPresent: Boolean(evidence?.vehiclePositionPresent),
      evidenceClassification: classification.classification,
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
      delete next.active[identityKey];
    } else {
      next.active[identityKey] = updated;
    }
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
      return Number(a.time) - Number(b.time);
    });
    const locked = routeArrivals.filter(arrival => arrival.departureProofLocked);
    const unlocked = routeArrivals.filter(arrival => !arrival.departureProofLocked);
    result.push(...locked, ...unlocked.slice(0, Math.max(0, 3 - locked.length)));
  }

  return result.sort((a, b) => Number(a.time) - Number(b.time));
}

export function inspectDepartureProofState(state) {
  return Object.freeze({
    active: Object.values(state?.active || {}).map(lock => Object.freeze({ ...lock })),
    released: (state?.released || []).map(lock => Object.freeze({ ...lock }))
  });
}

export function createDepartureProofDiagnostics(states) {
  return Object.freeze({
    inspect() {
      const active = [];
      const released = [];

      for (const state of states.values()) {
        const inspected = inspectDepartureProofState(state);
        active.push(...inspected.active);
        released.push(...inspected.released);
      }

      return Object.freeze({
        enabled: true,
        active: Object.freeze(active),
        released: Object.freeze(released)
      });
    }
  });
}
