(() => {
  "use strict";

  const BUILD_ID = "0.2.0-dev1";
  const ENDPOINT = "/backend-api/f/conversation";
  const ALLOWED_PATHS = new Set([
    '["model"]',
    '["thinking_effort"]',
    '["conversation_origin"]',
    '["service_tier"]'
  ]);
  const MODES = Object.freeze({
    chat: Object.freeze({
      model: "gpt-5-6-thinking",
      thinkingEffort: "max",
      targetOps: Object.freeze([
        Object.freeze({op: "remove", path: Object.freeze(["conversation_origin"])}),
        Object.freeze({op: "remove", path: Object.freeze(["service_tier"])})
      ]),
      sourceOps: Object.freeze([
        Object.freeze({op: "set", path: Object.freeze(["conversation_origin"]), value: "tpp"}),
        Object.freeze({op: "set", path: Object.freeze(["service_tier"]), value: "standard"})
      ])
    }),
    work: Object.freeze({
      model: "gpt-5.6-luna-wm",
      thinkingEffort: "standard",
      targetOps: Object.freeze([
        Object.freeze({op: "set", path: Object.freeze(["conversation_origin"]), value: "tpp"}),
        Object.freeze({op: "set", path: Object.freeze(["service_tier"]), value: "standard"})
      ]),
      sourceOps: Object.freeze([
        Object.freeze({op: "remove", path: Object.freeze(["conversation_origin"])}),
        Object.freeze({op: "remove", path: Object.freeze(["service_tier"])})
      ])
    })
  });

  function pathKey(path) {
    return JSON.stringify(path);
  }

  function safeControlValue(value, fallback) {
    const text = String(value ?? "").trim();
    if (!text) return fallback;
    if (text.length > 80 || !/^[A-Za-z0-9._:-]+$/.test(text)) return null;
    return text;
  }

  function validOp(op) {
    if (!op || !["set", "remove"].includes(op.op) || !Array.isArray(op.path)) return false;
    if (!ALLOWED_PATHS.has(pathKey(op.path))) return false;
    if (op.op === "remove") return !("value" in op);
    return typeof op.value === "string" && op.value.length <= 80 && /^[A-Za-z0-9._:-]+$/.test(op.value);
  }

  function cloneOps(ops) {
    return ops.map((op) => ({...op, path: [...op.path]}));
  }

  function buildConfig(mode, options = {}, conversationId) {
    const template = MODES[mode];
    if (!template || typeof conversationId !== "string" || !/^[0-9a-z-]{8,80}$/i.test(conversationId)) return null;
    const model = safeControlValue(options.model, template.model);
    const thinkingEffort = safeControlValue(options.thinkingEffort, template.thinkingEffort);
    if (!model || !thinkingEffort) return null;
    const targetOps = [
      {op: "set", path: ["model"], value: model},
      {op: "set", path: ["thinking_effort"], value: thinkingEffort},
      ...cloneOps(template.targetOps)
    ];
    const sourceOps = cloneOps(template.sourceOps);
    if (![...targetOps, ...sourceOps].every(validOp)) return null;
    return {
      buildId: BUILD_ID,
      mode,
      conversationId,
      endpoint: ENDPOINT,
      autoReload: options.autoReload !== false,
      model,
      thinkingEffort,
      targetOps,
      sourceOps
    };
  }

  function getAtPath(root, path) {
    let cursor = root;
    for (const key of path) {
      if (!cursor || typeof cursor !== "object" || !(key in cursor)) return {exists: false, value: undefined};
      cursor = cursor[key];
    }
    return {exists: true, value: cursor};
  }

  function matchesOps(body, ops) {
    if (!body || typeof body !== "object" || Array.isArray(body) || !Array.isArray(ops) || !ops.every(validOp)) return false;
    for (const op of ops) {
      const current = getAtPath(body, op.path);
      if (op.op === "set" && (!current.exists || !Object.is(current.value, op.value))) return false;
      if (op.op === "remove" && current.exists) return false;
    }
    return true;
  }

  function cloneJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function setAtPath(root, path, value) {
    let cursor = root;
    for (let index = 0; index < path.length - 1; index += 1) {
      const key = path[index];
      if (!cursor[key] || typeof cursor[key] !== "object" || Array.isArray(cursor[key])) cursor[key] = {};
      cursor = cursor[key];
    }
    cursor[path.at(-1)] = value;
  }

  function removeAtPath(root, path) {
    let cursor = root;
    for (let index = 0; index < path.length - 1; index += 1) {
      const key = path[index];
      if (!cursor || typeof cursor !== "object" || !(key in cursor)) return;
      cursor = cursor[key];
    }
    if (cursor && typeof cursor === "object") delete cursor[path.at(-1)];
  }

  function transformBody(body, config) {
    if (!body || typeof body !== "object" || Array.isArray(body)) return {status: "invalid-body", transformed: false, body};
    if (!config || config.endpoint !== ENDPOINT || !["chat", "work"].includes(config.mode)) return {status: "invalid-config", transformed: false, body};
    if (![...(config.targetOps || []), ...(config.sourceOps || [])].every(validOp)) return {status: "invalid-config", transformed: false, body};
    if (matchesOps(body, config.targetOps)) return {status: "already-target", transformed: false, body};
    if (!matchesOps(body, config.sourceOps)) return {status: "source-profile-mismatch", transformed: false, body};

    const protectedConversationId = body.conversation_id;
    const protectedMessages = body.messages;
    const next = cloneJson(body);
    let applied = 0;
    for (const op of config.targetOps) {
      const before = getAtPath(next, op.path);
      if (op.op === "set") {
        if (!before.exists || !Object.is(before.value, op.value)) {
          setAtPath(next, op.path, op.value);
          applied += 1;
        }
      } else if (before.exists) {
        removeAtPath(next, op.path);
        applied += 1;
      }
    }
    if (protectedConversationId !== undefined) next.conversation_id = protectedConversationId;
    if (protectedMessages !== undefined) next.messages = protectedMessages;
    return {status: applied ? "applied" : "already-target", transformed: applied > 0, body: next, applied};
  }

  const api = Object.freeze({BUILD_ID, ENDPOINT, buildConfig, matchesOps, transformBody, allowedPaths: Object.freeze([...ALLOWED_PATHS])});
  globalThis.UiStateInspectorChatWorkSwitchCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
