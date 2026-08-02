import assert from "node:assert/strict";
import test from "node:test";
import {
  describeDepartureCorridor,
  evaluateLonghaulDeparture
} from "../forever-engine/longhaul-fallback.js";

test("corridor follows the next served stop without inventing skipped-stop counts", () => {
  const corridor = describeDepartureCorridor([
    { stopId: "R31N", stopSequence: 10, eventTime: 1000 },
    { stopId: "D22N", stopSequence: 40, eventTime: 1360 }
  ], "R31N");
  assert.deepEqual(corridor, {
    targetStop: "R31N",
    nextServedStop: "D22N",
    targetStopSequence: 10,
    nextStopSequence: 40,
    predictedTravelSeconds: 360,
    skippedStopCount: null
  });
});

test("shadow evaluator requires elapsed observation and two corroborators", () => {
  const result = evaluateLonghaulDeparture({
    nowMs: 400_000,
    lockedAt: 100_000,
    departureLocked: true,
    corridor: { nextServedStop: "D22N", predictedTravelSeconds: 360 },
    vehicle: { present: false, fresh: false },
    tripUpdatePresent: true,
    targetPresent: false,
    lastTargetTime: 150
  });
  assert.equal(result.wouldRelease, true);
  assert.equal(result.boardEffect, false);
  assert.equal(result.reason, "LONGHAUL_CORROBORATED_DEPARTURE");
});

test("fresh explicit STOPPED_AT target vetoes the shadow fallback", () => {
  const result = evaluateLonghaulDeparture({
    nowMs: 400_000,
    lockedAt: 100_000,
    departureLocked: true,
    corridor: { nextServedStop: "D22N", predictedTravelSeconds: 360 },
    vehicle: {
      present: true,
      fresh: true,
      position: "TARGET",
      currentStatusExplicit: true,
      currentStatus: 1
    },
    tripUpdatePresent: true,
    targetPresent: false,
    lastTargetTime: 150
  });
  assert.equal(result.wouldRelease, false);
  assert.equal(result.reason, "FRESH_EXPLICIT_STOPPED_VETO");
});

test("time alone can never produce a shadow release", () => {
  const result = evaluateLonghaulDeparture({
    nowMs: 1_000_000,
    lockedAt: 0,
    departureLocked: true,
    corridor: { nextServedStop: "D22N", predictedTravelSeconds: 360 },
    vehicle: { present: true, fresh: true, position: "TARGET" },
    tripUpdatePresent: true,
    targetPresent: true,
    lastTargetTime: 2000
  });
  assert.equal(result.wouldRelease, false);
  assert.equal(result.corroboratorCount, 0);
});

test("unresolved and ambiguous corridors fail closed", () => {
  assert.equal(describeDepartureCorridor([
    { stopId: "R31N" },
    { stopId: "R31N" },
    { stopId: "D22N" }
  ], "R31N"), null);
  const result = evaluateLonghaulDeparture({
    nowMs: 1_000_000,
    lockedAt: 0,
    departureLocked: true,
    corridor: null
  });
  assert.equal(result.wouldRelease, false);
  assert.equal(result.reason, "CORRIDOR_UNRESOLVED");
});
