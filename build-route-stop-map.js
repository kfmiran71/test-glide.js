import fs from "fs";
import { execFileSync } from "child_process";

const GTFS_FILES = {
  routes: "routes.txt",
  trips: "trips.txt",
  stopTimes: "stop_times.txt",
  stops: "stops.txt"
};

const ARCHIVE_PATH = "Archive.zip";
const OUTPUT_PATH = "route-stop-map.json";
const PLATFORM_ROUTE_OUTPUT_PATH = "platform-route-map.json";
const REPRESENTATIVE_TERMINALS = {
  "5|N": {
    first: "247N",
    last: "501N"
  },
  "5|S": {
    first: "501S",
    last: "247S"
  }
};

function readGtfsFile(fileName) {
  if (fs.existsSync(fileName)) {
    return fs.readFileSync(fileName, "utf8");
  }

  if (fs.existsSync(ARCHIVE_PATH)) {
    return execFileSync("unzip", ["-p", ARCHIVE_PATH, fileName], {
      encoding: "utf8",
      maxBuffer: 80 * 1024 * 1024
    });
  }

  throw new Error(`Missing ${fileName}`);
}

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && inQuotes && next === '"') {
      value += '"';
      i++;
      continue;
    }

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (char === "," && !inQuotes) {
      values.push(value);
      value = "";
      continue;
    }

    value += char;
  }

  values.push(value);
  return values;
}

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines[0]);

  return lines.slice(1).map(line => {
    const values = parseCsvLine(line);
    const row = {};

    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });

    return row;
  });
}

function getDirection(stopId) {
  const suffix = stopId.slice(-1);
  return suffix === "N" || suffix === "S" ? suffix : null;
}

function getStationId(stopId) {
  return stopId.replace(/[NS]$/, "");
}

const routes = parseCsv(readGtfsFile(GTFS_FILES.routes));
const stops = parseCsv(readGtfsFile(GTFS_FILES.stops));
const trips = parseCsv(readGtfsFile(GTFS_FILES.trips));

const routeIds = new Set(
  routes
    .filter(route => route.route_id !== "SI" && route.route_short_name !== "SIR")
    .map(route => route.route_id)
);

const stopById = new Map(
  stops.map(stop => [
    stop.stop_id,
    {
      stop_id: stop.stop_id,
      station_id: getStationId(stop.stop_id),
      stop_name: stop.stop_name,
      lat: stop.stop_lat,
      lon: stop.stop_lon
    }
  ])
);

const routeByTripId = new Map();

trips.forEach(trip => {
  if (routeIds.has(trip.route_id)) {
    routeByTripId.set(trip.trip_id, trip.route_id);
  }
});

const routeStops = {};
const tripStops = new Map();
const platformRoutes = {};

function ensureDirection(routeId, direction) {
  routeStops[routeId] ??= { N: {}, S: {} };
  return routeStops[routeId][direction];
}

for (const row of parseCsv(readGtfsFile(GTFS_FILES.stopTimes))) {
  const routeId = routeByTripId.get(row.trip_id);
  const stop = stopById.get(row.stop_id);
  const direction = getDirection(row.stop_id);

  if (!routeId || !stop || !direction) {
    continue;
  }

  const sequence = Number(row.stop_sequence);
  const directionStops = ensureDirection(routeId, direction);
  platformRoutes[row.stop_id] ??= new Set();
  platformRoutes[row.stop_id].add(routeId);

  directionStops[row.stop_id] ??= {
    ...stop,
    min_sequence: sequence
  };

  directionStops[row.stop_id].min_sequence = Math.min(
    directionStops[row.stop_id].min_sequence,
    sequence
  );

  const tripKey = `${routeId}|${direction}|${row.trip_id}`;
  const trip = tripStops.get(tripKey) ?? {
    routeId,
    direction,
    tripId: row.trip_id,
    stops: new Map()
  };

  const existingSequence = trip.stops.get(row.stop_id);
  if (existingSequence === undefined || sequence < existingSequence) {
    trip.stops.set(row.stop_id, sequence);
  }

  tripStops.set(tripKey, trip);
}

const representativeTrips = new Map();

function matchesRepresentativeTerminals(trip) {
  const terminals = REPRESENTATIVE_TERMINALS[`${trip.routeId}|${trip.direction}`];

  if (!terminals) {
    return true;
  }

  const orderedStops = [...trip.stops.entries()]
    .sort((a, b) => a[1] - b[1])
    .map(([stopId]) => stopId);

  return (
    orderedStops[0] === terminals.first &&
    orderedStops[orderedStops.length - 1] === terminals.last
  );
}

for (const trip of tripStops.values()) {
  const key = `${trip.routeId}|${trip.direction}`;
  const current = representativeTrips.get(key);
  const preferred = matchesRepresentativeTerminals(trip);
  const currentPreferred = current ? matchesRepresentativeTerminals(current) : false;

  if (
    !current ||
    (preferred && !currentPreferred) ||
    (preferred === currentPreferred && (
    trip.stops.size > current.stops.size ||
    (trip.stops.size === current.stops.size && trip.tripId < current.tripId)
    ))
  ) {
    representativeTrips.set(key, trip);
  }
}

const output = {};

Object.keys(routeStops).sort().forEach(routeId => {
  output[routeId] = { N: [], S: [] };

  ["N", "S"].forEach(direction => {
    const representative = representativeTrips.get(`${routeId}|${direction}`);

    if (representative) {
      output[routeId][direction] = [...representative.stops.entries()]
        .sort((a, b) => a[1] - b[1])
        .map(([stopId]) => routeStops[routeId][direction][stopId])
        .filter(Boolean)
        .map(({ min_sequence, ...stop }) => stop);

      return;
    }

    output[routeId][direction] = Object.values(routeStops[routeId][direction])
      .sort((a, b) => a.min_sequence - b.min_sequence || a.stop_id.localeCompare(b.stop_id))
      .map(({ min_sequence, ...stop }) => stop);
  });
});

fs.writeFileSync(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`);

const platformRouteOutput = Object.fromEntries(
  Object.entries(platformRoutes)
    .sort(([stopA], [stopB]) => stopA.localeCompare(stopB))
    .map(([stopId, routes]) => [stopId, [...routes].sort()])
);

fs.writeFileSync(
  PLATFORM_ROUTE_OUTPUT_PATH,
  `${JSON.stringify(platformRouteOutput, null, 2)}\n`
);

console.log(`${OUTPUT_PATH} generated`);
console.log(`${PLATFORM_ROUTE_OUTPUT_PATH} generated`);
