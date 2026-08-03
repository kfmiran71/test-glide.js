import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = fs.readFileSync(new URL("../public/arrivals.html", import.meta.url), "utf8");
const coordinatorSource = html.slice(
  html.indexOf("function createRefreshCoordinator"),
  html.indexOf("async function fetchRealtime")
);
const createRefreshCoordinator = vm.runInNewContext(
  `(${coordinatorSource.trim()})`
);

function harness({ startAt = 1000, shouldRefresh = () => true } = {}) {
  let now = startAt;
  let nextTimerId = 1;
  const timers = new Map();
  const requests = [];
  const wakes = [];
  const coordinator = createRefreshCoordinator({
    intervalMs: 15000,
    dedupeMs: 1000,
    now: () => now,
    setTimer(callback, delay) {
      const timerId = nextTimerId++;
      timers.set(timerId, { callback, dueAt: now + delay });
      return timerId;
    },
    clearTimer(timerId) {
      timers.delete(timerId);
    },
    shouldRefresh,
    requestRefresh(details) {
      requests.push(details);
    },
    onWake(details) {
      wakes.push(details);
    }
  });

  return {
    coordinator,
    requests,
    wakes,
    advanceTo(nextNow) {
      now = nextNow;
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.dueAt <= now)
        .sort((a, b) => a[1].dueAt - b[1].dueAt);
      for (const [timerId, timer] of due) {
        if (!timers.delete(timerId)) continue;
        timer.callback();
      }
    },
    now: () => now,
    timers
  };
}

test("the normal refresh deadline remains fifteen seconds", () => {
  const h = harness();
  h.coordinator.start();
  h.advanceTo(15999);
  assert.equal(h.requests.length, 0);
  h.advanceTo(16000);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].reason, "NORMAL_15_SECOND_REFRESH");
  assert.equal(h.requests[0].requestedAt, 16000);
  assert.equal(h.coordinator.inspect().nextDeadlineAt, 31000);
});

test("a throttled timer wake performs one immediate catch-up and restores cadence", () => {
  const h = harness();
  h.coordinator.start();
  h.advanceTo(53000);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].reason, "MISSED_INTERVAL_CATCH_UP");
  assert.equal(h.requests[0].requestedAt, 53000);
  assert.equal(h.coordinator.inspect().nextDeadlineAt, 61000);
  h.advanceTo(61000);
  assert.equal(h.requests[1].reason, "NORMAL_15_SECOND_REFRESH");
});

test("visibility and focus restoration coalesce into one catch-up request", () => {
  const h = harness();
  h.coordinator.start();
  h.advanceTo(8000);
  assert.equal(h.coordinator.catchUp("VISIBILITY_RESTORED"), true);
  h.advanceTo(8500);
  assert.equal(h.coordinator.catchUp("WINDOW_FOCUS_RESTORED"), false);
  assert.equal(h.requests.length, 1);
  assert.equal(h.wakes.at(-1).skipped, "DEDUPED");
});

test("active interaction skips a timer safely without creating a burst", () => {
  let interactionActive = true;
  const h = harness({ shouldRefresh: () => !interactionActive });
  h.coordinator.start();
  h.advanceTo(16000);
  assert.equal(h.requests.length, 0);
  assert.equal(h.wakes.at(-1).skipped, "INTERACTION_ACTIVE");
  interactionActive = false;
  h.advanceTo(31000);
  assert.equal(h.requests.length, 1);
  assert.equal(h.requests[0].reason, "NORMAL_15_SECOND_REFRESH");
});

test("Arrivals wires every resume signal and records refresh latency", () => {
  assert.match(html, /addEventListener\("visibilitychange"/);
  assert.match(html, /addEventListener\("pageshow"/);
  assert.match(html, /addEventListener\("focus"/);
  assert.match(html, /addEventListener\("online"/);
  assert.match(html, /MISSED_INTERVAL_CATCH_UP/);
  assert.match(html, /requestQueueDelayMs/);
  assert.match(html, /requestToCommitMs/);
  assert.match(html, /loadToCommitMs/);
  assert.doesNotMatch(html, /setInterval\(\(\) =>/);
});
