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

  const tabPage = await browser.newPage();
  await tabPage.goto("https://example.com", {waitUntil: "domcontentloaded"});
  await extension.triggerAction(tabPage);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const contexts = await directPage.evaluate(() => chrome.runtime.getContexts({contextTypes: ["SIDE_PANEL"]}));
  const actual = contexts.find((context) => context.documentUrl?.endsWith("/sidepanel.html"));
  if (!actual) throw new Error(`No SIDE_PANEL context for sidepanel.html: ${JSON.stringify(contexts)}`);
  if (pageErrors.length || consoleErrors.length) throw new Error(`Sidepanel boot emitted errors: ${JSON.stringify({pageErrors, consoleErrors})}`);

  console.log("SIDEPANEL_BROWSER_SMOKE_PASS", JSON.stringify({extensionId, direct, sidePanelContext: actual}));
} finally {
  await browser.close();
}