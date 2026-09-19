import { readFileSync } from "node:fs";
import { launchBrowser } from "./cdp.mjs";
const base = process.env.ACS_E2E_BASE ?? "http://127.0.0.1:3717";
const token = readFileSync(process.env.ACS_E2E_TOKEN_FILE ?? "/tmp/acs-mc-e2e/token", "utf8").trim();
const shots = process.env.SHOTS ?? "/tmp/acs-mc-e2e/shots";
import { mkdirSync } from "node:fs";
mkdirSync(shots, { recursive: true });
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  await page.setViewport(1440, 900);
  await page.goto(`${base}/console/overview`);
  await page.waitFor(() => !!document.querySelector("input[type=password]"));
  await page.screenshot(`${shots}/00-login.png`);
  await page.type("input[type=password]", token);
  await page.click("button[type=submit]");
  await page.waitFor(() => !!document.querySelector("[data-testid=page-overview]"), 15000);
  await new Promise((r) => setTimeout(r, 1500));
  await page.screenshot(`${shots}/01-overview.png`);
  console.log("console errors:", page.consoleErrors, "page errors:", page.pageErrors, "csp:", page.cspViolations);
} finally {
  await browser.close();
}
