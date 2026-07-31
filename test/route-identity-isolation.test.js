import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  VEHICLE_STATUSES,
  arrivalProofBoardArrivals,
  reconcileArrivalProofGates
} from "../public/arrival-proof-gate.js";
import {
  buildGtfsEvidence,
  experimentalBoardArrivals,
  reconcileDepartureProofLocks
} from "../public/departure-proof-lock.js";
import {
  reconcileVehicleProofQuarantine,
  vehicleProofCandidateArrivals
} from "../public/vehicle-proof-quarantine.js";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/mta-7-7x-modified-service.json", import.meta.url),
    "utf8"
  )
);
const NOW = Date.UTC(2026, 6, 30, 23, 49);
const FEED = NOW / 1000;
const TARGET = fixture.platform;
const corrected = { stationStateProofEnabled: true };

function arrival(service, overrides = {}) {
  return {
    identityKey: service.identityKey,
    tripId: service.tripId,
    startDate: service.startDate,
    route: service.routeId,
    platformId: TARGET,
    direction: "Southbound",
    time: "1",
    ...overrides
  };
}

function evidence(service, overrides = {}) {
  const targetIndex = service.realtimeStops.indexOf(TARGET);
  return {
    identityKey: service.identityKey,
    tripId: service.tripId,
    startDate: service.startDate,
    route: service.routeId,
    tripUpdateRoute: service.routeId,
    vehicleRoute: service.routeId,
    tripUpdateObservedRoutes: [service.routeId],
    tripUpdateRouteAmbiguous: false,
    routeIdMismatch: false,
    targetStop: TARGET,
    targetStopPresent: true,
    targetStopSequence: service.staticTargetSequence,
    tripUpdatePresent: true,
    tripUpdateProgressionSequence: null,
    stopUpdates: service.realtimeStops.map(stopId => ({ stopId })),
    vehiclePositionPresent: true,
    vehiclePositionAmbiguous: false,
    vehicle: {
      routeId: service.routeId,
      stopId: TARGET,
      currentStopSequence: targetIndex + 1,
      currentStopSequenceExplicit: true,
      currentStatus: VEHICLE_STATUSES.INCOMING_AT,
      currentStatusExplicit: true,
      timestamp: FEED - 5
    },
    feedTimestamp: FEED,
    feedAgeSeconds: 1,
    vehicleAgeSeconds: 5,
    feedSucceeded: true,
    feedStale: false,
    ...overrides
  };
}

function gate(state, arrivals, evidences) {
  return reconcileArrivalProofGates(
    state,
    { arrivals, evidence: evidences },
    NOW,
    corrected
  );
}

function lock(state, arrivals, evidences) {
  return reconcileDepartureProofLocks(
    state,
    { arrivals, evidence: evidences },
    NOW,
    corrected
  );
}

test("failed production 137500 fixture gates, promotes, locks, and retains at exact target", () => {
  const service = {
    identityKey: "137500_7..S|20260730",
    tripId: "137500_7..S",
    startDate: "20260730",
    routeId: "7",
    staticTargetSequence: null,
    realtimeStops: ["723S", "724S", "725S", "726S"]
  };
  const stoppedEvidence = evidence(service, {
    vehicle: {
      ...evidence(service).vehicle,
      stopId: TARGET,
      currentStopSequence: 19,
      currentStopSequenceExplicit: true,
      currentStatus: VEHICLE_STATUSES.STOPPED_AT,
      currentStatusExplicit: true
    }
  });

  const gated = gate(
    null,
    [arrival(service, { time: "1" })],
    [stoppedEvidence]
  );
  assert.equal(gated.confirmed.length, 1);
  assert.equal(gated.confirmed[0].identityKey, service.identityKey);
  assert.equal(gated.confirmed[0].targetStopSequence, null);
  assert.equal(gated.confirmed[0].entryDecision.reason, "FRESH_EXACT_TARGET_STOPPED_AT");
  const board = arrivalProofBoardArrivals(gated, []);
  assert.equal(board[0].time, "0");

  const locked = lock(null, board, [stoppedEvidence]);
  assert.ok(locked.active[service.identityKey]);
  assert.equal(locked.active[service.identityKey].targetStop, TARGET);
  assert.equal(locked.active[service.identityKey].targetStopSequence, null);
  assert.deepEqual(
    locked.active[service.identityKey].lastConclusiveStoppingPattern.stopIds,
    service.realtimeStops
  );
  assert.equal(locked.released.length, 0);
  assert.equal(
    locked.active[service.identityKey].releaseDecision.reason,
    "VEHICLE_STILL_NAMES_TARGET"
  );
});

test("modified-service fixture preserves static omissions 711S and 713S", () => {
  const local = fixture.regular7;
  assert.deepEqual(local.omittedFromStatic, ["711S", "713S"]);
  assert.equal(local.realtimeStops.includes("711S"), true);
  assert.equal(local.realtimeStops.includes("713S"), true);
  assert.equal(local.staticTargetSequence, 17);
  assert.equal(local.realtimeTargetSequence, 19);
});

test("distinct 7 and 7X identities cannot inherit each other's gates", () => {
  const local = fixture.regular7;
  const express = fixture.express7X;
  let state = gate(
    null,
    [arrival(local), arrival(express)],
    [evidence(local), evidence(express)]
  );
  assert.deepEqual(Object.keys(state.active).sort(), [
    express.identityKey,
    local.identityKey
  ].sort());

  state = gate(
    state,
    [],
    [
      evidence(local, {
        vehicle: {
          ...evidence(local).vehicle,
          currentStatus: VEHICLE_STATUSES.STOPPED_AT
        }
      })
    ]
  );
  assert.equal(state.confirmed.some(item => item.identityKey === local.identityKey), true);
  assert.ok(state.active[express.identityKey]);
  assert.equal(state.active[express.identityKey].route, "7X");
});

test("distinct 7 and 7X identities cannot inherit each other's locks", () => {
  const local = fixture.regular7;
  const express = fixture.express7X;
  let state = lock(
    null,
    [
      arrival(local, { time: "0" }),
      arrival(express, { time: "0" })
    ],
    [evidence(local), evidence(express)]
  );
  assert.ok(state.active[local.identityKey]);
  assert.ok(state.active[express.identityKey]);

  state = lock(
    state,
    [],
    [
      evidence(express, {
        vehicle: {
          ...evidence(express).vehicle,
          stopId: "724S",
          currentStatus: VEHICLE_STATUSES.STOPPED_AT
        }
      })
    ]
  );
  assert.equal(state.released.some(item => item.identityKey === express.identityKey), true);
  assert.ok(state.active[local.identityKey]);
});

test("7 and 7X sharing a platform keep independent quarantine histories", () => {
  const local = fixture.regular7;
  const express = fixture.express7X;
  let state = reconcileVehicleProofQuarantine(
    null,
    {
      arrivals: [arrival(local, { time: "4" }), arrival(express, { time: "4" })],
      evidence: [
        evidence(local),
        evidence(express, {
          vehiclePositionPresent: false,
          vehicle: null,
          vehicleAgeSeconds: null
        })
      ]
    },
    NOW
  );
  assert.ok(state.everFresh[local.identityKey]);
  assert.equal(Boolean(state.everFresh[express.identityKey]), false);
  assert.equal(vehicleProofCandidateArrivals(state)[0].identityKey, local.identityKey);

  state = reconcileVehicleProofQuarantine(
    state,
    {
      arrivals: [arrival(local, { time: "3" }), arrival(express, { time: "3" })],
      evidence: [
        evidence(local, {
          vehiclePositionPresent: false,
          vehicle: null,
          vehicleAgeSeconds: null
        }),
        evidence(express)
      ]
    },
    NOW + 15000
  );
  assert.ok(state.everFresh[local.identityKey]);
  assert.ok(state.everFresh[express.identityKey]);
  assert.deepEqual(
    vehicleProofCandidateArrivals(state)
      .map(item => item.route)
      .sort(),
    ["7", "7X"]
  );
});

test("7X without a static sequence gates from a unique realtime target", () => {
  const express = fixture.express7X;
  let state = gate(
    null,
    [arrival(express)],
    [evidence(express)]
  );
  assert.ok(state.active[express.identityKey]);
  assert.equal(state.active[express.identityKey].targetStopSequence, null);
  assert.equal(
    state.active[express.identityKey].lastConclusiveStoppingPattern.targetIndex,
    express.realtimeStops.indexOf(TARGET)
  );

  state = gate(state, [], [
    evidence(express, {
      vehicle: {
        ...evidence(express).vehicle,
        currentStatus: VEHICLE_STATUSES.STOPPED_AT
      }
    })
  ]);
  const board = arrivalProofBoardArrivals(state, []);
  assert.equal(board[0].time, "0");
  const locked = lock(null, board, [evidence(express)]);
  assert.ok(locked.active[express.identityKey]);
  assert.equal(locked.active[express.identityKey].targetStopSequence, null);
});

test("regular 7 uses its realtime target occurrence despite incompatible static sequence", () => {
  const local = fixture.regular7;
  let state = gate(
    null,
    [arrival(local)],
    [evidence(local)]
  );
  assert.equal(arrivalProofBoardArrivals(state, [])[0].time, "1");

  state = gate(
    state,
    [],
    [
      evidence(local, {
        vehicle: {
          ...evidence(local).vehicle,
          currentStatus: VEHICLE_STATUSES.STOPPED_AT
        }
      })
    ]
  );
  assert.equal(arrivalProofBoardArrivals(state, [])[0].time, "0");
  assert.equal(
    state.confirmed[0].entryDecision.staticRealtimeSequenceMismatch,
    true
  );

  let locked = lock(
    null,
    arrivalProofBoardArrivals(state, []),
    [
      evidence(local, {
        vehicle: {
          ...evidence(local).vehicle,
          currentStatus: VEHICLE_STATUSES.STOPPED_AT
        }
      })
    ]
  );
  assert.ok(locked.active[local.identityKey]);
  assert.equal(locked.released.length, 0);
  assert.equal(
    locked.active[local.identityKey].releaseDecision.reason,
    "VEHICLE_STILL_NAMES_TARGET"
  );

  locked = lock(locked, [], [
    evidence(local, {
      vehicle: {
        ...evidence(local).vehicle,
        stopId: "724S",
        currentStopSequence: 20,
        currentStatus: VEHICLE_STATUSES.STOPPED_AT
      }
    })
  ]);
  assert.equal(locked.released.length, 1);
  assert.equal(locked.released[0].releaseReason, "VEHICLE_DOWNSTREAM");
});

test("sequence mismatch on 7 cannot alter the 7X pattern or state", () => {
  const local = fixture.regular7;
  const express = fixture.express7X;
  let state = gate(
    null,
    [arrival(local), arrival(express)],
    [evidence(local), evidence(express)]
  );
  const expressPattern =
    state.active[express.identityKey].lastConclusiveStoppingPattern.stopIds;

  state = gate(
    state,
    [],
    [
      evidence(local, {
        vehicle: {
          ...evidence(local).vehicle,
          currentStopSequence: 99,
          currentStatus: VEHICLE_STATUSES.STOPPED_AT
        }
      })
    ]
  );
  assert.deepEqual(
    state.active[express.identityKey].lastConclusiveStoppingPattern.stopIds,
    expressPattern
  );
});

test("same exact identity route change follows one card without duplication", () => {
  const local = fixture.regular7;
  let state = gate(null, [arrival(local)], [evidence(local)]);
  const changedArrival = arrival(local, { route: "7X" });
  const changedEvidence = evidence(local, {
    route: "7X",
    tripUpdateRoute: "7X",
    vehicleRoute: "7X",
    tripUpdateObservedRoutes: ["7X"],
    feedTimestamp: FEED + 15,
    vehicle: {
      ...evidence(local).vehicle,
      routeId: "7X",
      timestamp: FEED + 10
    }
  });
  state = gate(state, [changedArrival], [changedEvidence]);

  assert.equal(state.active[local.identityKey].route, "7X");
  assert.equal(state.active[local.identityKey].routeDecision.changed, true);
  assert.equal(
    state.active[local.identityKey].lastConclusiveStoppingPattern.route,
    "7X"
  );
  const board = arrivalProofBoardArrivals(state, [changedArrival]);
  assert.equal(board.filter(item => item.identityKey === local.identityKey).length, 1);
  assert.equal(board[0].route, "7X");

  let locked = lock(
    null,
    [arrival(local, { time: "0" })],
    [evidence(local)]
  );
  locked = lock(locked, [], [changedEvidence]);
  assert.equal(locked.active[local.identityKey].route, "7X");
  assert.equal(locked.active[local.identityKey].routeDecision.changed, true);
  assert.equal(
    experimentalBoardArrivals(locked, [])
      .filter(item => item.identityKey === local.identityKey)
      .length,
    1
  );

  let quarantine = reconcileVehicleProofQuarantine(
    null,
    {
      arrivals: [arrival(local, { time: "4" })],
      evidence: [evidence(local)]
    },
    NOW
  );
  quarantine = reconcileVehicleProofQuarantine(
    quarantine,
    {
      arrivals: [arrival(local, { route: "7X", time: "3" })],
      evidence: [changedEvidence]
    },
    NOW + 15000
  );
  assert.equal(quarantine.admitted[local.identityKey].route, "7X");
  assert.equal(
    vehicleProofCandidateArrivals(quarantine)
      .filter(item => item.identityKey === local.identityKey)
      .length,
    1
  );
});

test("simultaneous route labels and TU/VP disagreement are deterministic and non-duplicating", () => {
  const local = fixture.regular7;
  const entities = [
    {
      tripUpdate: {
        trip: {
          tripId: local.tripId,
          startDate: local.startDate,
          routeId: "7"
        },
        stopTimeUpdate: [{ stopId: TARGET }]
      }
    },
    {
      tripUpdate: {
        trip: {
          tripId: local.tripId,
          startDate: local.startDate,
          routeId: "7X"
        },
        stopTimeUpdate: [{ stopId: TARGET }]
      }
    },
    {
      vehicle: {
        trip: {
          tripId: local.tripId,
          startDate: local.startDate,
          routeId: "7X"
        },
        stopId: TARGET,
        currentStopSequence: 19,
        currentStatus: VEHICLE_STATUSES.STOPPED_AT,
        timestamp: FEED
      }
    }
  ];
  const [built] = buildGtfsEvidence(
    entities,
    TARGET,
    FEED,
    () => 17
  );
  assert.deepEqual(built.tripUpdateObservedRoutes, ["7", "7X"]);
  assert.equal(built.tripUpdateRouteAmbiguous, true);
  assert.equal(built.route, "");

  const state = gate(
    null,
    [
      arrival(local, { route: "7" }),
      arrival(local, { route: "7X" })
    ],
    [built]
  );
  assert.equal(Object.keys(state.active).length, 0);

  const quarantine = reconcileVehicleProofQuarantine(
    null,
    {
      arrivals: [
        arrival(local, { route: "7", time: "4" }),
        arrival(local, { route: "7X", time: "4" })
      ],
      evidence: [built]
    },
    NOW
  );
  assert.equal(
    Object.keys(quarantine.quarantined).filter(key => key === local.identityKey).length,
    1
  );
  assert.equal(quarantine.quarantined[local.identityKey].routeAmbiguous, true);
});

test("TripUpdate and VehiclePosition route disagreement rejects movement proof", () => {
  const local = fixture.regular7;
  const [built] = buildGtfsEvidence(
    [
      {
        tripUpdate: {
          trip: {
            tripId: local.tripId,
            startDate: local.startDate,
            routeId: "7"
          },
          stopTimeUpdate: [{ stopId: TARGET }]
        }
      },
      {
        vehicle: {
          trip: {
            tripId: local.tripId,
            startDate: local.startDate,
            routeId: "7X"
          },
          stopId: TARGET,
          currentStopSequence: 19,
          currentStatus: VEHICLE_STATUSES.STOPPED_AT,
          timestamp: FEED
        }
      }
    ],
    TARGET,
    FEED,
    () => 17
  );
  assert.equal(built.route, "7");
  assert.equal(built.tripUpdateRoute, "7");
  assert.equal(built.vehicleRoute, "7X");
  assert.equal(built.routeIdMismatch, true);

  const gated = gate(null, [arrival(local)], [built]);
  assert.equal(Object.keys(gated.active).length, 0);
  const quarantine = reconcileVehicleProofQuarantine(
    null,
    {
      arrivals: [arrival(local, { time: "4" })],
      evidence: [{
        ...built,
        feedSucceeded: true,
        feedStale: false,
        vehicleAgeSeconds: 0
      }]
    },
    NOW
  );
  assert.ok(quarantine.quarantined[local.identityKey]);

  let establishedGate = gate(
    null,
    [arrival(local)],
    [evidence(local)]
  );
  establishedGate = gate(
    establishedGate,
    [arrival(local)],
    [{
      ...built,
      feedSucceeded: true,
      feedStale: false,
      vehicleAgeSeconds: 0
    }]
  );
  assert.ok(establishedGate.active[local.identityKey]);
  assert.equal(
    establishedGate.active[local.identityKey].entryDecision.reason,
    "EXACT_IDENTITY_EVIDENCE_UNAVAILABLE"
  );

  let establishedLock = lock(
    null,
    [arrival(local, { time: "0" })],
    [evidence(local)]
  );
  establishedLock = lock(
    establishedLock,
    [],
    [{
      ...built,
      feedSucceeded: true,
      feedStale: false,
      vehicleAgeSeconds: 0
    }]
  );
  assert.ok(establishedLock.active[local.identityKey]);
  assert.equal(establishedLock.released.length, 0);
  assert.equal(
    establishedLock.active[local.identityKey].releaseDecision.reason,
    "EXACT_IDENTITY_EVIDENCE_UNAVAILABLE"
  );
});

test("route cards retain independent three-arrival limits", () => {
  const identities = [
    ...Array.from({ length: 4 }, (_, index) => ({
      ...arrival(fixture.regular7, {
        identityKey: `local-${index}|20260730`,
        tripId: `local-${index}`,
        time: String(index + 2)
      })
    })),
    ...Array.from({ length: 4 }, (_, index) => ({
      ...arrival(fixture.express7X, {
        identityKey: `express-${index}|20260730`,
        tripId: `express-${index}`,
        time: String(index + 2)
      })
    }))
  ];
  const board = experimentalBoardArrivals(null, identities);
  assert.equal(board.filter(item => item.route === "7").length, 3);
  assert.equal(board.filter(item => item.route === "7X").length, 3);
});
