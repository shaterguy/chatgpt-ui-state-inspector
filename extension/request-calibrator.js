(() => {
  'use strict';

  const core = globalThis.ChatGptRequestSnapshotCore;
  const ENABLED_KEY = 'chatGptRequestProfileCaptureEnabledV2';
  const PROFILES_KEY = 'chatGptRequestProfilesV2';
  const LEGACY_CAPTURES_KEY = 'chatGptRequestSnapshotCapturesV1';

  const els = {
    start: document.getElementById('start-request-capture'),
    stop: document.getElementById('stop-request-capture'),
    reset: document.getElementById('reset-captures'),
    summary: document.getElementById('request-profile-summary'),
    profileList: document.getElementById('request-profile-list'),
    copyJson: document.getElementById('copy-request-json'),
    downloadJson: document.getElementById('download-request-json'),
    exportPreview: document.getElementById('request-export-preview'),
    status: document.getElementById('request-capture-status'),
    tabStatus: document.getElementById('request-tab-status')
  };

  if (!core || Object.values(els).some((node) => !node)) return;

  let captureEnabled = false;
  let profiles = [];
  let legacyCaptures = [];
  let refreshing = false;
  let refreshQueued = false;

  function setStatus(text, kind = 'info') {
    els.status.textContent = text;
    els.status.dataset.kind = kind;
  }

  async function callBackground(type, payload = {}) {
    const response = await chrome.runtime.sendMessage({type, ...payload});
    if (!response?.ok) throw new Error(response?.error || `${type} 요청에 실패했습니다.`);
    return response.result;
  }

  function decoratedProfiles() {
    return profiles.map((record) => ({
      ...record,
      displayName: core.userVisibleProfileName(record?.profile),
      internalCombination: core.internalProfileLabel(record?.profile)
    }));
  }

  function exportObject() {
    return {
      schema: 'chatgpt-request-profile-capture-v2',
      extensionVersion: '0.2.0-dev5',
      exportedAt: new Date().toISOString(),
      captureEnabled,
      profileCount: profiles.length,
      deduplication: {
        key: ['model', 'reasoning'],
        duplicatePolicy: 'skip'
      },
      retention: {
        persistentStorage: 'chrome.storage.local',
        automaticTruncation: false,
        explicitClearOnly: true
      },
      privacy: {
        promptTextStored: false,
        messageContentStored: false,
        attachmentsStored: false,
        identifiersStored: false,
        authOrCookieStored: false,
        externalTransmission: false
      },
      profiles: decoratedProfiles(),
      legacyScenarioCaptures: legacyCaptures
    };
  }

  function render() {
    els.start.disabled = captureEnabled;
    els.stop.disabled = !captureEnabled;
    els.tabStatus.textContent = captureEnabled ? '자동 캡처 중' : '캡처 중지';
    els.summary.textContent = `${captureEnabled ? '캡처 중' : '중지됨'} · 저장된 고유 모델×추론 조합 ${profiles.length}개${legacyCaptures.length ? ` · dev3 원본 ${legacyCaptures.length}개 보존` : ''}`;
    els.profileList.replaceChildren();

    if (!profiles.length) {
      const empty = document.createElement('div');
      empty.className = 'request-scenario';
      empty.textContent = '아직 저장된 조합이 없습니다. 캡처를 시작한 뒤 평소처럼 대화를 전송하면 자동으로 쌓입니다.';
      els.profileList.appendChild(empty);
    } else {
      profiles.forEach((record, index) => {
        const displayName = core.userVisibleProfileName(record?.profile);
        const internalCombination = core.internalProfileLabel(record?.profile);
        const card = document.createElement('div');
        card.className = 'request-scenario';
        const title = document.createElement('div');
        title.className = 'request-scenario-title';
        title.textContent = `${index + 1}. ${displayName}`;
        const internal = document.createElement('div');
        internal.className = 'request-scenario-meta';
        internal.textContent = `내부 조합: ${internalCombination}`;
        const detail = document.createElement('div');
        detail.className = 'request-scenario-instruction';
        const capturedAt = record?.firstCapturedAt || record?.savedAt || '';
        detail.textContent = `${record?.migratedFrom ? 'dev3 이관' : '자동 캡처'}${capturedAt ? ` · ${capturedAt}` : ''}`;
        card.append(title, internal, detail);
        els.profileList.appendChild(card);
      });
    }
    els.exportPreview.value = JSON.stringify(exportObject(), null, 2);
  }

  async function refreshState({quiet = false} = {}) {
    if (refreshing) {
      refreshQueued = true;
      return;
    }
    refreshing = true;
    let announce = !quiet;
    try {
      do {
        refreshQueued = false;
        const state = await callBackground('GET_REQUEST_PROFILE_STATE');
        captureEnabled = state?.captureEnabled === true;
        profiles = Array.isArray(state?.profiles) ? state.profiles : [];
        legacyCaptures = Array.isArray(state?.legacyCaptures) ? state.legacyCaptures : [];
        render();
        if (announce) {
          setStatus(
            captureEnabled
              ? '자동 캡처가 활성화되어 있습니다. 평소처럼 대화를 보내면 새로운 모델×추론 조합만 계속 저장합니다.'
              : '캡처 중지 상태입니다. 시작 버튼을 누르면 시나리오 설정 없이 자동 수집합니다.',
            captureEnabled ? 'ok' : 'info'
          );
          announce = false;
        }
        await Promise.resolve();
      } while (refreshQueued);
    } finally {
      refreshing = false;
    }
  }

  els.start.addEventListener('click', async () => {
    try {
      await callBackground('SET_REQUEST_PROFILE_CAPTURE_ENABLED', {enabled: true});
      await refreshState({quiet: true});
      setStatus('자동 캡처를 시작했습니다. 이제 사용자가 대화를 전송할 때마다 실제 요청의 모델×추론 조합을 확인하고, 처음 보는 조합만 저장합니다.', 'ok');
    } catch (error) {
      setStatus(error.message || String(error), 'error');
    }
  });

  els.stop.addEventListener('click', async () => {
    try {
      await callBackground('SET_REQUEST_PROFILE_CAPTURE_ENABLED', {enabled: false});
      await refreshState({quiet: true});
      setStatus('자동 캡처를 중지했습니다. 지금까지 저장한 값은 그대로 유지됩니다.', 'ok');
    } catch (error) {
      setStatus(error.message || String(error), 'error');
    }
  });

  els.reset.addEventListener('click', async () => {
    try {
      await callBackground('RESET_REQUEST_PROFILES');
      await refreshState({quiet: true});
      setStatus('저장된 API 요청 프로필과 dev3 캡처 원본을 초기화했습니다. 캡처 활성화 상태는 변경하지 않았습니다.', 'ok');
    } catch (error) {
      setStatus(error.message || String(error), 'error');
    }
  });

  els.copyJson.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(exportObject(), null, 2));
      setStatus('누적 API 요청 프로필 JSON을 복사했습니다.', 'ok');
    } catch (error) {
      setStatus(`복사 실패: ${error?.message || error}`, 'error');
    }
  });

  els.downloadJson.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(exportObject(), null, 2)], {type: 'application/json'});
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `chatgpt-request-profiles-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('누적 API 요청 프로필 JSON 파일 저장을 시작했습니다.', 'ok');
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!changes[ENABLED_KEY] && !changes[PROFILES_KEY] && !changes[LEGACY_CAPTURES_KEY]) return;
    refreshState({quiet: true}).catch(() => {});
  });

  refreshState().catch((error) => setStatus(error.message || String(error), 'error'));
})();