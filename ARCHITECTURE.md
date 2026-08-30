# Architecture

## Execution worlds

The extension uses two fixed `https://chatgpt.com/*` content-script worlds.

1. `MAIN`: `lib/protocol.js` and `page-probe.js` wrap the page's existing `fetch` and `WebSocket` constructors, delegate every original call, and inspect only cloned or copied response data. The probe cannot call `chrome.*`, persist data, or make a separate network request.
2. `ISOLATED`: `lib/core.js`, `lib/turn-state.js`, and `content.js` observe DOM state, validate the bridge, maintain the canonical turn-state machine, and send bounded sanitized events to the service worker.

The bridge uses same-window `postMessage` events with a per-page random token, a fixed channel, origin checks, direction checks, and a maximum serialized message size.

## Canonical turn state

`lib/turn-state.js` owns the stable state contract:

```text
IDLE → THINKING → ANSWERING → COMPLETE
                         ↘ ERROR
```

- A trusted composer submission, same-origin conversation POST, or active generation control begins `THINKING`.
- `message_marker:user_visible_token:first` is the strongest `ANSWERING` signal. Visible text in a newly active assistant turn is the DOM fallback.
- `message_stream_complete`, `finished_successfully + end_turn`, an explicit completion live-region state, or generation-control disappearance after output ends the turn.

The MAIN-world probe publishes the current normalized state through `window.__CHATGPT_UI_STATE_INSPECTOR_STATE__` and dispatches `chatgpt-ui-state-inspector:phasechange`. The state is computed in the isolated world; page code cannot write into extension storage or invoke privileged APIs through this interface.

## Event flow

1. The side panel creates one named session.
2. The isolated content script records a baseline and starts capture-phase click, submit, and MutationObserver listeners.
3. The MAIN probe reports sanitized transport metadata and candidate state signals.
4. The isolated tracker correlates protocol and DOM signals, emits `turn_state_signal` and `turn_state_transition`, and publishes the current public state.
5. Related mutations and delayed UI snapshots reference the originating click ID.
6. Event batches are sent to the extension service worker.
7. The service worker appends immutable storage chunks, updates session metadata, and persists the latest canonical turn state.
8. The side panel reads all chunks, sorts by sequence, and exports the complete session.

## Resilience

- The service worker is treated as ephemeral; persistent state is written after every small event batch.
- After a ChatGPT reload, the content script asks for the active session tied to its tab and hydrates the last persisted turn state.
- Transport buffers, frame counts, bridge messages, event batches, and stored text fields are bounded.
- The probe fails open: inspection errors are logged as sanitized probe events and never block the original ChatGPT request or response.
- Existing older content scripts are not overlaid with a second incompatible tracker; the side panel requires a tab refresh.

## Security and privacy boundary

- Fixed ChatGPT origin and no `host_permissions`
- No extension-originated network requests or telemetry
- No request body, response body, message text, headers, cookies, tokens, URL query, or fragment persistence
- Protocol metadata allowlist: event type, marker, status, role, content type, finish reason, boolean flags, key names, and byte length
- Sender, tab ID, bridge token, origin, and message-size validation
- No input values, `innerHTML`, runtime code generation, remote scripts, or MAIN-world persistent storage
- Bounded event batches and stream parsers
