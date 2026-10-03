import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export interface HermesInstallation {
  launcher: string;
  sourceRoot: string;
  python: string;
  runtimeRoot: string;
  installState: string;
  environment: string;
  hermesHome: string;
}

export interface HermesFixture extends HermesInstallation {
  fixtureRoot: string;
  fixtureHome: string;
  fixtureRuntime: string;
  fixtureState: string;
  fixtureEnvironment: string;
  fixturePython: string;
  fixtureLauncher: string;
  fixtureAcPLauncher: string;
  fixtureManifestBefore?: HermesManifestEntry[];
  defaultPluginConfig: { enabled: string[]; disabled: string[]; memoryProvider?: string };
  persistentRoots: string[];
}

const PERSISTENT_HERMES_ROOT = "/home/jacen/.hermes";

function findInstalledLauncher(executable: string): string {
  const candidate = realpathSync(executable);
  for (let depth = 0; depth < 4; depth += 1) {
    const contents = readFileSync(candidate, "utf8");
    const match = contents.match(/^exec\s+['"]?(\/[^\s'";]+\.hermes\/bin\/hermes)['"]?/m);
    if (match?.[1] && existsSync(match[1])) return realpathSync(match[1]);
    if (candidate.includes(`${sep}.hermes${sep}bin${sep}hermes`)) return candidate;
    throw new Error(`Hermes executable is not an installation-bound source launcher: ${candidate}`);
  }
  throw new Error("Hermes launcher forwarding depth exceeded the supported bound");
}

export function inspectHermesInstallation(executable: string): HermesInstallation {
  const launcher = findInstalledLauncher(executable);
  const sourceRoot = dirname(dirname(dirname(launcher)));
  const launcherText = readFileSync(launcher, "utf8");
  const persistentTools = realpathSync(join(PERSISTENT_HERMES_ROOT, "tools"));
  const launcherRuntime = launcherText.match(/\/tools\/([^/\s'";]+)\/bin\/python3(?:\s|$)/m)?.[1];
  if (!launcherRuntime) throw new Error("Hermes source launcher does not identify its runtime generation");
  const runtimeFacts = JSON.parse(readFileSync(join(persistentTools, "facts.json"), "utf8")) as {
    packages?: Record<string, { entry?: unknown }>;
  };
  const pythonEntry = runtimeFacts.packages?.python?.entry;
  if (typeof pythonEntry !== "string" || pythonEntry !== launcherRuntime || !/^[a-zA-Z0-9._+-]+$/.test(pythonEntry)) {
    throw new Error("Persistent Hermes runtime facts do not match the launcher generation");
  }
  const interpreter = join(persistentTools, pythonEntry, "bin", "python3");
  if (!existsSync(interpreter) || !realpathSync(interpreter).startsWith(`${persistentTools}${sep}`)) {
    throw new Error("Persistent Hermes runtime metadata does not resolve to an installed Python executable");
  }
  const hermesHome = realpathSync(PERSISTENT_HERMES_ROOT);
  const installKey = createHash("sha256").update(realpathSync(sourceRoot)).digest("hex").slice(0, 16);
  const installState = join(hermesHome, "installs", installKey);
  const installFacts = JSON.parse(readFileSync(join(installState, "facts.json"), "utf8")) as {
    packages?: Record<string, { environment?: unknown }>;
  };
  const environment = installFacts.packages?.venv?.environment;
  if (typeof environment !== "string" || !isAbsolute(environment) || !environment.startsWith(`${installState}${sep}`)) {
    throw new Error("Persistent Hermes install facts do not identify an environment inside install state");
  }
  const status = execFileSync("git", ["-C", sourceRoot, "status", "--porcelain=v1", "--untracked-files=no"], {
    encoding: "utf8"
  });
  if (status.trim())
    throw new Error("Installed Hermes source has tracked modifications; refusing to copy an ambiguous source tree");
  return {
    launcher,
    sourceRoot,
    python: interpreter,
    installState,
    environment,
    runtimeRoot: persistentTools,
    hermesHome
  };
}

function copyTrackedSource(sourceRoot: string, fixtureRoot: string): void {
  execFileSync("git", ["clone", "--no-local", "--depth", "1", "--no-hardlinks", "--no-tags", sourceRoot, fixtureRoot], {
    encoding: "utf8",
    stdio: "pipe"
  });
  execFileSync("git", [
    "-C",
    fixtureRoot,
    "remote",
    "set-url",
    "origin",
    "https://github.com/NousResearch/Hermes-Agent.git"
  ]);
}

interface HermesPluginHome {
  relativeHome: string;
  enabled: string[];
  disabled: string[];
  memoryProvider?: string;
  plugins: Array<{ name: string; source: string }>;
}

function yamlScalar(value: string): string {
  const trimmed = value.trim().replace(/\s+#.*$/, "");
  if (trimmed.startsWith('"')) return JSON.parse(trimmed) as string;
  if (trimmed.startsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'");
  return trimmed;
}

function yamlStringList(value: string, followingItems: string[]): string[] {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "[]") return followingItems;
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) throw new Error("Unsupported Hermes plugin list syntax");
  const body = trimmed.slice(1, -1).trim();
  if (!body) return followingItems;
  const entries = body.split(",").map(yamlScalar);
  if (entries.some((entry) => !entry)) throw new Error("Hermes plugin list contains an empty entry");
  return [...entries, ...followingItems];
}

function parsePluginSelection(configPath: string): { enabled: string[]; disabled: string[]; memoryProvider?: string } {
  if (!existsSync(configPath)) return { enabled: [], disabled: [] };
  const lines = readFileSync(configPath, "utf8").split(/\r?\n/);
  let section = "";
  let listName: "enabled" | "disabled" | undefined;
  let listValue = "";
  let listItems: string[] = [];
  let enabled: string[] = [];
  let disabled: string[] = [];
  let memoryProvider: string | undefined;
  const finishList = () => {
    if (!listName) return;
    const values = yamlStringList(listValue, listItems);
    if (values.some((value) => !value)) throw new Error(`Invalid Hermes ${listName} plugin name in ${configPath}`);
    if (listName === "enabled") enabled = values;
    else disabled = values;
    listName = undefined;
    listValue = "";
    listItems = [];
  };

  for (const line of lines) {
    const topLevel = line.match(/^([A-Za-z0-9_-]+):(?:\s|$)/);
    if (topLevel) {
      finishList();
      section = topLevel[1] ?? "";
      continue;
    }
    if (section === "plugins") {
      const setting = line.match(/^ {2}(enabled|disabled):\s*(.*?)\s*$/);
      if (setting) {
        finishList();
        listName = setting[1] as "enabled" | "disabled";
        listValue = setting[2] ?? "";
        continue;
      }
      const item = line.match(/^ {4}-\s*(.*?)\s*$/);
      if (item && listName) {
        listItems.push(yamlScalar(item[1] ?? ""));
        continue;
      }
      if (/^\s*(?:#.*)?$/.test(line) || /^\s{2,}\S/.test(line)) continue;
      if (line.trim()) throw new Error(`Unsupported Hermes plugin config syntax in ${configPath}`);
    } else if (section === "memory") {
      const provider = line.match(/^ {2}provider:\s*(.*?)\s*$/);
      if (provider) memoryProvider = yamlScalar(provider[1] ?? "");
    }
  }
  finishList();
  return { enabled, disabled, ...(memoryProvider ? { memoryProvider } : {}) };
}

function inspectHermesPluginHomes(installation: HermesInstallation): HermesPluginHome[] {
  const profilesRoot = join(installation.hermesHome, "profiles");
  const homes = [installation.hermesHome];
  if (existsSync(profilesRoot)) {
    for (const name of readdirSync(profilesRoot).sort()) {
      if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name) || name === "default") continue;
      const profile = join(profilesRoot, name);
      if (!lstatSync(profile).isDirectory() || existsSync(join(profilesRoot, ".deleted", name))) continue;
      const markers = ["config.yaml", ".env", "SOUL.md", "profile.yaml", "auth.json", "state.db"];
      if (
        !markers.some(
          (marker) =>
            existsSync(join(profile, marker)) ||
            (() => {
              try {
                return lstatSync(join(profile, marker)).isSymbolicLink();
              } catch {
                return false;
              }
            })()
        )
      )
        continue;
      homes.push(profile);
    }
  }

  return homes.map((home) => {
    const selection = parsePluginSelection(join(home, "config.yaml"));
    const enabled = selection.enabled.filter(
      (name, index) =>
        !selection.disabled.includes(name) &&
        !selection.disabled.includes(name.split("/").at(-1) ?? name) &&
        selection.enabled.indexOf(name) === index
    );
    const names = [...enabled];
    if (
      selection.memoryProvider &&
      !names.includes(selection.memoryProvider) &&
      existsSync(join(home, "plugins", selection.memoryProvider))
    ) {
      names.push(selection.memoryProvider);
    }
    const plugins = names.flatMap((name) => {
      const relativePlugin = name.split(/[\\/]/);
      if (isAbsolute(name) || relativePlugin.includes("..") || relativePlugin.some((part) => !part)) {
        throw new Error(`Invalid Hermes plugin path in ${join(home, "config.yaml")}`);
      }
      const homePlugin = join(home, "plugins", ...relativePlugin);
      const source = existsSync(homePlugin) ? homePlugin : join(installation.sourceRoot, "plugins", ...relativePlugin);
      return existsSync(source) ? [{ name, source: realpathSync(source) }] : [];
    });
    return {
      relativeHome: relative(installation.hermesHome, home) || ".",
      enabled,
      disabled: selection.disabled,
      ...(selection.memoryProvider ? { memoryProvider: selection.memoryProvider } : {}),
      plugins
    };
  });
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function writePluginHome(home: string, selection: HermesPluginHome): void {
  mkdirSync(home, { recursive: true });
  const lines = [
    "plugins:",
    `  enabled: ${JSON.stringify(selection.enabled)}`,
    `  disabled: ${JSON.stringify(selection.disabled)}`
  ];
  if (selection.memoryProvider) lines.push("memory:", `  provider: ${yamlString(selection.memoryProvider)}`);
  writeFileSync(join(home, "config.yaml"), `${lines.join("\n")}\n`);
}

function copyPluginHomes(
  homes: HermesPluginHome[],
  installation: HermesInstallation,
  fixtureRoot: string,
  fixtureHome: string
): HermesPluginHome[] {
  for (const selection of homes) {
    const destinationHome = selection.relativeHome === "." ? fixtureHome : join(fixtureHome, selection.relativeHome);
    writePluginHome(destinationHome, selection);
    for (const plugin of selection.plugins) {
      const source = realpathSync(plugin.source);
      if (source === installation.sourceRoot || source.startsWith(`${installation.sourceRoot}${sep}`)) continue;
      const target = join(destinationHome, "plugins", plugin.name);
      mkdirSync(dirname(target), { recursive: true });
      cpSync(source, target, { recursive: true, preserveTimestamps: true, dereference: true, force: true });
    }
  }
  return homes;
}

function rewriteCopiedEnvironment(
  fixtureRoot: string,
  fixtureHome: string,
  fixtureRuntime: string,
  installation: HermesInstallation
): { state: string; environment: string; python: string } {
  const key = createHash("sha256").update(realpathSync(fixtureRoot)).digest("hex").slice(0, 16);
  const fixtureState = join(fixtureHome, "installs", key);
  const sourceGeneration = dirname(installation.environment);
  const generationName = sourceGeneration.split(sep).at(-1);
  if (!generationName) throw new Error("Hermes dependency generation has no stable name");
  const fixtureGeneration = join(fixtureState, "environments", generationName);
  const fixtureEnvironment = join(fixtureGeneration, "venv");
  mkdirSync(dirname(fixtureGeneration), { recursive: true });
  cpSync(sourceGeneration, fixtureGeneration, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    filter: (path) => !path.split(sep).includes("__pycache__") && !path.endsWith(".pyc")
  });
  const fixturePmRuntime = join(fixtureState, "pm-runtime");
  cpSync(join(installation.installState, "pm-runtime"), fixturePmRuntime, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    filter: (path) => !path.split(sep).includes("__pycache__") && !path.endsWith(".pyc")
  });

  const oldEnvironment = installation.environment;
  const oldRuntime = installation.runtimeRoot;
  const replacePaths = (value: string) =>
    [
      [oldEnvironment, fixtureEnvironment],
      [installation.installState, fixtureState],
      [oldRuntime, fixtureRuntime],
      [installation.sourceRoot, fixtureRoot],
      [installation.hermesHome, fixtureHome]
    ].reduce((text, [oldPath, newPath]) => text.replaceAll(oldPath, newPath), value);

  const configPath = join(fixtureEnvironment, "pyvenv.cfg");
  writeFileSync(configPath, replacePaths(readFileSync(configPath, "utf8")));
  const bin = join(fixtureEnvironment, "bin");
  for (const name of readdirSync(bin)) {
    const path = join(bin, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) {
      const target = readlinkSync(path);
      if (
        isAbsolute(target) &&
        [oldEnvironment, oldRuntime, installation.installState, installation.hermesHome].some((oldPath) =>
          target.startsWith(oldPath)
        )
      ) {
        const updated = replacePaths(target);
        lstatSync(path);
        unlinkSync(path);
        symlinkSync(updated, path);
      }
      continue;
    }
    if (!info.isFile() || info.size > 1024 * 1024) continue;
    const text = readFileSync(path);
    if (text.subarray(0, 2).toString("utf8") !== "#!") continue;
    const updated = replacePaths(text.toString("utf8"));
    if (updated !== text.toString("utf8")) writeFileSync(path, updated, { mode: info.mode });
  }
  for (const path of walkFiles(fixtureEnvironment)) {
    if (!path.endsWith(".pth") && !path.split(sep).at(-1)?.startsWith("__editable__")) continue;
    if (lstatSync(path).isSymbolicLink()) continue;
    const original = readFileSync(path, "utf8");
    const updated = replacePaths(original);
    if (updated !== original) writeFileSync(path, updated);
  }

  for (const path of walkFiles(fixturePmRuntime)) {
    if (lstatSync(path).isSymbolicLink()) continue;
    const info = lstatSync(path);
    if (!info.isFile() || info.size > 1024 * 1024) continue;
    const original = readFileSync(path);
    const updated = replacePaths(original.toString("utf8"));
    if (updated !== original.toString("utf8")) writeFileSync(path, updated, { mode: info.mode });
  }
  for (const root of [fixtureEnvironment, fixturePmRuntime]) {
    for (const path of walkFiles(root)) {
      if (!lstatSync(path).isSymbolicLink()) continue;
      const target = readlinkSync(path);
      if (isAbsolute(target)) {
        const updated = replacePaths(target);
        if (updated !== target) {
          unlinkSync(path);
          symlinkSync(updated, path);
        }
      }
    }
  }

  const factsPath = join(installation.installState, "facts.json");
  const facts = JSON.parse(readFileSync(factsPath, "utf8")) as {
    packages?: Record<string, { environment?: unknown; resolved_lock?: unknown }>;
  };
  const venv = facts.packages?.venv;
  if (!venv || typeof venv !== "object") throw new Error("Hermes dependency facts omit the committed venv");
  venv.environment = fixtureEnvironment;
  if (typeof venv.resolved_lock === "string") {
    const relativeLock = relative(sourceGeneration, venv.resolved_lock);
    venv.resolved_lock =
      relativeLock && !relativeLock.startsWith(`..${sep}`)
        ? join(fixtureGeneration, relativeLock)
        : replacePaths(venv.resolved_lock);
  }
  mkdirSync(fixtureState, { recursive: true });
  const environmentsRoot = join(installation.installState, "environments");
  const pmRuntimeRoot = join(installation.installState, "pm-runtime");
  cpSync(installation.installState, fixtureState, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true,
    filter: (path) =>
      path !== environmentsRoot &&
      !path.startsWith(`${environmentsRoot}${sep}`) &&
      path !== pmRuntimeRoot &&
      !path.startsWith(`${pmRuntimeRoot}${sep}`)
  });
  writeFileSync(join(fixtureState, "facts.json"), `${JSON.stringify(facts)}\n`);
  const inputStamps = join(installation.installState, "inputs");
  if (existsSync(inputStamps)) {
    cpSync(inputStamps, join(fixtureState, "inputs"), { recursive: true, preserveTimestamps: true });
    const projectMarker = join(fixtureState, "inputs", ".project-root");
    if (existsSync(projectMarker)) writeFileSync(projectMarker, `${fixtureRoot}\n`);
  }
  for (const path of walkFiles(fixtureState)) {
    const info = lstatSync(path);
    if (!info.isFile() || info.size > 1024 * 1024) continue;
    const original = readFileSync(path, "utf8");
    const updated = replacePaths(original);
    if (updated !== original) writeFileSync(path, updated, { mode: info.mode });
  }
  for (const name of ["source-completion-pending", "source-completion-attempts"] as const) {
    const source = join(installation.installState, name);
    if (existsSync(source)) cpSync(source, join(fixtureState, name), { preserveTimestamps: true });
  }
  const selectedRuntime = join(fixturePmRuntime, "selected.json");
  if (!existsSync(selectedRuntime)) throw new Error("Fixture PM runtime selection is missing");
  return {
    state: fixtureState,
    environment: fixtureEnvironment,
    python: replacePaths(installation.python)
  };
}

function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const results: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else results.push(path);
    }
  }
  return results;
}

function assertFixtureOwnedExecution(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  const persistentRoot = realpathSync(PERSISTENT_HERMES_ROOT);
  const isPersistentPath = (value: string) => {
    const canonical = resolve(value);
    const fromRoot = relative(persistentRoot, canonical);
    return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
  };
  const candidates = [
    executable,
    cwd,
    ...args,
    ...Object.values(env).filter((value): value is string => typeof value === "string")
  ];
  for (const candidate of candidates) {
    const paths = candidate === env.PATH ? candidate.split(sep) : [candidate];
    if (paths.some((path) => path.includes(persistentRoot) || (isAbsolute(path) && isPersistentPath(path)))) {
      throw new Error(
        `Hermes fixture preparation attempted persistent Hermes execution or environment access: ${candidate}`
      );
    }
  }
}

export function assertHermesPathContained(fixtureRoot: string, candidate: string): string {
  const fixture = realpathSync(fixtureRoot);
  let resolved = resolve(candidate);
  const suffix: string[] = [];
  while (!existsSync(resolved)) {
    suffix.unshift(resolved.split(sep).at(-1) as string);
    resolved = dirname(resolved);
  }
  const canonical = join(realpathSync(resolved), ...suffix);
  const fromFixture = relative(fixture, canonical);
  if (fromFixture === ".." || fromFixture.startsWith(`..${sep}`) || isAbsolute(fromFixture)) {
    throw new Error(`Hermes mutable path escapes fixture root: ${candidate} -> ${canonical}; root=${fixture}`);
  }
  return canonical;
}

export function prepareHermesE2eFixture(executable: string, directory: string): HermesFixture {
  const installation = inspectHermesInstallation(executable);
  const expectedSource = join(PERSISTENT_HERMES_ROOT, "hermes-agent");
  const expectedHead = "f42f579cf8bac4918ac9599bece71618afadd846";
  if (realpathSync(installation.sourceRoot) !== realpathSync(expectedSource)) {
    throw new Error(`Hermes control launcher resolved an unexpected source root: ${installation.sourceRoot}`);
  }
  const actualHead = execFileSync("git", ["-C", installation.sourceRoot, "rev-parse", "HEAD"], {
    encoding: "utf8"
  }).trim();
  if (actualHead !== expectedHead) throw new Error(`Persistent Hermes source baseline changed: ${actualHead}`);
  if (realpathSync(installation.hermesHome) !== realpathSync(PERSISTENT_HERMES_ROOT)) {
    throw new Error(`Persistent Hermes home changed: ${installation.hermesHome}`);
  }
  if (realpathSync(installation.runtimeRoot) !== realpathSync(join(PERSISTENT_HERMES_ROOT, "tools"))) {
    throw new Error(`Persistent Hermes tools root changed: ${installation.runtimeRoot}`);
  }
  if (basename(dirname(installation.environment)) !== "c79aaa48537141acb732fd679648cba4") {
    throw new Error(`Persistent Hermes app dependency generation changed: ${installation.environment}`);
  }
  const fixtureRoot = join(directory, "hermes-source");
  const fixtureHome = join(directory, "hermes-home");
  const fixtureRuntime = join(fixtureHome, "tools");
  mkdirSync(fixtureRoot, { recursive: true });
  mkdirSync(fixtureHome, { recursive: true });
  const pluginHomes = inspectHermesPluginHomes(installation);
  copyTrackedSource(installation.sourceRoot, fixtureRoot);
  copyPluginHomes(pluginHomes, installation, fixtureRoot, fixtureHome);
  cpSync(installation.runtimeRoot, fixtureRuntime, {
    recursive: true,
    preserveTimestamps: true,
    verbatimSymlinks: true
  });
  for (const path of walkFiles(fixtureRuntime)) {
    if (!lstatSync(path).isSymbolicLink()) continue;
    const target = readlinkSync(path);
    if (!isAbsolute(target)) continue;
    const updated = target
      .replaceAll(installation.runtimeRoot, fixtureRuntime)
      .replaceAll(installation.hermesHome, fixtureHome);
    if (updated !== target) {
      unlinkSync(path);
      symlinkSync(updated, path);
    }
  }
  const copied = rewriteCopiedEnvironment(fixtureRoot, fixtureHome, fixtureRuntime, installation);
  const launcherDirectory = join(fixtureRoot, ".hermes", "bin");
  mkdirSync(launcherDirectory, { recursive: true });
  for (const name of ["install-stamp.json", ".hermes-bootstrap-complete"] as const) {
    const source = join(installation.sourceRoot, name);
    if (existsSync(source)) {
      cpSync(source, join(fixtureRoot, name), { preserveTimestamps: true });
      if (name === "install-stamp.json") {
        const stamp = readFileSync(join(fixtureRoot, name), "utf8");
        writeFileSync(
          join(fixtureRoot, name),
          stamp
            .replaceAll(installation.installState, copied.state)
            .replaceAll(installation.environment, copied.environment)
            .replaceAll(installation.runtimeRoot, fixtureRuntime)
            .replaceAll(installation.hermesHome, fixtureHome)
            .replaceAll(installation.sourceRoot, fixtureRoot)
        );
      }
    }
  }
  const fixturePython = join(fixtureRuntime, relative(installation.runtimeRoot, installation.python));
  const fixtureEnvironment = {
    HOME: join(directory, "home"),
    HERMES_HOME: fixtureHome,
    HERMES_RUNTIME_DIR: fixtureRuntime,
    HERMES_INSTALL_ROOT: fixtureRoot,
    XDG_CONFIG_HOME: join(directory, "xdg", "config"),
    XDG_CACHE_HOME: join(directory, "xdg", "cache"),
    XDG_DATA_HOME: join(directory, "xdg", "data"),
    UV_CACHE_DIR: join(directory, "uv-cache"),
    TMPDIR: join(directory, "tmp"),
    PATH: `${dirname(fixturePython)}:/usr/bin:/bin`
  };
  mkdirSync(fixtureEnvironment.HOME, { recursive: true });
  for (const path of [
    fixtureEnvironment.XDG_CONFIG_HOME,
    fixtureEnvironment.XDG_CACHE_HOME,
    fixtureEnvironment.XDG_DATA_HOME,
    fixtureEnvironment.UV_CACHE_DIR,
    fixtureEnvironment.TMPDIR
  ])
    mkdirSync(path, { recursive: true });
  const launcherArgs = ["-B", join(fixtureRoot, "hermes_cli", "_launchers.py"), launcherDirectory];
  assertFixtureOwnedExecution(fixturePython, launcherArgs, fixtureRoot, fixtureEnvironment);
  execFileSync(fixturePython, launcherArgs, { cwd: fixtureRoot, env: fixtureEnvironment, stdio: "pipe" });
  const launcher = join(launcherDirectory, "hermes");
  const acpLauncher = join(launcherDirectory, "hermes-acp");

  const readyArgs = [
    "-B",
    "-I",
    "-c",
    `import json,sys\nfrom pathlib import Path\nroot=Path(sys.argv[1])\nsys.path.insert(0,str(root))\nimport pm\nfrom hermes_constants import get_default_hermes_root\nfrom pm.environments import activate_dependencies,committed_venv,install_state_dir,store_root\nactivate_dependencies(root)\nfrom pm.packages import Venv\nfrom pm.install import _still_declared\nfrom pm.workspace import enabled_member_dirs\nfrom pm._uv import _toolchain\nfrom pm.runtime import _inputs,runtime_python\nenv=committed_venv(root)\nif env is None: raise RuntimeError("fixture has no committed dependency generation")\nstate=install_state_dir(root); facts_path=state/"facts.json"; facts=json.loads(facts_path.read_text()); fact=facts["packages"]["venv"]\nfact["stamp"]=Venv(root).expected_stamp(_still_declared(Venv(root),fact["extras"]),plugin_dirs=enabled_member_dirs())\nfacts_path.write_text(json.dumps(facts)+"\\n")\nruntime=state/"pm-runtime"; selected_path=runtime/"selected.json"; selected=json.loads(selected_path.read_text()); generation=runtime/selected["generation"]; tools=_toolchain(realize=False)\nif tools is None: raise RuntimeError("fixture PM toolchain metadata is unavailable")\nidentity=_inputs(root/"pm",tools[1])\nselected["inputs"]=identity; selected_path.write_text(json.dumps(selected)+"\\n"); marker=generation/"pm-runtime.json"; runtime_fact=json.loads(marker.read_text()); runtime_fact["inputs"]=identity; marker.write_text(json.dumps(runtime_fact)+"\\n")\nmanager=runtime_python(bootstrap=False)\nif not pm.venv_is_current(project_root=root): raise RuntimeError("fixture dependencies are not ready after rebasing the copied selection")\nif (state/"source-completion-pending").exists(): raise RuntimeError("fixture has a pending source-completion tail")\n\nprint(json.dumps({"state":str(state),"environment":str(env),"runtime":str(store_root(root)),"home":str(get_default_hermes_root()),"pm_python":str(manager)}))`,
    fixtureRoot
  ];
  assertFixtureOwnedExecution(fixturePython, readyArgs, fixtureRoot, fixtureEnvironment);
  const ready = JSON.parse(execFileSync(fixturePython, readyArgs, { env: fixtureEnvironment, encoding: "utf8" })) as {
    state: string;
    environment: string;
    runtime: string;
    home: string;
    pm_python: string;
  };
  if (
    ready.state !== copied.state ||
    ready.environment !== copied.environment ||
    ready.runtime !== fixtureRuntime ||
    ready.home !== fixtureHome ||
    !ready.pm_python.startsWith(join(copied.state, "pm-runtime") + sep)
  ) {
    throw new Error("Hermes fixture resolved mutable state outside its prepared paths");
  }
  if (!existsSync(join(fixtureRoot, ".git")))
    throw new Error("Hermes fixture source Git metadata is required for isolated source completion");
  if (!existsSync(acpLauncher)) throw new Error("Fixture Hermes ACP launcher was not published");
  const criticalPaths = [
    fixtureRoot,
    launcherDirectory,
    launcher,
    acpLauncher,
    fixturePython,
    fixtureRuntime,
    copied.environment,
    copied.state,
    join(fixtureRuntime, "facts.json"),
    join(copied.state, "facts.json"),
    join(copied.state, "pm-runtime", "selected.json"),
    join(copied.state, "source-completion-pending"),
    join(copied.state, "source-completion-attempts"),
    join(fixtureRoot, "install-stamp.json"),
    join(fixtureRoot, ".hermes-bootstrap-complete"),
    fixtureEnvironment.HOME,
    fixtureHome,
    join(fixtureHome, "config.yaml"),
    join(copied.state, "bootstrap"),
    fixtureEnvironment.XDG_CONFIG_HOME,
    fixtureEnvironment.XDG_CACHE_HOME,
    fixtureEnvironment.XDG_DATA_HOME,
    fixtureEnvironment.UV_CACHE_DIR,
    fixtureEnvironment.TMPDIR
  ];
  for (const path of criticalPaths) assertHermesPathContained(directory, path);
  for (const root of [fixtureRoot, fixtureRuntime, fixtureHome]) {
    for (const path of walkFiles(root)) {
      if (!lstatSync(path).isSymbolicLink()) continue;
      try {
        const resolvedTarget = realpathSync(path);
        if (!resolvedTarget.startsWith(`${realpathSync(directory)}${sep}`)) {
          throw new Error(`Hermes fixture symlink escapes fixture root: ${path} -> ${resolvedTarget}`);
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("escapes fixture root")) throw error;
        throw new Error(`Hermes fixture contains an unresolved symlink: ${path}`, { cause: error });
      }
    }
  }
  for (const name of ["hermes", "hermes-acp"] as const) {
    const text = readFileSync(join(launcherDirectory, name), "utf8");
    if (!text.includes(fixturePython) || !text.includes(fixtureRoot))
      throw new Error(`Fixture ${name} launcher is not bound to fixture Python/source`);
    if (text.includes(PERSISTENT_HERMES_ROOT) || /\/tmp\/acs-gateway-hermes-e2e-[^\s'"\\]*/.test(text)) {
      throw new Error(`Fixture ${name} launcher retains an old persistent or temporary Hermes path`);
    }
  }
  for (const path of [
    join(fixtureRoot, "install-stamp.json"),
    join(copied.state, "facts.json"),
    join(copied.state, "pm-runtime", "selected.json"),
    join(fixtureRuntime, "facts.json"),
    join(copied.environment, "pyvenv.cfg")
  ]) {
    if (readFileSync(path, "utf8").includes(PERSISTENT_HERMES_ROOT))
      throw new Error(`Fixture runtime metadata retains a persistent Hermes path: ${path}`);
  }

  const persistentRoots = [
    installation.hermesHome,
    installation.sourceRoot,
    installation.runtimeRoot,
    installation.installState,
    join(installation.hermesHome, "bin"),
    join(homedir(), ".local", "bin", "hermes"),
    join(homedir(), ".local", "bin", "hermes-acp")
  ];
  return {
    ...installation,
    fixtureRoot,
    fixtureHome,
    fixtureRuntime,
    fixtureState: copied.state,
    fixtureEnvironment: copied.environment,
    fixturePython,
    fixtureLauncher: launcher,
    fixtureAcPLauncher: acpLauncher,
    persistentRoots,
    defaultPluginConfig: pluginHomes.find((home) => home.relativeHome === ".") ?? { enabled: [], disabled: [] }
  };
}

export interface HermesManifestEntry {
  path: string;
  type: string;
  mode: number;
  size: number;
  device?: string;
  inode?: string;
  mtimeNs?: string;
  ctimeNs?: string;
  sha256?: string;
  target?: string;
}

export interface HermesFingerprintOptions {
  /** Hash smaller files while retaining filesystem identity and timestamps for larger state files. */
  hashFilesAtMostBytes?: number;
}

async function hashFile(path: string): Promise<string> {
  const { createReadStream } = await import("node:fs");
  const hash = createHash("sha256");
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolvePromise);
  });
  return hash.digest("hex");
}

export async function fingerprintHermesState(
  roots: string[],
  options: HermesFingerprintOptions = {}
): Promise<HermesManifestEntry[]> {
  const entries: HermesManifestEntry[] = [];
  const seen = new Set<string>();
  const uniqueRoots = roots
    .map((path) => resolve(path))
    .sort((a, b) => a.length - b.length)
    .filter((path, index, all) => !all.slice(0, index).some((parent) => path.startsWith(`${parent}${sep}`)));
  for (const root of uniqueRoots) {
    if (!existsSync(root)) continue;
    const canonical = realpathSync(root);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    const rootInfo = lstatSync(root, { bigint: true });
    const paths = rootInfo.isDirectory() ? [root, ...walkEntries(root)] : [root];
    for (const path of paths) {
      const info = lstatSync(path, { bigint: true });
      const entry: HermesManifestEntry = {
        path: `${root}${path === root ? "" : `/${relative(root, path)}`}`,
        type: info.isSymbolicLink() ? "symlink" : info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
        mode: Number(info.mode & 0o7777n),
        size: Number(info.size),
        device: info.dev.toString(),
        inode: info.ino.toString(),
        mtimeNs: info.mtimeNs.toString(),
        ctimeNs: info.ctimeNs.toString()
      };
      if (info.isSymbolicLink()) entry.target = readlinkSync(path);
      else if (
        info.isFile() &&
        (options.hashFilesAtMostBytes === undefined || Number(info.size) <= options.hashFilesAtMostBytes)
      ) {
        entry.sha256 = await hashFile(path);
      }
      entries.push(entry);
    }
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

export function measureHermesFixtureBytes(root: string): number {
  return walkFiles(root).reduce((total, path) => {
    const info = lstatSync(path);
    return total + (info.isFile() ? info.size : 0);
  }, 0);
}

function walkEntries(root: string): string[] {
  const result: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      result.push(path);
      if (entry.isDirectory()) pending.push(path);
    }
  }
  return result;
}
