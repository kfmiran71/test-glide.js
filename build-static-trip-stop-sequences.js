import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(directory, "Archive", "stop_times.txt");
const outputPath =
  path.join(directory, "static-trip-stop-sequences.json");
const lines =
  fs.readFileSync(sourcePath, "utf8").trim().split(/\r?\n/);
const headers = (lines.shift() || "").split(",");
const tripIndex = headers.indexOf("trip_id");
const stopIndex = headers.indexOf("stop_id");
const sequenceIndex = headers.indexOf("stop_sequence");
const output = {};

for (const line of lines) {
  const values = line.split(",");
  const pattern =
    (String(values[tripIndex] || "")
      .match(/(\d{6}_[^.]+\.\.[NS])/) || [])[1];
  const stopId = values[stopIndex] || "";
  const sequence = Number(values[sequenceIndex]);

  if (!pattern || !stopId || !Number.isFinite(sequence)) {
    continue;
  }

  output[pattern] ||= {};
  const previous = output[pattern][stopId];
  output[pattern][stopId] =
    previous === undefined || previous === sequence
      ? sequence
      : null;
}

fs.writeFileSync(outputPath, JSON.stringify(output));
console.log(
  `Wrote ${Object.keys(output).length} trip patterns to ${outputPath}`
);
