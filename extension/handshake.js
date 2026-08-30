"use strict";

(() => {
  const CARRIER_ATTR = "data-ui-state-inspector-carrier";
  const PARSER_ATTR = "data-ui-state-inspector-parser";
  const DECODER_ATTR = "data-ui-state-inspector-decoder";
  const EXPECTED_DECODER_BUILD = "0.1.7-dev11";

  function snapshot() {
    const root = document.documentElement;
    const decoderBuild = root?.getAttribute(DECODER_ATTR) || null;
    return {
      origin: location.origin,
      carrier: decoderBuild === EXPECTED_DECODER_BUILD ? root?.getAttribute(CARRIER_ATTR) || null : null,
      parserBuildId: root?.getAttribute(PARSER_ATTR) || null,
      decoderBuild,
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
