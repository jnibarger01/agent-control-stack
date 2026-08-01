#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";

const API_BASE = "https://api.pushcut.io/v1";
const MAX_PAYLOAD_BYTES = 262_144;

type Arguments = {
  execute: boolean;
  notification: string;
  payload: string;
};

function parseArguments(argv: string[]): Arguments {
  let execute = false;
  let notification = "";
  let payload = "";

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") {
      execute = true;
    } else if (argument === "--notification") {
      notification = argv[++index] ?? "";
    } else if (argument === "--payload") {
      payload = argv[++index] ?? "";
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  if (!notification || !payload) {
    throw new Error("--notification and --payload are required");
  }
  return { execute, notification, payload };
}

async function loadPayload(path: string): Promise<Record<string, unknown>> {
  const details = await stat(path);
  if (!details.isFile()) throw new Error("payload file not found");
  if (details.size > MAX_PAYLOAD_BYTES) throw new Error("payload exceeds 256 KiB");
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("payload must be a JSON object");
  }
  return value as Record<string, unknown>;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const payload = await loadPayload(args.payload);
  const endpoint = `${API_BASE}/notifications/${encodeURIComponent(args.notification)}`;

  if (!args.execute) {
    console.log("DRY RUN");
    console.log("method: POST");
    console.log(`endpoint: ${endpoint}`);
    console.log(`payload: ${args.payload}`);
    console.log("auth: API-Key from PUSHCUT_API_KEY (not displayed)");
    return;
  }

  const apiKey = process.env.PUSHCUT_API_KEY ?? "";
  if (!apiKey) throw new Error("PUSHCUT_API_KEY is required with --execute");
  if (!/^[A-Za-z0-9._-]{8,512}$/.test(apiKey)) {
    throw new Error("PUSHCUT_API_KEY contains unexpected characters");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "API-Key": apiKey },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`Pushcut HTTP ${response.status}: ${body.slice(0, 8192)}`);
    console.log(`HTTP ${response.status}`);
    if (body) console.log(body.slice(0, MAX_PAYLOAD_BYTES));
  } finally {
    clearTimeout(timer);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown error";
  console.error(`error: ${message}`);
  process.exitCode = 2;
});
