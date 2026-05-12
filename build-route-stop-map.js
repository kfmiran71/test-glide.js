import fs from "fs";

const stops = fs.readFileSync("./stops.txt", "utf-8").split("\n");
const trips = fs.readFileSync("./trips.txt", "utf-8").split("\n");
const stopTimes = fs.readFileSync("./stop_times.txt", "utf-8").split("\n");

const stopMap = {};
const routeTripMap = {};
const routeStopsMap = {};



// ----------------------
// BUILD STOP MAP
// ----------------------

for (let i = 1; i < stops.length; i++) {

  const row = stops[i].trim();

  if (!row) continue;

  const cols = row.split(",");

  const stopId = cols[0];
  const stopName = cols[1];

  stopMap[stopId] = {
    stopId,
    stopName
  };

}



// ----------------------
// BUILD TRIP -> ROUTE MAP
// ----------------------

for (let i = 1; i < trips.length; i++) {

  const row = trips[i].trim();

  if (!row) continue;

  const cols = row.split(",");

  const routeId = cols[0];
  const tripId = cols[2];

  routeTripMap[tripId] = routeId;

}



// ----------------------
// BUILD ROUTE -> STOPS MAP
// ----------------------

for (let i = 1; i < stopTimes.length; i++) {

  const row = stopTimes[i].trim();

  if (!row) continue;

  const cols = row.split(",");

  const tripId = cols[0];
  const stopId = cols[3];

  const routeId = routeTripMap[tripId];

  if (!routeId) continue;

  if (!stopMap[stopId]) continue;



  if (!routeStopsMap[routeId]) {
    routeStopsMap[routeId] = [];
  }



  const alreadyExists = routeStopsMap[routeId]
    .some(stop => stop.stopId === stopId);

  if (!alreadyExists) {

    routeStopsMap[routeId].push({
      stopId,
      stopName: stopMap[stopId].stopName
    });

  }

}



// ----------------------
// WRITE FILE
// ----------------------

fs.writeFileSync(
  "./route-stops.json",
  JSON.stringify(routeStopsMap, null, 2)
);

console.log("route-stops.json generated");
