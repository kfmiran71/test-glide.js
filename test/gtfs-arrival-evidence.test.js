import test from "node:test";
import assert from "node:assert/strict";
import {
  buildGtfsEvidence,
  classifyTargetServiceRole,
  exactTripIdentity,
  selectRiderFacingStopTime
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

test("timestamp selection uses arrival time for intermediate passenger stops", () => {
  const feedTimestamp = 1_800_000_000;
  const stopUpdates = [
    { arrival: { time: feedTimestamp + 120 }, departure: { time: feedTimestamp + 150 }, stopId: "248S", stopSequence: 20 },
    { arrival: { time: feedTimestamp + 240 }, departure: { time: feedTimestamp + 540 }, stopId: "249S", stopSequence: 21 },
    { arrival: { time: feedTimestamp + 660 }, departure: { time: feedTimestamp + 690 }, stopId: "250S", stopSequence: 22 }
  ];
  const serviceRole = classifyTargetServiceRole(stopUpdates, "249S", stopUpdates[1]);
  const selected = selectRiderFacingStopTime(stopUpdates[1], serviceRole);

  assert.equal(serviceRole, "INTERMEDIATE");
  assert.equal(selected.selectedEventTime, feedTimestamp + 240);
  assert.equal(selected.selectedEventType, "ARRIVAL");
  assert.equal(selected.timestampSelectionReason, "INTERMEDIATE_ARRIVAL_TIME");
  assert.equal(selected.dwellSeconds, 300);
});

test("late-night through 4 at actual Crown Heights 250S selects arrival", () => {
  const feedTimestamp = 1_800_000_000;
  const evidence = buildGtfsEvidence([{
    tripUpdate: {
      trip: { routeId: "4", startDate: "20260804", tripId: "late-night-through-4" },
      stopTimeUpdate: [
        { arrival: { time: feedTimestamp + 120 }, departure: { time: feedTimestamp + 150 }, stopId: "239S", stopSequence: 30 },
        { arrival: { time: feedTimestamp + 240 }, departure: { time: feedTimestamp + 540 }, stopId: "250S", stopSequence: 1 },
        { arrival: { time: feedTimestamp + 660 }, departure: { time: feedTimestamp + 690 }, stopId: "251S", stopSequence: 2 }
      ]
    }
  }], "250S", feedTimestamp);

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0].serviceRole, "INTERMEDIATE");
  assert.equal(evidence[0].targetArrivalTime, feedTimestamp + 240);
  assert.equal(evidence[0].targetDepartureTime, feedTimestamp + 540);
  assert.equal(evidence[0].targetSelectedEventTime, feedTimestamp + 240);
  assert.equal(evidence[0].targetSelectedEventType, "ARRIVAL");
  assert.equal(evidence[0].targetTimestampSelectionReason, "INTERMEDIATE_ARRIVAL_TIME");
  assert.equal(evidence[0].targetDwellSeconds, 300);
  assert.equal(evidence[0].stopUpdates[1].eventTime, feedTimestamp + 240);
});

test("origin departure keeps departure time when origin is conclusive", () => {
  const feedTimestamp = 1_800_000_000;
  const stopUpdates = [
    { arrival: { time: feedTimestamp }, departure: { time: feedTimestamp + 300 }, stopId: "257N", stopSequence: 1 },
    { arrival: { time: feedTimestamp + 420 }, departure: { time: feedTimestamp + 450 }, stopId: "256N", stopSequence: 2 }
  ];
  const serviceRole = classifyTargetServiceRole(stopUpdates, "257N", stopUpdates[0]);
  const selected = selectRiderFacingStopTime(stopUpdates[0], serviceRole);

  assert.equal(serviceRole, "ORIGIN_DEPARTURE");
  assert.equal(selected.selectedEventTime, feedTimestamp + 300);
  assert.equal(selected.selectedEventType, "DEPARTURE");
  assert.equal(selected.timestampSelectionReason, "ORIGIN_DEPARTURE_DEPARTURE_TIME");
});

test("terminal arrival and ambiguous partial updates prefer arrival time", () => {
  const feedTimestamp = 1_800_000_000;
  const terminalUpdates = [
    { arrival: { time: feedTimestamp + 60 }, departure: { time: feedTimestamp + 90 }, stopId: "701N", stopSequence: 15 },
    { arrival: { time: feedTimestamp + 240 }, departure: { time: feedTimestamp + 540 }, stopId: "702N", stopSequence: 16 }
  ];
  const terminalRole = classifyTargetServiceRole(terminalUpdates, "702N", terminalUpdates[1]);
  const terminalSelection = selectRiderFacingStopTime(terminalUpdates[1], terminalRole);

  assert.equal(terminalRole, "TERMINAL_ARRIVAL");
  assert.equal(terminalSelection.selectedEventTime, feedTimestamp + 240);
  assert.equal(terminalSelection.selectedEventType, "ARRIVAL");

  const partial = { arrival: { time: feedTimestamp + 240 }, departure: { time: feedTimestamp + 540 }, stopId: "251S" };
  const partialRole = classifyTargetServiceRole([partial], "251S", partial);
  const partialSelection = selectRiderFacingStopTime(partial, partialRole);
  assert.equal(partialRole, "UNRESOLVED");
  assert.equal(partialSelection.selectedEventTime, feedTimestamp + 240);
  assert.equal(partialSelection.selectedEventType, "ARRIVAL");
  assert.equal(partialSelection.timestampSelectionReason, "UNRESOLVED_ARRIVAL_TIME");
});

test("target-first partial update with sequence above one is intermediate, not origin", () => {
  const feedTimestamp = 1_800_000_000;
  const partial = [
    { arrival: { time: feedTimestamp + 240 }, departure: { time: feedTimestamp + 540 }, stopId: "251S", stopSequence: 31 },
    { arrival: { time: feedTimestamp + 660 }, departure: { time: feedTimestamp + 690 }, stopId: "252S", stopSequence: 32 }
  ];
  const serviceRole = classifyTargetServiceRole(partial, "251S", partial[0]);
  const selected = selectRiderFacingStopTime(partial[0], serviceRole);

  assert.equal(serviceRole, "INTERMEDIATE");
  assert.equal(selected.selectedEventTime, feedTimestamp + 240);
  assert.equal(selected.selectedEventType, "ARRIVAL");
  assert.equal(selected.timestampSelectionReason, "INTERMEDIATE_ARRIVAL_TIME");
});
