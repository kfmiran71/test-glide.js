function numberValue(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "object" && typeof value.toNumber === "function") {
    return value.toNumber();
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
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
    timestamp: numberValue(vehicle.timestamp),
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

export function normalizeGtfsEntities({
  entities = [],
  feedTimestamp = null,
  destinationForTrip = () => "",
  directionForPlatform = () => ""
} = {}) {
  const records = new Map();
  const vehicles = new Map();

  for (const entity of entities) {
    if (!entity.vehicle) continue;
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
    const stopUpdates = (entity.tripUpdate.stopTimeUpdate || []).map(update => ({
      stopId: String(update.stopId || ""),
      stopSequence: hasOwn(update, "stopSequence")
        ? numberValue(update.stopSequence)
        : null,
      stopSequenceExplicit: hasOwn(update, "stopSequence"),
      eventTime: eventTime(update),
      arrivalTime: numberValue(update.arrival?.time),
      departureTime: numberValue(update.departure?.time)
    }));
    const vehicleMatch = vehicles.get(key);
    records.set(key, {
      trip: {
        tripId: String(trip.tripId || ""),
        startDate: String(trip.startDate || ""),
        routeId: String(trip.routeId || "")
      },
      tripUpdatePresent: true,
      cancelled: Number(trip.scheduleRelationship) === 3,
      destination: destinationForTrip(entity.tripUpdate),
      direction: directionForPlatform(stopUpdates),
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
      destination: "",
      direction: "",
      stopUpdates: [],
      vehicle: vehicleMatch.vehicle,
      vehicleAmbiguous: Boolean(vehicleMatch.ambiguous),
      feedTimestamp: numberValue(feedTimestamp)
    });
  }

  return [...records.values()];
}

export const __test = Object.freeze({ identityKey, numberValue });
