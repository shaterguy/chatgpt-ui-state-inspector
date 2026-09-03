# Architecture

## Execution worlds

The integrated extension uses two fixed `https://chatgpt.com/*` content-script worlds.

1. `MAIN`: protocol parsers, `lib/chat-work-switch-core.js`, and `page-probe.js`. The page probe owns the single wrapper around ChatGPT's existing `fetch` and `WebSocket`. It observes cloned response data and, only when explicitly armed, transforms an allowlisted set of request control fields before delegating the original request once.
2. `ISOLATED`: recorder modules plus `switch-controller.js`. The recorder observes DOM state and persists sanitized events. The switch controller accepts extension-side panel commands, validates bounded model/reasoning values, and forwards only switch configuration/status across a dedicated same-window bridge.

The recorder and switch controller do not create their own network requests.

## Chat/Work switching boundary

`lib/chat-work-switch-core.js` owns the deterministic request-profile transformation contract. Its writable paths are limited to:

- `model`
- `thinking_effort`
- `conversation_origin`
- `service_tier`

The page probe applies a switch only when all of the following hold:

1. The current route contains an existing `/c/<conversation_id>`.
2. The request is same-origin `POST /backend-api/f/conversation`.
3. The request contains a `messages` array.
4. A body `conversation_id`, when present, matches the route conversation ID.
5. The request matches the expected source-mode discriminator.

After applying the allowlisted operations, the original `conversation_id` and full `messages` array are restored. Source mismatch is a bypass, while route/conversation mismatch disables the switch. Network/HTTP failure disables switching and is never followed by an automatic resend.

## Canonical turn state

`lib/turn-state.js` continues to own the stable state contract:

```text
IDLE → THINKING → ANSWERING → COMPLETE
                         ↘ ERROR
```

The existing recorder flow and storage schema are unchanged. Switching is orthogonal to whether recording is active.

## Event flow

### Recorder

1. The side panel creates one named session.
2. The isolated recorder starts DOM/click observation and the recorder bridge.
3. MAIN reports sanitized transport/protocol state signals.
4. ISOLATED validates/re-normalizes those signals and advances the canonical tracker.
5. Event batches are written to the service worker and stored in bounded chunks.
6. The side panel exports JSON/JSONL/CSV/Markdown on demand.

### Switcher

1. The side panel sends a bounded `SET_CHAT_WORK_SWITCH` message to the active ChatGPT tab.
2. `switch-controller.js` validates mode/model/reasoning and forwards the config to MAIN.
3. `page-probe.js` arms an in-memory switch for the current conversation ID.
4. The existing single `fetch` wrapper parses only a matching JSON message request and delegates either the original or one transformed request.
5. A cloned successful response stream is drained only to detect completion; optional same-route reload occurs after completion.
6. Switch status is returned to the side panel. No request body is persisted.

## Toolbar icon

The service worker creates the extension action icon locally with `OffscreenCanvas` and passes 16/32/48/128 `ImageData` variants to `chrome.action.setIcon()`. No external image asset or network fetch is required.

## Resilience

- Recorder storage remains independent from switch state.
- Existing content-script/version handshake behavior is retained.
- Switch state is in-memory and resets naturally on page reload.
- MAIN transformation fails closed on invalid/mismatched requests while recorder observation remains fail-open.
- No duplicate fetch wrapper is introduced by the switcher.
- Network failures do not trigger resend/retry.

## Security and privacy boundary

- Fixed ChatGPT content-script origin and no `host_permissions`
- No extension-originated network requests or telemetry
- No request/response body persistence
- No prompt/message/authentication-header persistence
- Allowlisted switch paths only, with bounded primitive model/reasoning inputs
- Original `conversation_id` and `messages` preservation after transform
- Separate isolated switch controller with extension-sender validation
- MAIN world has no `chrome.*` or persistent storage access
- No runtime code generation or remote scripts
