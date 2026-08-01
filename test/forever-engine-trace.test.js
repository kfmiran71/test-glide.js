import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import {
  TRACE_MAX_EVENTS,
  TRACE_MAX_BYTES,
  TRACE_RETENTION_MS,
  TRACE_STORAGE_KEY,
  classifyRemoval,
  createMemoryStorage,
  createTraceRecorder,
  normalizeTraceState,
  observeDecision
} from "../public/forever-engine-trace.js";

const html = fs.readFileSync(new URL("../public/arrivals.html", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");

function immediateTimer(callback) {
  callback();
  return 1;
}

test("trace activation is exact and disabled mode imports no module", () => {
  assert.match(html, /params\.get\("foreverEngineTrace"\) === "1"/);
  assert.match(html, /foreverEngineTraceEnabled\s*\? import\("\.\/forever-engine-trace\.js"\)\s*:\s*null/);
  assert.match(html, /if \(!foreverEngineTraceEnabled\) return ""/);
  assert.match(server, /req\.query\.foreverEngineTrace === "1"/);
  assert.match(server, /\.\.\.\(foreverEngineTraceEnabled\s*\?\s*\{/);
});

test("observer emits a decision and returns the identical engine result", () => {
  const recorder = createTraceRecorder({
    storage: createMemoryStorage(),
    now: () => 1000,
    setTimer: immediateTimer
  });
  const result = Object.freeze([{ identityKey: "trip|date", time: "1" }]);
  assert.equal(observeDecision(recorder, "STAGE", result, { reason: "UNCHANGED" }), result);
  assert.equal(recorder.inspect().events[0].type, "STAGE");
});

test("same exact identity disappearance and return are recorded", () => {
  let now = 1000;
  const recorder = createTraceRecorder({
    storage: createMemoryStorage(), now: () => now, setTimer: immediateTimer
  });
  const trip = { identityKey: "trip-a|20260731", routeId: "7", finalBoard: true };
  recorder.reconcileBoard("718S", [trip], { refreshReason: "PAGE_LOAD" });
  now = 2000;
  recorder.reconcileBoard("718S", [], { refreshReason: "NORMAL_15_SECOND_REFRESH" });
  now = 3000;
  recorder.reconcileBoard("718S", [trip], { refreshReason: "NORMAL_15_SECOND_REFRESH" });
  const events = recorder.inspect().events;
  assert.deepEqual(events.map(event => event.type), [
    "ARRIVAL_APPEARED", "ARRIVAL_DISAPPEARED", "ARRIVAL_RETURNED"
  ]);
  assert.equal(events[2].sameExactIdentity, true);
  assert.equal(events[2].elapsedMs, 1000);
});

test("different identity replacement is not classified as a return", () => {
  let now = 1000;
  const recorder = createTraceRecorder({
    storage: createMemoryStorage(), now: () => now, setTimer: immediateTimer
  });
  recorder.reconcileBoard("718S", [{
    identityKey: "7-a|date", routeId: "7", destination: "34 St-Hudson Yards"
  }]);
  now = 2000;
  recorder.reconcileBoard("718S", [{
    identityKey: "7-b|date", routeId: "7", destination: "34 St-Hudson Yards"
  }]);
  const events = recorder.inspect().events;
  assert.equal(events.at(-1).type, "ARRIVAL_APPEARED");
  assert.equal(events.at(-1).sameExactIdentity, false);
  assert.equal(events[1].classification, "REPLACED_BY_DIFFERENT_IDENTITY");
  assert.equal(events[1].replacementIdentityKey, "7-b|date");
});

test("feed absence and downstream pipeline filtering remain distinguishable", () => {
  assert.equal(classifyRemoval({ previous: {}, currentEvidence: null }), "ABSENT_FROM_FRESH_FEED");
  assert.equal(classifyRemoval({
    previous: {},
    currentEvidence: { rawCountdown: -1 },
    currentCandidate: null
  }), "NEGATIVE_CANDIDATE_FILTER");
  assert.equal(classifyRemoval({
    previous: {}, currentEvidence: {}, currentCandidate: {}, currentAfterPlatform: null
  }), "PLATFORM_UNAVAILABLE");
  assert.equal(classifyRemoval({
    previous: {}, currentEvidence: {}, currentCandidate: {}, currentAfterPlatform: {},
    lockState: { released: true }
  }), "DEPARTURE_LOCK_RELEASE");
});

test("storage survives a recorder recreation representing iframe reload", () => {
  const storage = createMemoryStorage();
  const first = createTraceRecorder({ storage, now: () => 1000, setTimer: immediateTimer });
  first.record("DOCUMENT_LOADED");
  first.persistNow();
  const second = createTraceRecorder({ storage, now: () => 2000, setTimer: immediateTimer });
  assert.equal(second.inspect().eventCount, 1);
  assert.equal(second.inspect().events[0].type, "DOCUMENT_LOADED");
});

test("events expire at ninety minutes and deterministic ring eviction keeps newest", () => {
  const now = TRACE_RETENTION_MS + 1000;
  const normalized = normalizeTraceState({
    nextSequence: TRACE_MAX_EVENTS + 3,
    events: [
      { sequence: 1, timestampMs: 999 },
      ...Array.from({ length: TRACE_MAX_EVENTS + 1 }, (_, index) => ({
        sequence: index + 2,
        timestampMs: 1000 + index
      }))
    ]
  }, now);
  assert.equal(normalized.events.length, TRACE_MAX_EVENTS);
  assert.equal(normalized.events[0].sequence, 3);
  assert.equal(normalized.events.at(-1).sequence, TRACE_MAX_EVENTS + 2);
});

test("export strips secrets, credential URLs and precise coordinates", () => {
  const recorder = createTraceRecorder({
    storage: createMemoryStorage(), now: () => 1000, setTimer: immediateTimer
  });
  recorder.record("SNAPSHOT", {
    token: "secret-value",
    lat: 40.7,
    lon: -73.9,
    requestUrl: "https://example.test/path?key=secret-value",
    safeStopId: "718S"
  });
  const exported = JSON.stringify(recorder.exportPayload({
    selectedContext: { stop: "718", route: "7" }
  }));
  assert.doesNotMatch(exported, /secret-value|40\.7|-73\.9/);
  assert.match(exported, /718S/);
  assert.match(exported, /Local-only diagnostic trace/);
});

test("persistence and export failures never throw into Arrivals", () => {
  const storage = {
    getItem() { throw new Error("read failed"); },
    setItem() { throw new Error("write failed"); },
    removeItem() { throw new Error("remove failed"); }
  };
  const recorder = createTraceRecorder({ storage, now: () => 1000, setTimer: immediateTimer });
  assert.doesNotThrow(() => recorder.record("SAFE"));
  assert.doesNotThrow(() => recorder.clear());
  assert.doesNotThrow(() => recorder.exportPayload());
});

test("7 and 7X exact identities remain independent on the same platform", () => {
  const recorder = createTraceRecorder({
    storage: createMemoryStorage(), now: () => 1000, setTimer: immediateTimer
  });
  recorder.reconcileBoard("718S", [
    { identityKey: "local|date", routeId: "7" },
    { identityKey: "express|date", routeId: "7X" }
  ]);
  const appeared = recorder.inspect().events.filter(event => event.type === "ARRIVAL_APPEARED");
  assert.deepEqual(appeared.map(event => event.identityKey).sort(), ["express|date", "local|date"]);
});

test("refresh, selection, reload, visibility and stale-response events are wired", () => {
  for (const eventType of [
    "DOCUMENT_LOADED", "NORMAL_15_SECOND_REFRESH", "STATION_SELECTION",
    "ROUTE_SELECTION", "VISIBILITY_CHANGED", "STALE_RESPONSE_REJECTED",
    "ERROR_BOARD_PRESERVED", "FULL_BOARD_COMMIT"
  ]) {
    assert.match(html, new RegExp(eventType));
  }
});

test("baseline response shape is gated and server diagnostics carry no feed URL", () => {
  assert.match(server, /foreverEngineTraceEnabled\s*\?\s*\{/);
  assert.doesNotMatch(server.slice(server.indexOf("foreverEngineTrace: {")), /feedUrl|x-api-key/);
});

test("classic inline script parses and trace module stays a separate dynamic import", () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0][1]));
  assert.doesNotMatch(html, /<script\s+type=["']module["']/);
});

test("storage is bounded and uses one versioned local-only key", () => {
  assert.equal(TRACE_STORAGE_KEY, "commuterEye.foreverEngine.arrivalTrace.v1");
  assert.ok(TRACE_MAX_EVENTS <= 2400);
  assert.ok(TRACE_MAX_BYTES <= 1500000);
  const normalized = normalizeTraceState({
    events: Array.from({ length: 20 }, (_, index) => ({
      sequence: index + 1,
      timestampMs: 1000 + index,
      payload: "x".repeat(200)
    }))
  }, 2000, { retentionMs: 5000, maxEvents: 100, maxBytes: 1000 });
  assert.ok(JSON.stringify(normalized.events).length <= 1000);
  assert.ok(normalized.events.at(-1).sequence === 20);
});

test("phone export prefers the native share sheet and retains download fallback", () => {
  assert.match(html, /navigator\.canShare\?\.\(\{ files: \[file\] \}\)/);
  assert.match(html, /await navigator\.share\(/);
  assert.match(html, /link\.download = fileName/);
});
