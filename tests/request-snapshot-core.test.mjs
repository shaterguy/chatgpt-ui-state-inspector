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

test('diff reports changed, added and removed safe leaves', () => {
  const a = { leaves: [{ path: ['model'], value: 'a' }, { path: ['old'], value: true }] };
  const b = { leaves: [{ path: ['model'], value: 'b' }, { path: ['new'], value: 1 }] };
  const diff = core.diffSnapshots(a, b);
  assert.deepEqual(diff.changed, [{ path: ['model'], from: 'a', to: 'b' }]);
  assert.deepEqual(diff.added, [{ path: ['new'], value: 1 }]);
  assert.deepEqual(diff.removed, [{ path: ['old'], value: true }]);
  assert.equal(diff.differenceCount, 3);
});

test('minimal plan includes Chat and Work model/reasoning axes plus Work follow-up captures', () => {
  const plan = core.buildScenarioPlan({
    chatModels: ['C0', 'C1'],
    chatReasoning: ['R0', 'R1', 'R2'],
    workModels: ['W0', 'W1', 'W2'],
    workReasoning: ['E0', 'E1']
  });
  assert.equal(plan.error, null);
  assert.equal(plan.requiredCount, 12);
  assert.equal(plan.optionalCount, 1);
  assert.equal(plan.scenarios.filter((s) => s.group === 'work-followup' && s.required).length, 4);
  assert.ok(plan.scenarios.some((s) => s.id === 'work-followup-model-1' && s.phase === 'followup'));
  assert.ok(plan.scenarios.some((s) => s.id === 'work-followup-reasoning-1' && s.phase === 'followup'));
  assert.equal(plan.scenarios.find((s) => s.id === 'work-followup-cross-check').required, false);
});