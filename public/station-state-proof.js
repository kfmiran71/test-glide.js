export const STATION_STATE_VEHICLE_FRESHNESS_SECONDS = 120;
export const COMPATIBILITY_CLASSIFICATIONS = Object.freeze({
  UNRESOLVED: "UNRESOLVED",
  COMPATIBLE: "COMPATIBLE",
  CONFLICT: "CONFLICT"
});

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boundedAnchors(anchors) {
  if (!anchors.length) return [];
  if (anchors.length <= 4) return anchors;
  return [
    anchors[0],
    anchors[1],
    anchors[anchors.length - 2],
    anchors[anchors.length - 1]
  ];
}

export function buildCompatibilityObservation({
  tripId,
  startDate,
  route,
  targetStop,
  stopUpdates = [],
  vehicle = null,
  tripUpdateRouteAmbiguous = false,
  routeIdMismatch = false,
  feedTimestamp = null,
  resolveStaticSequence = () => null
}) {
  const targetIndexes = [];
  const occurrenceCounts = new Map();
  const mapped = stopUpdates.map((stop, patternIndex) => {
    const stopId = String(stop?.stopId || "");
    occurrenceCounts.set(stopId, (occurrenceCounts.get(stopId) || 0) + 1);
    if (stopId === targetStop) targetIndexes.push(patternIndex);
    return {
      stopId,
      patternIndex,
      staticSequence: finiteNumber(resolveStaticSequence(tripId, stopId)),
      explicitRealtimeSequence:
        stop?.stopSequenceExplicit
          ? finiteNumber(stop.stopSequence)
          : null,
      explicitSource:
        stop?.stopSequenceExplicit ? "TRIP_UPDATE" : null
    };
  });
  const targetUnique = targetIndexes.length === 1;
  const targetPatternIndex = targetUnique ? targetIndexes[0] : null;
  const targetStaticSequence =
    finiteNumber(resolveStaticSequence(tripId, targetStop));

  const anchors = mapped
    .filter(item => item.explicitRealtimeSequence !== null)
    .map(item => ({
      source: item.explicitSource,
      stopId: item.stopId,
      patternIndex: item.patternIndex,
      realtimeSequence: item.explicitRealtimeSequence,
      staticSequence: item.staticSequence
    }));

  if (
    vehicle?.currentStopSequenceExplicit &&
    finiteNumber(vehicle.currentStopSequence) !== null
  ) {
    const stopId = String(vehicle.stopId || "");
    const indexes = mapped
      .filter(item => item.stopId === stopId)
      .map(item => item.patternIndex);
    anchors.push({
      source: "VEHICLE_POSITION",
      stopId,
      patternIndex: indexes.length === 1 ? indexes[0] : null,
      realtimeSequence: finiteNumber(vehicle.currentStopSequence),
      staticSequence: finiteNumber(resolveStaticSequence(tripId, stopId))
    });
  }

  const base = {
    classification: COMPATIBILITY_CLASSIFICATIONS.UNRESOLVED,
    reason: "ZERO_OFFSET_NOT_PROVEN",
    contradictionReason: null,
    zeroOffsetProven: false,
    routeEvidenceAgreement:
      !tripUpdateRouteAmbiguous && !routeIdMismatch,
    targetStaticSequence,
    targetRealtimePatternIndex: targetPatternIndex,
    establishedStartingSequence: null,
    anchorCount: anchors.length,
    anchors: boundedAnchors(anchors),
    feedTimestamp: finiteNumber(feedTimestamp)
  };

  if (tripUpdateRouteAmbiguous) {
    return {
      ...base,
      classification: COMPATIBILITY_CLASSIFICATIONS.CONFLICT,
      reason: "SIMULTANEOUS_TRIP_UPDATE_ROUTES",
      contradictionReason: "SIMULTANEOUS_TRIP_UPDATE_ROUTES"
    };
  }
  if (routeIdMismatch) {
    return {
      ...base,
      classification: COMPATIBILITY_CLASSIFICATIONS.CONFLICT,
      reason: "TRIP_UPDATE_VEHICLE_ROUTE_MISMATCH",
      contradictionReason: "TRIP_UPDATE_VEHICLE_ROUTE_MISMATCH"
    };
  }

  const contradictoryAnchor = anchors.find(anchor =>
    anchor.staticSequence !== null &&
    anchor.realtimeSequence !== anchor.staticSequence
  );
  if (contradictoryAnchor) {
    return {
      ...base,
      classification: COMPATIBILITY_CLASSIFICATIONS.CONFLICT,
      reason: "EXPLICIT_ANCHOR_NONZERO_OFFSET",
      contradictionReason: "EXPLICIT_ANCHOR_NONZERO_OFFSET",
      anchors: boundedAnchors([contradictoryAnchor, ...anchors])
    };
  }

  if (!targetUnique) {
    return {
      ...base,
      reason:
        targetIndexes.length > 1
          ? "TARGET_OCCURRENCE_AMBIGUOUS"
          : "TARGET_OCCURRENCE_UNAVAILABLE"
    };
  }
  if (targetStaticSequence === null) {
    return {
      ...base,
      reason: "STATIC_TARGET_SEQUENCE_UNAVAILABLE"
    };
  }

  const targetAnchor = anchors.find(anchor =>
    anchor.stopId === targetStop &&
    anchor.patternIndex === targetPatternIndex &&
    anchor.staticSequence === targetStaticSequence &&
    anchor.realtimeSequence === targetStaticSequence
  );
  if (targetAnchor) {
    return {
      ...base,
      classification: COMPATIBILITY_CLASSIFICATIONS.COMPATIBLE,
      reason: "EXPLICIT_TARGET_SEQUENCE_ZERO_OFFSET",
      zeroOffsetProven: true,
      establishedStartingSequence: targetAnchor.realtimeSequence,
      anchors: boundedAnchors([targetAnchor, ...anchors])
    };
  }

  const usableAnchors = anchors
    .filter(anchor =>
      anchor.patternIndex !== null &&
      anchor.patternIndex <= targetPatternIndex &&
      anchor.staticSequence !== null &&
      anchor.realtimeSequence === anchor.staticSequence &&
      occurrenceCounts.get(anchor.stopId) === 1
    )
    .sort((a, b) => a.patternIndex - b.patternIndex);
  if (!usableAnchors.length) {
    return {
      ...base,
      reason: "EXPLICIT_ZERO_OFFSET_ANCHOR_UNAVAILABLE"
    };
  }

  for (const anchor of usableAnchors) {
    const throughTarget = mapped.slice(
      anchor.patternIndex,
      targetPatternIndex + 1
    );
    if (
      throughTarget.some(item =>
        !item.stopId ||
        item.staticSequence === null ||
        occurrenceCounts.get(item.stopId) !== 1
      )
    ) {
      continue;
    }

    const everyOccurrenceExplicitAndMatching =
      throughTarget.every(item =>
        item.explicitRealtimeSequence !== null &&
        item.explicitRealtimeSequence === item.staticSequence
      );
    const staticallyConsecutive =
      throughTarget.every((item, index) =>
        index === 0 ||
        item.staticSequence === throughTarget[index - 1].staticSequence + 1
      );

    if (everyOccurrenceExplicitAndMatching || staticallyConsecutive) {
      return {
        ...base,
        classification: COMPATIBILITY_CLASSIFICATIONS.COMPATIBLE,
        reason:
          everyOccurrenceExplicitAndMatching
            ? "MULTIPLE_EXPLICIT_ANCHORS_ZERO_OFFSET"
            : "EXPLICIT_ANCHOR_WITH_FULL_STATIC_PROGRESSION",
        zeroOffsetProven: true,
        establishedStartingSequence: anchor.realtimeSequence,
        anchors: boundedAnchors(
          everyOccurrenceExplicitAndMatching
            ? throughTarget.map(item => ({
                source: item.explicitSource,
                stopId: item.stopId,
                patternIndex: item.patternIndex,
                realtimeSequence: item.explicitRealtimeSequence,
                staticSequence: item.staticSequence
              }))
            : [anchor]
        )
      };
    }
  }

  return {
    ...base,
    reason: "STATIC_NUMERIC_PROGRESSION_NOT_PROVEN",
    establishedStartingSequence: usableAnchors[0].realtimeSequence
  };
}

export function reconcileCompatibilityState(previous, evidence) {
  const prior =
    previous || {
      classification: COMPATIBILITY_CLASSIFICATIONS.UNRESOLVED,
      reason: "NO_COMPATIBILITY_EVIDENCE",
      contradictionReason: null,
      zeroOffsetProven: false,
      lastObservation: null
    };
  if (prior.classification === COMPATIBILITY_CLASSIFICATIONS.CONFLICT) {
    return prior;
  }

  const observation = evidence?.compatibility || null;
  if (!observation) return prior;
  if (observation.classification === COMPATIBILITY_CLASSIFICATIONS.CONFLICT) {
    return {
      ...observation,
      lastObservation: observation
    };
  }
  if (
    observation.classification ===
      COMPATIBILITY_CLASSIFICATIONS.COMPATIBLE &&
    observation.zeroOffsetProven
  ) {
    return {
      ...observation,
      lastObservation: observation
    };
  }
  if (prior.classification === COMPATIBILITY_CLASSIFICATIONS.COMPATIBLE) {
    return {
      ...prior,
      lastObservation: observation
    };
  }
  return {
    ...observation,
    classification: COMPATIBILITY_CLASSIFICATIONS.UNRESOLVED,
    zeroOffsetProven: false,
    lastObservation: observation
  };
}

export function exactEvidenceIdentityMatches(subject, evidence) {
  return Boolean(
    subject?.identityKey &&
    subject.identityKey === evidence?.identityKey &&
    subject.tripId &&
    subject.tripId === evidence?.tripId &&
    String(subject.startDate || "") === String(evidence?.startDate || "") &&
    !evidence?.tripUpdateRouteAmbiguous &&
    !evidence?.routeIdMismatch
  );
}

export function reconcileExactIdentityRoute(
  subject,
  evidence,
  arrivals = []
) {
  const observedRoutes = new Set(
    arrivals
      .filter(arrival => arrival?.identityKey === subject?.identityKey)
      .map(arrival => String(arrival?.route || ""))
      .filter(Boolean)
  );
  if (evidence?.route) observedRoutes.add(String(evidence.route));

  const routes = [...observedRoutes].sort();
  const ambiguous =
    Boolean(evidence?.tripUpdateRouteAmbiguous) ||
    Boolean(evidence?.routeIdMismatch) ||
    routes.length > 1;
  const previousRoute = String(subject?.route || "");
  const route =
    !ambiguous && routes.length === 1
      ? routes[0]
      : previousRoute || routes[0] || "";

  return {
    route,
    previousRoute,
    observedRoutes: routes,
    changed:
      Boolean(previousRoute) &&
      Boolean(route) &&
      previousRoute !== route,
    ambiguous,
    reason:
      ambiguous
        ? "SIMULTANEOUS_ROUTE_LABELS_AMBIGUOUS"
        : previousRoute && route !== previousRoute
          ? "EXACT_IDENTITY_ROUTE_UPDATED"
          : "EXACT_IDENTITY_ROUTE_STABLE"
  };
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
    !evidence?.tripId ||
    evidence?.tripUpdateRouteAmbiguous ||
    evidence?.routeIdMismatch
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
    route: String(evidence.route || ""),
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
