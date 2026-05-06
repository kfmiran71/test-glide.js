import express from "express";
import fetch from "node-fetch";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import fs from "fs";



import path from "path";

const stationsPath = path.resolve("./stations.json");
const STATION_MAP = JSON.parse(fs.readFileSync(stationsPath, "utf-8"));

const app = express();
const PORT = process.env.PORT || 3000;

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
  let arrivals = [];

const feeds = [
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace",
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm",
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g",
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz",
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw",
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l"
];

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
      if (!stopTimeUpdate.arrival?.time) continue;

      const arrivalTime = stopTimeUpdate.arrival.time * 1000;
      const now = Date.now();
      const minutes = Math.round((arrivalTime - now) / 60000);

      if (minutes < 0 || minutes > 60) continue;

      const stopId = stopTimeUpdate.stopId;

if (targetPlatform && stopId !== targetPlatform) continue;

const directionCode = stopId.slice(-1);
const stationCode = stopId.slice(0, -1);

const direction =
  directionCode === "N" ? "Northbound" :
  directionCode === "S" ? "Southbound" :
  directionCode;

const stationName = STATION_MAP[stationCode] || stationCode;

      arrivals.push({
  platformId: stopId,
  route: entity.tripUpdate.trip.routeId,
  time: minutes.toString(),
  station: station,
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
    console.log("PAYLOAD ARRIVALS:", arrivals);
    arrivals.forEach((a, i) => {
  console.log("ROW", i, {
    platformId: a.platformId,
    route: a.route,
    time: a.time,
    station: a.station,
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
      "jQXCB": arrival.station,
      "Qfui6": arrival.direction,
      "2sD53": index + 1,
      "v3Wj7": `${runId}-${String(index + 1).padStart(3, "0")}`
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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
