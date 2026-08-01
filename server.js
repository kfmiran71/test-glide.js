import express from "express";
import fetch from "node-fetch";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import fs from "fs";
import {
  buildGtfsEvidence,
  exactTripIdentity,
  runGlideMutationIfBaseline
} from "./public/departure-proof-lock.js";
import {
  evaluatePlatformAlertEntity
} from "./public/platform-alert-suppression.js";
import {
  createForeverEngine
} from "./forever-engine/engine.js";
import {
  normalizeGtfsEntities
} from "./forever-engine/gtfs-normalizer.js";



import path from "path";
import { fileURLToPath } from "url";
const stationsPath = path.resolve("./stations.json");
const STATION_MAP = JSON.parse(fs.readFileSync(stationsPath, "utf-8"));
const routeStopMapPath = path.resolve("./route-stop-map.json");
const ROUTE_STOP_MAP = JSON.parse(fs.readFileSync(routeStopMapPath, "utf-8"));
const STOP_DETAIL_MAP = new Map();
for (const routeStops of Object.values(ROUTE_STOP_MAP)) {
  for (const direction of ["N", "S"]) {
    for (const stop of routeStops[direction] || []) {
      STOP_DETAIL_MAP.set(stop.stop_id, stop);
    }
  }
}
const officialPlatformRouteMapPath = path.resolve("./official-platform-route-map.json");
const OFFICIAL_PLATFORM_ROUTE_MAP = JSON.parse(fs.readFileSync(officialPlatformRouteMapPath, "utf-8"));
const staticTripsPath = path.resolve("./Archive/trips.txt");
const STATIC_ROUTE_DIRECTION_SUFFIXES =
  buildStaticRouteDirectionSuffixes(
    fs.readFileSync(staticTripsPath, "utf-8")
  );
const routeBranchMapPath = path.resolve("./route-branches.json");
const ROUTE_BRANCH_MAP = JSON.parse(fs.readFileSync(routeBranchMapPath, "utf-8"));
const ROUTE_ORDER = [
  "1", "2", "3", "4", "5", "6", "6X", "7", "7X",
  "A", "B", "C", "D", "E", "F", "FX", "FS", "SF", "G",
  "GS", "H", "SR", "J", "Z", "L", "M", "N", "Q", "R", "W"
];
const HIDDEN_PICKER_ROUTES = new Set(["6X", "7X", "FX", "SI", "SIR"]);
const FEED_URLS = {
  numbered: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs",
  ace: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace",
  bdfm: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm",
  nqrw: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw",
  jz: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz",
  g: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g",
  l: "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l"
};
const ALERT_FEED_URL =
  "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/camsys%2Fsubway-alerts";
const ALERT_FEED_STALE_AFTER_SECONDS = 5 * 60;
const GLIDE_API_URL =
  "https://api.glideapp.io/api/function/mutateTables";
const GLIDE_APP_ID =
  process.env.GLIDE_APP_ID || "TYenWzXz52pcp3wCTXG6";
const GLIDE_API_TOKEN =
  process.env.GLIDE_API_TOKEN || "d25737fc-2ba6-4dfa-bcc1-0b1150680e14";
const LIVE_UPDATES_TABLE =
  process.env.GLIDE_LIVE_UPDATES_TABLE || "Live Updates";
const TUNNEL_TALK_TABLE =
  process.env.GLIDE_TUNNEL_TALK_TABLE || "Tunnel Talk";
const LIVE_UPDATE_COLUMNS = {
  route: process.env.GLIDE_LIVE_UPDATES_ROUTE_COLUMN || "route",
  stationId: process.env.GLIDE_LIVE_UPDATES_STATION_ID_COLUMN || "station_id",
  direction: process.env.GLIDE_LIVE_UPDATES_DIRECTION_COLUMN || "direction",
  alertType: process.env.GLIDE_LIVE_UPDATES_ALERT_TYPE_COLUMN || "alert_type",
  message: process.env.GLIDE_LIVE_UPDATES_MESSAGE_COLUMN || "message",
  userEmail: process.env.GLIDE_LIVE_UPDATES_USER_EMAIL_COLUMN || "user_email",
  timestamp: process.env.GLIDE_LIVE_UPDATES_TIMESTAMP_COLUMN || "timestamp",
  clusterId: process.env.GLIDE_LIVE_UPDATES_CLUSTER_ID_COLUMN || "cluster_id",
  status: process.env.GLIDE_LIVE_UPDATES_STATUS_COLUMN || "status",
  source: process.env.GLIDE_LIVE_UPDATES_SOURCE_COLUMN || "source"
};
const TUNNEL_TALK_COLUMNS = {
  route: process.env.GLIDE_TUNNEL_TALK_ROUTE_COLUMN || "route",
  stationId: process.env.GLIDE_TUNNEL_TALK_STATION_ID_COLUMN || "station_id",
  direction: process.env.GLIDE_TUNNEL_TALK_DIRECTION_COLUMN || "direction",
  alertType: process.env.GLIDE_TUNNEL_TALK_ALERT_TYPE_COLUMN || "alert_type",
  message: process.env.GLIDE_TUNNEL_TALK_MESSAGE_COLUMN || "message",
  userEmail: process.env.GLIDE_TUNNEL_TALK_USER_EMAIL_COLUMN || "user_email",
  timestamp: process.env.GLIDE_TUNNEL_TALK_TIMESTAMP_COLUMN || "timestamp",
  clusterId: process.env.GLIDE_TUNNEL_TALK_CLUSTER_ID_COLUMN || "cluster_id",
  status: process.env.GLIDE_TUNNEL_TALK_STATUS_COLUMN || "status",
  source: process.env.GLIDE_TUNNEL_TALK_SOURCE_COLUMN || "source"
};
const CLUSTER_WINDOW_MS =
  Number(process.env.ALERT_CLUSTER_WINDOW_MINUTES || 20) * 60 * 1000;
const CLUSTER_MAX_AGE_MS =
  Number(process.env.ALERT_CLUSTER_MAX_AGE_MINUTES || 120) * 60 * 1000;
const alertsClusters = new Map();
const foreverEngine = createForeverEngine();
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
app.use(express.json({
  limit: "64kb"
}));
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && "body" in err) {
    return res.status(400).json({
      ok: false,
      error: "Malformed JSON payload"
    });
  }

  next(err);
});
const PORT = process.env.PORT || 3000;

function buildStaticRouteDirectionSuffixes(csv) {
  const lines =
    String(csv || "").trim().split(/\r?\n/);
  const headers =
    (lines.shift() || "").split(",");
  const routeIndex =
    headers.indexOf("route_id");
  const directionIndex =
    headers.indexOf("direction_id");
  const shapeIndex =
    headers.indexOf("shape_id");
  const suffixes =
    {};

  for (const line of lines) {
    const values =
      line.split(",");
    const route =
      values[routeIndex] || "";
    const direction =
      values[directionIndex] || "";
    const shape =
      values[shapeIndex] || "";
    const suffixMatch =
      shape.match(/\.\.([NS])/);

    if (!route || direction === "" || !suffixMatch) {
      continue;
    }

    suffixes[route] ||= {};
    suffixes[route][direction] ||= new Set();
    suffixes[route][direction].add(suffixMatch[1]);
  }

  return Object.fromEntries(
    Object.entries(suffixes).map(([route, directions]) => [
      route,
      Object.fromEntries(
        Object.entries(directions).map(([direction, values]) => [
          direction,
          [...values]
        ])
      )
    ])
  );
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

function routeRank(routeId) {
  const rank =
    ROUTE_ORDER.indexOf(routeId);

  return rank === -1 ? ROUTE_ORDER.length : rank;
}

function normalizeText(value) {
  return String(value || "").trim();
}

function normalizeRouteId(value) {
  return normalizeText(value).toUpperCase();
}

function normalizeDirection(value) {
  const direction =
    normalizeText(value).toUpperCase();

  if (["N", "NORTH", "NORTHBOUND", "UPTOWN"].includes(direction)) {
    return "N";
  }

  if (["S", "SOUTH", "SOUTHBOUND", "DOWNTOWN"].includes(direction)) {
    return "S";
  }

  return direction;
}

function parseAlertTimestamp(value) {
  if (!value) {
    return new Date();
  }

  const parsed =
    new Date(value);

  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeAlertPayload(payload) {
  const timestamp =
    parseAlertTimestamp(payload.timestamp);

  if (!timestamp) {
    return {
      error: "timestamp must be a valid date"
    };
  }

  return {
    alert: {
      route: normalizeRouteId(payload.route),
      station_id: normalizeText(payload.station_id || payload.stationId),
      direction: normalizeDirection(payload.direction),
      alert_type: normalizeText(payload.alert_type || payload.alertType).toLowerCase(),
      message: normalizeText(payload.message),
      user_email: normalizeText(payload.user_email || payload.userEmail).toLowerCase(),
      timestamp: timestamp.toISOString()
    }
  };
}

function validateAlertPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return ["Request body must be a JSON object"];
  }

  const {
    error,
    alert
  } = normalizeAlertPayload(payload);

  if (error) {
    return [error];
  }

  const errors = [];
  const hasTimestamp =
    Boolean(normalizeText(payload.timestamp));

  [
    ["route", alert.route],
    ["station_id", alert.station_id],
    ["direction", alert.direction],
    ["alert_type", alert.alert_type],
    ["message", alert.message],
    ["user_email", alert.user_email],
    ["timestamp", hasTimestamp ? alert.timestamp : ""]
  ].forEach(([field, value]) => {
    if (!value) {
      errors.push(`${field} is required`);
    }
  });

  if (alert.message && alert.message.length < 6) {
    errors.push("message is too short");
  }

  if (alert.message && alert.message.length > 600) {
    errors.push("message is too long");
  }

  if (alert.user_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(alert.user_email)) {
    errors.push("user_email must be a valid email address");
  }

  if (alert.route && !new Set([...ROUTE_ORDER, "S"]).has(alert.route)) {
    errors.push("route is not a recognized subway route");
  }

  if (alert.direction && !["N", "S"].includes(alert.direction)) {
    errors.push("direction must be N/S, uptown/downtown, or northbound/southbound");
  }

  return errors;
}

function alertClusterKey(alert) {
  return [
    alert.route,
    alert.station_id.replace(/[NS]$/, ""),
    alert.direction,
    alert.alert_type
  ].join("|");
}

function messageTokens(message) {
  return new Set(
    normalizeText(message)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(token => token.length > 2)
  );
}

function messageSimilarity(a, b) {
  const tokensA =
    messageTokens(a);
  const tokensB =
    messageTokens(b);

  if (!tokensA.size || !tokensB.size) {
    return 0;
  }

  const shared =
    [...tokensA].filter(token => tokensB.has(token)).length;
  const total =
    new Set([...tokensA, ...tokensB]).size;

  return shared / total;
}

function rotateAlertClusters(nowMs = Date.now()) {
  for (const [clusterId, cluster] of alertsClusters.entries()) {
    if (nowMs - cluster.lastSeenMs > CLUSTER_MAX_AGE_MS) {
      alertsClusters.delete(clusterId);
    }
  }
}

function findMatchingCluster(alert, nowMs = Date.now()) {
  rotateAlertClusters(nowMs);

  const key =
    alertClusterKey(alert);

  return [...alertsClusters.values()].find(cluster =>
    cluster.key === key &&
    nowMs - cluster.lastSeenMs <= CLUSTER_WINDOW_MS &&
    messageSimilarity(cluster.message, alert.message) >= 0.34
  );
}

function isTunnelTalkAlert(alert) {
  const tunnelTypes =
    new Set(["chat", "comment", "question", "general", "other", "tunnel_talk", "tunnel-talk"]);
  const serviceWords =
    /\b(delay|delays|reroute|rerouted|stuck|skipping|police|ems|fire|smoke|sick|crowd|closed|bypass|incident|service|suspended)\b/i;

  return tunnelTypes.has(alert.alert_type) || !serviceWords.test(alert.message);
}

function determineAlertAction(alert) {
  const nowMs =
    Date.now();
  const matchingCluster =
    findMatchingCluster(alert, nowMs);

  if (isTunnelTalkAlert(alert)) {
    const cluster =
      matchingCluster || createAlertCluster(alert, nowMs, "tunnel-talk");

    return {
      action: "divert_to_tunnel_talk",
      cluster,
      duplicate: Boolean(matchingCluster)
    };
  }

  if (matchingCluster) {
    matchingCluster.lastSeenMs =
      nowMs;
    matchingCluster.count += 1;
    matchingCluster.message =
      alert.message;

    return {
      action: "attach_to_existing_cluster",
      cluster: matchingCluster,
      duplicate: true
    };
  }

  return {
    action: "create_new_live_update",
    cluster: createAlertCluster(alert, nowMs, "live-update"),
    duplicate: false
  };
}

function createAlertCluster(alert, nowMs, destination) {
  const cluster = {
    id: `rider-${nowMs}-${Math.random().toString(36).slice(2, 8)}`,
    key: alertClusterKey(alert),
    route: alert.route,
    station_id: alert.station_id,
    direction: alert.direction,
    alert_type: alert.alert_type,
    message: alert.message,
    destination,
    count: 1,
    createdMs: nowMs,
    lastSeenMs: nowMs
  };

  alertsClusters.set(cluster.id, cluster);

  return cluster;
}

function columnValuesFromAlert(alert, cluster, status, columns) {
  const values = {};
  const source =
    "rider";

  [
    ["route", alert.route],
    ["stationId", alert.station_id],
    ["direction", alert.direction],
    ["alertType", alert.alert_type],
    ["message", alert.message],
    ["userEmail", alert.user_email],
    ["timestamp", alert.timestamp],
    ["clusterId", cluster.id],
    ["status", status],
    ["source", source]
  ].forEach(([key, value]) => {
    if (columns[key]) {
      values[columns[key]] = value;
    }
  });

  return values;
}

async function mutateGlideTable(tableName, columnValues) {
  if (!tableName) {
    return {
      skipped: true,
      reason: "Glide table name is not configured"
    };
  }

  const response =
    await fetch(GLIDE_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${GLIDE_API_TOKEN}`
      },
      body: JSON.stringify({
        appID: GLIDE_APP_ID,
        mutations: [
          {
            kind: "add-row-to-table",
            tableName,
            columnValues
          }
        ]
      })
    });

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(`Glide mutateTables failed with ${response.status}: ${text}`);
  }

  return {
    status: response.status,
    ok: response.ok,
    response: text
  };
}

function getRoutesForPlatform(platformId) {
  return (OFFICIAL_PLATFORM_ROUTE_MAP[platformId] || [])
    .filter(routeId => !HIDDEN_PICKER_ROUTES.has(routeId));
}

function enumLabel(enumObject, value) {
  const match =
    Object.entries(enumObject).find(([, enumValue]) => enumValue === value);

  if (!match) {
    return "";
  }

  if (match[0].startsWith("UNKNOWN_")) {
    return "";
  }

  return match[0]
    .toLowerCase()
    .split("_")
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function translatedText(textBlock) {
  return textBlock?.translation?.find(item => item.language === "en")?.text ||
    textBlock?.translation?.[0]?.text ||
    "";
}

function toSeconds(value) {
  if (!value) {
    return 0;
  }

  if (typeof value === "number") {
    return value;
  }

  if (typeof value.toNumber === "function") {
    return value.toNumber();
  }

  return Number(value) || 0;
}

function isActiveAlert(alert, nowSeconds) {
  const periods =
    alert.activePeriod || [];

  if (!periods.length) {
    return true;
  }

  return periods.some(period => {
    const start =
      toSeconds(period.start);
    const end =
      toSeconds(period.end);

    return (!start || start <= nowSeconds) && (!end || end >= nowSeconds);
  });
}

function nextFutureAlertStart(alert, nowSeconds) {
  return nextFutureAlertPeriod(alert, nowSeconds)?.start || 0;
}

function isUpcomingAlert(alert, nowSeconds) {
  return !isActiveAlert(alert, nowSeconds) && Boolean(nextFutureAlertStart(alert, nowSeconds));
}

function alertPeriods(alert) {
  return (alert.activePeriod || [])
    .map(period => ({
      start: toSeconds(period.start),
      end: toSeconds(period.end)
    }))
    .filter(period => period.start || period.end)
    .sort((a, b) => {
      const startA =
        a.start || 0;
      const startB =
        b.start || 0;

      return startA - startB;
    });
}

function currentOrFirstAlertPeriod(alert, nowSeconds = 0) {
  const periods =
    alertPeriods(alert);

  if (!periods.length) {
    return null;
  }

  return periods.find(period =>
    (!period.start || period.start <= nowSeconds) &&
    (!period.end || period.end >= nowSeconds)
  ) || periods[0];
}

function nextFutureAlertPeriod(alert, nowSeconds = 0) {
  return alertPeriods(alert)
    .filter(period => period.start && period.start > nowSeconds)
    .sort((a, b) => a.start - b.start)[0] || null;
}

function alertMatches(alert, routeIds, stopIds) {
  const informed =
    alert.informedEntity || [];

  if (!informed.length) {
    return true;
  }

  return informed.some(entity => {
    const entityRoute =
      entity.routeId || "";
    const entityStop =
      entity.stopId || "";
    const routeMatches =
      !entityRoute || routeIds.includes(entityRoute);
    const stopMatches =
      !entityStop || stopIds.includes(entityStop);

    return routeMatches && stopMatches;
  });
}

function alertTimestamp(alert, feedTimestampSeconds, nowSeconds = 0) {
  const activePeriod =
    currentOrFirstAlertPeriod(alert, nowSeconds);
  const timestampSeconds =
    activePeriod?.start || feedTimestampSeconds || 0;

  if (!timestampSeconds) {
    return {
      timestamp: "",
      label: "",
      endTimestamp: ""
    };
  }

  return {
    timestamp: new Date(timestampSeconds * 1000).toISOString(),
    label: activePeriod?.start ? "Since" : "Updated",
    endTimestamp: activePeriod?.end ? new Date(activePeriod.end * 1000).toISOString() : ""
  };
}

function summarizeAlert(entity, feedTimestampSeconds = 0, nowSeconds = 0) {
  const alert =
    entity.alert;
  const timeInfo =
    alertTimestamp(alert, feedTimestampSeconds, nowSeconds);
  const stopIds =
    [
      ...new Set(
        (alert.informedEntity || [])
          .map(item => item.stopId)
          .filter(Boolean)
      )
    ];
  const routes =
    sortRoutes([
      ...new Set(
        (alert.informedEntity || [])
          .map(item => item.routeId)
          .filter(Boolean)
          .filter(routeId => !HIDDEN_PICKER_ROUTES.has(routeId))
      )
    ]);

  const cause =
    enumLabel(GtfsRealtimeBindings.transit_realtime.Alert.Cause, alert.cause);
  const effect =
    enumLabel(GtfsRealtimeBindings.transit_realtime.Alert.Effect, alert.effect);
  const severity =
    enumLabel(GtfsRealtimeBindings.transit_realtime.Alert.SeverityLevel, alert.severityLevel);

  return {
    id: entity.id || "",
    cause,
    effect,
    severity,
    routes,
    stopIds,
    timestamp: timeInfo.timestamp,
    timestampLabel: timeInfo.label,
    endTimestamp: timeInfo.endTimestamp,
    header: translatedText(alert.headerText),
    description: translatedText(alert.descriptionText)
  };
}

function summarizeUpcomingAlert(entity, feedTimestampSeconds = 0, nowSeconds = 0) {
  const summary =
    summarizeAlert(entity, feedTimestampSeconds, nowSeconds);
  const futurePeriod =
    nextFutureAlertPeriod(entity.alert, nowSeconds);
  const startSeconds =
    futurePeriod?.start || 0;

  return {
    ...summary,
    timestamp: startSeconds ? new Date(startSeconds * 1000).toISOString() : summary.timestamp,
    timestampLabel: startSeconds ? "Starts" : summary.timestampLabel,
    endTimestamp: futurePeriod?.end ? new Date(futurePeriod.end * 1000).toISOString() : summary.endTimestamp
  };
}

function platformAvailabilityEvidence(
  entities,
  selectedPlatform,
  selectedRoute,
  feedTimestampSeconds,
  nowSeconds
) {
  if (!selectedPlatform || !selectedRoute) {
    return [];
  }

  const parentStop =
    selectedPlatform.replace(/[NS]$/, "");
  const stationName =
    STOP_DETAIL_MAP.get(selectedPlatform)?.stop_name || "";
  const evidence =
    [];

  for (const entity of entities || []) {
    if (!entity.alert) {
      continue;
    }

    const header =
      translatedText(entity.alert.headerText);
    const description =
      translatedText(entity.alert.descriptionText);
    const activePeriods =
      alertPeriods(entity.alert);
    const structuredEffect =
      enumLabel(
        GtfsRealtimeBindings.transit_realtime.Alert.Effect,
        entity.alert.effect
      );

    for (const informedEntity of entity.alert.informedEntity || []) {
      if (
        informedEntity.routeId !== selectedRoute ||
        String(informedEntity.stopId || "").replace(/[NS]$/, "") !== parentStop
      ) {
        continue;
      }

      const evaluated =
        evaluatePlatformAlertEntity({
          alertId: entity.id || "",
          activePeriods,
          informedEntity,
          header,
          description,
          stationName,
          routeDirectionSuffixes: STATIC_ROUTE_DIRECTION_SUFFIXES,
          platformRoutes: OFFICIAL_PLATFORM_ROUTE_MAP,
          nowSeconds,
          feedTimestamp: feedTimestampSeconds,
          structuredEffect
        });

      evidence.push(
        evaluated.resolvedPlatform === selectedPlatform
          ? evaluated
          : {
              ...evaluated,
              suppressionApplied: false,
              decisionReason: "DIFFERENT_PLATFORM"
            }
      );
    }
  }

  return evidence;
}

function getRouteBranches(routeId, direction) {
  const routeBranches = ROUTE_BRANCH_MAP[routeId];

  if (!routeBranches) {
    return [];
  }

  return routeBranches.order
    .map(key => routeBranches.branches[key])
    .filter(branch => branch?.directions?.[direction]?.length)
    .map(branch => ({
      key: branch.key,
      label: branch.label
    }));
}

function getBranchStops(routeId, direction, branchKey) {
  return ROUTE_BRANCH_MAP[routeId]?.branches?.[branchKey]?.directions?.[direction] || [];
}

function boroughForStop(stop) {
  const lat =
    Number(stop?.lat);
  const lon =
    Number(stop?.lon);

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return "";
  }

  if (lat >= 40.79 && lon >= -73.91) {
    return "Bronx";
  }

  if (lon >= -73.86) {
    return "Queens";
  }

  if (lat < 40.70) {
    return "Brooklyn";
  }

  if (lon >= -73.946 && lat < 40.79) {
    return "Queens";
  }

  if (lat >= 40.68) {
    return "Manhattan";
  }

  return "";
}

function boundLabelForRouteStops(routeStops) {
  const terminal =
    routeStops?.[routeStops.length - 1];
  const borough =
    boroughForStop(terminal);

  return borough ? `${borough}-bound` : "";
}

function getStationName(stopId) {
  if (!stopId) {
    return "";
  }

  if (Array.isArray(STATION_MAP)) {
    const match =
      STATION_MAP.find(station => station.stop_id === stopId) ||
      STATION_MAP.find(station => station.stop_id === stopId.replace(/[NS]$/, ""));

    return match?.name || "";
  }

  const match =
    STATION_MAP[stopId] ||
    STATION_MAP[stopId.replace(/[NS]$/, "")];

  if (!match) {
    return "";
  }

  return typeof match === "string" ? match : match.name;
}

function destinationNameForTripUpdate(tripUpdate, currentStopId) {
  const updates =
    tripUpdate?.stopTimeUpdate || [];
  const destinationStopId =
    [...updates]
      .reverse()
      .find(update => update.stopId)?.stopId || "";

  if (destinationStopId && destinationStopId !== currentStopId) {
    return getStationName(destinationStopId);
  }

  const routeId =
    tripUpdate?.trip?.routeId || "";
  const direction =
    currentStopId?.endsWith("N") ? "N" :
    currentStopId?.endsWith("S") ? "S" :
    "";
  const terminal =
    ROUTE_STOP_MAP[routeId]?.[direction]?.at(-1);

  return terminal?.stop_name || getStationName(destinationStopId || currentStopId);
}

function chooseBranchKey(routeId, direction, requestedBranchKey, currentStopId) {
  const branches = getRouteBranches(routeId, direction);

  if (!branches.length) {
    return "";
  }

  const requestedBranch =
    branches.find(branch => branch.key === requestedBranchKey);

  if (requestedBranch) {
    return requestedBranch.key;
  }

  const currentStopBranch =
    branches.find(branch =>
      getBranchStops(routeId, direction, branch.key)
        .some(stop => stop.stop_id === currentStopId)
    );

  return currentStopBranch?.key || branches[0].key;
}

function getFeedUrlsForRoutes(routeIds) {
  const feeds = new Set();

  if (!routeIds.length) {
    Object.values(FEED_URLS).forEach(url => feeds.add(url));
    return [...feeds];
  }

  routeIds.forEach(routeId => {
    if (["1","2","3","4","5","6","6X","7","7X","GS"].includes(routeId)) {
      feeds.add(FEED_URLS.numbered);
    }

    else if (["A","C","E","H","SR"].includes(routeId)) {
      feeds.add(FEED_URLS.ace);
    }

    else if (["B","D","F","FX","FS","SF","M"].includes(routeId)) {
      feeds.add(FEED_URLS.bdfm);
    }

    else if (["N","Q","R","W"].includes(routeId)) {
      feeds.add(FEED_URLS.nqrw);
    }

    else if (["J","Z"].includes(routeId)) {
      feeds.add(FEED_URLS.jz);
    }

    else if (routeId === "G") {
      feeds.add(FEED_URLS.g);
    }

    else if (routeId === "L") {
      feeds.add(FEED_URLS.l);
    }
  });

  return [...feeds];
}

function findStopByStationId(stationId) {
  for (const routeStops of Object.values(ROUTE_STOP_MAP)) {
    for (const direction of ["N", "S"]) {
      const match = routeStops[direction]?.find(stop => stop.station_id === stationId);

      if (match) {
        return match;
      }
    }
  }

  return null;
}

function distanceMiles(stopA, stopB) {
  const latA = Number(stopA.lat);
  const lonA = Number(stopA.lon);
  const latB = Number(stopB.lat);
  const lonB = Number(stopB.lon);

  if (
    !Number.isFinite(latA) ||
    !Number.isFinite(lonA) ||
    !Number.isFinite(latB) ||
    !Number.isFinite(lonB)
  ) {
    return Number.POSITIVE_INFINITY;
  }

  const earthRadiusMiles = 3958.8;
  const toRadians = degrees => degrees * Math.PI / 180;
  const deltaLat = toRadians(latB - latA);
  const deltaLon = toRadians(lonB - lonA);
  const a =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(latA)) *
      Math.cos(toRadians(latB)) *
      Math.sin(deltaLon / 2) ** 2;

  return earthRadiusMiles * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getTransferGroups(stationId) {
  const currentStop = findStopByStationId(stationId);

  if (!currentStop) {
    return [];
  }

  const groups = new Map();

  for (const [routeId, routeStops] of Object.entries(ROUTE_STOP_MAP)) {
    for (const direction of ["N", "S"]) {
      for (const stop of routeStops[direction] || []) {
        if (
          stop.stop_name !== currentStop.stop_name ||
          stop.station_id === currentStop.station_id ||
          distanceMiles(currentStop, stop) > 0.22
        ) {
          continue;
        }

        const key = `${stop.station_id}|${direction}`;
        const group = groups.get(key) || {
          direction,
          stopId: stop.stop_id,
          stationId: stop.station_id,
          stationName: stop.stop_name,
          routes: new Set()
        };

        getRoutesForPlatform(stop.stop_id)
          .forEach(platformRoute => group.routes.add(platformRoute));
        groups.set(key, group);
      }
    }
  }

  return [...groups.values()]
    .map(group => ({
      ...group,
      routes: sortRoutes(group.routes)
    }))
    .filter(group => group.routes.length)
    .sort((a, b) => {
      if (a.direction !== b.direction) {
        return a.direction.localeCompare(b.direction);
      }

      return a.stationId.localeCompare(b.stationId);
    });
}

function originStopForAlert(alert, routeId) {
  const informedStop =
    (alert.stopIds || []).find(Boolean);

  if (informedStop) {
    return informedStop.replace(/[NS]$/, "");
  }

  const routeStops =
    ROUTE_STOP_MAP[routeId];

  return routeStops?.N?.[0]?.station_id ||
    routeStops?.S?.[0]?.station_id ||
    "";
}

function alertsForRoute(alerts, routeId) {
  return alerts.filter(alert => alert.routes.includes(routeId));
}

function sortAlertsByTimestamp(alerts) {
  return [...alerts].sort((a, b) => {
    const timeA =
      Date.parse(a.timestamp || "") || Number.MAX_SAFE_INTEGER;
    const timeB =
      Date.parse(b.timestamp || "") || Number.MAX_SAFE_INTEGER;

    if (timeA !== timeB) {
      return timeA - timeB;
    }

    return (a.header || "").localeCompare(b.header || "");
  });
}

function normalizeAlertGroupText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/-brooklyn museum/g, "")
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function groupLookAheadAlerts(alerts) {
  const groups =
    new Map();

  sortAlertsByTimestamp(alerts).forEach(alert => {
    const groupingText =
      normalizeAlertGroupText(alert.header || alert.description);
    const key =
      `${(alert.routes || []).join("|")}::${groupingText}`;

    if (!groups.has(key)) {
      groups.set(key, {
        ...alert,
        occurrences: [],
        starts: []
      });
    }

    const group =
      groups.get(key);
    const occurrenceKey =
      `${alert.timestamp || ""}::${alert.endTimestamp || ""}`;

    if (alert.timestamp && !group.occurrences.some(occurrence => occurrence.key === occurrenceKey)) {
      group.occurrences.push({
        key: occurrenceKey,
        start: alert.timestamp,
        end: alert.endTimestamp || ""
      });
      group.occurrences.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      group.starts.push(alert.timestamp);
      group.starts.sort((a, b) => Date.parse(a) - Date.parse(b));
      group.timestamp =
        group.starts[0] || group.timestamp;
      group.endTimestamp =
        group.occurrences[0]?.end || group.endTimestamp || "";
      group.timestampLabel =
        group.starts.length > 1 ? "Upcoming" : alert.timestampLabel;
    }
  });

  return sortAlertsByTimestamp([...groups.values()]);
}

function activeAlertRoutes(alerts) {
  return sortRoutes([
    ...new Set(
      alerts.flatMap(alert => alert.routes)
        .filter(routeId => !HIDDEN_PICKER_ROUTES.has(routeId))
    )
  ]);
}

function routeIdsInAlertText(alert) {
  const header =
    alert.header || "";
  const shouldUseHeaderRoutes =
    /\breplaces?\b|\binstead of\b|\bruns? .* via\b|\breroutes?\b/i.test(header) &&
    !/^take\b/i.test(header.trim());
  const routeMatches =
    shouldUseHeaderRoutes
      ? [...header.matchAll(/\[([A-Z0-9]+)\]/g)]
      .map(match => match[1])
      .filter(routeId => ROUTE_ORDER.includes(routeId) || routeId === "S")
      .filter(routeId => !HIDDEN_PICKER_ROUTES.has(routeId))
      : [];

  return sortRoutes([
    ...new Set([
      ...alert.routes,
      ...routeMatches
    ])
  ]);
}

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
app.get("/service-alerts", async (req, res) => {

  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");

    const stopId =
      req.query.stopId || "";
    const routeId =
      req.query.routeId || "";
    const baseStopId =
      stopId.replace(/[NS]$/, "");
    const stopIds =
      [stopId, baseStopId].filter(Boolean);
    const routeIds =
      sortRoutes([
        ...new Set([
          routeId,
          ...getRoutesForPlatform(stopId)
        ].filter(Boolean))
      ]);

    const mtaRes =
      await fetch(ALERT_FEED_URL, {
        headers: {
          "x-api-key": process.env.MTA_API_KEY
        }
      });

    if (!mtaRes.ok) {
      return res.status(mtaRes.status).json({
        error: `MTA alerts request failed with ${mtaRes.status}`
      });
    }

    const buffer =
      await mtaRes.arrayBuffer();
    const feed =
      GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
        new Uint8Array(buffer)
      );
    const feedTimestampSeconds =
      toSeconds(feed.header?.timestamp);
    const nowSeconds =
      Math.floor(Date.now() / 1000);
    const feedStale =
      !feedTimestampSeconds ||
      nowSeconds - feedTimestampSeconds > ALERT_FEED_STALE_AFTER_SECONDS ||
      feedTimestampSeconds - nowSeconds > 60;
    const platformAvailability =
      platformAvailabilityEvidence(
        feed.entity,
        stopId,
        routeId || (routeIds.length === 1 ? routeIds[0] : ""),
        feedTimestampSeconds,
        nowSeconds
      );
    const alerts =
      feed.entity
        .filter(entity => entity.alert)
        .filter(entity => isActiveAlert(entity.alert, nowSeconds))
        .filter(entity => alertMatches(entity.alert, routeIds, stopIds))
        .map(entity => summarizeAlert(entity, feedTimestampSeconds, nowSeconds))
        .filter(alert => (alert.header || alert.description) && alert.routes.some(routeId => !HIDDEN_PICKER_ROUTES.has(routeId)))
        .slice(0, 12);
    const feedSample =
      feed.entity
        .filter(entity => entity.alert)
        .filter(entity => isActiveAlert(entity.alert, nowSeconds))
        .map(entity => summarizeAlert(entity, feedTimestampSeconds, nowSeconds))
        .filter(alert => (alert.header || alert.description) && alert.routes.some(routeId => !HIDDEN_PICKER_ROUTES.has(routeId)))
        .slice(0, 20);

    res.json({
      routeIds,
      stopIds,
      count: alerts.length,
      alerts,
      feedSample,
      platformAvailability: {
        feedSucceeded: true,
        feedStale,
        feedTimestamp: feedTimestampSeconds,
        evidence: platformAvailability
      }
    });

  }

  catch(err) {

    res.status(500).json({
      error: err.message
    });

  }

});
app.get("/route-alerts", async (req, res) => {

  try {
    res.setHeader("Cache-Control", "no-store, max-age=0");

    const routeId =
      req.query.routeId || "";
    const mtaRes =
      await fetch(ALERT_FEED_URL, {
        headers: {
          "x-api-key": process.env.MTA_API_KEY
        }
      });

    if (!mtaRes.ok) {
      return res.status(mtaRes.status).json({
        error: `MTA alerts request failed with ${mtaRes.status}`
      });
    }

    const buffer =
      await mtaRes.arrayBuffer();
    const feed =
      GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
        new Uint8Array(buffer)
      );
    const feedTimestampSeconds =
      toSeconds(feed.header?.timestamp);
    const nowSeconds =
      Math.floor(Date.now() / 1000);
    const activeAlerts =
      feed.entity
        .filter(entity => entity.alert)
        .filter(entity => isActiveAlert(entity.alert, nowSeconds))
        .map(entity => summarizeAlert(entity, feedTimestampSeconds, nowSeconds))
        .filter(alert =>
          (alert.header || alert.description) &&
          alert.routes.some(activeRoute => !HIDDEN_PICKER_ROUTES.has(activeRoute))
        );
    const upcomingAlerts =
      feed.entity
        .filter(entity => entity.alert)
        .filter(entity => isUpcomingAlert(entity.alert, nowSeconds))
        .map(entity => summarizeUpcomingAlert(entity, feedTimestampSeconds, nowSeconds))
        .filter(alert =>
          (alert.header || alert.description) &&
          alert.routes.some(activeRoute => !HIDDEN_PICKER_ROUTES.has(activeRoute))
        );
    const routes =
      activeAlertRoutes(activeAlerts);
    const routeAlerts =
      routeId ? alertsForRoute(activeAlerts, routeId).slice(0, 4) : [];
    const routeLookAheadAlerts =
      routeId ? groupLookAheadAlerts(alertsForRoute(upcomingAlerts, routeId)).slice(0, 4) : [];
    const routeLinks =
      routes.map(activeRoute => {
        const alert =
          activeAlerts.find(item => item.routes.includes(activeRoute));

        return {
          route: activeRoute,
          stop: originStopForAlert(alert, activeRoute)
        };
      });
    const alertGroups =
      activeAlerts
        .map(alert => {
          const alertRoutes =
            routeIdsInAlertText(alert);
          const route =
            alert.routes[0] || alertRoutes[0] || "";

          return {
            id: alert.id,
            routes: alertRoutes,
            route,
            stop: originStopForAlert(alert, route)
          };
        })
        .filter(group => group.route)
        .filter((group, index, groups) => {
          const key =
            group.routes.join("|");

          return groups.findIndex(candidate =>
            candidate.routes.join("|") === key
          ) === index;
        })
        .sort((a, b) => {
          const routeA =
            routeRank(a.routes[0] || a.route);
          const routeB =
            routeRank(b.routes[0] || b.route);

          if (routeA !== routeB) {
            return routeA - routeB;
          }

          if (a.routes.length !== b.routes.length) {
            return a.routes.length - b.routes.length;
          }

          return (a.stop || "").localeCompare(b.stop || "");
        });

    res.json({
      routeId,
      count: routeAlerts.length,
      alerts: routeAlerts,
      lookAheadAlerts: routeLookAheadAlerts,
      routes,
      routeLinks,
      alertGroups
    });
  }

  catch(err) {
    res.status(500).json({
      error: err.message
    });
  }

});
app.post("/process-alert", async (req, res) => {

  try {
    const validationErrors =
      validateAlertPayload(req.body);

    if (validationErrors.length) {
      return res.status(400).json({
        ok: false,
        error: "Invalid alert payload",
        details: validationErrors
      });
    }

    const {
      alert
    } = normalizeAlertPayload(req.body);
    const decision =
      determineAlertAction(alert);
    const isTunnelTalk =
      decision.action === "divert_to_tunnel_talk";
    const tableName =
      isTunnelTalk ? TUNNEL_TALK_TABLE : LIVE_UPDATES_TABLE;
    const columns =
      isTunnelTalk ? TUNNEL_TALK_COLUMNS : LIVE_UPDATE_COLUMNS;
    const status =
      decision.action === "attach_to_existing_cluster" ? "attached" :
      decision.action === "divert_to_tunnel_talk" ? "diverted" :
      "new";
    const columnValues =
      columnValuesFromAlert(alert, decision.cluster, status, columns);
    const glideResult =
      await mutateGlideTable(tableName, columnValues);

    if (glideResult.skipped) {
      return res.status(503).json({
        ok: false,
        error: glideResult.reason,
        action: decision.action,
        cluster_id: decision.cluster.id
      });
    }

    res.json({
      ok: true,
      action: decision.action,
      duplicate: decision.duplicate,
      cluster_id: decision.cluster.id,
      cluster_count: decision.cluster.count,
      destination: isTunnelTalk ? "tunnel_talk" : "live_updates",
      glide: {
        status: glideResult.status,
        ok: glideResult.ok
      }
    });
  }

  catch(err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }

});
async function handleArrivals(req, res) {
  try {
 const targetPlatform = req.query.stop || req.query.platformId; 
 const departureProofLockEnabled =
   req.query.departureProofLock === "1";
 const foreverEngineTraceEnabled =
   req.query.foreverEngineTrace !== "0";
 const traceRequestStartedAt =
   foreverEngineTraceEnabled ? Date.now() : 0;
 const traceRequestId =
   foreverEngineTraceEnabled
     ? `${traceRequestStartedAt}-${Math.random().toString(36).slice(2, 10)}`
     : "";
    console.log("BACKEND VERSION: station-string-v2");
  let arrivals = [];
  let departureProofEvidence = [];
  let traceEvidence = [];
  const traceFeeds = [];
  const traceCandidates = [];
  const traceVehiclePositions = [];

const routeId = req.query.routeId;

const platformRoutes =
  targetPlatform ? getRoutesForPlatform(targetPlatform) : [];

const routesForFeeds =
  platformRoutes.length ? platformRoutes : routeId ? [routeId] : [];

const feeds =
  getFeedUrlsForRoutes(routesForFeeds);
  
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

  const decodedAt = Date.now();
  const feedEvidence =
    (foreverEngineTraceEnabled || departureProofLockEnabled)
      ? buildGtfsEvidence(
      feed.entity,
      targetPlatform,
      feed.header?.timestamp
      )
      : [];
  if (foreverEngineTraceEnabled) {
    traceEvidence.push(...feedEvidence);
    const headerTimestamp = Number(feed.header?.timestamp || 0);
    traceFeeds.push({
      feedHeaderTimestamp: headerTimestamp || null,
      decodedAt,
      freshnessSeconds: headerTimestamp
        ? Math.max(0, Math.round(decodedAt / 1000) - headerTimestamp)
        : null,
      entityCount: (feed.entity || []).length
    });
    for (const entity of feed.entity || []) {
      if (!entity.vehicle) continue;
      const identity = exactTripIdentity(entity.vehicle.trip);
      if (!identity) continue;
      const timestamp = Number(entity.vehicle.timestamp || 0) || null;
      traceVehiclePositions.push({
        identityKey: identity.identityKey,
        tripId: identity.tripId,
        startDate: identity.startDate,
        routeId: String(entity.vehicle.trip?.routeId || ""),
        stopId: String(entity.vehicle.stopId || ""),
        currentStopSequence:
          Object.prototype.hasOwnProperty.call(entity.vehicle, "currentStopSequence")
            ? Number(entity.vehicle.currentStopSequence)
            : null,
        currentStopSequenceExplicit:
          Object.prototype.hasOwnProperty.call(entity.vehicle, "currentStopSequence"),
        currentStatus:
          Object.prototype.hasOwnProperty.call(entity.vehicle, "currentStatus")
            ? Number(entity.vehicle.currentStatus)
            : null,
        currentStatusExplicit:
          Object.prototype.hasOwnProperty.call(entity.vehicle, "currentStatus"),
        timestamp,
        ageSeconds: timestamp
          ? Math.max(0, Math.round(decodedAt / 1000) - timestamp)
          : null
      });
    }
  }

  if (departureProofLockEnabled) {
    departureProofEvidence.push(...feedEvidence);
  }

  for (const entity of feed.entity) {
    if (!entity.tripUpdate) continue;

  const tripDestinationName =
    destinationNameForTripUpdate(entity.tripUpdate, targetPlatform);

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

  if (foreverEngineTraceEnabled) {
    const traceIdentity = exactTripIdentity(entity.tripUpdate.trip);
    traceCandidates.push({
      identityKey: traceIdentity?.identityKey || null,
      tripId: traceIdentity?.tripId || null,
      startDate: traceIdentity?.startDate || "",
      routeId: String(entity.tripUpdate.trip?.routeId || ""),
      targetPlatform: String(stopId || ""),
      targetPredictionTimestamp: Number(eventTime),
      arrivalTimestamp: Number(stopTimeUpdate.arrival?.time || 0) || null,
      departureTimestamp: Number(stopTimeUpdate.departure?.time || 0) || null,
      rawCountdown: minutes,
      negative: minutes < 0,
      beyondWindow: minutes > 60,
      candidateArrayMembership:
        (departureProofLockEnabled || minutes >= 0) && minutes <= 60,
      rejectionReason:
        minutes > 60 ? "BEYOND_60_MINUTE_WINDOW" :
        (!departureProofLockEnabled && minutes < 0)
          ? "NEGATIVE_CANDIDATE_FILTER"
          : ""
    });
  }

  if (
    (!departureProofLockEnabled && minutes < 0) ||
    minutes > 60
  ) continue;

const directionCode = stopId.slice(-1);
const stationCode = stopId.slice(0, -1);

const direction =
  directionCode === "N" ? "Northbound" :
  directionCode === "S" ? "Southbound" :
  directionCode;
const stopDetails =
  STOP_DETAIL_MAP.get(stopId);

let stationName =
  tripDestinationName || stationCode;

const exactIdentity =
  departureProofLockEnabled
    ? exactTripIdentity(entity.tripUpdate.trip)
    : null;

if (departureProofLockEnabled && !exactIdentity) continue;
      
    arrivals.push({
  platformId: stopId,
  route: entity.tripUpdate.trip.routeId,
  time: minutes.toString(),
  station: stationName,
  lat: stopDetails?.lat || "",
  lon: stopDetails?.lon || "",
  direction: direction,
  ...(departureProofLockEnabled
    ? {
        identityKey: exactIdentity.identityKey,
        tripId: exactIdentity.tripId,
        startDate: exactIdentity.startDate
      }
    : {})
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

  if (
    departureProofLockEnabled ||
    routeCounts[a.route] < 3
  ) {
    limitedArrivals.push(a);
    routeCounts[a.route]++;
  }
}
    
    limitedArrivals.sort((a, b) => parseInt(a.time) - parseInt(b.time));
if (!departureProofLockEnabled) {
    const glideArrivals =
      limitedArrivals;
    console.log("LIMITED ARRIVALS BEING SENT TO GLIDE:", glideArrivals);
glideArrivals.forEach((a, i) => {
  console.log("GLIDE ROW", i, {
    platformId: a.platformId,
    route: a.route,
    time: a.time,
    station: a.station,
    stationType: typeof a.station,
    lat: a.lat,
    lon: a.lon,
    direction: a.direction
  });
});

    
    const runId = Date.now().toString();
    
    await runGlideMutationIfBaseline(
      departureProofLockEnabled,
      () => fetch("https://api.glideapp.io/api/function/mutateTables", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer d25737fc-2ba6-4dfa-bcc1-0b1150680e14"
      },
      body: JSON.stringify({
        appID: "TYenWzXz52pcp3wCTXG6",
           mutations: [
           
  ...glideArrivals.map((arrival, index) => ({
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
 })
    );
}
  
    res.json({
  status: 200,
  arrivals: limitedArrivals,
  ...(departureProofLockEnabled
    ? {
        departureProofLock: {
          enabled: true,
          evidence: departureProofEvidence
        }
      }
    : {}),
  ...(foreverEngineTraceEnabled
    ? {
        foreverEngineTrace: {
          schemaVersion: 1,
          requestId: traceRequestId,
          requestStartedAt: traceRequestStartedAt,
          responseCreatedAt: Date.now(),
          deployedCommitSha: process.env.RENDER_GIT_COMMIT || "unknown",
          platform: String(targetPlatform || ""),
          routeId: String(routeId || ""),
          feeds: traceFeeds,
          candidates: traceCandidates,
          vehiclePositions: traceVehiclePositions.filter(vehicle =>
            traceCandidates.some(candidate =>
              candidate.identityKey &&
              candidate.identityKey === vehicle.identityKey
            )
          ),
          evidenceSource:
            departureProofLockEnabled
              ? "departureProofLock.evidence"
              : "foreverEngineTrace.evidence",
          evidence:
            departureProofLockEnabled ? [] : traceEvidence
        }
      }
    : {})
});
  } catch (err) {
    res.json({ error: err.message });
  }
}

async function handleForeverArrivals(req, res) {
  try {
    const targetPlatform = String(req.query.stop || req.query.platformId || "");
    const routeId = String(req.query.routeId || "");
    if (!targetPlatform) {
      return res.status(400).json({ error: "Missing exact platform" });
    }

    const platformRoutes = getRoutesForPlatform(targetPlatform);
    const routesForFeeds = platformRoutes.length
      ? platformRoutes
      : routeId ? [routeId] : [];
    const feeds = getFeedUrlsForRoutes(routesForFeeds);
    const observations = new Map();
    let newestFeedTimestamp = null;

    for (const url of feeds) {
      const mtaRes = await fetch(url, {
        headers: { "x-api-key": process.env.MTA_API_KEY }
      });
      if (!mtaRes.ok) {
        throw new Error(`MTA realtime request failed with ${mtaRes.status}`);
      }
      const buffer = await mtaRes.arrayBuffer();
      const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(
        new Uint8Array(buffer)
      );
      const feedTimestamp = toSeconds(feed.header?.timestamp) || null;
      if (feedTimestamp !== null) {
        newestFeedTimestamp = Math.max(newestFeedTimestamp || 0, feedTimestamp);
      }
      const normalized = normalizeGtfsEntities({
        entities: feed.entity,
        feedTimestamp,
        destinationForTrip: tripUpdate =>
          destinationNameForTripUpdate(tripUpdate, targetPlatform),
        directionForPlatform: () => {
          const suffix = targetPlatform.slice(-1);
          return suffix === "N" ? "Northbound" :
            suffix === "S" ? "Southbound" : suffix;
        }
      });
      for (const observation of normalized) {
        const key = `${observation.trip.tripId}|${observation.trip.startDate}`;
        observations.set(key, observation);
      }
    }

    const result = foreverEngine.reconcile({
      platform: targetPlatform,
      observedAt: Date.now(),
      feedTimestamp: newestFeedTimestamp,
      trips: [...observations.values()]
    });
    const stopDetails = STOP_DETAIL_MAP.get(targetPlatform);
    const arrivals = result.arrivals.map(arrival => ({
      ...arrival,
      lat: stopDetails?.lat || "",
      lon: stopDetails?.lon || ""
    }));
    const diagnosticsEnabled = req.query.foreverEngineDiagnostics === "1";

    res.json({
      status: 200,
      engine: "forever",
      platform: targetPlatform,
      feedTimestamp: newestFeedTimestamp,
      arrivals,
      departureProofLock: {
        enabled: true,
        implementation: "forever-engine"
      },
      ...(diagnosticsEnabled ? { foreverEngine: result.diagnostics } : {})
    });
  } catch (err) {
    res.status(502).json({ error: String(err?.message || err) });
  }
}

app.get("/push-arrivals", handleArrivals);
app.get("/arrivals", handleArrivals);
app.get("/forever-arrivals", handleForeverArrivals);
app.get("/transfers", async (req, res) => {

  try {

    const stopId = req.query.stopId;
    const stationId = stopId ? stopId.replace(/[NS]$/, "") : "";

    if (!stationId) {
      return res.status(400).json({
        error: "Missing stopId"
      });
    }

    res.json({
      transfers: getTransferGroups(stationId)
    });

  }

  catch(err) {

    res.status(500).json({
      error: err.message
    });

  }

});
app.get("/stations", async (req, res) => {

  try {

    const routeId = req.query.routeId;
    const direction = req.query.direction;
    const currentStop = req.query.currentStop;
    const requestedBranchKey = req.query.branchKey || "";

    if (!direction) {
      return res.status(400).json({
        error: "Missing direction"
      });
    }

    const currentStationId =
      currentStop ? currentStop.replace(/[NS]$/, "") : "";

    const currentStopId =
      currentStationId ? `${currentStationId}${direction}` : "";

    const platformRoutes =
      currentStopId ? getRoutesForPlatform(currentStopId) : [routeId];

    const effectiveRouteId =
      routeId && platformRoutes.includes(routeId)
        ? routeId
        : platformRoutes[0] || routeId;

    if (!effectiveRouteId) {
      return res.status(400).json({
        error: "Missing routeId or recognizable currentStop"
      });
    }

    const branchKey =
      chooseBranchKey(effectiveRouteId, direction, requestedBranchKey, currentStopId);

    const branches =
      getRouteBranches(effectiveRouteId, direction);

    const routeStops =
      branchKey
        ? getBranchStops(effectiveRouteId, direction, branchKey)
        : ROUTE_STOP_MAP[effectiveRouteId]?.[direction] || [];

    const currentStopIndex =
      routeStops.findIndex(stop => stop.stop_id === currentStopId);

    const visibleStops =
      currentStopIndex >= 0 ? routeStops.slice(currentStopIndex) : routeStops;
    const boundLabel =
      boundLabelForRouteStops(routeStops);

    const stops = visibleStops.map(stop => ({
      stopId: stop.stop_id,
      name: stop.stop_name,
      boundLabel,
      routes: getRoutesForPlatform(stop.stop_id)
    }));

    res.json({
      branchKey,
      branches,
      currentStation: currentStopId
        ? {
            stopId: currentStopId,
            name: getStationName(currentStopId),
            boundLabel,
            routes: getRoutesForPlatform(currentStopId),
            inList: currentStopIndex >= 0
          }
        : null,
      routeId: effectiveRouteId,
      routes: platformRoutes,
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
