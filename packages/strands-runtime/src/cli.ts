import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { InterruptResponseContent, type Agent, type InvokeArgs } from "@strands-agents/sdk";
import { AcsClient, AcsError } from "./acs-client.js";
import { createAcsAgent } from "./agent.js";
import { createModel } from "./models.js";

async function stream(agent: Agent, input: InvokeArgs) {
  const events = agent.stream(input, { limits: { turns: 24 }, cancelSignal: AbortSignal.timeout(300_000) });
  while (true) {
    const next = await events.next();
    if (next.done) return next.value;
    const event = next.value;
    if (
      event.type === "modelStreamUpdateEvent" &&
      event.event.type === "modelContentBlockDeltaEvent" &&
      event.event.delta.type === "textDelta"
    ) {
      process.stdout.write(event.event.delta.text);
    }
  }
}

async function main() {
  const prompt = process.argv.slice(2).join(" ").trim();
  if (!prompt || prompt === "--help") {
    console.log(
      'HARNESS_MODEL=ollama/<model> HARNESS_ACS_URL=http://127.0.0.1:3000 HARNESS_ACS_TOKEN=<token> npm run harness -w packages/strands-runtime -- "prompt"'
    );
    return;
  }
  const env = process.env;
  if (!env.HARNESS_MODEL || !env.HARNESS_ACS_URL || !env.HARNESS_ACS_TOKEN)
    throw new AcsError("missing_harness_configuration");
  const sessionId = randomUUID();
  const agent = createAcsAgent({
    api: new AcsClient(env.HARNESS_ACS_URL, env.HARNESS_ACS_TOKEN),
    model: createModel(env.HARNESS_MODEL),
    sessionId
  });
  console.error(JSON.stringify({ sessionId }));
  let result = await stream(agent, prompt);
  while (result.stopReason === "interrupt") {
    console.error(JSON.stringify({ state: "paused", interrupts: result.interrupts }));
    if (!process.stdin.isTTY) {
      process.exitCode = 2;
      return;
    }
    const terminal = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await terminal.question("Resolve the work item in ACS, then enter resume (or quit): ");
    terminal.close();
    if (answer.trim() !== "resume") {
      process.exitCode = 2;
      return;
    }
    result = await stream(
      agent,
      result.interrupts!.map(
        (interrupt) => new InterruptResponseContent({ interruptId: interrupt.id, response: "check_acs" })
      )
    );
  }
  console.log();
  if (result.stopReason !== "endTurn") {
    console.error(JSON.stringify({ state: "incomplete", stopReason: result.stopReason }));
    process.exitCode = 2;
  }
}
main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      code: error instanceof AcsError ? error.code : "harness_failed",
      detail: "No automatic execution retry. Check provider configuration and ACS work-item state."
    })
  );
  process.exitCode = 1;
});
