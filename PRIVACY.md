# Privacy

ChatGPT UI State Inspector is designed for local, developer-controlled inspection of ChatGPT request-control profiles and turn-state transitions.

## Request profile collection

Request-profile capture starts only after the user explicitly enables automatic capture. While enabled, the MAIN-world probe reads each actual ChatGPT conversation POST immediately before delegating to the page's original transport. It does not rewrite, resend, or create an additional request.

The snapshot keeps sanitized control primitives and request-shape metadata that can identify the current model/reasoning profile, such as short enum/string values, booleans, numbers, endpoint, transport, first/follow-up shape, and key paths. The first snapshot for each unique `model × reasoning` combination is retained; later requests with the same combination are skipped.

## Turn-state recorder collection

The continuous recorder stores trusted click timing, structural target descriptors, selected ARIA/data state attributes, bounded DOM mutation structure, canonical `IDLE`, `THINKING`, `ANSWERING`, `COMPLETE`, and `ERROR` transitions, and sanitized transport/protocol metadata.

## Deliberately excluded

Both collection paths exclude or discard:

- User prompt and chat message bodies
- Input, textarea, and contenteditable values from the state recorder
- Attachments and file contents
- Conversation, message, parent, request, user, account, and workspace identifier values
- Header values, cookies, authentication tokens, credentials, passwords, and session secrets
- URLs, email addresses, UUID-like values, long opaque strings, and volatile screen/time context
- Full page HTML and binary frame contents

The request-profile feature parses the conversation request only long enough to build the sanitized control-value snapshot; the raw request body is not persisted. Before persistence, the extension service worker validates the stored snapshot boundary again and derives the deduplication key from that sanitized snapshot.

## Processing and retention

All processing occurs inside the installed extension and ChatGPT tab. The extension contains no telemetry or external transmission endpoint.

The automatic-capture enabled flag and unique request profiles remain in `chrome.storage.local` across side-panel close, ChatGPT reload, and browser restart. Request profiles are not automatically capped, truncated, or aged out; they remain until the user explicitly clears them or removes the extension. Existing dev3 scenario captures in the same extension storage are preserved during migration and are included in export until the user explicitly clears request-profile data.

State-recording sessions remain in `chrome.storage.local` until the user deletes them or removes the extension. Export files are created locally only when the user explicitly copies or saves results.