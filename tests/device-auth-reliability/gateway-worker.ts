import { SqliteWorkItemStore } from "@agent-control-stack/work-items";
import { buildGateway } from "../../apps/gateway/src/server.js";

const dbPath = process.env.ACS_DB_PATH;
const token = process.env.ACS_GATEWAY_TOKEN;
const actorId = process.env.ACS_GATEWAY_ACTOR_ID ?? "operator-1";
const actor = process.env.ACS_GATEWAY_ACTOR ?? "user";

if (!dbPath || !token) {
  console.error("ACS_DB_PATH and ACS_GATEWAY_TOKEN are required");
  process.exit(1);
}

const seed = new SqliteWorkItemStore(dbPath);
try {
  seed.registerActor({ id: actorId, actorType: "HUMAN", displayName: "Operator One" });
} catch {
  // Actor already registered on shared DB
} finally {
  seed.close();
}

const app = buildGateway({
  dbPath,
  logger: false,
  auth: {
    token,
    actor,
    actorId
  }
});

const address = await app.listen({ port: 0, host: "127.0.0.1" });
process.stdout.write(`READY ${address}\n`);

const shutdown = async () => {
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
