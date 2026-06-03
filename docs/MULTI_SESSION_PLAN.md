# Multi-session fork plan — true in-pod concurrent sessions

> Status: **planned, not started.** Tracked in Huly (see issue link once filed).
> This is a ledoent-fork initiative; steel OSS runs one Chrome / one session
> per container by design.

## Goal & baseline

Run **N concurrent, fully independent browser sessions inside one pod**, each
backed by its own Chrome process, addressable/routable by `sessionId`. Today the
server runs exactly one Chrome and one logical session; `POST /v1/sessions`
*replaces* it. "Tiling" is a Steel **Cloud** feature but is simply unimplemented
in OSS — not license-gated.

## Confirmed blockers (source-verified, `steel-dev/steel-browser@main`)

| # | Where | What |
|---|---|---|
| 1 | `cdp.service.ts` | Singleton `browserInstance` / `primaryPage` / `wsEndpoint` / `currentSessionConfig`; one `pluginManager`/`wsProxyServer`/instrumentation. `endSession()` relaunches a default idle browser. |
| 2 | `cdp.service.ts::launchInternal` | Hardcoded `--remote-debugging-port=9222` (ignores existing `env.CDP_REDIRECT_PORT`). |
| 3 | `session.service.ts` | Single `activeSession`; `startSession`→`resetSessionInfo` clobbers it; `endSession()` takes no id. |
| 4 | `sessions.controller.ts` | `handleGetSessionDetails` returns a synthetic "released" stub for any id≠active; `handleExitBrowserSession` ignores its route param; live-details unscoped. |
| 5 | `casting.handler.ts` / `browser-socket.ts` | Cast parses `:id` but ignores it, uses `activeSession`; `puppeteer.connect` tunnels through the Fastify port → singleton `proxyWebSocket` → `this.wsEndpoint` (doubly singleton-bound). |
| 6 | (found in source) | **Shared `userDataDir`** defaults to one path (`$TMPDIR/steel-chrome`) — two Chromes collide/corrupt. Must be per-session. |
| 7 | (found in source) | `onDisconnect → endSession → relaunch(default)` keepAlive behavior must be gated off for pooled per-session instances. |
| — | `nginx.conf` + Dockerfile | External raw DevTools is nginx `9223→9222`, outside Node. Multi-port Chrome needs an nginx range/path mapping for direct DevTools (in-pod cast viewer does NOT depend on it). |

## Target architecture

`SessionService` becomes a **registry**: `Map<sessionId, { details, cdpService }>`.
Each `CDPService` owns one Chrome, one debug port, its own `PluginManager` /
`wsProxyServer` / instrumentation / `userDataDir`. Existing single-session code
inside `CDPService` runs unchanged **per instance** (smallest blast radius). A
new `PortAllocator` hands out debug ports; WS/HTTP routing keys on `sessionId`
from the URL. Keep one idle/default `CDPService` for the no-id "current session"
endpoints (back-compat).

## Phases (ordered, each shippable; 0 & 1 land behind defaults that preserve single-session behavior)

- **Phase 0 — Port allocator + per-session `userDataDir` (S).** New
  `port-allocator.ts` (range `[CDP_BASE_PORT, +CDP_PORT_RANGE)`, linear scan +
  bind-probe; ephemeral `:0` fallback reading back `wsEndpoint()`). Replace the
  literal `9222` with `this.debugPort`. Per-session `userDataDir =
  $TMPDIR/steel-chrome/<sessionId>`. New env: `CDP_BASE_PORT`, `CDP_PORT_RANGE`,
  `MAX_CONCURRENT_SESSIONS`.
- **Phase 1 — `CDPService` instance factory + lifecycle decoupling (M).**
  Constructor gains `{ keepAlive?, debugPort?, sessionId?, relaunchIdleOnEnd? }`.
  Gate the trailing idle relaunch in `endSession`. Add injectable
  `onTerminated?()` so a pooled instance's disconnect evicts the entry + releases
  the port instead of resurrecting an idle browser.
- **Phase 2 — `SessionService` registry refactor (L, core).** `activeSession` →
  `Map`, with a compat getter (`= the sole live session, else idle/default`).
  `startSession`: enforce cap (429 at limit), allocate port, construct a
  per-session `CDPService` (`relaunchIdleOnEnd:false`), stop clobbering, insert
  keyed by id, emit session-scoped `websocketUrl`/`debuggerUrl`/viewer URLs.
  `endSession(sessionId)` (+ `endAllSessions()`), `getSession`,
  `getActiveSessions`, `resolveCdpForUpgrade(url)`. Typed `SessionNotFoundError`
  / `SessionCapacityError`.
- **Phase 3 — Session-scoped HTTP + WS routing (L, core).** Thread
  `params.sessionId` through `sessions.controller.ts` (404 for unknown id, kill
  the synthetic stub), `handleExitBrowserSession`, live-details, stream. Add
  scoped `/sessions/:sessionId/scrape|screenshot|pdf` (keep legacy un-scoped →
  current/default). Cast handler: use the parsed `:id`, `puppeteer.connect`
  directly to that session's `wsEndpoint` (new `getWsEndpoint()`). Generic
  `proxyWebSocket`: resolve target by `sessionId` before default. DevTools URL
  builder gains a `sessionId` arg; document nginx port-range change for external
  raw DevTools.
- **Phase 4 — Concurrency & resource controls (M).** `MAX_CONCURRENT_SESSIONS`
  → 429 + `Retry-After` at cap (no queue in v1). Per-Chrome memory flag
  (`CHROME_MAX_OLD_SPACE_MB`); sizing rule `cap = floor(podMem / perSessionRSS)`.
  Idle-timeout sweeper evicts past `session.timeout`/`SESSION_IDLE_TIMEOUT_MS`
  (no LRU eviction of active sessions). Crash/`onDisconnect` → evict + release
  port.
- **Phase 5 — Tests & docs (M).** Unit: PortAllocator, registry semantics, cap.
  Integration (real Chrome): distinct PIDs + ports per session; A→URL1 / B→URL2
  with no cross-talk in live-details; `endSession(A)` leaves B alive + frees A's
  port; cast streams the right session's pixels. Regression: single-session
  suite green with defaults. Docs: multi-session config + nginx note + sizing.

## Effort & upstreamability

Roughly **1 S + 3 M + 2 L** ≈ 3–4 weeks for one engineer.

**Fork-first.** Steel's model is one-session-per-container (they scale by
spawning containers), so the core "N Chromes per pod" posture is unlikely to be
accepted upstream. But two Phase-0 bits are clean standalone upstream PRs that
fix latent bugs regardless: **per-session `userDataDir`** (shared dir corrupts
under any concurrency) and **`--remote-debugging-port` from `env.CDP_REDIRECT_PORT`**
(the env already exists and is ignored). Keep the registry/fleet/routing work
fork-only and gate — never delete — the singleton paths so rebases stay tractable.

## Critical files
- `api/src/services/session.service.ts`
- `api/src/services/cdp/cdp.service.ts`
- `api/src/modules/sessions/sessions.controller.ts`
- `api/src/plugins/browser-socket/casting.handler.ts`
- `api/src/plugins/browser.ts` + `api/src/plugins/browser-session.ts` (wiring)
- new: `api/src/services/cdp/utils/port-allocator.ts`

## Pragmatic interim (no fork work)
For parallel live views today: scale `replicas` and give each steel pod its own
ingress host. Gets concurrency; just no single-viewer tiling.
