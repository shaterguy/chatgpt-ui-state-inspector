# Privacy

ChatGPT UI State Inspector is designed for local, developer-controlled inspection of ChatGPT request-control profiles and turn-state transitions.

## Request snapshot collection

A request snapshot is captured only after the user explicitly arms a model/reasoning scenario and sends an actual ChatGPT conversation POST. The MAIN-world probe reads the request object immediately before delegating to the page's original transport. It does not rewrite, resend, or create an additional request.

The snapshot keeps bounded, sanitized control primitives and request-shape metadata that can distinguish model/reasoning profiles, such as short enum/string values, booleans, numbers, endpoint, transport, first/follow-up shape, and key paths.

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

The request snapshot feature parses the conversation request only long enough to build the sanitized control-value snapshot; the raw request body is not persisted.

## Processing and retention

All processing occurs inside the installed extension and ChatGPT tab. The extension contains no telemetry or external transmission endpoint. Captures and state-recording sessions remain in `chrome.storage.local` until the user resets/deletes them or removes the extension. Export files are created locally only when the user explicitly copies or saves results.