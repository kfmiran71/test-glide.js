import test from "node:test";
import assert from "node:assert/strict";
import {
  RELEASE_REASONS,
  reconcileDepartureProofLocks
} from "../public/departure-proof-lock.js";
import {
  classifySuccessorOccupancyRelease
} from "../public/successor-occupancy-proof.js";
import fs from "node:fs";

const NOW = Date.UTC(2026, 6, 31, 12, 0, 0);
const TARGET = "D14S";

function arrival(overrides = {}) {
  return {
    identityKey: "leader|20260731",
    tripId: "leader",
    startDate: "20260731",
    route: "D",
    platformId: TARGET,
    direction: "Southbound",
    station: "Coney Island-Stillwell Av",
    time: "0",
    ...overrides
  };
}

function evidence(overrides = {}) {
  return {
    identityKey: "leader|20260731",
    tripId: "leader",
    startDate: "20260731",
    route: "D",
    targetStop: TARGET,
    targetStopPresent: true,
    targetStopSequence: 14,
    tripUpdatePresent: true,
    tripUpdateProgressionSequence: null,
    stopUpdates: [
      { stopId: TARGET, stopSequence: 14, eventTime: NOW / 1000 }
    ],
    vehiclePositionPresent: false,
    vehiclePositionAmbiguous: false,
    vehicle: null,
    feedTimestamp: NOW / 1000,
    ...overrides
  };
}

function successor(overrides = {}) {
  return evidence({
    identityKey: "follower|20260731",
    tripId: "follower",
    route: "B",
    tripUpdatePresent: false,
    targetStopPresent: false,
    targetStopSequence: null,
    stopUpdates: [],
    vehiclePositionPresent: true,
    vehicle: {
      stopId: TARGET,
      currentStopSequence: 14,
      currentStatus: 1,
      currentStatusExplicit: true
    },
    ...overrides
  });
}

function reconcile(
  state,
  arrivals,
  evidences,
  enabled = true,
  nowMs = NOW
) {
  return reconcileDepartureProofLocks(
    state,
    { arrivals, evidence: evidences },
    nowMs,
    { successorOccupancyProofEnabled: enabled }
  );
}

test("fresh exact successor STOPPED_AT target releases the old lock", () => {
  let state = reconcile(null, [arrival()], [evidence()]);
  state = reconcile(state, [], [evidence(), successor()]);

  assert.equal(Object.keys(state.active).length, 0);
  assert.equal(
    state.released[0].releaseReason,
    RELEASE_REASONS.SUCCESSOR_STOPPED_AT_TARGET
  );
  assert.equal(
    state.tombstones["leader|20260731"].successorIdentityKey,
    "follower|20260731"
  );
  assert.equal(
    state.released[0].successorOccupancyDecision.outcome,
    "AFFIRMATIVE"
  );
});

test("same exact identity can never serve as its own successor", () => {
  const decision = classifySuccessorOccupancyRelease({
    lock: arrival(),
    lockedEvidence: null,
    allEvidence: [
      successor({
        identityKey: "leader|20260731",
        tripId: "leader"
      })
    ],
    nowMs: NOW
  });

  assert.equal(decision.outcome, "UNKNOWN");
});

test("INCOMING_AT and defaulted status cannot prove successor occupancy", () => {
  for (const vehicle of [
    {
      stopId: TARGET,
      currentStatus: 0,
      currentStatusExplicit: true
    },
    {
      stopId: TARGET,
      currentStatus: 1,
      currentStatusExplicit: false
    }
  ]) {
    let state = reconcile(null, [arrival()], [evidence()]);
    state = reconcile(state, [], [
      evidence(),
      successor({ vehicle })
    ]);
    assert.equal(Object.keys(state.active).length, 1);
    assert.equal(state.released.length, 0);
  }
});

test("stale, future, ambiguous, and missing-feed successor evidence retains lock", () => {
  const invalidSuccessors = [
    successor({ feedTimestamp: NOW / 1000 - 91 }),
    successor({ feedTimestamp: NOW / 1000 + 61 }),
    successor({
      vehiclePositionPresent: false,
      vehiclePositionAmbiguous: true,
      vehicle: null
    }),
    successor({ feedTimestamp: null })
  ];

  for (const invalid of invalidSuccessors) {
    let state = reconcile(null, [arrival()], [evidence()]);
    state = reconcile(state, [], [evidence(), invalid]);
    assert.equal(Object.keys(state.active).length, 1);
    assert.equal(state.released.length, 0);
  }
});

test("fresh evidence that the locked train still names target blocks successor", () => {
  let state = reconcile(null, [arrival()], [evidence()]);
  state = reconcile(state, [], [
    evidence({
      vehiclePositionPresent: true,
      vehicle: {
        stopId: TARGET,
        currentStopSequence: 14,
        currentStatus: 1,
        currentStatusExplicit: true
      }
    }),
    successor()
  ]);

  assert.equal(Object.keys(state.active).length, 1);
  assert.equal(state.released.length, 0);
  assert.equal(
    state.active["leader|20260731"].successorOccupancyDecision.reason,
    "LOCKED_VEHICLE_STILL_NAMES_TARGET"
  );
});

test("multiple stopped successors are treated as ambiguous", () => {
  let state = reconcile(null, [arrival()], [evidence()]);
  state = reconcile(state, [], [
    evidence(),
    successor(),
    successor({
      identityKey: "follower-2|20260731",
      tripId: "follower-2"
    })
  ]);

  assert.equal(Object.keys(state.active).length, 1);
  assert.equal(
    state.active["leader|20260731"].successorOccupancyDecision.reason,
    "SUCCESSOR_OCCUPANCY_AMBIGUOUS"
  );
});

test("shared-platform routes remain independent while allowing physical occupancy proof", () => {
  let state = reconcile(null, [arrival()], [evidence()]);
  state = reconcile(state, [], [
    evidence(),
    successor({ route: "B" })
  ]);

  assert.equal(state.released[0].route, "D");
  assert.equal(
    state.released[0].successorOccupancyDecision.successorRoute,
    "B"
  );
});

test("flag off preserves the exact historical departure-proof behavior", () => {
  let state = reconcile(null, [arrival()], [evidence()], false);
  state = reconcile(
    state,
    [],
    [evidence(), successor()],
    false
  );

  assert.equal(Object.keys(state.active).length, 1);
  assert.equal(state.released.length, 0);
  assert.equal(
    "successorOccupancyDecision" in state.active["leader|20260731"],
    false
  );
});

test("successor release tombstone prevents the old identity from relocking", () => {
  let state = reconcile(null, [arrival()], [evidence()]);
  state = reconcile(state, [], [evidence(), successor()]);
  state = reconcile(state, [arrival()], [evidence()]);

  assert.equal(Object.keys(state.active).length, 0);
  assert.equal(state.released.length, 1);
  assert.equal(
    state.tombstones["leader|20260731"].releaseReason,
    RELEASE_REASONS.SUCCESSOR_STOPPED_AT_TARGET
  );
});

function activationPolicyFromEmbed(html) {
  const match = html.match(
    /function isSuccessorOccupancyProofEnabled\([\s\S]*?\n\}/
  );
  assert.ok(match, "successor occupancy activation policy must exist");
  return new Function(
    "URLSearchParams",
    `${match[0]}; return (value, departureProofEnabled = true) =>
      isSuccessorOccupancyProofEnabled(
        new URLSearchParams(value),
        departureProofEnabled
      );`
  )(URLSearchParams);
}

test("existing Glide URL enables successor occupancy and explicit zero disables it", () => {
  const html = fs.readFileSync(
    new URL("../public/arrivals.html", import.meta.url),
    "utf8"
  );
  const isEnabled = activationPolicyFromEmbed(html);

  assert.equal(isEnabled("route=D&stop=D14"), true);
  assert.equal(isEnabled("successorOccupancyProof=1"), true);
  assert.equal(isEnabled("successorOccupancyProof=0"), false);
  assert.equal(isEnabled("", false), false);
  assert.match(
    html,
    /query\.set\("successorOccupancyProof", "1"\)/
  );
});
