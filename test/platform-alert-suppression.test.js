import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  classifyExplicitNoStopText,
  createPlatformAlertDiagnostics,
  evaluatePlatformAlertEntity,
  filterPlatformUnavailableArrivals,
  initialAuthoritativePlatformAvailability,
  PLATFORM_AVAILABILITY,
  reconcileAuthoritativePlatformAvailability,
  reconcilePlatformAvailability,
  SANITIZED_PLATFORM_CLOSURES
} from "../public/platform-alert-suppression.js";
import {
  reconcileDepartureProofLocks,
  suppressDepartureProofLocks
} from "../public/departure-proof-lock.js";

const fixture = JSON.parse(
  fs.readFileSync(
    new URL("./fixtures/mta-103-corona-flushing-skip.json", import.meta.url),
    "utf8"
  )
);
const NOW_SECONDS = Date.UTC(2026, 6, 30, 21) / 1000;
const NOW_MS = NOW_SECONDS * 1000;
const routeDirectionSuffixes = {
  "7": {
    0: ["N"],
    1: ["S"]
  },
  A: {
    0: ["N"],
    1: ["S"]
  }
};
const platformRoutes = {
  "706N": ["7"],
  "706S": ["7"],
  A24N: ["A"],
  A24S: ["A"]
};

function decision(overrides = {}) {
  return evaluatePlatformAlertEntity({
    alertId: fixture.id,
    activePeriods: fixture.activePeriods,
    informedEntity: fixture.informedEntity,
    header: fixture.header,
    description: fixture.description,
    stationName: fixture.stationName,
    routeDirectionSuffixes,
    platformRoutes,
    nowSeconds: NOW_SECONDS,
    feedTimestamp: NOW_SECONDS,
    ...overrides
  });
}

function stateFromEvidence(evidence, previous = null, feedSucceeded = true) {
  return reconcilePlatformAvailability(
    previous,
    { feedSucceeded, evidence },
    NOW_MS
  );
}

function authoritativeState(
  evidence,
  previous = null,
  overrides = {},
  nowMs = NOW_MS,
  platformId = "706N"
) {
  return reconcileAuthoritativePlatformAvailability(
    previous,
    {
      feedSucceeded: true,
      decodeSucceeded: true,
      feedStale: false,
      feedTimestamp: NOW_SECONDS,
      evidence,
      ...overrides
    },
    nowMs,
    { platformId }
  );
}

function arrival(overrides = {}) {
  return {
    identityKey: "trip-1|20260730",
    tripId: "trip-1",
    startDate: "20260730",
    route: "7",
    platformId: "706N",
    direction: "Northbound",
    station: "Flushing-Main St",
    time: "0",
    ...overrides
  };
}

function tripEvidence(overrides = {}) {
  return {
    identityKey: "trip-1|20260730",
    tripId: "trip-1",
    startDate: "20260730",
    route: "7",
    targetStop: "706N",
    targetStopPresent: true,
    targetStopSequence: 17,
    tripUpdatePresent: true,
    tripUpdateProgressionSequence: null,
    stopUpdates: [
      { stopId: "706N", stopSequence: 17, eventTime: NOW_SECONDS }
    ],
    vehiclePositionPresent: false,
    vehiclePositionAmbiguous: false,
    vehicle: null,
    feedTimestamp: NOW_SECONDS,
    ...overrides
  };
}

test("sanitized 103 St fixture resolves direction 0 to 706N and suppresses it", () => {
  const evaluated = decision();
  const state = stateFromEvidence([evaluated]);
  const board = filterPlatformUnavailableArrivals(state, [
    arrival(),
    arrival({
      identityKey: "trip-s|20260730",
      tripId: "trip-s",
      platformId: "706S"
    })
  ]);

  assert.equal(evaluated.resolvedPlatform, "706N");
  assert.equal(evaluated.phraseCategory, "SKIP");
  assert.equal(evaluated.suppressionApplied, true);
  assert.deepEqual(board.map(item => item.platformId), ["706S"]);
});

test("continued raw 706N predictions cannot override an active skip", () => {
  const state = stateFromEvidence([decision()]);
  assert.deepEqual(
    filterPlatformUnavailableArrivals(state, [
      arrival({ time: "0" }),
      arrival({ identityKey: "trip-2|20260730", tripId: "trip-2", time: "4" })
    ]),
    []
  );
});

test("explicit skip and no-stop phrase allowlist qualifies", () => {
  const cases = [
    ["Trains skip 103 St-Corona Plaza", "SKIP"],
    ["Trains are not stopping at 103 St-Corona Plaza", "ARE_NOT_STOPPING"],
    ["Trains will not stop at 103 St-Corona Plaza", "WILL_NOT_STOP"]
  ];

  for (const [header, category] of cases) {
    assert.equal(
      classifyExplicitNoStopText({
        header,
        stationName: fixture.stationName
      })?.category,
      category
    );
  }
});

test("delay, maintenance, conditional skip, and generic express text fail closed", () => {
  const rejected = [
    "Trains are running with delays at 103 St-Corona Plaza",
    "Station improvements at 103 St-Corona Plaza",
    "Some trains may skip 103 St-Corona Plaza",
    "Trains are running express near 103 St-Corona Plaza"
  ];

  for (const header of rejected) {
    assert.equal(
      classifyExplicitNoStopText({
        header,
        stationName: fixture.stationName
      }),
      null
    );
  }
});

test("explicit text and structured entity must agree on station", () => {
  const evaluated = decision({
    header: "Trains skip 111 St",
    description: "",
    stationName: fixture.stationName
  });

  assert.equal(evaluated.suppressionApplied, false);
  assert.equal(evaluated.decisionReason, "NO_EXPLICIT_NO_STOP_PHRASE");

  assert.equal(
    classifyExplicitNoStopText({
      header:
        "Trains skip 111 St; use 103 St-Corona Plaza for alternate service",
      stationName: fixture.stationName
    }),
    null
  );
});

test("structured entity without explicit no-stop action does not suppress", () => {
  const evaluated = decision({
    header: "Station improvements at 103 St-Corona Plaza",
    description: ""
  });

  assert.equal(evaluated.suppressionApplied, false);
});

test("future alerts do not suppress early", () => {
  const evaluated = decision({
    activePeriods: [{ start: NOW_SECONDS + 60, end: NOW_SECONDS + 3600 }]
  });

  assert.equal(evaluated.active, false);
  assert.equal(evaluated.decisionReason, "OUTSIDE_ACTIVE_PERIOD");
});

test("official active-period expiration conclusively restores arrivals", () => {
  const unavailable = authoritativeState([decision()]);
  const policyEnd =
    SANITIZED_PLATFORM_CLOSURES["706N"].activePeriod.end;
  const restored = authoritativeState(
    [],
    unavailable,
    { feedTimestamp: policyEnd },
    (policyEnd + 1) * 1000
  );

  assert.equal(restored.unavailable, false);
  assert.equal(restored.availability, PLATFORM_AVAILABILITY.AVAILABLE);
  assert.equal(
    restored.restorationReason,
    "OFFICIAL_ACTIVE_PERIOD_EXPIRED"
  );
  assert.equal(filterPlatformUnavailableArrivals(restored, [arrival()]).length, 1);
});

test("wrong route, stop, direction, or platform remains unaffected", () => {
  const state = stateFromEvidence([decision()]);
  const unaffected = [
    arrival({ route: "A" }),
    arrival({ platformId: "705N" }),
    arrival({ platformId: "706S" })
  ];

  assert.deepEqual(
    filterPlatformUnavailableArrivals(state, unaffected),
    unaffected
  );
});

test("ambiguous direction mapping fails open and records uncertainty", () => {
  const evaluated = decision({
    routeDirectionSuffixes: {
      "7": { 0: ["N", "S"] }
    }
  });

  assert.equal(evaluated.suppressionApplied, false);
  assert.equal(evaluated.mappingStatus, "AMBIGUOUS_DIRECTION_MAPPING");
});

test("station and route without an affirmatively present direction fail open", () => {
  const evaluated = decision({
    informedEntity: {
      agencyId: "MTASBWY",
      routeId: "7",
      stopId: "706"
    }
  });

  assert.equal(evaluated.suppressionApplied, false);
  assert.equal(evaluated.informedEntity.directionIdPresent, false);
  assert.equal(evaluated.mappingStatus, "AMBIGUOUS_DIRECTION_MAPPING");
});

test("alert-feed failure preserves the last conclusive unavailable state", () => {
  const unavailable = stateFromEvidence([decision()]);
  const failed = reconcilePlatformAvailability(
    unavailable,
    {
      feedSucceeded: false,
      evidence: [],
      error: "decode failed"
    },
    NOW_MS + 1000
  );

  assert.equal(failed.unavailable, true);
  assert.equal(failed.uncertainty, "decode failed");
  assert.equal(filterPlatformUnavailableArrivals(failed, [arrival()]).length, 0);
});

test("stale alert feed preserves the last conclusive state", () => {
  const unavailable = stateFromEvidence([decision()]);
  const stale = reconcilePlatformAvailability(
    unavailable,
    {
      feedSucceeded: true,
      feedStale: true,
      evidence: []
    },
    NOW_MS + 1000
  );

  assert.equal(stale.unavailable, true);
  assert.equal(stale.uncertainty, "ALERT_FEED_STALE");
});

test("successful disappearance is uncertainty and retains suppression", () => {
  const unavailable = authoritativeState([decision()]);
  const retained = authoritativeState([], unavailable);

  assert.equal(retained.unavailable, true);
  assert.equal(retained.availability, PLATFORM_AVAILABILITY.UNKNOWN);
  assert.equal(retained.retainedThroughUncertainty, true);
  assert.equal(retained.uncertainty, "QUALIFYING_ALERT_ABSENT");
});

test("an existing lock is separately suppressed and cannot resurrect", () => {
  let lockState = reconcileDepartureProofLocks(
    null,
    { arrivals: [arrival()], evidence: [tripEvidence()] },
    NOW_MS
  );
  lockState = suppressDepartureProofLocks(
    lockState,
    [decision()],
    NOW_MS + 1000
  );

  assert.equal(Object.keys(lockState.active).length, 0);
  assert.equal(lockState.released.length, 0);
  assert.equal(lockState.suppressed[0].disposition, "PLATFORM_UNAVAILABLE");
  assert.equal(
    lockState.suppressionTombstones["trip-1|20260730"].disposition,
    "PLATFORM_UNAVAILABLE"
  );

  lockState = reconcileDepartureProofLocks(
    lockState,
    { arrivals: [arrival()], evidence: [tripEvidence()] },
    NOW_MS + 2000
  );
  assert.equal(Object.keys(lockState.active).length, 0);
});

test("new current exact evidence may create a different lock after restoration", () => {
  let lockState = reconcileDepartureProofLocks(
    null,
    { arrivals: [arrival()], evidence: [tripEvidence()] },
    NOW_MS
  );
  lockState = suppressDepartureProofLocks(
    lockState,
    [decision()],
    NOW_MS + 1000
  );
  const secondArrival = arrival({
    identityKey: "trip-2|20260730",
    tripId: "trip-2"
  });
  const secondEvidence = tripEvidence({
    identityKey: "trip-2|20260730",
    tripId: "trip-2"
  });
  lockState = reconcileDepartureProofLocks(
    lockState,
    { arrivals: [secondArrival], evidence: [secondEvidence] },
    NOW_MS + 2000
  );

  assert.deepEqual(Object.keys(lockState.active), ["trip-2|20260730"]);
});

test("continuous evidence and coexisting 52/69 evidence stay suppressed regardless of order", () => {
  const unrelated =
    decision({
      alertId: "lmm:planned_work:31498",
      informedEntity: {
        agencyId: "MTASBWY",
        routeId: "7",
        stopId: "713",
        directionId: 0,
        directionIdPresent: true
      },
      header: "Flushing-bound [7] skips 52 St and 69 St",
      stationName: "103 St-Corona Plaza"
    });
  let state =
    authoritativeState([decision(), unrelated]);
  state =
    authoritativeState([unrelated, decision()], state);

  assert.equal(state.unavailable, true);
  assert.equal(state.latestObservationResult, "QUALIFYING_EVIDENCE");
  assert.equal(state.activeEvidence[0].alertId, fixture.id);
});

test("rider-facing limiting cannot affect complete suppression evidence", () => {
  const allEvidence =
    [
      decision(),
      decision({
        alertId: "other",
        header: "7 trains are delayed",
        description: ""
      })
    ];
  const state =
    authoritativeState(allEvidence);
  const riderFacingAlerts =
    [{ id: "other" }];

  assert.equal(riderFacingAlerts.some(item => item.id === fixture.id), false);
  assert.equal(state.unavailable, true);
});

test("absent-present-absent-present snapshots never reopen the platform", () => {
  let state =
    authoritativeState([decision()]);
  const states =
    [state.availability];

  for (const evidence of [[], [decision()], [], [decision()]]) {
    state =
      authoritativeState(
        evidence,
        state,
        { feedTimestamp: state.lastAcceptedFeedTimestamp + 1 }
      );
    states.push(state.availability);
    assert.equal(state.unavailable, true);
  }

  assert.deepEqual(states, [
    PLATFORM_AVAILABILITY.SUPPRESSED,
    PLATFORM_AVAILABILITY.UNKNOWN,
    PLATFORM_AVAILABILITY.SUPPRESSED,
    PLATFORM_AVAILABILITY.UNKNOWN,
    PLATFORM_AVAILABILITY.SUPPRESSED
  ]);
});

test("fetch, decode, and stale uncertainty retain last conclusive suppression", () => {
  const initial =
    authoritativeState([decision()]);
  const cases = [
    {
      feedSucceeded: false,
      decodeSucceeded: true,
      evidence: []
    },
    {
      feedSucceeded: false,
      decodeSucceeded: false,
      evidence: []
    },
    {
      feedSucceeded: true,
      decodeSucceeded: true,
      feedStale: true,
      evidence: []
    }
  ];

  for (const snapshot of cases) {
    const retained =
      reconcileAuthoritativePlatformAvailability(
        initial,
        snapshot,
        NOW_MS + 1000,
        { platformId: "706N" }
      );
    assert.equal(retained.unavailable, true);
    assert.equal(retained.availability, PLATFORM_AVAILABILITY.UNKNOWN);
    assert.equal(retained.retainedThroughUncertainty, true);
  }
});

test("older feed results cannot overwrite newer conclusive evidence", () => {
  const newer =
    authoritativeState(
      [decision()],
      null,
      { feedTimestamp: NOW_SECONDS + 10 }
    );
  const older =
    authoritativeState(
      [],
      newer,
      { feedTimestamp: NOW_SECONDS }
    );

  assert.equal(older.unavailable, true);
  assert.equal(older.latestObservationResult, "OUT_OF_ORDER_FEED");
  assert.equal(
    older.lastAcceptedFeedTimestamp,
    NOW_SECONDS + 10
  );
});

test("conflicting concurrent completion order cannot reopen 706N", () => {
  const base =
    initialAuthoritativePlatformAvailability("706N", NOW_MS);
  const conclusive =
    authoritativeState(
      [decision()],
      base,
      { feedTimestamp: NOW_SECONDS + 20 }
    );
  const conflicting =
    authoritativeState(
      [],
      conclusive,
      { feedTimestamp: NOW_SECONDS + 10 }
    );

  assert.equal(conflicting.unavailable, true);
  assert.equal(conflicting.availability, PLATFORM_AVAILABILITY.UNKNOWN);
});

test("new iframe and server restart bootstrap the same bounded official closure", () => {
  const iframe =
    initialAuthoritativePlatformAvailability("706N", NOW_MS);
  const restartedServer =
    initialAuthoritativePlatformAvailability("706N", NOW_MS);

  assert.deepEqual(restartedServer, iframe);
  assert.equal(iframe.unavailable, true);
  assert.equal(iframe.evidenceAlertId, fixture.id);
  assert.equal(
    iframe.expiration.policyEnd,
    SANITIZED_PLATFORM_CLOSURES["706N"].activePeriod.end
  );
});

test("missing direction and harmless alert-id variation are uncertainty, not restoration", () => {
  const initial =
    authoritativeState([decision()]);
  const missingDirection =
    authoritativeState([
      decision({
        informedEntity: {
          agencyId: "MTASBWY",
          routeId: "7",
          stopId: "706"
        }
      })
    ], initial);
  const variedId =
    authoritativeState([
      decision({ alertId: "replacement-id-with-same-exact-evidence" })
    ], missingDirection);

  assert.equal(missingDirection.unavailable, true);
  assert.equal(missingDirection.availability, PLATFORM_AVAILABILITY.UNKNOWN);
  assert.equal(variedId.unavailable, true);
  assert.equal(variedId.availability, PLATFORM_AVAILABILITY.SUPPRESSED);
});

test("unrelated route-7 and delay alerts cannot reopen a retained closure", () => {
  const initial =
    authoritativeState([decision()]);
  const unrelated =
    decision({
      alertId: "unrelated",
      informedEntity: {
        routeId: "7",
        stopId: "705",
        directionId: 0,
        directionIdPresent: true
      },
      header: "Trains are delayed at 111 St",
      stationName: fixture.stationName
    });
  const retained =
    authoritativeState([unrelated], initial);

  assert.equal(unrelated.suppressionApplied, false);
  assert.equal(retained.unavailable, true);
  assert.equal(retained.availability, PLATFORM_AVAILABILITY.UNKNOWN);
});

test("706S, 705N, and 707N never inherit the 706N policy", () => {
  for (const platformId of ["706S", "705N", "707N"]) {
    const state =
      initialAuthoritativePlatformAvailability(platformId, NOW_MS);
    assert.equal(state.availability, PLATFORM_AVAILABILITY.AVAILABLE);
    assert.equal(state.unavailable, false);
  }
});

test("critical flapping sequence remains suppressed throughout", () => {
  let state =
    authoritativeState([decision()]);
  const snapshots = [
    { feedSucceeded: true, evidence: [] },
    {
      feedSucceeded: true,
      evidence: [decision({
        alertId: "unrelated",
        header: "7 trains are delayed",
        description: ""
      })]
    },
    { feedSucceeded: false, evidence: [] },
    { feedSucceeded: true, evidence: [decision()] }
  ];

  for (const snapshot of snapshots) {
    state =
      reconcileAuthoritativePlatformAvailability(
        state,
        {
          decodeSucceeded: snapshot.feedSucceeded,
          feedStale: false,
          feedTimestamp:
            (state.lastAcceptedFeedTimestamp || NOW_SECONDS) + 1,
          ...snapshot
        },
        NOW_MS + 1000,
        { platformId: "706N" }
      );
    assert.equal(state.unavailable, true);
  }
});

test("client reconciliation accepts the server result without reinterpreting missing evidence", () => {
  const authoritative =
    authoritativeState([]);
  const client =
    reconcilePlatformAvailability(
      null,
      {
        feedSucceeded: true,
        evidence: [],
        authoritative
      },
      NOW_MS
    );

  assert.deepEqual(client, authoritative);
  assert.equal(client.unavailable, true);
});

test("platform diagnostics are deeply detached, frozen, and read-only", () => {
  const liveState = authoritativeState([decision()]);
  const diagnostics = createPlatformAlertDiagnostics(
    new Map([["706N", liveState]])
  );
  const first = diagnostics.inspect();
  const before = JSON.stringify(first);

  assert.equal(Object.isFrozen(first), true);
  assert.notEqual(first.selections[0], liveState);
  assert.notEqual(first.selections[0].activeEvidence, liveState.activeEvidence);
  assert.throws(() => {
    first.selections[0].activeEvidence[0].route = "BAD";
  }, TypeError);
  assert.throws(() => {
    first.selections[0].expiration.policyEnd = 0;
  }, TypeError);
  assert.equal(
    first.selections[0].lastConclusiveState,
    PLATFORM_AVAILABILITY.SUPPRESSED
  );
  assert.equal(first.selections[0].evidenceAlertId, fixture.id);
  assert.equal(first.selections[0].retainedThroughUncertainty, false);
  assert.equal(JSON.stringify(diagnostics.inspect()), before);
  assert.deepEqual(Object.keys(diagnostics), ["inspect"]);
});

function activationPolicy(html, functionName) {
  const match = html.match(
    new RegExp(`function ${functionName}\\(searchParams\\) \\{[\\s\\S]*?\\n\\}`)
  );
  assert.ok(match, `${functionName} must exist`);
  return new Function(
    "URLSearchParams",
    `${match[0]}; return value =>
      ${functionName}(new URLSearchParams(value));`
  )(URLSearchParams);
}

test("platform suppression defaults on and has a narrow emergency off switch", () => {
  const html = fs.readFileSync(
    new URL("../public/arrivals.html", import.meta.url),
    "utf8"
  );
  const enabled = activationPolicy(
    html,
    "isPlatformAlertSuppressionEnabled"
  );
  const departureProofEnabled = activationPolicy(
    html,
    "isDepartureProofLockEnabled"
  );

  assert.equal(enabled(""), true);
  assert.equal(enabled("platformAlertSuppression=1"), true);
  assert.equal(enabled("platformAlertSuppression=0"), false);
  assert.equal(
    departureProofEnabled("platformAlertSuppression=0"),
    true
  );
  assert.match(
    html,
    /platformAlertSuppressionEnabled\s*\? import\("\.\/platform-alert-suppression\.js"\)/
  );
});
