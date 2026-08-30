(() => {
  "use strict";

  const CARRIER_BUILD = "0.1.3-dev7";
  const DECODER_BUILD = "0.1.6-dev10";
  const CARRIER_ATTR = "data-ui-state-inspector-carrier";
  const PARSER_ATTR = "data-ui-state-inspector-parser";
  const DECODER_ATTR = "data-ui-state-inspector-decoder";
  const base = globalThis.UiStateInspectorProtocol;
  if (!base) return;

  let parserBuild = null;
  try {
    parserBuild = base.summarizePayload?.({})?.buildId || null;
  } catch {}

  function publishDomHandshake() {
    try {
      if (typeof document === "undefined") return false;
      const root = document.documentElement;
      if (!root) return false;
      root.setAttribute(CARRIER_ATTR, CARRIER_BUILD);
      root.setAttribute(DECODER_ATTR, DECODER_BUILD);
      if (parserBuild) root.setAttribute(PARSER_ATTR, String(parserBuild).slice(0, 40));
      return true;
    } catch {
      return false;
    }
  }

  if (!publishDomHandshake() && typeof document !== "undefined" && typeof MutationObserver !== "undefined") {
    const observer = new MutationObserver(() => {
      if (publishDomHandshake()) observer.disconnect();
    });
    try {
      observer.observe(document, {childList: true, subtree: true});
    } catch {}
  }

  if (globalThis.__CHATGPT_UI_STATE_INSPECTOR_STRUCTURE_CARRIER__ === DECODER_BUILD) return;

  const SAFE_TOKEN = /^[A-Za-z0-9_.:/-]{1,80}$/;
  const MAX_ENCODED_ITEMS = 6;
  const MAX_ENCODED_ITEM_LENGTH = 200000;

  function token(value, max = 28) {
    const text = String(value ?? "").trim();
    if (!text) return "null";
    const cleaned = text
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/ig, "id")
      .replace(/[A-Za-z0-9_-]{24,}/g, "id")
      .replace(/[^A-Za-z0-9_.:/-]/g, "_")
      .slice(0, max);
    return SAFE_TOKEN.test(cleaned) ? cleaned : "redacted";
  }

  function pathToken(value, max = 44) {
    const text = String(value ?? "")
      .replace(/^\$\.?/, "")
      .replace(/::<json>/g, ".json")
      .replace(/\[(\d+)\]/g, ".i$1")
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/ig, "id")
      .replace(/[A-Za-z0-9_-]{24,}/g, "id")
      .replace(/[^A-Za-z0-9_.:/-]/g, "_");
    const clipped = text.length > max ? text.slice(text.length - max) : text;
    return token(clipped || "root", max);
  }

  function candidateToken(item, prefix = "sc") {
    if (!item || typeof item !== "object") return null;
    const valueType = typeof item.value === "boolean" ? "b" : typeof item.value === "number" ? "n" : "s";
    const value = token(item.value, 22);
    const key = token(item.key, 20);
    const path = pathToken(item.path, 28);
    const encoded = `${prefix}:${valueType}:${key}:${value}:${path}`.slice(0, 80);
    return SAFE_TOKEN.test(encoded) ? encoded : null;
  }

  function keyPathToken(item, prefix = "kp") {
    if (!item || typeof item !== "object") return null;
    const kind = token(item.kind, 12);
    const path = pathToken(item.path, 58);
    const encoded = `${prefix}:${kind}:${path}`.slice(0, 80);
    return SAFE_TOKEN.test(encoded) ? encoded : null;
  }

  function nestedPathToken(path) {
    const encoded = `nj:${pathToken(path, 74)}`.slice(0, 80);
    return SAFE_TOKEN.test(encoded) ? encoded : null;
  }

  function dedupe(values, limit) {
    const out = [];
    for (const value of values) {
      if (!value || out.includes(value)) continue;
      out.push(value);
      if (out.length >= limit) break;
    }
    return out;
  }

  function lengthBucket(length) {
    const size = Math.max(0, Number(length) || 0);
    if (size <= 64) return "64";
    if (size <= 256) return "256";
    if (size <= 1024) return "1024";
    if (size <= 4096) return "4096";
    if (size <= 16384) return "16384";
    if (size <= 65536) return "65536";
    return "large";
  }

  function collectEncodedItems(value, depth = 0, out = []) {
    if (out.length >= MAX_ENCODED_ITEMS || depth > 8 || value == null) return out;
    if (Array.isArray(value)) {
      for (const item of value) {
        collectEncodedItems(item, depth + 1, out);
        if (out.length >= MAX_ENCODED_ITEMS) break;
      }
      return out;
    }
    if (typeof value !== "object") return out;
    for (const [key, child] of Object.entries(value)) {
      if (key === "encoded_item" && typeof child === "string") {
        out.push(child.slice(0, MAX_ENCODED_ITEM_LENGTH));
      } else if (child && typeof child === "object") {
        collectEncodedItems(child, depth + 1, out);
      }
      if (out.length >= MAX_ENCODED_ITEMS) break;
    }
    return out;
  }

  function parseJsonContainer(text) {
    let current = String(text ?? "").trim();
    for (let depth = 0; depth < 2; depth += 1) {
      if (!current) return null;
      if (current.startsWith("{") || current.startsWith("[")) {
        try {
          return JSON.parse(current);
        } catch {
          return null;
        }
      }
      if (current.startsWith('"')) {
        try {
          const decoded = JSON.parse(current);
          if (typeof decoded !== "string") return null;
          current = decoded.trim();
          continue;
        } catch {
          return null;
        }
      }
      return null;
    }
    return null;
  }

  function normalizeBase64(value) {
    const text = String(value ?? "").trim();
    if (text.length < 8 || text.length % 4 === 1) return null;
    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text)) return null;
    let normalized = text.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/g, "");
    while (normalized.length % 4) normalized += "=";
    return normalized;
  }

  function decodeBase64Bytes(value) {
    if (typeof globalThis.atob !== "function") return null;
    const normalized = normalizeBase64(value);
    if (!normalized) return null;
    try {
      const binary = globalThis.atob(normalized);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index) & 255;
      return bytes;
    } catch {
      return null;
    }
  }

  function decodeUtf8(bytes) {
    if (!bytes || typeof globalThis.TextDecoder !== "function") return null;
    try {
      return new globalThis.TextDecoder("utf-8", {fatal: true}).decode(bytes);
    } catch {
      return null;
    }
  }

  function binaryCodec(bytes) {
    if (!bytes?.length) return "empty";
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return "gzip";
    if (bytes.length >= 2 && bytes[0] === 0x78 && [0x01, 0x5e, 0x9c, 0xda].includes(bytes[1])) return "zlib";
    return "binary";
  }

  function structuralTokens(parsed) {
    if (!parsed || typeof base.summarizeStructure !== "function") {
      return {candidateTokens: [], keyPathTokens: []};
    }
    try {
      const structure = base.summarizeStructure(parsed) || {};
      return {
        candidateTokens: (Array.isArray(structure.stateCandidates) ? structure.stateCandidates : [])
          .map((item) => candidateToken(item, "ec"))
          .filter(Boolean),
        keyPathTokens: (Array.isArray(structure.keyPaths) ? structure.keyPaths : [])
          .map((item) => keyPathToken(item, "ek"))
          .filter(Boolean)
      };
    } catch {
      return {candidateTokens: [], keyPathTokens: []};
    }
  }

  function inspectEncodedItem(raw) {
    const topTokens = [`ei:len:${lengthBucket(raw.length)}`];
    let parsed = parseJsonContainer(raw);
    if (parsed) {
      const structure = structuralTokens(parsed);
      return {topTokens: [...topTokens, "ei:codec:json"], ...structure};
    }

    let candidate = raw;
    if (/%[0-9A-Fa-f]{2}/.test(candidate)) {
      try {
        const decodedUri = decodeURIComponent(candidate);
        parsed = parseJsonContainer(decodedUri);
        if (parsed) {
          const structure = structuralTokens(parsed);
          return {topTokens: [...topTokens, "ei:codec:url-json"], ...structure};
        }
        candidate = decodedUri;
      } catch {}
    }

    const bytes = decodeBase64Bytes(candidate);
    if (!bytes) return {topTokens: [...topTokens, "ei:codec:opaque"], candidateTokens: [], keyPathTokens: []};

    const text = decodeUtf8(bytes);
    if (text != null) {
      parsed = parseJsonContainer(text);
      if (parsed) {
        const structure = structuralTokens(parsed);
        return {topTokens: [...topTokens, "ei:codec:b64-json"], ...structure};
      }
      return {topTokens: [...topTokens, "ei:codec:b64-text"], candidateTokens: [], keyPathTokens: []};
    }

    return {
      topTokens: [...topTokens, `ei:codec:b64-${binaryCodec(bytes)}`],
      candidateTokens: [],
      keyPathTokens: []
    };
  }

  function inspectEncodedItems(payload) {
    const items = collectEncodedItems(payload);
    const topTokens = [`decoder:${DECODER_BUILD}`];
    const candidateTokens = [];
    const keyPathTokens = [];
    if (items.length) topTokens.push(`ei:count:${items.length}`);
    for (const item of items) {
      const result = inspectEncodedItem(item);
      topTokens.push(...result.topTokens);
      candidateTokens.push(...result.candidateTokens);
      keyPathTokens.push(...result.keyPathTokens);
    }
    return {
      topTokens: dedupe(topTokens, 8),
      candidateTokens: dedupe(candidateTokens, 14),
      keyPathTokens: dedupe(keyPathTokens, 14)
    };
  }

  function enrich(summary, payload) {
    if (!summary || typeof summary !== "object") return summary;
    const encodedInspection = inspectEncodedItems(payload);
    const candidateTokens = (Array.isArray(summary.stateCandidates) ? summary.stateCandidates : [])
      .map((item) => candidateToken(item))
      .filter(Boolean);
    const keyPathTokens = (Array.isArray(summary.keyPaths) ? summary.keyPaths : [])
      .map((item) => keyPathToken(item))
      .filter(Boolean);
    const nestedTokens = (Array.isArray(summary.nestedJsonPaths) ? summary.nestedJsonPaths : [])
      .map(nestedPathToken)
      .filter(Boolean);

    return {
      ...summary,
      topLevelKeys: dedupe([
        `carrier:${CARRIER_BUILD}`,
        ...encodedInspection.topTokens,
        `parser:${token(summary.buildId, 28)}`,
        `root:${token(summary.rootKind, 14)}`,
        `trunc:${summary.structureTruncated ? "true" : "false"}`,
        ...(Array.isArray(summary.topLevelKeys) ? summary.topLevelKeys : [])
      ], 20),
      messageKeys: dedupe([
        ...encodedInspection.candidateTokens,
        ...candidateTokens,
        ...(Array.isArray(summary.messageKeys) ? summary.messageKeys : [])
      ], 20),
      metadataKeys: dedupe([
        ...encodedInspection.keyPathTokens,
        ...keyPathTokens,
        ...nestedTokens,
        ...(Array.isArray(summary.metadataKeys) ? summary.metadataKeys : [])
      ], 20)
    };
  }

  function detectSignals(summary) {
    const signals = Array.isArray(base.detectSignals?.(summary)) ? [...base.detectSignals(summary)] : [];
    const workDone = (Array.isArray(summary?.messageKeys) ? summary.messageKeys : [])
      .some((item) => typeof item === "string" && item.startsWith("sc:s:type:done:"));
    if (workDone && !signals.some((signal) => signal?.code === "STREAM_COMPLETE")) {
      signals.push({code: "STREAM_COMPLETE", confidence: 0.99, reason: "Work websocket done event"});
    }
    return signals;
  }

  const api = Object.freeze({
    ...base,
    summarizePayload(payload, byteLength) {
      return enrich(base.summarizePayload(payload, byteLength), payload);
    },
    summarizeSseData(rawData) {
      const result = base.summarizeSseData(rawData);
      return {...result, summary: enrich(result?.summary, null)};
    },
    detectSignals
  });

  globalThis.UiStateInspectorProtocol = api;
  globalThis.__CHATGPT_UI_STATE_INSPECTOR_STRUCTURE_CARRIER__ = DECODER_BUILD;
  publishDomHandshake();
})();
