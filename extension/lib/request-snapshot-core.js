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
  const MODEL_KEYS = ['model', 'model_slug', 'selected_model'];
  const REASONING_KEYS = ['thinking_effort', 'reasoning_effort', 'reasoning_level', 'thinking_level', 'reasoning', 'effort'];
  const GPT56_VISIBLE_LABELS = new Map([
    ['gpt-5-6\u0000', '즉시'],
    ['gpt-5-6-thinking\u0000standard', '중간'],
    ['gpt-5-6-thinking\u0000medium', '중간'],
    ['gpt-5-6-thinking\u0000extended', '높음'],
    ['gpt-5-6-thinking\u0000high', '높음'],
    ['gpt-5-6-thinking\u0000max', '매우 높음'],
    ['gpt-5-6-thinking\u0000heavy', '매우 높음'],
    ['gpt-5-6-thinking\u0000xhigh', '매우 높음'],
    ['gpt-5-6-thinking\u0000extra_high', '매우 높음'],
    ['gpt-5-6-thinking\u0000extra-high', '매우 높음'],
    ['gpt-5-6-pro\u0000standard', 'Pro 표준'],
    ['gpt-5-6-pro\u0000medium', 'Pro 표준'],
    ['gpt-5-6-pro\u0000extended', 'Pro 확장'],
    ['gpt-5-6-pro\u0000high', 'Pro 확장']
  ]);

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

  function findControlLeaf(snapshot, candidates, stringOnly = false) {
    const leaves = Array.isArray(snapshot?.leaves) ? snapshot.leaves : [];
    for (const candidate of candidates) {
      for (const topLevelOnly of [true, false]) {
        const leaf = leaves.find((item) => {
          if (!Array.isArray(item?.path) || item.path.length === 0) return false;
          if (topLevelOnly && item.path.length !== 1) return false;
          const key = String(item.path[item.path.length - 1]).toLowerCase();
          if (key !== candidate) return false;
          if (stringOnly) return typeof item.value === 'string' && safePrimitive(item.value);
          return !Array.isArray(item.value) && safePrimitive(item.value);
        });
        if (leaf) return { value: leaf.value, path: leaf.path.slice() };
      }
    }
    return null;
  }

  function requestProfileFromSnapshot(snapshot) {
    const model = findControlLeaf(snapshot, MODEL_KEYS, true);
    if (!model) return null;
    const reasoning = findControlLeaf(snapshot, REASONING_KEYS, false);
    return {
      model: model.value,
      reasoning: reasoning ? reasoning.value : null,
      modelPath: model.path,
      reasoningPath: reasoning ? reasoning.path : null
    };
  }

  function requestProfileKey(profile) {
    if (!profile || typeof profile.model !== 'string' || !profile.model) return null;
    return JSON.stringify([profile.model, profile.reasoning ?? null]);
  }

  function normalizedControl(value) {
    return value === null || value === undefined ? '' : String(value).trim().toLowerCase();
  }

  function humanizeModelSlug(value) {
    const raw = String(value || '').trim();
    if (!raw) return '(model 없음)';
    const match = /^gpt-(\d+)-(\d+)(?:-(.+))?$/i.exec(raw);
    if (!match) return raw;
    const suffix = match[3]
      ? ` ${match[3].split('-').filter(Boolean).map((part) => {
          const lower = part.toLowerCase();
          if (lower === 'pro') return 'Pro';
          if (lower === 'gpt') return 'GPT';
          return `${part.charAt(0).toUpperCase()}${part.slice(1)}`;
        }).join(' ')}`
      : '';
    return `GPT-${match[1]}.${match[2]}${suffix}`;
  }

  function userVisibleProfileName(profile) {
    const model = normalizedControl(profile?.model);
    const reasoning = normalizedControl(profile?.reasoning);
    const exact = GPT56_VISIBLE_LABELS.get(`${model}\u0000${reasoning}`);
    if (exact) return exact;
    if (model === 'gpt-5-6-pro' && !reasoning) return 'Pro';
    const friendlyModel = humanizeModelSlug(profile?.model);
    return reasoning ? `${friendlyModel} · ${String(profile.reasoning)}` : friendlyModel;
  }

  function internalProfileLabel(profile) {
    const model = typeof profile?.model === 'string' && profile.model ? profile.model : '(model 없음)';
    const reasoning = profile?.reasoning === null || profile?.reasoning === undefined || profile?.reasoning === ''
      ? '기본'
      : String(profile.reasoning);
    return `${model} · 추론 ${reasoning}`;
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

  globalThis.ChatGptRequestSnapshotCore = {
    collectLeaves,
    isConversationCandidate,
    buildSnapshot,
    requestProfileFromSnapshot,
    requestProfileKey,
    humanizeModelSlug,
    userVisibleProfileName,
    internalProfileLabel,
    diffSnapshots
  };
})();