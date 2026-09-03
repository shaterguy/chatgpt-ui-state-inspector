# ChatGPT UI State Inspector

`v0.2.0-dev3` combines two passive inspection functions in one Chrome side panel. It does not include Chat↔Work request switching.

## 1. Model / reasoning API request snapshots

The **API 요청 프로필 캡처** section recreates the Request Snapshot Calibrator workflow:

- Enter the Chat model list, Chat reasoning list, Work model list, and Work reasoning list visible in the current ChatGPT UI.
- Generate the minimum capture scenarios.
- Arm one scenario, set ChatGPT to the indicated model/reasoning combination, and send one short prompt.
- The extension reads that actual same-origin conversation POST immediately before transmission and stores only sanitized short control primitives and request-shape metadata.
- Exported JSON includes the scenario plan, captures, and baseline-relative `changed / added / removed` diffs.
- The request is never rewritten or resent by this feature.

Excluded from snapshots include prompt/message text, attachments, conversation/message/user/account/workspace identifiers, auth/cookies/tokens, URLs/emails, UUID-like values, and volatile screen/time context.

## 2. Turn-state and UI event recorder

The **대화 상태 연속 기록** section preserves the existing inspector:

- Canonical `IDLE`, `THINKING`, `ANSWERING`, `COMPLETE`, `ERROR` state transitions
- Structural UI and interaction events
- Sanitized transport/protocol structure for Chat and Work
- Local session storage and JSON / JSONL / CSV / Markdown export

The state recorder does not store prompt or answer bodies.

## Installation

1. Download and unzip the TEST artifact.
2. Open `chrome://extensions` and enable Developer mode.
3. Choose **Load unpacked** and select the unzipped extension directory.
4. Refresh existing ChatGPT tabs once after installation.
5. Click the extension toolbar icon to open the side panel.

## Development verification

The GitHub Actions gate performs JavaScript syntax checks, unit/integration contract tests, a real Chrome side-panel smoke test, package/privacy boundary validation, archive integrity checks, and upload of the unpacked TEST artifact.