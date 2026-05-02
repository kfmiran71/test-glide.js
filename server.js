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

const mtaResponse = await fetch(
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs"
);

const buffer = await mtaResponse.arrayBuffer();

const GtfsRealtimeBindings = (await import("gtfs-realtime-bindings")).default;

const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
  new Uint8Array(buffer)
);

const arrivals = [];

feed.entity.forEach(entity => {
  if (entity.tripUpdate) {
    entity.tripUpdate.stopTimeUpdate.forEach(update => {
      if (update.stopId === stopId && update.arrival?.time) {
        const arrivalTime = new Date(update.arrival.time * 1000);
        const now = new Date();

        const diffMin = Math.round((arrivalTime - now) / 60000);

        if (diffMin >= 0 && diffMin <= 60) {
          arrivals.push({
            platform_id: stopId,
            route: entity.tripUpdate.trip.routeId,
            arrival_time: diffMin + " min",
            station: "Atlantic Av - Barclays",
            direction: "Uptown"
          });
        }
      }
    });
  }
});

const glideRes = await fetch("https://api.glideapp.io/api/function/mutateTables", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": "Bearer d25737fc-2ba6-4dfa-bcc1-0b1150680e14"
  },
  body: JSON.stringify({
    appID: "TYenWzXz52pcp3wCTXG6",
    mutations: arrivals.slice(0, 5).map(arrival => ({
      kind: "add-row-to-table",
      tableName: "native-table-d3UgjzNMFLdWdcIIc8AP",
      columnValues: {
        "Name": arrival.platform_id,
        "wuIO9": arrival.route,
        "58c8P": arrival.arrival_time,
        "jQXCB": arrival.station,
        "Qfui6": arrival.direction
      }
    }))
  })
});

const text = await glideRes.text();

    res.json({
      status: response.status,
      ok: response.ok,
      response: text
    });

  } catch (err) {
    res.json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
