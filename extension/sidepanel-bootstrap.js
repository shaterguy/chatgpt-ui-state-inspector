"use strict";

(() => {
  const CHATGPT_ORIGIN = "https://chatgpt.com";
  const EXPECTED_PARSER_BUILD_ID = "0.1.1-dev5";
  const MAIN_SCRIPT = "sidepanel.js";
  const MAX_WAIT_MS = 8000;
  const POLL_MS = 160;

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function activeTab() {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    return Number.isInteger(tab?.id) ? tab : null;
  }

  async function pageOrigin(tabId) {
    try {
      const result = await chrome.scripting.executeScript({
        target: {tabId},
        func: () => location.origin
      });
      return result?.[0]?.result || null;
    } catch {
      return null;
    }
  }

  async function parserBuildId(tabId) {
    try {
      const result = await chrome.scripting.executeScript({
        target: {tabId},
        world: "MAIN",
        func: () => {
          try {
            return globalThis.UiStateInspectorProtocol?.summarizePayload?.({})?.buildId || null;
          } catch {
            return null;
          }
        }
      });
      return result?.[0]?.result || null;
    } catch {
      return null;
    }
  }

  async function waitForParser(tabId) {
    const deadline = Date.now() + MAX_WAIT_MS;
    while (Date.now() < deadline) {
      if (await parserBuildId(tabId) === EXPECTED_PARSER_BUILD_ID) return true;
      await delay(POLL_MS);
    }
    return false;
  }

  async function ensureCurrentParser() {
    const tab = await activeTab();
    if (!tab) return;
    if (await pageOrigin(tab.id) !== CHATGPT_ORIGIN) return;
    if (await parserBuildId(tab.id) === EXPECTED_PARSER_BUILD_ID) return;

    await chrome.tabs.reload(tab.id);
    await waitForParser(tab.id);
  }

  function loadSidepanel() {
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL(MAIN_SCRIPT);
    script.async = false;
    document.body.append(script);
  }

  ensureCurrentParser()
    .catch(() => {})
    .finally(loadSidepanel);
})();
