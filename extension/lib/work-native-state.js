(() => {
  "use strict";

  const BUILD_ID = "0.1.8-dev12";
  const DECODER_ATTR = "data-ui-state-inspector-decoder";
  const base = globalThis.UiStateInspectorProtocol;
  if (!base) return;
  if (globalThis.__CHATGPT_UI_STATE_INSPECTOR_WORK_NATIVE_STATE__ === BUILD_ID) return;

  function publishBuild() {
    try {
      if (typeof document === "undefined") return false;
      const root = document.documentElement;
      if (!root) return false;
      root.setAttribute(DECODER_ATTR, BUILD_ID);
      return true;
    } catch {
      return false;
    }
  }

  if (!publishBuild() && typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
    const observer = new MutationObserver(() => {
      if (publishBuild()) observer.disconnect();
    });
    try {
      observer.observe(document, {childList: true, subtree: true});
    } catch {}
  }

  function detectSignals(summary) {
    const signals = Array.isArray(base.detectSignals?.(summary)) ? [...base.detectSignals(summary)] : [];
    const messageKeys = Array.isArray(summary?.messageKeys) ? summary.messageKeys : [];
    const finalChannelFirst =
      messageKeys.includes("ec:s:marker:final_channel_token:marker") &&
      messageKeys.includes("ec:s:event:first:event");
    if (finalChannelFirst && !signals.some((signal) => signal?.code === "VISIBLE_ANSWER")) {
      signals.push({
        code: "VISIBLE_ANSWER",
        confidence: 1,
        reason: "Work final_channel_token first"
      });
    }
    return signals;
  }

  globalThis.UiStateInspectorProtocol = Object.freeze({...base, detectSignals});
  globalThis.__CHATGPT_UI_STATE_INSPECTOR_WORK_NATIVE_STATE__ = BUILD_ID;
  publishBuild();
})();
