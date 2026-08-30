(() => {
  "use strict";

  const CARRIER_BUILD = "0.1.3-dev7";
  const CARRIER_ATTR = "data-ui-state-inspector-carrier";
  const PARSER_ATTR = "data-ui-state-inspector-parser";
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

  if (globalThis.__CHATGPT_UI_STATE_INSPECTOR_STRUCTURE_CARRIER__ === CARRIER_BUILD) return;

  const SAFE_TOKEN = /^[A-Za-z0-9_.:/-]{1,80}$/;

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

  function candidateToken(item) {
    if (!item || typeof item !== "object") return null;
    const valueType = typeof item.value === "boolean" ? "b" : typeof item.value === "number" ? "n" : "s";
    const value = token(item.value, 22);
    const key = token(item.key, 20);
    const path = pathToken(item.path, 28);
    const encoded = `sc:${valueType}:${key}:${value}:${path}`.slice(0, 80);
    return SAFE_TOKEN.test(encoded) ? encoded : null;
  }

  function keyPathToken(item) {
    if (!item || typeof item !== "object") return null;
    const kind = token(item.kind, 12);
    const path = pathToken(item.path, 58);
    const encoded = `kp:${kind}:${path}`.slice(0, 80);
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

  function enrich(summary) {
    if (!summary || typeof summary !== "object") return summary;
    const candidateTokens = (Array.isArray(summary.stateCandidates) ? summary.stateCandidates : [])
      .map(candidateToken)
      .filter(Boolean);
    const keyPathTokens = (Array.isArray(summary.keyPaths) ? summary.keyPaths : [])
      .map(keyPathToken)
      .filter(Boolean);
    const nestedTokens = (Array.isArray(summary.nestedJsonPaths) ? summary.nestedJsonPaths : [])
      .map(nestedPathToken)
      .filter(Boolean);

    return {
      ...summary,
      topLevelKeys: dedupe([
        `carrier:${CARRIER_BUILD}`,
        `parser:${token(summary.buildId, 28)}`,
        `root:${token(summary.rootKind, 14)}`,
        `trunc:${summary.structureTruncated ? "true" : "false"}`,
        ...(Array.isArray(summary.topLevelKeys) ? summary.topLevelKeys : [])
      ], 20),
      messageKeys: dedupe([
        ...candidateTokens,
        ...(Array.isArray(summary.messageKeys) ? summary.messageKeys : [])
      ], 20),
      metadataKeys: dedupe([
        ...keyPathTokens,
        ...nestedTokens,
        ...(Array.isArray(summary.metadataKeys) ? summary.metadataKeys : [])
      ], 20)
    };
  }

  const api = Object.freeze({
    ...base,
    summarizePayload(payload, byteLength) {
      return enrich(base.summarizePayload(payload, byteLength));
    },
    summarizeSseData(rawData) {
      const result = base.summarizeSseData(rawData);
      return {...result, summary: enrich(result?.summary)};
    }
  });

  globalThis.UiStateInspectorProtocol = api;
  globalThis.__CHATGPT_UI_STATE_INSPECTOR_STRUCTURE_CARRIER__ = CARRIER_BUILD;
  publishDomHandshake();
})();
