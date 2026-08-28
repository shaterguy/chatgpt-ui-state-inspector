# ChatGPT UI State Inspector

ChatGPT UI State Inspector는 데스크톱 Chrome의 ChatGPT UI에서 사용자가 수행한 **한 번의 전체 조작 흐름**을 시간순으로 기록하는 Manifest V3 확장프로그램입니다.

기록 제목을 `워크모드`처럼 입력하고 시작한 뒤 Chat/Work 전환, 모델 선택, 추론 수준 선택, 메뉴 재열기, 같은 항목 반복 클릭 등을 자유롭게 수행하세요. 확장프로그램은 클릭을 합치거나 항목별로 분리하지 않고 모두 기록합니다.

## 기록 내용

- 세션 시작 시 보이는 상호작용 요소의 구조적 기준 스냅샷
- 모든 신뢰된 사용자 클릭과 화면 내 좌표
- 대상 요소의 태그, 역할, ARIA 상태, `data-testid`, `data-state`, 안정적 클래스 토큰
- ID, 테스트 ID, ARIA 레이블, role+name, 구조 경로 등 후보 로케이터와 안정성 점수
- 클릭 직전 및 0ms/250ms/900ms 뒤의 관련 UI 스냅샷
- 클릭과 연결된 DOM attribute/childList 변경 묶음
- 클릭과 무관하게 발생한 비동기 DOM 변경 묶음
- 경로 이동 및 페이지 새로고침 후 자동 기록 재개
- JSON, JSONL, CSV, Markdown 전체 세션 내보내기

입력 필드 값, 대화 메시지 본문, 긴 자유 텍스트, 이메일·URL·전화번호로 보이는 문자열은 저장하지 않습니다. 외부 전송이나 원격 분석 기능도 없습니다.

## 설치

1. 배포 ZIP을 내려받아 압축을 풉니다.
2. Chrome에서 `chrome://extensions`를 엽니다.
3. **개발자 모드**를 켭니다.
4. **압축해제된 확장 프로그램을 로드합니다**를 누르고, `manifest.json`이 있는 폴더를 선택합니다.
5. `https://chatgpt.com` 탭을 열고 확장프로그램 아이콘을 누릅니다.

## 사용

1. 사이드 패널의 기록 제목에 `워크모드` 등 전체 흐름의 이름을 적습니다.
2. **기록 시작**을 누릅니다.
3. ChatGPT 화면에서 원하는 전환·선택·반복 조작을 처음부터 끝까지 수행합니다.
4. 사이드 패널에서 **기록 종료**를 누릅니다.
5. 저장된 세션에서 형식을 선택하고 **파일 저장**을 누릅니다.

AI 분석이나 자동화 코드 작성에는 전체 구조를 보존하는 JSON 또는 한 줄 단위 처리가 쉬운 JSONL을 권장합니다.

## 권한

| 권한/범위 | 목적 |
| --- | --- |
| `https://chatgpt.com/*` content script | ChatGPT 탭의 클릭과 구조적 DOM 상태 관찰 |
| `sidePanel` | 검사 화면과 분리된 기록 제어 UI |
| `storage` | 세션·이벤트를 로컬에 보존 |
| `unlimitedStorage` | 반복 조작이 많은 긴 세션의 저장 공간 확보 |

확장프로그램 코드는 `chatgpt.com` 외 호스트에 접근하지 않으며 네트워크 요청 API를 사용하지 않습니다.

## 개발 및 검증

```bash
node --test
node scripts/validate-package.mjs
```

GitHub Actions는 JavaScript 구문, 단위 테스트, Manifest/권한 경계, 패키지 구성과 금지된 네트워크 호출을 검증한 뒤 Chrome에서 압축 해제해 로드할 수 있는 아티팩트를 생성합니다.

## 제한

ChatGPT가 폐쇄형 Shadow DOM이나 iframe 내부로 선택 UI를 옮기면 해당 경계 안쪽의 DOM은 일반 content script로 관찰할 수 없습니다. 이 경우에도 바깥쪽 클릭과 접근 가능한 상태 변경은 기록됩니다.

## 라이선스

MIT
