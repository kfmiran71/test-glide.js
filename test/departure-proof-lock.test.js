import test from "node:test";
import assert from "node:assert/strict";
import {
  createDepartureProofDiagnostics,
  RELEASE_REASONS,
  experimentalBoardArrivals,
  inspectDepartureProofState,
  reconcileDepartureProofLocks,
  runGlideMutationIfBaseline
} from "../public/departure-proof-lock.js";
import fs from "node:fs";

const NOW = Date.UTC(2026, 6, 30, 12, 0, 0);
const TARGET = "A24N";

function arrival(overrides = {}) {
  return {
    identityKey: "trip-1|20260730",
    tripId: "trip-1",
    startDate: "20260730",
    route: "A",
    platformId: TARGET,
    direction: "Northbound",
    station: "Inwood",
    time: "0",
    ...overrides
  };
}

function evidence(overrides = {}) {
  return {
    identityKey: "trip-1|20260730",
    tripId: "trip-1",
    startDate: "20260730",
    route: "A",
    targetStop: TARGET,
    targetStopPresent: true,
    targetStopSequence: 10,
    tripUpdatePresent: true,
    tripUpdateProgressionSequence: null,
    stopUpdates: [
      { stopId: TARGET, stopSequence: 10, eventTime: NOW / 1000 },
      { stopId: "A25N", stopSequence: 11, eventTime: NOW / 1000 + 120 }
    ],
    vehiclePositionPresent: false,
    vehiclePositionAmbiguous: false,
    vehicle: null,
    feedTimestamp: NOW / 1000,
    ...overrides
  };
}

function reconcile(state, arrivals, evidences, time = NOW) {
  return reconcileDepartureProofLocks(
    state,
    { arrivals, evidence: evidences },
    time
  );
}

test("exact trip reaches zero with target evidence and becomes inspectable", () => {
  const state = reconcile(null, [arrival()], [evidence()]);
  const inspected = inspectDepartureProofState(state);
  assert.equal(inspected.active.length, 1);
  assert.equal(inspected.active[0].identityKey, "trip-1|20260730");
  assert.equal(inspected.active[0].targetStopSequence, 10);
  assert.equal(inspected.active[0].evidenceClassification, "AT_OR_BEFORE_TARGET");
  assert.equal(inspected.active[0].releaseReason, null);
});

test("prediction expiry and negative countdown never raise or remove lock", () => {
  let state = reconcile(null, [arrival()], [evidence()]);
  state = reconcile(
    state,
    [arrival({ time: "-8" })],
    [evidence()],
    NOW + 8 * 60_000
  );
  const board = experimentalBoardArrivals(state, [arrival({ time: "-8" })]);
  assert.equal(board.length, 1);
  assert.equal(board[0].time, "0");
  assert.equal(board[0].departureProofLocked, true);
});

test("TripUpdate disappearance, return, staleness, and unavailable evidence retain lock", () => {
  let state = reconcile(null, [arrival()], [evidence()]);
  state = reconcile(state, [], []);
  assert.equal(Object.keys(state.active).length, 1);
  assert.equal(state.active["trip-1|20260730"].evidenceClassification, "EVIDENCE_UNAVAILABLE");

  state = reconcile(state, [], [evidence({ feedTimestamp: NOW / 1000 - 3600 })]);
  assert.equal(Object.keys(state.active).length, 1);

  state = reconcile(state, [arrival({ time: "-2" })], [evidence()]);
  assert.equal(Object.keys(state.active).length, 1);
});

test("same-route trains and refresh reordering cannot displace or inherit a lock", () => {
  const state = reconcile(null, [arrival()], [evidence()]);
  const other = [
    arrival({ identityKey: "trip-4|20260730", tripId: "trip-4", time: "4" }),
    arrival({ identityKey: "trip-2|20260730", tripId: "trip-2", time: "2" }),
    arrival({ identityKey: "trip-3|20260730", tripId: "trip-3", time: "3" }),
    arrival({ identityKey: "trip-5|20260730", tripId: "trip-5", time: "1" })
  ];
  const board = experimentalBoardArrivals(state, other.reverse());
  assert.equal(board.length, 3);
  assert.equal(board[0].identityKey, "trip-1|20260730");
  assert.equal(board.filter(item => item.departureProofLocked).length, 1);
});

test("matching VehiclePosition downstream releases with exact reason", () => {
  let state = reconcile(null, [arrival()], [evidence()]);
  state = reconcile(state, [], [
    evidence({
      vehiclePositionPresent: true,
      vehicle: { stopId: "A25N", currentStopSequence: 11, currentStatus: 1 }
    })
  ]);
  assert.equal(Object.keys(state.active).length, 0);
  assert.equal(state.released[0].releaseReason, RELEASE_REASONS.VEHICLE_DOWNSTREAM);
});

test("matching TripUpdate timed downstream releases with exact reason", () => {
  let state = reconcile(null, [arrival()], [evidence()]);
  state = reconcile(state, [], [
    evidence({
      tripUpdateProgressionSequence: 11
    })
  ]);
  assert.equal(
    state.released[0].releaseReason,
    RELEASE_REASONS.TRIP_UPDATE_DOWNSTREAM
  );
});

test("removed target with downstream updates releases with exact reason", () => {
  let state = reconcile(null, [arrival()], [evidence()]);
  state = reconcile(state, [], [
    evidence({
      targetStopPresent: false,
      targetStopSequence: null,
      stopUpdates: [
        { stopId: "A25N", stopSequence: 11, eventTime: NOW / 1000 + 60 }
      ]
    })
  ]);
  assert.equal(
    state.released[0].releaseReason,
    RELEASE_REASONS.TARGET_STOP_REMOVED_WITH_DOWNSTREAM_EVIDENCE
  );
});

test("similar trip and mismatched or ambiguous vehicle cannot affect exact lock", () => {
  let state = reconcile(null, [arrival()], [evidence()]);
  state = reconcile(state, [], [
    evidence({
      identityKey: "trip-2|20260730",
      tripId: "trip-2",
      vehiclePositionPresent: true,
      vehicle: { stopId: "A25N", currentStopSequence: 99, currentStatus: 1 }
    })
  ]);
  assert.equal(Object.keys(state.active).length, 1);

  state = reconcile(state, [], [
    evidence({
      vehiclePositionPresent: false,
      vehiclePositionAmbiguous: true,
      vehicle: null
    })
  ]);
  assert.equal(Object.keys(state.active).length, 1);
});

test("no age, stale feed, disappearance, or countdown condition releases", () => {
  let state = reconcile(null, [arrival()], [evidence()]);
  state = reconcile(
    state,
    [arrival({ time: "-999999" })],
    [evidence({ feedTimestamp: 1 })],
    NOW + 10 * 365 * 24 * 60 * 60_000
  );
  state = reconcile(state, [], [], NOW + 20 * 365 * 24 * 60 * 60_000);
  assert.equal(Object.keys(state.active).length, 1);
  assert.equal(state.released.length, 0);
});

test("a trip cannot lock without exact identity, zero, target evidence, and sequence", () => {
  const nonZero = reconcile(null, [arrival({ time: "1" })], [evidence()]);
  assert.equal(Object.keys(nonZero.active).length, 0);

  const noTarget = reconcile(null, [arrival()], [
    evidence({ targetStopPresent: false })
  ]);
  assert.equal(Object.keys(noTarget.active).length, 0);

  const noSequence = reconcile(null, [arrival()], [
    evidence({ targetStopSequence: null })
  ]);
  assert.equal(Object.keys(noSequence.active).length, 0);
});

test("read-only diagnostics expose active and released audit records", () => {
  const state = reconcile(null, [arrival()], [evidence()]);
  const states = new Map([[TARGET, state]]);
  const diagnostics = createDepartureProofDiagnostics(states);
  const inspected = diagnostics.inspect();

  assert.equal(Object.isFrozen(diagnostics), true);
  assert.equal(Object.isFrozen(inspected), true);
  assert.equal(inspected.enabled, true);
  assert.equal(inspected.active[0].tripId, "trip-1");
  assert.equal(inspected.active[0].selectedStop, TARGET);
});

test("released exact identity is tombstoned and cannot re-lock", () => {
  let state = reconcile(null, [arrival()], [evidence()]);
  state = reconcile(state, [], [
    evidence({
      vehiclePositionPresent: true,
      vehicle: { stopId: "A25N", currentStopSequence: 11, currentStatus: 1 }
    })
  ]);
  state = reconcile(state, [arrival()], [evidence()]);

  assert.equal(Object.keys(state.active).length, 0);
  assert.equal(state.released.length, 1);
  assert.equal(
    state.tombstones["trip-1|20260730"].releaseReason,
    RELEASE_REASONS.VEHICLE_DOWNSTREAM
  );
});

test("a different exact identity may lock after another identity is tombstoned", () => {
  let state = reconcile(null, [arrival()], [evidence()]);
  state = reconcile(state, [], [
    evidence({
      vehiclePositionPresent: true,
      vehicle: { currentStopSequence: 11 }
    })
  ]);

  const secondArrival = arrival({
    identityKey: "trip-2|20260730",
    tripId: "trip-2"
  });
  const secondEvidence = evidence({
    identityKey: "trip-2|20260730",
    tripId: "trip-2"
  });
  state = reconcile(state, [secondArrival], [secondEvidence]);

  assert.deepEqual(Object.keys(state.active), ["trip-2|20260730"]);
});

test("temporary disappearance does not create a tombstone", () => {
  let state = reconcile(null, [arrival()], [evidence()]);
  state = reconcile(state, [], []);

  assert.equal(Object.keys(state.active).length, 1);
  assert.deepEqual(state.tombstones, {});
});

test("every authorized release reason creates its exact tombstone", () => {
  const releaseEvidence = [
    [
      RELEASE_REASONS.VEHICLE_DOWNSTREAM,
      evidence({
        vehiclePositionPresent: true,
        vehicle: { currentStopSequence: 11 }
      })
    ],
    [
      RELEASE_REASONS.TRIP_UPDATE_DOWNSTREAM,
      evidence({ tripUpdateProgressionSequence: 11 })
    ],
    [
      RELEASE_REASONS.TARGET_STOP_REMOVED_WITH_DOWNSTREAM_EVIDENCE,
      evidence({
        targetStopPresent: false,
        stopUpdates: [{ stopId: "A25N", stopSequence: 11 }]
      })
    ]
  ];

  for (const [reason, downstreamEvidence] of releaseEvidence) {
    let state = reconcile(null, [arrival()], [evidence()]);
    state = reconcile(state, [], [downstreamEvidence]);
    assert.equal(state.tombstones["trip-1|20260730"].releaseReason, reason);
  }
});

test("diagnostics are deeply detached and recursively frozen", () => {
  let state = reconcile(null, [arrival()], [
    evidence({
      vehiclePositionPresent: true,
      vehicle: { stopId: TARGET, currentStopSequence: 10, currentStatus: 1 }
    })
  ]);
  const states = new Map([[TARGET, state]]);
  const diagnostics = createDepartureProofDiagnostics(states);
  const first = diagnostics.inspect();
  const before = JSON.stringify(first);

  assert.notEqual(first.active[0], state.active["trip-1|20260730"]);
  assert.notEqual(first.active[0].arrival, state.active["trip-1|20260730"].arrival);
  assert.notEqual(
    first.active[0].lastSupportingEvidence,
    state.active["trip-1|20260730"].lastSupportingEvidence
  );
  assert.notEqual(
    first.active[0].lastSupportingEvidence.stopUpdates,
    state.active["trip-1|20260730"].lastSupportingEvidence.stopUpdates
  );
  assert.notEqual(
    first.active[0].lastSupportingEvidence.vehicle,
    state.active["trip-1|20260730"].lastSupportingEvidence.vehicle
  );

  assert.throws(() => { first.active[0].arrival.time = "99"; }, TypeError);
  assert.throws(() => {
    first.active[0].lastSupportingEvidence.stopUpdates[0].stopId = "BAD";
  }, TypeError);
  assert.throws(() => {
    first.active[0].lastSupportingEvidence.vehicle.currentStopSequence = 999;
  }, TypeError);
  assert.throws(() => { first.active.push({}); }, TypeError);
  assert.throws(() => { first.released.push({}); }, TypeError);
  assert.throws(() => { first.tombstones.push({}); }, TypeError);

  assert.equal(JSON.stringify(diagnostics.inspect()), before);
  assert.deepEqual(Object.keys(diagnostics).sort(), ["inspect"]);
});

test("released records and tombstones are detached from diagnostics", () => {
  let state = reconcile(null, [arrival()], [evidence()]);
  state = reconcile(state, [], [
    evidence({
      vehiclePositionPresent: true,
      vehicle: { stopId: "A25N", currentStopSequence: 11, currentStatus: 1 }
    })
  ]);
  const diagnostics = createDepartureProofDiagnostics(new Map([[TARGET, state]]));
  const first = diagnostics.inspect();
  const before = JSON.stringify(first);

  assert.notEqual(first.released[0], state.released[0]);
  assert.notEqual(first.released[0].arrival, state.released[0].arrival);
  assert.notEqual(
    first.tombstones[0],
    state.tombstones["trip-1|20260730"]
  );
  assert.throws(() => { first.released[0].arrival.time = "99"; }, TypeError);
  assert.throws(() => { first.tombstones[0].releaseReason = "BAD"; }, TypeError);
  assert.equal(JSON.stringify(diagnostics.inspect()), before);
  assert.equal(Object.isFrozen(state.tombstones["trip-1|20260730"]), false);
});

test("experimental mode skips Glide mutation and baseline invokes it", async () => {
  let calls = 0;
  const mutate = async () => {
    calls++;
    return "ok";
  };

  const experimental = await runGlideMutationIfBaseline(true, mutate);
  assert.deepEqual(experimental, { skipped: true });
  assert.equal(calls, 0);

  const baseline = await runGlideMutationIfBaseline(false, mutate);
  assert.deepEqual(baseline, { skipped: false, result: "ok" });
  assert.equal(calls, 1);
});

test("baseline client remains a classic script and imports no module without toggle", () => {
  const html = fs.readFileSync(
    new URL("../public/arrivals.html", import.meta.url),
    "utf8"
  );
  assert.match(html, /<script>\s*const params/);
  assert.doesNotMatch(html, /<script type="module">/);
  assert.match(
    html,
    /departureProofLockEnabled\s*\? import\("\.\/departure-proof-lock\.js"\)\s*:\s*null/
  );
});
