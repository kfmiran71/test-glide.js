import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import {
  createForeverEngine,
  DECISION_REASONS,
  MOVEMENT_STATES,
  SERVICE_ROLES
} from "../forever-engine/engine.js";
import { normalizeGtfsEntities } from "../forever-engine/gtfs-normalizer.js";
import { replaySnapshots } from "../forever-engine/replay.js";

const html = fs.readFileSync(new URL("../public/arrivals.html", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
const groupArrivalsSource = html.slice(
  html.indexOf("function groupArrivals"),
  html.indexOf("function routeColor")
);
const groupArrivals = vm.runInNewContext(`(${groupArrivalsSource.trim()})`);

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);
const NOW_SECONDS = NOW / 1000;
const TARGET = "705N";

function trip(overrides = {}) {
  return {
    trip: { tripId: "trip-a", startDate: "20260801", routeId: "7" },
    tripUpdatePresent: true,
    cancelled: false,
    destination: "Flushing-Main St",
    direction: "Northbound",
    stopUpdates: [
      { stopId: "704N", stopSequence: 4, eventTime: NOW_SECONDS - 60 },
      { stopId: TARGET, stopSequence: 7, eventTime: NOW_SECONDS + 120 },
      { stopId: "706N", stopSequence: 11, eventTime: NOW_SECONDS + 240 }
    ],
    vehicle: {
      stopId: "704N",
      timestamp: NOW_SECONDS,
      currentStopSequence: 4,
      currentStopSequenceExplicit: true,
      currentStatus: 2,
      currentStatusExplicit: true
    },
    vehicleAmbiguous: false,
    feedTimestamp: NOW_SECONDS,
    ...overrides
  };
}

function reconcile(engine, trips, at = NOW, platform = TARGET) {
  return engine.reconcile({ platform, observedAt: at, feedTimestamp: at / 1000, trips });
}

test("credible predictions receive exact-identity custody before the final minute", () => {
  const engine = createForeverEngine();
  const result = reconcile(engine, [trip()]);
  assert.equal(result.arrivals.length, 1);
  assert.equal(result.arrivals[0].identityKey, "trip-a|20260801");
  assert.equal(result.arrivals[0].time, "2");
  assert.equal(result.diagnostics.active[0].movementState, MOVEMENT_STATES.MOVING_UPSTREAM);
});

test("a never-validated TripUpdate-only prediction is suppressed inside five minutes", () => {
  const engine = createForeverEngine();
  const result = reconcile(engine, [trip({ vehicle: null })]);
  assert.equal(result.arrivals.length, 0);
  assert.equal(result.diagnostics.active.length, 0);
  const inspected = engine.inspect(TARGET)[TARGET];
  assert.equal(
    inspected[0].decisionReason,
    DECISION_REASONS.SUPPRESSED_ORPHAN_TRIP_UPDATE
  );
  assert.equal(inspected[0].departureLocked, false);
});

test("a feed-consistent future TripUpdate is recovered on its first snapshot", () => {
  const engine = createForeverEngine();
  const result = reconcile(engine, [trip({
    vehicle: null,
    stopUpdates: [
      { stopId: "704N", stopSequence: 4, eventTime: NOW_SECONDS + 6 * 60 },
      { stopId: TARGET, stopSequence: 7, eventTime: NOW_SECONDS + 8 * 60 },
      { stopId: "706N", stopSequence: 11, eventTime: NOW_SECONDS + 10 * 60 }
    ]
  })]);
  assert.equal(result.arrivals.length, 1);
  assert.equal(result.arrivals[0].time, "8");
  assert.equal(
    result.diagnostics.active[0].decisionReason,
    DECISION_REASONS.RECOVERED_FEED_CONSISTENT_FUTURE
  );
});

test("future recovery becomes persistent and follows the identity into the strict window", () => {
  const engine = createForeverEngine();
  const future = trip({
    vehicle: null,
    stopUpdates: [
      { stopId: "704N", stopSequence: 4, eventTime: NOW_SECONDS + 6 * 60 },
      { stopId: TARGET, stopSequence: 7, eventTime: NOW_SECONDS + 8 * 60 },
      { stopId: "706N", stopSequence: 11, eventTime: NOW_SECONDS + 10 * 60 }
    ]
  });
  const first = reconcile(engine, [future]);
  assert.equal(first.diagnostics.active[0].decisionReason,
    DECISION_REASONS.RECOVERED_FEED_CONSISTENT_FUTURE);
  const second = reconcile(engine, [{
    ...future,
    feedTimestamp: NOW_SECONDS + 30
  }], NOW + 30_000);
  assert.equal(second.diagnostics.active[0].decisionReason,
    DECISION_REASONS.RECOVERED_PERSISTENT_FUTURE);
  const near = reconcile(engine, [trip({
    vehicle: null,
    feedTimestamp: NOW_SECONDS + 60,
    stopUpdates: [
      { stopId: "704N", stopSequence: 4, eventTime: NOW_SECONDS + 60 },
      { stopId: TARGET, stopSequence: 7, eventTime: NOW_SECONDS + 4 * 60 },
      { stopId: "706N", stopSequence: 11, eventTime: NOW_SECONDS + 6 * 60 }
    ]
  })], NOW + 60_000);
  assert.equal(near.arrivals.length, 1);
  assert.equal(near.arrivals[0].time, "3");
  assert.equal(near.diagnostics.active[0].decisionReason,
    DECISION_REASONS.RECOVERED_PERSISTENT_FUTURE);
});

test("same-feed repetition cannot manufacture persistent future recovery", () => {
  const engine = createForeverEngine();
  const future = trip({
    vehicle: null,
    stopUpdates: [
      { stopId: "704N", stopSequence: 4, eventTime: NOW_SECONDS + 6 * 60 },
      { stopId: TARGET, stopSequence: 7, eventTime: NOW_SECONDS + 8 * 60 },
      { stopId: "706N", stopSequence: 11, eventTime: NOW_SECONDS + 10 * 60 }
    ]
  });
  reconcile(engine, [future]);
  const repeated = reconcile(engine, [future], NOW + 15_000);
  assert.equal(repeated.diagnostics.active[0].decisionReason,
    DECISION_REASONS.RECOVERED_FEED_CONSISTENT_FUTURE);
  assert.equal(repeated.diagnostics.active[0].hasRecoveredFutureConfidence, false);
});

test("stale and incoherent orphan TripUpdates cannot recover", () => {
  const cases = [
    trip({ vehicle: null, feedTimestamp: NOW_SECONDS - 600 }),
    trip({
      vehicle: null,
      stopUpdates: [
        { stopId: "704N", eventTime: NOW_SECONDS + 8 * 60 },
        { stopId: TARGET, eventTime: NOW_SECONDS + 6 * 60 },
        { stopId: "706N", eventTime: NOW_SECONDS + 9 * 60 }
      ]
    })
  ];
  for (const candidate of cases) {
    const result = reconcile(createForeverEngine(), [candidate]);
    assert.equal(result.arrivals.length, 0);
  }
});

test("a vehicle-tagged coherent future TripUpdate may recover without its temporary VP", () => {
  const candidate = trip({
    vehicle: null,
    tripUpdateVehicleId: "temporarily-missing-vehicle",
    stopUpdates: [
      { stopId: "704N", eventTime: NOW_SECONDS + 6 * 60 },
      { stopId: TARGET, eventTime: NOW_SECONDS + 8 * 60 },
      { stopId: "706N", eventTime: NOW_SECONDS + 10 * 60 }
    ]
  });
  const result = reconcile(createForeverEngine(), [candidate]);
  assert.equal(result.arrivals[0].time, "8");
  assert.equal(result.diagnostics.active[0].decisionReason,
    DECISION_REASONS.RECOVERED_FEED_CONSISTENT_FUTURE);
});

test("target SKIPPED and NO_DATA relationships suppress before admission", () => {
  for (const scheduleRelationship of [1, 2]) {
    const result = reconcile(createForeverEngine(), [trip({
      stopUpdates: trip().stopUpdates.map(stop => stop.stopId === TARGET
        ? { ...stop, scheduleRelationship }
        : stop)
    })]);
    assert.equal(result.arrivals.length, 0);
    assert.equal(
      result.diagnostics.counts.active,
      0
    );
  }
});

test("fresh exact VehiclePosition admits a prediction inside five minutes", () => {
  const engine = createForeverEngine();
  const result = reconcile(engine, [trip()]);
  assert.equal(result.arrivals.length, 1);
  assert.equal(result.arrivals[0].identityKey, "trip-a|20260801");
});

test("a current VehiclePosition match does not create native future-recovery state", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip({
    stopUpdates: trip().stopUpdates.map(stop => stop.stopId === TARGET
      ? { ...stop, eventTime: NOW_SECONDS + 6 * 60 }
      : stop)
  })]);
  const result = reconcile(engine, [trip({
    vehicle: null,
    feedTimestamp: NOW_SECONDS + 15,
    stopUpdates: trip().stopUpdates.map(stop => stop.stopId === TARGET
      ? { ...stop, eventTime: NOW_SECONDS + 4 * 60 }
      : stop)
  })], NOW + 15_000);
  assert.equal(result.arrivals.length, 0);
  assert.equal(engine.inspect(TARGET)[TARGET][0].decisionReason,
    DECISION_REASONS.SUPPRESSED_ORPHAN_TRIP_UPDATE);
});

test("suppressed orphan cannot enter pre-entry custody or Departure-Proof Lock", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip({ vehicle: null })]);
  const missing = reconcile(engine, [], NOW + 15_000);
  assert.equal(missing.arrivals.length, 0);
  const zero = reconcile(engine, [trip({
    vehicle: null,
    feedTimestamp: NOW_SECONDS + 30,
    stopUpdates: trip().stopUpdates.map(stop => stop.stopId === TARGET
      ? { ...stop, eventTime: NOW_SECONDS + 30 }
      : stop)
  })], NOW + 30_000);
  assert.equal(zero.arrivals.length, 0);
  assert.equal(engine.inspect(TARGET)[TARGET][0].departureLocked, false);
});

test("terminal-origin TripUpdate-only prediction keeps its admission exception", () => {
  const engine = createForeverEngine();
  const result = reconcile(engine, [trip({
    vehicle: null,
    stopUpdates: [
      { stopId: TARGET, stopSequence: 1, eventTime: NOW_SECONDS + 3 * 60 },
      { stopId: "706N", stopSequence: 2, eventTime: NOW_SECONDS + 5 * 60 }
    ]
  })]);
  assert.equal(result.arrivals.length, 1);
  assert.equal(result.arrivals[0].time, "3");
  assert.equal(result.diagnostics.active[0].serviceRole, SERVICE_ROLES.ORIGIN_DEPARTURE);
});

test("static first-stop evidence identifies an origin when realtime sequences are absent", () => {
  const result = reconcile(createForeverEngine(), [trip({
    originStopId: TARGET,
    vehicle: null,
    stopUpdates: [
      { stopId: TARGET, eventTime: NOW_SECONDS + 3 * 60 },
      { stopId: "706N", eventTime: NOW_SECONDS + 5 * 60 }
    ]
  })]);
  assert.equal(result.arrivals.length, 1);
  assert.equal(result.diagnostics.active[0].serviceRole, SERVICE_ROLES.ORIGIN_DEPARTURE);
  assert.equal(result.diagnostics.active[0].staticOriginStop, TARGET);
});

test("target-first realtime suffix alone does not manufacture an origin role", () => {
  const result = reconcile(createForeverEngine(), [trip({
    vehicle: null,
    stopUpdates: [
      { stopId: TARGET, eventTime: NOW_SECONDS + 3 * 60 },
      { stopId: "706N", eventTime: NOW_SECONDS + 5 * 60 }
    ]
  })]);
  assert.equal(result.diagnostics.active[0].serviceRole, SERVICE_ROLES.UNRESOLVED);
});

test("fresh exact STOPPED_AT creates distinct origin-departure custody", () => {
  const engine = createForeverEngine();
  const result = reconcile(engine, [trip({
    originStopId: TARGET,
    stopUpdates: [
      { stopId: TARGET, eventTime: NOW_SECONDS },
      { stopId: "706N", eventTime: NOW_SECONDS + 2 * 60 }
    ],
    vehicle: {
      stopId: TARGET,
      timestamp: NOW_SECONDS,
      currentStopSequence: 1,
      currentStopSequenceExplicit: true,
      currentStatus: 1,
      currentStatusExplicit: true
    }
  })]);
  assert.equal(result.arrivals[0].time, "0");
  assert.equal(result.arrivals[0].originDepartureCustody, true);
  assert.equal(result.arrivals[0].departureProofLocked, false);
  assert.equal(result.diagnostics.active[0].decisionReason,
    DECISION_REASONS.ORIGIN_DEPARTURE_CUSTODY);
});

test("origin custody survives the scheduled clock and first missing VehiclePosition", () => {
  const engine = createForeverEngine();
  const stopped = trip({
    originStopId: TARGET,
    stopUpdates: [
      { stopId: TARGET, eventTime: NOW_SECONDS },
      { stopId: "706N", eventTime: NOW_SECONDS + 2 * 60 }
    ],
    vehicle: {
      stopId: TARGET,
      timestamp: NOW_SECONDS,
      currentStopSequence: 1,
      currentStopSequenceExplicit: true,
      currentStatus: 1,
      currentStatusExplicit: true
    }
  });
  reconcile(engine, [stopped]);
  const held = reconcile(engine, [{
    ...stopped,
    feedTimestamp: NOW_SECONDS + 15,
    vehicle: null,
    vehiclePositionMatched: false,
    stopUpdates: stopped.stopUpdates.map(stop => ({
      ...stop,
      eventTime: stop.eventTime - 60
    }))
  }], NOW + 15_000);
  assert.equal(held.arrivals[0].time, "0");
  assert.equal(held.arrivals[0].originDepartureCustody, true);
  assert.equal(held.diagnostics.active[0].released, false);
  assert.equal(held.diagnostics.active[0].decisionReason,
    DECISION_REASONS.ORIGIN_DEPARTURE_HOLD);
});

test("origin custody survives complete snapshot disappearance", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip({
    originStopId: TARGET,
    stopUpdates: [
      { stopId: TARGET, eventTime: NOW_SECONDS },
      { stopId: "706N", eventTime: NOW_SECONDS + 2 * 60 }
    ],
    vehicle: {
      stopId: TARGET,
      timestamp: NOW_SECONDS,
      currentStopSequence: 1,
      currentStopSequenceExplicit: true,
      currentStatus: 1,
      currentStatusExplicit: true
    }
  })]);
  const held = reconcile(engine, [], NOW + 15_000);
  assert.equal(held.arrivals[0].time, "0");
  assert.equal(held.diagnostics.active[0].decisionReason,
    DECISION_REASONS.ORIGIN_DEPARTURE_HOLD);
});

test("exact downstream VehiclePosition releases origin custody", () => {
  const engine = createForeverEngine();
  const stopped = trip({
    originStopId: TARGET,
    stopUpdates: [
      { stopId: TARGET, eventTime: NOW_SECONDS },
      { stopId: "706N", eventTime: NOW_SECONDS + 2 * 60 }
    ],
    vehicle: {
      stopId: TARGET,
      timestamp: NOW_SECONDS,
      currentStopSequence: 1,
      currentStopSequenceExplicit: true,
      currentStatus: 1,
      currentStatusExplicit: true
    }
  });
  reconcile(engine, [stopped]);
  const released = reconcile(engine, [{
    ...stopped,
    feedTimestamp: NOW_SECONDS + 15,
    stopUpdates: [{ stopId: "706N", eventTime: NOW_SECONDS + 90 }],
    vehicle: {
      stopId: "706N",
      timestamp: NOW_SECONDS + 15,
      currentStopSequence: 2,
      currentStopSequenceExplicit: true,
      currentStatus: 1,
      currentStatusExplicit: true
    }
  }], NOW + 15_000);
  assert.equal(released.arrivals.length, 0);
  assert.equal(released.diagnostics.released[0].releaseReason,
    DECISION_REASONS.EXACT_VEHICLE_DOWNSTREAM);
});

test("exact downstream TripUpdate progression releases origin custody despite lagging target VP", () => {
  const engine = createForeverEngine();
  const stopped = trip({
    originStopId: TARGET,
    stopUpdates: [
      { stopId: TARGET, eventTime: NOW_SECONDS },
      { stopId: "706N", eventTime: NOW_SECONDS + 2 * 60 },
      { stopId: "707N", eventTime: NOW_SECONDS + 4 * 60 }
    ],
    vehicle: {
      stopId: TARGET,
      timestamp: NOW_SECONDS,
      currentStopSequence: 1,
      currentStopSequenceExplicit: true,
      currentStatus: 1,
      currentStatusExplicit: true
    }
  });
  reconcile(engine, [stopped]);
  const released = reconcile(engine, [{
    ...stopped,
    feedTimestamp: NOW_SECONDS + 15,
    stopUpdates: [
      { stopId: "706N", eventTime: NOW_SECONDS + 90 },
      { stopId: "707N", eventTime: NOW_SECONDS + 210 }
    ],
    vehicle: {
      ...stopped.vehicle,
      timestamp: NOW_SECONDS + 15
    }
  }], NOW + 15_000);
  assert.equal(released.arrivals.length, 0);
  assert.equal(released.diagnostics.released[0].releaseReason,
    DECISION_REASONS.EXACT_DOWNSTREAM_PATTERN_OVERRIDES_TARGET);
});

test("temporary TripUpdate disappearance preserves a train already in pre-entry custody", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip()]);
  const result = reconcile(engine, [], NOW + 15_000);
  assert.equal(result.arrivals.length, 1);
  assert.equal(result.arrivals[0].time, "2");
  assert.equal(result.diagnostics.active[0].decisionReason, DECISION_REASONS.PRE_ENTRY_CUSTODY);
});

test("pre-entry custody expires after two distinct missing feed snapshots", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip()]);
  assert.equal(reconcile(engine, [], NOW + 15_000).arrivals.length, 1);
  assert.equal(reconcile(engine, [], NOW + 30_000).arrivals.length, 1);
  const expired = reconcile(engine, [], NOW + 45_000);
  assert.equal(expired.arrivals.length, 0);
});

test("pre-entry custody cannot preserve a prediction after its bounded arrival grace", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip({
    stopUpdates: trip().stopUpdates.map(stop => stop.stopId === TARGET
      ? { ...stop, eventTime: NOW_SECONDS + 60 }
      : stop)
  })]);
  const expired = reconcile(engine, [], NOW + 120_000);
  assert.equal(expired.arrivals.length, 0);
});

test("an established Departure-Proof lock releases on its first missing-VP refresh", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip({
    stopUpdates: trip().stopUpdates.map(stop => stop.stopId === TARGET
      ? { ...stop, eventTime: NOW_SECONDS }
      : stop),
    vehicle: {
      stopId: TARGET,
      timestamp: NOW_SECONDS,
      currentStopSequence: 7,
      currentStopSequenceExplicit: true,
      currentStatus: 1,
      currentStatusExplicit: true
    }
  })]);
  const released = reconcile(engine, [], NOW + 4 * 60 * 60 * 1000);
  assert.equal(released.arrivals.length, 0);
  assert.equal(released.diagnostics.released[0].releaseReason,
    DECISION_REASONS.FIRST_MISSING_EXACT_VEHICLE_POSITION);
});

test("a distant prediction is displayed while current but is not preserved after disappearance", () => {
  const engine = createForeverEngine({ custodyWindowMinutes: 10 });
  const distant = trip({
    stopUpdates: trip().stopUpdates.map(stop => stop.stopId === TARGET
      ? { ...stop, eventTime: NOW_SECONDS + 20 * 60 }
      : stop)
  });
  assert.equal(reconcile(engine, [distant]).arrivals[0].time, "20");
  const missing = reconcile(engine, [], NOW + 15_000);
  assert.equal(missing.arrivals.length, 0);
});

test("terminal arrivals display current evidence but never create an unreleasable downstream lock", () => {
  const engine = createForeverEngine();
  const terminal = trip({
    stopUpdates: [
      { stopId: "704N", eventTime: NOW_SECONDS - 60 },
      { stopId: TARGET, eventTime: NOW_SECONDS }
    ],
    vehicle: {
      stopId: TARGET,
      timestamp: NOW_SECONDS,
      currentStatus: 1,
      currentStatusExplicit: true
    }
  });
  const atTerminal = reconcile(engine, [terminal]);
  assert.equal(atTerminal.arrivals[0].time, "0");
  assert.equal(atTerminal.arrivals[0].departureProofLocked, false);
  assert.equal(atTerminal.diagnostics.active[0].serviceRole, SERVICE_ROLES.TERMINAL_ARRIVAL);
  const completed = reconcile(engine, [], NOW + 15_000);
  assert.equal(completed.arrivals.length, 0);
  assert.equal(completed.diagnostics.released[0].releaseReason, DECISION_REASONS.TERMINAL_TRIP_COMPLETED);
});

test("an expired terminal prediction cannot manufacture zero without fresh exact target VP", () => {
  const result = reconcile(createForeverEngine(), [trip({
    stopUpdates: [
      { stopId: "704N", eventTime: NOW_SECONDS - 10 * 60 },
      { stopId: TARGET, eventTime: NOW_SECONDS - 8 * 60 }
    ],
    vehicle: {
      stopId: "704N",
      timestamp: NOW_SECONDS - 30 * 60,
      currentStatus: 1,
      currentStatusExplicit: true
    }
  })]);
  assert.equal(result.arrivals.length, 0);
  assert.equal(result.diagnostics.counts.active, 0);
});

test("fresh exact target VP may hold terminal arrival zero after its clock expires", () => {
  const result = reconcile(createForeverEngine(), [trip({
    stopUpdates: [
      { stopId: "704N", eventTime: NOW_SECONDS - 3 * 60 },
      { stopId: TARGET, eventTime: NOW_SECONDS - 60 }
    ],
    vehicle: {
      stopId: TARGET,
      timestamp: NOW_SECONDS,
      currentStatus: 1,
      currentStatusExplicit: true
    }
  })]);
  assert.equal(result.arrivals[0].time, "0");
  assert.equal(result.diagnostics.active[0].serviceRole,
    SERVICE_ROLES.TERMINAL_ARRIVAL);
});

test("a fresh exact STOPPED_AT origin supersedes its timetable countdown with custody", () => {
  const engine = createForeverEngine();
  const origin = trip({
    destination: "Flushing-Main St",
    stopUpdates: [
      { stopId: TARGET, stopSequence: 1, eventTime: NOW_SECONDS + 60 },
      { stopId: "706N", stopSequence: 2, eventTime: NOW_SECONDS + 180 }
    ],
    vehicle: {
      stopId: TARGET,
      timestamp: NOW_SECONDS,
      currentStopSequence: 1,
      currentStopSequenceExplicit: true,
      currentStatus: 1,
      currentStatusExplicit: true
    }
  });
  const result = reconcile(engine, [origin]);
  assert.equal(result.arrivals[0].time, "0");
  assert.equal(result.arrivals[0].departureProofLocked, false);
  assert.equal(result.arrivals[0].originDepartureCustody, true);
  assert.equal(result.diagnostics.active[0].serviceRole, SERVICE_ROLES.ORIGIN_DEPARTURE);
});

test("target-first truncated realtime pattern with in-progress sequence remains an intermediate arrival", () => {
  const engine = createForeverEngine();
  const result = reconcile(engine, [trip({
    trip: { tripId: "borough-hall-held-4", startDate: "20260801", routeId: "4" },
    stopUpdates: [
      { stopId: TARGET, eventTime: NOW_SECONDS },
      { stopId: "706N", eventTime: NOW_SECONDS + 120 }
    ],
    vehicle: {
      stopId: TARGET,
      timestamp: NOW_SECONDS,
      currentStopSequence: 17,
      currentStopSequenceExplicit: true,
      currentStatus: 1,
      currentStatusExplicit: true
    }
  })]);
  assert.equal(result.arrivals[0].time, "0");
  assert.equal(result.arrivals[0].departureProofLocked, true);
  assert.equal(result.diagnostics.active[0].serviceRole, SERVICE_ROLES.INTERMEDIATE);
  assert.equal(result.diagnostics.active[0].decisionReason, DECISION_REASONS.EXACT_STOPPED_AT_TARGET);
});

test("target-first pattern without affirmative first-stop sequence cannot manufacture an origin", () => {
  const engine = createForeverEngine();
  const result = reconcile(engine, [trip({
    stopUpdates: [
      { stopId: TARGET, eventTime: NOW_SECONDS },
      { stopId: "706N", eventTime: NOW_SECONDS + 120 }
    ],
    vehicle: {
      stopId: TARGET,
      timestamp: NOW_SECONDS,
      currentStatus: 1,
      currentStatusExplicit: true
    }
  })]);
  assert.equal(result.arrivals[0].time, "0");
  assert.equal(result.diagnostics.active[0].serviceRole, SERVICE_ROLES.UNRESOLVED);
  assert.equal(result.arrivals[0].departureProofLocked, true);
});

test("replacement presentation keeps same-route destinations on independent cards", () => {
  const arrivals = [
    { route: "4", station: "167 St", time: "6", platformId: "257N" },
    { route: "4", station: "Woodlawn", time: "14", platformId: "257N" },
    { route: "4", station: "167 St", time: "22", platformId: "257N" }
  ];
  const replacementGroups = groupArrivals(arrivals, true);
  assert.deepEqual(
    Array.from(replacementGroups, group => ({ station: group.station, times: Array.from(group.times) })),
    [
      { station: "167 St", times: [6, 22] },
      { station: "Woodlawn", times: [14] }
    ]
  );
  const legacyGroups = groupArrivals(arrivals, false);
  assert.equal(legacyGroups.length, 1);
  assert.equal(legacyGroups[0].station, "167 St");
});

test("terminal classification survives a target-only final update using the last conclusive pattern", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip({
    stopUpdates: [
      { stopId: "704N", eventTime: NOW_SECONDS - 60 },
      { stopId: TARGET, eventTime: NOW_SECONDS + 60 }
    ]
  })]);
  const targetOnly = reconcile(engine, [trip({
    stopUpdates: [{ stopId: TARGET, eventTime: NOW_SECONDS }],
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: 1, currentStatusExplicit: true }
  })], NOW + 15_000);
  assert.equal(targetOnly.diagnostics.active[0].serviceRole, SERVICE_ROLES.TERMINAL_ARRIVAL);
  assert.equal(targetOnly.arrivals[0].departureProofLocked, false);
});

test("intermediate station entry and departure proof remain unchanged", () => {
  const engine = createForeverEngine();
  const stopped = reconcile(engine, [trip({
    stopUpdates: trip().stopUpdates.map(stop =>
      stop.stopId === TARGET ? { ...stop, eventTime: NOW_SECONDS } : stop
    ),
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: 1, currentStatusExplicit: true }
  })]);
  assert.equal(stopped.diagnostics.active[0].serviceRole, SERVICE_ROLES.INTERMEDIATE);
  assert.equal(stopped.arrivals[0].departureProofLocked, true);
});

test("a target-free TripUpdate suffix uses the last target-containing pattern to release downstream", () => {
  const engine = createForeverEngine();
  const stopped = trip({
    stopUpdates: [
      { stopId: "704N", eventTime: NOW_SECONDS - 60 },
      { stopId: TARGET, eventTime: NOW_SECONDS },
      { stopId: "706N", eventTime: NOW_SECONDS + 120 },
      { stopId: "707N", eventTime: NOW_SECONDS + 240 }
    ],
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: 1, currentStatusExplicit: true }
  });
  assert.equal(reconcile(engine, [stopped]).arrivals[0].time, "0");

  const downstream = trip({
    stopUpdates: [
      { stopId: "706N", eventTime: NOW_SECONDS + 30 },
      { stopId: "707N", eventTime: NOW_SECONDS + 150 }
    ],
    vehicle: { stopId: "706N", timestamp: NOW_SECONDS + 15, currentStatus: 1, currentStatusExplicit: true },
    feedTimestamp: NOW_SECONDS + 15
  });
  const released = reconcile(engine, [downstream], NOW + 15_000);
  assert.equal(released.arrivals.length, 0);
  assert.equal(released.diagnostics.released[0].releaseReason, DECISION_REASONS.EXACT_VEHICLE_DOWNSTREAM);
  assert.equal(released.diagnostics.released[0].lastPattern.some(stop => stop.stopId === TARGET), true);
});

test("a target-free suffix cannot release without an exact stop in the last conclusive pattern", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip({
    stopUpdates: [
      { stopId: "704N", eventTime: NOW_SECONDS - 60 },
      { stopId: TARGET, eventTime: NOW_SECONDS },
      { stopId: "706N", eventTime: NOW_SECONDS + 120 }
    ],
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: 1, currentStatusExplicit: true }
  })]);
  const ambiguous = reconcile(engine, [trip({
    stopUpdates: [{ stopId: "unmapped-stop", eventTime: NOW_SECONDS + 30 }],
    vehicle: { stopId: "unmapped-stop", timestamp: NOW_SECONDS + 15, currentStatus: 1, currentStatusExplicit: true },
    feedTimestamp: NOW_SECONDS + 15
  })], NOW + 15_000);
  assert.equal(ambiguous.arrivals[0].time, "0");
  assert.equal(ambiguous.diagnostics.active[0].decisionReason, DECISION_REASONS.DEPARTURE_PROOF_HOLD);
});

test("an exact downstream TripUpdate overrides a lagging target VehiclePosition by default", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip({
    stopUpdates: [
      { stopId: "704N", eventTime: NOW_SECONDS - 60 },
      { stopId: TARGET, eventTime: NOW_SECONDS },
      { stopId: "706N", eventTime: NOW_SECONDS + 120 }
    ],
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: 1, currentStatusExplicit: true }
  })]);
  const released = reconcile(engine, [trip({
    stopUpdates: [{ stopId: "706N", eventTime: NOW_SECONDS + 30 }],
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS + 15, currentStatus: 1, currentStatusExplicit: true },
    feedTimestamp: NOW_SECONDS + 15
  })], NOW + 15_000);
  assert.equal(released.arrivals.length, 0);
  assert.equal(
    released.diagnostics.released[0].releaseReason,
    DECISION_REASONS.EXACT_DOWNSTREAM_PATTERN_OVERRIDES_TARGET
  );
  assert.equal(released.diagnostics.released[0].history.at(-1).vehicle.position, "TARGET");
});

test("the first refresh missing an exact VehiclePosition releases an existing lock", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip({
    vehicle: {
      stopId: TARGET,
      timestamp: NOW_SECONDS,
      currentStatus: 1,
      currentStatusExplicit: true
    }
  })]);

  const released = reconcile(engine, [trip({
    vehicle: null,
    vehiclePositionMatched: false,
    feedTimestamp: NOW_SECONDS + 15
  })], NOW + 15_000);

  assert.equal(released.arrivals.length, 0);
  assert.equal(
    released.diagnostics.released[0].releaseReason,
    DECISION_REASONS.FIRST_MISSING_EXACT_VEHICLE_POSITION
  );
});

test("complete exact-trip disappearance releases a lock on the first refresh", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip({
    vehicle: {
      stopId: TARGET,
      timestamp: NOW_SECONDS,
      currentStatus: 1,
      currentStatusExplicit: true
    }
  })]);

  const released = reconcile(engine, [], NOW + 15_000);

  assert.equal(released.arrivals.length, 0);
  assert.equal(
    released.diagnostics.released[0].releaseReason,
    DECISION_REASONS.FIRST_MISSING_EXACT_VEHICLE_POSITION
  );
});

test("a stale but still exact VehiclePosition does not use the missing-VP emergency key", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip({
    vehicle: {
      stopId: TARGET,
      timestamp: NOW_SECONDS,
      currentStatus: 1,
      currentStatusExplicit: true
    }
  })]);

  const held = reconcile(engine, [trip({
    vehicle: {
      stopId: TARGET,
      timestamp: NOW_SECONDS - 600,
      currentStatus: 1,
      currentStatusExplicit: true
    },
    feedTimestamp: NOW_SECONDS + 15
  })], NOW + 15_000);

  assert.equal(held.arrivals[0].time, "0");
  assert.equal(held.diagnostics.active[0].decisionReason, DECISION_REASONS.DEPARTURE_PROOF_HOLD);
});

test("an exact downstream-only TripUpdate releases when target VehiclePosition is stale", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip({
    stopUpdates: [
      { stopId: "704N", eventTime: NOW_SECONDS - 60 },
      { stopId: TARGET, eventTime: NOW_SECONDS },
      { stopId: "706N", eventTime: NOW_SECONDS + 120 },
      { stopId: "707N", eventTime: NOW_SECONDS + 240 }
    ],
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: 1, currentStatusExplicit: true }
  })]);
  const released = reconcile(engine, [trip({
    stopUpdates: [
      { stopId: "706N", eventTime: NOW_SECONDS + 30 },
      { stopId: "707N", eventTime: NOW_SECONDS + 150 }
    ],
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS - 120, currentStatus: 1, currentStatusExplicit: true },
    feedTimestamp: NOW_SECONDS + 15
  })], NOW + 15_000);
  assert.equal(released.arrivals.length, 0);
  assert.equal(
    released.diagnostics.released[0].releaseReason,
    DECISION_REASONS.EXACT_TRIP_UPDATE_DOWNSTREAM
  );
});

test("emergency-off keeps the strict target VehiclePosition veto", () => {
  const engine = createForeverEngine({ downstreamProofMonitorEnabled: false });
  reconcile(engine, [trip({
    stopUpdates: [
      { stopId: "704N", eventTime: NOW_SECONDS - 60 },
      { stopId: TARGET, eventTime: NOW_SECONDS },
      { stopId: "706N", eventTime: NOW_SECONDS + 120 }
    ],
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: 1, currentStatusExplicit: true }
  })]);
  const held = reconcile(engine, [trip({
    stopUpdates: [{ stopId: "706N", eventTime: NOW_SECONDS + 30 }],
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS + 15, currentStatus: 1, currentStatusExplicit: true },
    feedTimestamp: NOW_SECONDS + 15
  })], NOW + 15_000);
  assert.equal(held.arrivals[0].time, "0");
  assert.equal(held.diagnostics.active[0].decisionReason, DECISION_REASONS.EXACT_STOPPED_AT_TARGET);
});

test("an upstream or unmapped target-free TripUpdate cannot release custody", () => {
  for (const firstStop of ["704N", "unmapped-stop"]) {
    const engine = createForeverEngine();
    reconcile(engine, [trip({
      stopUpdates: [
        { stopId: "704N", eventTime: NOW_SECONDS - 60 },
        { stopId: TARGET, eventTime: NOW_SECONDS },
        { stopId: "706N", eventTime: NOW_SECONDS + 120 }
      ],
      vehicle: { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: 1, currentStatusExplicit: true }
    })]);
    const held = reconcile(engine, [trip({
      stopUpdates: [{ stopId: firstStop, eventTime: NOW_SECONDS + 30 }],
      vehicle: { stopId: TARGET, timestamp: NOW_SECONDS - 120, currentStatus: 1, currentStatusExplicit: true },
      feedTimestamp: NOW_SECONDS + 15
    })], NOW + 15_000);
    assert.equal(held.arrivals[0].time, "0");
    assert.equal(held.diagnostics.active[0].decisionReason, DECISION_REASONS.DEPARTURE_PROOF_HOLD);
  }
});

test("target-free exact suffix progression releases a lock created after a mid-trip restart", () => {
  const engine = createForeverEngine();
  const initial = reconcile(engine, [trip({
    stopUpdates: [
      { stopId: "706N", eventTime: NOW_SECONDS + 120 },
      { stopId: "707N", eventTime: NOW_SECONDS + 240 },
      { stopId: "708N", eventTime: NOW_SECONDS + 360 }
    ],
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: 1, currentStatusExplicit: true }
  })]);
  assert.equal(initial.arrivals[0].time, "0");
  assert.equal(initial.diagnostics.active[0].lastPattern.length, 0);

  const progressed = reconcile(engine, [trip({
    stopUpdates: [
      { stopId: "707N", eventTime: NOW_SECONDS + 90 },
      { stopId: "708N", eventTime: NOW_SECONDS + 210 }
    ],
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS - 120, currentStatus: 1, currentStatusExplicit: true },
    feedTimestamp: NOW_SECONDS + 15
  })], NOW + 15_000);
  assert.equal(progressed.arrivals.length, 0);
  assert.equal(
    progressed.diagnostics.released[0].releaseReason,
    DECISION_REASONS.EXACT_TRIP_UPDATE_PROGRESSION
  );
});

test("unchanged, reordered, or ambiguous target-free suffixes cannot manufacture progression", () => {
  for (const nextPattern of [
    ["706N", "707N", "708N"],
    ["708N", "706N", "707N"],
    ["707N", "706N", "707N"]
  ]) {
    const engine = createForeverEngine();
    reconcile(engine, [trip({
      stopUpdates: ["706N", "707N", "708N"].map((stopId, index) => ({
        stopId,
        eventTime: NOW_SECONDS + (index + 1) * 120
      })),
      vehicle: { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: 1, currentStatusExplicit: true }
    })]);
    const held = reconcile(engine, [trip({
      stopUpdates: nextPattern.map((stopId, index) => ({
        stopId,
        eventTime: NOW_SECONDS + (index + 1) * 120
      })),
      vehicle: { stopId: TARGET, timestamp: NOW_SECONDS - 120, currentStatus: 1, currentStatusExplicit: true },
      feedTimestamp: NOW_SECONDS + 15
    })], NOW + 15_000);
    assert.equal(held.arrivals[0].time, "0");
  }
});

test("exact suffix progression overrides a lagging target VehiclePosition", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip({
    stopUpdates: ["706N", "707N", "708N"].map((stopId, index) => ({
      stopId,
      eventTime: NOW_SECONDS + (index + 1) * 120
    })),
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: 1, currentStatusExplicit: true }
  })]);
  const released = reconcile(engine, [trip({
    stopUpdates: ["707N", "708N"].map((stopId, index) => ({
      stopId,
      eventTime: NOW_SECONDS + (index + 1) * 120
    })),
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS + 15, currentStatus: 1, currentStatusExplicit: true },
    feedTimestamp: NOW_SECONDS + 15
  })], NOW + 15_000);
  assert.equal(released.arrivals.length, 0);
  assert.equal(
    released.diagnostics.released[0].releaseReason,
    DECISION_REASONS.EXACT_DOWNSTREAM_PATTERN_OVERRIDES_TARGET
  );
});

test("an express trip may prove departure at its next served stop without sequence arithmetic", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip({
    stopUpdates: [
      { stopId: "704N", stopSequence: 10, eventTime: NOW_SECONDS - 60 },
      { stopId: TARGET, stopSequence: 20, eventTime: NOW_SECONDS },
      { stopId: "709N", stopSequence: 50, eventTime: NOW_SECONDS + 180 }
    ],
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: 1, currentStatusExplicit: true }
  })]);
  const released = reconcile(engine, [trip({
    stopUpdates: [
      { stopId: "709N", stopSequence: 50, eventTime: NOW_SECONDS + 150 }
    ],
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS + 15, currentStatus: 1, currentStatusExplicit: true },
    feedTimestamp: NOW_SECONDS + 15
  })], NOW + 15_000);
  assert.equal(released.arrivals.length, 0);
  assert.equal(
    released.diagnostics.released[0].releaseReason,
    DECISION_REASONS.EXACT_DOWNSTREAM_PATTERN_OVERRIDES_TARGET
  );
});

test("a stopped same-lane train cannot release another exact identity", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip({
    trip: { tripId: "older-a", startDate: "20260801", routeId: "A" },
    destination: "Inwood-207 St",
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: 1, currentStatusExplicit: true },
    stopUpdates: trip().stopUpdates.map(stop =>
      stop.stopId === TARGET ? { ...stop, eventTime: NOW_SECONDS } : stop
    )
  })]);
  const result = reconcile(engine, [
    trip({
      trip: { tripId: "older-a", startDate: "20260801", routeId: "A" },
      destination: "Inwood-207 St",
      vehicle: { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: 1, currentStatusExplicit: true },
      stopUpdates: trip().stopUpdates.map(stop =>
        stop.stopId === TARGET ? { ...stop, eventTime: NOW_SECONDS } : stop
      ),
      feedTimestamp: NOW_SECONDS + 15
    }),
    trip({
      trip: { tripId: "successor-d", startDate: "20260801", routeId: "D" },
      destination: "Norwood-205 St",
      vehicle: { stopId: TARGET, timestamp: NOW_SECONDS + 15, currentStatus: 1, currentStatusExplicit: true },
      stopUpdates: trip().stopUpdates.map(stop =>
        stop.stopId === TARGET ? { ...stop, eventTime: NOW_SECONDS + 15 } : stop
      ),
      feedTimestamp: NOW_SECONDS + 15
    })
  ], NOW + 15_000);
  const older = result.diagnostics.active.find(item => item.identityKey === "older-a|20260801");
  assert.equal(older.departureLocked, true);
  assert.equal(older.released, false);
  assert.equal(older.successorIdentityKey, undefined);
});

test("fresh successor on a different local or express lane cannot release the older lock", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip({
    trip: { tripId: "older-local", startDate: "20260801", routeId: "C" },
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: 1, currentStatusExplicit: true },
    stopUpdates: [
      { stopId: "local-upstream", eventTime: NOW_SECONDS - 60 },
      { stopId: TARGET, eventTime: NOW_SECONDS },
      { stopId: "local-downstream", eventTime: NOW_SECONDS + 120 }
    ]
  })]);
  const result = reconcile(engine, [
    trip({
      trip: { tripId: "older-local", startDate: "20260801", routeId: "C" },
      vehicle: { stopId: TARGET, timestamp: NOW_SECONDS + 15, currentStatus: 1, currentStatusExplicit: true },
      stopUpdates: [
        { stopId: "local-upstream", eventTime: NOW_SECONDS - 60 },
        { stopId: TARGET, eventTime: NOW_SECONDS },
        { stopId: "local-downstream", eventTime: NOW_SECONDS + 120 }
      ],
      feedTimestamp: NOW_SECONDS + 15
    }),
    trip({
      trip: { tripId: "successor-express", startDate: "20260801", routeId: "D" },
      vehicle: { stopId: TARGET, timestamp: NOW_SECONDS + 15, currentStatus: 1, currentStatusExplicit: true },
      stopUpdates: [
        { stopId: "express-upstream", eventTime: NOW_SECONDS - 30 },
        { stopId: TARGET, eventTime: NOW_SECONDS + 15 },
        { stopId: "express-downstream", eventTime: NOW_SECONDS + 150 }
      ],
      feedTimestamp: NOW_SECONDS + 15
    })
  ], NOW + 15_000);
  const older = result.diagnostics.active.find(item => item.identityKey === "older-local|20260801");
  assert.equal(older.departureLocked, true);
  assert.equal(older.decisionReason, DECISION_REASONS.EXACT_STOPPED_AT_TARGET);
});

test("a stopped different identity cannot release a lock while its stale exact VP remains visible", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip({
    trip: { tripId: "older-local", startDate: "20260801", routeId: "C" },
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: 1, currentStatusExplicit: true },
    stopUpdates: trip().stopUpdates.map(stop =>
      stop.stopId === TARGET ? { ...stop, eventTime: NOW_SECONDS } : stop
    )
  })]);
  const result = reconcile(engine, [trip({
    trip: { tripId: "older-local", startDate: "20260801", routeId: "C" },
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS - 120, currentStatus: 1, currentStatusExplicit: true },
    stopUpdates: [{ stopId: "unmapped-after-target", eventTime: NOW_SECONDS + 60 }],
    feedTimestamp: NOW_SECONDS + 15
  }), trip({
    trip: { tripId: "successor-express", startDate: "20260801", routeId: "A" },
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS + 15, currentStatus: 1, currentStatusExplicit: true },
    stopUpdates: trip().stopUpdates.map(stop =>
      stop.stopId === TARGET ? { ...stop, eventTime: NOW_SECONDS + 15 } : stop
    ),
    feedTimestamp: NOW_SECONDS + 15
  })], NOW + 15_000);
  const older = result.diagnostics.active.find(item => item.identityKey === "older-local|20260801");
  assert.equal(older.departureLocked, true);
  assert.equal(older.released, false);
  assert.equal(older.successorIdentityKey, undefined);
});

test("TripUpdate progression cannot release an identity that never entered departure custody", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip({
    trip: { tripId: "outside-window", startDate: "20260801", routeId: "C" },
    stopUpdates: [
      { stopId: "706N", eventTime: NOW_SECONDS + 3600 },
      { stopId: "707N", eventTime: NOW_SECONDS + 3720 }
    ],
    vehicle: null
  })]);
  const result = reconcile(engine, [trip({
    trip: { tripId: "outside-window", startDate: "20260801", routeId: "C" },
    stopUpdates: [{ stopId: "707N", eventTime: NOW_SECONDS + 3660 }],
    vehicle: null,
    feedTimestamp: NOW_SECONDS + 15
  })], NOW + 15_000);
  assert.equal(result.diagnostics.released.some(item => item.identityKey === "outside-window|20260801"), false);
});

test("approaching or stale successor evidence cannot release an older lock", () => {
  for (const vehicle of [
    { stopId: TARGET, timestamp: NOW_SECONDS + 15, currentStatus: 0, currentStatusExplicit: true },
    { stopId: TARGET, timestamp: NOW_SECONDS - 120, currentStatus: 1, currentStatusExplicit: true }
  ]) {
    const engine = createForeverEngine();
    reconcile(engine, [trip({
      trip: { tripId: "older-a", startDate: "20260801", routeId: "A" },
      vehicle: { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: 1, currentStatusExplicit: true },
      stopUpdates: trip().stopUpdates.map(stop =>
        stop.stopId === TARGET ? { ...stop, eventTime: NOW_SECONDS } : stop
      )
    })]);
    const result = reconcile(engine, [trip({
      trip: { tripId: "older-a", startDate: "20260801", routeId: "A" },
      vehicle: { stopId: TARGET, timestamp: NOW_SECONDS - 120, currentStatus: 1, currentStatusExplicit: true },
      stopUpdates: [{ stopId: "unmapped-after-target", eventTime: NOW_SECONDS + 60 }],
      feedTimestamp: NOW_SECONDS + 15
    }), trip({
      trip: { tripId: "successor-d", startDate: "20260801", routeId: "D" },
      vehicle,
      stopUpdates: trip().stopUpdates.map(stop =>
        stop.stopId === TARGET ? { ...stop, eventTime: NOW_SECONDS + 15 } : stop
      ),
      feedTimestamp: NOW_SECONDS + 15
    })], NOW + 15_000);
    assert.equal(result.diagnostics.active.some(item => item.identityKey === "older-a|20260801"), true);
  }
});

test("successor occupancy is isolated by exact platform", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip({
    trip: { tripId: "older-a", startDate: "20260801", routeId: "A" },
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: 1, currentStatusExplicit: true },
    stopUpdates: trip().stopUpdates.map(stop =>
      stop.stopId === TARGET ? { ...stop, eventTime: NOW_SECONDS } : stop
    )
  })]);
  reconcile(engine, [trip({
    trip: { tripId: "other-platform-d", startDate: "20260801", routeId: "D" },
    vehicle: { stopId: "other-platform", timestamp: NOW_SECONDS + 15, currentStatus: 1, currentStatusExplicit: true },
    stopUpdates: [{ stopId: "other-platform", eventTime: NOW_SECONDS + 15 }],
    feedTimestamp: NOW_SECONDS + 15
  })], NOW + 15_000, "other-platform");
  const original = reconcile(engine, [trip({
    trip: { tripId: "older-a", startDate: "20260801", routeId: "A" },
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS - 120, currentStatus: 1, currentStatusExplicit: true },
    stopUpdates: [{ stopId: "unmapped-after-target", eventTime: NOW_SECONDS + 60 }],
    feedTimestamp: NOW_SECONDS + 30
  })], NOW + 30_000);
  assert.equal(original.diagnostics.active.some(item => item.identityKey === "older-a|20260801"), true);
});

test("an incoming different identity cannot release a stale exact lock", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip({
    trip: { tripId: "older-a", startDate: "20260801", routeId: "A" },
    destination: "Inwood-207 St",
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: 1, currentStatusExplicit: true },
    stopUpdates: trip().stopUpdates.map(stop =>
      stop.stopId === TARGET ? { ...stop, eventTime: NOW_SECONDS } : stop
    )
  })]);
  const result = reconcile(engine, [
    trip({
      trip: { tripId: "older-a", startDate: "20260801", routeId: "A" },
      destination: "Inwood-207 St",
      stopUpdates: [{ stopId: "unmapped-after-target", eventTime: NOW_SECONDS + 60 }],
      vehicle: { stopId: TARGET, timestamp: NOW_SECONDS - 120, currentStatus: 1, currentStatusExplicit: true },
      feedTimestamp: NOW_SECONDS + 15
    }),
    trip({
      trip: { tripId: "incoming-d", startDate: "20260801", routeId: "D" },
      destination: "Norwood-205 St",
      vehicle: { stopId: TARGET, timestamp: NOW_SECONDS + 15, currentStatus: 0, currentStatusExplicit: true },
      stopUpdates: trip().stopUpdates.map(stop =>
        stop.stopId === TARGET ? { ...stop, eventTime: NOW_SECONDS + 60 } : stop
      ),
      feedTimestamp: NOW_SECONDS + 15
    })
  ], NOW + 15_000);
  const older = result.diagnostics.active.find(item => item.identityKey === "older-a|20260801");
  assert.equal(older.departureLocked, true);
  assert.equal(older.released, false);
  assert.equal(older.successorIdentityKey, undefined);
});

test("incoming successor cannot release unless every independent stale-target condition is present", () => {
  const cases = [
    {
      name: "older target remains",
      olderStops: trip().stopUpdates,
      olderVehicle: { stopId: TARGET, timestamp: NOW_SECONDS - 120, currentStatus: 1, currentStatusExplicit: true },
      successorVehicle: { stopId: TARGET, timestamp: NOW_SECONDS + 15, currentStatus: 0, currentStatusExplicit: true }
    },
    {
      name: "older target VP remains fresh",
      olderStops: [{ stopId: "unmapped-after-target", eventTime: NOW_SECONDS + 60 }],
      olderVehicle: { stopId: TARGET, timestamp: NOW_SECONDS + 15, currentStatus: 1, currentStatusExplicit: true },
      successorVehicle: { stopId: TARGET, timestamp: NOW_SECONDS + 15, currentStatus: 0, currentStatusExplicit: true }
    },
    {
      name: "successor is stale",
      olderStops: [{ stopId: "unmapped-after-target", eventTime: NOW_SECONDS + 60 }],
      olderVehicle: { stopId: TARGET, timestamp: NOW_SECONDS - 120, currentStatus: 1, currentStatusExplicit: true },
      successorVehicle: { stopId: TARGET, timestamp: NOW_SECONDS - 120, currentStatus: 0, currentStatusExplicit: true }
    },
    {
      name: "successor is only in transit",
      olderStops: [{ stopId: "unmapped-after-target", eventTime: NOW_SECONDS + 60 }],
      olderVehicle: { stopId: TARGET, timestamp: NOW_SECONDS - 120, currentStatus: 1, currentStatusExplicit: true },
      successorVehicle: { stopId: TARGET, timestamp: NOW_SECONDS + 15, currentStatus: 2, currentStatusExplicit: true }
    }
  ];
  for (const currentCase of cases) {
    const engine = createForeverEngine();
    reconcile(engine, [trip({
      trip: { tripId: "older-a", startDate: "20260801", routeId: "A" },
      vehicle: { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: 1, currentStatusExplicit: true },
      stopUpdates: trip().stopUpdates.map(stop =>
        stop.stopId === TARGET ? { ...stop, eventTime: NOW_SECONDS } : stop
      )
    })]);
    const result = reconcile(engine, [
      trip({
        trip: { tripId: "older-a", startDate: "20260801", routeId: "A" },
        stopUpdates: currentCase.olderStops,
        vehicle: currentCase.olderVehicle,
        feedTimestamp: NOW_SECONDS + 15
      }),
      trip({
        trip: { tripId: "incoming-d", startDate: "20260801", routeId: "D" },
        vehicle: currentCase.successorVehicle,
        stopUpdates: trip().stopUpdates,
        feedTimestamp: NOW_SECONDS + 15
      })
    ], NOW + 15_000);
    assert.equal(
      result.diagnostics.active.some(item => item.identityKey === "older-a|20260801"),
      true,
      currentCase.name
    );
  }
});

test("a fresh exact STOPPED_AT target observation promotes directly to zero", () => {
  const engine = createForeverEngine();
  const result = reconcile(engine, [trip({
    stopUpdates: trip().stopUpdates.map(stop =>
      stop.stopId === TARGET ? { ...stop, eventTime: NOW_SECONDS } : stop
    ),
    vehicle: {
      stopId: TARGET,
      timestamp: NOW_SECONDS,
      currentStopSequence: 7,
      currentStopSequenceExplicit: true,
      currentStatus: 1,
      currentStatusExplicit: true
    }
  })]);
  assert.equal(result.arrivals[0].time, "0");
  assert.equal(result.arrivals[0].departureProofLocked, true);
  assert.equal(result.diagnostics.active[0].decisionReason, DECISION_REASONS.EXACT_STOPPED_AT_TARGET);
});

test("non-stopped statuses do not prove entry and native confidence ignores VP age", () => {
  for (const vehicle of [
    { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: 0, currentStatusExplicit: true },
    { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: 2, currentStatusExplicit: true },
    { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: null, currentStatusExplicit: false }
  ]) {
    const engine = createForeverEngine();
    const result = reconcile(engine, [trip({
      stopUpdates: trip().stopUpdates.map(stop =>
        stop.stopId === TARGET ? { ...stop, eventTime: NOW_SECONDS } : stop
      ),
      vehicle
    })]);
    assert.equal(result.arrivals[0].time, "1");
    assert.equal(result.arrivals[0].departureProofLocked, false);
  }
  const stale = reconcile(createForeverEngine(), [trip({
    stopUpdates: trip().stopUpdates.map(stop =>
      stop.stopId === TARGET ? { ...stop, eventTime: NOW_SECONDS } : stop
    ),
    vehicle: {
      stopId: TARGET,
      timestamp: NOW_SECONDS - 600,
      currentStatus: 1,
      currentStatusExplicit: true
    }
  })]);
  assert.equal(stale.arrivals.length, 1);
  assert.equal(stale.arrivals[0].time, "1");
});

test("two distinct target-zero snapshots require established approach and fresh exact vehicle continuity", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip()]);
  const recoveredFuture = trip({
    vehicle: null,
    stopUpdates: [
      { stopId: "704N", stopSequence: 4, eventTime: NOW_SECONDS + 5 * 60 },
      { stopId: TARGET, stopSequence: 7, eventTime: NOW_SECONDS + 7 * 60 },
      { stopId: "706N", stopSequence: 11, eventTime: NOW_SECONDS + 9 * 60 }
    ]
  });
  reconcile(engine, [{ ...recoveredFuture, feedTimestamp: NOW_SECONDS + 5 }], NOW + 5_000);
  reconcile(engine, [{ ...recoveredFuture, feedTimestamp: NOW_SECONDS + 10 }], NOW + 10_000);
  const zero = trip({
    stopUpdates: trip().stopUpdates.map(stop =>
      stop.stopId === TARGET ? { ...stop, eventTime: NOW_SECONDS } : stop
    ),
    vehicle: null
  });
  let result = reconcile(engine, [{ ...zero, feedTimestamp: NOW_SECONDS + 15 }], NOW + 15_000);
  assert.equal(result.arrivals[0].time, "1");
  result = reconcile(engine, [{ ...zero, feedTimestamp: NOW_SECONDS + 30 }], NOW + 30_000);
  assert.equal(result.arrivals[0].time, "0");
  assert.equal(result.diagnostics.active[0].decisionReason, DECISION_REASONS.REPEATED_TARGET_ZERO);
});

test("an identity first discovered with an expired target prediction cannot manufacture entry", () => {
  const engine = createForeverEngine();
  const expired = trip({
    stopUpdates: trip().stopUpdates.map(stop =>
      stop.stopId === TARGET ? { ...stop, eventTime: NOW_SECONDS - 10 * 60 } : stop
    ),
    vehicle: null
  });
  reconcile(engine, [expired]);
  const result = reconcile(
    engine,
    [{ ...expired, feedTimestamp: NOW_SECONDS + 15 }],
    NOW + 15_000
  );
  assert.equal(result.arrivals.length, 0);
  assert.equal(result.diagnostics.active.length, 0);
  assert.equal(result.diagnostics.counts.board, 0);
});

test("a TripUpdate-only approach yields its board slot after prediction expiry", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip({ vehicle: null })]);
  const expired = trip({
    stopUpdates: trip().stopUpdates.map(stop =>
      stop.stopId === TARGET ? { ...stop, eventTime: NOW_SECONDS } : stop
    ),
    vehicle: null
  });
  reconcile(engine, [{ ...expired, feedTimestamp: NOW_SECONDS + 15 }], NOW + 15_000);
  reconcile(
    engine,
    [{ ...expired, feedTimestamp: NOW_SECONDS + 30 }],
    NOW + 30_000
  );
  const result = reconcile(
    engine,
    [{ ...expired, feedTimestamp: NOW_SECONDS + 60 }],
    NOW + 60_000
  );
  assert.equal(result.arrivals.length, 0);
  assert.equal(result.diagnostics.active.length, 0);
});

test("fresh exact upstream VehiclePosition contradicts prediction-only entry", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip()]);
  const zero = trip({
    stopUpdates: trip().stopUpdates.map(stop =>
      stop.stopId === TARGET ? { ...stop, eventTime: NOW_SECONDS } : stop
    )
  });
  reconcile(engine, [{ ...zero, feedTimestamp: NOW_SECONDS + 15 }], NOW + 15_000);
  const result = reconcile(
    engine,
    [{
      ...zero,
      feedTimestamp: NOW_SECONDS + 60,
      vehicle: { ...zero.vehicle, timestamp: NOW_SECONDS + 60 }
    }],
    NOW + 60_000
  );
  assert.equal(result.arrivals.length, 0);
  assert.equal(result.diagnostics.active.length, 0);
});

test("an uncertain expired identity can return when fresh current evidence reappears", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip({ vehicle: null })]);
  const expired = trip({
    stopUpdates: trip().stopUpdates.map(stop =>
      stop.stopId === TARGET ? { ...stop, eventTime: NOW_SECONDS } : stop
    ),
    vehicle: null,
    feedTimestamp: NOW_SECONDS + 60
  });
  assert.equal(reconcile(engine, [expired], NOW + 60_000).arrivals.length, 0);
  const returned = trip({
    stopUpdates: trip().stopUpdates.map(stop =>
      stop.stopId === TARGET ? { ...stop, eventTime: NOW_SECONDS + 5 * 60 } : stop
    ),
    feedTimestamp: NOW_SECONDS + 75,
    vehicle: { ...trip().vehicle, timestamp: NOW_SECONDS + 75 }
  });
  const result = reconcile(engine, [returned], NOW + 75_000);
  assert.equal(result.arrivals[0].time, "4");
  assert.equal(result.arrivals[0].departureProofLocked, false);
});

test("the same feed snapshot cannot manufacture repeated-zero confirmation", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip()]);
  const recoveredFuture = trip({
    vehicle: null,
    stopUpdates: [
      { stopId: "704N", stopSequence: 4, eventTime: NOW_SECONDS + 5 * 60 },
      { stopId: TARGET, stopSequence: 7, eventTime: NOW_SECONDS + 7 * 60 },
      { stopId: "706N", stopSequence: 11, eventTime: NOW_SECONDS + 9 * 60 }
    ]
  });
  reconcile(engine, [{ ...recoveredFuture, feedTimestamp: NOW_SECONDS + 5 }], NOW + 5_000);
  reconcile(engine, [{ ...recoveredFuture, feedTimestamp: NOW_SECONDS + 10 }], NOW + 10_000);
  const zero = trip({
    stopUpdates: trip().stopUpdates.map(stop =>
      stop.stopId === TARGET ? { ...stop, eventTime: NOW_SECONDS } : stop
    ),
    vehicle: null
  });
  const first = { ...zero, feedTimestamp: NOW_SECONDS + 15 };
  reconcile(engine, [first], NOW + 15_000);
  const result = reconcile(engine, [first], NOW + 30_000);
  assert.equal(result.arrivals[0].time, "1");
});

test("Departure-Proof custody releases immediately when the exact trip and VP disappear", () => {
  const engine = createForeverEngine();
  const stopped = trip({
    stopUpdates: trip().stopUpdates.map(stop =>
      stop.stopId === TARGET ? { ...stop, eventTime: NOW_SECONDS } : stop
    ),
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: 1, currentStatusExplicit: true }
  });
  reconcile(engine, [stopped]);
  const result = reconcile(engine, [], NOW + 10 * 60_000);
  assert.equal(result.arrivals.length, 0);
  assert.equal(result.diagnostics.released[0].releaseReason,
    DECISION_REASONS.FIRST_MISSING_EXACT_VEHICLE_POSITION);
});

test("the first missing-VP emergency key acts before the longhaul shadow fallback", () => {
  const engine = createForeverEngine();
  const stopped = trip({
    stopUpdates: trip().stopUpdates.map(stop =>
      stop.stopId === TARGET ? { ...stop, eventTime: NOW_SECONDS } : stop
    ),
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: 1, currentStatusExplicit: true }
  });
  reconcile(engine, [stopped]);
  const result = reconcile(engine, [], NOW + 4 * 60_000);
  assert.equal(result.arrivals.length, 0);
  assert.equal(result.diagnostics.released[0].releaseReason,
    DECISION_REASONS.FIRST_MISSING_EXACT_VEHICLE_POSITION);
});

test("a VehiclePosition still naming the exact target can never release, regardless of sequence", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip({
    stopUpdates: trip().stopUpdates.map(stop => stop.stopId === TARGET ? { ...stop, eventTime: NOW_SECONDS } : stop),
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: 1, currentStatusExplicit: true }
  })]);
  const result = reconcile(engine, [trip({
    vehicle: {
      stopId: TARGET,
      timestamp: NOW_SECONDS + 15,
      currentStopSequence: 999,
      currentStopSequenceExplicit: true,
      currentStatus: 2,
      currentStatusExplicit: true
    },
    feedTimestamp: NOW_SECONDS + 15
  })], NOW + 15_000);
  assert.equal(result.arrivals[0].time, "0");
  assert.equal(result.diagnostics.released.length, 0);
});

test("fresh exact downstream VehiclePosition releases using realtime relative order with nonconsecutive sequences", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip({
    stopUpdates: trip().stopUpdates.map(stop => stop.stopId === TARGET ? { ...stop, eventTime: NOW_SECONDS } : stop),
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: 1, currentStatusExplicit: true }
  })]);
  const result = reconcile(engine, [trip({
    vehicle: { stopId: "706N", timestamp: NOW_SECONDS + 15, currentStopSequence: 2, currentStatus: 2, currentStatusExplicit: true },
    feedTimestamp: NOW_SECONDS + 15
  })], NOW + 15_000);
  assert.equal(result.arrivals.length, 0);
  assert.equal(result.diagnostics.released[0].releaseReason, DECISION_REASONS.EXACT_VEHICLE_DOWNSTREAM);
});

test("unknown, repeated or ambiguous realtime stop order cannot release", () => {
  for (const stopUpdates of [
    [{ stopId: TARGET, eventTime: NOW_SECONDS }, { stopId: "X", eventTime: NOW_SECONDS + 60 }],
    [{ stopId: TARGET, eventTime: NOW_SECONDS }, { stopId: "706N", eventTime: NOW_SECONDS + 60 }, { stopId: "706N", eventTime: NOW_SECONDS + 120 }]
  ]) {
    const engine = createForeverEngine();
    reconcile(engine, [trip({
      stopUpdates: trip().stopUpdates.map(stop => stop.stopId === TARGET ? { ...stop, eventTime: NOW_SECONDS } : stop),
      vehicle: { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: 1, currentStatusExplicit: true }
    })]);
    const result = reconcile(engine, [trip({
      stopUpdates,
      vehicle: { stopId: "706N", timestamp: NOW_SECONDS + 15, currentStatus: 2, currentStatusExplicit: true },
      feedTimestamp: NOW_SECONDS + 15
    })], NOW + 15_000);
    assert.equal(result.arrivals[0].time, "0");
  }
});

test("distinct 7 and 7X identities never share movement state or route slots", () => {
  const engine = createForeverEngine({ routeLimit: 1 });
  const local = trip();
  const express = trip({
    trip: { tripId: "trip-x", startDate: "20260801", routeId: "7X" },
    destination: "Flushing-Main St"
  });
  const result = reconcile(engine, [local, express]);
  assert.equal(result.arrivals.length, 2);
  assert.deepEqual(result.arrivals.map(item => item.route).sort(), ["7", "7X"]);
});

test("protected arrivals cannot be displaced by sorting or same-route limits", () => {
  const engine = createForeverEngine({ routeLimit: 2 });
  const stopped = trip({
    stopUpdates: trip().stopUpdates.map(stop => stop.stopId === TARGET ? { ...stop, eventTime: NOW_SECONDS } : stop),
    vehicle: { stopId: TARGET, timestamp: NOW_SECONDS, currentStatus: 1, currentStatusExplicit: true }
  });
  reconcile(engine, [stopped]);
  const ordinary = [1, 2, 3].map(index => trip({
    trip: { tripId: `trip-${index}`, startDate: "20260801", routeId: "7" },
    stopUpdates: trip().stopUpdates.map(stop => stop.stopId === TARGET
      ? { ...stop, eventTime: NOW_SECONDS + index * 60 }
      : stop),
    vehicle: {
      stopId: "704N",
      timestamp: NOW_SECONDS + 15,
      currentStatus: 2,
      currentStatusExplicit: true
    }
  }));
  const result = reconcile(engine, [
    trip({
      vehicle: { stopId: TARGET, timestamp: NOW_SECONDS - 120, currentStatus: 1, currentStatusExplicit: true },
      stopUpdates: [{ stopId: "unmapped-after-target", eventTime: NOW_SECONDS + 60 }],
      feedTimestamp: NOW_SECONDS + 15
    }),
    ...ordinary
  ], NOW + 15_000);
  assert.equal(result.arrivals.filter(item => item.route === "7").length, 2);
  assert.equal(result.arrivals.some(item => item.identityKey === "trip-a|20260801"), true);
});

test("explicit cancellation withdraws only the exact identity", () => {
  const engine = createForeverEngine();
  reconcile(engine, [trip(), trip({ trip: { tripId: "trip-b", startDate: "20260801", routeId: "7" } })]);
  const result = reconcile(engine, [trip({ cancelled: true })], NOW + 15_000);
  assert.equal(result.arrivals.some(item => item.identityKey === "trip-a|20260801"), false);
  assert.equal(result.arrivals.some(item => item.identityKey === "trip-b|20260801"), true);
});

test("normalizer preserves field presence and correlates only exact identities", () => {
  const entities = [
    { tripUpdate: { trip: { tripId: "a", startDate: "20260801", routeId: "1" }, stopTimeUpdate: [{ stopId: "101N", arrival: { time: NOW_SECONDS } }] } },
    { vehicle: { trip: { tripId: "a", startDate: "20260801", routeId: "1" }, stopId: "101N", timestamp: NOW_SECONDS, currentStatus: 1 } },
    { vehicle: { trip: { tripId: "a", startDate: "20260802", routeId: "1" }, stopId: "102N", timestamp: NOW_SECONDS } }
  ];
  const normalized = normalizeGtfsEntities({ entities, feedTimestamp: NOW_SECONDS });
  const exact = normalized.find(item => item.trip.startDate === "20260801");
  const different = normalized.find(item => item.trip.startDate === "20260802");
  assert.equal(exact.vehicle.stopId, "101N");
  assert.equal(exact.vehicle.currentStatusExplicit, true);
  assert.equal(exact.vehicle.currentStopSequenceExplicit, false);
  assert.equal(different.tripUpdatePresent, false);
});

test("normalized future TripUpdates with omitted protobuf timestamps remain eligible", () => {
  const normalized = normalizeGtfsEntities({
    feedTimestamp: NOW_SECONDS,
    entities: [{
      tripUpdate: {
        trip: { tripId: "future-with-default-timestamp", startDate: "20260801", routeId: "4" },
        timestamp: 0,
        stopTimeUpdate: [
          { stopId: "704N", arrival: { time: NOW_SECONDS + 60 } },
          { stopId: TARGET, arrival: { time: NOW_SECONDS + 12 * 60 } },
          { stopId: "706N", arrival: { time: NOW_SECONDS + 14 * 60 } }
        ]
      }
    }]
  });
  assert.equal(normalized[0].tripUpdateTimestamp, null);

  const result = reconcile(createForeverEngine(), normalized);
  assert.equal(result.arrivals.length, 1);
  assert.equal(result.arrivals[0].tripId, "future-with-default-timestamp");
  assert.equal(result.arrivals[0].time, "12");
});

test("native confidence may match VehiclePosition by tripId without weakening exact movement identity", () => {
  const normalized = normalizeGtfsEntities({
    feedTimestamp: NOW_SECONDS,
    entities: [
      { tripUpdate: { trip: { tripId: "shared-trip", startDate: "20260801", routeId: "1" }, stopTimeUpdate: [{ stopId: "101N", arrival: { time: NOW_SECONDS + 180 } }] } },
      { vehicle: { trip: { tripId: "shared-trip", startDate: "20260802", routeId: "1" }, stopId: "102N", timestamp: NOW_SECONDS } }
    ]
  });
  const update = normalized.find(item => item.trip.startDate === "20260801");

  assert.equal(update.vehiclePositionMatched, true);
  assert.equal(update.vehicle, null);
});

test("diagnostics are detached from live registry state", () => {
  const engine = createForeverEngine();
  const result = reconcile(engine, [trip()]);
  result.diagnostics.active[0].route = "MUTATED";
  const inspection = engine.inspect(TARGET);
  assert.equal(inspection[TARGET][0].route, "7");
});

test("an out-of-order feed snapshot cannot move the shared registry backward", () => {
  const engine = createForeverEngine();
  const current = reconcile(engine, [trip()], NOW + 30_000);
  assert.equal(current.arrivals[0].time, "2");
  const stale = engine.reconcile({
    platform: TARGET,
    observedAt: NOW + 45_000,
    feedTimestamp: NOW_SECONDS,
    trips: [trip({
      stopUpdates: trip().stopUpdates.map(stop => stop.stopId === TARGET
        ? { ...stop, eventTime: NOW_SECONDS + 30 * 60 }
        : stop)
    })]
  });
  assert.equal(stale.diagnostics.staleSnapshotRejected, true);
  assert.equal(stale.arrivals[0].time, "2");
});

test("forever is the parameter-free field mode while legacy remains an explicit emergency control", () => {
  assert.match(html, /requested === "legacy" \|\| requested === "shadow"/);
  assert.match(html, /:\s*"forever";/);
  assert.match(html, /arrivalEngineMode === "shadow"/);
  assert.match(html, /arrivalEngineMode === "forever"/);
  assert.match(html, /requestJson\("\/forever-arrivals"\)/);
  assert.match(server, /app\.get\("\/forever-arrivals", handleForeverArrivals\)/);
});

test("downstream proof monitoring defaults on and exact zero selects isolated strict state", () => {
  assert.match(html, /params\.get\("downstreamProofMonitor"\) !== "0"/);
  assert.match(html, /if \(!downstreamProofMonitorEnabled\) \{\s*query\.set\("downstreamProofMonitor", "0"\)/);
  assert.match(server, /createForeverEngine\(\{\s*downstreamProofMonitorEnabled: false\s*\}\)/);
  assert.match(server, /req\.query\.downstreamProofMonitor !== "0"/);
  assert.match(server, /downstreamProofMonitorEnabled\s*\? foreverEngine\s*:\s*strictForeverEngine/);
});

test("forever mode does not import or execute the legacy Departure-Proof implementation", () => {
  assert.match(html, /legacyDepartureProofEnabled\s*=\s*departureProofLockEnabled && arrivalEngineMode !== "forever"/);
  assert.match(html, /legacyDepartureProofEnabled\s*\? import\("\.\/departure-proof-lock\.js"\)\s*:\s*null/);
  assert.match(html, /if \(legacyDepartureProofEnabled\)/);
});

test("shadow mode records comparison but returns the legacy response", () => {
  assert.match(html, /SHADOW_ENGINE_COMPARISON/);
  assert.match(html, /res = legacy\.response;\s*data = legacy\.payload;/);
});

test("replacement endpoint cannot invoke the Glide mutation path", () => {
  const start = server.indexOf("async function handleForeverArrivals");
  const end = server.indexOf('app.get("/push-arrivals"', start);
  const handler = server.slice(start, end);
  assert.ok(start > -1 && end > start);
  assert.doesNotMatch(handler, /mutateGlideTable|mutateTables|GLIDE_API|runGlideMutation/);
});

test("classic client script still parses after adding the replacement selector", () => {
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.doesNotThrow(() => new vm.Script(scripts[0][1]));
  assert.doesNotMatch(html, /<script\s+type=["']module["']/);
});

test("Glide refresh requests bypass caches and cannot hold the refresh loop indefinitely", () => {
  assert.match(html, /const realtimeRequestTimeoutMs = 12000/);
  assert.match(html, /requestUrl\.searchParams\.set\("_refresh"/);
  assert.match(html, /cache: "no-store"/);
  assert.match(html, /signal: controller\.signal/);
  assert.match(html, /controller\.abort\(\)/);
  assert.match(html, /fetchRealtime\(`\$\{endpoint\}\?\$\{query\.toString\(\)\}`\)/);
  assert.doesNotMatch(html, /const response = await fetch\(`\$\{endpoint\}/);
});

test("Glide refresh recovers from lost touches, foreground restore, and bfcache restore", () => {
  assert.match(html, /const touchScrollHardResetMs = 5000/);
  assert.match(html, /activeTouchCount = event\.touches\.length/);
  assert.match(html, /requestRefreshCatchUp\("VISIBILITY_RESTORED"\)/);
  assert.match(html, /requestRefreshCatchUp\("BFCACHE_RESTORED"\)/);
  assert.match(html, /requestRefreshCatchUp\("WINDOW_FOCUS_RESTORED"\)/);
  assert.match(html, /requestRefreshCatchUp\("NETWORK_RESTORED"\)/);
  assert.match(html, /if \(!event\.persisted\) return/);
});

test("recorded snapshot sequences replay deterministically", () => {
  const snapshots = [
    { platform: TARGET, observedAt: NOW, feedTimestamp: NOW_SECONDS, trips: [trip()] },
    { platform: TARGET, observedAt: NOW + 15_000, feedTimestamp: NOW_SECONDS + 15, trips: [] }
  ];
  const first = replaySnapshots(snapshots);
  const second = replaySnapshots(snapshots);
  assert.deepEqual(first, second);
  assert.equal(first[1].arrivals[0].identityKey, "trip-a|20260801");
});
