# ChatGPT UI State Inspector

ChatGPT UI State Inspector는 데스크톱 Chrome의 ChatGPT UI에서 한 번의 전체 조작 흐름과 대화 턴의 상태 전이를 시간순으로 기록하는 Manifest V3 확장프로그램입니다.

기록 제목을 입력하고 시작한 뒤 Chat/Work 전환, 모델 선택, 추론 수준 선택, 프롬프트 전송 등을 수행하면 클릭·DOM 변화와 함께 다음 canonical 상태가 기록됩니다.

- `IDLE`: 생성 중인 턴이 없음
- `THINKING`: 프롬프트 전송 후 첫 사용자 표시 답변이 나오기 전
- `ANSWERING`: 첫 사용자 표시 답변이 나온 뒤 스트리밍이 끝나기 전
- `COMPLETE`: 응답 스트림 또는 동등한 DOM 완료 신호가 끝남
- `ERROR`: 활성 턴의 전송·생성 오류

## 상태 접근 인터페이스

기록기가 연결된 ChatGPT 탭의 페이지 콘솔에서 현재 상태를 바로 읽을 수 있습니다.

```js
window.__CHATGPT_UI_STATE_INSPECTOR_STATE__.phase
```

전체 상태 스냅샷:

```js
window.__CHATGPT_UI_STATE_INSPECTOR_STATE__
```

상태 전이 이벤트:

```js
window.addEventListener("chatgpt-ui-state-inspector:phasechange", (event) => {
  console.log(event.detail.phase, event.detail);
});
```

이 인터페이스는 확장 자체의 canonical 상태입니다. ChatGPT의 비공개 minified 변수명을 외부 계약으로 노출하지 않습니다.

## 판정 신호

상태 판정은 하나의 DOM 선택자에 의존하지 않고 다음 신호를 우선순위와 신뢰도로 결합합니다.

1. ChatGPT가 이미 수행하는 `fetch` SSE와 WebSocket 이벤트의 정규화된 메타데이터
2. `message_marker / user_visible_token / first`, `message_stream_complete`, `finished_successfully + end_turn` 같은 프로토콜 패턴
3. `role=status` live region, 생성 중지 버튼, 새 assistant turn, 완료 action과 같은 DOM fallback

MAIN-world probe는 기존 `fetch`와 `WebSocket`을 그대로 호출하며 응답 복제본만 관찰합니다. 확장프로그램이 새 네트워크 요청을 만들거나 원래 스트림을 소비하지 않습니다.

## 기록 내용

- 세션 시작 시 보이는 상호작용 요소의 구조적 기준 스냅샷
- 모든 신뢰된 사용자 클릭과 화면 내 좌표
- 대상 요소의 태그, 역할, ARIA 상태, `data-testid`, `data-state`, 안정적 클래스 토큰
- 클릭 직전 및 0ms/250ms/900ms 뒤의 관련 UI 스냅샷
- 클릭과 연결된 DOM attribute/childList 변경 묶음
- 클릭과 무관하게 발생한 비동기 DOM 변경 묶음
- `IDLE → THINKING → ANSWERING → COMPLETE` 상태 전이와 신뢰도·근거 신호
- 프로토콜 이벤트의 종류·상태·marker·역할·키 목록·바이트 길이
- 경로 이동 및 페이지 새로고침 후 자동 기록 재개
- JSON, JSONL, CSV, Markdown 전체 세션 내보내기

입력 필드 값, 프롬프트, 대화 메시지 본문, 요청·응답 본문, 헤더, 쿠키, 인증정보, 긴 자유 텍스트는 저장하지 않습니다. 외부 전송이나 원격 분석 기능도 없습니다.

## 설치

1. GitHub Actions의 테스트 아티팩트를 내려받아 압축을 풉니다.
2. Chrome에서 `chrome://extensions`를 엽니다.
3. **개발자 모드**를 켭니다.
4. **압축해제된 확장 프로그램을 로드합니다**를 누르고 `manifest.json`이 있는 폴더를 선택합니다.
5. `https://chatgpt.com` 탭을 새로 열거나 새로고침한 뒤 확장프로그램 아이콘을 누릅니다.

이전 버전 content script가 이미 연결된 탭에서는 안전하게 중복 주입하지 않고 새로고침을 요구합니다.

## 사용

1. 사이드 패널의 기록 제목을 입력합니다.
2. **기록 시작**을 누릅니다.
3. ChatGPT에서 프롬프트를 전송하고 대화 상태 전이를 관찰합니다.
4. 사이드 패널의 canonical 상태와 최근 전이 이벤트를 확인합니다.
5. **기록 종료** 후 JSON 또는 JSONL로 저장합니다.

AI 분석이나 자동화 코드 작성에는 전체 구조를 보존하는 JSON 또는 한 줄 단위 처리가 쉬운 JSONL을 권장합니다.

## 권한과 실행 경계

| 권한/범위 | 목적 |
| --- | --- |
| `https://chatgpt.com/*` MAIN content script | 기존 ChatGPT 전송의 정규화된 상태 메타데이터 관찰 |
| `https://chatgpt.com/*` ISOLATED content script | DOM 상태 판정, 이벤트 저장과 확장 메시지 처리 |
| `sidePanel` | 검사 화면과 분리된 기록 제어 UI |
| `activeTab` | 사용자가 확장프로그램을 연 현재 탭에만 임시 접근 |
| `scripting` | 설치 전에 열려 있던 ChatGPT 탭에 두 실행 world를 연결 |
| `storage` | 세션·이벤트를 로컬에 보존 |
| `unlimitedStorage` | 반복 조작이 많은 긴 세션의 저장 공간 확보 |

`host_permissions`는 요청하지 않습니다. MAIN-world probe에는 `chrome.*` API, 영구 저장소 접근, 외부 송신 기능이 없습니다.

## 개발 및 검증

```bash
node --test
node scripts/validate-package.mjs
```

GitHub Actions는 다음 항목을 검증합니다.

- JavaScript 구문과 상태 머신·프로토콜 parser 단위 테스트
- Manifest의 고정 `chatgpt.com` 범위와 MAIN/ISOLATED 분리
- MAIN probe의 확장 API·영구 저장소·원문 소비 금지
- 대화 본문·요청 본문이 정규화 메타데이터에 포함되지 않는지 검증
- 압축 해제 후 Chrome에서 바로 로드 가능한 패키지 구조

## 제한

- `THINKING → ANSWERING`은 모델 내부 추론 종료 자체가 아니라 첫 사용자 표시 답변 신호를 기준으로 합니다.
- ChatGPT가 비공개 전송 형식이나 DOM 구조를 변경하면 일부 프로토콜 신호가 사라질 수 있으며, 이때 DOM fallback과 신뢰도 값으로 판정합니다.
- 폐쇄형 Shadow DOM이나 iframe 안쪽은 일반 content script가 직접 관찰할 수 없습니다.
- 실제 계정의 Instant·Thinking·도구 호출 모드별 신호 재현은 설치 후 사용자 환경에서 사후 확인해야 합니다.

세부 이벤트 계약은 [STATE_PROTOCOL.md](STATE_PROTOCOL.md)를 참조하십시오.

## 라이선스

MIT
