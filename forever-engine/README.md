# Forever Engine replacement

This directory contains an arrivals engine that is independent of the legacy
Glide arrivals decision pipeline. It consumes normalized GTFS-Realtime
observations and owns exact-trip custody, movement state, station-entry
classification, departure proof, and board composition.

## Modes

- No parameter (or `arrivalEngine=forever`): the replacement endpoint and
  state machine supply the board for the Glide field test.
- `arrivalEngine=legacy`: the previously deployed Glide engine remains an
  explicit emergency comparison control.
- `arrivalEngine=shadow`: both engines run, the legacy board is rendered, and
  the trace records a comparison.
  The legacy Departure-Proof module is not imported or executed in replacement
  mode.

No mode writes replacement arrivals to Glide tables. Platform-alert
suppression remains a separate publication policy applied by the page.

## Universal invariants

1. State belongs to `tripId|startDate` and never transfers between identities.
2. Missing, stale, ambiguous, or defaulted evidence cannot prove movement.
3. A VehiclePosition naming the exact target cannot be downstream.
4. Realtime array order establishes relative order; numeric sequences are not
   assumed to be consecutive.
5. Station entry requires a fresh explicit exact-target `STOPPED_AT` sample or
   two distinct feed snapshots retaining a zero target prediction.
6. Departure-proof custody survives prediction expiry, disappearance, errors,
   stale evidence, reordering, and route-slot pressure.
7. Departure requires a fresh exact VehiclePosition at a uniquely downstream
   realtime occurrence or an explicit cancellation.
8. Protected trips are composed before ordinary per-route limits.
9. Diagnostics are detached from live state.
10. Registries and per-trip histories are bounded.
11. A conclusive realtime pattern classifies each exact trip once as an
    intermediate arrival, terminal arrival, or origin departure; a later
    shrinking pattern cannot change that role.
12. Terminal arrivals remain visible while current target evidence exists but
    do not create downstream-dependent locks. Origin departures retain their
    departure countdown and cannot masquerade as arrivals at zero.

## Runtime boundary

`gtfs-normalizer.js` preserves protobuf field presence and correlates
TripUpdates and VehiclePositions only by exact identity. `engine.js` has no
Express, Glide, DOM, or legacy-engine dependency. `server.js` is an adapter that
fetches and decodes MTA feeds, calls the engine, and returns the existing card
shape through `/forever-arrivals`.

The registry is intentionally in process for this experiment. A Render restart
clears custody and the engine reconstructs state from new observations. A
production promotion would require explicit restart persistence or acceptance
of this reset boundary.

`replay.js` runs captured normalized snapshots through a fresh engine so field
failures can become deterministic regression fixtures before a policy is
allowed to control the rider board.
