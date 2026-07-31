import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  GATE_DISPOSITIONS,
  GATE_STATES,
  VEHICLE_STATUSES,
  arrivalProofBoardArrivals,
  initialArrivalProofGateState,
  reconcileArrivalProofGates,
  suppressArrivalProofGates
} from "../public/arrival-proof-gate.js";
import {
  reconcileDepartureProofLocks
} from "../public/departure-proof-lock.js";
import {
  reconcileVehicleProofQuarantine,
  vehicleProofCandidateArrivals
} from "../public/vehicle-proof-quarantine.js";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/mta-route1-preentry-custody.json", import.meta.url),
    "utf8"
  )
);
const NOW = fixture.targetPrediction * 1000 - 120000;
const FEED = NOW / 1000;
const enabled = { stationStateProofEnabled: true };

function arrival(overrides = {}) {
  return {
    identityKey: fixture.identityKey,
    tripId: fixture.tripId,
    startDate: fixture.startDate,
    route: fixture.routeId,
    platformId: fixture.platform,
    direction: "Northbound",
    station: "Van Cortlandt Park-242 St",
    time: "2",
    ...overrides
  };
}

function evidence(overrides = {}) {
  return {
    identityKey: fixture.identityKey,
    tripId: fixture.tripId,
    startDate: fixture.startDate,
    route: fixture.routeId,
    targetStop: fixture.platform,
    targetStopPresent: true,
    targetStopSequence: fixture.staticTargetSequence,
    tripUpdatePresent: true,
    tripUpdateRouteAmbiguous: false,
    routeIdMismatch: false,
    stopUpdates: fixture.realtimeStops.map(stopId => ({
      stopId,
      eventTime:
        stopId === fixture.platform ? fixture.targetPrediction : null
    })),
    vehiclePositionPresent: true,
    vehiclePositionAmbiguous: false,
    vehicle: {
      routeId: fixture.routeId,
      stopId: "129N",
      currentStopSequence: 12,
      currentStopSequenceExplicit: true,
      currentStatus: VEHICLE_STATUSES.IN_TRANSIT_TO,
      currentStatusExplicit: true,
      timestamp: FEED - 5
    },
    feedTimestamp: FEED,
    feedSucceeded: true,
    feedStale: false,
    vehicleAgeSeconds: 5,
    ...overrides
  };
}

function gate(
  state,
  arrivals = [arrival()],
  evidences = [evidence()],
  now = NOW
) {
  return reconcileArrivalProofGates(
    state,
    { arrivals, evidence: evidences },
    now,
    enabled
  );
}

test("admitted raw two creates PREARMED_AT_2 without changing display", () => {
  const state = gate(null);
  const custody = state.active[fixture.identityKey];
  assert.equal(custody.state, GATE_STATES.PREARMED_AT_2);
  assert.equal(custody.displayedCountdown, 2);
  assert.equal(
    custody.lastAcceptedTargetPredictionTimestamp,
    fixture.targetPrediction
  );
  assert.equal(arrivalProofBoardArrivals(state, [])[0].time, "2");
});

test("present candidate displays legitimate values and retains custody above two", () => {
  let state = gate(null);
  state = gate(
    state,
    [arrival({ time: "3" })],
    [
      evidence({
        stopUpdates: fixture.realtimeStops.map(stopId => ({
          stopId,
          eventTime:
            stopId === fixture.platform
              ? fixture.targetPrediction + 60
              : null
        }))
      })
    ],
    NOW + 15000
  );
  assert.equal(state.active[fixture.identityKey].state, GATE_STATES.PREARMED_AT_2);
  assert.equal(arrivalProofBoardArrivals(state, [])[0].time, "3");
});

test("two to negative or disappearance preserves exact custody", () => {
  for (const [arrivals, evidences] of [
    [[arrival({ time: "-1" })], [evidence()]],
    [[], []]
  ]) {
    let state = gate(null);
    state = gate(state, arrivals, evidences, NOW + 15000);
    assert.ok(state.active[fixture.identityKey]);
    assert.equal(state.active[fixture.identityKey].state, GATE_STATES.PREARMED_AT_2);
  }
});

test("retained target time advances to one but never directly to zero", () => {
  let state = gate(null);
  state = gate(state, [], [], fixture.targetPrediction * 1000 - 30000);
  assert.equal(state.active[fixture.identityKey].state, GATE_STATES.GATED_AT_ONE);
  assert.equal(arrivalProofBoardArrivals(state, [])[0].time, "1");

  state = gate(state, [], [], fixture.targetPrediction * 1000 + 120000);
  assert.equal(state.active[fixture.identityKey].state, GATE_STATES.GATED_AT_ONE);
  assert.equal(state.confirmed.length, 0);
  assert.equal(arrivalProofBoardArrivals(state, [])[0].time, "1");
});

test("returning candidate reconciles once and only newer prediction wins", () => {
  let state = gate(null);
  state = gate(state, [], [], NOW + 15000);
  state = gate(
    state,
    [arrival({ time: "2" })],
    [
      evidence({
        stopUpdates: fixture.realtimeStops.map(stopId => ({
          stopId,
          eventTime:
            stopId === fixture.platform
              ? fixture.targetPrediction + 90
              : null
        }))
      })
    ],
    NOW + 30000
  );
  assert.equal(Object.keys(state.active).length, 1);
  assert.equal(
    state.active[fixture.identityKey].lastAcceptedTargetPredictionTimestamp,
    fixture.targetPrediction + 90
  );

  state = gate(
    state,
    [arrival({ time: "2" })],
    [
      evidence({
        stopUpdates: fixture.realtimeStops.map(stopId => ({
          stopId,
          eventTime:
            stopId === fixture.platform
              ? fixture.targetPrediction - 90
              : null
        }))
      })
    ],
    NOW + 45000
  );
  assert.equal(
    state.active[fixture.identityKey].lastAcceptedTargetPredictionTimestamp,
    fixture.targetPrediction + 90
  );
  assert.equal(
    arrivalProofBoardArrivals(state, [arrival({ time: "2" })])
      .filter(item => item.identityKey === fixture.identityKey).length,
    1
  );
});

test("different or similar identity cannot inherit custody", () => {
  let state = gate(null);
  state = gate(
    state,
    [
      arrival({
        identityKey: "005650_1..N15X010|20260801",
        startDate: "20260801"
      })
    ],
    [
      evidence({
        identityKey: "005650_1..N15X010|20260801",
        startDate: "20260801"
      })
    ],
    NOW + 15000
  );
  assert.ok(state.active[fixture.identityKey]);
  assert.ok(state.active["005650_1..N15X010|20260801"]);
  assert.notEqual(
    state.active[fixture.identityKey],
    state.active["005650_1..N15X010|20260801"]
  );
});

test("distinct 7 and 7X identities retain independent pre-entry custody", () => {
  const local = {
    identityKey: "local-7|20260731",
    tripId: "local-7",
    route: "7"
  };
  const express = {
    identityKey: "express-7x|20260731",
    tripId: "express-7x",
    route: "7X"
  };
  const arrivals = [local, express].map(item =>
    arrival({ ...item, time: "2" })
  );
  const evidences = [local, express].map(item =>
    evidence({
      ...item,
      vehicle: {
        ...evidence().vehicle,
        routeId: item.route
      }
    })
  );
  const state = gate(null, arrivals, evidences);
  assert.equal(state.active[local.identityKey].route, "7");
  assert.equal(state.active[express.identityKey].route, "7X");
  assert.equal(
    state.active[local.identityKey].state,
    GATE_STATES.PREARMED_AT_2
  );
  assert.equal(
    state.active[express.identityKey].state,
    GATE_STATES.PREARMED_AT_2
  );
});

test("prearmed identity is protected from same-route limiting", () => {
  const state = gate(null);
  const others = [0, 1, 2, 3].map(index =>
    arrival({
      identityKey: `other-${index}|20260731`,
      tripId: `other-${index}`,
      time: String(index + 3)
    })
  );
  const board = arrivalProofBoardArrivals(state, others);
  assert.equal(board.length, 3);
  assert.equal(
    board.filter(item => item.identityKey === fixture.identityKey).length,
    1
  );
});

test("never-fresh candidate cannot prearm but formerly fresh candidate can", () => {
  const noVehicle = evidence({
    vehiclePositionPresent: false,
    vehicle: null,
    vehicleAgeSeconds: null
  });
  let quarantine = reconcileVehicleProofQuarantine(
    null,
    { arrivals: [arrival()], evidence: [noVehicle] },
    NOW
  );
  let state = gate(
    null,
    vehicleProofCandidateArrivals(quarantine),
    [noVehicle]
  );
  assert.equal(Object.keys(state.active).length, 0);

  quarantine = reconcileVehicleProofQuarantine(
    null,
    { arrivals: [arrival({ time: "6" })], evidence: [evidence()] },
    NOW
  );
  quarantine = reconcileVehicleProofQuarantine(
    quarantine,
    { arrivals: [arrival()], evidence: [noVehicle] },
    NOW + 15000
  );
  state = gate(
    null,
    vehicleProofCandidateArrivals(quarantine),
    [noVehicle],
    NOW + 15000
  );
  assert.equal(
    state.active[fixture.identityKey].state,
    GATE_STATES.PREARMED_AT_2
  );
  state = gate(state, [], [], NOW + 30000);
  assert.ok(state.active[fixture.identityKey]);
});

test("null-static two to zero gates, STOPPED_AT confirms, and lock receives identity", () => {
  let state = gate(null);
  const stopped = evidence({
    vehicle: {
      ...evidence().vehicle,
      stopId: fixture.platform,
      currentStopSequence: 13,
      currentStatus: VEHICLE_STATUSES.STOPPED_AT,
      timestamp: FEED + 10
    }
  });
  state = gate(
    state,
    [arrival({ time: "0" })],
    [stopped],
    NOW + 30000
  );
  assert.equal(state.confirmed.length, 1);
  const board = arrivalProofBoardArrivals(state, []);
  assert.equal(board[0].time, "0");
  const lock = reconcileDepartureProofLocks(
    null,
    { arrivals: board, evidence: [stopped] },
    NOW + 30000,
    enabled
  );
  assert.ok(lock.active[fixture.identityKey]);
});

test("fresh exact target cannot bypass, but exact downstream can", () => {
  let state = gate(null);
  state = gate(
    state,
    [],
    [
      evidence({
        vehicle: {
          ...evidence().vehicle,
          stopId: fixture.platform,
          currentStopSequence: 99,
          currentStatus: VEHICLE_STATUSES.INCOMING_AT,
          timestamp: FEED + 10
        }
      })
    ],
    NOW + 30000
  );
  assert.ok(state.active[fixture.identityKey]);

  state = gate(
    state,
    [],
    [
      evidence({
        vehicle: {
          ...evidence().vehicle,
          stopId: "127N",
          currentStopSequence: 14,
          currentStatus: VEHICLE_STATUSES.STOPPED_AT,
          timestamp: FEED + 20
        }
      })
    ],
    NOW + 45000
  );
  assert.equal(
    state.bypassed[0].disposition,
    GATE_DISPOSITIONS.TARGET_PASSED_WITHOUT_ENTRY_CONFIRMATION
  );
});

test("platform suppression removes custody and tombstone prevents resurrection", () => {
  let state = gate(null);
  state = suppressArrivalProofGates(
    state,
    [{
      suppressionApplied: true,
      route: fixture.routeId,
      resolvedPlatform: fixture.platform
    }],
    NOW + 1000
  );
  assert.equal(Object.keys(state.active).length, 0);
  state = gate(state);
  assert.equal(Object.keys(state.active).length, 0);
});

test("negative evidence-only arrival cannot prearm and reload resets custody", () => {
  const historical = gate(
    null,
    [arrival({ time: "-2" })],
    [evidence()]
  );
  assert.equal(Object.keys(historical.active).length, 0);
  const reloaded = initialArrivalProofGateState();
  assert.equal(Object.keys(reloaded.active).length, 0);
});
