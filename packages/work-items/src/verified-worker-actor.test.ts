import { describe, expect, it } from "vitest";
import { SqliteWorkItemStore, WORKER_ACTOR_REF_PREFIX } from "./store.js";

function fixture() {
  const store = new SqliteWorkItemStore(":memory:");
  store.registerActor({ id: "operator", actorType: "HUMAN", displayName: "Operator" });
  store.registerActor({ id: "intruder", actorType: "AGENT", displayName: "An agent with a mutation credential" });
  return store;
}
const bind = (
  store: SqliteWorkItemStore,
  workerId: string,
  by: string | undefined,
  id = `actor-${workerId}`,
  type: "AGENT" | "SERVICE" | "HUMAN" | "SYSTEM" = "AGENT"
) =>
  store.registerActor({
    id,
    actorType: type,
    displayName: id,
    externalRef: `${WORKER_ACTOR_REF_PREFIX}${workerId}`,
    ...(by ? { registeredByActorId: by } : {})
  });

describe("isHumanOperator", () => {
  it("is true only for a registered HUMAN actor", () => {
    const store = fixture();
    expect(store.isHumanOperator("operator")).toBe(true);
    expect(store.isHumanOperator("intruder")).toBe(false);
    expect(store.isHumanOperator("nobody")).toBe(false);
    expect(store.isHumanOperator("")).toBe(false);
  });
});

describe("resolveVerifiedWorkerActor", () => {
  it("resolves a worker bound to an agent actor by a human operator", () => {
    const store = fixture();
    bind(store, "worker-1", "operator");
    expect(store.resolveVerifiedWorkerActor("worker-1")).toBe("actor-worker-1");
  });

  it("accepts a SERVICE actor too", () => {
    const store = fixture();
    bind(store, "svc", "operator", "actor-svc", "SERVICE");
    expect(store.resolveVerifiedWorkerActor("svc")).toBe("actor-svc");
  });

  it("never treats a worker id as an actor id", () => {
    const store = fixture();
    expect(store.resolveVerifiedWorkerActor("operator")).toBeUndefined();
    expect(store.resolveVerifiedWorkerActor("intruder")).toBeUndefined();
  });

  it("does not resolve a worker nobody bound", () => {
    expect(fixture().resolveVerifiedWorkerActor("ghost")).toBeUndefined();
  });

  it("refuses a binding nobody registered: self-registration is not provenance", () => {
    const store = fixture();
    bind(store, "worker-1", undefined);
    expect(store.resolveVerifiedWorkerActor("worker-1")).toBeUndefined();
  });

  it("refuses a binding registered by a non-human, even with a mutation credential", () => {
    const store = fixture();
    bind(store, "worker-1", "intruder");
    expect(store.resolveVerifiedWorkerActor("worker-1")).toBeUndefined();
  });

  it("refuses a worker bound to a HUMAN or SYSTEM actor", () => {
    const store = fixture();
    bind(store, "w-human", "operator", "actor-human", "HUMAN");
    bind(store, "w-system", "operator", "actor-system", "SYSTEM");
    expect(store.resolveVerifiedWorkerActor("w-human")).toBeUndefined();
    expect(store.resolveVerifiedWorkerActor("w-system")).toBeUndefined();
  });

  it("refuses when the reference is ambiguous", () => {
    const store = fixture();
    bind(store, "worker-1", "operator", "actor-a");
    bind(store, "worker-1", "operator", "actor-b");
    expect(store.resolveVerifiedWorkerActor("worker-1")).toBeUndefined();
  });

  it("stops resolving once a non-operator re-registers the actor (POST /actors overwrites)", () => {
    const store = fixture();
    bind(store, "worker-1", "operator");
    expect(store.resolveVerifiedWorkerActor("worker-1")).toBe("actor-worker-1");
    // The same actor id is overwritten by an intruder: the latest registration now has no human provenance.
    bind(store, "worker-1", "intruder");
    expect(store.resolveVerifiedWorkerActor("worker-1")).toBeUndefined();
  });

  it("refuses an actor whose current row no longer matches its registration event", () => {
    const store = fixture();
    bind(store, "worker-1", "operator");
    // A direct edit of the row (not through registerActor) leaves the audited registration behind.
    (store as unknown as { db: { exec(sql: string): void } }).db.exec(
      `UPDATE actors SET actor_type = 'SERVICE' WHERE id = 'actor-worker-1'`
    );
    expect(store.resolveVerifiedWorkerActor("worker-1")).toBeUndefined();
  });

  it("does not let one worker's binding stand in for another's", () => {
    const store = fixture();
    bind(store, "worker-1", "operator");
    expect(store.resolveVerifiedWorkerActor("worker-2")).toBeUndefined();
    expect(store.resolveVerifiedWorkerActor("worker-1 ")).toBeUndefined();
  });

  it.each(["", " ", "../x", "a b", "a\nb", "x".repeat(129), "-lead", "w;drop"])(
    "refuses the malformed worker id %j",
    (id) => {
      const store = fixture();
      bind(store, "worker-1", "operator");
      expect(store.resolveVerifiedWorkerActor(id)).toBeUndefined();
    }
  );
});
