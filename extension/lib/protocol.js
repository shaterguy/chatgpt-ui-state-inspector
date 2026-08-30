(() => {
  "use strict";

  const SAFE_TOKEN = /^[A-Za-z0-9_.:/-]{1,80}$/;

  function object(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  }

  function safeToken(value) {
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (!text) return null;
    return SAFE_TOKEN.test(text) ? text : "[redacted]";
  }

  function safeKeys(value, limit = 20) {
    const source = object(value);
    if (!source) return [];
    return Object.keys(source)
      .filter((key) => SAFE_TOKEN.test(key))
      .slice(0, limit);
  }

  function firstToken(...values) {
    for (const value of values) {
      const token = safeToken(value);
      if (token) return token;
    }
    return null;
  }

  function findMessage(payload) {
    return object(payload?.message) || object(payload?.data?.message) ||
      object(payload?.delta?.message) || object(payload?.response?.message) || null;
  }

  function assistantTextPresent(message, role) {
    if (role !== "assistant" || !message) return false;
    const content = object(message.content);
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    return parts.some((part) => {
      if (typeof part === "string") return part.trim().length > 0;
      if (object(part) && typeof part.text === "string") return part.text.trim().length > 0;
      return false;
    });
  }

  function summarizePayload(payload, byteLength = 0) {
    const root = object(payload) || {};
    const message = findMessage(root);
    const metadata = object(message?.metadata) || object(root.metadata);
    const role = firstToken(
      message?.author?.role,
      root.author?.role,
      root.role,
      root.data?.role
    );
    const type = firstToken(root.type, root.data?.type, root.event?.type, message?.type);
    const event = firstToken(root.event, root.data?.event, root.event?.name);
    const marker = firstToken(root.marker, root.data?.marker, metadata?.marker);
    const status = firstToken(root.status, root.data?.status, message?.status, root.response?.status);
    const contentType = firstToken(
      message?.content?.content_type,
      root.content?.content_type,
      root.data?.content_type
    );
    const finishReason = firstToken(
      root.finish_reason,
      root.stop_reason,
      root.data?.finish_reason,
      metadata?.finish_reason
    );
    const endTurnCandidate = message?.end_turn ?? root.end_turn ?? root.data?.end_turn;
    const errorCode = firstToken(root.error?.code, root.code, root.data?.error?.code);
    const normalizedType = String(type || "").toLowerCase();
    const normalizedStatus = String(status || "").toLowerCase();
    return {
      type,
      event,
      marker,
      status,
      endTurn: typeof endTurnCandidate === "boolean" ? endTurnCandidate : null,
      role,
      contentType,
      finishReason,
      errorCode,
      error: normalizedType === "error" || normalizedStatus.includes("error") || normalizedStatus.includes("failed"),
      assistantVisibleText: assistantTextPresent(message, role),
      topLevelKeys: safeKeys(root),
      messageKeys: safeKeys(message),
      metadataKeys: safeKeys(metadata),
      byteLength: Math.max(0, Number(byteLength) || 0)
    };
  }

  function detectSignals(summary) {
    const signals = [];
    const type = String(summary?.type || "").toLowerCase();
    const event = String(summary?.event || "").toLowerCase();
    const marker = String(summary?.marker || "").toLowerCase();
    const status = String(summary?.status || "").toLowerCase();
    if (type === "message_marker" && marker === "user_visible_token" && event === "first") {
      signals.push({code: "FIRST_VISIBLE_TOKEN", confidence: 0.99, reason: "message_marker user_visible_token first"});
    }
    if (type === "message_stream_complete") {
      signals.push({code: "STREAM_COMPLETE", confidence: 0.99, reason: "message_stream_complete"});
    }
    if (status === "finished_successfully" && summary?.endTurn === true) {
      signals.push({code: "STREAM_COMPLETE", confidence: 0.96, reason: "finished_successfully with end_turn"});
    }
    if (summary?.assistantVisibleText) {
      signals.push({code: "VISIBLE_ANSWER", confidence: 0.86, reason: "assistant payload contains visible text"});
    }
    if (summary?.error) {
      signals.push({code: "GENERATION_ERROR", confidence: 0.95, reason: "protocol error status"});
    }
    return signals;
  }

  function summarizeSseData(rawData) {
    const data = String(rawData ?? "");
    const byteLength = data.length;
    if (data.trim() === "[DONE]") {
      const summary = {
        type: "sse_done",
        event: null,
        marker: null,
        status: null,
        endTurn: null,
        role: null,
        contentType: null,
        finishReason: null,
        errorCode: null,
        error: false,
        assistantVisibleText: false,
        topLevelKeys: [],
        messageKeys: [],
        metadataKeys: [],
        byteLength
      };
      return {summary, signals: [{code: "STREAM_COMPLETE", confidence: 0.94, reason: "SSE DONE sentinel"}]};
    }
    try {
      const summary = summarizePayload(JSON.parse(data), byteLength);
      return {summary, signals: detectSignals(summary)};
    } catch {
      return {
        summary: {
          type: "unparsed_frame",
          event: null,
          marker: null,
          status: null,
          endTurn: null,
          role: null,
          contentType: null,
          finishReason: null,
          errorCode: null,
          error: false,
          assistantVisibleText: false,
          topLevelKeys: [],
          messageKeys: [],
          metadataKeys: [],
          byteLength,
          parseError: true
        },
        signals: []
      };
    }
  }

  const api = Object.freeze({safeToken, safeKeys, summarizePayload, detectSignals, summarizeSseData});
  globalThis.UiStateInspectorProtocol = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
