(() => {
  "use strict";

  const BUILD_ID = "0.1.1-dev5";
  const SAFE_TOKEN = /^[A-Za-z0-9_.:/-]{1,80}$/;
  const MAX_SHAPE_PATHS = 96;
  const MAX_STATE_CANDIDATES = 48;
  const MAX_NESTED_JSON_PATHS = 24;
  const MAX_STRUCTURE_DEPTH = 7;
  const MAX_STRUCTURE_NODES = 320;
  const MAX_NESTED_JSON_TEXT = 12000;
  const STATE_KEY = /(?:^|_)(?:type|status|state|phase|event|marker|role|kind|op|action|finish_reason|end_turn|is_complete|content_type)$/i;

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

  function valueKind(value) {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    return typeof value;
  }

  function pathKey(path, key) {
    return SAFE_TOKEN.test(key) ? `${path}.${key}` : `${path}.[key]`;
  }

  function arrayLengthBucket(length) {
    const count = Math.max(0, Number(length) || 0);
    if (count === 0) return 0;
    if (count <= 4) return 4;
    if (count <= 16) return 16;
    if (count <= 64) return 64;
    return 65;
  }

  function stateCandidateValue(value) {
    if (typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1000000) return value;
    if (typeof value !== "string") return null;
    const token = safeToken(value);
    return token && token !== "[redacted]" ? token : null;
  }

  function maybeNestedJson(value) {
    if (typeof value !== "string") return null;
    const text = value.trim();
    if (text.length < 2 || text.length > MAX_NESTED_JSON_TEXT) return null;
    if (!((text.startsWith("{") && text.endsWith("}")) || (text.startsWith("[") && text.endsWith("]")))) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  function summarizeStructure(payload) {
    const keyPaths = [];
    const stateCandidates = [];
    const nestedJsonPaths = [];
    let nodes = 0;

    function pushPath(path, kind, extra = null) {
      if (keyPaths.length >= MAX_SHAPE_PATHS) return;
      keyPaths.push(extra ? {path, kind, ...extra} : {path, kind});
    }

    function walk(value, path, depth) {
      if (nodes >= MAX_STRUCTURE_NODES || depth > MAX_STRUCTURE_DEPTH) return;
      nodes += 1;
      const kind = valueKind(value);
      if (kind === "array") {
        pushPath(path, kind, {lengthBucket: arrayLengthBucket(value.length)});
        const limit = Math.min(value.length, 24);
        for (let index = 0; index < limit; index += 1) {
          walk(value[index], `${path}[${index}]`, depth + 1);
        }
        return;
      }
      if (kind === "object") {
        pushPath(path, kind);
        const entries = Object.entries(value).slice(0, 40);
        for (const [key, child] of entries) {
          const childPath = pathKey(path, key);
          const childKind = valueKind(child);
          pushPath(childPath, childKind);
          if (STATE_KEY.test(key) && stateCandidates.length < MAX_STATE_CANDIDATES) {
            const candidate = stateCandidateValue(child);
            if (candidate !== null) stateCandidates.push({path: childPath, key, value: candidate, valueType: typeof candidate});
          }
          const nested = maybeNestedJson(child);
          if (nested !== null && nestedJsonPaths.length < MAX_NESTED_JSON_PATHS) {
            const nestedPath = `${childPath}::<json>`;
            nestedJsonPaths.push(nestedPath);
            walk(nested, nestedPath, depth + 1);
          } else if (childKind === "object" || childKind === "array") {
            walk(child, childPath, depth + 1);
          }
        }
        return;
      }
      pushPath(path, kind);
      const nested = maybeNestedJson(value);
      if (nested !== null && nestedJsonPaths.length < MAX_NESTED_JSON_PATHS) {
        const nestedPath = `${path}::<json>`;
        nestedJsonPaths.push(nestedPath);
        walk(nested, nestedPath, depth + 1);
      }
    }

    walk(payload, "$", 0);
    return {
      rootKind: valueKind(payload),
      rootArrayLengthBucket: Array.isArray(payload) ? arrayLengthBucket(payload.length) : null,
      keyPaths,
      stateCandidates,
      nestedJsonPaths,
      structureTruncated: nodes >= MAX_STRUCTURE_NODES || keyPaths.length >= MAX_SHAPE_PATHS
    };
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
    const structure = summarizeStructure(payload);
    return {
      buildId: BUILD_ID,
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
      rootKind: structure.rootKind,
      rootArrayLengthBucket: structure.rootArrayLengthBucket,
      keyPaths: structure.keyPaths,
      stateCandidates: structure.stateCandidates,
      nestedJsonPaths: structure.nestedJsonPaths,
      structureTruncated: structure.structureTruncated,
      byteLength: Math.max(0, Number(byteLength) || 0)
    };
  }

  function detectSignals(summary) {
    const signals = [];
    const type = String(summary?.type || "").toLowerCase();
    const event = String(summary?.event || "").toLowerCase();
    const marker = String(summary?.marker || "").toLowerCase();
    const status = String(summary?.status || "").toLowerCase();
    if (
      type === "message_marker" && event === "first" &&
      (marker === "final_channel_token" || marker === "user_visible_token")
    ) {
      signals.push({
        code: "FIRST_VISIBLE_TOKEN",
        confidence: marker === "final_channel_token" ? 1 : 0.99,
        reason: marker === "final_channel_token"
          ? "message_marker final_channel_token first"
          : "message_marker user_visible_token first"
      });
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
        buildId: BUILD_ID,
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
        rootKind: "string",
        rootArrayLengthBucket: null,
        keyPaths: [],
        stateCandidates: [],
        nestedJsonPaths: [],
        structureTruncated: false,
        byteLength
      };
      return {summary, signals: []};
    }
    try {
      const summary = summarizePayload(JSON.parse(data), byteLength);
      return {summary, signals: detectSignals(summary)};
    } catch {
      return {
        summary: {
          buildId: BUILD_ID,
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
          rootKind: "string",
          rootArrayLengthBucket: null,
          keyPaths: [],
          stateCandidates: [],
          nestedJsonPaths: [],
          structureTruncated: false,
          byteLength,
          parseError: true
        },
        signals: []
      };
    }
  }

  const api = Object.freeze({safeToken, safeKeys, summarizeStructure, summarizePayload, detectSignals, summarizeSseData});
  globalThis.UiStateInspectorProtocol = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
