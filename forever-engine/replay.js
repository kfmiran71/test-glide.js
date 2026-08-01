import { createForeverEngine } from "./engine.js";

export function replaySnapshots(snapshots, configuration = {}) {
  const engine = createForeverEngine(configuration);
  return (snapshots || []).map((snapshot, index) => {
    const result = engine.reconcile(snapshot);
    return {
      index,
      platform: result.platform,
      observedAt: result.observedAt,
      arrivals: result.arrivals,
      diagnostics: result.diagnostics
    };
  });
}

export function compareReplay(snapshots, expectedBoards, configuration = {}) {
  const actual = replaySnapshots(snapshots, configuration);
  return actual.map((frame, index) => ({
    index,
    actual: frame.arrivals,
    expected: expectedBoards?.[index] || [],
    matches: JSON.stringify(frame.arrivals) ===
      JSON.stringify(expectedBoards?.[index] || [])
  }));
}
