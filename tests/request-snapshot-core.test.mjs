import test from 'node:test';
import assert from 'node:assert/strict';
import '../extension/lib/request-snapshot-core.js';

const core = globalThis.ChatGptRequestSnapshotCore;

test('captures model/reasoning control primitives but excludes messages, identifiers and auth-like values', () => {
  const body = {
    action: 'next',
    model: 'gpt-test-model',
    thinking_effort: 'high',
    conversation_origin: 'tpp',
    feature_enabled: true,
    conversation_id: '123e4567-e89b-12d3-a456-426614174000',
    parent_message_id: '223e4567-e89b-12d3-a456-426614174000',
    account_id: '323e4567-e89b-12d3-a456-426614174000',
    messages: [{ content: { parts: ['TOP SECRET PROMPT'] } }],
    token: 'secret-token',
    client_contextual_info: { time_since_loaded: 12, screen_width: 1000 }
  };
  const snap = core.buildSnapshot(body, { endpoint: '/backend-api/f/conversation', hasUrlConversationId: false });
  const paths = new Map(snap.leaves.map((leaf) => [JSON.stringify(leaf.path), leaf.value]));
  assert.equal(paths.get('["model"]'), 'gpt-test-model');
  assert.equal(paths.get('["thinking_effort"]'), 'high');
  assert.equal(paths.get('["conversation_origin"]'), 'tpp');
  assert.equal(paths.get('["feature_enabled"]'), true);
  assert.equal(paths.has('["conversation_id"]'), false);
  assert.equal(paths.has('["account_id"]'), false);
  assert.equal([...paths.keys()].some((key) => key.includes('messages') || key.includes('token') || key.includes('client_contextual_info')), false);
  assert.equal(snap.requestShape.hasConversationId, true);
  assert.equal(snap.requestShape.hasParentMessageId, true);
  assert.equal(snap.requestShape.messageCount, 1);
});

test('conversation candidate ignores menu traffic and accepts actual conversation sends', () => {
  assert.equal(core.isConversationCandidate('/backend-api/settings', 'POST', { selected_model: 'x' }), false);
  assert.equal(core.isConversationCandidate('/backend-api/f/conversation', 'POST', { action: 'next', messages: [] }), true);
  assert.equal(core.isConversationCandidate('/backend-api/f/conversation', 'GET', { action: 'next', messages: [] }), false);
  assert.equal(core.isConversationCandidate('https://example.com/backend-api/f/conversation', 'POST', { action: 'next', messages: [] }), false);
});

test('derives an exact model/reasoning profile key from the sanitized snapshot', () => {
  const snapshot = core.buildSnapshot({
    action: 'next',
    model: 'gpt-test-model',
    thinking_effort: 'high',
    messages: []
  });
  const profile = core.requestProfileFromSnapshot(snapshot);
  assert.deepEqual(profile, {
    model: 'gpt-test-model',
    reasoning: 'high',
    modelPath: ['model'],
    reasoningPath: ['thinking_effort']
  });
  assert.equal(core.requestProfileKey(profile), '["gpt-test-model","high"]');
});

test('accepts a model with no explicit reasoning value as the default/null combination', () => {
  const snapshot = core.buildSnapshot({action: 'next', model: 'gpt-test-model', messages: []});
  const profile = core.requestProfileFromSnapshot(snapshot);
  assert.equal(profile.model, 'gpt-test-model');
  assert.equal(profile.reasoning, null);
  assert.equal(profile.reasoningPath, null);
  assert.equal(core.requestProfileKey(profile), '["gpt-test-model",null]');
});

test('prefers top-level model/reasoning controls and falls back to safe nested aliases', () => {
  const topLevel = core.buildSnapshot({
    action: 'next',
    model: 'top-model',
    thinking_effort: 'high',
    client: {model: 'nested-model', thinking_effort: 'low'},
    messages: []
  });
  assert.equal(core.requestProfileFromSnapshot(topLevel).model, 'top-model');
  assert.equal(core.requestProfileFromSnapshot(topLevel).reasoning, 'high');

  const nested = core.buildSnapshot({
    action: 'next',
    controls: {selected_model: 'nested-model', reasoning_effort: 'max'},
    messages: []
  });
  assert.deepEqual(core.requestProfileFromSnapshot(nested), {
    model: 'nested-model',
    reasoning: 'max',
    modelPath: ['controls', 'selected_model'],
    reasoningPath: ['controls', 'reasoning_effort']
  });
});

test('maps known GPT-5.6 request combinations to the current visible picker labels', () => {
  assert.equal(core.userVisibleProfileName({model: 'gpt-5-6', reasoning: null}), '즉시');
  assert.equal(core.userVisibleProfileName({model: 'gpt-5-6-thinking', reasoning: 'standard'}), '중간');
  assert.equal(core.userVisibleProfileName({model: 'gpt-5-6-thinking', reasoning: 'extended'}), '높음');
  assert.equal(core.userVisibleProfileName({model: 'gpt-5-6-thinking', reasoning: 'max'}), '매우 높음');
  assert.equal(core.userVisibleProfileName({model: 'gpt-5-6-pro', reasoning: 'standard'}), 'Pro 표준');
  assert.equal(core.userVisibleProfileName({model: 'gpt-5-6-pro', reasoning: 'extended'}), 'Pro 확장');
});

test('keeps the internal model/reasoning combination visible alongside the friendly label', () => {
  const profile = {model: 'gpt-5-6-thinking', reasoning: 'max'};
  assert.equal(core.userVisibleProfileName(profile), '매우 높음');
  assert.equal(core.internalProfileLabel(profile), 'gpt-5-6-thinking · 추론 max');
});

test('falls back without inventing a picker label for unknown combinations', () => {
  assert.equal(core.userVisibleProfileName({model: 'gpt-5-6-sol', reasoning: 'ultra'}), 'GPT-5.6 Sol · ultra');
  assert.equal(core.internalProfileLabel({model: 'gpt-5-6-sol', reasoning: 'ultra'}), 'gpt-5-6-sol · 추론 ultra');
});

test('does not produce a profile key when no safe model control exists', () => {
  const snapshot = core.buildSnapshot({action: 'next', messages: []});
  assert.equal(core.requestProfileFromSnapshot(snapshot), null);
  assert.equal(core.requestProfileKey(null), null);
});

test('diff reports changed, added and removed safe leaves', () => {
  const a = { leaves: [{ path: ['model'], value: 'a' }, { path: ['old'], value: true }] };
  const b = { leaves: [{ path: ['model'], value: 'b' }, { path: ['new'], value: 1 }] };
  const diff = core.diffSnapshots(a, b);
  assert.deepEqual(diff.changed, [{ path: ['model'], from: 'a', to: 'b' }]);
  assert.deepEqual(diff.added, [{ path: ['new'], value: 1 }]);
  assert.deepEqual(diff.removed, [{ path: ['old'], value: true }]);
  assert.equal(diff.differenceCount, 3);
});