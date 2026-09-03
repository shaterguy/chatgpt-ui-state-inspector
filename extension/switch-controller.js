(() => {
  "use strict";

  const CHANNEL = "chatgpt-ui-state-inspector-switch@1";
  const token = crypto.randomUUID();
  const SAFE_CONTROL = /^[A-Za-z0-9._:-]+$/;
  let state = {
    ready: false,
    status: "connecting",
    reason: null,
    mode: null,
    model: null,
    thinkingEffort: null,
    autoReload: true,
    conversationIdMatches: null
  };

  function cleanControl(value) {
    const text = String(value ?? "").trim();
    if (!text) return "";
    if (text.length > 80 || !SAFE_CONTROL.test(text)) return null;
    return text;
  }

  function post(type, payload = {}) {
    window.postMessage({channel: CHANNEL, direction: "content", token, type, payload}, location.origin);
  }

  function validPageMessage(event) {
    if (event.source !== window || event.origin !== location.origin) return false;
    const message = event.data;
    if (!message || message.channel !== CHANNEL || message.direction !== "probe" || message.token !== token) return false;
    try {
      return JSON.stringify(message).length <= 12000;
    } catch {
      return false;
    }
  }

  window.addEventListener("message", (event) => {
    if (!validPageMessage(event)) return;
    if (event.data.type !== "switch_state") return;
    const payload = event.data.payload || {};
    state = {
      ready: Boolean(payload.ready),
      status: String(payload.status || "ready").slice(0, 40),
      reason: payload.reason ? String(payload.reason).slice(0, 80) : null,
      mode: payload.mode === "chat" || payload.mode === "work" ? payload.mode : null,
      model: cleanControl(payload.model),
      thinkingEffort: cleanControl(payload.thinkingEffort),
      autoReload: payload.autoReload !== false,
      conversationIdMatches: typeof payload.conversationIdMatches === "boolean" ? payload.conversationIdMatches : null,
      operationCount: Math.max(0, Number(payload.operationCount) || 0),
      statusCode: Number.isFinite(Number(payload.statusCode)) ? Number(payload.statusCode) : null
    };
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === "GET_CHAT_WORK_SWITCH_STATUS") {
      post("get_switch_state");
      sendResponse({ok: true, result: state});
      return false;
    }
    if (message?.type === "DISABLE_CHAT_WORK_SWITCH") {
      post("disable_switch");
      state = {...state, status: "disabling"};
      sendResponse({ok: true, result: state});
      return false;
    }
    if (message?.type === "SET_CHAT_WORK_SWITCH") {
      const mode = message.mode === "chat" || message.mode === "work" ? message.mode : null;
      const model = cleanControl(message.model);
      const thinkingEffort = cleanControl(message.thinkingEffort);
      if (!mode || model === null || thinkingEffort === null) {
        sendResponse({ok: false, error: "전환 설정 값이 올바르지 않습니다."});
        return false;
      }
      post("set_switch", {
        mode,
        model,
        thinkingEffort,
        autoReload: message.autoReload !== false
      });
      state = {
        ...state,
        status: "arming",
        mode,
        model: model || null,
        thinkingEffort: thinkingEffort || null,
        autoReload: message.autoReload !== false
      };
      sendResponse({ok: true, result: state});
      return false;
    }
    return false;
  });

  post("init");
  const handshakeTimer = setInterval(() => {
    if (state.ready) {
      clearInterval(handshakeTimer);
      return;
    }
    post("init");
  }, 300);
  setTimeout(() => clearInterval(handshakeTimer), 8000);
})();
