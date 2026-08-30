# Privacy

ChatGPT UI State Inspector is designed for local, developer-controlled inspection of ChatGPT UI and turn-state transitions.

## Collected locally

- Trusted click timing, pointer location, and structural target descriptors
- Selected ARIA and `data-*` state attributes
- Candidate locators and limited control labels
- DOM child-list, selected attribute, and bounded character-data change counts
- Baseline, related, and final structural snapshots
- Canonical `IDLE`, `THINKING`, `ANSWERING`, `COMPLETE`, and `ERROR` transitions with timestamps, confidence, and signal source
- Sanitized transport metadata: event type, marker, status, role, content type, finish reason, boolean flags, key names, and byte length

## Deliberately excluded

- Input, textarea, and contenteditable values
- User prompts and chat message bodies
- Request and response bodies
- Header values, cookies, authentication tokens, and URL query or fragment values
- Conversation-link titles in navigation
- Full page HTML
- Binary frame contents
- Long free text and strings resembling email addresses, URLs, or telephone numbers

## Transport observation

The MAIN-world probe delegates to ChatGPT's existing `fetch` and `WebSocket` implementations. It does not initiate an additional network request. For SSE, it observes a cloned response stream; the page's original response remains untouched. Parsed message text is reduced to booleans such as `assistantVisibleText`, and the text itself is never returned to the isolated content script or stored.

## Processing and retention

All extension processing occurs inside the installed browser extension and ChatGPT tab. The extension contains no telemetry or external transmission endpoint. Sessions remain in `chrome.storage.local` until the user deletes the session or removes the extension. Export files are created locally only when the user clicks **파일 저장**.

The public page variable `window.__CHATGPT_UI_STATE_INSPECTOR_STATE__` contains only the current normalized phase, timestamps, confidence, source, reason, and non-sensitive turn identifiers. It contains no prompt or answer text.
