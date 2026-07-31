import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPATIBILITY_CLASSIFICATIONS,
  buildCompatibilityObservation,
  reconcileCompatibilityState
} from "../public/station-state-proof.js";

const ID = "uptown-fixture";
const DATE = "20260731";
const TARGET = "C";

function observation({
  stops = ["A", "B", "C"],
  staticSequences = { A: 10, B: 11, C: 12 },
  explicitSequences = {},
  ...overrides
} = {}) {
  return buildCompatibilityObservation({
    tripId: ID,
    startDate: DATE,
    route: "7",
    targetStop: TARGET,
    stopUpdates: stops.map(stopId => ({
      stopId,
      ...(Object.hasOwn(explicitSequences, stopId)
        ? {
            stopSequence: explicitSequences[stopId],
            stopSequenceExplicit: true
          }
        : {})
    })),
    resolveStaticSequence: (_tripId, stopId) =>
      Object.hasOwn(staticSequences, stopId)
        ? staticSequences[stopId]
        : null,
    ...overrides
  });
}

test("nonconsecutive static sequences do not imply numeric array progression", () => {
  const result = observation({
    staticSequences: { A: 10, B: 20, C: 30 },
    explicitSequences: { A: 10 }
  });
  assert.equal(result.classification, COMPATIBILITY_CLASSIFICATIONS.UNRESOLVED);
  assert.equal(result.targetStaticSequence, 30);
  assert.notEqual(result.targetStaticSequence, 12);
});

test("array distance is never added blindly to an explicit anchor", () => {
  const result = observation({
    stops: ["A", "B", "D", "E", "C"],
    staticSequences: { A: 12, B: 20, D: 30, E: 40, C: 50 },
    explicitSequences: { A: 12 }
  });
  assert.equal(result.classification, COMPATIBILITY_CLASSIFICATIONS.UNRESOLVED);
  assert.equal(result.establishedStartingSequence, 12);
  assert.equal(result.targetStaticSequence, 50);
});

test("an intervening realtime stop without unique static mapping blocks compatibility", () => {
  const result = observation({
    stops: ["A", "UNMAPPED", "C"],
    staticSequences: { A: 10, C: 12 },
    explicitSequences: { A: 10 }
  });
  assert.equal(result.classification, COMPATIBILITY_CLASSIFICATIONS.UNRESOLVED);
  assert.equal(result.reason, "STATIC_NUMERIC_PROGRESSION_NOT_PROVEN");
});

test("explicit anchors prove compatibility across nonconsecutive numbering", () => {
  const result = observation({
    staticSequences: { A: 10, B: 20, C: 30 },
    explicitSequences: { A: 10, B: 20, C: 30 }
  });
  assert.equal(result.classification, COMPATIBILITY_CLASSIFICATIONS.COMPATIBLE);
  assert.equal(result.zeroOffsetProven, true);
  assert.equal(result.reason, "EXPLICIT_TARGET_SEQUENCE_ZERO_OFFSET");
});

test("matching array length and relative order alone remain unresolved", () => {
  const result = observation();
  assert.equal(result.classification, COMPATIBILITY_CLASSIFICATIONS.UNRESOLVED);
  assert.equal(result.reason, "EXPLICIT_ZERO_OFFSET_ANCHOR_UNAVAILABLE");
});

test("uptown fixture is compatible through mapped numeric agreement", () => {
  const result = observation({
    stops: ["701N", "702N", "705N", "706N"],
    staticSequences: {
      "701N": 1,
      "702N": 2,
      "705N": 3,
      "706N": 4
    },
    explicitSequences: { "701N": 1 },
    targetStop: "706N"
  });
  assert.equal(result.classification, COMPATIBILITY_CLASSIFICATIONS.COMPATIBLE);
  assert.equal(result.reason, "EXPLICIT_ANCHOR_WITH_FULL_STATIC_PROGRESSION");
  assert.equal(result.targetStaticSequence, 4);
});

test("affirmative contradiction overrides compatible and remains sticky", () => {
  const compatible = observation({
    explicitSequences: { A: 10 }
  });
  let state = reconcileCompatibilityState(null, { compatibility: compatible });
  assert.equal(state.classification, COMPATIBILITY_CLASSIFICATIONS.COMPATIBLE);

  const conflict = observation({
    explicitSequences: { A: 99 }
  });
  state = reconcileCompatibilityState(state, { compatibility: conflict });
  assert.equal(state.classification, COMPATIBILITY_CLASSIFICATIONS.CONFLICT);

  state = reconcileCompatibilityState(state, { compatibility: compatible });
  assert.equal(state.classification, COMPATIBILITY_CLASSIFICATIONS.CONFLICT);
});
