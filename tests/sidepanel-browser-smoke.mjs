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
      modelInputs: ["chat-models", "chat-reasoning", "work-models", "work-reasoning"].every((id) => visible(document.getElementById(id))),
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
  if (!direct.headerVisible || !direct.calibratorVisible || !direct.stateRecorderVisible || !direct.modelInputs || direct.visibleCards < 3) {
    throw new Error(`Integrated side panel render failed: ${JSON.stringify(direct)}`);
  }
  if (direct.hasSwitchControls) throw new Error(`Unexpected Chat/Work switching UI: ${JSON.stringify(direct)}`);
  if (direct.options?.path !== "sidepanel.html" || direct.options?.enabled === false) throw new Error(`Side panel options are not active: ${JSON.stringify(direct.options)}`);
  if (direct.behavior?.openPanelOnActionClick !== true) throw new Error(`Toolbar behavior is not armed: ${JSON.stringify(direct.behavior)}`);

  let interceptedConversationBody = null;
  const chatPage = await browser.newPage();
  await chatPage.setRequestInterception(true);
  chatPage.on("request", async (request) => {
    const url = request.url();
    if (url === "https://chatgpt.com/" && request.isNavigationRequest()) {
      await request.respond({status: 200, contentType: "text/html", body: "<!doctype html><html><head><title>ChatGPT Smoke</title></head><body><main>smoke</main></body></html>"});
      return;
    }
    if (url.includes("/backend-api/f/conversation")) {
      interceptedConversationBody = request.postData() || null;
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

  const armResponse = await directPage.evaluate(async (tabId) => {
    return chrome.tabs.sendMessage(tabId, {
      source: "chatgpt-request-snapshot-panel",
      type: "RS_ARM_SCENARIO",
      scenario: {id: "smoke-profile", order: 1, mode: "chat", phase: "first", model: "smoke-model", reasoning: "smoke-high"}
    });
  }, chatTabId);
  if (!armResponse?.ok) throw new Error(`Could not arm request snapshot: ${JSON.stringify(armResponse)}`);

  await chatPage.evaluate(async () => {
    await fetch("/backend-api/f/conversation", {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({
        action: "next",
        model: "smoke-model",
        thinking_effort: "smoke-high",
        conversation_origin: "smoke-origin",
        conversation_id: "smoke-private-conversation-id",
        messages: [{content: {parts: ["SMOKE_PRIVATE_PROMPT"]}}]
      })
    });
  });

  await directPage.waitForFunction(async () => {
    const stored = await chrome.storage.local.get("chatGptRequestSnapshotCapturesV1");
    return Array.isArray(stored.chatGptRequestSnapshotCapturesV1)
      && stored.chatGptRequestSnapshotCapturesV1.some((item) => item.scenarioId === "smoke-profile");
  }, {timeout: 5000});

  const capture = await directPage.evaluate(async () => {
    const stored = await chrome.storage.local.get("chatGptRequestSnapshotCapturesV1");
    return stored.chatGptRequestSnapshotCapturesV1.find((item) => item.scenarioId === "smoke-profile");
  });
  const leaves = new Map(capture.snapshot.leaves.map((leaf) => [JSON.stringify(leaf.path), leaf.value]));
  if (leaves.get('["model"]') !== "smoke-model") throw new Error(`Model control not captured: ${JSON.stringify(capture)}`);
  if (leaves.get('["thinking_effort"]') !== "smoke-high") throw new Error(`Reasoning control not captured: ${JSON.stringify(capture)}`);
  if ([...leaves.keys()].some((key) => key.includes("messages") || key.includes("conversation_id"))) {
    throw new Error(`Private payload escaped sanitizer: ${JSON.stringify(capture)}`);
  }
  const transmitted = JSON.parse(interceptedConversationBody || "null");
  if (transmitted?.model !== "smoke-model" || transmitted?.thinking_effort !== "smoke-high") {
    throw new Error(`Outgoing controls were modified: ${interceptedConversationBody}`);
  }
  if (transmitted?.conversation_id !== "smoke-private-conversation-id" || transmitted?.messages?.[0]?.content?.parts?.[0] !== "SMOKE_PRIVATE_PROMPT") {
    throw new Error(`Outgoing request body was modified: ${interceptedConversationBody}`);
  }

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
    requestSnapshot: {
      model: leaves.get('["model"]'),
      thinkingEffort: leaves.get('["thinking_effort"]'),
      privateFieldsStored: false,
      outgoingBodyPreserved: true
    },
    sidePanelContext: actual
  }));
} finally {
  await browser.close();
}