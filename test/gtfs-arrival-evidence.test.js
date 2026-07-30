import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGtfsEvidence,
  exactTripIdentity
} from "../public/departure-proof-lock.js";

test("strict identity uses tripId and startDate and rejects missing tripId", () => {
  assert.deepEqual(
    exactTripIdentity({ tripId: "A-1", startDate: "20260730", routeId: "A" }),
    {
      identityKey: "A-1|20260730",
      tripId: "A-1",
      startDate: "20260730"
    }
  );
  assert.equal(exactTripIdentity({ routeId: "A" }), null);
});

test("TripUpdate and exact VehiclePosition are correlated", () => {
  const descriptor = {
    tripId: "A-1",
    startDate: "20260730",
    routeId: "A"
  };
  const evidence = buildGtfsEvidence([
    {
      tripUpdate: {
        trip: descriptor,
        currentStopSequence: 11,
        stopTimeUpdate: [
          {
            stopId: "A24N",
            stopSequence: 10,
            arrival: { time: 1000 }
          },
          {
            stopId: "A25N",
            stopSequence: 11,
            departure: { time: 1100 }
          }
        ]
      }
    },
    {
      vehicle: {
        trip: descriptor,
        stopId: "A25N",
        currentStopSequence: 11,
        currentStatus: 1
      }
    }
  ], "A24N", 999);

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].identityKey, "A-1|20260730");
  assert.equal(evidence[0].targetStopPresent, true);
  assert.equal(evidence[0].targetStopSequence, 10);
  assert.equal(evidence[0].tripUpdateProgressionSequence, 11);
  assert.equal(evidence[0].vehiclePositionPresent, true);
  assert.equal(evidence[0].vehicle.currentStopSequence, 11);
});

test("mismatched VehiclePosition remains separate and cannot correlate", () => {
  const evidence = buildGtfsEvidence([
    {
      tripUpdate: {
        trip: { tripId: "A-1", startDate: "20260730", routeId: "A" },
        stopTimeUpdate: [{ stopId: "A24N", stopSequence: 10 }]
      }
    },
    {
      vehicle: {
        trip: { tripId: "A-2", startDate: "20260730", routeId: "A" },
        currentStopSequence: 50
      }
    }
  ], "A24N", 999);

  const update = evidence.find(item => item.identityKey === "A-1|20260730");
  const vehicle = evidence.find(item => item.identityKey === "A-2|20260730");
  assert.equal(update.vehiclePositionPresent, false);
  assert.equal(vehicle.tripUpdatePresent, false);
});

test("multiple VehiclePositions for one identity are classified ambiguous", () => {
  const trip = { tripId: "A-1", startDate: "20260730" };
  const evidence = buildGtfsEvidence([
    { vehicle: { trip, currentStopSequence: 11 } },
    { vehicle: { trip, currentStopSequence: 12 } }
  ], "A24N", 999);

  assert.equal(evidence[0].vehiclePositionAmbiguous, true);
  assert.equal(evidence[0].vehiclePositionPresent, false);
  assert.equal(evidence[0].vehicle, null);
});

test("protobuf default status is not treated as explicitly encoded", () => {
  const trip = { tripId: "A-1", startDate: "20260730" };
  const evidence = buildGtfsEvidence([
    {
      tripUpdate: {
        trip,
        stopTimeUpdate: [{ stopId: "A24N" }]
      }
    },
    {
      vehicle: {
        trip,
        stopId: "A24N",
        currentStopSequence: 10
      }
    }
  ], "A24N", 999, () => 10);

  assert.equal(evidence[0].targetStopSequence, 10);
  assert.equal(evidence[0].vehicle.currentStatus, null);
  assert.equal(evidence[0].vehicle.currentStatusExplicit, false);
  assert.equal(evidence[0].vehicle.currentStopSequenceExplicit, true);
});

test("explicit status and VehiclePosition timestamp are retained", () => {
  const trip = { tripId: "A-1", startDate: "20260730" };
  const evidence = buildGtfsEvidence([
    {
      vehicle: {
        trip,
        stopId: "A24N",
        currentStopSequence: 10,
        currentStatus: 0,
        timestamp: 998
      }
    }
  ], "A24N", 999);

  assert.equal(evidence[0].vehicle.currentStatus, 0);
  assert.equal(evidence[0].vehicle.currentStatusExplicit, true);
  assert.equal(evidence[0].vehicle.timestamp, 998);
});
