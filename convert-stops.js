import fs from "fs";

const raw = fs.readFileSync("./stops.txt", "utf-8");
const lines = raw.split("\n");

lines.shift();

const stationMap = {};

for (const line of lines) {
  if (!line.trim()) continue;


  const parts = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/)

  const stop_id = parts[0];
  const stop_name = parts[2];

  if (stop_id && stop_name) {
    stationMap[stop_id] = stop_name;
  }

  
  
  if (stop_id && stop_name) {
  stationMap[stop_id] = stop_name;
}

}

const result = Object.entries(stationMap).map(([id, name]) => ({
  stop_id: id,
  name: name
}));

fs.writeFileSync("./stations.json", JSON.stringify(result, null, 2));

console.log("stations.json created");
