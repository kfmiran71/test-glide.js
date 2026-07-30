export const PLATFORM_DISPOSITION = "PLATFORM_UNAVAILABLE";

export const PLATFORM_AVAILABILITY = Object.freeze({
  AVAILABLE: "AVAILABLE",
  SUPPRESSED: "SUPPRESSED",
  UNKNOWN: "UNKNOWN"
});

export const SANITIZED_PLATFORM_CLOSURES = Object.freeze({
  "706N": Object.freeze({
    platformId: "706N",
    route: "7",
    alertId: "lmm:planned_work:23514",
    evidenceSource: "MTA_SUBWAY_ALERTS",
    evidenceFeedTimestamp: 1785443407,
    lastValidatedAt: "2026-07-30T20:33:58.604Z",
    activePeriod: Object.freeze({
      start: 1783191600,
      end: 1790582400
    }),
    header:
      "In Queens, Flushing-bound [7] skips 103 St-Corona Plaza"
  })
});

export const NO_STOP_PHRASE_CATEGORIES = Object.freeze({
  SKIP: "SKIP",
  ARE_NOT_STOPPING: "ARE_NOT_STOPPING",
  WILL_NOT_STOP: "WILL_NOT_STOP"
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

function stripMarkup(value) {
  return String(value || "")
    .replace(/<[^>]*>/g, " ");
}

export function normalizeAlertText(value) {
  return stripMarkup(value)
    .normalize("NFKD")
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/&(?:nbsp|amp);/gi, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function stationAppearsInText(text, stationName) {
  const normalizedStation =
    normalizeAlertText(stationName);

  return Boolean(
    normalizedStation &&
    normalizeAlertText(text).includes(normalizedStation)
  );
}

function conditionalSkip(text) {
  return /\b(?:may|might|could|sometimes|possibly|potentially)\s+(?:be\s+)?skip(?:s|ped|ping)?\b/i
    .test(text);
}

function escapedPattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function directionIsPresent(informedEntity) {
  return informedEntity?.directionIdPresent === true ||
    Object.prototype.hasOwnProperty.call(
      informedEntity || {},
      "directionId"
    );
}

export function classifyExplicitNoStopText({
  header = "",
  description = "",
  stationName = ""
} = {}) {
  for (const source of [
    { field: "header", text: header },
    { field: "description", text: description }
  ]) {
    const normalized =
      normalizeAlertText(source.text);
    const normalizedStation =
      normalizeAlertText(stationName);
    const stationPattern =
      escapedPattern(normalizedStation);

    if (!stationAppearsInText(source.text, stationName)) {
      continue;
    }

    if (
      !conditionalSkip(normalized) &&
      new RegExp(
        `\\bskip(?:s|ped|ping)?\\s+(?:the\\s+)?${stationPattern}\\b`
      ).test(normalized)
    ) {
      return {
        category: NO_STOP_PHRASE_CATEGORIES.SKIP,
        source: source.field
      };
    }

    if (
      new RegExp(
        `\\bare not stopping at\\s+(?:the\\s+)?${stationPattern}\\b`
      ).test(normalized)
    ) {
      return {
        category: NO_STOP_PHRASE_CATEGORIES.ARE_NOT_STOPPING,
        source: source.field
      };
    }

    if (
      new RegExp(
        `\\bwill not stop at\\s+(?:the\\s+)?${stationPattern}\\b`
      ).test(normalized)
    ) {
      return {
        category: NO_STOP_PHRASE_CATEGORIES.WILL_NOT_STOP,
        source: source.field
      };
    }
  }

  return null;
}

export function isAlertActive(activePeriods, nowSeconds) {
  const periods =
    activePeriods || [];

  if (!periods.length) {
    return true;
  }

  return periods.some(period => {
    const start =
      numberValue(period.start) || 0;
    const end =
      numberValue(period.end) || 0;

    return (!start || start <= nowSeconds) &&
      (!end || end >= nowSeconds);
  });
}

export function resolveInformedPlatform({
  informedEntity,
  routeDirectionSuffixes,
  platformRoutes
} = {}) {
  const route =
    String(informedEntity?.routeId || "");
  const parentStop =
    String(informedEntity?.stopId || "").replace(/[NS]$/, "");
  const direction =
    numberValue(informedEntity?.directionId);
  const suffixes =
    routeDirectionSuffixes?.[route]?.[direction] || [];

  if (
    !route ||
    !parentStop ||
    !directionIsPresent(informedEntity) ||
    direction === null ||
    suffixes.length !== 1
  ) {
    return {
      resolvedPlatform: "",
      mappingStatus: "AMBIGUOUS_DIRECTION_MAPPING"
    };
  }

  const candidate =
    `${parentStop}${suffixes[0]}`;
  const candidateRoutes =
    platformRoutes?.[candidate] || [];

  if (!candidateRoutes.includes(route)) {
    return {
      resolvedPlatform: "",
      mappingStatus: "PLATFORM_ROUTE_MISMATCH"
    };
  }

  return {
    resolvedPlatform: candidate,
    mappingStatus: "RESOLVED"
  };
}

export function evaluatePlatformAlertEntity({
  alertId = "",
  activePeriods = [],
  informedEntity = {},
  header = "",
  description = "",
  stationName = "",
  routeDirectionSuffixes = {},
  platformRoutes = {},
  nowSeconds = 0,
  feedTimestamp = 0,
  structuredEffect = ""
} = {}) {
  const mapping =
    resolveInformedPlatform({
      informedEntity,
      routeDirectionSuffixes,
      platformRoutes
    });
  const textMatch =
    classifyExplicitNoStopText({
      header,
      description,
      stationName
    });
  const active =
    isAlertActive(activePeriods, nowSeconds);
  const exactEntity =
    Boolean(
      informedEntity?.routeId &&
      informedEntity?.stopId &&
      directionIsPresent(informedEntity) &&
      numberValue(informedEntity?.directionId) !== null
    );
  const suppressionApplied =
    active &&
    exactEntity &&
    mapping.mappingStatus === "RESOLVED" &&
    Boolean(textMatch);

  return {
    alertId,
    activePeriods: (activePeriods || []).map(period => ({
      start: numberValue(period.start) || 0,
      end: numberValue(period.end) || 0
    })),
    active,
    informedEntity: {
      agencyId: String(informedEntity?.agencyId || ""),
      routeId: String(informedEntity?.routeId || ""),
      stopId: String(informedEntity?.stopId || ""),
      directionId: numberValue(informedEntity?.directionId),
      directionIdPresent: directionIsPresent(informedEntity)
    },
    route: String(informedEntity?.routeId || ""),
    parentStop: String(informedEntity?.stopId || "").replace(/[NS]$/, ""),
    direction: numberValue(informedEntity?.directionId),
    resolvedPlatform: mapping.resolvedPlatform,
    mappingStatus: mapping.mappingStatus,
    stationName,
    structuredEffect,
    phraseCategory: textMatch?.category || "",
    phraseSource: textMatch?.source || "",
    suppressionApplied,
    decisionReason:
      suppressionApplied ? "ACTIVE_EXPLICIT_NO_STOP" :
      !active ? "OUTSIDE_ACTIVE_PERIOD" :
      !exactEntity ? "INCOMPLETE_INFORMED_ENTITY" :
      mapping.mappingStatus !== "RESOLVED" ? mapping.mappingStatus :
      !textMatch ? "NO_EXPLICIT_NO_STOP_PHRASE" :
      "NOT_APPLIED",
    feedTimestamp: numberValue(feedTimestamp) || 0
  };
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
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function isoTime(milliseconds) {
  return milliseconds ? new Date(milliseconds).toISOString() : "";
}

function latestObservationResult(snapshot) {
  if (!snapshot?.feedSucceeded) {
    return snapshot?.decodeSucceeded === false
      ? "DECODE_FAILURE"
      : "FETCH_FAILURE";
  }
  if (snapshot.feedStale) return "STALE_FEED";
  return "SUCCESS";
}

function policyEvidence(policy, feedTimestamp = 0) {
  if (!policy) return [];
  return [{
    alertId: policy.alertId,
    activePeriods: [detachedCopy(policy.activePeriod)],
    active: true,
    informedEntity: {
      agencyId: "MTASBWY",
      routeId: policy.route,
      stopId: policy.platformId.replace(/[NS]$/, ""),
      directionId: policy.platformId.endsWith("N") ? 0 : 1,
      directionIdPresent: true
    },
    route: policy.route,
    parentStop: policy.platformId.replace(/[NS]$/, ""),
    direction: policy.platformId.endsWith("N") ? 0 : 1,
    resolvedPlatform: policy.platformId,
    mappingStatus: "RESOLVED",
    stationName: "",
    structuredEffect: "",
    phraseCategory: NO_STOP_PHRASE_CATEGORIES.SKIP,
    phraseSource: "sanitized-policy",
    suppressionApplied: true,
    decisionReason: "SANITIZED_ACTIVE_PERIOD",
    feedTimestamp: feedTimestamp || policy.evidenceFeedTimestamp || 0
  }];
}

function blankAuthoritativeState(platformId, nowMs) {
  return {
    platformId,
    availability: PLATFORM_AVAILABILITY.AVAILABLE,
    unavailable: false,
    lastConclusiveState: PLATFORM_AVAILABILITY.AVAILABLE,
    activeEvidence: [],
    decisions: [],
    suppressionStart: "",
    mostRecentSupportingEvidence: [],
    restorationReason: "",
    uncertainty: "",
    evidenceAlertId: "",
    evidenceFeedTimestamp: 0,
    lastAcceptedFeedTimestamp: 0,
    lastValidationTime: "",
    latestObservationResult: "NOT_OBSERVED",
    retainedThroughUncertainty: false,
    retentionReason: "",
    expiration: {
      policyEnd: 0,
      expired: false,
      revalidationPolicy: "NONE"
    },
    updatedAt: isoTime(nowMs)
  };
}

function activePolicyState(platformId, policy, nowMs) {
  const evidence =
    policyEvidence(policy);
  return {
    ...blankAuthoritativeState(platformId, nowMs),
    availability: PLATFORM_AVAILABILITY.SUPPRESSED,
    unavailable: true,
    lastConclusiveState: PLATFORM_AVAILABILITY.SUPPRESSED,
    activeEvidence: evidence,
    mostRecentSupportingEvidence: detachedCopy(evidence),
    suppressionStart: isoTime(policy.activePeriod.start * 1000),
    evidenceAlertId: policy.alertId,
    evidenceFeedTimestamp: policy.evidenceFeedTimestamp || 0,
    lastAcceptedFeedTimestamp: policy.evidenceFeedTimestamp || 0,
    lastValidationTime: policy.lastValidatedAt || "",
    expiration: {
      policyEnd: policy.activePeriod.end,
      expired: false,
      revalidationPolicy:
        "RETAIN_UNTIL_OFFICIAL_ACTIVE_PERIOD_END_OR_NEWER_EXPLICIT_RESTORATION"
    }
  };
}

export function initialAuthoritativePlatformAvailability(
  platformId,
  nowMs,
  policies = SANITIZED_PLATFORM_CLOSURES
) {
  const policy =
    policies?.[platformId] || null;
  const nowSeconds =
    Math.floor(nowMs / 1000);

  if (
    policy &&
    (!policy.activePeriod.start || policy.activePeriod.start <= nowSeconds) &&
    (!policy.activePeriod.end || policy.activePeriod.end > nowSeconds)
  ) {
    return activePolicyState(platformId, policy, nowMs);
  }

  return blankAuthoritativeState(platformId, nowMs);
}

export function reconcileAuthoritativePlatformAvailability(
  state,
  snapshot,
  nowMs,
  {
    platformId = state?.platformId || "",
    policies = SANITIZED_PLATFORM_CLOSURES
  } = {}
) {
  const policy =
    policies?.[platformId] || null;
  const previous =
    state ||
    initialAuthoritativePlatformAvailability(
      platformId,
      nowMs,
      policies
    );
  const nowSeconds =
    Math.floor(nowMs / 1000);
  const feedTimestamp =
    numberValue(snapshot?.feedTimestamp) || 0;
  const decisions =
    detachedCopy(snapshot?.evidence || []);
  const qualifying =
    decisions.filter(item =>
      item.suppressionApplied &&
      item.resolvedPlatform === platformId
    );
  const result =
    latestObservationResult(snapshot);
  const policyExpired =
    Boolean(
      policy?.activePeriod?.end &&
      nowSeconds >= policy.activePeriod.end
    );

  if (policyExpired) {
    return {
      ...blankAuthoritativeState(platformId, nowMs),
      decisions,
      restorationReason: "OFFICIAL_ACTIVE_PERIOD_EXPIRED",
      latestObservationResult: result,
      lastAcceptedFeedTimestamp:
        Math.max(previous.lastAcceptedFeedTimestamp || 0, feedTimestamp),
      expiration: {
        policyEnd: policy.activePeriod.end,
        expired: true,
        revalidationPolicy:
          "RESTORE_AT_OFFICIAL_ACTIVE_PERIOD_END"
      }
    };
  }

  if (
    feedTimestamp &&
    previous.lastAcceptedFeedTimestamp &&
    feedTimestamp < previous.lastAcceptedFeedTimestamp
  ) {
    return {
      ...previous,
      decisions,
      availability:
        previous.unavailable
          ? PLATFORM_AVAILABILITY.UNKNOWN
          : previous.availability,
      latestObservationResult: "OUT_OF_ORDER_FEED",
      uncertainty: "OUT_OF_ORDER_FEED",
      retainedThroughUncertainty: previous.unavailable,
      retentionReason:
        previous.unavailable
          ? "NEWER_CONCLUSIVE_SUPPRESSION_RETAINED"
          : "",
      updatedAt: isoTime(nowMs)
    };
  }

  if (
    snapshot?.feedSucceeded &&
    !snapshot?.feedStale &&
    qualifying.length
  ) {
    return {
      ...previous,
      availability: PLATFORM_AVAILABILITY.SUPPRESSED,
      unavailable: true,
      lastConclusiveState: PLATFORM_AVAILABILITY.SUPPRESSED,
      activeEvidence: qualifying,
      decisions,
      suppressionStart:
        previous.unavailable && previous.suppressionStart
          ? previous.suppressionStart
          : isoTime(nowMs),
      mostRecentSupportingEvidence: detachedCopy(qualifying),
      restorationReason: "",
      uncertainty: "",
      evidenceAlertId: qualifying[0].alertId || policy?.alertId || "",
      evidenceFeedTimestamp: feedTimestamp,
      lastAcceptedFeedTimestamp:
        Math.max(previous.lastAcceptedFeedTimestamp || 0, feedTimestamp),
      lastValidationTime: isoTime(nowMs),
      latestObservationResult: "QUALIFYING_EVIDENCE",
      retainedThroughUncertainty: false,
      retentionReason: "",
      expiration: {
        policyEnd: policy?.activePeriod?.end || 0,
        expired: false,
        revalidationPolicy:
          "RETAIN_UNTIL_OFFICIAL_ACTIVE_PERIOD_END_OR_NEWER_EXPLICIT_RESTORATION"
      },
      updatedAt: isoTime(nowMs)
    };
  }

  if (previous.unavailable) {
    const uncertainty =
      result === "SUCCESS"
        ? decisions.length
          ? "NO_QUALIFYING_EVIDENCE_IN_SNAPSHOT"
          : "QUALIFYING_ALERT_ABSENT"
        : result;
    return {
      ...previous,
      availability: PLATFORM_AVAILABILITY.UNKNOWN,
      decisions,
      uncertainty,
      lastAcceptedFeedTimestamp:
        result === "SUCCESS"
          ? Math.max(previous.lastAcceptedFeedTimestamp || 0, feedTimestamp)
          : previous.lastAcceptedFeedTimestamp || 0,
      latestObservationResult: uncertainty,
      retainedThroughUncertainty: true,
      retentionReason:
        policy
          ? "OFFICIAL_ACTIVE_PERIOD_STILL_OPEN"
          : "LAST_CONCLUSIVE_SUPPRESSION",
      updatedAt: isoTime(nowMs)
    };
  }

  return {
    ...previous,
    decisions,
    latestObservationResult: result,
    lastAcceptedFeedTimestamp:
      result === "SUCCESS"
        ? Math.max(previous.lastAcceptedFeedTimestamp || 0, feedTimestamp)
        : previous.lastAcceptedFeedTimestamp || 0,
    uncertainty:
      result === "SUCCESS" ? "" : result,
    updatedAt: isoTime(nowMs)
  };
}

export function reconcilePlatformAvailability(
  state,
  snapshot,
  nowMs
) {
  const previous =
    state || {
      unavailable: false,
      activeEvidence: [],
      decisions: [],
      suppressionStart: "",
      mostRecentSupportingEvidence: [],
      restorationReason: "",
      uncertainty: ""
    };

  if (snapshot?.authoritative) {
    return detachedCopy(snapshot.authoritative);
  }

  if (!snapshot?.feedSucceeded || snapshot?.feedStale) {
    return {
      ...previous,
      decisions: detachedCopy(snapshot?.evidence || previous.decisions || []),
      uncertainty:
        snapshot?.feedStale
          ? "ALERT_FEED_STALE"
          : snapshot?.error || "ALERT_FEED_UNAVAILABLE"
    };
  }

  const decisions =
    detachedCopy(snapshot.evidence || []);
  const activeEvidence =
    decisions.filter(item => item.suppressionApplied);
  const unavailable =
    activeEvidence.length > 0 || Boolean(previous.unavailable);

  return {
    unavailable,
    activeEvidence:
      activeEvidence.length
        ? activeEvidence
        : detachedCopy(previous.activeEvidence || []),
    decisions,
    suppressionStart:
      unavailable
        ? previous.unavailable && previous.suppressionStart
          ? previous.suppressionStart
          : new Date(nowMs).toISOString()
        : "",
    mostRecentSupportingEvidence:
      unavailable
        ? detachedCopy(
            activeEvidence.length
              ? activeEvidence
              : previous.mostRecentSupportingEvidence || []
          )
        : detachedCopy(previous.mostRecentSupportingEvidence || []),
    restorationReason:
      unavailable ? "" : previous.restorationReason || "",
    uncertainty:
      activeEvidence.length
        ? ""
        : previous.unavailable
          ? "QUALIFYING_ALERT_ABSENT"
          : ""
  };
}

export function arrivalIsPlatformSuppressed(state, arrival) {
  return (state?.activeEvidence || []).some(evidence =>
    evidence.route === arrival?.route &&
    evidence.resolvedPlatform === arrival?.platformId
  );
}

export function filterPlatformUnavailableArrivals(state, arrivals) {
  return (arrivals || [])
    .filter(arrival => !arrivalIsPlatformSuppressed(state, arrival));
}

export function createPlatformAlertDiagnostics(states, enabled = true) {
  return Object.freeze({
    inspect() {
      const selections = [];

      for (const [platform, state] of states.entries()) {
        selections.push({
          platform,
          availability:
            state?.availability ||
            (state?.unavailable
              ? PLATFORM_AVAILABILITY.SUPPRESSED
              : PLATFORM_AVAILABILITY.AVAILABLE),
          unavailable: Boolean(state?.unavailable),
          lastConclusiveState: state?.lastConclusiveState || "",
          activeEvidence: state?.activeEvidence || [],
          decisions: state?.decisions || [],
          suppressionStart: state?.suppressionStart || "",
          mostRecentSupportingEvidence:
            state?.mostRecentSupportingEvidence || [],
          restorationReason: state?.restorationReason || "",
          uncertainty: state?.uncertainty || "",
          evidenceAlertId: state?.evidenceAlertId || "",
          evidenceFeedTimestamp: state?.evidenceFeedTimestamp || 0,
          lastValidationTime: state?.lastValidationTime || "",
          latestObservationResult: state?.latestObservationResult || "",
          retainedThroughUncertainty:
            Boolean(state?.retainedThroughUncertainty),
          retentionReason: state?.retentionReason || "",
          expiration: state?.expiration || {}
        });
      }

      return deepFreeze(detachedCopy({
        enabled,
        selections
      }));
    }
  });
}
