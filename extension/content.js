(() => {
  "use strict";

  if (globalThis.__CHATGPT_UI_STATE_INSPECTOR_CONTENT_LOADED__) return;
  globalThis.__CHATGPT_UI_STATE_INSPECTOR_CONTENT_LOADED__ = true;

  const Core = globalThis.UiStateInspectorCore;
  const INTERACTIVE_SELECTOR = [
    "button", "select", "option", "a[href]", "input",
    "[role]", "[data-testid]", "[data-state]",
    "[aria-selected]", "[aria-checked]", "[aria-pressed]", "[aria-expanded]"
  ].join(",");

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
  const recent = [];

  function nowRecordBase(type) {
    return {
      schemaVersion: "1.0.0",
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

  function queueEvent(type, payload = {}) {
    if (!active) return null;
    const event = {...nowRecordBase(type), ...payload};
    buffer.push(event);
    recent.push({seq: event.seq, type: event.type, timestamp: event.timestamp});
    if (recent.length > 12) recent.shift();
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

  function handleClick(event) {
    if (!active || !event.isTrusted) return;
    const target = event.composedPath().find((node) => node?.nodeType === 1);
    if (!target) return;
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
      mutations: []
    };
    for (const mutation of mutations) {
      if (bucket.mutations.length >= 200) break;
      bucket.mutations.push(summarizeMutation(mutation));
    }
    mutationBuckets.set(key, bucket);
    if (!mutationFlushTimer) mutationFlushTimer = setTimeout(flushMutationBuckets, 140);
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
    observer = new MutationObserver(handleMutations);
    const root = document.documentElement;
    if (root) {
      observer.observe(root, {
        subtree: true,
        childList: true,
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
    observer?.disconnect();
    observer = null;
    if (urlTimer) clearInterval(urlTimer);
    urlTimer = null;
    if (mutationFlushTimer) clearTimeout(mutationFlushTimer);
    flushMutationBuckets();
  }

  async function begin(meta, resumed = false) {
    if (active) throw new Error("이미 기록 중입니다.");
    active = true;
    sessionId = meta.id;
    title = meta.title;
    seq = Number(meta.lastSeq) || 0;
    buffer = [];
    recent.length = 0;
    startObservers();
    queueEvent(resumed ? "session_resumed" : "session_started", {
      title,
      document: {
        readyState: document.readyState,
        language: document.documentElement?.lang || null
      },
      baseline: globalSnapshot()
    });
    await flush();
    return status();
  }

  async function finish() {
    if (!active) return status();
    queueEvent("session_completed", {
      title,
      finalSnapshot: globalSnapshot()
    });
    stopObservers();
    await flush();
    const id = sessionId;
    const response = await chrome.runtime.sendMessage({type: "COMPLETE_SESSION", sessionId: id});
    if (!response?.ok) throw new Error(response?.error || "기록을 종료하지 못했습니다.");
    active = false;
    sessionId = null;
    title = "";
    return {active: false, completedSessionId: id};
  }

  function status() {
    return {active, sessionId, title, seq, pendingEvents: buffer.length, recent: [...recent]};
  }

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
