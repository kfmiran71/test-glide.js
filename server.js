import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Server is running");
});

app.get("/push-arrivals", async (req, res) => {
  try {
    const stopId = req.query.stop || "235N";

const FEEDS = [
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace",
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm",
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw",
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz",
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l",
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g",
];


const GtfsRealtimeBindings = (await import("gtfs-realtime-bindings")).default;

const arrivals = [];

await Promise.all(
  FEEDS.map(async (url) => {
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();

    const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
      new Uint8Array(buffer)
    );

    feed.entity.forEach(entity => {
      if (!entity.tripUpdate) return;

      entity.tripUpdate.stopTimeUpdate.forEach(update => {
        if (update.stopId === stopId && update.arrival?.time) {

          const arrivalTime = update.arrival.time * 1000;
          const now = Date.now();

          const diffMin = Math.round((arrivalTime - now) / 60000) || 0;

          if (diffMin >= 0 && diffMin <= 60) {
            arrivals.push({
  platformId: stopId,
  route: entity.tripUpdate.trip.routeId || "UNKNOWN",
  times: Number(diffMin) || 0,
  station: "Atlantic Av – Barclays",
  direction: "Uptown"
});
          }
        }
      });
    });
  })
);
 arrivals.sort((a, b) => a.times - b.times);
const grouped = {};

arrivals.forEach(arrival => {
  const route = arrival.route;

  if (!grouped[route]) {
    grouped[route] = [];
  }

  grouped[route].push(arrival);
});
    Object.keys(grouped).forEach(route => {
  grouped[route].sort((a, b) => a.times - b.times);
  grouped[route] = grouped[route].slice(0, 3);
});
const finalArrivals = [];

Object.values(grouped).forEach(routeArrivals => {
  routeArrivals.forEach(a => finalArrivals.push(a));
});
console.log("FINAL ARRIVALS:", JSON.stringify(finalArrivals, null, 2));


  const mutations = [];

mutations.push({
  kind: "delete-all-rows-from-table",
  tableName: "native-table-d3UgJzNMFLdWdcIIc8AP"
});

finalArrivals.forEach(arrival => {
  mutations.push({
    kind: "add-row-to-table",
    tableName: "native-table-d3UgJzNMFLdWdcIIc8AP",
    columnValues: {
      "Name": String(arrival.platformId),
      "wuIO9": String(arrival.route),
      "58c8P": String(arrival.times),
      "jQXCB": String(arrival.station),
      "Qfui6": String(arrival.direction)
    }
  });
});
    console.log("MUTATIONS SENT:", JSON.stringify(mutations, null, 2));
const glideRes = await fetch("https://api.glideapp.io/api/function/mutateTables", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer d25737fc-2ba6-4dfa-bcc1-0b1150680e14"
  },
 body: JSON.stringify({
  appID: "TYenWzXz52pcp3wCTXG6",
  const mutations = [
  {
    kind: "add-row-to-table",
    tableName: "native-table-d3UgJzNMFLdWdcIIc8AP",
    columnValues: {
      "Name": "TEST",
      "wuIO9": "X",
      "58c8P": "1",
      "jQXCB": "Test Station",
      "Qfui6": "Test"
    }
  }
];
  

const text = await glideRes.text();

   res.json({
  status: glideRes.status,
  ok: glideRes.ok,
  response: text
});
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
