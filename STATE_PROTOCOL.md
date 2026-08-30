# ChatGPT Turn State Protocol

## 1. Public contract

The page-level read-only contract is exposed after the probe is loaded:

```js
window.__CHATGPT_UI_STATE_INSPECTOR_STATE__
```

Example:

```json
{
  "protocolVersion": "1.1.0",
  "phase": "ANSWERING",
  "turnSequence": 3,
  "turnId": "turn-3",
  "generationActive": true,
  "sawVisibleAnswer": true,
  "startedAt": "2026-08-30T06:40:00.000Z",
  "firstVisibleTokenAt": "2026-08-30T06:40:05.200Z",
  "completedAt": null,
  "confidence": 0.99,
  "source": "protocol",
  "reason": "message_marker user_visible_token first",
  "updatedAt": "2026-08-30T06:40:05.201Z"
}
```

Available phases are also exposed as:

```js
window.__CHATGPT_UI_STATE_INSPECTOR_PHASES__
```

State changes dispatch:

```js
window.addEventListener("chatgpt-ui-state-inspector:phasechange", (event) => {
  console.log(event.detail);
});
```

## 2. Phase semantics

| Phase | Meaning | Primary evidence |
| --- | --- | --- |
| `IDLE` | No active generated turn | Initial/reset state |
| `THINKING` | Prompt submitted and no user-visible answer observed yet | Conversation POST, trusted submit, live generation control |
| `ANSWERING` | First user-visible answer signal has occurred and generation remains active | `user_visible_token:first`, visible new assistant output |
| `COMPLETE` | Active response stream or equivalent UI generation has ended | `message_stream_complete`, successful end-turn, completion DOM signal |
| `ERROR` | Active turn ended with an observed generation/transport error | Protocol error or failed conversation response |

`THINKING` is an externally observable pre-answer phase, not proof that the model's private internal reasoning process is running. `ANSWERING` begins at the first user-visible output boundary.

## 3. Recorded event types

### 3.1 State events

- `turn_state_signal`: every normalized signal considered by the tracker
- `turn_state_transition`: an actual canonical phase change
- `protocol_state_signal`: sanitized protocol-derived signal before tracker correlation
- `dom_state_sample`: changed DOM fallback state

### 3.2 Protocol events

- `protocol_frame`: sanitized frame summary; no raw body or message text
- `protocol_transport`: request, response, complete, or error lifecycle metadata
- `probe_status`: MAIN probe ready/enabled state
- `probe_error`: bounded error name and inspection stage

### 3.3 Existing UI events

- `click`, `ui_snapshot`
- `dom_mutation_batch`, `ambient_mutation_batch`
- `navigation`
- `session_started`, `session_resumed`, `session_completed`

## 4. Signal precedence

1. `FIRST_VISIBLE_TOKEN` from `message_marker / user_visible_token / first`
2. `STREAM_COMPLETE` from `message_stream_complete`
3. Successful message `status=finished_successfully` with `end_turn=true`
4. DOM live-region completion and generation-control transitions
5. Visible output in a new assistant turn

Every transition includes `confidence`, `source`, `reason`, timestamp, and turn sequence. Consumers should prefer the canonical `phase` rather than reimplementing raw-signal precedence.

## 5. Compatibility

This protocol is owned by the extension, not OpenAI. ChatGPT's private event names and DOM selectors can change without notice. A protocol version change is required when the extension's public phase semantics or exported event shape becomes incompatible. Additional raw-signal adapters that preserve the public semantics may be added without changing the public phase names.
