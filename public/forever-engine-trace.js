export const FOREVER_ENGINE_TRACE_SCHEMA_VERSION = 1;
export const TRACE_RETENTION_MS = 90 * 60 * 1000;
export const TRACE_MAX_EVENTS = 2400;
export const TRACE_MAX_BYTES = 1500000;
export const TRACE_STORAGE_KEY = "commuterEye.foreverEngine.arrivalTrace.v1";

const SECRET_KEY_PATTERN = /(?:authorization|api[_-]?key|token|secret|password|cookie|deployhook)/i;
const URL_CREDENTIAL_PATTERN = /(?:[?&](?:key|token|secret|auth|api[_-]?key)=)|(?:bearer\s+)/i;

function detached(value) {
  if (Array.isArray(value)) return value.map(detached);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [key, detached(nested)])
    );
  }
  return value;
}

function sanitize(value, key = "") {
  if (SECRET_KEY_PATTERN.test(key)) return "[REDACTED]";
  if (key === "lat" || key === "lon" || key === "latitude" || key === "longitude") {
    return undefined;
  }
  if (typeof value === "string" && URL_CREDENTIAL_PATTERN.test(value)) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) {
    return value.map(item => sanitize(item)).filter(item => item !== undefined);
  }
  if (value && typeof value === "object") {
    const result = {};
    for (const [nestedKey, nestedValue] of Object.entries(value)) {
      const clean = sanitize(nestedValue, nestedKey);
      if (clean !== undefined) result[nestedKey] = clean;
    }
    return result;
  }
  return value;
}

export function createMemoryStorage(initialValue = null) {
  let value = initialValue;
  return {
    getItem() { return value; },
    setItem(_key, next) { value = String(next); },
    removeItem() { value = null; }
  };
}

export function normalizeTraceState(raw, nowMs, {
  retentionMs = TRACE_RETENTION_MS,
  maxEvents = TRACE_MAX_EVENTS,
  maxBytes = TRACE_MAX_BYTES
} = {}) {
  const parsed = raw && typeof raw === "object" ? raw : {};
  const cutoff = nowMs - retentionMs;
  const eligibleEvents = (Array.isArray(parsed.events) ? parsed.events : [])
    .filter(event => Number(event?.timestampMs) >= cutoff)
    .sort((a, b) => Number(a.timestampMs) - Number(b.timestampMs))
    .slice(-maxEvents)
    .map(detached);
  const events = [];
  let retainedBytes = 2;
  for (let index = eligibleEvents.length - 1; index >= 0; index -= 1) {
    const event = eligibleEvents[index];
    const eventBytes = JSON.stringify(event).length + 1;
    if (events.length && retainedBytes + eventBytes > maxBytes) break;
    if (!events.length && eventBytes > maxBytes) continue;
    events.unshift(event);
    retainedBytes += eventBytes;
  }
  return {
    schemaVersion: FOREVER_ENGINE_TRACE_SCHEMA_VERSION,
    events,
    nextSequence: Math.max(
      Number(parsed.nextSequence) || 1,
      events.reduce((highest, event) => Math.max(highest, Number(event.sequence) || 0), 0) + 1
    )
  };
}

export function classifyRemoval({
  previous,
  currentEvidence,
  currentCandidate,
  currentAfterPlatform,
  currentAfterEngine,
  lockState,
  platformUnavailable,
  routeLimited,
  replacementIdentity
} = {}) {
  if (!previous) return "UNKNOWN";
  if (replacementIdentity) return "REPLACED_BY_DIFFERENT_IDENTITY";
  if (!currentEvidence) return "ABSENT_FROM_FRESH_FEED";
  if (Number(currentEvidence.rawCountdown) < 0 && !currentCandidate) {
    return "NEGATIVE_CANDIDATE_FILTER";
  }
  if (platformUnavailable || (currentCandidate && !currentAfterPlatform)) {
    return "PLATFORM_UNAVAILABLE";
  }
  if (lockState?.tombstoned) return "DEPARTURE_TOMBSTONED";
  if (lockState?.released) return "DEPARTURE_LOCK_RELEASE";
  if (routeLimited || (currentAfterEngine && !currentAfterEngine.finalBoard)) {
    return "ROUTE_LIMIT";
  }
  return "UNKNOWN";
}

export function createTraceRecorder({
  storage,
  now = () => Date.now(),
  retentionMs = TRACE_RETENTION_MS,
  maxEvents = TRACE_MAX_EVENTS,
  maxBytes = TRACE_MAX_BYTES,
  persistDelayMs = 400,
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  let state = normalizeTraceState(null, now(), { retentionMs, maxEvents, maxBytes });
  let timer = null;
  let persistenceError = "";
  let observedBoards = new Map();

  try {
    const stored = storage?.getItem(TRACE_STORAGE_KEY);
    state = normalizeTraceState(stored ? JSON.parse(stored) : null, now(), {
      retentionMs,
      maxEvents,
      maxBytes
    });
  } catch (error) {
    persistenceError = String(error?.message || error);
  }

  function persistNow() {
    timer = null;
    try {
      storage?.setItem(TRACE_STORAGE_KEY, JSON.stringify(state));
      persistenceError = "";
    } catch (error) {
      persistenceError = String(error?.message || error);
    }
  }

  function schedulePersist() {
    if (!storage || timer !== null) return;
    timer = setTimer(persistNow, persistDelayMs);
  }

  function record(type, details = {}, timestampMs = now()) {
    try {
      state = normalizeTraceState(state, timestampMs, { retentionMs, maxEvents, maxBytes });
      const event = sanitize({
        sequence: state.nextSequence,
        timestampMs,
        timestamp: new Date(timestampMs).toISOString(),
        type,
        ...details
      });
      state.events.push(event);
      state.nextSequence += 1;
      state = normalizeTraceState(state, timestampMs, { retentionMs, maxEvents, maxBytes });
      schedulePersist();
      return detached(event);
    } catch {
      return null;
    }
  }

  function reconcileBoard(platform, records, context = {}) {
    const current = new Map(
      (records || []).filter(record => record?.identityKey)
        .map(record => [record.identityKey, detached(record)])
    );
    const previous = observedBoards.get(platform) || new Map();
    for (const [identityKey, prior] of previous) {
      if (current.has(identityKey)) continue;
      const replacement = [...current.values()].find(item =>
        item.identityKey !== identityKey &&
        (item.routeId || item.route || "") === (prior.routeId || prior.route || "") &&
        (item.destination || "") === (prior.destination || "")
      );
      record("ARRIVAL_DISAPPEARED", {
        platform,
        identityKey,
        routeId: prior.routeId || prior.route || "",
        classification: classifyRemoval({
          previous: prior,
          currentEvidence: context.evidenceByIdentity?.[identityKey] || null,
          currentCandidate: context.candidateByIdentity?.[identityKey] || null,
          currentAfterPlatform: context.afterPlatformByIdentity?.[identityKey] || null,
          currentAfterEngine: context.afterEngineByIdentity?.[identityKey] || null,
          lockState: context.lockStateByIdentity?.[identityKey] || null,
          platformUnavailable: context.platformUnavailable === true,
          routeLimited: context.routeLimitedIdentityKeys?.includes(identityKey) === true,
          replacementIdentity: replacement?.identityKey || null
        }),
        replacementIdentityKey: replacement?.identityKey || null,
        prior
      });
    }
    for (const [identityKey, item] of current) {
      if (!previous.has(identityKey)) {
        const earlier = [...state.events].reverse().find(event =>
          event.type === "ARRIVAL_DISAPPEARED" && event.identityKey === identityKey
        );
        record(earlier ? "ARRIVAL_RETURNED" : "ARRIVAL_APPEARED", {
          platform,
          identityKey,
          sameExactIdentity: Boolean(earlier),
          elapsedMs: earlier ? now() - earlier.timestampMs : null,
          refreshReason: context.refreshReason || "UNKNOWN",
          tripUpdateReturned: item.tripUpdatePresent ?? null,
          vehiclePositionReturned: item.vehiclePositionPresent ?? null,
          item
        });
      }
    }
    observedBoards.set(platform, current);
  }

  function clear() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    state = normalizeTraceState(null, now(), { retentionMs, maxEvents, maxBytes });
    observedBoards = new Map();
    try {
      storage?.removeItem(TRACE_STORAGE_KEY);
      persistenceError = "";
    } catch (error) {
      persistenceError = String(error?.message || error);
    }
  }

  function inspect() {
    state = normalizeTraceState(state, now(), { retentionMs, maxEvents, maxBytes });
    return detached({
      enabled: true,
      eventCount: state.events.length,
      oldestTimestamp: state.events[0]?.timestamp || null,
      newestTimestamp: state.events.at(-1)?.timestamp || null,
      persistenceError,
      events: state.events
    });
  }

  function exportPayload(metadata = {}) {
    const snapshot = inspect();
    return sanitize({
      schemaVersion: FOREVER_ENGINE_TRACE_SCHEMA_VERSION,
      deployedCommitSha: metadata.deployedCommitSha || "unknown",
      activeExperimentFlags: metadata.activeExperimentFlags || {},
      selectedContext: metadata.selectedContext || {},
      traceStartedAt: snapshot.oldestTimestamp,
      traceEndedAt: snapshot.newestTimestamp,
      privacy: "Local-only diagnostic trace. No authentication tokens, precise location, or network upload.",
      events: snapshot.events
    });
  }

  return Object.freeze({ record, reconcileBoard, clear, inspect, exportPayload, persistNow });
}

export function createBrowserTraceRecorder(options = {}) {
  return createTraceRecorder({ storage: window.localStorage, ...options });
}

export function observeDecision(recorder, type, result, details = {}) {
  try {
    recorder?.record(type, details);
  } catch {
    // An observer is never allowed to affect the engine result.
  }
  return result;
}
