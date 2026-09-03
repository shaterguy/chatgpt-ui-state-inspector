"use strict";

const switchStatus = document.querySelector("#switch-status");
const chatModel = document.querySelector("#chat-model");
const chatEffort = document.querySelector("#chat-effort");
const workModel = document.querySelector("#work-model");
const workEffort = document.querySelector("#work-effort");
const autoReload = document.querySelector("#switch-auto-reload");
const chatButton = document.querySelector("#switch-chat");
const workButton = document.querySelector("#switch-work");
const disableButton = document.querySelector("#switch-disable");

const STATUS_LABELS = Object.freeze({
  connecting: "전환기 연결 중",
  ready: "전환 대기",
  arming: "전환 설정 전달 중",
  armed: "다음 전송부터 전환 적용",
  applied: "요청 전환 적용됨 · 응답 대기",
  complete: "전환 응답 완료",
  bypassed: "안전 조건 불일치 · 원본 요청 유지",
  disabled: "전환 해제됨",
  disabling: "전환 해제 중",
  rejected: "전환 설정 거부됨"
});

function cleanInput(node) {
  return node.value.replace(/\s+/g, "").trim().slice(0, 80);
}

async function activeTab() {
  let tabs = await chrome.tabs.query({active: true, currentWindow: true});
  if (!tabs?.some((tab) => Number.isInteger(tab?.id))) tabs = await chrome.tabs.query({active: true, lastFocusedWindow: true});
  if (!tabs?.some((tab) => Number.isInteger(tab?.id))) tabs = await chrome.tabs.query({active: true});
  const tab = tabs?.find((item) => Number.isInteger(item?.id));
  if (!tab) throw new Error("활성 브라우저 탭을 찾지 못했습니다.");
  return tab;
}

async function send(message) {
  const tab = await activeTab();
  try {
    const response = await chrome.tabs.sendMessage(tab.id, message);
    if (!response?.ok) throw new Error(response?.error || "ChatGPT 전환기에서 요청을 처리하지 못했습니다.");
    return response.result;
  } catch (error) {
    throw new Error(error?.message?.includes("Receiving end does not exist")
      ? "ChatGPT 탭을 한 번 새로고침한 뒤 다시 시도해 주세요."
      : error?.message || "ChatGPT 전환기와 통신하지 못했습니다.");
  }
}

function render(state) {
  const status = state?.status || "connecting";
  const label = STATUS_LABELS[status] || status;
  const detail = [
    state?.mode ? `mode=${state.mode}` : null,
    state?.model ? `model=${state.model}` : null,
    state?.thinkingEffort ? `reasoning=${state.thinkingEffort}` : null,
    state?.reason ? `reason=${state.reason}` : null
  ].filter(Boolean).join(" · ");
  switchStatus.textContent = detail ? `${label} · ${detail}` : label;
  switchStatus.dataset.kind = ["rejected"].includes(status) ? "error" : "normal";
  disableButton.disabled = !["arming", "armed", "applied", "complete", "bypassed"].includes(status);
}

async function refreshSwitchState() {
  try {
    render(await send({type: "GET_CHAT_WORK_SWITCH_STATUS"}));
  } catch (error) {
    switchStatus.textContent = error.message;
    switchStatus.dataset.kind = "error";
    disableButton.disabled = true;
  }
}

async function arm(mode) {
  const isChat = mode === "chat";
  const state = await send({
    type: "SET_CHAT_WORK_SWITCH",
    mode,
    model: cleanInput(isChat ? chatModel : workModel),
    thinkingEffort: cleanInput(isChat ? chatEffort : workEffort),
    autoReload: autoReload.checked
  });
  render(state);
  setTimeout(() => refreshSwitchState(), 120);
}

chatButton.addEventListener("click", () => arm("chat").catch((error) => {
  switchStatus.textContent = error.message;
  switchStatus.dataset.kind = "error";
}));
workButton.addEventListener("click", () => arm("work").catch((error) => {
  switchStatus.textContent = error.message;
  switchStatus.dataset.kind = "error";
}));
disableButton.addEventListener("click", () => send({type: "DISABLE_CHAT_WORK_SWITCH"})
  .then(render)
  .then(() => setTimeout(() => refreshSwitchState(), 120))
  .catch((error) => {
    switchStatus.textContent = error.message;
    switchStatus.dataset.kind = "error";
  }));

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refreshSwitchState();
});
refreshSwitchState();
setInterval(() => refreshSwitchState(), 1500);
