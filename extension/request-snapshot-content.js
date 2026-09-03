(() => {
  'use strict';

  const CHANNEL = 'chatgpt-request-snapshot-v1';
  const CAPTURES_KEY = 'chatGptRequestSnapshotCapturesV1';
  const MAX_PER_SCENARIO = 3;
  const SOURCE = 'chatgpt-request-snapshot-panel';
  let bridgeReady = false;
  let activeScenario = null;
  let pendingScenario = null;

  function post(type, payload = {}) {
    try {
      window.postMessage({ channel: CHANNEL, direction: 'extension-to-bridge', type, ...payload }, location.origin);
    } catch {}
  }

  async function saveCapture(data) {
    const stored = await chrome.storage.local.get(CAPTURES_KEY);
    let captures = Array.isArray(stored[CAPTURES_KEY]) ? stored[CAPTURES_KEY] : [];
    const scenario = activeScenario?.id === data.scenarioId
      ? activeScenario
      : { id: data.scenarioId, mode: null, phase: null, model: null, reasoning: null };
    captures.push({
      captureId: data.captureId,
      scenarioId: data.scenarioId,
      scenario,
      snapshot: data.snapshot,
      savedAt: new Date().toISOString()
    });

    const same = captures.filter((item) => item.scenarioId === data.scenarioId);
    if (same.length > MAX_PER_SCENARIO) {
      const removeIds = new Set(same.slice(0, same.length - MAX_PER_SCENARIO).map((item) => item.captureId));
      captures = captures.filter((item) => !removeIds.has(item.captureId));
    }
    if (captures.length > 250) captures = captures.slice(-250);
    await chrome.storage.local.set({ [CAPTURES_KEY]: captures });
    activeScenario = null;
    pendingScenario = null;
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.direction !== 'bridge-to-extension') return;
    if (data.type === 'RS_BRIDGE_READY') {
      bridgeReady = true;
      if (pendingScenario) post('RS_ARM_CAPTURE', { scenarioId: pendingScenario.id });
    } else if (data.type === 'RS_CAPTURED') {
      saveCapture(data).catch(() => {});
    } else if (data.type === 'RS_ARM_STATE' && !data.scenarioId) {
      pendingScenario = null;
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || message?.source !== SOURCE) return false;
    (async () => {
      if (message.type === 'RS_GET_STATE') {
        return { ok: true, bridgeReady, activeScenario };
      }
      if (message.type === 'RS_ARM_SCENARIO') {
        if (!message.scenario?.id) throw new Error('시나리오 ID가 없습니다.');
        activeScenario = message.scenario;
        pendingScenario = bridgeReady ? null : message.scenario;
        if (bridgeReady) post('RS_ARM_CAPTURE', { scenarioId: message.scenario.id });
        return { ok: true, bridgeReady, activeScenario };
      }
      if (message.type === 'RS_DISARM') {
        activeScenario = null;
        pendingScenario = null;
        if (bridgeReady) post('RS_DISARM_CAPTURE');
        return { ok: true };
      }
      return { ok: false, error: '지원하지 않는 메시지입니다.' };
    })().then(sendResponse, (error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  });
})();