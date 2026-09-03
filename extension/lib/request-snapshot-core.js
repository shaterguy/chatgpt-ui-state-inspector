(() => {
  'use strict';

  const BLOCKED_KEYS = new Set([
    'id', 'conversation_id', 'parent_message_id', 'message_id', 'current_node',
    'request_id', 'client_request_id', 'user_id', 'account_id', 'workspace_id',
    'prompt', 'input', 'text', 'content', 'parts', 'messages', 'message',
    'attachments', 'attachment', 'files', 'file', 'image', 'audio',
    'authorization', 'cookie', 'set-cookie', 'client_contextual_info'
  ]);
  const BLOCKED_PATTERN = /(token|secret|credential|password|cookie|authorization|session)/i;
  const VOLATILE_PATTERN = /^(time_since_loaded|timestamp|request_time|screen_|viewport_|window_|pixel_ratio|timezone_)/i;
  const LIKELY_UUID = /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i;
  const LIKELY_LONG_OPAQUE = /^[A-Za-z0-9_\-./+=]{64,}$/;
  const LIKELY_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function shouldSkipKey(key) {
    const lower = String(key).toLowerCase();
    return BLOCKED_KEYS.has(lower)
      || /_ids?$/.test(lower)
      || BLOCKED_PATTERN.test(lower)
      || VOLATILE_PATTERN.test(lower);
  }

  function safePrimitive(value) {
    if (value === null || typeof value === 'boolean' || typeof value === 'number') return true;
    if (typeof value !== 'string') return false;
    if (value.length === 0 || value.length > 160) return false;
    if (/^https?:\/\//i.test(value) || LIKELY_EMAIL.test(value)) return false;
    if (LIKELY_UUID.test(value) || LIKELY_LONG_OPAQUE.test(value)) return false;
    return true;
  }

  function collectLeaves(value, path = [], depth = 0, out = []) {
    if (depth > 8) return out;
    if (Array.isArray(value)) {
      if (path.length && value.length <= 16 && value.every(safePrimitive)) {
        out.push({ path: [...path], value: value.slice() });
      }
      return out;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (shouldSkipKey(key)) continue;
        collectLeaves(child, [...path, key], depth + 1, out);
      }
      return out;
    }
    if (path.length && safePrimitive(value)) out.push({ path: [...path], value });
    return out;
  }

  function parseUrl(url, origin = 'https://chatgpt.com') {
    try { return new URL(url, origin); } catch { return null; }
  }

  function isConversationCandidate(url, method, body, origin = 'https://chatgpt.com') {
    if (String(method || 'GET').toUpperCase() !== 'POST') return false;
    const parsed = parseUrl(url, origin);
    if (!parsed || parsed.origin !== origin || !parsed.pathname.includes('/backend-api/')) return false;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
    return Array.isArray(body.messages);
  }

  function buildSnapshot(body, meta = {}) {
    const hasConversationId = typeof body?.conversation_id === 'string' && body.conversation_id.length > 0;
    const hasParentMessageId = typeof body?.parent_message_id === 'string' && body.parent_message_id.length > 0;
    return {
      schemaVersion: 1,
      capturedAt: meta.capturedAt || new Date().toISOString(),
      endpoint: meta.endpoint || null,
      method: String(meta.method || 'POST').toUpperCase(),
      transport: meta.transport || null,
      page: {
        routeKind: meta.routeKind || null,
        projectContext: Boolean(meta.projectContext),
        hasUrlConversationId: Boolean(meta.hasUrlConversationId)
      },
      requestShape: {
        hasConversationId,
        hasParentMessageId,
        messageCount: Array.isArray(body?.messages) ? body.messages.length : null,
        action: safePrimitive(body?.action) ? body.action : null,
        turnClass: hasConversationId || meta.hasUrlConversationId ? 'followup' : 'first'
      },
      leaves: collectLeaves(body)
    };
  }

  const pathKey = (path) => JSON.stringify(path);
  const valueKey = (value) => JSON.stringify(value);

  function leafMap(snapshot) {
    const map = new Map();
    for (const leaf of snapshot?.leaves || []) {
      if (!Array.isArray(leaf?.path) || leaf.path.length === 0) continue;
      map.set(pathKey(leaf.path), { path: leaf.path, value: leaf.value });
    }
    return map;
  }

  function diffSnapshots(base, target) {
    const left = leafMap(base);
    const right = leafMap(target);
    const changed = [];
    const added = [];
    const removed = [];

    for (const [key, item] of right) {
      const before = left.get(key);
      if (!before) added.push({ path: item.path, value: item.value });
      else if (valueKey(before.value) !== valueKey(item.value)) {
        changed.push({ path: item.path, from: before.value, to: item.value });
      }
    }
    for (const [key, item] of left) {
      if (!right.has(key)) removed.push({ path: item.path, value: item.value });
    }
    return { changed, added, removed, differenceCount: changed.length + added.length + removed.length };
  }

  function normalizeList(input) {
    const raw = Array.isArray(input) ? input : String(input || '').split(/[\n,]+/);
    const seen = new Set();
    const result = [];
    for (const item of raw) {
      const value = String(item || '').trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      result.push(value);
    }
    return result;
  }

  function buildScenarioPlan(config = {}) {
    const chatModels = normalizeList(config.chatModels);
    const chatReasoning = normalizeList(config.chatReasoning);
    const workModels = normalizeList(config.workModels);
    const workReasoning = normalizeList(config.workReasoning);
    const lists = { chatModels, chatReasoning, workModels, workReasoning };
    if (Object.values(lists).some((list) => list.length === 0)) {
      return { version: 1, config: lists, scenarios: [], requiredCount: 0, optionalCount: 0, error: '네 옵션 목록을 모두 1개 이상 입력해야 합니다.' };
    }

    const scenarios = [];
    let order = 0;
    const add = (data) => scenarios.push({ order: ++order, required: true, ...data });
    const chatBaseModel = chatModels[0];
    const chatBaseReasoning = chatReasoning[0];
    const workBaseModel = workModels[0];
    const workBaseReasoning = workReasoning[0];

    add({
      id: 'chat-first-base', mode: 'chat', phase: 'first', group: 'chat-first',
      model: chatBaseModel, reasoning: chatBaseReasoning, compareTo: null,
      instruction: `새 Chat 대화를 열고 모델 '${chatBaseModel}', 추론 '${chatBaseReasoning}' 상태에서 짧은 프롬프트를 1회 전송합니다.`
    });
    chatReasoning.slice(1).forEach((reasoning, index) => add({
      id: `chat-first-reasoning-${index + 1}`, mode: 'chat', phase: 'first', group: 'chat-first',
      model: chatBaseModel, reasoning, compareTo: 'chat-first-base',
      instruction: `새 Chat 대화를 열고 모델은 '${chatBaseModel}' 그대로, 추론만 '${reasoning}'으로 바꾼 뒤 1회 전송합니다.`
    }));
    chatModels.slice(1).forEach((model, index) => add({
      id: `chat-first-model-${index + 1}`, mode: 'chat', phase: 'first', group: 'chat-first',
      model, reasoning: chatBaseReasoning, compareTo: 'chat-first-base',
      instruction: `새 Chat 대화를 열고 추론은 '${chatBaseReasoning}' 그대로, 모델만 '${model}'로 바꾼 뒤 1회 전송합니다.`
    }));

    add({
      id: 'work-first-base', mode: 'work', phase: 'first', group: 'work-first',
      model: workBaseModel, reasoning: workBaseReasoning, compareTo: null,
      instruction: `새 Work 대화를 열고 모델 '${workBaseModel}', 추론 '${workBaseReasoning}' 상태에서 첫 프롬프트를 1회 전송합니다. 이 대화는 다음 Work 후속 턴 실험에 계속 사용합니다.`
    });
    add({
      id: 'work-followup-base', mode: 'work', phase: 'followup', group: 'work-followup',
      model: workBaseModel, reasoning: workBaseReasoning, compareTo: null,
      instruction: `방금 만든 동일 Work 대화에서 모델 '${workBaseModel}', 추론 '${workBaseReasoning}'을 유지한 채 다음 턴을 1회 전송합니다.`
    });
    workModels.slice(1).forEach((model, index) => add({
      id: `work-followup-model-${index + 1}`, mode: 'work', phase: 'followup', group: 'work-followup',
      model, reasoning: workBaseReasoning, compareTo: 'work-followup-base',
      instruction: `동일 Work 대화를 계속 사용합니다. 추론은 '${workBaseReasoning}' 그대로 두고 이번 턴 모델만 '${model}'로 바꾼 뒤 1회 전송합니다.`
    }));
    workReasoning.slice(1).forEach((reasoning, index) => add({
      id: `work-followup-reasoning-${index + 1}`, mode: 'work', phase: 'followup', group: 'work-followup',
      model: workBaseModel, reasoning, compareTo: 'work-followup-base',
      instruction: `동일 Work 대화를 계속 사용합니다. 모델을 '${workBaseModel}'로 두고 이번 턴 추론만 '${reasoning}'으로 바꾼 뒤 1회 전송합니다.`
    }));
    if (workModels.length > 1 && workReasoning.length > 1) {
      scenarios.push({
        order: ++order, required: false, id: 'work-followup-cross-check', mode: 'work', phase: 'followup', group: 'work-followup',
        model: workModels[1], reasoning: workReasoning[1], compareTo: 'work-followup-base',
        instruction: `선택 교차검증입니다. 동일 Work 대화에서 모델 '${workModels[1]}'와 추론 '${workReasoning[1]}'을 동시에 적용하고 1회 전송합니다.`
      });
    }

    workReasoning.slice(1).forEach((reasoning, index) => add({
      id: `work-first-reasoning-${index + 1}`, mode: 'work', phase: 'first', group: 'work-first',
      model: workBaseModel, reasoning, compareTo: 'work-first-base',
      instruction: `새 Work 대화를 열고 모델은 '${workBaseModel}' 그대로, 추론만 '${reasoning}'으로 설정하여 첫 프롬프트를 1회 전송합니다.`
    }));
    workModels.slice(1).forEach((model, index) => add({
      id: `work-first-model-${index + 1}`, mode: 'work', phase: 'first', group: 'work-first',
      model, reasoning: workBaseReasoning, compareTo: 'work-first-base',
      instruction: `새 Work 대화를 열고 추론은 '${workBaseReasoning}' 그대로, 모델만 '${model}'로 설정하여 첫 프롬프트를 1회 전송합니다.`
    }));

    return {
      version: 1,
      config: lists,
      scenarios,
      requiredCount: scenarios.filter((item) => item.required).length,
      optionalCount: scenarios.filter((item) => !item.required).length,
      error: null
    };
  }

  function latestCaptureMap(captures = []) {
    const map = new Map();
    for (const capture of captures) {
      if (!capture?.scenarioId) continue;
      map.set(capture.scenarioId, capture);
    }
    return map;
  }

  function buildAnalysis(plan, captures = []) {
    const latest = latestCaptureMap(captures);
    const comparisons = [];
    for (const scenario of plan?.scenarios || []) {
      if (!scenario.compareTo) continue;
      const base = latest.get(scenario.compareTo);
      const target = latest.get(scenario.id);
      comparisons.push({
        scenarioId: scenario.id,
        compareTo: scenario.compareTo,
        available: Boolean(base && target),
        diff: base && target ? diffSnapshots(base.snapshot, target.snapshot) : null
      });
    }
    return comparisons;
  }

  globalThis.ChatGptRequestSnapshotCore = {
    collectLeaves,
    isConversationCandidate,
    buildSnapshot,
    diffSnapshots,
    normalizeList,
    buildScenarioPlan,
    buildAnalysis
  };
})();