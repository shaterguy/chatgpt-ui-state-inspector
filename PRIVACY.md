# Privacy

ChatGPT UI State Inspector is designed for local, developer-controlled inspection of ChatGPT UI/turn-state transitions and explicit same-conversation Chat/Work request switching.

## Collected locally by the recorder

- Trusted click timing, pointer location, and structural target descriptors
- Selected ARIA and `data-*` state attributes
- Candidate locators and limited control labels
- DOM child-list, selected attribute, and bounded character-data change counts
- Baseline, related, and final structural snapshots
- Canonical `IDLE`, `THINKING`, `ANSWERING`, `COMPLETE`, and `ERROR` transitions with timestamps, confidence, and signal source
- Sanitized transport metadata: event type, marker, status, role, content type, finish reason, boolean flags, key names, and byte length

## Deliberately excluded from persistence

- Input, textarea, and contenteditable values
- User prompts and chat message bodies
- Request and response bodies
- Header values, cookies, authentication tokens, and URL query or fragment values
- Conversation-link titles in navigation
- Full page HTML
- Binary frame contents
- Long free text and strings resembling email addresses, URLs, or telephone numbers

## Request switching

When the user explicitly arms Chat or Work switching, the MAIN-world probe may transiently parse the JSON body of the next matching `POST /backend-api/f/conversation` request in memory. This transient body is used only to verify the current conversation/source profile and to change the allowlisted control fields `model`, `thinking_effort`, `conversation_origin`, and `service_tier`.

The switcher restores the original `conversation_id` and full `messages` array after transformation. It does not persist the original or transformed body, does not inspect or copy authentication headers, and does not create a second network request. Source-profile mismatch, route mismatch, parse failure, or conversation-ID mismatch causes a fail-closed bypass or switch disable. A failed transformed request is never automatically resent.

## Transport observation

The MAIN-world probe delegates to ChatGPT's existing `fetch` and `WebSocket` implementations. It does not initiate an additional network request. For SSE and switch-completion monitoring, it observes cloned response streams; the page's original response remains untouched. Parsed response message text is reduced to bounded metadata/booleans and is never returned as raw text to extension storage.

## Processing and retention

All extension processing occurs inside the installed browser extension and ChatGPT tab. The extension contains no telemetry or external transmission endpoint. Recorder sessions remain in `chrome.storage.local` until the user deletes the session or removes the extension. Switch state is in-memory only and is not persisted as request content. Export files are created locally only when the user clicks **파일 저장**.

The public page variable `window.__CHATGPT_UI_STATE_INSPECTOR_STATE__` contains only the current normalized phase, timestamps, confidence, source, reason, and non-sensitive turn identifiers. It contains no prompt or answer text.
