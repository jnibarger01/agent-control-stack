import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { fixtures, scenarioOrder } from "../src/fixtures.js";

const root = resolve(import.meta.dirname, "..");
const sourceFiles = [
  join(root, "index.html"),
  ...await collect(join(root, "src"), [".js", ".jsx", ".css"])
];
const builtFiles = await collect(join(root, "dist"), [".html", ".js", ".css", ".svg"]);
const scannedFiles = [...sourceFiles, ...builtFiles];
const publicText = (await Promise.all(scannedFiles.map(async (file) => `${relative(root, file)}\n${await readFile(file, "utf8")}`))).join("\n");
const builtHtml = await readFile(join(root, "dist", "index.html"), "utf8");

const failures = [];
const fail = (message) => failures.push(message);

for (const [label, pattern] of [
  ["runtime fetch", /\bfetch\s*\(/],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["EventSource", /\bEventSource\b/],
  ["WebSocket", /\bWebSocket\b/],
  ["absolute home path", /\/(?:home|Users)\//],
  ["local database path", /storage\/[^\s'"]+\.db/],
  ["run artifact reference", /(?:^|[\s'"`])runs\//m],
  ["real ACS work-item id", /\bwrk_[a-f0-9-]{8,}\b/i],
  ["real ACS event id", /\bevt_[a-f0-9-]{8,}\b/i],
  ["64-character hash", /\b[a-f0-9]{64}\b/i],
  ["prohibited tamper-proof claim", /tamper[- ]proof/i],
  ["prohibited immutable claim", /\bimmutable\b/i],
  ["prohibited open-source claim", /\bopen source\b|\bopen-source\b/i],
  ["prohibited real-time claim", /\breal time\b|\breal-time\b/i]
]) {
  if (pattern.test(publicText)) fail(`Detected ${label} in public source or generated bundle.`);
}

if (!/connect-src 'none'/.test(builtHtml)) fail("Generated HTML must contain connect-src 'none'.");
if (/(?:src|href)=["']https?:\/\//i.test(builtHtml)) fail("Generated HTML references an external runtime asset.");
if (/<link\b[^>]*rel=["']modulepreload["']/i.test(builtHtml)) fail("Generated HTML must not inject module-preload requests.");
if (!publicText.includes("SYNTHETIC DEMO")) fail("Persistent SYNTHETIC DEMO disclosure is missing.");
if (!publicText.includes("Hardened OS isolation is not implemented")) fail("Hardened-isolation limitation is missing.");
if (!publicText.includes("tamper-detecting")) fail("Approved tamper-detecting wording is missing.");

if (scenarioOrder.length !== 7) fail(`Expected 7 scenarios, found ${scenarioOrder.length}.`);
for (const scenarioKey of scenarioOrder) {
  const scenario = fixtures[scenarioKey];
  if (!scenario) {
    fail(`Missing fixture for ${scenarioKey}.`);
    continue;
  }
  const ids = [
    ...scenario.agents.map((agent) => agent.id),
    ...scenario.workItems.flatMap((item) => [item.id, item.assignedAgentId].filter(Boolean)),
    ...scenario.activity.flatMap((event) => [event.id, event.subjectId])
  ];
  for (const id of ids) {
    if (!id.startsWith("DEMO-")) fail(`${scenarioKey} contains a non-DEMO identifier: ${id}`);
  }
  for (const event of scenario.activity) {
    if (!/^T\+\d{2}:\d{2}$/.test(event.scenarioOffset)) {
      fail(`${scenarioKey} contains a non-relative scenario time: ${event.scenarioOffset}`);
    }
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Safety verification passed for ${sourceFiles.length} authored files, ${builtFiles.length} generated files, and ${scenarioOrder.length} synthetic scenarios.`);

async function collect(directory, extensions) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collect(path, extensions));
    else if (extensions.includes(extname(entry.name))) files.push(path);
  }
  return files;
}
