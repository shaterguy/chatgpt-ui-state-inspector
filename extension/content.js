(() => {
  "use strict";

  const Core = globalThis.UiStateInspectorCore;
  const TurnState = globalThis.UiStateInspectorTurnState;
  if (!Core || !TurnState) return;
  if (globalThis.__CHATGPT_UI_STATE_INSPECTOR_CONTENT_LOADED__) return;
  globalThis.__CHATGPT_UI_STATE_INSPECTOR_CONTENT_LOADED__ = true;

  const PROTOCOL_VERSION = "1.1.0";
  const BRIDGE_CHANNEL = "chatgpt-ui-state-inspector@1";
  const bridgeToken = crypto.randomUUID();
  const INTERACTIVE_SELECTOR = [
    "button", "select", "option", "a[href]", "input",
    "[role]", "[data-testid]", "[data-state]",
    "[aria-selected]", "[aria-checked]", "[aria-pressed]", "[aria-expanded]"
  ].join(",");
  const ASSISTANT_SELECTOR = "[data-message-author-role='assistant']";

  let active = false;
  let sessionId = null;
  let title = "";
  let seq = 0;
  let buffer = [];
  let flushTimer = null;
  let flushPromise = Promise.resolve();
  let observer = null;
  let urlTimer = null;
  let lastUrl = location.href;
  let latestClick = null;
  let mutationBuckets = new Map();
  let mutationFlushTimer = null;
  let domScanTimer = null;
  let lastDomState = null;
  let assistantBaselineCount = 0;
  let protocolFrameCount = 0;
  let turnTracker = TurnState.createTracker();
  const recent = [];
  const probe = {ready: false, enabled: false, transports: null};
  let bridgeTimer = null;

  function nowRecordBase(type) {
    return {
      schemaVersion: "1.1.0",
      sessionId,
      seq: ++seq,
      eventId: crypto.randomUUID(),
      type,
      timestamp: new Date().toISOString(),
      performanceMs: Math.round(performance.now() * 1000) / 1000,
      url: {
        origin: location.origin,
        pathname: location.pathname
      },
      viewport: {
        width: innerWidth,
        height: innerHeight,
        devicePixelRatio
      }
    };
  }

  function eventLabel(type, payload) {
    if (type === "turn_state_transition") {
      return `${payload.transition?.previousPhase || "?"}→${payload.transition?.phase || "?"}`;
    }
    if (type === "protocol_state_signal" || type === "turn_state_signal") {
      return payload.signal || payload.code || type;
    }
    return type;
  }

  function queueEvent(type, payload = {}) {
    if (!active) return null;
    const event = {...nowRecordBase(type), ...payload};
    buffer.push(event);
    recent.push({seq: event.seq, type: event.type, label: eventLabel(type, payload), timestamp: event.timestamp});
    if (recent.length > 14) recent.shift();
    if (buffer.length >= 10) {
      void flush();
    } else if (!flushTimer) {
      flushTimer = setTimeout(() => void flush(), 220);
    }
    return event;
  }

  function flush() {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    const persistNextBatch = async () => {
      if (!buffer.length || !sessionId) return;
      const events = buffer;
      buffer = [];
      try {
        const response = await chrome.runtime.sendMessage({type: "APPEND_EVENTS", sessionId, events});
        if (!response?.ok) throw new Error(response?.error || "Could not save events.");
      } catch (error) {
        buffer.unshift(...events);
        console.warn("[ChatGPT UI State Inspector] save retry scheduled", error);
        if (!flushTimer) flushTimer = setTimeout(() => void flush(), 1000);
        throw error;
      }
    };
    flushPromise = flushPromise.then(persistNextBatch, persistNextBatch);
    return flushPromise;
  }

  function isVisible(element) {
    if (!element?.getBoundingClientRect) return false;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function uniqueElements(elements, limit) {
    const seen = new Set();
    const result = [];
    for (const element of elements) {
      if (!element?.tagName || seen.has(element) || !isVisible(element)) continue;
      seen.add(element);
      result.push(element);
      if (result.length >= limit) break;
    }
    return result;
  }

  function globalSnapshot(limit = 180) {
    const candidates = document.querySelectorAll(INTERACTIVE_SELECTOR);
    return uniqueElements(candidates, limit).map(Core.describeElement).filter(Boolean);
  }

  function relevantSnapshot(target, phase) {
    const candidates = [];
    let current = target;
    for (let depth = 0; current?.tagName && depth < 5; depth += 1) {
      candidates.push(current);
      current.querySelectorAll?.(INTERACTIVE_SELECTOR).forEach((item) => candidates.push(item));
      current = current.parentElement;
    }
    document.querySelectorAll([
      "[role='menu']", "[role='listbox']", "[role='dialog']", "[role='alertdialog']",
      "[data-state='open']", "[aria-selected='true']", "[aria-checked='true']",
      "[aria-pressed='true']", "[aria-expanded='true']"
    ].join(",")).forEach((root) => {
      candidates.push(root);
      root.querySelectorAll?.(INTERACTIVE_SELECTOR).forEach((item) => candidates.push(item));
    });
    return {
      phase,
      activeElement: Core.describeElement(document.activeElement),
      elements: uniqueElements(candidates, 140).map(Core.describeElement).filter(Boolean)
    };
  }

  function composedPath(path) {
    return path
      .filter((node) => node?.tagName)
      .slice(0, 8)
      .map(Core.describeElement)
      .filter(Boolean);
  }

  function postBridge(type, payload = {}) {
    try {
      window.postMessage({
        channel: BRIDGE_CHANNEL,
        direction: "content",
        token: bridgeToken,
        type,
        payload
      }, location.origin);
    } catch {}
  }

  function publishTurnState() {
    postBridge("publish_state", turnTracker.snapshot());
  }

  function setProbeCapture(enabled) {
    if (!probe.ready) return;
    postBridge("set_capture", {enabled: Boolean(enabled)});
  }

  function startBridgeHandshake() {
    const announce = () => postBridge("init", {protocolVersion: PROTOCOL_VERSION});
    announce();
    if (!bridgeTimer) {
      bridgeTimer = setInterval(() => {
        if (probe.ready) {
          clearInterval(bridgeTimer);
          bridgeTimer = null;
        } else {
          announce();
        }
      }, 300);
    }
  }

  function ingestStateSignal(signal, meta = {}) {
    const result = turnTracker.ingest(signal, meta);
    queueEvent("turn_state_signal", {
      signal,
      source: meta.source || "unknown",
      confidence: meta.confidence ?? null,
      reason: meta.reason || null,
      state: result.state
    });
    for (const transition of result.transitions) {
      queueEvent("turn_state_transition", {transition, state: result.state});
    }
    publishTurnState();
    return result;
  }

  function assistantNodes() {
    return [...document.querySelectorAll(ASSISTANT_SELECTOR)];
  }

  function latestAssistantRoot() {
    return assistantNodes().at(-1) || null;
  }

  function hasVisibleAssistantText(root) {
    if (!root) return false;
    const markdown = [...root.querySelectorAll(".markdown, [class*='markdown']")].find(isVisible);
    const surface = markdown || root.querySelector("p, pre, code, li, blockquote, table, h1, h2, h3, h4");
    if (!surface || !isVisible(surface)) return false;
    return Boolean(String(surface.textContent || "").replace(/\s+/g, "").trim());
  }

  function readStatusText() {
    const regions = [...document.querySelectorAll("[role='status'][aria-live]")]
      .filter(isVisible)
      .filter((node) => !node.closest("[data-message-author-role], article"));
    for (const node of regions.reverse()) {
      const text = Core.sanitizeText(node.textContent, 80);
      if (text) return text;
    }
    return null;
  }

  function classifyStatus(text) {
    const value = String(text || "");
    if (/\b(thinking|reasoning|working|generating)\b|생각|추론|작성 중|응답 중/i.test(value)) return "thinking";
    if (/response complete|generation complete|finished|응답 완료|답변 완료|완료됨/i.test(value)) return "complete";
    return "other";
  }

  function domStateSnapshot() {
    const assistants = assistantNodes();
    const latest = assistants.at(-1) || null;
    const statusText = readStatusText();
    const statusKind = classifyStatus(statusText);
    const stopButton = [...document.querySelectorAll("[data-testid='stop-button'], button[data-testid*='stop']")].find(isVisible);
    const streamMarker = [...document.querySelectorAll("[class*='group-data-stream'], [data-state='streaming']")].find(isVisible);
    const completionAction = Boolean(latest?.querySelector?.("[data-testid='copy-turn-action-button']"));
    const state = {
      generationActive: Boolean(stopButton || streamMarker || statusKind === "thinking"),
      statusText,
      statusKind,
      assistantTurnCount: assistants.length,
      assistantVisibleAnswer: hasVisibleAssistantText(latest),
      completionAction
    };
    state.fingerprint = JSON.stringify(state);
    return state;
  }

  function scheduleDomScan(reason = "mutation") {
    if (!active || domScanTimer) return;
    domScanTimer = setTimeout(() => {
      domScanTimer = null;
      scanDomState(reason);
    }, 80);
  }

  function notePromptSubmitted(source, reason, confidence = 0.86) {
    const phase = turnTracker.snapshot().phase;
    if (phase !== "THINKING" && phase !== "ANSWERING") assistantBaselineCount = assistantNodes().length;
    return ingestStateSignal("PROMPT_SUBMITTED", {source, reason, confidence});
  }

  function scanDomState(reason = "manual") {
    if (!active) return;
    const previous = lastDomState;
    const current = domStateSnapshot();
    if (!previous || previous.fingerprint !== current.fingerprint) {
      queueEvent("dom_state_sample", {
        reason,
        dom: {
          generationActive: current.generationActive,
          statusText: current.statusText,
          statusKind: current.statusKind,
          assistantTurnCount: current.assistantTurnCount,
          assistantVisibleAnswer: current.assistantVisibleAnswer,
          completionAction: current.completionAction
        }
      });
    }

    const phaseBefore = turnTracker.snapshot().phase;
    if (current.generationActive && phaseBefore !== "THINKING" && phaseBefore !== "ANSWERING") {
      assistantBaselineCount = Math.max(0, current.assistantTurnCount - (current.assistantVisibleAnswer ? 1 : 0));
      ingestStateSignal("GENERATION_ACTIVE", {
        source: "dom",
        reason: current.statusKind === "thinking" ? "live status reports thinking" : "generation control is active",
        confidence: current.statusKind === "thinking" ? 0.9 : 0.82
      });
    }

    const currentPhase = turnTracker.snapshot().phase;
    const currentTurnVisible = current.assistantTurnCount > assistantBaselineCount || currentPhase === "THINKING" || currentPhase === "ANSWERING";
    if (current.assistantVisibleAnswer && currentTurnVisible && !turnTracker.snapshot().sawVisibleAnswer) {
      ingestStateSignal("VISIBLE_ANSWER", {
        source: "dom",
        reason: "latest assistant turn has visible rendered text",
        confidence: 0.84
      });
    }

    const activePhase = ["THINKING", "ANSWERING"].includes(turnTracker.snapshot().phase);
    if (activePhase && !current.generationActive) {
      if (current.statusKind === "complete") {
        ingestStateSignal("DOM_COMPLETE", {
          source: "dom",
          reason: "live status reports response complete",
          confidence: 0.92
        });
      } else if (previous?.generationActive && (current.assistantVisibleAnswer || current.completionAction)) {
        ingestStateSignal("GENERATION_INACTIVE", {
          source: "dom",
          reason: "generation control disappeared after output",
          confidence: 0.84
        });
      } else if (current.completionAction && current.assistantTurnCount > assistantBaselineCount) {
        ingestStateSignal("DOM_COMPLETE", {
          source: "dom",
          reason: "completion action is available on the new assistant turn",
          confidence: 0.82
        });
      }
    }
    lastDomState = current;
  }

  function isComposerForm(form) {
    return Boolean(form?.querySelector?.("#prompt-textarea, textarea, [contenteditable='true'], [contenteditable='plaintext-only']"));
  }

  function handleSubmit(event) {
    if (!active || !event.isTrusted || !isComposerForm(event.target)) return;
    notePromptSubmitted("dom-submit", "trusted composer form submission", 0.9);
    scheduleDomScan("submit");
  }

  function handleClick(event) {
    if (!active || !event.isTrusted) return;
    const target = event.composedPath().find((node) => node?.nodeType === 1);
    if (!target) return;
    const submitControl = target.closest?.("[data-testid='send-button'], button[type='submit']");
    if (submitControl && isComposerForm(submitControl.closest("form"))) {
      notePromptSubmitted("dom-click", "trusted composer send control", 0.88);
      scheduleDomScan("send-click");
    }
    const record = queueEvent("click", {
      pointer: {
        button: event.button,
        clientX: Math.round(event.clientX),
        clientY: Math.round(event.clientY),
        normalizedX: innerWidth ? Math.round((event.clientX / innerWidth) * 10000) / 10000 : null,
        normalizedY: innerHeight ? Math.round((event.clientY / innerHeight) * 10000) / 10000 : null,
        detail: event.detail,
        modifiers: {
          alt: event.altKey,
          ctrl: event.ctrlKey,
          meta: event.metaKey,
          shift: event.shiftKey
        }
      },
      target: Core.describeElement(target),
      composedPath: composedPath(event.composedPath()),
      before: relevantSnapshot(target, "before-click")
    });
    if (!record) return;
    latestClick = {eventId: record.eventId, target, expiresAt: performance.now() + 1800};

    for (const [delay, phase] of [[0, "after-microtask"], [250, "after-250ms"], [900, "after-900ms"]]) {
      setTimeout(() => {
        if (!active) return;
        queueEvent("ui_snapshot", {
          causedByClickId: record.eventId,
          snapshot: relevantSnapshot(target, phase)
        });
      }, delay);
    }
  }

  function lengthBucket(length) {
    if (!length) return 0;
    if (length <= 32) return 32;
    if (length <= 128) return 128;
    if (length <= 512) return 512;
    return 513;
  }

  function summarizeMutation(mutation) {
    if (mutation.type === "attributes") {
      const name = mutation.attributeName;
      const rawNew = mutation.target.getAttribute?.(name);
      const sanitize = name === "aria-label" || name === "title";
      return {
        kind: "attribute",
        attribute: name,
        oldValue: sanitize ? Core.sanitizeText(mutation.oldValue, 100) : String(mutation.oldValue ?? "").slice(0, 160),
        newValue: sanitize ? Core.sanitizeText(rawNew, 100) : String(rawNew ?? "").slice(0, 160),
        target: Core.describeNode(mutation.target)
      };
    }
    if (mutation.type === "characterData") {
      return {
        kind: "characterData",
        target: Core.describeNode(mutation.target.parentElement),
        lengthBucket: lengthBucket(mutation.target.data?.length)
      };
    }
    return {
      kind: "childList",
      target: Core.describeNode(mutation.target),
      added: [...mutation.addedNodes].slice(0, 12).map(Core.describeNode),
      removed: [...mutation.removedNodes].slice(0, 12).map(Core.describeNode),
      addedCount: mutation.addedNodes.length,
      removedCount: mutation.removedNodes.length
    };
  }

  function handleMutations(mutations) {
    if (!active) return;
    const click = latestClick && latestClick.expiresAt >= performance.now() ? latestClick : null;
    const key = click?.eventId || "ambient";
    const bucket = mutationBuckets.get(key) || {
      causedByClickId: click?.eventId || null,
      firstSeenAt: new Date().toISOString(),
      characterDataCount: 0,
      mutations: []
    };
    for (const mutation of mutations) {
      if (mutation.type === "characterData") {
        bucket.characterDataCount += 1;
        if (bucket.characterDataCount <= 3 && bucket.mutations.length < 200) bucket.mutations.push(summarizeMutation(mutation));
      } else if (bucket.mutations.length < 200) {
        bucket.mutations.push(summarizeMutation(mutation));
      }
    }
    mutationBuckets.set(key, bucket);
    if (!mutationFlushTimer) mutationFlushTimer = setTimeout(flushMutationBuckets, 140);
    scheduleDomScan("mutation");
  }

  function flushMutationBuckets() {
    mutationFlushTimer = null;
    for (const bucket of mutationBuckets.values()) {
      queueEvent(bucket.causedByClickId ? "dom_mutation_batch" : "ambient_mutation_batch", bucket);
    }
    mutationBuckets = new Map();
  }

  function startObservers() {
    document.addEventListener("click", handleClick, true);
    document.addEventListener("submit", handleSubmit, true);
    observer = new MutationObserver(handleMutations);
    const root = document.documentElement;
    if (root) {
      observer.observe(root, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
        attributeOldValue: true,
        attributeFilter: [
          "id", "role", "class", "title", "disabled", "checked",
          "aria-label", "aria-checked", "aria-selected", "aria-pressed",
          "aria-expanded", "aria-current", "aria-haspopup", "aria-controls",
          "data-testid", "data-state", "data-value"
        ]
      });
    }
    lastUrl = location.href;
    urlTimer = setInterval(() => {
      if (location.href === lastUrl) return;
      const previous = new URL(lastUrl);
      const current = new URL(location.href);
      lastUrl = location.href;
      queueEvent("navigation", {
        previous: {origin: previous.origin, pathname: previous.pathname},
        current: {origin: current.origin, pathname: current.pathname}
      });
    }, 500);
  }

  function stopObservers() {
    document.removeEventListener("click", handleClick, true);
    document.removeEventListener("submit", handleSubmit, true);
    observer?.disconnect();
    observer = null;
    if (urlTimer) clearInterval(urlTimer);
    urlTimer = null;
    if (mutationFlushTimer) clearTimeout(mutationFlushTimer);
    if (domScanTimer) clearTimeout(domScanTimer);
    domScanTimer = null;
    flushMutationBuckets();
  }

  function validProbeMessage(message) {
    if (!message || message.channel !== BRIDGE_CHANNEL || message.direction !== "probe" || message.token !== bridgeToken) return false;
    try {
      return JSON.stringify(message).length <= 50000;
    } catch {
      return false;
    }
  }

  function handleProbeMessage(event) {
    if (event.source !== window || event.origin !== location.origin || !validProbeMessage(event.data)) return;
    const {type, payload = {}} = event.data;
    if (type === "probe_ready") {
      probe.ready = true;
      probe.transports = payload.transports || null;
      if (bridgeTimer) {
        clearInterval(bridgeTimer);
        bridgeTimer = null;
      }
      setProbeCapture(active);
      publishTurnState();
      queueEvent("probe_status", {status: "ready", protocolVersion: payload.protocolVersion, transports: probe.transports});
      return;
    }
    if (type === "capture_state") {
      probe.enabled = Boolean(payload.enabled);
      queueEvent("probe_status", {status: probe.enabled ? "enabled" : "disabled"});
      return;
    }
    if (!active) return;
    if (type === "protocol_frame") {
      protocolFrameCount += 1;
      queueEvent("protocol_frame", {probe: payload});
      return;
    }
    if (type === "state_signal") {
      const code = String(payload.code || "").toUpperCase();
      queueEvent("protocol_state_signal", {
        code,
        confidence: payload.confidence ?? null,
        reason: payload.reason || null,
        transport: payload.transport || null,
        requestId: payload.requestId || null
      });
      if (code === "PROMPT_SUBMITTED") {
        notePromptSubmitted(payload.source || "protocol", payload.reason || "protocol request", payload.confidence || 0.9);
      } else {
        ingestStateSignal(code, {
          source: payload.source || "protocol",
          reason: payload.reason,
          confidence: payload.confidence,
          timestamp: payload.timestamp
        });
      }
      scheduleDomScan("protocol-signal");
      return;
    }
    if (["transport_request", "transport_response", "transport_complete", "transport_error", "probe_error"].includes(type)) {
      queueEvent(type === "probe_error" ? "probe_error" : "protocol_transport", {phase: type, probe: payload});
    }
  }

  async function begin(meta, resumed = false) {
    if (active) throw new Error("이미 기록 중입니다.");
    active = true;
    sessionId = meta.id;
    title = meta.title;
    seq = Number(meta.lastSeq) || 0;
    buffer = [];
    recent.length = 0;
    protocolFrameCount = 0;
    assistantBaselineCount = assistantNodes().length;
    turnTracker = TurnState.createTracker(meta.lastTurnState || null);
    lastDomState = null;
    startObservers();
    startBridgeHandshake();
    setProbeCapture(true);
    publishTurnState();
    queueEvent(resumed ? "session_resumed" : "session_started", {
      title,
      protocolVersion: PROTOCOL_VERSION,
      document: {
        readyState: document.readyState,
        language: document.documentElement?.lang || null
      },
      turnState: turnTracker.snapshot(),
      baseline: globalSnapshot()
    });
    scanDomState("session-start");
    await flush();
    return status();
  }

  async function finish() {
    if (!active) return status();
    queueEvent("session_completed", {
      title,
      turnState: turnTracker.snapshot(),
      protocolFrameCount,
      finalSnapshot: globalSnapshot()
    });
    setProbeCapture(false);
    stopObservers();
    await flush();
    const id = sessionId;
    const response = await chrome.runtime.sendMessage({type: "COMPLETE_SESSION", sessionId: id});
    if (!response?.ok) throw new Error(response?.error || "기록을 종료하지 못했습니다.");
    active = false;
    sessionId = null;
    title = "";
    return {active: false, completedSessionId: id, protocolVersion: PROTOCOL_VERSION, turnState: turnTracker.snapshot()};
  }

  function status() {
    return {
      protocolVersion: PROTOCOL_VERSION,
      active,
      sessionId,
      title,
      seq,
      pendingEvents: buffer.length,
      recent: [...recent],
      turnState: turnTracker.snapshot(),
      probe: {...probe, protocolFrameCount},
      domState: lastDomState ? {
        generationActive: lastDomState.generationActive,
        statusText: lastDomState.statusText,
        statusKind: lastDomState.statusKind,
        assistantTurnCount: lastDomState.assistantTurnCount,
        assistantVisibleAnswer: lastDomState.assistantVisibleAnswer,
        completionAction: lastDomState.completionAction
      } : null
    };
  }

  window.addEventListener("message", handleProbeMessage);
  startBridgeHandshake();

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return false;
    if (message?.type === "START_RECORDING") {
      begin(message.session, false)
        .then((result) => sendResponse({ok: true, result}))
        .catch((error) => sendResponse({ok: false, error: error.message}));
      return true;
    }
    if (message?.type === "STOP_RECORDING") {
      finish()
        .then((result) => sendResponse({ok: true, result}))
        .catch((error) => sendResponse({ok: false, error: error.message}));
      return true;
    }
    if (message?.type === "GET_RECORDING_STATUS") {
      sendResponse({ok: true, result: status()});
      return false;
    }
    return false;
  });

  chrome.runtime.sendMessage({type: "GET_ACTIVE_FOR_TAB"})
    .then((response) => {
      if (response?.ok && response.result && !active) return begin(response.result, true);
      return null;
    })
    .catch(() => {});
})();
