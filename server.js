import express from "express";
import fetch from "node-fetch";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import fs from "fs";



import path from "path";
import { fileURLToPath } from "url";
const stationsPath = path.resolve("./stations.json");
const STATION_MAP = JSON.parse(fs.readFileSync(stationsPath, "utf-8"));
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
app.get("/push-arrivals", async (req, res) => {
  try {
 const targetPlatform = req.query.platformId; 
    console.log("BACKEND VERSION: station-string-v2");
  let arrivals = [];

const routeId = req.query.routeId;

let feeds = [];

if (!routeId) {

  feeds = [
    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace",
    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm",
    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw",
    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz",
    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g",
    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l"
  ];

}

else if (["1","2","3","4","5","6","7"].includes(routeId)) {

  feeds = [
    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs"
  ];

}

else if (["A","C","E"].includes(routeId)) {

  feeds = [
    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace"
  ];

}

else if (["B","D","F","M"].includes(routeId)) {

  feeds = [
    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm"
  ];

}

else if (["N","Q","R","W"].includes(routeId)) {

  feeds = [
    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw"
  ];

}

else if (["J","Z"].includes(routeId)) {

  feeds = [
    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz"
  ];

}

else if (routeId === "G") {

  feeds = [
    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g"
  ];

}

else if (routeId === "L") {

  feeds = [
    "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l"
  ];

}
  
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
});
app.get("/stations", async (req, res) => {

  try {

    const routeId = req.query.routeId;
    const direction = req.query.direction;

    if (!routeId || !direction) {
      return res.status(400).json({
        error: "Missing routeId or direction"
      });
    }

    let stops = [];

    if (Array.isArray(STATION_MAP)) {

      stops = STATION_MAP
        .filter(stop => {

          if (!stop.stop_id) return false;

          if (!stop.stop_id.endsWith(direction)) {
  return false;
}

const stopPrefix =
  stop.stop_id.replace(/[NS]$/, "").charAt(0);

if (routeId === "1" || routeId === "2" || routeId === "3") {
  return stopPrefix === "1" || stopPrefix === "2";
}

if (routeId === "4" || routeId === "5" || routeId === "6") {
  return stopPrefix === "4";
}

if (routeId === "7") {
  return stopPrefix === "7";
}

return true;

        })
        .map(stop => ({
          stopId: stop.stop_id,
          name: stop.name
        }));

    }

    else {

      stops = Object.entries(STATION_MAP)
        .filter(([stopId]) => stopId.endsWith(direction))
        .map(([stopId, stopData]) => ({
          stopId,
          name:
            typeof stopData === "string"
              ? stopData
              : stopData.name
        }));

    }

    res.json({
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
