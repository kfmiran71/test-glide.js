export const PLATFORM_DISPOSITION = "PLATFORM_UNAVAILABLE";

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

function restorationReason(previous, evidence) {
  if (!previous?.unavailable) return "";
  if (!evidence.length) return "ALERT_DISAPPEARED";
  if (evidence.some(item => item.decisionReason === "OUTSIDE_ACTIVE_PERIOD")) {
    return "ACTIVE_PERIOD_ENDED";
  }
  if (evidence.some(item => item.decisionReason === "NO_EXPLICIT_NO_STOP_PHRASE")) {
    return "EXPLICIT_NO_STOP_REMOVED";
  }
  return "STRUCTURED_ENTITY_NO_LONGER_APPLIES";
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
    activeEvidence.length > 0;

  return {
    unavailable,
    activeEvidence,
    decisions,
    suppressionStart:
      unavailable
        ? previous.unavailable && previous.suppressionStart
          ? previous.suppressionStart
          : new Date(nowMs).toISOString()
        : "",
    mostRecentSupportingEvidence:
      unavailable
        ? detachedCopy(activeEvidence)
        : detachedCopy(previous.mostRecentSupportingEvidence || []),
    restorationReason:
      unavailable ? "" : restorationReason(previous, decisions),
    uncertainty: ""
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
          unavailable: Boolean(state?.unavailable),
          activeEvidence: state?.activeEvidence || [],
          decisions: state?.decisions || [],
          suppressionStart: state?.suppressionStart || "",
          mostRecentSupportingEvidence:
            state?.mostRecentSupportingEvidence || [],
          restorationReason: state?.restorationReason || "",
          uncertainty: state?.uncertainty || ""
        });
      }

      return deepFreeze(detachedCopy({
        enabled,
        selections
      }));
    }
  });
}
