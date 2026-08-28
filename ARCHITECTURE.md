# Architecture

## Recording boundary

The side panel owns recording controls and export. The content script only observes `https://chatgpt.com/*`; it does not inject controls or modify ChatGPT state.

## Event flow

1. The side panel creates one named session.
2. The content script records a baseline and starts capture-phase click and MutationObserver listeners.
3. Every trusted click receives a unique event ID and chronological sequence number.
4. Related mutations and delayed UI snapshots reference that click ID.
5. Mutations without a recent click become ambient mutation batches.
6. Event batches are sent to the extension service worker.
7. The service worker appends immutable storage chunks and updates session metadata.
8. The side panel reads all chunks, sorts by sequence, and exports the complete session.

## Resilience

The service worker is treated as ephemeral. Persistent state is stored after every small event batch. When a ChatGPT page reloads, the content script asks for the active session tied to its tab, continues from the last saved sequence, and records a resume event.

## Security boundary

- Fixed ChatGPT origin
- No cross-origin fetch
- Sender and tab ID validation for storage writes
- Bounded event batches
- No input values or message-body capture
- No `innerHTML` serialization
- No runtime code generation or remote scripts
