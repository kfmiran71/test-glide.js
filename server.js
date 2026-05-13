import express from "express";
import fetch from "node-fetch";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import fs from "fs";



import path from "path";
import { fileURLToPath } from "url";
const stationsPath = path.resolve("./stations.json");
const STATION_MAP = JSON.parse(fs.readFileSync(stationsPath, "utf-8"));
const routeStopMapPath = path.resolve("./route-stop-map.json");
const ROUTE_STOP_MAP = JSON.parse(fs.readFileSync(routeStopMapPath, "utf-8"));
const platformRouteMapPath = path.resolve("./platform-route-map.json");
const PLATFORM_ROUTE_MAP = JSON.parse(fs.readFileSync(platformRouteMapPath, "utf-8"));
const routeBranchMapPath = path.resolve("./route-branches.json");
const ROUTE_BRANCH_MAP = JSON.parse(fs.readFileSync(routeBranchMapPath, "utf-8"));
const ROUTE_ORDER = [
  "1", "2", "3", "4", "5", "6", "6X", "7", "7X",
  "A", "B", "C", "D", "E", "F", "FX", "FS", "G",
  "GS", "J", "Z", "L", "M", "N", "Q", "R", "W"
];
const HIDDEN_PICKER_ROUTES = new Set(["6X", "7X", "FX"]);
const FEED_URLS = {
  numbered: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
  ace: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace",
  bdfm: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm",
  nqrw: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw",
  jz: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz",
  g: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g",
  l: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l"
};
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Methods",
    "GET, POST, OPTIONS"
  );
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );
  next();
});
const PORT = process.env.PORT || 3000;

function sortRoutes(routes) {
  return [...routes].sort((a, b) => {
    const routeA = ROUTE_ORDER.indexOf(a);
    const routeB = ROUTE_ORDER.indexOf(b);

    if (routeA !== -1 && routeB !== -1) {
      return routeA - routeB;
    }

    if (routeA !== -1) return -1;
    if (routeB !== -1) return 1;

    return a.localeCompare(b);
  });
}

function buildOfficialPlatformRouteMap() {
  const platformRoutes = new Map();
  const addStopRoute = (stopId, routeId) => {
    if (!stopId || !routeId || HIDDEN_PICKER_ROUTES.has(routeId)) {
      return;
    }

    const routes = platformRoutes.get(stopId) || new Set();
    routes.add(routeId);
    platformRoutes.set(stopId, routes);
  };

  for (const [routeId, routeStops] of Object.entries(ROUTE_STOP_MAP)) {
    for (const direction of ["N", "S"]) {
      for (const stop of routeStops[direction] || []) {
        addStopRoute(stop.stop_id, routeId);
      }
    }
  }

  for (const [routeId, routeBranches] of Object.entries(ROUTE_BRANCH_MAP)) {
    for (const branch of Object.values(routeBranches.branches || {})) {
      for (const direction of ["N", "S"]) {
        for (const stop of branch.directions?.[direction] || []) {
          addStopRoute(stop.stop_id, routeId);
        }
      }
    }
  }

  return Object.fromEntries(
    [...platformRoutes.entries()].map(([stopId, routes]) => [
      stopId,
      sortRoutes([...routes])
    ])
  );
}

const OFFICIAL_PLATFORM_ROUTE_MAP = buildOfficialPlatformRouteMap();

function getRoutesForPlatform(platformId) {
  return OFFICIAL_PLATFORM_ROUTE_MAP[platformId] || [];
}

function getRouteBranches(routeId, direction) {
  const routeBranches = ROUTE_BRANCH_MAP[routeId];

  if (!routeBranches) {
    return [];
  }

  return routeBranches.order
    .map(key => routeBranches.branches[key])
    .filter(branch => branch?.directions?.[direction]?.length)
    .map(branch => ({
      key: branch.key,
      label: branch.label
    }));
}

function getBranchStops(routeId, direction, branchKey) {
  return ROUTE_BRANCH_MAP[routeId]?.branches?.[branchKey]?.directions?.[direction] || [];
}

function getStationName(stopId) {
  if (!stopId) {
    return "";
  }

  if (Array.isArray(STATION_MAP)) {
    const match =
      STATION_MAP.find(station => station.stop_id === stopId) ||
      STATION_MAP.find(station => station.stop_id === stopId.replace(/[NS]$/, ""));

    return match?.name || "";
  }

  const match =
    STATION_MAP[stopId] ||
    STATION_MAP[stopId.replace(/[NS]$/, "")];

  if (!match) {
    return "";
  }

  return typeof match === "string" ? match : match.name;
}

function chooseBranchKey(routeId, direction, requestedBranchKey, currentStopId) {
  const branches = getRouteBranches(routeId, direction);

  if (!branches.length) {
    return "";
  }

  const requestedBranch =
    branches.find(branch => branch.key === requestedBranchKey);

  if (requestedBranch) {
    return requestedBranch.key;
  }

  const currentStopBranch =
    branches.find(branch =>
      getBranchStops(routeId, direction, branch.key)
        .some(stop => stop.stop_id === currentStopId)
    );

  return currentStopBranch?.key || branches[0].key;
}

function getFeedUrlsForRoutes(routeIds) {
  const feeds = new Set();

  if (!routeIds.length) {
    Object.values(FEED_URLS).forEach(url => feeds.add(url));
    return [...feeds];
  }

  routeIds.forEach(routeId => {
    if (["1","2","3","4","5","6","6X","7","7X","GS","FS"].includes(routeId)) {
      feeds.add(FEED_URLS.numbered);
    }

    else if (["A","C","E"].includes(routeId)) {
      feeds.add(FEED_URLS.ace);
    }

    else if (["B","D","F","FX","M"].includes(routeId)) {
      feeds.add(FEED_URLS.bdfm);
    }

    else if (["N","Q","R","W"].includes(routeId)) {
      feeds.add(FEED_URLS.nqrw);
    }

    else if (["J","Z"].includes(routeId)) {
      feeds.add(FEED_URLS.jz);
    }

    else if (routeId === "G") {
      feeds.add(FEED_URLS.g);
    }

    else if (routeId === "L") {
      feeds.add(FEED_URLS.l);
    }
  });

  return [...feeds];
}

function findStopByStationId(stationId) {
  for (const routeStops of Object.values(ROUTE_STOP_MAP)) {
    for (const direction of ["N", "S"]) {
      const match = routeStops[direction]?.find(stop => stop.station_id === stationId);

      if (match) {
        return match;
      }
    }
  }

  return null;
}

function distanceMiles(stopA, stopB) {
  const latA = Number(stopA.lat);
  const lonA = Number(stopA.lon);
  const latB = Number(stopB.lat);
  const lonB = Number(stopB.lon);

  if (
    !Number.isFinite(latA) ||
    !Number.isFinite(lonA) ||
    !Number.isFinite(latB) ||
    !Number.isFinite(lonB)
  ) {
    return Number.POSITIVE_INFINITY;
  }

  const earthRadiusMiles = 3958.8;
  const toRadians = degrees => degrees * Math.PI / 180;
  const deltaLat = toRadians(latB - latA);
  const deltaLon = toRadians(lonB - lonA);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(latA)) *
      Math.cos(toRadians(latB)) *
      Math.sin(deltaLon / 2) ** 2;

  return earthRadiusMiles * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getTransferGroups(stationId) {
  const currentStop = findStopByStationId(stationId);

  if (!currentStop) {
    return [];
  }

  const groups = new Map();

  for (const [routeId, routeStops] of Object.entries(ROUTE_STOP_MAP)) {
    for (const direction of ["N", "S"]) {
      for (const stop of routeStops[direction] || []) {
        if (
          stop.stop_name !== currentStop.stop_name ||
          stop.station_id === currentStop.station_id ||
          distanceMiles(currentStop, stop) > 0.22
        ) {
          continue;
        }

        const key = `${stop.station_id}|${direction}`;
        const group = groups.get(key) || {
          direction,
          stopId: stop.stop_id,
          stationId: stop.station_id,
          stationName: stop.stop_name,
          routes: new Set()
        };

        getRoutesForPlatform(stop.stop_id)
          .forEach(platformRoute => group.routes.add(platformRoute));
        groups.set(key, group);
      }
    }
  }

  return [...groups.values()]
    .map(group => ({
      ...group,
      routes: sortRoutes(group.routes)
    }))
    .filter(group => group.routes.length)
    .sort((a, b) => {
      if (a.direction !== b.direction) {
        return a.direction.localeCompare(b.direction);
      }

      return a.stationId.localeCompare(b.stationId);
    });
}

app.use(express.static(path.join(__dirname, "public")));
app.get("/", (req, res) => {
  res.send("Server is running");
});
app.get("/clear-arrivals", async (req, res) => {
  try {
    const response = await fetch("https://api.glideapp.io/api/function/mutateTables", {
     
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer d25737fc-2ba6-4dfa-bcc1-0b1150680e14"
      },
      body: JSON.stringify({
        appID: "TYenWzXz52pcp3wCTXG6",
        mutations: [
          {
            kind: "delete-all-rows-from-table",
            tableName: "native-table-d3UgJzNMFLdWdcIIc8AP"
          }
        ]
      })
    });

    const text = await response.text();

    res.json({
  status: response.status,
  ok: response.ok,
  response: text
});

  } catch (err) {
    res.json({ error: err.message });
  }
});
async function handleArrivals(req, res) {
  try {
 const targetPlatform = req.query.stop || req.query.platformId; 
    console.log("BACKEND VERSION: station-string-v2");
  let arrivals = [];

const routeId = req.query.routeId;

const platformRoutes =
  targetPlatform ? getRoutesForPlatform(targetPlatform) : [];

const routesForFeeds =
  platformRoutes.length ? platformRoutes : routeId ? [routeId] : [];

const feeds =
  getFeedUrlsForRoutes(routesForFeeds);
  
for (const url of feeds) {
  const mtaRes = await fetch(url, {
    headers: {
      "x-api-key": process.env.MTA_API_KEY
    }
  });

  const buffer = await mtaRes.arrayBuffer();
  const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
    new Uint8Array(buffer)
  );

  for (const entity of feed.entity) {
    if (!entity.tripUpdate) continue;

  for (const stopTimeUpdate of entity.tripUpdate.stopTimeUpdate || []) {

  const stopId = stopTimeUpdate.stopId;

  if (targetPlatform && stopId !== targetPlatform) continue;

  const eventTime =
  stopTimeUpdate.departure?.time ||
  stopTimeUpdate.arrival?.time;

if (!eventTime) continue;

const arrivalTime = eventTime * 1000;
  const now = Date.now();
  const minutes = Math.round((arrivalTime - now) / 60000);

  if (minutes < 0 || minutes > 60) continue;

const directionCode = stopId.slice(-1);
const stationCode = stopId.slice(0, -1);

const direction =
  directionCode === "N" ? "Northbound" :
  directionCode === "S" ? "Southbound" :
  directionCode;

let stationName = stationCode;

if (Array.isArray(STATION_MAP)) {
  const match = STATION_MAP.find(s => s.stop_id === stopId);
  if (match) stationName = match.name;
}

else if (STATION_MAP[stopId]) {
  const val = STATION_MAP[stopId];
  stationName = typeof val === "string" ? val : val.name;
}
      
    arrivals.push({
  platformId: stopId,
  route: entity.tripUpdate.trip.routeId,
  time: minutes.toString(),
  station: stationName,
  direction: direction
});
    }
  }
}
    arrivals.sort((a, b) => parseInt(a.time) - parseInt(b.time));
    const limitedArrivals = [];
const routeCounts = {};

for (const a of arrivals) {
  if (!routeCounts[a.route]) {
    routeCounts[a.route] = 0;
  }

  if (routeCounts[a.route] < 3) {
    limitedArrivals.push(a);
    routeCounts[a.route]++;
  }
}
    
    limitedArrivals.sort((a, b) => parseInt(a.time) - parseInt(b.time));
    console.log("LIMITED ARRIVALS BEING SENT TO GLIDE:", limitedArrivals);
limitedArrivals.forEach((a, i) => {
  console.log("GLIDE ROW", i, {
    platformId: a.platformId,
    route: a.route,
    time: a.time,
    station: a.station,
    stationType: typeof a.station,
    direction: a.direction
  });
});

    
    const runId = Date.now().toString();
    
    const response = await fetch("https://api.glideapp.io/api/function/mutateTables", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer d25737fc-2ba6-4dfa-bcc1-0b1150680e14"
      },
      body: JSON.stringify({
        appID: "TYenWzXz52pcp3wCTXG6",
           mutations: [
           
  ...limitedArrivals.map((arrival, index) => ({
    kind: "add-row-to-table",
    tableName: "native-table-d3UgJzNMFLdWdcIIc8AP",
    columnValues: {
      "04m7z": runId,
      "Name": arrival.platformId,
      "wuIO9": arrival.route,
      "58c8P": arrival.time,
      "jQXCB": arrival.station ? arrival.station : "",
      "Qfui6": arrival.direction 
    }
  }))
]
 })
 });
  
    res.json({
  status: 200,
  arrivals: limitedArrivals
});
  } catch (err) {
    res.json({ error: err.message });
  }
}

app.get("/push-arrivals", handleArrivals);
app.get("/arrivals", handleArrivals);
app.get("/transfers", async (req, res) => {

  try {

    const stopId = req.query.stopId;
    const stationId = stopId ? stopId.replace(/[NS]$/, "") : "";

    if (!stationId) {
      return res.status(400).json({
        error: "Missing stopId"
      });
    }

    res.json({
      transfers: getTransferGroups(stationId)
    });

  }

  catch(err) {

    res.status(500).json({
      error: err.message
    });

  }

});
app.get("/stations", async (req, res) => {

  try {

    const routeId = req.query.routeId;
    const direction = req.query.direction;
    const currentStop = req.query.currentStop;
    const requestedBranchKey = req.query.branchKey || "";

    if (!direction) {
      return res.status(400).json({
        error: "Missing direction"
      });
    }

    const currentStationId =
      currentStop ? currentStop.replace(/[NS]$/, "") : "";

    const currentStopId =
      currentStationId ? `${currentStationId}${direction}` : "";

    const platformRoutes =
      currentStopId ? getRoutesForPlatform(currentStopId) : [routeId];

    const effectiveRouteId =
      routeId && platformRoutes.includes(routeId)
        ? routeId
        : platformRoutes[0] || routeId;

    if (!effectiveRouteId) {
      return res.status(400).json({
        error: "Missing routeId or recognizable currentStop"
      });
    }

    const branchKey =
      chooseBranchKey(effectiveRouteId, direction, requestedBranchKey, currentStopId);

    const branches =
      getRouteBranches(effectiveRouteId, direction);

    const routeStops =
      branchKey
        ? getBranchStops(effectiveRouteId, direction, branchKey)
        : ROUTE_STOP_MAP[effectiveRouteId]?.[direction] || [];

    const currentStopIndex =
      routeStops.findIndex(stop => stop.stop_id === currentStopId);

    const visibleStops =
      currentStopIndex >= 0 ? routeStops.slice(currentStopIndex) : routeStops;

    const stops = visibleStops.map(stop => ({
      stopId: stop.stop_id,
      name: stop.stop_name,
      routes: getRoutesForPlatform(stop.stop_id)
    }));

    res.json({
      branchKey,
      branches,
      currentStation: currentStopId
        ? {
            stopId: currentStopId,
            name: getStationName(currentStopId),
            routes: getRoutesForPlatform(currentStopId),
            inList: currentStopIndex >= 0
          }
        : null,
      routeId: effectiveRouteId,
      routes: platformRoutes,
      stations: stops
    });

  }

  catch(err) {

    res.status(500).json({
      error: err.message
    });

  }

});
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
