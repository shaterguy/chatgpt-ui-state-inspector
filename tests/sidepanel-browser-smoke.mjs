import puppeteer from "puppeteer-core";
import {execFileSync} from "node:child_process";
import path from "node:path";
import process from "node:process";

function chromeBinary() {
  const found = execFileSync("bash", ["-lc", "command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser"], {encoding: "utf8"}).trim();
  if (!found) throw new Error("Chrome/Chromium binary not found on runner.");
  return found;
}

async function waitForExtensionId(browser) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const target of browser.targets()) {
      const match = target.url().match(/^chrome-extension:\/\/([a-p]{32})\//);
      if (match) return match[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Loaded extension target was not discovered.");
}

const extensionDir = path.resolve(process.cwd(), "extension");
const browser = await puppeteer.launch({
  headless: false,
  executablePath: chromeBinary(),
  args: [
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check"
  ]
});

try {
  const extensionId = await waitForExtensionId(browser);
  const page = await browser.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(String(error?.stack || error)));

  const sidePanelUrl = `chrome-extension://${extensionId}/sidepanel.html`;
  await page.goto(sidePanelUrl, {waitUntil: "load"});
  await page.waitForSelector("h1");

  const direct = await page.evaluate(async () => {
    const h1 = document.querySelector("h1");
    const header = document.querySelector("header");
    const cards = [...document.querySelectorAll(".card")];
    const visible = (node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const options = await chrome.sidePanel.getOptions({});
    const behavior = await chrome.sidePanel.getPanelBehavior();
    return {
      title: document.title,
      heading: h1?.textContent || "",
      headerVisible: Boolean(header && visible(header)),
      cardCount: cards.length,
      visibleCards: cards.filter(visible).length,
      bodyWidth: document.body.getBoundingClientRect().width,
      bodyHeight: document.body.getBoundingClientRect().height,
      options,
      behavior,
      chromeVersion: navigator.userAgent
    };
  });

  if (direct.heading !== "ChatGPT UI State Inspector") throw new Error(`Unexpected heading: ${direct.heading}`);
  if (!direct.headerVisible || direct.visibleCards < 3 || direct.bodyWidth <= 0 || direct.bodyHeight <= 0) {
    throw new Error(`Direct sidepanel render failed: ${JSON.stringify(direct)}`);
  }
  if (direct.options?.path !== "sidepanel.html" || direct.options?.enabled === false) {
    throw new Error(`Side panel options are not active: ${JSON.stringify(direct.options)}`);
  }
  if (direct.behavior?.openPanelOnActionClick !== true) {
    throw new Error(`Toolbar behavior is not armed: ${JSON.stringify(direct.behavior)}`);
  }

  await page.evaluate(() => {
    window.__sidePanelOpenResult = {done: false};
    const trigger = document.querySelector("#refresh");
    trigger.addEventListener("click", async () => {
      try {
        const current = await chrome.windows.getCurrent();
        await chrome.sidePanel.open({windowId: current.id});
        window.__sidePanelOpenResult = {done: true, ok: true};
      } catch (error) {
        window.__sidePanelOpenResult = {done: true, ok: false, error: String(error?.stack || error)};
      }
    }, {once: true});
  });
  await page.click("#refresh");
  await page.waitForFunction(() => window.__sidePanelOpenResult?.done === true, {timeout: 5000});
  const opened = await page.evaluate(() => window.__sidePanelOpenResult);
  if (!opened.ok) throw new Error(`chrome.sidePanel.open failed: ${opened.error}`);

  await new Promise((resolve) => setTimeout(resolve, 500));
  const contexts = await page.evaluate(async () => {
    if (!("getContexts" in chrome.runtime)) return [];
    return chrome.runtime.getContexts({contextTypes: ["SIDE_PANEL"]});
  });
  const actual = contexts.find((context) => context.documentUrl?.endsWith("/sidepanel.html"));
  if (!actual) throw new Error(`No SIDE_PANEL context for sidepanel.html: ${JSON.stringify(contexts)}`);

  if (pageErrors.length || consoleErrors.length) {
    throw new Error(`Sidepanel boot emitted errors: ${JSON.stringify({pageErrors, consoleErrors})}`);
  }

  console.log("SIDEPANEL_BROWSER_SMOKE_PASS", JSON.stringify({extensionId, direct, sidePanelContext: actual}));
} finally {
  await browser.close();
}
