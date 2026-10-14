import * as realFs from "node:fs";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const hook = vi.hoisted(() => ({ fn: undefined as undefined | ((p: string) => void) }));
vi.mock("node:fs", async (orig) => {
  const actual = (await orig()) as typeof realFs;
  const realpath = (p: string) => {
    hook.fn?.(p);
    return actual.realpathSync(p);
  };
  return { ...actual, default: { ...actual, realpathSync: realpath }, realpathSync: realpath };
});

import { cleanupWorlds, world } from "./general-coding-fixture.js";

const cleanups: string[] = [];
afterEach(() => {
  hook.fn = undefined;
  cleanupWorlds();
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type World = ReturnType<typeof world>;
const setRepository = (w: World, repository: string) =>
  w.exec.missions.db
    .prepare("UPDATE coding_operations SET payload_json=? WHERE mission_id=? AND operation_id='u1'")
    .run(JSON.stringify({ ...(w.unit().payload as object), repository }), w.item.id);

describe("general coding scope check is judged on the pinned path (#361)", () => {
  it("never executes when a pinned outside path only resolves into scope while a second resolution runs", async () => {
    const w = world({ scope: (repo) => [{ kind: "repository", id: join(repo, ".."), coverage: "descendants" }] });
    mkdirSync(w.repository, { recursive: true });
    const outsideParent = realpathSync(mkdtempSync(join(tmpdir(), "acs-361-outside-")));
    cleanups.push(outsideParent, `${outsideParent}-real`);
    const outsideRepository = join(outsideParent, "acs");
    mkdirSync(outsideRepository);
    setRepository(w, outsideRepository);

    // Resolution #1 pins the path. Any later resolution of it during the scope check sees the parent
    // swapped into scope; the swap is undone on the resolution after that.
    let calls = 0;
    hook.fn = (p) => {
      if (p !== outsideRepository) return;
      calls++;
      if (calls === 2) {
        renameSync(outsideParent, `${outsideParent}-real`);
        symlinkSync(join(w.repository, ".."), outsideParent);
      }
      if (calls === 3) {
        rmSync(outsideParent);
        renameSync(`${outsideParent}-real`, outsideParent);
      }
    };

    const executed: string[] = [];
    await w.run([
      w.adapter(
        w.executor(async (request) => {
          executed.push(request.task.repository);
          return w.good();
        })
      )
    ]);
    expect(executed).toHaveLength(0);
  });
});
