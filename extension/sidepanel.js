"use strict";

const titleInput = document.querySelector("#session-title");
const startButton = document.querySelector("#start");
const stopButton = document.querySelector("#stop");
const statusNode = document.querySelector("#live-status");
const recentNode = document.querySelector("#recent-events");
const sessionsNode = document.querySelector("#sessions");
const refreshButton = document.querySelector("#refresh");
const template = document.querySelector("#session-template");
let currentTabId = null;
const CHATGPT_ORIGIN = "https://chatgpt.com";
const CHATGPT_TAB_ERROR = "활성 탭이 https://chatgpt.com인지 확인해 주세요.";

async function activeChatGptTab() {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  if (!Number.isInteger(tab?.id)) throw new Error(CHATGPT_TAB_ERROR);
  currentTabId = tab.id;
  return tab;
}

async function probeRecorder(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {type: "GET_RECORDING_STATUS"});
    return response?.ok ? response : null;
  } catch {
    return null;
  }
}

async function ensureContentScript(tabId) {
  const existing = await probeRecorder(tabId);
  if (existing) return existing;

  let origin = null;
  try {
    const result = await chrome.scripting.executeScript({
      target: {tabId},
      func: () => location.origin
    });
    origin = result?.[0]?.result || null;
  } catch {
    throw new Error(CHATGPT_TAB_ERROR);
  }
  if (origin !== CHATGPT_ORIGIN) throw new Error(CHATGPT_TAB_ERROR);

  await chrome.scripting.executeScript({
    target: {tabId},
    files: ["lib/core.js", "content.js"]
  });
  const injected = await probeRecorder(tabId);
  if (!injected) {
    throw new Error("ChatGPT 탭에 기록기를 연결하지 못했습니다. 탭을 새로고침한 뒤 다시 시도해 주세요.");
  }
  return injected;
}

async function sendToActiveTab(message) {
  const tab = await activeChatGptTab();
  await ensureContentScript(tab.id);
  return chrome.tabs.sendMessage(tab.id, message);
}

function setStatus(message, kind = "normal") {
  statusNode.textContent = message;
  statusNode.dataset.kind = kind;
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
    schema: "chatgpt-ui-state-inspector/session@1.0.0",
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
    `- Started: ${payload.meta.startedAt}`,
    `- Completed: ${payload.meta.completedAt || "recording"}`,
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
    const extension = format;
    downloadText(
      `${safeFilename(session.meta.title)}_${session.meta.id.slice(0, 8)}.${extension}`,
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
    fragment.querySelector(".session-meta").textContent =
      `${formatDate(session.startedAt)} · ${session.eventCount}개 이벤트`;
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
  setStatus(error.message || String(error), "error");
}

async function refreshLive() {
  try {
    const tab = await activeChatGptTab();
    const response = await ensureContentScript(tab.id);
    if (!response?.ok) throw new Error(response?.error || "상태를 읽지 못했습니다.");
    const state = response.result;
    startButton.disabled = state.active;
    stopButton.disabled = !state.active;
    titleInput.disabled = state.active;
    setStatus(state.active
      ? `“${state.title}” 기록 중 · 현재 순번 ${state.seq}`
      : "대기 중");
    recentNode.replaceChildren();
    for (const item of state.recent.slice().reverse()) {
      const li = document.createElement("li");
      li.textContent = `#${item.seq} ${item.type}`;
      recentNode.append(li);
    }
  } catch (error) {
    startButton.disabled = false;
    stopButton.disabled = true;
    titleInput.disabled = false;
    setStatus(error.message || CHATGPT_TAB_ERROR, "error");
    recentNode.replaceChildren();
  }
}

startButton.addEventListener("click", async () => {
  startButton.disabled = true;
  let session = null;
  try {
    const title = titleInput.value.replace(/\s+/g, " ").trim();
    if (!title) throw new Error("기록 제목을 입력해 주세요.");
    const tab = await activeChatGptTab();
    await ensureContentScript(tab.id);
    const created = await chrome.runtime.sendMessage({type: "CREATE_SESSION", title, tabId: tab.id});
    if (!created?.ok) throw new Error(created?.error || "세션을 만들지 못했습니다.");
    session = created.result;
    const started = await chrome.tabs.sendMessage(tab.id, {type: "START_RECORDING", session});
    if (!started?.ok) throw new Error(started?.error || "기록을 시작하지 못했습니다.");
    await refreshLive();
    await renderSessions();
  } catch (error) {
    if (session?.id) await chrome.runtime.sendMessage({type: "ABORT_SESSION", sessionId: session.id}).catch(() => {});
    showError(error);
    startButton.disabled = false;
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
