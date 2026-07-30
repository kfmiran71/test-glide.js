import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import GtfsRealtimeBindings from "gtfs-realtime-bindings";
import {
  VEHICLE_STATUSES,
  arrivalProofBoardArrivals,
  initialArrivalProofGateState,
  reconcileArrivalProofGates
} from "../public/arrival-proof-gate.js";

const repositoryRoot =
  path.resolve(new URL("..", import.meta.url).pathname);

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

function fixtureFeed(nowSeconds) {
  return GtfsRealtimeBindings.transit_realtime.FeedMessage.encode({
    header: {
      gtfsRealtimeVersion: "2.0",
      timestamp: nowSeconds
    },
    entity: [
      {
        id: "trip-update",
        tripUpdate: {
          trip: {
            tripId: "102700_7..N",
            startDate: "20260730",
            routeId: "7"
          },
          stopTimeUpdate: [
            {
              stopId: "706N",
              arrival: { time: nowSeconds + 30 }
            }
          ]
        }
      },
      {
        id: "vehicle",
        vehicle: {
          trip: {
            tripId: "102700_7..N",
            startDate: "20260730",
            routeId: "7"
          },
          stopId: "706N",
          currentStopSequence: 19,
          currentStatus: VEHICLE_STATUSES.IN_TRANSIT_TO,
          timestamp: nowSeconds - 5
        }
      }
    ]
  }).finish();
}

async function startFixtureServer(t) {
  const directory =
    fs.mkdtempSync(path.join(os.tmpdir(), "arrival-proof-integration-"));
  const fixturePath = path.join(directory, "numbered.pb");
  fs.writeFileSync(
    fixturePath,
    fixtureFeed(Math.floor(Date.now() / 1000))
  );
  const port = await availablePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(port),
      MTA_GTFS_FIXTURE_PATH: fixturePath
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.on("data", chunk => {
    stderr += chunk;
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Server startup timed out: ${stderr}`)),
      10_000
    );
    child.once("exit", code => {
      clearTimeout(timeout);
      reject(new Error(`Server exited with ${code}: ${stderr}`));
    });
    child.stdout.on("data", chunk => {
      if (String(chunk).includes(`Server running on port ${port}`)) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  t.after(() => {
    child.kill("SIGTERM");
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    serverErrors: () => stderr
  };
}

test("production server serves modules and gate API without rider error", async t => {
  const { baseUrl, serverErrors } = await startFixtureServer(t);
  const modulePaths = [
    "/arrival-proof-gate.js",
    "/departure-proof-lock.js",
    "/platform-alert-suppression.js"
  ];

  for (const modulePath of modulePaths) {
    const response = await fetch(`${baseUrl}${modulePath}`);
    assert.equal(response.status, 200);
    assert.match(
      response.headers.get("content-type") || "",
      /application\/javascript/
    );
    assert.ok((await response.text()).length > 100);
  }

  const htmlResponse =
    await fetch(`${baseUrl}/arrivals.html?stop=706&route=7`);
  assert.equal(htmlResponse.status, 200);
  const html = await htmlResponse.text();
  assert.match(html, /import\("\.\/arrival-proof-gate\.js"\)/);

  const enabledResponse = await fetch(
    `${baseUrl}/push-arrivals?stop=706N&routeId=7&` +
    "departureProofLock=1&arrivalProofGate=1"
  );
  assert.equal(enabledResponse.status, 200);
  assert.ok(
    Number(enabledResponse.headers.get("content-length")) < 750_000,
    "combined gate response must not duplicate the full evidence payload"
  );
  const enabled = await enabledResponse.json();
  assert.equal(enabled.error, undefined);
  assert.equal(enabled.status, 200);
  assert.equal(enabled.arrivalProofGate.enabled, true);
  assert.equal(enabled.departureProofLock.enabled, true);
  assert.equal(enabled.arrivalProofGate.evidence, undefined);
  assert.equal(enabled.departureProofLock.evidence.length, 1);
  assert.equal(
    enabled.departureProofLock.evidence[0].targetStopSequence,
    19
  );
  assert.equal(
    enabled.departureProofLock.evidence[0]
      .vehicle.currentStatusExplicit,
    true
  );

  const state = reconcileArrivalProofGates(
    initialArrivalProofGateState(),
    {
      arrivals: enabled.arrivals,
      evidence: enabled.departureProofLock.evidence
    },
    Date.now()
  );
  const board = arrivalProofBoardArrivals(state, enabled.arrivals);
  assert.equal(board[0].time, "1");
  assert.equal(board[0].arrivalProofGated, true);

  const offResponse = await fetch(
    `${baseUrl}/push-arrivals?stop=706N&routeId=7&` +
    "departureProofLock=1"
  );
  assert.equal(offResponse.status, 200);
  const off = await offResponse.json();
  assert.equal(off.error, undefined);
  assert.equal(off.arrivalProofGate, undefined);
  assert.equal(off.departureProofLock.enabled, true);
  assert.equal(serverErrors(), "");
  assert.doesNotMatch(html, /<script type="module">/);
  assert.ok(
    fs.statSync(
      path.join(repositoryRoot, "static-trip-stop-sequences.json")
    ).size < 6_000_000,
    "runtime static lookup must remain compact"
  );
});
