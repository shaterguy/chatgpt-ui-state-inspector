(() => {
  'use strict';

  const CHANNEL = 'chatgpt-request-snapshot-v1';
  const MARKER = '__CHATGPT_REQUEST_SNAPSHOT_PROBE__';
  const core = globalThis.ChatGptRequestSnapshotCore;
  if (!core || globalThis[MARKER]) return;
  globalThis[MARKER] = true;

  let armedScenarioId = null;
  let sequence = 0;

  function emit(type, payload = {}) {
    try {
      window.postMessage({ channel: CHANNEL, direction: 'bridge-to-extension', type, ...payload }, location.origin);
    } catch {}
  }

  function currentConversationId() {
    return location.pathname.match(/\/c\/([0-9a-z-]+)/i)?.[1] || null;
  }

  function routeKind() {
    if (currentConversationId()) return location.pathname.includes('/g/') ? 'project-conversation' : 'conversation';
    if (location.pathname.includes('/g/') || location.pathname.includes('/project')) return 'project-new';
    return 'new-or-home';
  }

  function inspect(url, method, body, transport) {
    if (!armedScenarioId || !core.isConversationCandidate(url, method, body, location.origin)) return null;
    let endpoint = null;
    try { endpoint = new URL(url, location.href).pathname; } catch {}
    const scenarioId = armedScenarioId;
    armedScenarioId = null;
    const captureId = `capture-${Date.now()}-${++sequence}`;
    const snapshot = core.buildSnapshot(body, {
      capturedAt: new Date().toISOString(),
      endpoint,
      method,
      transport,
      routeKind: routeKind(),
      projectContext: location.pathname.includes('/g/') || location.pathname.includes('/project'),
      hasUrlConversationId: Boolean(currentConversationId())
    });
    emit('RS_CAPTURED', { captureId, scenarioId, snapshot });
    emit('RS_ARM_STATE', { scenarioId: null });
    return captureId;
  }

  function parseBody(text) {
    if (typeof text !== 'string' || !text.trim().startsWith('{')) return null;
    try { return JSON.parse(text); } catch { return null; }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.direction !== 'extension-to-bridge') return;
    if (data.type === 'RS_ARM_CAPTURE') {
      armedScenarioId = typeof data.scenarioId === 'string' && data.scenarioId ? data.scenarioId : null;
      emit('RS_ARM_STATE', { scenarioId: armedScenarioId });
    } else if (data.type === 'RS_DISARM_CAPTURE') {
      armedScenarioId = null;
      emit('RS_ARM_STATE', { scenarioId: null });
    }
  });

  const originalFetch = window.fetch;
  function requestSnapshotFetch(input, init) {
    if (!armedScenarioId) return Reflect.apply(originalFetch, this, arguments);
    const url = typeof input === 'string' || input instanceof URL ? String(input) : input?.url;
    const method = init?.method || input?.method || 'GET';

    if (typeof init?.body === 'string') {
      const body = parseBody(init.body);
      if (body) inspect(url, method, body, 'fetch');
      return Reflect.apply(originalFetch, this, arguments);
    }

    if (typeof Request !== 'undefined' && input instanceof Request && !init?.body) {
      try {
        input.clone().text().then((text) => {
          const body = parseBody(text);
          if (body) inspect(url, method, body, 'fetch-request');
        }).catch(() => {});
      } catch {}
    }
    return Reflect.apply(originalFetch, this, arguments);
  }
  try {
    Object.defineProperty(requestSnapshotFetch, 'name', { value: originalFetch.name });
    Object.defineProperty(requestSnapshotFetch, 'length', { value: originalFetch.length });
    requestSnapshotFetch.toString = originalFetch.toString.bind(originalFetch);
  } catch {}
  window.fetch = requestSnapshotFetch;

  const xhrMeta = new WeakMap();
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    xhrMeta.set(this, { method, url: String(url) });
    return Reflect.apply(originalOpen, this, [method, url, ...rest]);
  };
  XMLHttpRequest.prototype.send = function(body) {
    if (armedScenarioId && typeof body === 'string') {
      const meta = xhrMeta.get(this);
      const parsed = parseBody(body);
      if (meta && parsed) inspect(meta.url, meta.method, parsed, 'xhr');
    }
    return Reflect.apply(originalSend, this, arguments);
  };

  emit('RS_BRIDGE_READY', { captureOnly: true });
})();