import fs from "fs";

// read stops.txt
const raw = fs.readFileSync("./stops.txt", "utf-8");

// split into lines
const lines = raw.split("\n");

// remove header
lines.shift();

const stationMap = {};

// loop through each line
for (const line of lines) {
  if (!line.trim()) continue;

  const parts = line.split(",");

  const stop_id = parts[0];
  const stop_name = parts[2]; // GTFS format

  // ONLY keep station-level IDs (no direction)
  if (/^[A-Z0-9]+$/.test(stop_id)) {
    stationMap[stop_id] = stop_name;
  }
}

// convert to array format
const result = Object.entries(stationMap).map(([id, name]) => ({
  stop_id: id,
  name: name
}));

// write to JSON
fs.writeFileSync("./stations.json", JSON.stringify(result, null, 2));

console.log("stations.json created");
