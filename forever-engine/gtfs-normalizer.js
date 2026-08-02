function numberValue(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "object" && typeof value.toNumber === "function") {
    return value.toNumber();
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestampValue(value) {
  const timestamp = numberValue(value);
  return timestamp !== null && timestamp > 0 ? timestamp : null;
}

function hasOwn(object, field) {
  return Boolean(object) && Object.prototype.hasOwnProperty.call(object, field);
}

function identityKey(trip = {}) {
  const tripId = String(trip.tripId || "").trim();
  if (!tripId) return null;
  return `${tripId}|${String(trip.startDate || "").trim()}`;
}

function eventTime(stopUpdate = {}) {
  return numberValue(stopUpdate.departure?.time ?? stopUpdate.arrival?.time);
}

function normalizeVehicle(entity) {
  const vehicle = entity.vehicle;
  if (!vehicle) return null;
  return {
    stopId: String(vehicle.stopId || ""),
    timestamp: timestampValue(vehicle.timestamp),
    currentStopSequence: hasOwn(vehicle, "currentStopSequence")
      ? numberValue(vehicle.currentStopSequence)
      : null,
    currentStopSequenceExplicit: hasOwn(vehicle, "currentStopSequence"),
    currentStatus: hasOwn(vehicle, "currentStatus")
      ? numberValue(vehicle.currentStatus)
      : null,
    currentStatusExplicit: hasOwn(vehicle, "currentStatus")
  };
}

function vehicleId(entity = {}) {
  return String(entity.vehicle?.vehicle?.id || "").trim();
}

export function normalizeGtfsEntities({
  entities = [],
  feedTimestamp = null,
  destinationForTrip = () => "",
  directionForPlatform = () => "",
  originStopForTrip = () => ""
} = {}) {
  const records = new Map();
  const vehicles = new Map();
  const vehicleTripIds = new Set();
  const vehicleIds = new Set();

  for (const entity of entities) {
    if (!entity.vehicle) continue;
    const vehicleTripId = String(entity.vehicle.trip?.tripId || "").trim();
    if (vehicleTripId) vehicleTripIds.add(vehicleTripId);
    const exactVehicleId = vehicleId(entity);
    if (exactVehicleId) vehicleIds.add(exactVehicleId);
    const key = identityKey(entity.vehicle.trip);
    if (!key) continue;
    const existing = vehicles.get(key);
    vehicles.set(key, existing
      ? { ambiguous: true, vehicle: null }
      : { ambiguous: false, vehicle: normalizeVehicle(entity) });
  }

  for (const entity of entities) {
    if (!entity.tripUpdate) continue;
    const trip = entity.tripUpdate.trip || {};
    const key = identityKey(trip);
    if (!key) continue;
    const tripUpdateVehicleId = String(entity.tripUpdate.vehicle?.id || "").trim();
    const stopUpdates = (entity.tripUpdate.stopTimeUpdate || []).map(update => ({
      stopId: String(update.stopId || ""),
      stopSequence: hasOwn(update, "stopSequence")
        ? numberValue(update.stopSequence)
        : null,
      stopSequenceExplicit: hasOwn(update, "stopSequence"),
      eventTime: eventTime(update),
      arrivalTime: numberValue(update.arrival?.time),
      departureTime: numberValue(update.departure?.time),
      scheduleRelationship: numberValue(update.scheduleRelationship)
    }));
    const vehicleMatch = vehicles.get(key);
    const tripId = String(trip.tripId || "").trim();
    records.set(key, {
      trip: {
        tripId,
        startDate: String(trip.startDate || ""),
        routeId: String(trip.routeId || "")
      },
      tripUpdatePresent: true,
      cancelled: [3, 7].includes(Number(trip.scheduleRelationship)),
      tripScheduleRelationship: numberValue(trip.scheduleRelationship),
      // protobufjs materializes an omitted optional uint64 as zero. Zero is
      // absence, not an ancient TripUpdate that should fail freshness checks.
      tripUpdateTimestamp: timestampValue(entity.tripUpdate.timestamp),
      tripUpdateVehicleId,
      vehiclePositionMatched: tripId
        ? vehicleTripIds.has(tripId)
        : Boolean(tripUpdateVehicleId && vehicleIds.has(tripUpdateVehicleId)),
      destination: destinationForTrip(entity.tripUpdate),
      direction: directionForPlatform(stopUpdates),
      originStopId: String(originStopForTrip(trip) || ""),
      stopUpdates,
      vehicle: vehicleMatch?.vehicle || null,
      vehicleAmbiguous: Boolean(vehicleMatch?.ambiguous),
      feedTimestamp: numberValue(feedTimestamp)
    });
  }

  for (const [key, vehicleMatch] of vehicles) {
    if (records.has(key)) continue;
    const entity = entities.find(candidate =>
      candidate.vehicle && identityKey(candidate.vehicle.trip) === key
    );
    const trip = entity?.vehicle?.trip || {};
    records.set(key, {
      trip: {
        tripId: String(trip.tripId || ""),
        startDate: String(trip.startDate || ""),
        routeId: String(trip.routeId || "")
      },
      tripUpdatePresent: false,
      cancelled: false,
      tripScheduleRelationship: null,
      tripUpdateTimestamp: null,
      tripUpdateVehicleId: "",
      vehiclePositionMatched: true,
      destination: "",
      direction: "",
      originStopId: String(originStopForTrip(trip) || ""),
      stopUpdates: [],
      vehicle: vehicleMatch.vehicle,
      vehicleAmbiguous: Boolean(vehicleMatch.ambiguous),
      feedTimestamp: numberValue(feedTimestamp)
    });
  }

  return [...records.values()];
}

export const __test = Object.freeze({ identityKey, numberValue, timestampValue });
