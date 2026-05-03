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
    const response = await fetch(url);
const buffer = await response.arrayBuffer();
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
  times: Number(diffMin) || 0
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


 
   res.json({
  success: true,
  rowsWritten: finalArrivals.length
});
  } catch (err) {
    res.json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
