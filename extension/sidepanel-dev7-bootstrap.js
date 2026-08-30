"use strict";

const EXPECTED_CARRIER_BUILD = "0.1.3-dev7";
const CHATGPT_ORIGIN = "https://chatgpt.com";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
  return Number.isInteger(tab?.id) ? tab : null;
}

async function inspect(tabId) {
  try {
    const result = await chrome.scripting.executeScript({
      target: {tabId},
      world: "MAIN",
      func: () => ({
        origin: location.origin,
        carrier: globalThis.__CHATGPT_UI_STATE_INSPECTOR_STRUCTURE_CARRIER__ || null
      })
    });
    return result?.[0]?.result || null;
  } catch {
    return null;
  }
}

async function ensureCarrier() {
  const tab = await activeTab();
  if (!tab) return;
  const current = await inspect(tab.id);
  if (current?.origin !== CHATGPT_ORIGIN) return;
  if (current?.carrier === EXPECTED_CARRIER_BUILD) return;

  await chrome.tabs.reload(tab.id);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await delay(150);
    const state = await inspect(tab.id);
    if (state?.origin === CHATGPT_ORIGIN && state.carrier === EXPECTED_CARRIER_BUILD) return;
  }
  throw new Error("최신 Work 구조 계측기를 ChatGPT 탭에 연결하지 못했습니다.");
}

function loadSidepanel() {
  const script = document.createElement("script");
  script.src = "sidepanel.js";
  document.body.append(script);
}

ensureCarrier()
  .catch((error) => {
    const status = document.querySelector("#live-status");
    if (status) {
      status.textContent = error.message || String(error);
      status.dataset.kind = "error";
    }
  })
  .finally(loadSidepanel);
