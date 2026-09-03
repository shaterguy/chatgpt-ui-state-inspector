(() => {
  "use strict";

  const PROTOCOL_VERSION = "1.1.0";
  const CHANNEL = "chatgpt-ui-state-inspector@1";
  const SWITCH_CHANNEL = "chatgpt-ui-state-inspector-switch@1";
  const MARKER = "__CHATGPT_UI_STATE_INSPECTOR_PAGE_PROBE__";
  const PUBLIC_STATE = "__CHATGPT_UI_STATE_INSPECTOR_STATE__";
  const PUBLIC_PHASES = "__CHATGPT_UI_STATE_INSPECTOR_PHASES__";
  const PHASE_EVENT = "chatgpt-ui-state-inspector:phasechange";
  const Protocol = globalThis.UiStateInspectorProtocol;
  const SwitchCore = globalThis.UiStateInspectorChatWorkSwitchCore;
  const MAX_STREAM_BUFFER = 512000;
  const MAX_FRAME_COUNT = 10000;
  const MAX_SOCKET_TEXT = 1000000;

  if (globalThis[MARKER]?.version === PROTOCOL_VERSION) return;

  let bridgeToken = null;
  let switchBridgeToken = null;
  let enabled = false;
  let requestSequence = 0;
  let switchSequence = 0;
  let activeSwitch = null;
  let publishedState = Object.freeze({
    protocolVersion: PROTOCOL_VERSION,
    phase: "IDLE",
    turnSequence: 0,
    turnId: null,
    confidence: 1,
    source: "initial",
    reason: "waiting",
    updatedAt: new Date().toISOString()
  });

  function safeText(value, maxLength = 120) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim();
    if (!text) return null;
    if (/https?:\/\/|\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(text)) return "[redacted]";
    return text.slice(0, maxLength);
  }

  function safePublicState(value) {
    const allowed = new Set(["IDLE", "THINKING", "ANSWERING", "COMPLETE", "ERROR"]);
    const phase = allowed.has(value?.phase) ? value.phase : "IDLE";
    return Object.freeze({
      protocolVersion: PROTOCOL_VERSION,
      phase,
      turnSequence: Math.max(0, Number(value?.turnSequence) || 0),
      turnId: safeText(value?.turnId, 80),
      generationActive: Boolean(value?.generationActive),
      sawVisibleAnswer: Boolean(value?.sawVisibleAnswer),
      startedAt: safeText(value?.startedAt, 40),
      firstVisibleTokenAt: safeText(value?.firstVisibleTokenAt, 40),
      completedAt: safeText(value?.completedAt, 40),
      confidence: Math.max(0, Math.min(1, Number(value?.confidence) || 0)),
      source: safeText(value?.source, 80),
      reason: safeText(value?.reason, 120),
      updatedAt: new Date().toISOString()
    });
  }

  function definePublicState() {
    try {
      Object.defineProperty(globalThis, PUBLIC_STATE, {
        configurable: true,
        enumerable: false,
        get: () => publishedState
      });
      Object.defineProperty(globalThis, PUBLIC_PHASES, {
        configurable: true,
        enumerable: false,
        value: Object.freeze(["IDLE", "THINKING", "ANSWERING", "COMPLETE", "ERROR"])
      });
    } catch {
      // A page-owned non-configurable property must not affect ChatGPT execution.
    }
  }

  function post(type, payload = {}) {
    if (!bridgeToken) return;
    try {
      window.postMessage({channel: CHANNEL, direction: "probe", token: bridgeToken, type, payload}, location.origin);
    } catch {
      // Recorder observation must always fail open.
    }
  }

  function postSwitch(type, payload = {}) {
    if (!switchBridgeToken) return;
    try {
      window.postMessage({channel: SWITCH_CHANNEL, direction: "probe", token: switchBridgeToken, type, payload}, location.origin);
    } catch {
      // Switch status reporting must never block ChatGPT.
    }
  }

  function stateSignal(code, details = {}) {
    post("state_signal", {
      code,
      confidence: Number(details.confidence) || 0.6,
      reason: safeText(details.reason, 120) || code.toLowerCase().replaceAll("_", " "),
      source: safeText(details.source, 40) || "protocol",
      transport: safeText(details.transport, 40),
      requestId: safeText(details.requestId, 80),
      timestamp: new Date().toISOString()
    });
  }

  function parsedUrl(value) {
    try {
      return new URL(String(value), location.href);
    } catch {
      return null;
    }
  }

  function currentConversationId() {
    return location.pathname.match(/\/c\/([0-9a-z-]+)/i)?.[1] || null;
  }

  function requestMetadata(input, init) {
    const isRequest = typeof Request !== "undefined" && input instanceof Request;
    const url = parsedUrl(isRequest ? input.url : input);
    const method = String(init?.method || (isRequest ? input.method : "GET") || "GET").toUpperCase();
    const sameOrigin = url?.origin === location.origin;
    const path = sameOrigin ? url.pathname.slice(0, 240) : null;
    const conversation = Boolean(sameOrigin && method === "POST" && /\/(?:conversation|responses)(?:\/|$)/i.test(path || ""));
    return {method, sameOrigin, path, conversation};
  }

  function nextRequestId(prefix) {
    requestSequence += 1;
    return `${prefix}-${requestSequence}`;
  }

  function emitProtocolFrame({transport, requestId, path, frameIndex, eventName, result}) {
    const payload = {
      transport,
      requestId,
      path,
      frameIndex,
      eventName: Protocol?.safeToken?.(eventName) || null,
      summary: result.summary,
      signals: result.signals
    };
    post("protocol_frame", payload);
    for (const signal of result.signals || []) {
      stateSignal(signal.code, {
        confidence: signal.confidence,
        reason: signal.reason,
        source: "protocol",
        transport,
        requestId
      });
    }
  }

  function processSseBlock(block, context) {
    const lines = String(block).split("\n");
    const dataLines = [];
    let eventName = null;
    for (const line of lines) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (!dataLines.length || !Protocol) return;
    context.frameIndex += 1;
    if (context.frameIndex > MAX_FRAME_COUNT) return;
    const result = Protocol.summarizeSseData(dataLines.join("\n"));
    emitProtocolFrame({...context, eventName, result});
  }

  async function inspectSseResponse(response, context) {
    const reader = response.body?.getReader?.();
    if (!reader) return;
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (enabled) {
        const {done, value} = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, {stream: true});
        buffer = buffer.replace(/\r\n/g, "\n");
        if (buffer.length > MAX_STREAM_BUFFER) {
          post("probe_error", {stage: "sse-buffer", name: "FrameBufferLimit", requestId: context.requestId, path: context.path});
          buffer = buffer.slice(-Math.floor(MAX_STREAM_BUFFER / 2));
        }
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          processSseBlock(block, context);
        }
      }
      buffer += decoder.decode();
      if (enabled && buffer.trim()) processSseBlock(buffer, context);
      if (!enabled) await reader.cancel().catch(() => {});
      post("transport_complete", {transport: context.transport, requestId: context.requestId, path: context.path, frames: context.frameIndex});
    } catch (error) {
      post("probe_error", {stage: "sse-read", name: safeText(error?.name, 60) || "Error", requestId: context.requestId, path: context.path});
    }
  }

  function switchSnapshot(status, reason = null, extra = {}) {
    return {
      ready: Boolean(SwitchCore),
      status,
      reason: safeText(reason, 80),
      mode: activeSwitch?.mode || extra.mode || null,
      model: activeSwitch?.model || extra.model || null,
      thinkingEffort: activeSwitch?.thinkingEffort || extra.thinkingEffort || null,
      autoReload: activeSwitch?.autoReload ?? extra.autoReload ?? true,
      conversationIdMatches: activeSwitch ? currentConversationId() === activeSwitch.conversationId : null,
      ...extra
    };
  }

  function disableSwitch(reason, extra = {}) {
    const previous = activeSwitch;
    activeSwitch = null;
    postSwitch("switch_state", switchSnapshot("disabled", reason, {
      mode: previous?.mode || null,
      model: previous?.model || null,
      thinkingEffort: previous?.thinkingEffort || null,
      autoReload: previous?.autoReload ?? true,
      ...extra
    }));
  }

  function armSwitch(payload) {
    const conversationId = currentConversationId();
    const config = SwitchCore?.buildConfig?.(payload?.mode, {
      model: payload?.model,
      thinkingEffort: payload?.thinkingEffort,
      autoReload: payload?.autoReload
    }, conversationId);
    if (!config || config.endpoint !== SwitchCore.ENDPOINT) {
      activeSwitch = null;
      postSwitch("switch_state", switchSnapshot("rejected", "invalid-config"));
      return;
    }
    switchSequence += 1;
    activeSwitch = {...config, switchSequence};
    postSwitch("switch_state", switchSnapshot("armed", null));
  }

  async function readRequestBody(input, init) {
    if (typeof init?.body === "string") return init.body;
    if (typeof Request !== "undefined" && input instanceof Request && init?.body == null) {
      try {
        return await input.clone().text();
      } catch {
        return null;
      }
    }
    return null;
  }

  async function prepareSwitchArgs(args, meta) {
    if (!activeSwitch || !SwitchCore || !meta.conversation || meta.path !== activeSwitch.endpoint) return {args, context: null};
    const currentId = currentConversationId();
    if (!currentId || currentId !== activeSwitch.conversationId) {
      disableSwitch("conversation-changed");
      return {args, context: null};
    }
    const bodyText = await readRequestBody(args[0], args[1]);
    if (typeof bodyText !== "string" || !bodyText.trim().startsWith("{")) return {args, context: null};
    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      postSwitch("switch_state", switchSnapshot("bypassed", "body-parse-failed"));
      return {args, context: null};
    }
    if (!Array.isArray(body?.messages)) return {args, context: null};
    const bodyConversationId = typeof body.conversation_id === "string" ? body.conversation_id : null;
    if (bodyConversationId && bodyConversationId !== currentId) {
      disableSwitch("conversation-id-mismatch");
      return {args, context: null};
    }
    const transformed = SwitchCore.transformBody(body, activeSwitch);
    if (!transformed.transformed) {
      if (transformed.status === "source-profile-mismatch") {
        postSwitch("switch_state", switchSnapshot("bypassed", transformed.status));
      }
      return {args, context: null};
    }
    const nextBody = JSON.stringify(transformed.body);
    const nextArgs = [...args];
    try {
      if (typeof Request !== "undefined" && args[0] instanceof Request) {
        nextArgs[0] = new Request(args[0], {...(args[1] || {}), body: nextBody});
        nextArgs[1] = undefined;
      } else {
        nextArgs[1] = {...(args[1] || {}), body: nextBody};
      }
    } catch {
      disableSwitch("request-rebuild-failure");
      return {args, context: null};
    }
    const context = {
      mode: activeSwitch.mode,
      conversationId: activeSwitch.conversationId,
      autoReload: activeSwitch.autoReload,
      switchSequence: activeSwitch.switchSequence,
      operationCount: transformed.applied
    };
    postSwitch("switch_state", switchSnapshot("applied", null, {operationCount: transformed.applied}));
    return {args: nextArgs, context};
  }

  async function monitorSwitchResponse(response, context) {
    if (!context) return;
    if (!response?.ok) {
      disableSwitch("http-failure", {statusCode: Number(response?.status) || null});
      return;
    }
    let clone;
    try {
      clone = response.clone();
    } catch {
      postSwitch("switch_state", switchSnapshot("response-ok", "clone-unavailable"));
      return;
    }
    const reader = clone.body?.getReader?.();
    if (reader) {
      try {
        while (true) {
          const {done} = await reader.read();
          if (done) break;
        }
      } catch {
        postSwitch("switch_state", switchSnapshot("response-ok", "completion-monitor-failed"));
        return;
      }
    }
    if (!activeSwitch || activeSwitch.switchSequence !== context.switchSequence) return;
    if (currentConversationId() !== context.conversationId) {
      disableSwitch("conversation-changed-after-response");
      return;
    }
    postSwitch("switch_state", switchSnapshot("complete", null, {operationCount: context.operationCount}));
    if (context.autoReload) setTimeout(() => location.reload(), 250);
  }

  function installFetchProbe() {
    const nativeFetch = globalThis.fetch;
    if (typeof nativeFetch !== "function") return false;
    const inspectedFetch = async function(...args) {
      const meta = requestMetadata(args[0], args[1]);
      const requestId = nextRequestId("fetch");
      if (enabled && meta.conversation) {
        post("transport_request", {transport: "fetch", requestId, method: meta.method, path: meta.path, category: "conversation"});
        stateSignal("PROMPT_SUBMITTED", {confidence: 0.9, reason: "same-origin conversation POST", source: "fetch", transport: "fetch", requestId});
      }
      const prepared = await prepareSwitchArgs(args, meta);
      let response;
      try {
        response = await Reflect.apply(nativeFetch, this, prepared.args);
      } catch (error) {
        if (prepared.context) disableSwitch("network-failure");
        if (enabled && meta.conversation) {
          post("transport_error", {transport: "fetch", requestId, path: meta.path, name: safeText(error?.name, 60) || "Error"});
          stateSignal("GENERATION_ERROR", {confidence: 0.9, reason: "conversation request rejected", source: "fetch", transport: "fetch", requestId});
        }
        throw error;
      }
      if (prepared.context) void monitorSwitchResponse(response, prepared.context);
      if (enabled) {
        try {
          const contentType = response.headers?.get?.("content-type") || "";
          const eventStream = /text\/event-stream/i.test(contentType);
          if (meta.conversation || eventStream) {
            post("transport_response", {transport: "fetch", requestId, path: meta.path, status: response.status, eventStream});
          }
          if (response.status >= 400 && meta.conversation) {
            stateSignal("GENERATION_ERROR", {confidence: 0.92, reason: `conversation response status ${response.status}`, source: "fetch", transport: "fetch", requestId});
          }
          if (eventStream && response.body) {
            const clone = response.clone();
            void inspectSseResponse(clone, {transport: "fetch-sse", requestId, path: meta.path, frameIndex: 0});
          }
        } catch (error) {
          post("probe_error", {stage: "fetch-response", name: safeText(error?.name, 60) || "Error", requestId, path: meta.path});
        }
      }
      return response;
    };
    try {
      Object.defineProperty(inspectedFetch, "name", {value: nativeFetch.name});
      Object.defineProperty(inspectedFetch, "length", {value: nativeFetch.length});
      inspectedFetch.toString = nativeFetch.toString.bind(nativeFetch);
    } catch {}
    globalThis.fetch = inspectedFetch;
    return true;
  }

  function socketAllowed(url) {
    const parsed = parsedUrl(url);
    if (!parsed) return false;
    return parsed.hostname === location.hostname || parsed.hostname.endsWith(".chatgpt.com") || parsed.hostname.endsWith(".openai.com");
  }

  function inspectSocketText(text, context) {
    if (!Protocol || typeof text !== "string") return;
    const trimmed = text.trim();
    if (!trimmed) return;
    if (trimmed.startsWith("data:")) {
      const data = trimmed.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
      context.frameIndex += 1;
      emitProtocolFrame({...context, eventName: null, result: Protocol.summarizeSseData(data)});
      return;
    }
    try {
      const summary = Protocol.summarizePayload(JSON.parse(trimmed), trimmed.length);
      context.frameIndex += 1;
      emitProtocolFrame({...context, eventName: null, result: {summary, signals: Protocol.detectSignals(summary)}});
    } catch {
      context.frameIndex += 1;
      emitProtocolFrame({...context, eventName: null, result: Protocol.summarizeSseData(trimmed)});
    }
  }

  async function inspectSocketData(data, context) {
    try {
      if (typeof data === "string") {
        inspectSocketText(data.slice(0, MAX_SOCKET_TEXT), context);
      } else if (typeof Blob !== "undefined" && data instanceof Blob) {
        if (data.size <= MAX_SOCKET_TEXT) inspectSocketText(await data.text(), context);
        else post("protocol_frame", {transport: context.transport, requestId: context.requestId, path: context.path, frameIndex: ++context.frameIndex, summary: {type: "binary_frame", byteLength: data.size, parseError: false}, signals: []});
      } else {
        const size = data?.byteLength ?? null;
        post("protocol_frame", {transport: context.transport, requestId: context.requestId, path: context.path, frameIndex: ++context.frameIndex, summary: {type: "binary_frame", byteLength: Number(size) || 0, parseError: false}, signals: []});
      }
    } catch (error) {
      post("probe_error", {stage: "websocket-message", name: safeText(error?.name, 60) || "Error", requestId: context.requestId, path: context.path});
    }
  }

  function installWebSocketProbe() {
    const NativeWebSocket = globalThis.WebSocket;
    if (typeof NativeWebSocket !== "function") return false;
    function InspectedWebSocket(url, protocols) {
      if (!new.target) return Reflect.apply(NativeWebSocket, this, arguments);
      const socket = arguments.length > 1 ? new NativeWebSocket(url, protocols) : new NativeWebSocket(url);
      if (!socketAllowed(url)) return socket;
      const parsed = parsedUrl(url);
      const context = {transport: "websocket", requestId: nextRequestId("ws"), path: parsed?.pathname?.slice(0, 240) || null, frameIndex: 0};
      socket.addEventListener("open", () => { if (enabled) post("transport_response", {...context, status: 101, eventStream: false}); });
      socket.addEventListener("message", (event) => { if (enabled) void inspectSocketData(event.data, context); });
      socket.addEventListener("close", (event) => { if (enabled) post("transport_complete", {...context, code: event.code, clean: event.wasClean, frames: context.frameIndex}); });
      socket.addEventListener("error", () => { if (enabled) post("transport_error", {...context, name: "WebSocketError"}); });
      return socket;
    }
    try {
      Object.setPrototypeOf(InspectedWebSocket, NativeWebSocket);
      InspectedWebSocket.prototype = NativeWebSocket.prototype;
      Object.defineProperty(InspectedWebSocket, "name", {value: NativeWebSocket.name});
      Object.defineProperty(InspectedWebSocket, "length", {value: NativeWebSocket.length});
      InspectedWebSocket.toString = NativeWebSocket.toString.bind(NativeWebSocket);
    } catch {}
    globalThis.WebSocket = InspectedWebSocket;
    return true;
  }

  definePublicState();
  const transports = Object.freeze({fetch: installFetchProbe(), websocket: installWebSocketProbe()});
  try {
    Object.defineProperty(globalThis, MARKER, {
      configurable: true,
      enumerable: false,
      value: Object.freeze({version: PROTOCOL_VERSION, transports, switchCore: SwitchCore?.BUILD_ID || null})
    });
  } catch {}

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const message = event.data;
    if (!message || typeof message !== "object") return;

    if (message.channel === SWITCH_CHANNEL && message.direction === "content") {
      const token = typeof message.token === "string" && message.token.length <= 100 ? message.token : null;
      if (!token) return;
      if (message.type === "init") {
        if (!switchBridgeToken || switchBridgeToken === token) switchBridgeToken = token;
        if (switchBridgeToken === token) postSwitch("switch_state", switchSnapshot("ready", null));
        return;
      }
      if (token !== switchBridgeToken) return;
      if (message.type === "set_switch") {
        armSwitch(message.payload || {});
        return;
      }
      if (message.type === "disable_switch") {
        disableSwitch("user-disabled");
        return;
      }
      if (message.type === "get_switch_state") {
        postSwitch("switch_state", switchSnapshot(activeSwitch ? "armed" : "ready", null));
      }
      return;
    }

    if (message.channel !== CHANNEL || message.direction !== "content") return;
    const token = typeof message.token === "string" && message.token.length <= 100 ? message.token : null;
    if (!token) return;
    if (message.type === "init") {
      bridgeToken = token;
      post("probe_ready", {protocolVersion: PROTOCOL_VERSION, transports});
      return;
    }
    if (token !== bridgeToken) return;
    if (message.type === "set_capture") {
      enabled = Boolean(message.payload?.enabled);
      post("capture_state", {enabled});
      return;
    }
    if (message.type === "publish_state") {
      publishedState = safePublicState(message.payload);
      try {
        window.dispatchEvent(new CustomEvent(PHASE_EVENT, {detail: publishedState}));
      } catch {}
    }
  });
})();
