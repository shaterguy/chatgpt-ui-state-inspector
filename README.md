# ChatGPT UI State Inspector

`v0.2.0-dev1`은 기존 UI/턴 상태 Inspector와 Chat ↔ Work Switcher를 하나의 Manifest V3 확장프로그램으로 통합한 TEST 버전입니다.

## 통합 기능

### Chat ↔ Work 전환

사이드 패널 상단에서 현재 `/c/<conversation_id>` 대화의 다음 전송부터 Chat 또는 Work 요청 프로필을 선택할 수 있습니다.

- Chat 기본값: `gpt-5-6-thinking` / `max`
- Work 기본값: `gpt-5.6-luna-wm` / `standard`
- 모델·추론 수준은 사이드 패널에서 직접 바꿀 수 있습니다.
- 전환 응답 완료 후 같은 대화를 자동 새로고침하는 옵션을 제공합니다.
- 전환을 해제하면 원래 ChatGPT 요청을 그대로 보냅니다.

전환기는 기존 Chat ↔ Work Switcher의 same-conversation 안전 계약을 유지합니다.

- 활성 URL의 `conversation_id`와 요청 본문의 `conversation_id`가 다르면 전환을 해제합니다.
- 전환 대상은 `POST /backend-api/f/conversation`의 실제 메시지 전송 요청으로 제한합니다.
- `conversation_id`와 전체 `messages` 배열은 변환 전 값을 복원합니다.
- 변경 가능한 필드는 `model`, `thinking_effort`, `conversation_origin`, `service_tier`만 허용합니다.
- 예상 source profile과 다르면 요청을 수정하지 않습니다.
- 네트워크/HTTP 실패 시 전환을 해제하며 실패한 요청을 자동 재전송하지 않습니다.

## 상태 기록

기존 Inspector 기능은 그대로 유지됩니다.

- `IDLE`
- `THINKING`
- `ANSWERING`
- `COMPLETE`
- `ERROR`

기록 세션에는 클릭·DOM 구조 변화, sanitized 프로토콜 메타데이터, canonical turn state가 시간순으로 저장됩니다. JSON, JSONL, CSV, Markdown으로 내보낼 수 있습니다.

페이지 콘솔에서 현재 상태를 읽는 기존 인터페이스도 유지됩니다.

```js
window.__CHATGPT_UI_STATE_INSPECTOR_STATE__.phase
```

## 단일 네트워크 훅

두 기존 확장프로그램을 단순히 동시에 주입하지 않습니다. MAIN world의 기존 `page-probe.js` 하나가 ChatGPT의 원래 `fetch`를 한 번만 감싸며 다음 두 역할을 함께 수행합니다.

1. 기존 turn-state/프로토콜 관찰
2. 사용자가 전환을 명시적으로 활성화한 경우에만 allowlist 제어 필드 변환

응답 기록과 전환 완료 감시는 모두 `response.clone()`을 사용하며 페이지가 받는 원본 응답 스트림을 소비하지 않습니다.

## 개인정보·보안 경계

- 입력 필드 값, 프롬프트, 대화 메시지 본문, 헤더, 쿠키, 인증정보를 저장하지 않습니다.
- 전환 시 요청 JSON은 전송 직전에 메모리에서만 파싱하며 원문이나 변환본을 `chrome.storage`에 기록하지 않습니다.
- 확장프로그램 자체의 외부 네트워크 요청·텔레메트리는 없습니다.
- `host_permissions`를 추가하지 않았습니다.
- 기존 권한 `activeTab`, `scripting`, `storage`, `unlimitedStorage`, `sidePanel`만 사용합니다.
- MAIN world에는 `chrome.*` 또는 영구 브라우저 저장소 접근이 없습니다.

## 아이콘

`manifest.json`은 16/32/48/128 PNG 아이콘을 `icons`와 `action.default_icon`에 연결합니다. PNG는 `scripts/generate-icons.mjs`가 외부 이미지나 신규 의존성 없이 결정론적으로 생성하며, GitHub Actions가 테스트와 패키징 전에 생성·크기 검증·아카이브 포함 여부까지 확인합니다. service worker는 같은 청록색 ↔ 디자인을 `action.setIcon({imageData})`와 `OffscreenCanvas`로 다시 적용해 툴바 아이콘도 일관되게 유지합니다.

## 설치

1. GitHub Actions의 `v0.2.0-dev1` TEST artifact를 받습니다.
2. artifact 안의 `extension/` 디렉터리를 꺼냅니다.
3. Chrome에서 `chrome://extensions`를 엽니다.
4. 개발자 모드를 켭니다.
5. **압축해제된 확장 프로그램을 로드합니다**에서 `manifest.json`이 있는 `extension/` 폴더를 선택합니다.
6. 기존에 열려 있던 `https://chatgpt.com` 탭은 한 번 새로고침합니다.
7. 확장 아이콘을 누르면 사이드 패널이 열립니다.

## 사용

### Chat/Work 전환

1. 기존 `/c/...` 대화를 엽니다.
2. 사이드 패널에서 대상 모드의 모델·추론 수준을 확인합니다.
3. **Chat로 전환** 또는 **Work로 전환**을 누릅니다.
4. 같은 대화에서 메시지를 전송합니다.
5. 사이드 패널 상태가 `요청 전환 적용됨` → `전환 응답 완료`로 진행되는지 확인합니다.

실제 ChatGPT 서버의 내부 프로필 규약이 변경되어 source profile이 맞지 않으면 확장프로그램은 fail-closed로 원래 요청을 그대로 유지합니다.

### 기록

1. 기록 제목을 입력합니다.
2. **기록 시작**을 누릅니다.
3. ChatGPT를 사용합니다.
4. **기록 종료** 후 저장된 세션을 원하는 형식으로 내보냅니다.

## 개발 및 검증

```bash
node scripts/generate-icons.mjs
node --test
node scripts/validate-package.mjs
```

GitHub Actions는 `v*-dev*` push에서 JavaScript 구문, 아이콘 생성, 단위/계약 테스트, 패키지 보안 경계, loadable archive 구조와 PNG 포함 여부를 검증하고 unpacked `extension/` 디렉터리를 TEST artifact로 업로드합니다.

## 알려진 검증 공백

자동 테스트는 요청 변환 규칙, 비회귀 조건과 패키지 구조를 검증합니다. 실제 계정에서 Chat → Work → Chat이 서버에서 목표 모드로 실행되는지 여부는 ChatGPT 비공개 서버 규약에 의존하므로 설치 후 사후 실브라우저 확인 항목입니다.

## 라이선스

MIT
