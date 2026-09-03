import puppeteer from "puppeteer";
import path from "node:path";
import process from "node:process";

const extensionDir = path.resolve(process.cwd(), "extension");
const browser = await puppeteer.launch({
  headless: false,
  enableExtensions: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"]
});

try {
  const extensionId = await browser.installExtension(extensionDir);
  const extensions = await browser.extensions();
  const extension = extensions.get(extensionId);
  if (!extension) throw new Error(`Installed extension not listed: ${extensionId}`);

  const directPage = await browser.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  directPage.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  directPage.on("pageerror", (error) => pageErrors.push(String(error?.stack || error)));

  const sidePanelUrl = `chrome-extension://${extensionId}/sidepanel.html`;
  await directPage.goto(sidePanelUrl, {waitUntil: "load"});
  await directPage.waitForSelector("h1");

  const direct = await directPage.evaluate(async () => {
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const cards = [...document.querySelectorAll(".card")];
    return {
      title: document.title,
      heading: document.querySelector("h1")?.textContent || "",
      headerVisible: visible(document.querySelector("header")),
      calibratorVisible: visible(document.querySelector("#request-calibrator-heading")),
      stateRecorderVisible: visible(document.querySelector("#record-heading")),
      autoCaptureControls: ["start-request-capture", "stop-request-capture", "request-profile-summary", "request-profile-list"]
        .every((id) => Boolean(document.getElementById(id))),
      oldScenarioControls: ["chat-models", "chat-reasoning", "work-models", "work-reasoning", "generate-scenarios", "arm-next", "scenario-list"]
        .some((id) => Boolean(document.getElementById(id))),
      cardCount: cards.length,
      visibleCards: cards.filter(visible).length,
      bodyWidth: document.body.getBoundingClientRect().width,
      bodyHeight: document.body.getBoundingClientRect().height,
      hasSwitchControls: Boolean(document.querySelector("#switch-chat, #switch-work, [data-switch-mode]")),
      options: await chrome.sidePanel.getOptions({}),
      behavior: await chrome.sidePanel.getPanelBehavior(),
      chromeVersion: navigator.userAgent
    };
  });

  if (direct.heading !== "ChatGPT UI State Inspector") throw new Error(`Unexpected heading: ${direct.heading}`);
  if (!direct.headerVisible || !direct.calibratorVisible || !direct.stateRecorderVisible || !direct.autoCaptureControls || direct.visibleCards < 3) {
    throw new Error(`Integrated side panel render failed: ${JSON.stringify(direct)}`);
  }
  if (direct.oldScenarioControls) throw new Error(`Old scenario controls are still present: ${JSON.stringify(direct)}`);
  if (direct.hasSwitchControls) throw new Error(`Unexpected Chat/Work switching UI: ${JSON.stringify(direct)}`);
  if (direct.options?.path !== "sidepanel.html" || direct.options?.enabled === false) throw new Error(`Side panel options are not active: ${JSON.stringify(direct.options)}`);
  if (direct.behavior?.openPanelOnActionClick !== true) throw new Error(`Toolbar behavior is not armed: ${JSON.stringify(direct.behavior)}`);

  const legacySnapshot = {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    endpoint: "/backend-api/f/conversation",
    method: "POST",
    transport: "fetch",
    page: {routeKind: "conversation", projectContext: false, hasUrlConversationId: true},
    requestShape: {hasConversationId: true, hasParentMessageId: true, messageCount: 1, action: "next", turnClass: "followup"},
    leaves: [
      {path: ["action"], value: "next"},
      {path: ["model"], value: "legacy-model"},
      {path: ["thinking_effort"], value: "legacy-high"}
    ]
  };
  await directPage.evaluate(async (snapshot) => {
    await chrome.storage.local.set({
      chatGptRequestSnapshotCapturesV1: [{scenarioId: "legacy-dev3", captureId: "legacy-1", savedAt: snapshot.capturedAt, snapshot}],
      chatGptRequestProfilesV2: [],
      chatGptRequestProfileCaptureEnabledV2: true
    });
  }, legacySnapshot);

  const interceptedConversationBodies = [];
  const chatPage = await browser.newPage();
  await chatPage.setRequestInterception(true);
  chatPage.on("request", async (request) => {
    const url = request.url();
    if (url === "https://chatgpt.com/" && request.isNavigationRequest()) {
      await request.respond({status: 200, contentType: "text/html", body: "<!doctype html><html><head><title>ChatGPT Smoke</title></head><body><main>smoke</main></body></html>"});
      return;
    }
    if (url.includes("/backend-api/f/conversation")) {
      interceptedConversationBodies.push(request.postData() || null);
      await request.respond({status: 200, contentType: "application/json", body: "{\"ok\":true}"});
      return;
    }
    await request.continue();
  });
  await chatPage.goto("https://chatgpt.com/", {waitUntil: "domcontentloaded"});
  await chatPage.bringToFront();

  const chatTabId = await directPage.evaluate(async () => {
    const tabs = await chrome.tabs.query({active: true, currentWindow: true});
    return tabs[0]?.id || null;
  });
  if (!chatTabId) throw new Error("Could not resolve synthetic ChatGPT tab id");

  await directPage.waitForFunction(async (tabId) => {
    return chrome.tabs.sendMessage(tabId, {source: "chatgpt-request-snapshot-panel", type: "RS_GET_STATE"})
      .then((response) => response?.bridgeReady === true && response?.captureEnabled === true)
      .catch(() => false);
  }, {timeout: 5000}, chatTabId);

  async function sendSynthetic(model, effort, marker) {
    await chatPage.evaluate(async ({model, effort, marker}) => {
      await fetch("/backend-api/f/conversation", {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({
          action: "next",
          model,
          thinking_effort: effort,
          conversation_origin: "smoke-origin",
          conversation_id: `smoke-private-conversation-${marker}`,
          messages: [{content: {parts: [`SMOKE_PRIVATE_PROMPT_${marker}`]}}]
        })
      });
    }, {model, effort, marker});
  }

  await sendSynthetic("smoke-model", "smoke-high", "A1");
  await directPage.waitForFunction(async () => {
    const stored = await chrome.storage.local.get(["chatGptRequestProfilesV2", "chatGptRequestSnapshotCapturesV1"]);
    return Array.isArray(stored.chatGptRequestProfilesV2)
      && stored.chatGptRequestProfilesV2.length === 2
      && Array.isArray(stored.chatGptRequestSnapshotCapturesV1)
      && stored.chatGptRequestSnapshotCapturesV1.length === 1;
  }, {timeout: 5000});

  await sendSynthetic("smoke-model", "smoke-high", "A2");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const duplicateCount = await directPage.evaluate(async () => {
    const stored = await chrome.storage.local.get("chatGptRequestProfilesV2");
    return stored.chatGptRequestProfilesV2?.length || 0;
  });
  if (duplicateCount !== 2) throw new Error(`Duplicate profile was not skipped: ${duplicateCount}`);

  await sendSynthetic("smoke-model", "smoke-max", "B1");
  await directPage.waitForFunction(async () => {
    const stored = await chrome.storage.local.get("chatGptRequestProfilesV2");
    return Array.isArray(stored.chatGptRequestProfilesV2) && stored.chatGptRequestProfilesV2.length === 3;
  }, {timeout: 5000});

  const profileState = await directPage.evaluate(async () => {
    const stored = await chrome.storage.local.get(["chatGptRequestProfilesV2", "chatGptRequestSnapshotCapturesV1"]);
    return {
      profiles: stored.chatGptRequestProfilesV2 || [],
      legacy: stored.chatGptRequestSnapshotCapturesV1 || []
    };
  });
  const profileKeys = profileState.profiles.map((item) => item.profileKey).sort();
  for (const expected of [
    '["legacy-model","legacy-high"]',
    '["smoke-model","smoke-high"]',
    '["smoke-model","smoke-max"]'
  ]) {
    if (!profileKeys.includes(expected)) throw new Error(`Missing profile ${expected}: ${JSON.stringify(profileState)}`);
  }
  if (profileState.legacy.length !== 1) throw new Error(`Legacy dev3 source was modified: ${JSON.stringify(profileState.legacy)}`);
  const storedJson = JSON.stringify(profileState.profiles);
  if (storedJson.includes("SMOKE_PRIVATE_PROMPT") || storedJson.includes("smoke-private-conversation")) {
    throw new Error(`Private payload escaped sanitizer: ${storedJson}`);
  }

  await directPage.evaluate(() => chrome.storage.local.set({chatGptRequestProfileCaptureEnabledV2: false}));
  await directPage.waitForFunction(async (tabId) => {
    return chrome.tabs.sendMessage(tabId, {source: "chatgpt-request-snapshot-panel", type: "RS_GET_STATE"})
      .then((response) => response?.bridgeReady === true && response?.captureEnabled === false)
      .catch(() => false);
  }, {timeout: 5000}, chatTabId);
  await chatPage.bringToFront();
  await sendSynthetic("smoke-other-model", "smoke-high", "C1");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const stoppedCount = await directPage.evaluate(async () => {
    const stored = await chrome.storage.local.get("chatGptRequestProfilesV2");
    return stored.chatGptRequestProfilesV2?.length || 0;
  });
  if (stoppedCount !== 3) throw new Error(`Capture continued after stop: ${stoppedCount}`);

  if (interceptedConversationBodies.length !== 4) {
    throw new Error(`Unexpected outgoing request count: ${interceptedConversationBodies.length}`);
  }
  const transmitted = interceptedConversationBodies.map((body) => JSON.parse(body || "null"));
  const expectedBodies = [
    ["smoke-model", "smoke-high", "A1"],
    ["smoke-model", "smoke-high", "A2"],
    ["smoke-model", "smoke-max", "B1"],
    ["smoke-other-model", "smoke-high", "C1"]
  ];
  transmitted.forEach((body, index) => {
    const [model, effort, marker] = expectedBodies[index];
    if (body?.model !== model || body?.thinking_effort !== effort) {
      throw new Error(`Outgoing controls were modified: ${JSON.stringify(body)}`);
    }
    if (body?.conversation_id !== `smoke-private-conversation-${marker}` || body?.messages?.[0]?.content?.parts?.[0] !== `SMOKE_PRIVATE_PROMPT_${marker}`) {
      throw new Error(`Outgoing request body was modified: ${JSON.stringify(body)}`);
    }
  });

  await directPage.evaluate(() => chrome.sidePanel.setOptions({path: "sidepanel.html", enabled: false}));
  const stale = await directPage.evaluate(() => chrome.sidePanel.getOptions({}));
  if (stale.enabled !== false) throw new Error(`Could not create stale side panel state: ${JSON.stringify(stale)}`);

  const workerTarget = await browser.waitForTarget((target) => target.type() === "service_worker" && target.url().startsWith(`chrome-extension://${extensionId}/`));
  const worker = await workerTarget.worker();
  await worker.close();
  await directPage.evaluate(() => chrome.runtime.sendMessage({type: "LIST_SESSIONS"}));
  await directPage.waitForFunction(async () => {
    const options = await chrome.sidePanel.getOptions({});
    const behavior = await chrome.sidePanel.getPanelBehavior();
    return options.enabled === true && options.path === "sidepanel.html" && behavior.openPanelOnActionClick === true;
  }, {timeout: 5000});

  const actionPage = await browser.newPage();
  await actionPage.goto("https://example.com", {waitUntil: "domcontentloaded"});
  await extension.triggerAction(actionPage);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const contexts = await directPage.evaluate(() => chrome.runtime.getContexts({contextTypes: ["SIDE_PANEL"]}));
  const actual = contexts.find((context) => context.documentUrl?.endsWith("/sidepanel.html"));
  if (!actual) throw new Error(`No SIDE_PANEL context for sidepanel.html: ${JSON.stringify(contexts)}`);
  if (pageErrors.length || consoleErrors.length) throw new Error(`Sidepanel boot emitted errors: ${JSON.stringify({pageErrors, consoleErrors})}`);

  console.log("SIDEPANEL_BROWSER_SMOKE_PASS", JSON.stringify({
    extensionId,
    direct,
    requestProfiles: {
      legacyMigrated: true,
      uniqueCount: 3,
      duplicateSkipped: true,
      stoppedCaptureIgnored: true,
      privateFieldsStored: false,
      outgoingBodiesPreserved: true
    },
    sidePanelContext: actual
  }));
} finally {
  await browser.close();
}