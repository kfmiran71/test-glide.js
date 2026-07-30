import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  GATE_DISPOSITIONS,
  GATE_STATES,
  VEHICLE_STATUSES,
  arrivalProofBoardArrivals,
  createArrivalProofDiagnostics,
  initialArrivalProofGateState,
  inspectArrivalProofState,
  reconcileArrivalProofGates,
  suppressArrivalProofGates
} from "../public/arrival-proof-gate.js";
import {
  RELEASE_REASONS,
  reconcileDepartureProofLocks
} from "../public/departure-proof-lock.js";

const NOW = Date.UTC(2026, 6, 30, 17, 0, 0);
const FEED = NOW / 1000;
const TARGET = "701N";

function arrival(overrides = {}) {
  return {
    identityKey: "trip-1|20260730",
    tripId: "trip-1",
    startDate: "20260730",
    route: "7",
    platformId: TARGET,
    direction: "Northbound",
    station: "Mets-Willets Point",
    time: "1",
    ...overrides
  };
}

function evidence(overrides = {}) {
  return {
    identityKey: "trip-1|20260730",
    tripId: "trip-1",
    startDate: "20260730",
    route: "7",
    targetStop: TARGET,
    targetStopPresent: true,
    targetStopSequence: 22,
    tripUpdatePresent: true,
    stopUpdates: [{ stopId: TARGET, stopSequence: 22, eventTime: FEED + 30 }],
    vehiclePositionPresent: true,
    vehiclePositionAmbiguous: false,
    vehicle: {
      stopId: TARGET,
      currentStopSequence: 22,
      currentStopSequenceExplicit: true,
      currentStatus: VEHICLE_STATUSES.IN_TRANSIT_TO,
      currentStatusExplicit: true,
      timestamp: FEED - 10
    },
    feedTimestamp: FEED,
    feedSucceeded: true,
    feedStale: false,
    ...overrides
  };
}

function reconcile(state, arrivals = [arrival()], evidences = [evidence()], now = NOW) {
  return reconcileArrivalProofGates(
    state,
    { arrivals, evidence: evidences },
    now
  );
}

test("1 exact trip counts normally above one", () => {
  const state = reconcile(null, [arrival({ time: "2" })]);
  assert.equal(Object.keys(state.active).length, 0);
  assert.equal(arrivalProofBoardArrivals(state, [arrival({ time: "2" })])[0].time, "2");
});

test("2 explicit IN_TRANSIT_TO at target gates at one", () => {
  const state = reconcile(null);
  assert.equal(state.active[arrival().identityKey].displayedCountdown, 1);
  assert.equal(state.active[arrival().identityKey].lastTransitionReason, "EXPLICIT_IN_TRANSIT_TO_TARGET");
});

test("3 zero prediction remains displayed at one while in transit", () => {
  const state = reconcile(null, [arrival({ time: "0" })]);
  assert.equal(arrivalProofBoardArrivals(state, [arrival({ time: "0" })])[0].time, "1");
});

test("4 negative prediction remains displayed at one", () => {
  const state = reconcile(null, [arrival({ time: "-4" })]);
  assert.equal(arrivalProofBoardArrivals(state, [arrival({ time: "-4" })])[0].time, "1");
});

test("5 jump from two to zero creates a gate", () => {
  let state = reconcile(null, [arrival({ time: "2" })]);
  state = reconcile(state, [arrival({ time: "0" })]);
  assert.equal(state.active[arrival().identityKey].state, GATE_STATES.GATED_AT_ONE);
});

for (const [number, status, label] of [
  [6, VEHICLE_STATUSES.INCOMING_AT, "INCOMING_AT"],
  [7, VEHICLE_STATUSES.STOPPED_AT, "STOPPED_AT"]
]) {
  test(`${number} exact target ${label} promotes to zero`, () => {
    const state = reconcile(null, [arrival({ time: "0" })], [
      evidence({ vehicle: { ...evidence().vehicle, currentStatus: status } })
    ]);
    const board = arrivalProofBoardArrivals(state, []);
    assert.equal(board[0].time, "0");
    assert.equal(state.confirmed[0].transferredToDepartureProofLock, true);
  });
}

test("8 defaulted IN_TRANSIT_TO is unknown", () => {
  const state = reconcile(null, [arrival({ time: "0" })], [
    evidence({
      vehicle: {
        ...evidence().vehicle,
        currentStatus: null,
        currentStatusExplicit: false
      }
    })
  ]);
  assert.equal(state.active[arrival().identityKey].lastTransitionReason, "ENTRY_EVIDENCE_UNKNOWN");
});

test("9 missing VehiclePosition retains gate", () => {
  const state = reconcile(null, undefined, [
    evidence({ vehiclePositionPresent: false, vehicle: null })
  ]);
  assert.equal(Object.keys(state.active).length, 1);
});

test("10 stale VehiclePosition cannot confirm", () => {
  const state = reconcile(null, undefined, [
    evidence({
      vehicle: {
        ...evidence().vehicle,
        currentStatus: VEHICLE_STATUSES.INCOMING_AT,
        timestamp: FEED - 121
      }
    })
  ]);
  assert.equal(state.confirmed.length, 0);
});

test("11 mismatched VehiclePosition cannot confirm", () => {
  const state = reconcile(null, undefined, [
    evidence({ vehiclePositionPresent: false, vehicle: null }),
    evidence({
      identityKey: "trip-2|20260730",
      tripId: "trip-2",
      vehicle: { ...evidence().vehicle, currentStatus: VEHICLE_STATUSES.INCOMING_AT }
    })
  ]);
  assert.equal(Object.keys(state.active).length, 1);
});

test("12 VehiclePosition at another stop cannot confirm", () => {
  const state = reconcile(null, undefined, [
    evidence({
      vehicle: {
        ...evidence().vehicle,
        stopId: "702N",
        currentStatus: VEHICLE_STATUSES.INCOMING_AT
      }
    })
  ]);
  assert.equal(state.confirmed.length, 0);
});

test("13 similar trip cannot inherit gate", () => {
  let state = reconcile(null);
  state = reconcile(state, [
    arrival({ identityKey: "trip-2|20260730", tripId: "trip-2", time: "0" })
  ], [
    evidence({
      identityKey: "trip-2|20260730",
      tripId: "trip-2",
      vehicle: { ...evidence().vehicle, currentStatus: VEHICLE_STATUSES.INCOMING_AT }
    })
  ]);
  assert.ok(state.active["trip-1|20260730"]);
});

test("14 new same-route trip cannot displace gated identity", () => {
  const state = reconcile(null);
  const board = arrivalProofBoardArrivals(state, [
    arrival({ identityKey: "trip-2|20260730", tripId: "trip-2", time: "0" })
  ]);
  assert.ok(board.some(item => item.identityKey === "trip-1|20260730"));
});

test("15 refresh reordering preserves exact gate", () => {
  let state = reconcile(null);
  state = reconcile(state, [
    arrival({ identityKey: "trip-2|20260730", tripId: "trip-2", time: "2" }),
    arrival({ time: "-1" })
  ], [evidence()]);
  assert.ok(state.active["trip-1|20260730"]);
});

test("16 temporary TripUpdate disappearance retains gate", () => {
  let state = reconcile(null);
  state = reconcile(state, [], []);
  assert.ok(state.active["trip-1|20260730"]);
});

test("17 failed feed retains gate", () => {
  let state = reconcile(null);
  state = reconcile(state, [], [evidence({ feedSucceeded: false })]);
  assert.ok(state.active["trip-1|20260730"]);
});

test("18 stale feed retains gate", () => {
  let state = reconcile(null);
  state = reconcile(state, [], [evidence({ feedStale: true })]);
  assert.ok(state.active["trip-1|20260730"]);
});

test("19 exact downstream evidence bypasses gate", () => {
  let state = reconcile(null);
  state = reconcile(state, [], [
    evidence({
      vehicle: { ...evidence().vehicle, stopId: "702N", currentStopSequence: 23, timestamp: FEED + 1 }
    })
  ], NOW + 1000);
  assert.equal(state.bypassed[0].disposition, GATE_DISPOSITIONS.TARGET_PASSED_WITHOUT_ENTRY_CONFIRMATION);
});

test("20 bypass tombstone prevents recreation", () => {
  let state = reconcile(null);
  state = reconcile(state, [], [
    evidence({
      vehicle: { ...evidence().vehicle, currentStopSequence: 23, timestamp: FEED + 1 }
    })
  ]);
  state = reconcile(state);
  assert.equal(Object.keys(state.active).length, 0);
});

test("21 a different identity remains eligible", () => {
  let state = reconcile(null);
  state = reconcile(state, [], [
    evidence({ vehicle: { ...evidence().vehicle, currentStopSequence: 23, timestamp: FEED + 1 } })
  ]);
  state = reconcile(state, [
    arrival({ identityKey: "trip-2|20260730", tripId: "trip-2" })
  ], [
    evidence({ identityKey: "trip-2|20260730", tripId: "trip-2" })
  ]);
  assert.ok(state.active["trip-2|20260730"]);
});

test("22 entry confirmation transfers exact identity to Departure-Proof Lock", () => {
  const gate = reconcile(null, [arrival({ time: "0" })], [
    evidence({ vehicle: { ...evidence().vehicle, currentStatus: VEHICLE_STATUSES.INCOMING_AT } })
  ]);
  const board = arrivalProofBoardArrivals(gate, []);
  const lock = reconcileDepartureProofLocks(null, { arrivals: board, evidence: [evidence()] }, NOW);
  assert.ok(lock.active["trip-1|20260730"]);
});

test("23 Departure-Proof Lock retains the confirmed zero", () => {
  let lock = reconcileDepartureProofLocks(null, { arrivals: [arrival({ time: "0" })], evidence: [evidence()] }, NOW);
  lock = reconcileDepartureProofLocks(lock, { arrivals: [], evidence: [] }, NOW + 60_000);
  assert.ok(lock.active["trip-1|20260730"]);
});

test("24 Departure-Proof Lock release reasons remain unchanged", () => {
  assert.deepEqual(Object.values(RELEASE_REASONS).sort(), [
    "TARGET_STOP_REMOVED_WITH_DOWNSTREAM_EVIDENCE",
    "TRIP_UPDATE_DOWNSTREAM",
    "VEHICLE_DOWNSTREAM"
  ]);
});

test("25 platform suppression prevents gate creation by filtering arrivals", () => {
  const state = reconcile(null, [], [evidence()]);
  assert.equal(Object.keys(state.active).length, 0);
});

test("26 platform suppression removes active gate", () => {
  const state = suppressArrivalProofGates(reconcile(null), [{
    suppressionApplied: true,
    route: "7",
    resolvedPlatform: TARGET,
    alertId: "alert-1"
  }], NOW);
  assert.equal(state.suppressed[0].state, GATE_STATES.PLATFORM_UNAVAILABLE);
});

test("27 restoration allows a different current trip to gate", () => {
  let state = suppressArrivalProofGates(reconcile(null), [{
    suppressionApplied: true, route: "7", resolvedPlatform: TARGET
  }], NOW);
  state = reconcile(state, [
    arrival({ identityKey: "trip-2|20260730", tripId: "trip-2" })
  ], [
    evidence({ identityKey: "trip-2|20260730", tripId: "trip-2" })
  ]);
  assert.ok(state.active["trip-2|20260730"]);
});

test("28 per-route limiting protects gated trip", () => {
  const state = reconcile(null);
  const arrivals = [2, 3, 4, 5].map(number =>
    arrival({ identityKey: `trip-${number}|20260730`, tripId: `trip-${number}`, time: String(number) })
  );
  const board = arrivalProofBoardArrivals(state, arrivals);
  assert.equal(board.length, 3);
  assert.ok(board.some(item => item.identityKey === "trip-1|20260730"));
});

function activationPolicy(html) {
  const match = html.match(/function isArrivalProofGateEnabled\(searchParams\) \{[\s\S]*?\n\}/);
  assert.ok(match);
  return new Function("URLSearchParams", `${match[0]}; return value => isArrivalProofGateEnabled(new URLSearchParams(value));`)(URLSearchParams);
}

test("29 arrivalProofGate zero disables the feature", () => {
  const html = fs.readFileSync(new URL("../public/arrivals.html", import.meta.url), "utf8");
  assert.equal(activationPolicy(html)("arrivalProofGate=0"), false);
  assert.match(html, /arrivalProofGateEnabled\s*\? import\("\.\/arrival-proof-gate\.js"\)\s*:\s*null/);
});

test("30 Departure-Proof Lock remains independently enabled", () => {
  const html = fs.readFileSync(new URL("../public/arrivals.html", import.meta.url), "utf8");
  assert.match(html, /const departureProofLockEnabled =\s*isDepartureProofLockEnabled\(params\)/);
});

test("31 platform suppression remains independently enabled", () => {
  const html = fs.readFileSync(new URL("../public/arrivals.html", import.meta.url), "utf8");
  assert.match(html, /const platformAlertSuppressionEnabled =\s*isPlatformAlertSuppressionEnabled\(params\)/);
});

test("32 diagnostics are deeply detached and frozen", () => {
  const state = reconcile(null);
  const diagnostics = createArrivalProofDiagnostics(new Map([[TARGET, state]]));
  const first = diagnostics.inspect();
  const before = JSON.stringify(first);
  assert.notEqual(first.activeGates[0], state.active["trip-1|20260730"]);
  assert.throws(() => { first.activeGates[0].arrival.time = "99"; }, TypeError);
  assert.throws(() => { first.activeGates.push({}); }, TypeError);
  assert.equal(JSON.stringify(diagnostics.inspect()), before);
  assert.deepEqual(Object.keys(diagnostics), ["inspect"]);
  assert.equal(Object.isFrozen(inspectArrivalProofState(state).activeGates[0].lastTripUpdateEvidence), true);
});

test("33 default is on and emergency-off path preserves current classic embed", () => {
  const html = fs.readFileSync(new URL("../public/arrivals.html", import.meta.url), "utf8");
  const policy = activationPolicy(html);
  assert.equal(policy(""), true);
  assert.equal(policy("arrivalProofGate=1"), true);
  assert.equal(policy("arrivalProofGate=0"), false);
  assert.match(html, /<script>\s*const params/);
  assert.doesNotMatch(html, /<script type="module">/);
});
