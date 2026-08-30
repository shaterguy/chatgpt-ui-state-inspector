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
  "confidence": 0.94,
  "source": "dom",
  "reason": "current turn has new visible assistant output",
  "updatedAt": "2026-08-30T06:40:05.300Z"
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
| `THINKING` | A canonical turn has started but no visible output for that turn has been rendered yet | Trusted composer submission or exact `POST /backend-api/f/conversation`; live thinking/working status as recovery |
| `ANSWERING` | New assistant output belonging to the current turn is visibly rendered and generation remains active | New assistant DOM root/count with visible text |
| `COMPLETE` | The active turn has actually finished | `message_stream_complete`, successful `end_turn`, or explicit DOM completion state |
| `ERROR` | Active turn ended with an observed generation/transport error | Protocol error or failed canonical conversation response |

`THINKING` is an externally observable pre-answer phase, not proof that the model's private internal reasoning process is running.

`message_marker` events such as `final_channel_token:first` and `user_visible_token:first` are recorded as a high-confidence indication that final output is about to become visible. They set `firstVisibleTokenAt`, but they do not by themselves transition the public phase to `ANSWERING`. The DOM must confirm that the current turn has new visible assistant output.

## 3. Turn-start correlation

Only an exact canonical generation request may act as a fetch-derived turn start:

```text
POST /backend-api/f/conversation
POST /backend-api/f/responses
```

Preparation or background requests such as the following are telemetry only and must not start a turn:

```text
POST /backend-api/f/conversation/prepare
```

The isolated content layer correlates `requestId` from transport metadata before accepting a fetch-derived `PROMPT_SUBMITTED` signal.

## 4. Completion correlation

`message_stream_complete` and a successful `end_turn` are protocol-level completion signals.

The raw SSE `[DONE]` sentinel is only a transport/substream boundary. It is deliberately not promoted to `COMPLETE`, because Work mode can close an individual SSE while the overall Work turn is still running.

DOM completion text such as `응답 완료` / `response complete` overrides stale stop-button or streaming-class evidence. This is required because Work mode can retain generic generation controls after the turn is visually complete.

## 5. Recorded event types

### 5.1 State events

- `turn_state_signal`: every normalized signal considered by the tracker
- `turn_state_transition`: an actual canonical phase change
- `protocol_state_signal`: sanitized protocol-derived signal before tracker correlation
- `dom_state_sample`: changed DOM fallback state

### 5.2 Protocol events

- `protocol_frame`: sanitized frame summary; no raw body or message text
- `protocol_transport`: request, response, complete, or error lifecycle metadata
- `probe_status`: MAIN probe ready/enabled state
- `probe_error`: bounded error name and inspection stage

### 5.3 Existing UI events

- `click`, `ui_snapshot`
- `dom_mutation_batch`, `ambient_mutation_batch`
- `navigation`
- `session_started`, `session_resumed`, `session_completed`

## 6. Signal precedence

1. Trusted composer submission or exact canonical conversation POST starts `THINKING`.
2. `final_channel_token:first` or `user_visible_token:first` records the impending visible-output boundary but remains `THINKING` until render confirmation.
3. New visible assistant output belonging to the current turn transitions to `ANSWERING`.
4. `message_stream_complete` or successful `status=finished_successfully` + `end_turn=true` transitions to `COMPLETE`.
5. Explicit DOM completion is the Work-compatible completion fallback.
6. SSE `[DONE]`, generic streaming classes, stale prior-turn text, and `/conversation/prepare` never independently change the canonical phase.

Every transition includes `confidence`, `source`, `reason`, timestamp, and turn sequence. Consumers should prefer the canonical `phase` rather than reimplementing raw-signal precedence.

## 7. Compatibility

This protocol is owned by the extension, not OpenAI. ChatGPT's private event names and DOM selectors can change without notice. A protocol version change is required when the extension's public phase names or exported event shape becomes incompatible. Signal-adapter corrections that make the existing phase semantics more faithful may be shipped within the same protocol version.
