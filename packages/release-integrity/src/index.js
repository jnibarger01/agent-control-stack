/**
 * Release integrity: symlink policy
 *
 * Release roots, a release's own `node_modules` directory, and the pinned Node
 * binary must all be real filesystem objects that resolve to themselves. A symlink
 * at any of those positions is rejected rather than canonicalized, because the
 * release fingerprint is computed over paths relative to the release root: if the
 * root itself could be redirected, every path in the manifest could be made to
 * point outside the published directory while still appearing correct.
 *
 * This is intentionally stricter than resolving symlinks and comparing canonical
 * paths. Normalizing would let a packaged deployment bind to an arbitrary
 * developer checkout, so the contract is instead documented and enforced:
 *
 *   - the release root must not be a symlink, and no ancestor of it may be one;
 *   - `node_modules` must be a real directory, though individual package entries
 *     inside it may be workspace links;
 *   - the pinned Node executable must be a real file, not a link.
 *
 * Operators using symlinked deployment roots must copy or bind-mount the release
 * into place instead of linking to it.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const RELEASE_FILE = 'RELEASE.json';
const MANIFEST_FILE = 'RELEASE-MANIFEST.json';
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonicalDigest = (value) => sha256(JSON.stringify(value));
const byPath = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;

function assertDirectory(directory, { allowStaging = false } = {}) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('ACS_DC_RELEASE_DIR must be an absolute directory');
  const parent = path.basename(path.dirname(directory));
  if (!['acs', 'dc', 'dc-mcp-gateway'].includes(parent) && !(allowStaging && parent === '_staging')) {
    throw new Error('release directory is not under a published component directory');
  }
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink()) throw new Error('ACS_DC_RELEASE_DIR must not be a symlink');
  if (!stat.isDirectory()) throw new Error('ACS_DC_RELEASE_DIR must be a real directory');
  assertResolvesToItself(directory, 'ACS_DC_RELEASE_DIR');
}

/**
 * Reject paths that resolve to a different location, which happens when the path
 * or one of its ancestors is a symlink. Callers check `isSymbolicLink()` first so
 * the error distinguishes a direct link from a linked ancestor.
 */
function assertResolvesToItself(target, label) {
  if (fs.realpathSync(target) !== target) {
    throw new Error(`${label} must not resolve through a symlink; copy or bind-mount the release instead`);
  }
}

function assertComponentDirectory(directory, component, commit, options = {}) {
  if (!['acs', 'dc', 'gateway'].includes(component)) throw new Error('unknown release component');
  const parent = path.basename(path.dirname(directory));
  const expectedParent = component === 'gateway' ? 'dc-mcp-gateway' : component;
  if (parent !== expectedParent && !(options.allowStaging && parent === '_staging')) throw new Error('release component directory mismatch');
  if (component === 'acs' && !options.allowStaging && !path.basename(directory).startsWith(commit.slice(0, 7))) throw new Error('ACS release commit directory mismatch');
}

function entriesUnder(root, relative = '', exclude = () => false, allowedRoot = root) {
  const entries = [];
  for (const name of fs.readdirSync(path.join(root, relative)).sort()) {
    const file = relative ? `${relative}/${name}` : name;
    if (exclude(file)) continue;
    const absolute = path.join(root, file);
    const stat = fs.lstatSync(absolute);
    if (stat.isDirectory()) {
      entries.push(...entriesUnder(root, file, exclude, allowedRoot));
    } else if (stat.isFile()) {
      entries.push({ path: file, sha256: sha256(fs.readFileSync(absolute)) });
    } else if (stat.isSymbolicLink()) {
      const target = fs.readlinkSync(absolute);
      const resolved = path.resolve(path.dirname(absolute), target);
      if (resolved !== allowedRoot && !resolved.startsWith(`${allowedRoot}${path.sep}`)) throw new Error(`release symlink escapes root: ${file}`);
      entries.push({ path: file, link: target });
    } else {
      throw new Error(`unsupported release file type: ${file}`);
    }
  }
  return entries;
}

function releaseFiles(directory, component) {
  if (fs.existsSync(path.join(directory, '.claude/settings.local.json'))) {
    throw new Error('machine-local settings must not be present in a release');
  }
  return entriesUnder(directory, '', (file) =>
    file === RELEASE_FILE || file === MANIFEST_FILE ||
    file === 'node_modules' || (component !== 'acs' && (file === 'logs' ||
    file.endsWith('.log') || file.startsWith('logs/')))
  ).sort(component === 'acs' ? (a, b) => a.path.localeCompare(b.path, 'en') : byPath);
}

function dependencyFiles(directory, component) {
  const root = path.join(directory, 'node_modules');
  if (!fs.lstatSync(root).isDirectory()) throw new Error('release node_modules missing or linked');
  assertResolvesToItself(root, 'release node_modules');
  return entriesUnder(root, '', () => false, component === 'acs' ? directory : root)
    .sort(component === 'acs' ? (a, b) => a.path.localeCompare(b.path, 'en') : byPath);
}

function runtimeFiles(entries, component) {
  if (component === 'acs') {
    const files = entries.filter(({ path: file }) =>
      file === 'package.json' || file === 'package-lock.json' ||
      /^apps\/[^/]+\/dist\//.test(file) || /^packages\/[^/]+\/dist\//.test(file)
    );
    if (!files.some((file) => file.path === 'apps/gateway/dist/cli.js') ||
        !files.some((file) => file.path === 'package-lock.json') ||
        files.some((file) => file.link !== undefined)) throw new Error('ACS runtime inputs missing or linked');
    return files;
  }
  if (component === 'gateway') {
    const files = entries.filter(({ path: file }) =>
      (!file.includes('/') && file.endsWith('.js')) || file === 'package.json' || file === 'package-lock.json'
    );
    if (!files.some((file) => file.path === 'server.js') ||
        !files.some((file) => file.path === 'bridge.js') ||
        !files.some((file) => file.path === 'release-integrity.js') ||
        files.some((file) => file.link !== undefined)) {
      throw new Error('gateway runtime inputs missing or linked');
    }
    return files;
  }
  if (component !== 'dc') throw new Error('unknown release component');
  const files = entries.filter(({ path: file }) =>
    file.startsWith('dist/') || file === 'package.json' || file === 'package-lock.json'
  );
  if (!files.some((file) => file.path === 'dist/index.js') ||
      !files.some((file) => file.path === 'package.json') ||
      !files.some((file) => file.path === 'package-lock.json') ||
      files.some((file) => file.link !== undefined)) {
    throw new Error('release runtime inputs missing or linked');
  }
  return files;
}

export function runtimeIdentityDigest(directory, nodeVersion, component = 'dc', options = {}) {
  assertDirectory(directory, options);
  if (typeof nodeVersion !== 'string' || !/^v\d+\.\d+\.\d+$/.test(nodeVersion)) throw new Error('pinned Node version invalid');
  return canonicalDigest({ nodeVersion, files: runtimeFiles(releaseFiles(directory, component), component) });
}

function nodeIdentity(directory, nodePath, recordedVersion, expectedHash) {
  if (typeof nodePath !== 'string' || typeof recordedVersion !== 'string' ||
      !/^v\d+\.\d+\.\d+$/.test(recordedVersion)) throw new Error('pinned Node metadata invalid');
  const expected = path.join(path.dirname(path.dirname(directory)), '_node', recordedVersion, 'bin/node');
  if (nodePath !== expected) throw new Error('pinned Node path does not belong to release root');
  const stat = fs.lstatSync(nodePath);
  if (stat.isSymbolicLink()) throw new Error('pinned Node must not be a symlink');
  if (!stat.isFile()) throw new Error('pinned Node must be a real file');
  assertResolvesToItself(nodePath, 'pinned Node');
  const digest = sha256(fs.readFileSync(nodePath));
  // Verify recorded executable bytes before launching even --version. A changed
  // binary must not gain execution merely by being named in release metadata.
  if (expectedHash !== undefined && digest !== expectedHash) throw new Error('pinned Node identity mismatch');
  let version;
  try {
    version = execFileSync(nodePath, ['--version'], { encoding: 'utf8', timeout: 5000 }).trim();
  } catch {
    throw new Error('pinned Node failed version check');
  }
  if (version !== recordedVersion) throw new Error('pinned Node version mismatch');
  return { path: nodePath, version, sha256: digest };
}

function readIntegrityJson(directory, file) {
  const absolute = path.join(directory, file);
  try {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid file type');
    return JSON.parse(fs.readFileSync(absolute, 'utf8'));
  } catch {
    throw new Error(`${file} missing or invalid`);
  }
}

export function createReleaseMetadata(directory, { commit, nodePath, component = 'dc' }) {
  assertDirectory(directory, { allowStaging: true });
  if (typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('release commit invalid');
  assertComponentDirectory(directory, component, commit, { allowStaging: true });
  // Metadata creation seals a new artifact. Never bless changed bytes by
  // replacing an existing seal, including a partial or linked metadata pair.
  for (const file of [MANIFEST_FILE, RELEASE_FILE]) {
    try {
      fs.lstatSync(path.join(directory, file));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    throw new Error('release metadata already exists');
  }
  if (typeof nodePath !== 'string') throw new Error('pinned Node path missing');
  const nodeVersion = path.basename(path.dirname(path.dirname(nodePath)));
  const node = nodeIdentity(directory, nodePath, nodeVersion);
  const files = releaseFiles(directory, component);
  const manifest = { schemaVersion: 1, files };
  const release = {
    schemaVersion: 1,
    component,
    commit,
    node,
    runtimeIdentityDigest: runtimeIdentityDigest(directory, node.version, component, { allowStaging: true }),
    fullManifestDigest: canonicalDigest(manifest),
    dependencyDigest: canonicalDigest(dependencyFiles(directory, component)),
  };
  // Exclusive creation also fences another creator racing the preflight.
  // A partial pair fails verification and must be inspected by the operator.
  fs.writeFileSync(path.join(directory, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
  fs.writeFileSync(path.join(directory, RELEASE_FILE), `${JSON.stringify(release, null, 2)}\n`, { flag: 'wx' });
  return release;
}

export function verifyRelease(directory, options = {}) {
  assertDirectory(directory, options);
  const release = readIntegrityJson(directory, RELEASE_FILE);
  const manifest = readIntegrityJson(directory, MANIFEST_FILE);
  if (!release || typeof release !== 'object' || Array.isArray(release) ||
      !manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      release.schemaVersion !== 1 || manifest.schemaVersion !== 1 ||
      typeof release.commit !== 'string' || !/^[a-f0-9]{40}$/.test(release.commit)) throw new Error('release metadata invalid');
  const component = release.component ?? 'dc';
  assertComponentDirectory(directory, component, release.commit, options);
  if (typeof release.node?.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(release.node.sha256)) throw new Error('pinned Node hash invalid');
  const node = nodeIdentity(directory, release.node?.path, release.node?.version, release.node?.sha256);
  if (JSON.stringify(node) !== JSON.stringify(release.node)) throw new Error('pinned Node identity mismatch');
  const files = releaseFiles(directory, component);
  if (JSON.stringify(manifest) !== JSON.stringify({ schemaVersion: 1, files }) ||
      release.fullManifestDigest !== canonicalDigest(manifest)) throw new Error('full release manifest mismatch');
  if (release.runtimeIdentityDigest !== runtimeIdentityDigest(directory, node.version, component, options)) {
    throw new Error('runtime identity mismatch');
  }
  if (release.dependencyDigest !== canonicalDigest(dependencyFiles(directory, component))) throw new Error('release dependencies mismatch');
  return { directory, ...release };
}
