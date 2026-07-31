import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  VEHICLE_STATUSES,
  arrivalProofBoardArrivals,
  createArrivalProofDiagnostics,
  reconcileArrivalProofGates
} from "../public/arrival-proof-gate.js";
import {
  RELEASE_REASONS,
  createDepartureProofDiagnostics,
  reconcileDepartureProofLocks
} from "../public/departure-proof-lock.js";
import {
  COMPATIBILITY_CLASSIFICATIONS
} from "../public/station-state-proof.js";

const NOW = Date.UTC(2026, 6, 30, 22, 30);
const FEED = NOW / 1000;
const TARGET = "723S";
const BEFORE = "721S";
const AFTER = "724S";
const LATER = "725S";
const ID = "132500_7..S|20260730";
const corrected = { stationStateProofEnabled: true };

function arrival(overrides = {}) {
  return {
    identityKey: ID,
    tripId: "132500_7..S",
    startDate: "20260730",
    route: "7",
    platformId: TARGET,
    direction: "Southbound",
    time: "0",
    ...overrides
  };
}

function vehicle(overrides = {}) {
  return {
    stopId: TARGET,
    currentStopSequence: 19,
    currentStopSequenceExplicit: true,
    currentStatus: VEHICLE_STATUSES.STOPPED_AT,
    currentStatusExplicit: true,
    timestamp: FEED - 10,
    ...overrides
  };
}

function evidence(overrides = {}) {
  return {
    identityKey: ID,
    tripId: "132500_7..S",
    startDate: "20260730",
    route: "7",
    targetStop: TARGET,
    targetStopPresent: true,
    targetStopSequence: 17,
    tripUpdatePresent: true,
    tripUpdateProgressionSequence: null,
    stopUpdates: [BEFORE, TARGET, AFTER, LATER].map(stopId => ({ stopId })),
    vehiclePositionPresent: true,
    vehiclePositionAmbiguous: false,
    vehicle: vehicle(),
    feedTimestamp: FEED,
    feedAgeSeconds: 5,
    vehicleAgeSeconds: 10,
    feedSucceeded: true,
    feedStale: false,
    ...overrides
  };
}

function compatibleEvidence(overrides = {}) {
  return evidence({
    compatibility: {
      classification: COMPATIBILITY_CLASSIFICATIONS.COMPATIBLE,
      reason: "EXPLICIT_TARGET_SEQUENCE_ZERO_OFFSET",
      contradictionReason: null,
      zeroOffsetProven: true
    },
    vehicle: vehicle({ currentStopSequence: 17 }),
    ...overrides
  });
}

function gate(state, arrivals = [arrival()], evidences = [evidence()]) {
  return reconcileArrivalProofGates(
    state,
    { arrivals, evidence: evidences },
    NOW,
    corrected
  );
}

function lock(state, arrivals = [arrival()], evidences = [evidence()]) {
  return reconcileDepartureProofLocks(
    state,
    { arrivals, evidence: evidences },
    NOW,
    corrected
  );
}

test("one fresh exact STOPPED_AT promotes and transfers to the lock", () => {
  const gated = gate(null);
  const board = arrivalProofBoardArrivals(gated, []);
  assert.equal(board[0].time, "0");
  assert.equal(gated.confirmed[0].entryDecision.reason, "FRESH_EXACT_TARGET_STOPPED_AT");
  const locked = lock(null, board, [evidence()]);
  assert.ok(locked.active[ID]);
});

test("compatible trip preserves deployed INCOMING_AT entry behavior", () => {
  const state = gate(
    null,
    [arrival()],
    [
      compatibleEvidence({
        vehicle: vehicle({
          currentStopSequence: 17,
          currentStatus: VEHICLE_STATUSES.INCOMING_AT
        })
      })
    ]
  );
  assert.equal(arrivalProofBoardArrivals(state, [])[0].time, "0");
  assert.equal(
    state.confirmed[0].entryDecision.mode,
    "DEPLOYED_COMPATIBLE"
  );
});

test("compatible state changes to sticky conflict before later classification", () => {
  let state = gate(
    null,
    [arrival({ time: "1" })],
    [
      compatibleEvidence({
        vehicle: vehicle({
          currentStopSequence: 17,
          currentStatus: VEHICLE_STATUSES.IN_TRANSIT_TO
        })
      })
    ]
  );
  assert.equal(
    state.active[ID].compatibilityState.classification,
    COMPATIBILITY_CLASSIFICATIONS.COMPATIBLE
  );

  state = gate(state, [], [
    evidence({
      compatibility: {
        classification: COMPATIBILITY_CLASSIFICATIONS.CONFLICT,
        reason: "EXPLICIT_ANCHOR_NONZERO_OFFSET",
        contradictionReason: "EXPLICIT_ANCHOR_NONZERO_OFFSET",
        zeroOffsetProven: false
      },
      vehicle: vehicle({
        currentStatus: VEHICLE_STATUSES.INCOMING_AT
      })
    })
  ]);
  assert.equal(arrivalProofBoardArrivals(state, [])[0].time, "1");
  assert.equal(
    state.active[ID].compatibilityState.classification,
    COMPATIBILITY_CLASSIFICATIONS.CONFLICT
  );
  assert.equal(
    state.active[ID].entryDecision.mode,
    "STRICT_STATION_STATE_PROOF"
  );
});

for (const [label, change, reason] of [
  ["INCOMING_AT", { currentStatus: 0 }, "INCOMING_AT_IS_APPROACH_EVIDENCE"],
  ["IN_TRANSIT_TO", { currentStatus: 2 }, "IN_TRANSIT_TO_IS_APPROACH_EVIDENCE"],
  ["missing status", { currentStatus: null, currentStatusExplicit: false }, "CURRENT_STATUS_NOT_EXPLICIT"],
  ["missing sequence", { currentStopSequence: null, currentStopSequenceExplicit: false }, "CURRENT_STOP_SEQUENCE_NOT_EXPLICIT"]
]) {
  test(`${label} remains gated at one`, () => {
    const state = gate(null, [arrival()], [
      evidence({ vehicle: vehicle(change) })
    ]);
    assert.equal(arrivalProofBoardArrivals(state, [])[0].time, "1");
    assert.equal(state.active[ID].entryDecision.reason, reason);
  });
}

test("stale, ambiguous, wrong-stop, parent-only, and wrong-trip entry evidence fail", () => {
  const variants = [
    evidence({ feedStale: true, vehicleAgeSeconds: 121 }),
    evidence({ vehiclePositionAmbiguous: true, vehicle: null }),
    evidence({ vehicle: vehicle({ stopId: BEFORE }) }),
    evidence({ vehicle: vehicle({ stopId: "723" }) }),
    evidence({ identityKey: "other|20260730", tripId: "other" })
  ];
  for (const item of variants) {
    const board = arrivalProofBoardArrivals(
      gate(null, [arrival()], [item]),
      []
    );
    assert.equal(board.some(entry => entry.time === "0"), false);
  }
});

test("live 132500 mismatch retains zero while VP still names 723S", () => {
  const state = lock(null);
  assert.ok(state.active[ID]);
  assert.equal(state.released.length, 0);
  assert.equal(state.active[ID].releaseDecision.reason, "VEHICLE_STILL_NAMES_TARGET");
  assert.equal(state.active[ID].releaseDecision.staticRealtimeSequenceMismatch, true);
});

for (const stopId of [AFTER, LATER]) {
  test(`fresh exact downstream stop ${stopId} releases`, () => {
    let state = lock(null, [arrival()], [
      evidence({ vehiclePositionPresent: false, vehicle: null })
    ]);
    state = lock(state, [], [
      evidence({ vehicle: vehicle({ stopId, currentStopSequence: 20 }) })
    ]);
    assert.equal(state.released[0].releaseReason, RELEASE_REASONS.VEHICLE_DOWNSTREAM);
  });
}

test("stale, missing-status, missing-sequence, ambiguous, and wrong-trip downstream VP retain", () => {
  const variants = [
    evidence({ feedStale: true, vehicleAgeSeconds: 121, vehicle: vehicle({ stopId: AFTER }) }),
    evidence({ vehicle: vehicle({ stopId: AFTER, currentStatus: null, currentStatusExplicit: false }) }),
    evidence({ vehicle: vehicle({ stopId: AFTER, currentStopSequence: null, currentStopSequenceExplicit: false }) }),
    evidence({ vehiclePositionAmbiguous: true, vehicle: null }),
    evidence({ identityKey: "other|20260730", tripId: "other", vehicle: vehicle({ stopId: AFTER }) })
  ];
  for (const item of variants) {
    let state = lock(null, [arrival()], [evidence({ vehiclePositionPresent: false, vehicle: null })]);
    state = lock(state, [], [item]);
    assert.ok(state.active[ID]);
  }
});

test("target removal, future predictions, and TripUpdate progression do not release", () => {
  let state = lock(null, [arrival()], [
    evidence({ vehiclePositionPresent: false, vehicle: null })
  ]);
  state = lock(state, [], [
    evidence({
      targetStopPresent: false,
      stopUpdates: [AFTER, LATER].map(stopId => ({ stopId })),
      tripUpdateProgressionSequence: 99,
      vehiclePositionPresent: false,
      vehicle: null
    })
  ]);
  assert.ok(state.active[ID]);
  assert.equal(state.released.length, 0);
});

test("last exact pattern supports downstream proof after target disappears", () => {
  let state = lock(null, [arrival()], [
    evidence({ vehiclePositionPresent: false, vehicle: null })
  ]);
  state = lock(state, [], [
    evidence({
      targetStopPresent: false,
      stopUpdates: [AFTER, LATER].map(stopId => ({ stopId })),
      feedTimestamp: FEED + 15,
      vehicleAgeSeconds: 5,
      vehicle: vehicle({ stopId: AFTER, timestamp: FEED + 10 })
    })
  ]);
  assert.equal(state.released[0].releaseReason, RELEASE_REASONS.VEHICLE_DOWNSTREAM);
});

test("repeated target and looped downstream identities are unknown", () => {
  for (const stops of [
    [BEFORE, TARGET, AFTER, TARGET],
    [AFTER, TARGET, AFTER, LATER]
  ]) {
    let state = lock(null, [arrival()], [
      evidence({ stopUpdates: stops.map(stopId => ({ stopId })), vehiclePositionPresent: false, vehicle: null })
    ]);
    state = lock(state, [], [
      evidence({ stopUpdates: stops.map(stopId => ({ stopId })), vehicle: vehicle({ stopId: AFTER }) })
    ]);
    assert.ok(state.active[ID]);
  }
});

test("a newly ambiguous target cannot borrow an older conclusive occurrence", () => {
  let state = lock(null, [arrival()], [
    evidence({ vehiclePositionPresent: false, vehicle: null })
  ]);
  state = lock(state, [], [
    evidence({
      feedTimestamp: FEED + 15,
      vehicleAgeSeconds: 5,
      stopUpdates: [BEFORE, TARGET, AFTER, TARGET, LATER]
        .map(stopId => ({ stopId })),
      vehicle: vehicle({
        stopId: AFTER,
        timestamp: FEED + 10
      })
    })
  ]);
  assert.ok(state.active[ID]);
  assert.equal(
    state.active[ID].releaseDecision.reason,
    "TARGET_OCCURRENCE_AMBIGUOUS"
  );
});

test("older reordered pattern, feed failure, and absence retain the lock", () => {
  let state = lock(null, [arrival()], [
    evidence({ vehiclePositionPresent: false, vehicle: null })
  ]);
  const original = state.active[ID].lastConclusiveStoppingPattern.stopIds;
  state = lock(state, [], [
    evidence({
      feedTimestamp: FEED - 60,
      stopUpdates: [AFTER, TARGET, BEFORE].map(stopId => ({ stopId })),
      vehiclePositionPresent: false,
      vehicle: null
    })
  ]);
  assert.deepEqual(state.active[ID].lastConclusiveStoppingPattern.stopIds, original);
  state = lock(state, [], []);
  assert.ok(state.active[ID]);
  state = lock(state, [], [evidence({ feedSucceeded: false, vehicle: vehicle({ stopId: AFTER }) })]);
  assert.ok(state.active[ID]);
});

test("stationStateProof=0 preserves legacy entry but universal target retention", () => {
  const legacy = { stationStateProofEnabled: false };
  const gated = reconcileArrivalProofGates(
    null,
    {
      arrivals: [arrival()],
      evidence: [
        evidence({
          vehicle: vehicle({
            currentStatus: 0,
            currentStopSequence: 17
          })
        })
      ]
    },
    NOW,
    legacy
  );
  assert.equal(arrivalProofBoardArrivals(gated, [])[0].time, "0");
  const released = reconcileDepartureProofLocks(
    null,
    { arrivals: [arrival()], evidence: [evidence()] },
    NOW,
    legacy
  );
  assert.ok(released.active[ID]);
  assert.equal(released.released.length, 0);
  assert.equal(
    released.active[ID].releaseDecision.reason,
    "VEHICLE_STILL_NAMES_TARGET"
  );
});

test("default-on URL policy and diagnostics remain detached and frozen", () => {
  const html = fs.readFileSync(new URL("../public/arrivals.html", import.meta.url), "utf8");
  assert.match(html, /searchParams\.get\("stationStateProof"\) !== "0"/);
  assert.match(html, /query\.set\("stationStateProof", "1"\)/);

  const gateState = gate(null);
  const lockState = lock(null);
  const gateSnapshot = createArrivalProofDiagnostics(new Map([["723S", gateState]]), true).inspect();
  const lockSnapshot = createDepartureProofDiagnostics(new Map([["723S", lockState]]), true).inspect();
  assert.equal(gateSnapshot.stationStateProofEnabled, true);
  assert.equal(lockSnapshot.stationStateProofEnabled, true);
  assert.equal(Object.isFrozen(lockSnapshot.active[0].releaseDecision), true);
  assert.notStrictEqual(
    lockSnapshot.active[0].lastConclusiveStoppingPattern,
    lockState.active[ID].lastConclusiveStoppingPattern
  );
  assert.throws(() => {
    lockSnapshot.active[0].releaseDecision.reason = "MUTATED";
  }, TypeError);
});
