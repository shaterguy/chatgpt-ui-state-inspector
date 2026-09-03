(() => {
  'use strict';

  const core = globalThis.ChatGptRequestSnapshotCore;
  const CONFIG_KEY = 'chatGptRequestSnapshotConfigV1';
  const CAPTURES_KEY = 'chatGptRequestSnapshotCapturesV1';
  const SOURCE = 'chatgpt-request-snapshot-panel';

  const els = {
    chatModels: document.getElementById('chat-models'),
    chatReasoning: document.getElementById('chat-reasoning'),
    workModels: document.getElementById('work-models'),
    workReasoning: document.getElementById('work-reasoning'),
    generate: document.getElementById('generate-scenarios'),
    resetCaptures: document.getElementById('reset-captures'),
    planSummary: document.getElementById('plan-summary'),
    scenarioList: document.getElementById('scenario-list'),
    armNext: document.getElementById('arm-next'),
    armedStatus: document.getElementById('armed-status'),
    copyJson: document.getElementById('copy-request-json'),
    downloadJson: document.getElementById('download-request-json'),
    exportPreview: document.getElementById('request-export-preview'),
    status: document.getElementById('request-capture-status'),
    tabStatus: document.getElementById('request-tab-status')
  };

  if (!core || Object.values(els).some((node) => !node)) return;

  let plan = null;
  let captures = [];
  let activeTabId = null;
  let activeScenario = null;

  function setStatus(text, kind = 'info') {
    els.status.textContent = text;
    els.status.dataset.kind = kind;
  }

  function configFromInputs() {
    return {
      chatModels: core.normalizeList(els.chatModels.value),
      chatReasoning: core.normalizeList(els.chatReasoning.value),
      workModels: core.normalizeList(els.workModels.value),
      workReasoning: core.normalizeList(els.workReasoning.value)
    };
  }

  function putConfig(config) {
    els.chatModels.value = (config.chatModels || []).join('\n');
    els.chatReasoning.value = (config.chatReasoning || []).join('\n');
    els.workModels.value = (config.workModels || []).join('\n');
    els.workReasoning.value = (config.workReasoning || []).join('\n');
  }

  async function currentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('활성 탭을 찾지 못했습니다.');
    activeTabId = tab.id;
    return tab;
  }

  async function send(type, payload = {}) {
    if (!activeTabId) await currentTab();
    try {
      const response = await chrome.tabs.sendMessage(activeTabId, { source: SOURCE, type, ...payload });
      els.tabStatus.textContent = 'ChatGPT 연결';
      return response;
    } catch {
      throw new Error('현재 ChatGPT 탭의 API 요청 캡처기와 연결되지 않았습니다. 설치 직후라면 ChatGPT 탭을 한 번 새로고침해 주세요.');
    }
  }

  function captureCounts() {
    const counts = new Map();
    for (const capture of captures) counts.set(capture.scenarioId, (counts.get(capture.scenarioId) || 0) + 1);
    return counts;
  }

  function render() {
    if (!plan || plan.error) {
      els.planSummary.textContent = plan?.error || '모델/추론 목록을 입력해 주세요.';
      els.scenarioList.replaceChildren();
      els.armNext.disabled = true;
      updateExport();
      return;
    }
    const counts = captureCounts();
    const completedRequired = plan.scenarios.filter((item) => item.required && counts.has(item.id)).length;
    els.planSummary.textContent = `필수 ${plan.requiredCount}회 · 완료 ${completedRequired}/${plan.requiredCount} · 선택 ${plan.optionalCount}회`;
    els.armNext.disabled = completedRequired >= plan.requiredCount;
    els.scenarioList.replaceChildren();

    for (const scenario of plan.scenarios) {
      const count = counts.get(scenario.id) || 0;
      const card = document.createElement('div');
      card.className = 'request-scenario';
      card.dataset.done = count > 0 ? 'true' : 'false';

      const top = document.createElement('div');
      top.className = 'request-scenario-top';
      const title = document.createElement('div');
      title.className = 'request-scenario-title';
      title.textContent = `${scenario.order}. ${scenario.mode.toUpperCase()} · ${scenario.phase === 'first' ? '첫 턴' : '후속 턴'}`;
      const tag = document.createElement('span');
      tag.className = scenario.required ? 'request-tag' : 'request-tag optional';
      tag.textContent = scenario.required ? '필수' : '선택';
      title.appendChild(tag);
      if (count) {
        const done = document.createElement('span');
        done.className = 'request-tag done';
        done.textContent = `캡처 ${count}`;
        title.appendChild(done);
      }
      const button = document.createElement('button');
      button.className = 'ghost request-arm';
      button.textContent = activeScenario?.id === scenario.id ? '대기 중' : '이 시나리오 대기';
      button.disabled = activeScenario?.id === scenario.id;
      button.addEventListener('click', () => armScenario(scenario));
      top.append(title, button);

      const meta = document.createElement('div');
      meta.className = 'request-scenario-meta';
      meta.textContent = `모델: ${scenario.model} · 추론: ${scenario.reasoning}`;
      const instruction = document.createElement('div');
      instruction.className = 'request-scenario-instruction';
      instruction.textContent = scenario.instruction;
      card.append(top, meta, instruction);
      els.scenarioList.appendChild(card);
    }
    els.armedStatus.textContent = activeScenario
      ? `캡처 대기: ${activeScenario.order}. ${activeScenario.mode.toUpperCase()} · ${activeScenario.model} · ${activeScenario.reasoning}`
      : '대기 중인 시나리오 없음';
    els.armedStatus.dataset.active = activeScenario ? 'true' : 'false';
    updateExport();
  }

  async function armScenario(scenario) {
    try {
      const response = await send('RS_ARM_SCENARIO', { scenario });
      if (!response?.ok) throw new Error(response?.error || '캡처 대기 설정에 실패했습니다.');
      activeScenario = scenario;
      render();
      setStatus('ChatGPT UI에서 표시된 모델·추론 상태를 맞춘 뒤 프롬프트를 1회 전송하세요. 그 conversation POST 요청의 안전한 제어값만 캡처합니다.', 'warn');
    } catch (error) {
      setStatus(error.message || String(error), 'error');
    }
  }

  function nextMissingScenario() {
    if (!plan?.scenarios) return null;
    const counts = captureCounts();
    return plan.scenarios.find((item) => item.required && !counts.has(item.id)) || null;
  }

  function exportObject() {
    const analysis = plan && !plan.error ? core.buildAnalysis(plan, captures) : [];
    return {
      schema: 'chatgpt-request-snapshot-calibration-v1',
      extensionVersion: '0.2.0-dev3',
      exportedAt: new Date().toISOString(),
      privacy: {
        promptTextStored: false,
        messageContentStored: false,
        attachmentsStored: false,
        identifiersStored: false,
        authOrCookieStored: false
      },
      plan,
      captures,
      comparisons: analysis
    };
  }

  function updateExport() {
    els.exportPreview.value = JSON.stringify(exportObject(), null, 2);
  }

  async function load() {
    const stored = await chrome.storage.local.get([CONFIG_KEY, CAPTURES_KEY]);
    const config = stored[CONFIG_KEY] || { chatModels: [], chatReasoning: [], workModels: [], workReasoning: [] };
    captures = Array.isArray(stored[CAPTURES_KEY]) ? stored[CAPTURES_KEY] : [];
    putConfig(config);
    plan = core.buildScenarioPlan(config);
    try {
      await currentTab();
      const tabState = await send('RS_GET_STATE');
      activeScenario = tabState?.activeScenario || null;
      setStatus(plan.error ? plan.error : '준비되었습니다. 다음 미캡처 시나리오부터 진행하세요.', plan.error ? 'warn' : 'ok');
    } catch (error) {
      els.tabStatus.textContent = '연결 실패';
      setStatus(error.message || String(error), 'error');
    }
    render();
  }

  els.generate.addEventListener('click', async () => {
    const config = configFromInputs();
    plan = core.buildScenarioPlan(config);
    await chrome.storage.local.set({ [CONFIG_KEY]: config });
    render();
    setStatus(plan.error || `최소 필수 캡처 ${plan.requiredCount}개를 생성했습니다.`, plan.error ? 'error' : 'ok');
  });

  els.armNext.addEventListener('click', () => {
    const scenario = nextMissingScenario();
    if (scenario) armScenario(scenario);
  });

  els.resetCaptures.addEventListener('click', async () => {
    await chrome.storage.local.set({ [CAPTURES_KEY]: [] });
    captures = [];
    activeScenario = null;
    try { await send('RS_DISARM'); } catch {}
    render();
    setStatus('API 요청 캡처 결과만 초기화했습니다. 모델·추론 목록은 유지됩니다.', 'ok');
  });

  els.copyJson.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(exportObject(), null, 2));
      setStatus('모델·추론별 API 요청 스냅샷 JSON을 복사했습니다.', 'ok');
    } catch (error) {
      setStatus(`복사 실패: ${error?.message || error}`, 'error');
    }
  });

  els.downloadJson.addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(exportObject(), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `chatgpt-request-snapshots-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus('API 요청 스냅샷 JSON 파일 저장을 시작했습니다.', 'ok');
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[CAPTURES_KEY]) return;
    captures = Array.isArray(changes[CAPTURES_KEY].newValue) ? changes[CAPTURES_KEY].newValue : [];
    if (activeScenario && captures.some((item) => item.scenarioId === activeScenario.id)) activeScenario = null;
    render();
  });

  load().catch((error) => setStatus(error.message || String(error), 'error'));
})();