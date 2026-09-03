"use strict";

const INDEX_KEY = "uiInspector:sessionIndex";
const META_PREFIX = "uiInspector:meta:";
const CHUNK_PREFIX = "uiInspector:chunk:";
let writeQueue = Promise.resolve();

function createActionIcon(size) {
  if (typeof OffscreenCanvas === "undefined") return null;
  const canvas = new OffscreenCanvas(size, size);
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.clearRect(0, 0, size, size);
  context.fillStyle = "#0f766e";
  context.fillRect(0, 0, size, size);
  context.strokeStyle = "#ffffff";
  context.lineWidth = Math.max(2, Math.round(size * 0.11));
  context.lineCap = "round";
  context.lineJoin = "round";
  const left = size * 0.22;
  const right = size * 0.78;
  const top = size * 0.36;
  const bottom = size * 0.64;
  const wing = size * 0.13;
  context.beginPath();
  context.moveTo(left, top);
  context.lineTo(right, top);
  context.moveTo(right, top);
  context.lineTo(right - wing, top - wing);
  context.moveTo(right, top);
  context.lineTo(right - wing, top + wing);
  context.moveTo(right, bottom);
  context.lineTo(left, bottom);
  context.moveTo(left, bottom);
  context.lineTo(left + wing, bottom - wing);
  context.moveTo(left, bottom);
  context.lineTo(left + wing, bottom + wing);
  context.stroke();
  return context.getImageData(0, 0, size, size);
}

async function applyToolbarIcon() {
  const imageData = {};
  for (const size of [16, 32, 48, 128]) {
    const icon = createActionIcon(size);
    if (icon) imageData[size] = icon;
  }
  if (Object.keys(imageData).length) await chrome.action.setIcon({imageData});
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({openPanelOnActionClick: true}).catch(() => {});
  applyToolbarIcon().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => applyToolbarIcon().catch(() => {}));
applyToolbarIcon().catch(() => {});

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
