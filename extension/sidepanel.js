"use strict";

const titleInput = document.querySelector("#session-title");
const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const statusNode = document.querySelector("#live-status");
const phasePanel = document.querySelector("#turn-phase");
const phaseCode = document.querySelector("#phase-code");
const phaseMeta = document.querySelector("#phase-meta");
const recentNode = document.querySelector("#recent-events");
const sessionsNode = document.querySelector("#sessions");
const refreshButton = document.querySelector("#refresh");
const template = document.querySelector("#session-template");
let currentTabId = null;
let preparationActive = false;
let statusHoldUntil = 0;
const CHATGPT_ORIGIN = "https://chatgpt.com";
const CHATGPT_TAB_ERROR = "활성 탭이 https://chatgpt.com인지 확인해 주세요.";
const EXPECTED_PROTOCOL_VERSION = "1.1.0";
const EXPECTED_CARRIER_BUILD = "0.1.3-dev7";
const SCRIPT_CALL_TIMEOUT_MS = 1200;
const CARRIER_WAIT_MS = 8000;
const CARRIER_POLL_MS = 180;
const PHASE_LABELS = Object.freeze({
  IDLE: "대기",
  THINKING: "추론 중",
  ANSWERING: "답변 작성 중",
  COMPLETE: "답변 완료",
  ERROR: "오류"
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function activeChatGptTab() {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (!Number.isInteger(tab?.id)) throw new Error(CHATGPT_TAB_ERROR);
  currentTabId = tab.id;
  return tab;
}

async function probeRecorder(tabId) {
  try {
    const response = await withTimeout(
      chrome.tabs.sendMessage(tabId, {type: "GET_RECORDING_STATUS"}),
      SCRIPT_CALL_TIMEOUT_MS,
      "상태 기록기 응답 시간이 초과되었습니다."
    );
    return response?.ok ? response : null;
  } catch {
    return null;
  }
}

async function mainWorldSnapshot(tabId) {
  try {
    const result = await withTimeout(
      chrome.scripting.executeScript({
        target: {tabId},
        world: "MAIN",
        func: () => ({
          origin: location.origin,
          carrier: globalThis.__CHATGPT_UI_STATE_INSPECTOR_STRUCTURE_CARRIER__ || null,
          parserBuildId: (() => {
            try {
              return globalThis.UiStateInspectorProtocol?.summarizePayload?.({})?.buildId || null;
            } catch {
              return null;
            }
          })()
        })
      }),
      SCRIPT_CALL_TIMEOUT_MS,
      "ChatGPT 페이지 계측기 확인 시간이 초과되었습니다."
    );
    return result?.[0]?.result || null;
  } catch {
    return null;
  }
}

async function waitForCarrier(tabId) {
  const deadline = Date.now() + CARRIER_WAIT_MS;
  while (Date.now() < deadline) {
    const state = await mainWorldSnapshot(tabId);
    if (state?.origin === CHATGPT_ORIGIN && state.carrier === EXPECTED_CARRIER_BUILD) return true;
    await delay(CARRIER_POLL_MS);
  }
  return false;
}

async function ensureCarrierReady(tabId) {
  const current = await mainWorldSnapshot(tabId);
  if (!current) throw new Error(CHATGPT_TAB_ERROR);
  if (current.origin !== CHATGPT_ORIGIN) throw new Error(CHATGPT_TAB_ERROR);
  if (current.carrier === EXPECTED_CARRIER_BUILD) return current;

  setStatus("최신 Work 계측기를 적용하기 위해 ChatGPT 탭을 한 번 새로고침합니다.");
  await withTimeout(
    chrome.tabs.reload(tabId),
    2000,
    "ChatGPT 탭 새로고침 요청 시간이 초과되었습니다."
  );
  const ready = await waitForCarrier(tabId);
  if (!ready) {
    throw new Error("Work 계측기 연결 확인에 실패했습니다. ChatGPT 탭을 직접 새로고침한 뒤 기록 시작을 다시 눌러 주세요.");
  }
  return mainWorldSnapshot(tabId);
}

async function ensureContentScript(tabId) {
  await ensureCarrierReady(tabId);

  const existing = await probeRecorder(tabId);
  if (existing?.result?.protocolVersion === EXPECTED_PROTOCOL_VERSION) return existing;
  if (existing) {
    throw new Error("이 탭에는 이전 버전 기록기가 연결되어 있습니다. ChatGPT 탭을 새로고침한 뒤 다시 시작해 주세요.");
  }

  await chrome.scripting.executeScript({
    target: {tabId},
    files: ["lib/protocol.js", "lib/protocol-structure-carrier.js", "page-probe.js"],
    world: "MAIN"
  });
  await chrome.scripting.executeScript({
    target: {tabId},
    files: ["lib/core.js", "lib/turn-state.js", "content.js"],
    world: "ISOLATED"
  });

  const injected = await probeRecorder(tabId);
  if (!injected || injected.result?.protocolVersion !== EXPECTED_PROTOCOL_VERSION) {
    throw new Error("ChatGPT 탭에 상태 기록기를 연결하지 못했습니다. 탭을 새로고침한 뒤 다시 시도해 주세요.");
  }
  return injected;
}

async function sendToActiveTab(message) {
  const tab = await activeChatGptTab();
  return chrome.tabs.sendMessage(tab.id, message);
}

function setStatus(message, kind = "normal", holdMs = 0) {
  statusNode.textContent = message;
  statusNode.dataset.kind = kind;
  if (holdMs > 0) statusHoldUntil = Date.now() + holdMs;
}

function renderTurnState(state, probe) {
  const phase = PHASE_LABELS[state?.phase] ? state.phase : "IDLE";
  const label = PHASE_LABELS[phase];
  phasePanel.dataset.phase = phase;
  phaseCode.textContent = `${phase} · ${label}`;
  const source = state?.source || "-";
  const confidence = Number.isFinite(Number(state?.confidence))
    ? `${Math.round(Number(state.confidence) * 100)}%`
    : "-";
  const transport = probe?.ready
    ? Object.entries(probe.transports || {}).filter(([, value]) => value).map(([key]) => key).join("+") || "DOM"
    : "연결 대기";
  const frameCount = Number(probe?.protocolFrameCount) || 0;
  phaseMeta.textContent = `source=${source} · confidence=${confidence} · probe=${transport} · frames=${frameCount}`;
}

function formatDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "short", timeStyle: "medium"
  }).format(new Date(value));
}

function safeFilename(value) {
  return String(value || "session")
    .normalize("NFKC")
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "-")
    .replace(/\s+/g, "_")
    .slice(0, 60) || "session";
}

function csvCell(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return '"' + text.replace(/"/g, '""') + '"';
}

function targetSummary(event) {
  const target = event.target || event.snapshot?.activeElement || null;
  if (!target) return "";
  return target.accessibleName || target.text || target.attributes?.["data-testid"] ||
    [target.tag, target.role].filter(Boolean).join("/");
}

function serialize(session, format) {
  const payload = {
    schema: "chatgpt-ui-state-inspector/session@1.1.0",
    exportedAt: new Date().toISOString(),
    meta: session.meta,
    events: session.events
  };
  if (format === "json") return JSON.stringify(payload, null, 2);
  if (format === "jsonl") {
    return [
      JSON.stringify({recordType: "session", ...payload.meta, exportedAt: payload.exportedAt}),
      ...payload.events.map((event) => JSON.stringify({recordType: "event", ...event}))
    ].join("\n") + "\n";
  }
  if (format === "csv") {
    const rows = [["seq", "timestamp", "type", "event_id", "caused_by_click_id", "target_summary", "event_json"]];
    for (const event of payload.events) {
      rows.push([
        event.seq, event.timestamp, event.type, event.eventId,
        event.causedByClickId || "", targetSummary(event), event
      ]);
    }
    return rows.map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
  }
  const lines = [
    "# ChatGPT UI State Inspector session",
    "",
    `- Title: ${payload.meta.title}`,
    `- Session ID: ${payload.meta.id}`,
    `- Protocol: ${payload.meta.protocolVersion || "1.0.0"}`,
    `- Started: ${payload.meta.startedAt}`,
    `- Completed: ${payload.meta.completedAt || "recording"}`,
    `- Last turn phase: ${payload.meta.lastTurnState?.phase || "IDLE"}`,
    `- Events: ${payload.events.length}`,
    `- Exported: ${payload.exportedAt}`,
    "",
    "| Seq | Timestamp | Type | Caused by | Target | Full event JSON |",
    "| ---: | --- | --- | --- | --- | --- |"
  ];
  for (const event of payload.events) {
    const json = JSON.stringify(event).replace(/\|/g, "\\|");
    lines.push(`| ${event.seq} | ${event.timestamp} | ${event.type} | ${event.causedByClickId || ""} | ${targetSummary(event).replace(/\|/g, "\\|")} | \`${json.replace(/\`/g, "\\\`")}\` |`);
  }
  return lines.join("\n") + "\n";
}

function downloadText(filename, content, type) {
  const blob = new Blob([content], {type});
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportSession(id, format, button) {
  button.disabled = true;
  try {
    const response = await chrome.runtime.sendMessage({type: "GET_SESSION", sessionId: id});
    if (!response?.ok) throw new Error(response?.error || "세션을 읽지 못했습니다.");
    const session = response.result;
    const mime = {
      json: "application/json", jsonl: "application/x-ndjson",
      csv: "text/csv", md: "text/markdown"
    }[format];
    downloadText(
      `${safeFilename(session.meta.title)}_${session.meta.id.slice(0, 8)}.${format}`,
      serialize(session, format),
      `${mime};charset=utf-8`
    );
  } finally {
    button.disabled = false;
  }
}

async function deleteSession(id) {
  if (!confirm("이 기록 세션을 삭제할까요? 복구할 수 없습니다.")) return;
  const response = await chrome.runtime.sendMessage({type: "DELETE_SESSION", sessionId: id});
  if (!response?.ok) throw new Error(response?.error || "세션을 삭제하지 못했습니다.");
  await renderSessions();
}

async function renderSessions() {
  const response = await chrome.runtime.sendMessage({type: "LIST_SESSIONS"});
  if (!response?.ok) throw new Error(response?.error || "세션 목록을 읽지 못했습니다.");
  const sessions = response.result;
  sessionsNode.replaceChildren();
  if (!sessions.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "아직 저장된 세션이 없습니다.";
    sessionsNode.append(empty);
    return;
  }
  for (const session of sessions) {
    const fragment = template.content.cloneNode(true);
    fragment.querySelector(".session-title").textContent = session.title;
    const phase = session.lastTurnState?.phase || "IDLE";
    fragment.querySelector(".session-meta").textContent =
      `${formatDate(session.startedAt)} · ${session.eventCount}개 이벤트 · ${phase}`;
    const badge = fragment.querySelector(".badge");
    badge.textContent = session.status === "recording" ? "기록 중" : "완료";
    const select = fragment.querySelector(".format");
    const exportButton = fragment.querySelector(".export");
    exportButton.disabled = session.status === "recording";
    exportButton.addEventListener("click", () =>
      exportSession(session.id, select.value, exportButton).catch(showError)
    );
    fragment.querySelector(".delete").addEventListener("click", () =>
      deleteSession(session.id).catch(showError)
    );
    sessionsNode.append(fragment);
  }
}

function showError(error) {
  setStatus(error.message || String(error), "error", 8000);
}

async function refreshLive() {
  if (preparationActive) return;
  try {
    const tab = await activeChatGptTab();
    const response = await probeRecorder(tab.id);
    if (!response?.ok) {
      startButton.disabled = false;
      stopButton.disabled = true;
      titleInput.disabled = false;
      renderTurnState(null, null);
      if (Date.now() >= statusHoldUntil) {
        setStatus("대기 중 · 기록 시작을 누르면 계측기를 연결합니다.");
        phaseMeta.textContent = "기록 시작 전";
      }
      recentNode.replaceChildren();
      return;
    }

    const state = response.result;
    startButton.disabled = state.active;
    stopButton.disabled = !state.active;
    titleInput.disabled = state.active;
    renderTurnState(state.turnState, state.probe);
    if (Date.now() >= statusHoldUntil) {
      setStatus(state.active
        ? `“${state.title}” 기록 중 · #${state.seq} · ${state.turnState?.phase || "IDLE"}`
        : "대기 중 · 계측기 연결됨");
    }
    recentNode.replaceChildren();
    for (const item of state.recent.slice().reverse()) {
      const li = document.createElement("li");
      li.textContent = `#${item.seq} ${item.label || item.type}`;
      recentNode.append(li);
    }
  } catch (error) {
    startButton.disabled = false;
    stopButton.disabled = true;
    titleInput.disabled = false;
    renderTurnState(null, null);
    if (Date.now() >= statusHoldUntil) setStatus(error.message || CHATGPT_TAB_ERROR, "error");
    recentNode.replaceChildren();
  }
}

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  preparationActive = true;
  statusHoldUntil = 0;
  let session = null;
  try {
    const title = titleInput.value.replace(/\s+/g, " ").trim();
    if (!title) throw new Error("기록 제목을 입력해 주세요.");
    const tab = await activeChatGptTab();
    setStatus("계측기 연결 확인 중");
    await ensureContentScript(tab.id);
    setStatus("계측기 연결 완료 · 기록을 시작합니다.");
    const created = await chrome.runtime.sendMessage({type: "CREATE_SESSION", title, tabId: tab.id});
    if (!created?.ok) throw new Error(created?.error || "세션을 만들지 못했습니다.");
    session = created.result;
    const started = await chrome.tabs.sendMessage(tab.id, {type: "START_RECORDING", session});
    if (!started?.ok) throw new Error(started?.error || "기록을 시작하지 못했습니다.");
  } catch (error) {
    if (session?.id) await chrome.runtime.sendMessage({type: "ABORT_SESSION", sessionId: session.id}).catch(() => {});
    showError(error);
  } finally {
    preparationActive = false;
    await refreshLive();
    await renderSessions().catch(showError);
  }
});

stopButton.addEventListener("click", async () => {
  stopButton.disabled = true;
  try {
    const response = await sendToActiveTab({type: "STOP_RECORDING"});
    if (!response?.ok) throw new Error(response?.error || "기록을 종료하지 못했습니다.");
    await refreshLive();
    await renderSessions();
  } catch (error) {
    showError(error);
    stopButton.disabled = false;
  }
});

refreshButton.addEventListener("click", () => renderSessions().catch(showError));

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    refreshLive();
    renderSessions().catch(showError);
  }
});

renderSessions().catch(showError);
refreshLive();
setInterval(() => {
  refreshLive();
  renderSessions().catch(() => {});
}, 1200);
