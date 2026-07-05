import { readFileSync } from "node:fs";
import { auditEventSchema } from "@agent-control-stack/shared";
import { findUnapprovedExecution, replay } from "./index.js";

const input = process.argv[2] ? readFileSync(process.argv[2], "utf8") : readFileSync(0, "utf8");
const events = JSON.parse(input);

if (!Array.isArray(events)) {
  throw new Error("expected a JSON array of audit events");
}

const parsed = events.map((event) => auditEventSchema.parse(event));

console.log(
  JSON.stringify(
    {
      ...replay(parsed),
      unapprovedExecution: findUnapprovedExecution(parsed)
    },
    null,
    2
  )
);
