"use strict";

const INDEX_KEY = "uiInspector:sessionIndex";
const META_PREFIX = "uiInspector:meta:";
const CHUNK_PREFIX = "uiInspector:chunk:";
const REQUEST_CAPTURE_ENABLED_KEY = "chatGptRequestProfileCaptureEnabledV2";
const REQUEST_PROFILES_KEY = "chatGptRequestProfilesV2";
const LEGACY_REQUEST_CAPTURES_KEY = "chatGptRequestSnapshotCapturesV1";
const REQUEST_BLOCKED_KEYS = new Set([
  "id", "conversation_id", "parent_message_id", "message_id", "current_node",
  "request_id", "client_request_id", "user_id", "account_id", "workspace_id",
  "prompt", "input", "text", "content", "parts", "messages", "message",
  "attachments", "attachment", "files", "file", "image", "audio",
  "authorization", "cookie", "set-cookie", "client_contextual_info"
]);
const REQUEST_BLOCKED_PATTERN = /(token|secret|credential|password|cookie|authorization|session)/i;
const REQUEST_VOLATILE_PATTERN = /^(time_since_loaded|timestamp|request_time|screen_|viewport_|window_|pixel_ratio|timezone_)/i;
const REQUEST_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{20,}$/i;
const REQUEST_OPAQUE_PATTERN = /^[A-Za-z0-9_\-./+=]{64,}$/;
const REQUEST_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MODEL_KEYS = ["model", "model_slug", "selected_model"];
const REASONING_KEYS = ["thinking_effort", "reasoning_effort", "reasoning_level", "thinking_level", "reasoning", "effort"];
let writeQueue = Promise.resolve();

async function ensureSidePanelReady() {
  await chrome.sidePanel.setOptions({path: "sidepanel.html", enabled: true});
  await chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true});
}

function initializeExtensionUi() {
  ensureSidePanelReady().catch(() => {});
}

chrome.runtime.onInstalled.addListener(initializeExtensionUi);
chrome.runtime.onStartup.addListener(initializeExtensionUi);
initializeExtensionUi();

function queueWrite(task) {
  const run = writeQueue.then(task, task);
  writeQueue = run.catch(() => {});
  return run;
}

function metaKey(id) {
  return META_PREFIX + id;
}

function chunkKey(id, index) {
  return `${CHUNK_PREFIX}${id}:${index}`;
}

function isExtensionPage(sender) {
  return sender.id === chrome.runtime.id && !sender.tab;
}

function isChatGptContent(sender) {
  if (sender.id !== chrome.runtime.id || !sender.tab?.id || !sender.url) return false;
  try {
    return new URL(sender.url).origin === "https://chatgpt.com";
  } catch {
    return false;
  }
}

function requestPathBlocked(path) {
  return path.some((segment) => {
    const lower = String(segment).toLowerCase();
    return REQUEST_BLOCKED_KEYS.has(lower)
      || /_ids?$/.test(lower)
      || REQUEST_BLOCKED_PATTERN.test(lower)
      || REQUEST_VOLATILE_PATTERN.test(lower);
  });
}

function safeRequestPrimitive(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number") return true;
  if (typeof value !== "string" || value.length === 0 || value.length > 160) return false;
  if (/^https?:\/\//i.test(value) || REQUEST_EMAIL_PATTERN.test(value)) return false;
  if (REQUEST_UUID_PATTERN.test(value) || REQUEST_OPAQUE_PATTERN.test(value)) return false;
  return true;
}

function safeRequestValue(value) {
  if (Array.isArray(value)) return value.length <= 16 && value.every(safeRequestPrimitive);
  return safeRequestPrimitive(value);
}

function safeShortString(value, max = 160) {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function safeIso(value) {
  return typeof value === "string" && value.length <= 64 && !Number.isNaN(Date.parse(value)) ? value : null;
}

function sanitizeRequestSnapshot(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const serialized = JSON.stringify(input);
  if (serialized.length > 300000 || !Array.isArray(input.leaves) || input.leaves.length > 512) return null;

  const leaves = [];
  for (const leaf of input.leaves) {
    if (!leaf || !Array.isArray(leaf.path) || leaf.path.length < 1 || leaf.path.length > 9) continue;
    if (!leaf.path.every((part) => typeof part === "string" && part.length > 0 && part.length <= 80)) continue;
    if (requestPathBlocked(leaf.path) || !safeRequestValue(leaf.value)) continue;
    leaves.push({path: leaf.path.slice(), value: Array.isArray(leaf.value) ? leaf.value.slice() : leaf.value});
  }

  const endpoint = typeof input.endpoint === "string" && input.endpoint.startsWith("/backend-api/") && input.endpoint.length <= 200
    ? input.endpoint.split("?")[0]
    : null;
  const transport = ["fetch", "fetch-request", "xhr"].includes(input.transport) ? input.transport : null;
  const page = input.page && typeof input.page === "object" ? input.page : {};
  const shape = input.requestShape && typeof input.requestShape === "object" ? input.requestShape : {};
  const action = safeRequestPrimitive(shape.action) ? shape.action : null;
  const messageCount = Number.isInteger(shape.messageCount) && shape.messageCount >= 0 && shape.messageCount <= 1000
    ? shape.messageCount
    : null;

  return {
    schemaVersion: 1,
    capturedAt: safeIso(input.capturedAt) || new Date().toISOString(),
    endpoint,
    method: "POST",
    transport,
    page: {
      routeKind: safeShortString(page.routeKind, 60),
      projectContext: page.projectContext === true,
      hasUrlConversationId: page.hasUrlConversationId === true
    },
    requestShape: {
      hasConversationId: shape.hasConversationId === true,
      hasParentMessageId: shape.hasParentMessageId === true,
      messageCount,
      action,
      turnClass: shape.turnClass === "followup" ? "followup" : "first"
    },
    leaves
  };
}

function findControlLeaf(snapshot, candidates, stringOnly = false) {
  for (const candidate of candidates) {
    for (const topLevelOnly of [true, false]) {
      const leaf = snapshot.leaves.find((item) => {
        if (topLevelOnly && item.path.length !== 1) return false;
        if (String(item.path[item.path.length - 1]).toLowerCase() !== candidate) return false;
        if (stringOnly) return typeof item.value === "string" && safeRequestPrimitive(item.value);
        return !Array.isArray(item.value) && safeRequestPrimitive(item.value);
      });
      if (leaf) return {value: leaf.value, path: leaf.path.slice()};
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
  if (!profile || typeof profile.model !== "string" || !profile.model) return null;
  return JSON.stringify([profile.model, profile.reasoning ?? null]);
}

function migrateLegacyRequestProfiles(profiles, legacyCaptures) {
  const next = Array.isArray(profiles) ? profiles.slice() : [];
  const keys = new Set(next.map((item) => item?.profileKey).filter(Boolean));
  let added = 0;
  for (const legacy of Array.isArray(legacyCaptures) ? legacyCaptures : []) {
    const snapshot = sanitizeRequestSnapshot(legacy?.snapshot);
    if (!snapshot) continue;
    const profile = requestProfileFromSnapshot(snapshot);
    const profileKey = requestProfileKey(profile);
    if (!profileKey || keys.has(profileKey)) continue;
    keys.add(profileKey);
    next.push({
      schemaVersion: 2,
      profileKey,
      profile,
      captureId: safeShortString(legacy?.captureId, 120) || `legacy-${next.length + 1}`,
      firstCapturedAt: snapshot.capturedAt,
      savedAt: safeIso(legacy?.savedAt) || snapshot.capturedAt,
      migratedFrom: LEGACY_REQUEST_CAPTURES_KEY,
      snapshot
    });
    added += 1;
  }
  return {profiles: next, added};
}

async function getRequestProfileState(sender) {
  if (!isExtensionPage(sender)) throw new Error("Extension page required.");
  return queueWrite(async () => {
    const stored = await chrome.storage.local.get([
      REQUEST_CAPTURE_ENABLED_KEY,
      REQUEST_PROFILES_KEY,
      LEGACY_REQUEST_CAPTURES_KEY
    ]);
    const legacyCaptures = Array.isArray(stored[LEGACY_REQUEST_CAPTURES_KEY]) ? stored[LEGACY_REQUEST_CAPTURES_KEY] : [];
    const migrated = migrateLegacyRequestProfiles(stored[REQUEST_PROFILES_KEY], legacyCaptures);
    if (migrated.added) await chrome.storage.local.set({[REQUEST_PROFILES_KEY]: migrated.profiles});
    return {
      captureEnabled: stored[REQUEST_CAPTURE_ENABLED_KEY] === true,
      profiles: migrated.profiles,
      legacyCaptures,
      migratedCount: migrated.added
    };
  });
}

async function setRequestProfileCaptureEnabled(message, sender) {
  if (!isExtensionPage(sender)) throw new Error("Extension page required.");
  const enabled = message.enabled === true;
  return queueWrite(async () => {
    await chrome.storage.local.set({[REQUEST_CAPTURE_ENABLED_KEY]: enabled});
    return {captureEnabled: enabled};
  });
}

async function resetRequestProfiles(message, sender) {
  if (!isExtensionPage(sender)) throw new Error("Extension page required.");
  return queueWrite(async () => {
    await chrome.storage.local.set({
      [REQUEST_PROFILES_KEY]: [],
      [LEGACY_REQUEST_CAPTURES_KEY]: []
    });
    return {reset: true};
  });
}

async function saveRequestProfileCapture(message, sender) {
  if (!isChatGptContent(sender)) throw new Error("ChatGPT content script required.");
  return queueWrite(async () => {
    const stored = await chrome.storage.local.get([
      REQUEST_CAPTURE_ENABLED_KEY,
      REQUEST_PROFILES_KEY,
      LEGACY_REQUEST_CAPTURES_KEY
    ]);
    const legacyCaptures = Array.isArray(stored[LEGACY_REQUEST_CAPTURES_KEY]) ? stored[LEGACY_REQUEST_CAPTURES_KEY] : [];
    const migrated = migrateLegacyRequestProfiles(stored[REQUEST_PROFILES_KEY], legacyCaptures);
    let profiles = migrated.profiles;
    if (migrated.added) await chrome.storage.local.set({[REQUEST_PROFILES_KEY]: profiles});
    if (stored[REQUEST_CAPTURE_ENABLED_KEY] !== true) {
      return {stored: false, disabled: true, profileCount: profiles.length};
    }

    const snapshot = sanitizeRequestSnapshot(message.snapshot);
    if (!snapshot) throw new Error("Invalid request profile snapshot.");
    const profile = requestProfileFromSnapshot(snapshot);
    const profileKey = requestProfileKey(profile);
    if (!profileKey) throw new Error("Request model profile was not found.");
    if (safeShortString(message.profileKey, 240) && message.profileKey !== profileKey) {
      throw new Error("Request profile key mismatch.");
    }

    if (profiles.some((item) => item?.profileKey === profileKey)) {
      return {stored: false, duplicate: true, profileKey, profileCount: profiles.length};
    }

    const now = new Date().toISOString();
    const record = {
      schemaVersion: 2,
      profileKey,
      profile,
      captureId: safeShortString(message.captureId, 120) || `capture-${crypto.randomUUID()}`,
      firstCapturedAt: snapshot.capturedAt,
      savedAt: now,
      migratedFrom: null,
      snapshot
    };
    profiles = [...profiles, record];
    await chrome.storage.local.set({[REQUEST_PROFILES_KEY]: profiles});
    return {stored: true, duplicate: false, profileKey, profileCount: profiles.length};
  });
}

async function getIndex() {
  const result = await chrome.storage.local.get(INDEX_KEY);
  return Array.isArray(result[INDEX_KEY]) ? result[INDEX_KEY] : [];
}

async function setIndex(index) {
  await chrome.storage.local.set({[INDEX_KEY]: index});
}

async function createSession(message, sender) {
  if (!isExtensionPage(sender)) throw new Error("Extension page required.");
  const title = String(message.title || "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!title) throw new Error("기록 제목을 입력해 주세요.");
  const tabId = Number(message.tabId);
  if (!Number.isInteger(tabId)) throw new Error("활성 ChatGPT 탭을 찾지 못했습니다.");
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const meta = {
    schemaVersion: "1.1.0",
    protocolVersion: "1.1.0",
    id,
    title,
    status: "recording",
    source: "https://chatgpt.com",
    tabId,
    createdAt: now,
    startedAt: now,
    completedAt: null,
    eventCount: 0,
    lastSeq: 0,
    nextChunk: 0,
    lastTurnState: null,
    exportFormats: ["json", "jsonl", "csv", "md"],
    privacy: {
      inputValuesCaptured: false,
      messageBodiesCaptured: false,
      networkPayloadsCaptured: false,
      protocolMetadataCaptured: true,
      networkTransmission: false
    }
  };
  await chrome.storage.local.set({[metaKey(id)]: meta});
  const index = await getIndex();
  await setIndex([id, ...index.filter((item) => item !== id)]);
  return meta;
}

async function appendEvents(message, sender) {
  if (!isChatGptContent(sender)) throw new Error("ChatGPT content script required.");
  const id = String(message.sessionId || "");
  const events = Array.isArray(message.events) ? message.events : [];
  if (!id || !events.length || events.length > 100) throw new Error("Invalid event batch.");
  const serialized = JSON.stringify(events);
  if (serialized.length > 600000) throw new Error("Event batch is too large.");

  return queueWrite(async () => {
    const key = metaKey(id);
    const result = await chrome.storage.local.get(key);
    const meta = result[key];
    if (!meta || meta.status !== "recording") throw new Error("Recording session is not active.");
    if (meta.tabId !== sender.tab.id) throw new Error("Session tab mismatch.");
    const chunkIndex = meta.nextChunk;
    const lastSeq = events.reduce((max, event) => Math.max(max, Number(event.seq) || 0), meta.lastSeq || 0);
    const latestTransition = events.slice().reverse().find((event) => event?.type === "turn_state_transition" && event?.state);
    const updated = {
      ...meta,
      eventCount: meta.eventCount + events.length,
      lastSeq,
      nextChunk: chunkIndex + 1,
      lastTurnState: latestTransition?.state || meta.lastTurnState || null,
      updatedAt: new Date().toISOString()
    };
    await chrome.storage.local.set({
      [chunkKey(id, chunkIndex)]: events,
      [key]: updated
    });
    return {eventCount: updated.eventCount, lastSeq, lastTurnState: updated.lastTurnState};
  });
}

async function completeSession(message, sender) {
  if (!isChatGptContent(sender) && !isExtensionPage(sender)) throw new Error("Unauthorized sender.");
  return queueWrite(async () => {
    const id = String(message.sessionId || "");
    const key = metaKey(id);
    const result = await chrome.storage.local.get(key);
    const meta = result[key];
    if (!meta) throw new Error("Session not found.");
    if (sender.tab && meta.tabId !== sender.tab.id) throw new Error("Session tab mismatch.");
    const updated = {
      ...meta,
      status: "completed",
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await chrome.storage.local.set({[key]: updated});
    return updated;
  });
}

async function listSessions(sender) {
  if (!isExtensionPage(sender)) throw new Error("Extension page required.");
  const index = await getIndex();
  const keys = index.map(metaKey);
  const result = keys.length ? await chrome.storage.local.get(keys) : {};
  return index.map((id) => result[metaKey(id)]).filter(Boolean);
}

async function getSession(message, sender) {
  if (!isExtensionPage(sender)) throw new Error("Extension page required.");
  const id = String(message.sessionId || "");
  const result = await chrome.storage.local.get(metaKey(id));
  const meta = result[metaKey(id)];
  if (!meta) throw new Error("Session not found.");
  const keys = Array.from({length: meta.nextChunk}, (_, index) => chunkKey(id, index));
  const chunks = keys.length ? await chrome.storage.local.get(keys) : {};
  const events = [];
  for (let index = 0; index < meta.nextChunk; index += 1) {
    const chunk = chunks[chunkKey(id, index)];
    if (Array.isArray(chunk)) events.push(...chunk);
  }
  events.sort((a, b) => (Number(a.seq) || 0) - (Number(b.seq) || 0));
  return {meta, events};
}

async function deleteSession(message, sender) {
  if (!isExtensionPage(sender)) throw new Error("Extension page required.");
  return queueWrite(async () => {
    const id = String(message.sessionId || "");
    const result = await chrome.storage.local.get(metaKey(id));
    const meta = result[metaKey(id)];
    if (!meta) return {deleted: false};
    const keys = [metaKey(id)];
    for (let index = 0; index < meta.nextChunk; index += 1) keys.push(chunkKey(id, index));
    await chrome.storage.local.remove(keys);
    const index = await getIndex();
    await setIndex(index.filter((item) => item !== id));
    return {deleted: true};
  });
}

async function abortSession(message, sender) {
  if (!isExtensionPage(sender)) throw new Error("Extension page required.");
  return deleteSession(message, sender);
}

async function activeForTab(message, sender) {
  if (!isChatGptContent(sender)) throw new Error("ChatGPT content script required.");
  const index = await getIndex();
  const keys = index.map(metaKey);
  const result = keys.length ? await chrome.storage.local.get(keys) : {};
  return index
    .map((id) => result[metaKey(id)])
    .find((meta) => meta?.status === "recording" && meta.tabId === sender.tab.id) || null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handlers = {
    GET_REQUEST_PROFILE_STATE: () => getRequestProfileState(sender),
    SET_REQUEST_PROFILE_CAPTURE_ENABLED: () => setRequestProfileCaptureEnabled(message, sender),
    RESET_REQUEST_PROFILES: () => resetRequestProfiles(message, sender),
    SAVE_REQUEST_PROFILE_CAPTURE: () => saveRequestProfileCapture(message, sender),
    CREATE_SESSION: () => createSession(message, sender),
    APPEND_EVENTS: () => appendEvents(message, sender),
    COMPLETE_SESSION: () => completeSession(message, sender),
    LIST_SESSIONS: () => listSessions(sender),
    GET_SESSION: () => getSession(message, sender),
    DELETE_SESSION: () => deleteSession(message, sender),
    ABORT_SESSION: () => abortSession(message, sender),
    GET_ACTIVE_FOR_TAB: () => activeForTab(message, sender)
  };
  const handler = handlers[message?.type];
  if (!handler) return false;
  Promise.resolve()
    .then(handler)
    .then((result) => sendResponse({ok: true, result}))
    .catch((error) => sendResponse({ok: false, error: error.message || "Unknown error"}));
  return true;
});