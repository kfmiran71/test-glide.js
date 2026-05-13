import fs from "fs";
import path from "path";

const ROUTE_ORDER = [
  "1", "2", "3", "4", "5", "6", "6X", "7", "7X",
  "A", "B", "C", "D", "E", "F", "FX", "FS", "G",
  "GS", "J", "Z", "L", "M", "N", "Q", "R", "W"
];
const HIDDEN_PICKER_ROUTES = new Set(["6X", "7X", "FX"]);

const sourcePath =
  process.argv[2] ||
  "/Users/kfmiran/Downloads/Untitled spreadsheet - GTFS_Map-3.csv";
const outputPath =
  process.argv[3] ||
  path.resolve("./official-platform-route-map.json");

function parseCsvLine(line) {
  const cells = [];
  let cell = "";
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1];

    if (char === "\"" && quoted && next === "\"") {
      cell += "\"";
      index += 1;
      continue;
    }

    if (char === "\"") {
      quoted = !quoted;
      continue;
    }

    if (char === "," && !quoted) {
      cells.push(cell);
      cell = "";
      continue;
    }

    cell += char;
  }

  cells.push(cell);
  return cells;
}

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

const [headerLine, ...lines] =
  fs.readFileSync(sourcePath, "utf-8").trim().split(/\r?\n/);
const headers =
  parseCsvLine(headerLine);
const routeIndex =
  headers.indexOf("Route ID");
const platformIndex =
  headers.indexOf("Platform ID");

if (routeIndex < 0 || platformIndex < 0) {
  throw new Error("CSV must include Route ID and Platform ID columns");
}

const platformRoutes =
  new Map();

for (const line of lines) {
  if (!line.trim()) {
    continue;
  }

  const row =
    parseCsvLine(line);
  const routeId =
    row[routeIndex]?.trim();
  const platformId =
    row[platformIndex]?.trim();

  if (!routeId || !platformId || HIDDEN_PICKER_ROUTES.has(routeId)) {
    continue;
  }

  const routes =
    platformRoutes.get(platformId) || new Set();

  routes.add(routeId);
  platformRoutes.set(platformId, routes);
}

const officialMap =
  Object.fromEntries(
    [...platformRoutes.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([platformId, routes]) => [
        platformId,
        sortRoutes([...routes])
      ])
  );

fs.writeFileSync(
  outputPath,
  `${JSON.stringify(officialMap, null, 2)}\n`
);

console.log(
  `Wrote ${Object.keys(officialMap).length} official platform route entries to ${outputPath}`
);
