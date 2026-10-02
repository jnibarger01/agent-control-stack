import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

/**
 * Run the installed Hermes source with a disposable installation identity.
 * HERMES_HOME alone isolates configuration, but its bootstrap can still publish
 * launchers into the original checkout. Copy source and the selected dependency
 * generation so bootstrap, launcher repair, and generation leases stay local.
 */
export function prepareHermesSourceFixture(installedLauncher: string, directory: string, home: string) {
  const sourceRoot = dirname(dirname(dirname(installedLauncher)));
  if (!existsSync(join(sourceRoot, "hermes_bootstrap.py"))) {
    throw new Error("Hermes interoperability fixture requires an installation-bound source launcher");
  }
  const inspectionEnv = { HOME: homedir(), PATH: process.env.PATH };
  const runtimeCommand: unknown = JSON.parse(
    execFileSync(installedLauncher, ["--print-runtime-command"], { env: inspectionEnv, encoding: "utf8" })
  );
  if (!Array.isArray(runtimeCommand) || typeof runtimeCommand[0] !== "string" || !isAbsolute(runtimeCommand[0])) {
    throw new Error("Hermes launcher did not identify its installed Python runtime");
  }
  const python = runtimeCommand[0];
  const metadata = JSON.parse(
    execFileSync(
      python,
      [
        "-I",
        "-c",
        `
import json, sys
from pathlib import Path
root = Path(sys.argv[1])
sys.path.insert(0, str(root))
from pm.environments import install_state_dir, committed_venv, store_root
environment = committed_venv(root)
if environment is None:
    raise RuntimeError("Hermes has no committed dependency generation")
print(json.dumps({"state": str(install_state_dir(root)), "environment": str(environment), "runtime": str(store_root(root))}))
`,
        sourceRoot
      ],
      { env: inspectionEnv, encoding: "utf8" }
    )
  ) as Record<string, unknown>;
  for (const key of ["state", "environment", "runtime"] as const) {
    if (typeof metadata[key] !== "string" || !isAbsolute(metadata[key])) {
      throw new Error("Hermes installation metadata contains an invalid path");
    }
  }
  const fixtureRoot = join(directory, "hermes-source");
  mkdirSync(fixtureRoot);
  const tracked = execFileSync("git", ["-C", sourceRoot, "ls-files", "-z"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  for (const relative of tracked.split("\0").filter(Boolean)) {
    const first = relative.split("/")[0];
    if (["tests", "docs", ".github", ".hermes", ".env"].includes(first)) continue;
    const destination = resolve(fixtureRoot, relative);
    if (!destination.startsWith(fixtureRoot + sep)) throw new Error("Hermes tracked path escapes the fixture");
    const source = join(sourceRoot, relative);
    if (!existsSync(source)) continue;
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { preserveTimestamps: true });
  }
  // Use Hermes's own installation key and launcher writer. Only dependency
  // metadata and code are copied; operator configuration and credentials are not.
  execFileSync(
    python,
    [
      "-I",
      "-c",
      `
import json, shutil, sys
from pathlib import Path
source, fixture, state, environment = map(Path, sys.argv[1:5])
sys.path.insert(0, str(source))
from pm.environments import install_state_dir
from hermes_cli._launchers import mint_launcher
destination = install_state_dir(fixture)
destination.mkdir(parents=True, exist_ok=True)
generation = destination / "environments" / environment.parent.name
shutil.copytree(environment.parent, generation, symlinks=True)
# Editable dependency members can contain the original absolute source path.
# Rewrite only the copied installation metadata so imports stay in the fixture.
for metadata in generation.rglob("*.pth"):
    metadata.write_text(metadata.read_text().replace(str(source), str(fixture)))
for metadata in generation.rglob("__editable__*.py"):
    metadata.write_text(metadata.read_text().replace(str(source), str(fixture)))
facts = json.loads((state / "facts.json").read_text())
facts["packages"]["venv"]["environment"] = str(generation / environment.name)
lock = facts["packages"]["venv"].get("resolved_lock")
if lock:
    facts["packages"]["venv"]["resolved_lock"] = str(generation / Path(lock).relative_to(environment.parent))
(destination / "facts.json").write_text(json.dumps(facts))
if (state / "inputs").is_dir():
    shutil.copytree(state / "inputs", destination / "inputs")
output = fixture / ".hermes" / "bin"
output.mkdir(parents=True, exist_ok=True)
assert mint_launcher("hermes", fixture, fixture / ".hermes" / "bin", Path(sys.executable), None)
`,
      sourceRoot,
      fixtureRoot,
      String(metadata.state),
      String(metadata.environment)
    ],
    {
      env: { ...inspectionEnv, HERMES_HOME: home, HERMES_RUNTIME_DIR: String(metadata.runtime) },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  return {
    launcher: join(fixtureRoot, ".hermes", "bin", "hermes"),
    runtimeDirectory: String(metadata.runtime),
    sourceRoot: fixtureRoot
  };
}
