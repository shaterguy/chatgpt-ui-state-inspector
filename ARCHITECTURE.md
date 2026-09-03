# Architecture

## Execution worlds

The extension uses two fixed `https://chatgpt.com/*` content-script worlds.

1. `MAIN`: `lib/request-snapshot-core.js` and `request-snapshot-probe.js` wrap the page's existing `fetch` and `XMLHttpRequest` send paths while automatic request-profile capture is enabled. They delegate every original call, inspect only the outgoing conversation request object immediately before delegation, and emit only a sanitized model/reasoning snapshot. `lib/protocol.js` and `page-probe.js` separately inspect turn-state transport signals. MAIN-world code cannot call `chrome.*`, persist data, or make a separate network request.
2. `ISOLATED`: `request-snapshot-content.js` reads the persistent capture-enabled flag from extension storage, synchronizes that flag to the MAIN probe, and forwards sanitized profile candidates to the service worker. `lib/core.js`, `lib/turn-state.js`, and `content.js` observe DOM state, validate and re-normalize the turn-state page bridge, maintain the canonical turn-state machine, and send bounded sanitized events to the service worker.

The turn-state bridge uses same-window `postMessage` events with a per-page routing token, a fixed channel, origin checks, and a maximum serialized message size. The routing token is not treated as a security secret: a capture-phase isolated-world guard stops every page-probe message, rebuilds it from a field allowlist, redacts dynamic path segments, replaces free-text reasons with canonical reason codes, and only then re-dispatches it to the recorder. Unknown message types, signal codes, fields, and free text are dropped.

The request-profile bridge is separate and one-way for captured profiles: MAIN emits only the sanitized snapshot/profile candidate; ISOLATED forwards it to the service worker. Capture enable/disable state is sent in the opposite direction from the isolated content script after it reads `chrome.storage.local`.

## Automatic request profile flow

1. The side panel enables automatic capture through the service worker. The enabled flag is persisted in `chrome.storage.local`.
2. Every ChatGPT isolated content script hydrates that flag at startup and listens for storage changes, so page reloads, side-panel closure, and browser restarts restore the configured capture state.
3. While enabled, each actual same-origin conversation POST caused by normal ChatGPT use is inspected immediately before the page's original `fetch` or `XMLHttpRequest.send` continues.
4. The MAIN probe builds a sanitized request snapshot, derives the current request model and reasoning control value, and emits that candidate without changing or resending the request.
5. The isolated content script forwards the candidate to the service worker.
6. The service worker validates and sanitizes the snapshot again, re-derives the model/reasoning pair from the sanitized data, and serializes all profile writes through one queue.
7. Before a new write, any legacy dev3 scenario captures are non-destructively migrated into the v2 profile set. Deduplication then uses the exact `model × reasoning` pair; an existing pair is skipped and a new pair is appended.
8. Unique profiles have no automatic count cap, truncation, or age-based deletion. They remain in local extension storage until the user explicitly clears request-profile data or removes the extension.
9. JSON export contains the complete accumulated v2 profile set and the preserved dev3 scenario-capture source data.

## Canonical turn state

`lib/turn-state.js` owns the stable state contract:

```text
IDLE → THINKING → ANSWERING → COMPLETE
                         ↘ ERROR
```

- A trusted composer submission, same-origin conversation POST, or active generation control begins `THINKING`.
- `message_marker:user_visible_token:first` is the strongest `ANSWERING` signal. Visible text in a newly active assistant turn is the DOM fallback.
- `message_stream_complete`, `finished_successfully + end_turn`, an explicit completion live-region state, or generation-control disappearance after output ends the turn.

The MAIN-world turn-state probe publishes the current normalized state through `window.__CHATGPT_UI_STATE_INSPECTOR_STATE__` and dispatches `chatgpt-ui-state-inspector:phasechange`. The state is computed in the isolated world; page code cannot write into extension storage or invoke privileged APIs through this interface.

## Turn-state event flow

1. The side panel creates one named session.
2. The isolated content script records a baseline and starts capture-phase click, submit, and MutationObserver listeners.
3. The MAIN turn-state probe reports candidate transport metadata and state signals.
4. The isolated bridge guard stops and allowlist-reissues the message.
5. The isolated tracker correlates sanitized protocol and DOM signals, emits `turn_state_signal` and `turn_state_transition`, and publishes the current public state.
6. Related mutations and delayed UI snapshots reference the originating click ID.
7. Event batches are sent to the extension service worker.
8. The service worker appends immutable storage chunks, updates session metadata, and persists the latest canonical turn state.
9. The side panel reads all chunks, sorts by sequence, and exports the complete session.

## Resilience

- The service worker is treated as ephemeral. Request-profile enable state, unique profiles, session metadata, and event chunks are persisted after bounded writes rather than held only in memory.
- Request-profile deduplication runs inside the same serialized service-worker write queue, preventing simultaneous ChatGPT tabs from appending the same model/reasoning pair twice.
- After a ChatGPT reload, the request-profile content script hydrates the persisted capture flag; the turn-state content script separately asks for any active recording session tied to its tab and hydrates the last persisted turn state.
- Transport buffers, frame counts, bridge messages, event batches, and stored text fields remain bounded. The number of unique request profiles is intentionally not automatically capped because the product requirement is durable accumulation; duplicate combinations are skipped.
- Both probes fail open: inspection errors never block the original ChatGPT request or response.
- Existing older content scripts are not overlaid with a second incompatible tracker; the side panel requires a tab refresh after extension update.

## Security and privacy boundary

- Fixed ChatGPT origin and no `host_permissions`
- No extension-originated network requests or telemetry
- No request rewrite, resend, or model/reasoning override
- No raw request body, response body, message text, headers, cookies, tokens, URL query, or fragment persistence
- Request-profile snapshots are sanitized in MAIN and validated/sanitized again in the service worker before persistence
- Protocol metadata allowlist: event type, marker, status, role, content type, finish reason, boolean flags, key names, and byte length
- Dynamic identifier-like URL path segments are replaced with `:id`
- Sender, tab ID, origin, message-size, message-type, signal-code, and field-level validation
- No input values, `innerHTML`, runtime code generation, remote scripts, or MAIN-world persistent storage
- Persistent request-profile retention is local-only and explicitly controlled: start/stop affects collection, and clear removes stored profile data