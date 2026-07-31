import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  createVehicleProofQuarantineDiagnostics,
  hasFreshQualifyingVehicle,
  initialVehicleProofQuarantineState,
  inspectVehicleProofQuarantineState,
  reconcileVehicleProofQuarantine,
  vehicleProofCandidateArrivals,
  VEHICLE_PROOF_QUARANTINE_REASON
} from "../public/vehicle-proof-quarantine.js";
import {
  arrivalProofBoardArrivals,
  initialArrivalProofGateState,
  reconcileArrivalProofGates
} from "../public/arrival-proof-gate.js";
import {
  reconcileDepartureProofLocks,
  RELEASE_REASONS
} from "../public/departure-proof-lock.js";

const NOW = Date.parse("2026-07-30T21:00:00.000Z");
const PLATFORM = "723N";

function arrival(overrides = {}) {
  return {
    platformId: PLATFORM,
    route: "7",
    time: "5",
    station: "Flushing-Main St",
    direction: "Northbound",
    identityKey: "125100_7..N|20260730",
    tripId: "125100_7..N",
    startDate: "20260730",
    ...overrides
  };
}

function evidence(overrides = {}) {
  return {
    identityKey: "125100_7..N|20260730",
    tripId: "125100_7..N",
    startDate: "20260730",
    route: "7",
    targetStop: PLATFORM,
    targetStopPresent: true,
    targetStopSequence: 4,
    tripUpdatePresent: true,
    vehiclePositionPresent: true,
    vehiclePositionAmbiguous: false,
    vehicle: {
      stopId: "724N",
      currentStopSequence: 3,
      currentStopSequenceExplicit: true,
      currentStatus: null,
      currentStatusExplicit: false,
      timestamp: NOW / 1000 - 10
    },
    feedTimestamp: NOW / 1000 - 4,
    feedSucceeded: true,
    feedAgeSeconds: 4,
    feedStale: false,
    vehicleAgeSeconds: 10,
    stopUpdates: [{ stopId: PLATFORM, eventTime: NOW / 1000 + 300 }],
    ...overrides
  };
}

function reconcile(state, arrivals, evidences, now = NOW) {
  return reconcileVehicleProofQuarantine(
    state || initialVehicleProofQuarantineState(),
    { arrivals, evidence: evidences },
    now
  );
}

test("TripUpdate-only candidate above five remains visible", () => {
  const item = arrival({ time: "6" });
  const state = reconcile(null, [item], [
    evidence({ vehiclePositionPresent: false, vehicle: null, vehicleAgeSeconds: null })
  ]);
  assert.deepEqual(vehicleProofCandidateArrivals(state), [item]);
});

test("never-fresh exact identity at five is quarantined", () => {
  const state = reconcile(null, [arrival()], [
    evidence({ vehiclePositionPresent: false, vehicle: null, vehicleAgeSeconds: null })
  ]);
  assert.deepEqual(vehicleProofCandidateArrivals(state), []);
  assert.equal(
    state.quarantined[arrival().identityKey].reason,
    VEHICLE_PROOF_QUARANTINE_REASON
  );
});

test("never-fresh identities from four through zero are quarantined", () => {
  for (const countdown of [4, 3, 2, 1, 0]) {
    const item = arrival({
      time: String(countdown),
      identityKey: `trip-${countdown}|20260730`,
      tripId: `trip-${countdown}`
    });
    const proof = evidence({
      identityKey: item.identityKey,
      tripId: item.tripId,
      vehiclePositionPresent: false,
      vehicle: null,
      vehicleAgeSeconds: null
    });
    assert.deepEqual(vehicleProofCandidateArrivals(reconcile(null, [item], [proof])), []);
  }
});

test("fresh exact VehiclePosition admits inside the window", () => {
  assert.equal(hasFreshQualifyingVehicle(evidence()), true);
  assert.deepEqual(vehicleProofCandidateArrivals(reconcile(null, [arrival()], [evidence()])), [
    arrival()
  ]);
});

test("stale, missing-timestamp, ambiguous, and failed-feed VP cannot initially admit", () => {
  const variants = [
    evidence({ vehicleAgeSeconds: 121 }),
    evidence({ vehicle: { ...evidence().vehicle, timestamp: null } }),
    evidence({ vehiclePositionPresent: false, vehiclePositionAmbiguous: true, vehicle: null }),
    evidence({ feedSucceeded: false }),
    evidence({ feedStale: true })
  ];
  for (const proof of variants) {
    assert.equal(hasFreshQualifyingVehicle(proof), false);
    assert.deepEqual(vehicleProofCandidateArrivals(reconcile(null, [arrival()], [proof])), []);
  }
});

test("protobuf-defaulted status is not required for quarantine admission", () => {
  const proof = evidence({
    vehicle: {
      ...evidence().vehicle,
      currentStatus: null,
      currentStatusExplicit: false
    }
  });
  assert.equal(hasFreshQualifyingVehicle(proof), true);
});

test("mismatched exact identity cannot admit", () => {
  const other = evidence({
    identityKey: "125150_7..N|20260730",
    tripId: "125150_7..N"
  });
  assert.deepEqual(vehicleProofCandidateArrivals(reconcile(null, [arrival()], [other])), []);
});

test("same tripId with a different startDate cannot inherit proof", () => {
  const otherDate = arrival({
    identityKey: "125100_7..N|20260731",
    startDate: "20260731"
  });
  const state = reconcile(null, [arrival()], [evidence()]);
  const next = reconcile(state, [otherDate], [
    evidence({
      identityKey: otherDate.identityKey,
      startDate: otherDate.startDate,
      vehiclePositionPresent: false,
      vehicle: null,
      vehicleAgeSeconds: null
    })
  ]);
  assert.deepEqual(vehicleProofCandidateArrivals(next), []);
});

test("prior fresh exact VP permits temporary disappearance or staleness", () => {
  const first = reconcile(null, [arrival()], [evidence()]);
  const missing = evidence({
    vehiclePositionPresent: false,
    vehicle: null,
    vehicleAgeSeconds: null
  });
  const second = reconcile(first, [arrival({ time: "2" })], [missing], NOW + 15000);
  const stale = evidence({ vehicleAgeSeconds: 500 });
  const third = reconcile(second, [arrival({ time: "1" })], [stale], NOW + 30000);
  assert.deepEqual(vehicleProofCandidateArrivals(second), [arrival({ time: "2" })]);
  assert.deepEqual(vehicleProofCandidateArrivals(third), [arrival({ time: "1" })]);
});

test("quarantined identity returns immediately on fresh exact VP", () => {
  const first = reconcile(null, [arrival()], [
    evidence({ vehiclePositionPresent: false, vehicle: null, vehicleAgeSeconds: null })
  ]);
  const second = reconcile(first, [arrival({ time: "4" })], [evidence()], NOW + 15000);
  assert.deepEqual(vehicleProofCandidateArrivals(second), [arrival({ time: "4" })]);
  assert.equal(second.quarantined[arrival().identityKey], undefined);
});

test("fresh proof observed outside five supplies exact historical continuity", () => {
  const first = reconcile(null, [arrival({ time: "8" })], [evidence()]);
  const second = reconcile(first, [arrival({ time: "5" })], [
    evidence({ vehiclePositionPresent: false, vehicle: null, vehicleAgeSeconds: null })
  ]);
  assert.deepEqual(vehicleProofCandidateArrivals(second), [arrival({ time: "5" })]);
});

test("same-route limiting cannot promote a quarantined identity", () => {
  const unsupported = arrival({ time: "2" });
  const supported = [3, 4, 5].map((time, index) => arrival({
    time: String(time),
    identityKey: `supported-${index}|20260730`,
    tripId: `supported-${index}`
  }));
  const proofs = [
    evidence({
      vehiclePositionPresent: false,
      vehicle: null,
      vehicleAgeSeconds: null
    }),
    ...supported.map(item => evidence({
      identityKey: item.identityKey,
      tripId: item.tripId
    }))
  ];
  const board = vehicleProofCandidateArrivals(
    reconcile(null, [unsupported, ...supported], proofs)
  ).slice(0, 3);
  assert.deepEqual(
    board.map(item => item.identityKey),
    supported.map(item => item.identityKey)
  );
  assert.equal(board.some(item => item.identityKey === unsupported.identityKey), false);
});

test("platform suppression remains authoritative over admitted history", () => {
  const first = reconcile(null, [arrival()], [evidence()]);
  assert.equal(vehicleProofCandidateArrivals(first).length, 1);
  const platformFiltered = reconcile(first, [], [evidence()], NOW + 15000);
  assert.deepEqual(vehicleProofCandidateArrivals(platformFiltered), []);
  assert.equal(Boolean(platformFiltered.everFresh[arrival().identityKey]), true);
});

test("quarantined evidence remains in the caller snapshot and diagnostics", () => {
  const snapshot = {
    arrivals: [arrival()],
    evidence: [evidence({ vehiclePositionPresent: false, vehicle: null, vehicleAgeSeconds: null })]
  };
  const state = reconcileVehicleProofQuarantine(
    initialVehicleProofQuarantineState(),
    snapshot,
    NOW
  );
  assert.equal(snapshot.evidence.length, 1);
  assert.equal(
    inspectVehicleProofQuarantineState(state).quarantinedIdentities[0]
      .evidence.tripUpdatePresent,
    true
  );
});

test("quarantined identity cannot enroll in Arrival-Proof Gate", () => {
  const proof = evidence({
    vehiclePositionPresent: false,
    vehicle: null,
    vehicleAgeSeconds: null
  });
  const quarantine = reconcile(null, [arrival({ time: "1" })], [proof]);
  const gate = reconcileArrivalProofGates(
    initialArrivalProofGateState(),
    { arrivals: vehicleProofCandidateArrivals(quarantine), evidence: [proof] },
    NOW
  );
  assert.equal(Object.keys(gate.active).length, 0);
});

test("an existing active gate is unchanged by later quarantine filtering", () => {
  const proof = evidence();
  const gate = reconcileArrivalProofGates(
    initialArrivalProofGateState(),
    { arrivals: [arrival({ time: "1" })], evidence: [proof] },
    NOW
  );
  const quarantine = reconcile(null, [arrival({ time: "0" })], [
    evidence({ vehiclePositionPresent: false, vehicle: null, vehicleAgeSeconds: null })
  ]);
  const nextGate = reconcileArrivalProofGates(
    gate,
    {
      arrivals: vehicleProofCandidateArrivals(quarantine),
      evidence: [
        evidence({ vehiclePositionPresent: false, vehicle: null, vehicleAgeSeconds: null })
      ]
    },
    NOW + 15000
  );
  assert.equal(nextGate.active[arrival().identityKey].state, "GATED_AT_ONE");
  assert.equal(arrivalProofBoardArrivals(nextGate, [])[0].time, "1");
});

test("supported identity confirms through the existing gate-to-lock path", () => {
  const initialEvidence = evidence();
  const quarantine = reconcile(null, [arrival({ time: "1" })], [initialEvidence]);
  let gate = reconcileArrivalProofGates(
    initialArrivalProofGateState(),
    {
      arrivals: vehicleProofCandidateArrivals(quarantine),
      evidence: [initialEvidence]
    },
    NOW
  );
  const enteringEvidence = evidence({
    vehicle: {
      ...evidence().vehicle,
      stopId: PLATFORM,
      currentStopSequence: 4,
      currentStatus: 0,
      currentStatusExplicit: true,
      timestamp: NOW / 1000 + 5
    },
    vehicleAgeSeconds: 0
  });
  gate = reconcileArrivalProofGates(
    gate,
    { arrivals: [arrival({ time: "0" })], evidence: [enteringEvidence] },
    NOW + 15000
  );
  const confirmed = arrivalProofBoardArrivals(gate, []);
  const lock = reconcileDepartureProofLocks(
    null,
    { arrivals: confirmed, evidence: [enteringEvidence] },
    NOW + 15000
  );
  assert.equal(confirmed[0].arrivalProofEntryConfirmed, true);
  assert.ok(lock.active[arrival().identityKey]);
  assert.deepEqual(Object.values(RELEASE_REASONS), [
    "VEHICLE_DOWNSTREAM",
    "TRIP_UPDATE_DOWNSTREAM",
    "TARGET_STOP_REMOVED_WITH_DOWNSTREAM_EVIDENCE"
  ]);
});

test("negative candidates remain excluded", () => {
  const state = reconcile(null, [arrival({ time: "-1" })], [evidence()]);
  assert.deepEqual(vehicleProofCandidateArrivals(state), []);
});

test("platform and direction state maps do not share historical continuity", () => {
  const north = reconcile(null, [arrival()], [evidence()]);
  const southArrival = arrival({
    platformId: "723S",
    direction: "Southbound",
    identityKey: "126500_7..S|20260730",
    tripId: "126500_7..S"
  });
  const southEvidence = evidence({
    identityKey: southArrival.identityKey,
    tripId: southArrival.tripId,
    targetStop: "723S",
    vehiclePositionPresent: false,
    vehicle: null,
    vehicleAgeSeconds: null
  });
  const south = reconcile(null, [southArrival], [southEvidence]);
  assert.equal(Boolean(north.everFresh[arrival().identityKey]), true);
  assert.deepEqual(vehicleProofCandidateArrivals(south), []);
});

test("a reload begins without historical continuity", () => {
  const beforeReload = reconcile(null, [arrival()], [evidence()]);
  assert.equal(Object.keys(beforeReload.everFresh).length, 1);
  const afterReload = reconcile(null, [arrival({ time: "1" })], [
    evidence({ vehiclePositionPresent: false, vehicle: null, vehicleAgeSeconds: null })
  ]);
  assert.deepEqual(vehicleProofCandidateArrivals(afterReload), []);
});

test("observed live ghost and stale-VP fixtures are quarantined inside five", () => {
  const fixtures = [
    ["125100_7..N|20260730", "125100_7..N", 1, null],
    ["126500_7..S|20260730", "126500_7..S", 3, null],
    ["127100_7X..N|20260730", "127100_7X..N", 2, null],
    ["128500_7..S|20260730", "128500_7..S", 5, null],
    ["127500_7..S|20260730", "127500_7..S", 4, 1060]
  ];
  for (const [identityKey, tripId, time, staleAge] of fixtures) {
    const item = arrival({ identityKey, tripId, time: String(time) });
    const proof = evidence({
      identityKey,
      tripId,
      vehiclePositionPresent: staleAge !== null,
      vehicle: staleAge === null ? null : evidence().vehicle,
      vehicleAgeSeconds: staleAge
    });
    assert.deepEqual(vehicleProofCandidateArrivals(reconcile(null, [item], [proof])), []);
  }
});

test("diagnostics are deeply detached, frozen, and expose only inspect", () => {
  const state = reconcile(null, [arrival()], [evidence()]);
  const diagnostics = createVehicleProofQuarantineDiagnostics(
    new Map([[PLATFORM, state]])
  );
  const first = diagnostics.inspect();
  const before = JSON.stringify(first);
  assert.notEqual(first.admittedIdentities[0], state.admitted[arrival().identityKey]);
  assert.throws(() => {
    first.admittedIdentities[0].arrival.time = "99";
  }, TypeError);
  assert.throws(() => {
    first.everFreshIdentities[0].latestEvidence.vehicle.stopId = "WRONG";
  }, TypeError);
  assert.throws(() => {
    first.transitions.push({});
  }, TypeError);
  assert.equal(JSON.stringify(diagnostics.inspect()), before);
  assert.deepEqual(Object.keys(diagnostics), ["inspect"]);
});

function activationPolicy(html) {
  const match = html.match(
    /function isVehicleProofQuarantineEnabled\(searchParams\) \{[\s\S]*?\n\}/
  );
  assert.ok(match);
  return new Function(
    "URLSearchParams",
    `${match[0]}; return value => isVehicleProofQuarantineEnabled(new URLSearchParams(value));`
  )(URLSearchParams);
}

test("default-on, explicit-on, and emergency-off activation are isolated", () => {
  const html = fs.readFileSync(
    new URL("../public/arrivals.html", import.meta.url),
    "utf8"
  );
  const policy = activationPolicy(html);
  assert.equal(policy(""), true);
  assert.equal(policy("vehicleProofQuarantine=1"), true);
  assert.equal(policy("vehicleProofQuarantine=0"), false);
  assert.match(
    html,
    /vehicleProofQuarantineEnabled\s*\? import\("\.\/vehicle-proof-quarantine\.js"\)\s*:\s*null/
  );
  assert.match(
    html,
    /if \(vehicleProofQuarantineEnabled\) \{\s*query\.set\("vehicleProofQuarantine", "1"\);/
  );
  assert.match(
    html,
    /const vehicleProofQuarantineStates =\s*vehicleProofQuarantineEnabled \? new Map\(\) : null;/
  );
});

test("client ordering is platform suppression, quarantine, gate, then lock", () => {
  const html = fs.readFileSync(
    new URL("../public/arrivals.html", import.meta.url),
    "utf8"
  );
  const quarantine = html.indexOf("if (vehicleProofQuarantineEnabled)", 70000);
  const gate = html.indexOf("if (arrivalProofGateEnabled)", quarantine);
  const lock = html.indexOf("if (departureProofLockEnabled)", gate);
  assert.ok(quarantine > 0);
  assert.ok(gate > quarantine);
  assert.ok(lock > gate);
  assert.match(
    html,
    /vehicleProofArrivals\([\s\S]*?filterPlatformUnavailableArrivals\([\s\S]*?reconcileVehicleProofQuarantine/
  );
});

test("emergency-off leaves lock and platform suppression independently enabled", () => {
  const html = fs.readFileSync(
    new URL("../public/arrivals.html", import.meta.url),
    "utf8"
  );
  assert.match(
    html,
    /const departureProofLockEnabled =\s*isDepartureProofLockEnabled\(params\)/
  );
  assert.match(
    html,
    /const platformAlertSuppressionEnabled =\s*isPlatformAlertSuppressionEnabled\(params\)/
  );
});
