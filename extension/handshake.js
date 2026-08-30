"use strict";

(() => {
  const CARRIER_ATTR = "data-ui-state-inspector-carrier";
  const PARSER_ATTR = "data-ui-state-inspector-parser";

  function snapshot() {
    const root = document.documentElement;
    return {
      origin: location.origin,
      carrier: root?.getAttribute(CARRIER_ATTR) || null,
      parserBuildId: root?.getAttribute(PARSER_ATTR) || null,
      readyState: document.readyState
    };
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type !== "GET_INSPECTOR_HANDSHAKE") return false;
    sendResponse({ok: true, result: snapshot()});
    return false;
  });
})();
