(() => {
  'use strict';

  const CHANNEL = 'chatgpt-request-snapshot-v1';
  const SOURCE = 'chatgpt-request-snapshot-panel';
  const ENABLED_KEY = 'chatGptRequestProfileCaptureEnabledV2';
  let bridgeReady = false;
  let captureEnabled = false;

  function postToBridge(type, payload = {}) {
    window.postMessage({ channel: CHANNEL, direction: 'extension-to-bridge', type, ...payload }, location.origin);
  }

  function syncBridgeState() {
    if (bridgeReady) postToBridge('RS_SET_CAPTURE_ENABLED', { enabled: captureEnabled });
  }

  async function hydrateCaptureState() {
    const stored = await chrome.storage.local.get(ENABLED_KEY);
    captureEnabled = stored[ENABLED_KEY] === true;
    syncBridgeState();
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL || data.direction !== 'bridge-to-extension') return;

    if (data.type === 'RS_BRIDGE_READY') {
      bridgeReady = true;
      syncBridgeState();
      return;
    }
    if (data.type === 'RS_CAPTURE_STATE') return;
    if (data.type !== 'RS_CAPTURED' || !captureEnabled) return;

    chrome.runtime.sendMessage({
      type: 'SAVE_REQUEST_PROFILE_CAPTURE',
      captureId: data.captureId,
      profile: data.profile,
      profileKey: data.profileKey,
      snapshot: data.snapshot
    }).catch(() => {});
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[ENABLED_KEY]) return;
    captureEnabled = changes[ENABLED_KEY].newValue === true;
    syncBridgeState();
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.source !== SOURCE) return false;
    if (message.type === 'RS_GET_STATE') {
      sendResponse({ ok: true, bridgeReady, captureEnabled });
      return false;
    }
    return false;
  });

  hydrateCaptureState().catch(() => {});
})();