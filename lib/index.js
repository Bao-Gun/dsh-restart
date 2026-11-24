// src/index.ts
import { homedir as homedir2, tmpdir } from "os";
import { join as join6 } from "path";

// src/server/last.ts
import { createHash, randomUUID } from "crypto";
import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { join } from "path";
var LAST_FILE = "last.json";
var LOCK_FILE = "pnpm-lock.yaml";
var FINGERPRINT_LENGTH = 16;
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isOptionalString(value) {
  return value === void 0 || typeof value === "string";
}
function isFailure(value) {
  if (!isPlainObject(value)) return false;
  const { plugin, kind, message, expected, actual } = value;
  return isOptionalString(plugin) && (kind === "config" || kind === "compat" || kind === "boot") && typeof message === "string" && isOptionalString(expected) && isOptionalString(actual);
}
function isPrecheck(value) {
  if (!isPlainObject(value)) return false;
  return typeof value.at === "string" && typeof value.ok === "boolean" && typeof value.fingerprint === "string" && Array.isArray(value.failures) && value.failures.every(isFailure) && typeof value.durationMs === "number" && Number.isFinite(value.durationMs);
}
function isRestart(value) {
  if (!isPlainObject(value)) return false;
  return typeof value.at === "string" && typeof value.port === "number" && Number.isFinite(value.port);
}
function validateRecord(value) {
  if (!isPlainObject(value)) return null;
  const record = {};
  if ("fingerprint" in value) {
    if (typeof value.fingerprint !== "string") return null;
    record.fingerprint = value.fingerprint;
  }
  if ("baseline" in value) {
    const baseline = value.baseline;
    if (!Array.isArray(baseline) || baseline.some((item) => typeof item !== "string")) return null;
    record.baseline = baseline;
  }
  if ("precheck" in value) {
    if (!isPrecheck(value.precheck)) return null;
    record.precheck = value.precheck;
  }
  if ("restart" in value) {
    if (!isRestart(value.restart)) return null;
    record.restart = value.restart;
  }
  return record;
}
async function computeFingerprint(profileDir, dshVersion) {
  const version = dshVersion?.trim();
  if (!version) return null;
  let lock;
  try {
    lock = await readFile(join(profileDir, LOCK_FILE), "utf8");
  } catch {
    return null;
  }
  return createHash("sha256").update(lock).update("\0").update(version).digest("hex").slice(0, FINGERPRINT_LENGTH);
}
async function readLast(dir) {
  try {
    const raw = await readFile(join(dir, LAST_FILE), "utf8");
    const parsed = JSON.parse(raw);
    return validateRecord(parsed) ?? {};
  } catch {
    return {};
  }
}
var writeChain = Promise.resolve();
function serializeWrite(task) {
  const run = writeChain.then(task);
  writeChain = run.then(
    () => void 0,
    () => void 0
  );
  return run;
}
function writeLast(dir, patch) {
  return serializeWrite(() => writeLastNow(dir, patch));
}
async function writeLastNow(dir, patch) {
  const merged = await readLast(dir);
  if (patch.fingerprint !== void 0) merged.fingerprint = patch.fingerprint;
  if (patch.baseline !== void 0) merged.baseline = patch.baseline;
  if (patch.precheck !== void 0) {
    merged.precheck = patch.precheck;
    if (patch.fingerprint === void 0) merged.fingerprint = patch.precheck.fingerprint;
  }
  if (patch.restart !== void 0) merged.restart = patch.restart;
  await mkdir(dir, { recursive: true });
  const file = join(dir, LAST_FILE);
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(merged, null, 2)}
`, "utf8");
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true }).catch(() => void 0);
    throw err;
  }
}
function isStale(record, fingerprint) {
  if (!fingerprint) return true;
  return record.fingerprint !== fingerprint;
}

// src/server/compat.ts
import { existsSync, readFileSync, realpathSync } from "fs";
import { readFile as readFile2 } from "fs/promises";
import { createRequire } from "module";
import { dirname, join as join2 } from "path";

// src/shared/version.ts
var SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
function parseRuntime(version) {
  const withoutV = version.trim().replace(/^v/, "");
  const withoutBuild = withoutV.split("+")[0] ?? "";
  const match = SEMVER.exec(withoutBuild);
  if (match === null) {
    throw new Error(
      `Invalid dsh runtime version: ${JSON.stringify(version)}; expected a semantic version`
    );
  }
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    patch: Number.parseInt(match[3], 10),
    pre: match[4] ?? null
  };
}

// src/server/compat.ts
var DSH_PACKAGE = "@deepseek-ai/dsh";
var BOOT_PACKAGE = "@deepseek-ai/dsh-app-boot";
var BOOT_ENTRY = join2("node_modules", "@deepseek-ai", "dsh-app-boot");
var OFFICIAL_SCOPE = "@deepseek-ai/";
var EXTRA_INSTALL_DIRS = [
  "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh",
  "/usr/local/lib/node_modules/@deepseek-ai/dsh"
];
var HOST_HINT = "\u53EF\u8BBE DSH_RESTART_DSH_DIR \u6307\u5411 dsh \u5B89\u88C5\u6839\uFF0C\u6216 DSH_RESTART_BOOT_DIR \u6307\u5411 @deepseek-ai/dsh-app-boot \u76EE\u5F55\u540E\u91CD\u8BD5";
function isPlainObject2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function readJsonFile(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const code = isPlainObject2(error) && typeof error.code === "string" ? error.code : "";
    return {
      ok: false,
      missing: code === "ENOENT",
      message: error instanceof Error ? error.message : String(error)
    };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, missing: false, message: error instanceof Error ? error.message : String(error) };
  }
}
function describeValue(value) {
  let text;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}
function realpathOf(file) {
  try {
    return realpathSync(file);
  } catch {
    return file;
  }
}
function ancestorsOf(file) {
  const dirs = [];
  let dir = dirname(realpathOf(file));
  for (let depth = 0; depth < 12; depth += 1) {
    dirs.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}
function isDshInstall(dir) {
  const manifest = readJsonFile(join2(dir, "package.json"));
  return manifest.ok && isPlainObject2(manifest.value) && manifest.value.name === DSH_PACKAGE;
}
function discoveredCandidates() {
  const installDirs = [
    ...ancestorsOf(process.argv[1] ?? ""),
    join2(dirname(process.execPath), "..", "lib", "node_modules", DSH_PACKAGE),
    ...EXTRA_INSTALL_DIRS
  ];
  const dirs = [];
  for (const dir of installDirs) {
    if (dir === "" || !isDshInstall(dir)) continue;
    const boot = join2(dir, BOOT_ENTRY);
    if (!dirs.includes(boot)) dirs.push(boot);
  }
  return dirs;
}
function overrideCandidates() {
  const boot = process.env.DSH_RESTART_BOOT_DIR;
  const install = process.env.DSH_RESTART_DSH_DIR;
  const hasBoot = boot !== void 0 && boot !== "";
  const hasInstall = install !== void 0 && install !== "";
  if (!hasBoot && !hasInstall) return null;
  const dirs = [];
  if (hasBoot) dirs.push(boot);
  if (hasInstall) dirs.push(join2(install, BOOT_ENTRY));
  return dirs;
}
var hostModule = null;
var hostProblem = "";
var hostTried = [];
function hostCompatibility() {
  if (hostModule !== null) return hostModule;
  const candidates = overrideCandidates() ?? discoveredCandidates();
  hostTried = candidates;
  hostProblem = "\u6CA1\u6709\u627E\u5230 dsh \u5B89\u88C5\u76EE\u5F55";
  for (const dir of candidates) {
    const manifest = readJsonFile(join2(dir, "package.json"));
    if (!manifest.ok || !isPlainObject2(manifest.value)) {
      hostProblem = `${dir} \u91CC\u6CA1\u6709\u53EF\u8BFB\u7684 package.json`;
      continue;
    }
    const main = typeof manifest.value.main === "string" && manifest.value.main !== "" ? manifest.value.main : "lib/index.js";
    try {
      const loaded = createRequire(join2(dir, "package.json"))(join2(dir, main));
      if (typeof loaded.evaluatePluginCompatibility !== "function" || typeof loaded.getDshRuntimeVersion !== "function") {
        hostProblem = `${BOOT_PACKAGE} \u6CA1\u6709\u5BFC\u51FA\u5224\u5B9A\u51FD\u6570\uFF08${dir}\uFF09`;
        continue;
      }
      hostModule = loaded;
      return hostModule;
    } catch (error) {
      hostProblem = error instanceof Error ? error.message : String(error);
    }
  }
  return null;
}
function hostRuntimeVersion() {
  try {
    return hostCompatibility()?.getDshRuntimeVersion() ?? "";
  } catch {
    return "";
  }
}
function expectedOf(requirements) {
  return Object.entries(requirements).map(([field, range]) => field === "engines.dsh" ? range : `${field} ${range}`).join(", ");
}
function manifestProblemFailures(plugin) {
  const name2 = plugin.name !== "" ? plugin.name : plugin.id;
  return (plugin.manifestProblems ?? []).map((problem) => ({
    plugin: name2,
    kind: "compat",
    message: `\u63D2\u4EF6 ${name2} \u7684\u6E05\u5355\u5B57\u6BB5 ${problem.field} \u5F62\u72B6\u4E0D\u5BF9\uFF08\u671F\u671B ${problem.expected}\uFF0C\u5B9E\u9645 ${problem.actual}\uFF09\uFF1A\u5BBF\u4E3B\u52A0\u8F7D\u65F6\u4F1A\u629B\u9519\u5E76\u505C\u7528\u5B83\uFF0C\u4E0D\u80FD\u5224\u4E3A\u517C\u5BB9`,
    expected: `${problem.field} \u4E3A ${problem.expected}`,
    actual: problem.actual
  }));
}
function judgeOne(host, plugin, runtimeVersion) {
  const manifest = { name: plugin.name, version: plugin.version };
  if (plugin.enginesDsh !== void 0) manifest.engines = { dsh: plugin.enginesDsh };
  if (plugin.peerDependencies !== void 0) {
    manifest.peerDependencies = plugin.peerDependencies;
  } else if (plugin.peerDsh !== void 0) {
    manifest.peerDependencies = { [DSH_PACKAGE]: plugin.peerDsh };
  }
  try {
    const issue = host.evaluatePluginCompatibility(manifest, {}, runtimeVersion);
    if (issue === void 0 || issue.exempted) return null;
    const expected = expectedOf(issue.requirements);
    const name2 = issue.name !== "" ? issue.name : plugin.name !== "" ? plugin.name : plugin.id;
    return {
      plugin: name2,
      kind: "compat",
      message: `\u63D2\u4EF6 ${name2}@${issue.version || plugin.version} \u4E0E dsh ${runtimeVersion} \u4E0D\u517C\u5BB9\uFF1A\u8981\u6C42 ${expected}`,
      expected,
      actual: runtimeVersion
    };
  } catch (error) {
    return {
      plugin: plugin.name !== "" ? plugin.name : plugin.id,
      kind: "compat",
      message: `\u63D2\u4EF6 ${plugin.name || plugin.id} \u7684\u6E05\u5355\u65E0\u6CD5\u5224\u5B9A\uFF1A${error instanceof Error ? error.message : String(error)}`,
      actual: runtimeVersion
    };
  }
}
function compatFailures(plugins, runtimeVersion) {
  try {
    parseRuntime(runtimeVersion);
  } catch (error) {
    return [
      {
        kind: "compat",
        message: `\u53D6\u4E0D\u5230\u5408\u6CD5\u7684 dsh \u8FD0\u884C\u65F6\u7248\u672C\uFF08${JSON.stringify(runtimeVersion)}\uFF09\uFF1A${error instanceof Error ? error.message : String(error)}\uFF1B\u65E0\u6CD5\u5224\u5B9A\u63D2\u4EF6\u517C\u5BB9\u6027\uFF0C\u4E0D\u80FD\u9ED8\u8BA4\u653E\u884C`,
        expected: "\u5408\u6CD5\u8BED\u4E49\u5316\u7248\u672C",
        actual: runtimeVersion
      }
    ];
  }
  const host = hostCompatibility();
  if (host === null) {
    const tried = hostTried.length === 0 ? "\uFF08\u65E0\u5019\u9009\u76EE\u5F55\uFF09" : hostTried.join("\u3001");
    return [
      {
        kind: "compat",
        message: `\u52A0\u8F7D\u4E0D\u5230\u5BBF\u4E3B\u7684\u517C\u5BB9\u6027\u5224\u5B9A\uFF08${hostProblem}\uFF1B\u5C1D\u8BD5\u8FC7\uFF1A${tried}\uFF09\u3002${HOST_HINT}`,
        actual: runtimeVersion
      }
    ];
  }
  const failures = [];
  for (const plugin of plugins) {
    if (plugin.manifestProblems !== void 0 && plugin.manifestProblems.length > 0) {
      failures.push(...manifestProblemFailures(plugin));
      continue;
    }
    const failure = judgeOne(host, plugin, runtimeVersion);
    if (failure !== null) failures.push(failure);
  }
  return failures;
}
var DSH_PEER_PREFIX = `${DSH_PACKAGE}-`;
var PATCH_ID = /^\s*-\s+id:\s*(\S+)\s*$/;
var PATCH_NAME = /^\s+(?:-\s+)?name:\s*(.+?)\s*$/;
var PACKAGE_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;
function stripComment(line) {
  const index = line.search(/\s#/);
  return index === -1 ? line : line.slice(0, index);
}
function unquote(value) {
  const trimmed = value.trim();
  const head = trimmed[0];
  if ((head === '"' || head === "'") && trimmed.endsWith(head)) return trimmed.slice(1, -1);
  return trimmed;
}
async function patchEntries(profileDir) {
  let raw;
  try {
    raw = await readFile2(join2(profileDir, "cordis.patch.yml"), "utf8");
  } catch {
    return [];
  }
  const entries = [];
  let id = null;
  for (const line of raw.split(/\r?\n/)) {
    const bare = stripComment(line);
    const idMatch = PATCH_ID.exec(bare);
    if (idMatch !== null) {
      id = idMatch[1] ?? null;
      continue;
    }
    const nameMatch = PATCH_NAME.exec(bare);
    if (nameMatch === null || id === null) continue;
    const name2 = unquote(nameMatch[1] ?? "");
    if (PACKAGE_NAME.test(name2)) entries.push({ id, name: name2 });
    id = null;
  }
  return entries;
}
function manifestPathFor(profileDir, name2) {
  try {
    const resolved = createRequire(join2(profileDir, "package.json")).resolve(`${name2}/package.json`);
    if (existsSync(resolved)) return resolved;
  } catch {
  }
  const direct = join2(profileDir, "node_modules", name2, "package.json");
  return existsSync(direct) ? direct : null;
}
function requirementsOf(manifest) {
  const problems = [];
  let enginesDsh;
  if (manifest.engines !== void 0) {
    if (!isPlainObject2(manifest.engines)) {
      problems.push({ field: "engines", expected: "\u5BF9\u8C61", actual: describeValue(manifest.engines) });
    } else if (manifest.engines.dsh !== void 0) {
      const range = manifest.engines.dsh;
      if (typeof range === "string") enginesDsh = range;
      else {
        problems.push({
          field: "engines.dsh",
          expected: "\u7248\u672C\u8303\u56F4\u5B57\u7B26\u4E32",
          actual: describeValue(range)
        });
      }
    }
  }
  const peerDependencies = {};
  if (manifest.peerDependencies !== void 0) {
    if (!isPlainObject2(manifest.peerDependencies)) {
      problems.push({
        field: "peerDependencies",
        expected: "\u5BF9\u8C61",
        actual: describeValue(manifest.peerDependencies)
      });
    } else {
      for (const [peer, range] of Object.entries(manifest.peerDependencies)) {
        if (typeof range !== "string") {
          problems.push({
            field: `peerDependencies[${JSON.stringify(peer)}]`,
            expected: "\u7248\u672C\u8303\u56F4\u5B57\u7B26\u4E32",
            actual: describeValue(range)
          });
          continue;
        }
        if (peer === DSH_PACKAGE || peer.startsWith(DSH_PEER_PREFIX)) peerDependencies[peer] = range;
      }
    }
  }
  return {
    ...enginesDsh === void 0 ? {} : { enginesDsh },
    ...Object.keys(peerDependencies).length === 0 ? {} : { peerDependencies },
    problems
  };
}
function readPlugin(profileDir, name2, id, warn, warnMissing) {
  const file = manifestPathFor(profileDir, name2);
  if (file === null) {
    if (warnMissing) warn(name2, `\u627E\u4E0D\u5230 ${name2} \u7684 package.json\uFF08\u88C5\u4E86\u4F46\u6CA1\u88C5\u597D\uFF09\uFF0C\u8DF3\u8FC7`);
    return null;
  }
  const manifest = readJsonFile(file);
  if (!manifest.ok) {
    warn(name2, `\u8BFB\u4E0D\u4E86 ${name2} \u7684 package.json\uFF08${manifest.message}\uFF09\uFF0C\u8DF3\u8FC7`);
    return null;
  }
  if (!isPlainObject2(manifest.value)) {
    warn(name2, `${name2} \u7684 package.json \u4E0D\u662F\u4E00\u4E2A\u5BF9\u8C61\uFF0C\u8DF3\u8FC7`);
    return null;
  }
  const requirements = requirementsOf(manifest.value);
  const peerDependencies = requirements.peerDependencies;
  return {
    id,
    name: typeof manifest.value.name === "string" && manifest.value.name !== "" ? manifest.value.name : name2,
    version: typeof manifest.value.version === "string" ? manifest.value.version : "",
    ...requirements.enginesDsh === void 0 ? {} : { enginesDsh: requirements.enginesDsh },
    ...peerDependencies?.[DSH_PACKAGE] === void 0 ? {} : { peerDsh: peerDependencies[DSH_PACKAGE] },
    ...peerDependencies === void 0 ? {} : { peerDependencies },
    ...requirements.problems.length === 0 ? {} : { manifestProblems: requirements.problems }
  };
}
async function readInstalled(profileDir, options = {}) {
  const warn = (plugin, message) => {
    options.onWarning?.({ plugin, kind: "compat", message });
  };
  const profile = readJsonFile(join2(profileDir, "package.json"));
  if (!profile.ok) {
    if (!profile.missing) {
      warn("profile", `\u8BFB\u4E0D\u4E86 profile \u7684 package.json\uFF08${profile.message}\uFF09\uFF0C\u65E0\u6CD5\u5224\u65AD\u88C5\u4E86\u54EA\u4E9B\u63D2\u4EF6`);
    }
    return [];
  }
  if (!isPlainObject2(profile.value)) {
    warn("profile", "profile \u7684 package.json \u4E0D\u662F\u4E00\u4E2A\u5BF9\u8C61\uFF0C\u65E0\u6CD5\u5224\u65AD\u88C5\u4E86\u54EA\u4E9B\u63D2\u4EF6");
    return [];
  }
  const plugins = [];
  const seen = /* @__PURE__ */ new Set();
  const dependencies = isPlainObject2(profile.value.dependencies) ? profile.value.dependencies : {};
  for (const name2 of Object.keys(dependencies).sort()) {
    const plugin = readPlugin(profileDir, name2, name2, warn, true);
    if (plugin === null) continue;
    plugins.push(plugin);
    seen.add(name2);
  }
  for (const entry of await patchEntries(profileDir)) {
    if (seen.has(entry.name)) continue;
    const plugin = readPlugin(profileDir, entry.name, entry.id, warn, false);
    if (plugin !== null) {
      plugins.push(plugin);
      seen.add(entry.name);
      continue;
    }
    if (!entry.name.startsWith(OFFICIAL_SCOPE)) {
      warn(
        entry.name,
        `patch \u6761\u76EE ${entry.id} \u6307\u5411 ${entry.name}\uFF0C\u4F46\u5B83\u7684 package.json \u627E\u4E0D\u5230\uFF08\u88C5\u4E86\u4F46\u6CA1\u88C5\u597D\uFF09\uFF0C\u8DF3\u8FC7`
      );
    }
  }
  return plugins;
}

// src/server/smoke.ts
import { execFile, spawn } from "child_process";
import { writeFileSync } from "fs";
import { mkdir as mkdir2, mkdtemp, readFile as readFile3, readdir, rm as rm2, stat, writeFile as writeFile2 } from "fs/promises";
import { basename, dirname as dirname2, join as join3, resolve } from "path";
import { setTimeout as delay } from "timers/promises";
import { promisify } from "util";

// src/server/clone.ts
function cloneCandidates(platform, source, dest) {
  if (platform === "darwin") {
    return [
      ["-c", "-R", source, dest],
      ["-R", source, dest]
    ];
  }
  if (platform === "linux") {
    return [
      ["--reflink=auto", "-R", source, dest],
      ["-R", source, dest]
    ];
  }
  return [["-R", source, dest]];
}

// src/server/smoke.ts
var execFileAsync = promisify(execFile);
var DEFAULT_SMOKE_TIMEOUT_MS = 12e3;
var DUMP_CONFIG_TIMEOUT_MS = 2e4;
var CLONE_TIMEOUT_MS = 6e4;
var COPY_TIMEOUT_MS = 12e4;
var HEALTH_POLL_INTERVAL_MS = 150;
var KILL_GRACE_MS = 2e3;
var KILL_KILL_GRACE_MS = 1e3;
var GROUP_POLL_INTERVAL_MS = 50;
var OUTPUT_QUIET_MS = 200;
var OUTPUT_SETTLE_CAP_MS = 1e3;
var EXIT_FLUSH_MS = 200;
var STDERR_LIMIT = 256 * 1024;
var STDOUT_LIMIT = 64 * 1024;
var MAX_BUFFER = 8 * 1024 * 1024;
var HEALTH_PROBE_TIMEOUT_MS = 1500;
var WEB_URL_LINE = /dsh web:\s+(https?:\/\/[^\s]+)/;
var ACTIVATION_MARKER = "did not activate";
var OPTIONAL_HEADER = /\b(?:entry|entries) did not activate/;
var DIAGNOSTIC_LINE = /^(\S+) \(([^()]*)\): /;
var STARTUP_FAILED_LINE = /^ {2}(\S+?)(?: \(required\))?$/;
var STARTUP_PACKAGE_LINE = /^ {4}Package: /;
var SMOKE_DIR_PREFIX = "dsh-smoke-";
var RUN_PID_FILE = "run.pid";
var DSH_IDENTITY_FILE = "dsh.json";
var STALE_DIR_MIN_AGE_MS = 3e4;
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function appendCapped(current, chunk, limit) {
  const next = current + chunk;
  return next.length > limit ? next.slice(0, limit) : next;
}
function tail(text, limit = 500) {
  const trimmed = text.trim();
  if (trimmed === "") return "";
  return trimmed.length > limit ? "\u2026" + trimmed.slice(-limit) : trimmed;
}
function describeCommand(outcome) {
  if (outcome.spawnError !== null) return "\u542F\u52A8\u5931\u8D25\uFF1A" + outcome.spawnError;
  if (outcome.timedOut) return "\u8D85\u65F6";
  const detail = tail(outcome.stderr);
  return "\u9000\u51FA\u7801 " + String(outcome.code) + (detail === "" ? "" : "\uFF1A" + detail);
}
function resolveDshBin() {
  return process.env.DSH_RESTART_DSH_BIN ?? "dsh";
}
async function runCommand(command, args, options) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      env: options.env ?? process.env,
      timeout: options.timeoutMs,
      maxBuffer: MAX_BUFFER,
      encoding: "utf8"
    });
    return { code: 0, stdout, stderr, timedOut: false, spawnError: null };
  } catch (error) {
    const failure = error;
    const spawnError = typeof failure.code === "string" ? failure.message ?? "spawn failed" : null;
    return {
      code: typeof failure.code === "number" ? failure.code : null,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      timedOut: failure.killed === true,
      spawnError
    };
  }
}
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function isDshCommand(command) {
  return /\bdsh\b/.test(command);
}
async function probeProcessIdentity(pid) {
  if (process.platform === "win32") return null;
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-p", String(pid), "-o", "lstart=", "-o", "command="],
      {
        timeout: 2e3,
        maxBuffer: 64 * 1024,
        encoding: "utf8",
        // 必须钉住 C 语言环境：zh_CN 下 macOS 的 ps 会把日期打成「一 11/23 22:40:14 2026」，
        // 与下面这条正则对不上，于是所有身份比对都退化成「无法确认」——清扫不再发信号，
        // 孤儿实例就这样活下来（2026-11-23 本机 LANG=zh_CN.UTF-8 实测）。
        env: { ...process.env, LC_ALL: "C", LANG: "C" }
      }
    );
    const line = stdout.trim();
    const match = /^(\S{3}\s+\S{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/.exec(line);
    if (match === null) return null;
    const lstart = match[1] ?? "";
    const command = (match[2] ?? "").trim();
    if (lstart === "" || command === "") return null;
    return { lstart, command };
  } catch {
    return null;
  }
}
async function recordDshIdentity(dir, pid) {
  const identity = await probeProcessIdentity(pid);
  if (identity === null || !isDshCommand(identity.command)) return;
  try {
    await writeFile2(
      join3(dir, DSH_IDENTITY_FILE),
      JSON.stringify({ pid, lstart: identity.lstart, command: identity.command }),
      "utf8"
    );
  } catch {
  }
}
async function readDshIdentity(dir) {
  try {
    const parsed = JSON.parse(await readFile3(join3(dir, DSH_IDENTITY_FILE), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed;
    const pid = record["pid"];
    const lstart = record["lstart"];
    const command = record["command"];
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
    if (typeof lstart !== "string" || lstart === "") return null;
    if (typeof command !== "string" || command === "") return null;
    return { pid, lstart, command };
  } catch {
    return null;
  }
}
function writeRunPidFile(dir) {
  writeFileSync(join3(dir, RUN_PID_FILE), String(process.pid), "utf8");
}
function groupAlive(pid) {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
async function waitForGroupGone(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!groupAlive(pid)) return true;
    await delay(GROUP_POLL_INTERVAL_MS);
  }
  return !groupAlive(pid);
}
async function terminateGroup(pid, graceMs, killGraceMs) {
  if (!groupAlive(pid)) return true;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    return !groupAlive(pid);
  }
  if (await waitForGroupGone(pid, graceMs)) return true;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
  }
  return waitForGroupGone(pid, killGraceMs);
}
function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit);
      resolveExit(false);
    }, timeoutMs);
    const onExit = () => {
      clearTimeout(timer);
      resolveExit(true);
    };
    child.once("exit", onExit);
  });
}
async function killProcessTree(child) {
  const pid = child.pid;
  if (pid === void 0) return true;
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    const exited = waitForExit(child, KILL_GRACE_MS);
    try {
      child.kill("SIGTERM");
    } catch {
    }
    if (await exited) return true;
    const killed = waitForExit(child, KILL_KILL_GRACE_MS);
    try {
      child.kill("SIGKILL");
    } catch {
    }
    return killed;
  }
  return terminateGroup(pid, KILL_GRACE_MS, KILL_KILL_GRACE_MS);
}
async function readPidFile(dir, name2) {
  try {
    const raw = await readFile3(join3(dir, name2), "utf8");
    const pid = Number.parseInt(raw.trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
async function cleanupStaleSmokeDirs(tmpRoot) {
  const removed = [];
  const failures = [];
  let entries;
  try {
    entries = await readdir(tmpRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return { removed, failures };
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(SMOKE_DIR_PREFIX)) continue;
    const dir = join3(tmpRoot, entry.name);
    let ageMs;
    try {
      ageMs = Date.now() - (await stat(dir)).mtimeMs;
    } catch {
      continue;
    }
    if (ageMs < STALE_DIR_MIN_AGE_MS) continue;
    const ownerPid = await readPidFile(dir, RUN_PID_FILE);
    if (ownerPid !== null && processAlive(ownerPid)) continue;
    const identity = await readDshIdentity(dir);
    if (identity !== null) {
      const current = await probeProcessIdentity(identity.pid);
      const confirmed = current !== null && current.lstart === identity.lstart && current.command === identity.command && isDshCommand(current.command);
      if (confirmed) {
        const cleaned = await terminateGroup(identity.pid, KILL_GRACE_MS, KILL_KILL_GRACE_MS);
        if (!cleaned) {
          failures.push({
            kind: "boot",
            message: "\u9648\u65E7\u5192\u70DF\u76EE\u5F55 " + dir + " \u7684\u8FDB\u7A0B\u7EC4 " + String(identity.pid) + " \u6740\u4E0D\u6389\uFF0C\u4FDD\u7559\u76EE\u5F55\u5F85\u4EBA\u5DE5\u5904\u7406"
          });
          continue;
        }
      }
    }
    try {
      await rm2(dir, { recursive: true, force: true });
      removed.push(entry.name);
    } catch (error) {
      failures.push({
        kind: "boot",
        message: "\u6E05\u7406\u9648\u65E7\u5192\u70DF\u76EE\u5F55 " + dir + " \u5931\u8D25\uFF1A" + messageOf(error)
      });
    }
  }
  return { removed, failures };
}
function parseNotActivated(stderr) {
  const lines = stderr.split(/\r?\n/);
  if (!lines.some((line) => line.includes(ACTIVATION_MARKER))) return [];
  const entries = [];
  const seen = /* @__PURE__ */ new Set();
  const push = (id) => {
    if (id === "" || seen.has(id)) return;
    seen.add(id);
    entries.push(id);
  };
  for (let index = 0; index < lines.length; index += 1) {
    if (!OPTIONAL_HEADER.test(lines[index] ?? "")) continue;
    let cursor = index + 1;
    while (cursor < lines.length) {
      const match = DIAGNOSTIC_LINE.exec(lines[cursor] ?? "");
      if (match === null) break;
      push(match[1] ?? "");
      cursor += 1;
    }
  }
  for (let index = 0; index < lines.length; index += 1) {
    const failed = STARTUP_FAILED_LINE.exec(lines[index] ?? "");
    if (failed !== null && STARTUP_PACKAGE_LINE.test(lines[index + 1] ?? "")) {
      push(failed[1] ?? "");
    }
  }
  return entries;
}
function uniqueEntries(items) {
  const seen = /* @__PURE__ */ new Set();
  const result = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    result.push(item);
  }
  return result;
}
function diffFailedEntries(current, baseline) {
  const now = uniqueEntries(current);
  const before = uniqueEntries(baseline);
  const baselineSet = new Set(before);
  const currentSet = new Set(now);
  return {
    added: now.filter((entry) => !baselineSet.has(entry)),
    removed: before.filter((entry) => !currentSet.has(entry))
  };
}
async function runDumpConfig(profileDir) {
  const profile = resolve(profileDir);
  const profileName = basename(profile);
  const home = dirname2(dirname2(profile));
  const bin = resolveDshBin();
  const outcome = await runCommand(bin, ["--profile", profileName, "--dump-config"], {
    env: { ...process.env, DSH_HOME: home },
    timeoutMs: DUMP_CONFIG_TIMEOUT_MS
  });
  if (outcome.spawnError !== null) {
    return [
      {
        kind: "config",
        message: "\u65E0\u6CD5\u542F\u52A8 " + bin + " --dump-config\uFF1A" + outcome.spawnError
      }
    ];
  }
  if (outcome.timedOut) {
    return [
      {
        kind: "config",
        message: bin + " --profile " + profileName + " --dump-config \u5728 " + String(DUMP_CONFIG_TIMEOUT_MS) + "ms \u5185\u6CA1\u6709\u7ED3\u675F"
      }
    ];
  }
  if (outcome.code !== 0) {
    return [
      {
        kind: "config",
        message: bin + " --profile " + profileName + " --dump-config \u5931\u8D25\uFF08" + describeCommand(outcome) + "\uFF09"
      }
    ];
  }
  return parseNotActivated(outcome.stderr).map((entry) => ({
    kind: "config",
    plugin: entry,
    message: "dump-config \u62A5\u544A\u6761\u76EE " + entry + " \u672A\u6FC0\u6D3B"
  }));
}
function cloneAttemptTimeoutMs(args) {
  return args.includes("-c") ? CLONE_TIMEOUT_MS : COPY_TIMEOUT_MS;
}
function describeCloneAttempt(args, outcome, timeoutMs) {
  const command = "cp " + args.slice(0, -2).join(" ");
  if (outcome.timedOut) return command + "\uFF1A\u514B\u9686\u8D85\u65F6\uFF08" + String(timeoutMs) + " ms\uFF09";
  return command + "\uFF1A" + describeCommand(outcome);
}
async function cloneProfile(source, dest) {
  const candidates = cloneCandidates(process.platform, source, dest);
  const attempts = [];
  for (const args of candidates) {
    const timeoutMs = cloneAttemptTimeoutMs(args);
    const outcome = await runCommand("cp", args, { timeoutMs });
    if (outcome.code === 0) return null;
    attempts.push(describeCloneAttempt(args, outcome, timeoutMs));
    await rm2(dest, { recursive: true, force: true }).catch(() => void 0);
  }
  return {
    kind: "boot",
    message: "\u514B\u9686 profile \u5931\u8D25\uFF1A" + attempts.join("\uFF1B")
  };
}
function parseWebUrl(stdout) {
  const line = WEB_URL_LINE.exec(stdout);
  if (line === null) return { port: null, urlWithoutPort: null };
  const raw = line[1] ?? "";
  try {
    const url = new URL(raw);
    const port = Number(url.port);
    if (Number.isInteger(port) && port > 0) return { port, urlWithoutPort: null };
    return { port: null, urlWithoutPort: raw };
  } catch {
    return { port: null, urlWithoutPort: raw };
  }
}
async function settleOutput(lastOutputAt) {
  const cap = Date.now() + OUTPUT_SETTLE_CAP_MS;
  while (Date.now() < cap) {
    if (Date.now() - lastOutputAt() >= OUTPUT_QUIET_MS) return;
    await delay(25);
  }
}
async function runWebInClone(tmpHome, profileName, timeoutMs) {
  const bin = resolveDshBin();
  const homeNote = "\uFF08\u8BD5\u8DD1 DSH_HOME: " + tmpHome + "\uFF0C\u4EC5\u514B\u9686 profile \u5C42\uFF09";
  const child = spawn(bin, ["--profile", profileName, "--port", "0", "--no-open"], {
    env: { ...process.env, DSH_HOME: tmpHome, DSH_DAEMON_OPEN_BROWSER: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32"
  });
  let stdout = "";
  let stderr = "";
  let lastOutputAt = Date.now();
  const spawnErrors = [];
  const exitRecords = [];
  let port = null;
  let urlWithoutPort = null;
  let healthStatus = null;
  let lastProbeError = "";
  let health = false;
  let cleaned = true;
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout = appendCapped(stdout, chunk, STDOUT_LIMIT);
    lastOutputAt = Date.now();
  });
  child.stderr?.on("data", (chunk) => {
    stderr = appendCapped(stderr, chunk, STDERR_LIMIT);
    lastOutputAt = Date.now();
  });
  child.once("error", (error) => {
    spawnErrors.push(messageOf(error));
  });
  child.once("exit", (code, signal) => {
    exitRecords.push({ code, signal });
  });
  const streamClosed = new Promise((resolveClosed) => {
    child.once("close", () => resolveClosed());
  });
  if (child.pid !== void 0) void recordDshIdentity(tmpHome, child.pid);
  const failures = [];
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (spawnErrors.length > 0 || exitRecords.length > 0) break;
      const probe = parseWebUrl(stdout);
      if (probe.port !== null) port = probe.port;
      if (probe.urlWithoutPort !== null) urlWithoutPort = probe.urlWithoutPort;
      if (port !== null) {
        try {
          const response = await fetch("http://127.0.0.1:" + String(port) + "/health", {
            signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS)
          });
          healthStatus = response.status;
          if (response.status === 200) {
            health = true;
            break;
          }
        } catch (error) {
          lastProbeError = messageOf(error);
        }
      }
      await delay(HEALTH_POLL_INTERVAL_MS);
    }
    if (health) {
      await settleOutput(() => lastOutputAt);
    } else if (exitRecords.length > 0) {
      await Promise.race([streamClosed, delay(EXIT_FLUSH_MS)]);
    }
    if (health) {
    } else if (spawnErrors.length > 0) {
      failures.push({
        kind: "boot",
        message: "\u65E0\u6CD5\u542F\u52A8\u8BD5\u8DD1\u5B9E\u4F8B\uFF08" + bin + "\uFF09\uFF1A" + (spawnErrors[0] ?? "") + homeNote
      });
    } else if (exitRecords.length > 0) {
      const exitState = exitRecords[0];
      const status = exitState.code !== null ? "\u9000\u51FA\u7801 " + String(exitState.code) : "\u88AB\u4FE1\u53F7 " + (exitState.signal ?? "unknown") + " \u7ED3\u675F";
      const detail = tail(stderr);
      failures.push({
        kind: "boot",
        message: "\u8BD5\u8DD1\u5B9E\u4F8B\u63D0\u524D\u9000\u51FA\uFF08" + status + "\uFF09" + (detail === "" ? "" : "\uFF1A" + detail) + homeNote
      });
    } else if (port === null && urlWithoutPort !== null) {
      failures.push({
        kind: "boot",
        message: "\u8BD5\u8DD1\u5B9E\u4F8B\u6253\u5370\u7684 Web URL \u53D6\u4E0D\u5230\u672C\u5730\u76D1\u542C\u7AEF\u53E3\uFF08\u53EF\u80FD\u662F public-url \u5F62\u6001\uFF09\uFF1A" + urlWithoutPort + homeNote
      });
    } else if (port === null) {
      const detail = tail(stderr);
      failures.push({
        kind: "boot",
        message: "\u8BD5\u8DD1\u5B9E\u4F8B\u5728 " + String(timeoutMs) + "ms \u5185\u6CA1\u6709\u6253\u5370 Web URL" + (detail === "" ? "" : "\uFF1A" + detail) + homeNote
      });
    } else {
      const probe = lastProbeError === "" ? "" : "\uFF0C\u6700\u540E\u63A2\u6D3B\u9519\u8BEF\uFF1A" + lastProbeError;
      failures.push({
        kind: "boot",
        message: "\u8BD5\u8DD1\u5B9E\u4F8B\u7AEF\u53E3 " + String(port) + " \u7684 /health \u5728 " + String(timeoutMs) + "ms \u5185\u672A\u8FD4\u56DE 200\uFF08\u6700\u540E\u72B6\u6001\uFF1A" + (healthStatus === null ? "\u65E0\u54CD\u5E94" : String(healthStatus)) + probe + "\uFF09" + homeNote
      });
    }
  } finally {
    cleaned = await killProcessTree(child);
    if (!cleaned) {
      failures.push({
        kind: "boot",
        message: "\u8BD5\u8DD1\u5B9E\u4F8B\uFF08pid " + String(child.pid) + "\uFF09\u7684\u8FDB\u7A0B\u7EC4\u5728 SIGKILL \u540E\u4ECD\u672A\u9000\u51FA\uFF0C\u53EF\u80FD\u7559\u4E0B\u5B64\u513F\u8FDB\u7A0B" + homeNote
      });
    }
  }
  return { health, cleaned, failures, failedEntries: parseNotActivated(stderr) };
}
async function runSmoke(options) {
  const startedAt = Date.now();
  const profileDir = resolve(options.profileDir);
  const profileName = basename(profileDir);
  const timeoutMs = options.timeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS;
  const failures = [];
  let health = false;
  let processesCleaned = true;
  let dirCleaned = true;
  let failedEntries = [];
  let tmpHome = null;
  try {
    const tmpRoot = resolve(options.tmpRoot);
    await mkdir2(tmpRoot, { recursive: true });
    const stale = await cleanupStaleSmokeDirs(tmpRoot);
    failures.push(...stale.failures);
    tmpHome = await mkdtemp(join3(tmpRoot, SMOKE_DIR_PREFIX));
    const home = tmpHome;
    writeRunPidFile(home);
    await mkdir2(join3(home, "profiles"), { recursive: true });
    const clonedProfile = join3(home, "profiles", profileName);
    const cloneFailure = await cloneProfile(profileDir, clonedProfile);
    if (cloneFailure !== null) {
      failures.push({
        ...cloneFailure,
        message: cloneFailure.message + "\uFF08\u8BD5\u8DD1 DSH_HOME: " + home + "\uFF0C\u4EC5\u514B\u9686 profile \u5C42\uFF09"
      });
    } else {
      const run = await runWebInClone(home, profileName, timeoutMs);
      health = run.health;
      processesCleaned = run.cleaned;
      failedEntries = run.failedEntries;
      failures.push(...run.failures);
    }
  } catch (error) {
    failures.push({ kind: "boot", message: "\u5192\u70DF\u51C6\u5907\u5931\u8D25\uFF1A" + messageOf(error) });
  } finally {
    if (tmpHome !== null) {
      try {
        await rm2(tmpHome, { recursive: true, force: true });
      } catch (error) {
        dirCleaned = false;
        failures.push({
          kind: "boot",
          message: "\u4E34\u65F6\u76EE\u5F55 " + tmpHome + " \u6E05\u7406\u5931\u8D25\uFF1A" + messageOf(error)
        });
      }
    }
  }
  const ok = health && processesCleaned && dirCleaned;
  return { ok, health, failures, failedEntries, durationMs: Date.now() - startedAt };
}

// src/server/precheck.ts
var running = false;
function acquirePrecheck() {
  if (running) return false;
  running = true;
  return true;
}
function releasePrecheck() {
  running = false;
}
async function runPrecheckRun(io, target, options = {}) {
  const startedAt = Date.now();
  const elapsed = () => Math.max(0, Date.now() - startedAt);
  const cancelled = () => options.isCancelled?.() ?? false;
  const cancelledOutcome = (smoke) => ({
    ok: false,
    saved: false,
    cancelled: true,
    fingerprint: null,
    failures: smoke?.failures ?? [],
    warnings: [],
    entries: smoke?.failedEntries ?? [],
    health: smoke?.health ?? false,
    durationMs: elapsed()
  });
  try {
    const configFailures = await stage("config", () => io.runDumpConfig(target.dir));
    options.onStage?.({ stage: "config", ok: configFailures.length === 0, failures: configFailures });
    const version = io.runtimeVersion();
    const pluginWarnings = [];
    try {
      const plugins = await io.readInstalled(target.dir, (failure) => pluginWarnings.push(failure));
      pluginWarnings.push(...io.compatFailures(plugins, version ?? ""));
    } catch (error) {
      pluginWarnings.push({ kind: "compat", message: "\u517C\u5BB9\u6027\u68C0\u67E5\u6CA1\u8DD1\u5B8C\uFF1A" + messageOf2(error) });
    }
    options.onStage?.({ stage: "compat", ok: true, failures: [], warnings: pluginWarnings });
    if (cancelled()) return cancelledOutcome();
    let smoke;
    try {
      smoke = await io.runSmoke({ profileDir: target.dir, tmpRoot: io.tmpRoot });
    } catch (error) {
      smoke = {
        ok: false,
        health: false,
        failures: [{ kind: "boot", message: "\u5192\u70DF\u6267\u884C\u5931\u8D25\uFF1A" + messageOf2(error) }],
        failedEntries: [],
        durationMs: 0
      };
    }
    if (cancelled()) return cancelledOutcome(smoke);
    const previous = await safeReadLast(io);
    const { added } = diffFailedEntries(smoke.failedEntries, previous.baseline ?? []);
    const newEntrySet = new Set(added);
    const bootWarnings = smoke.failedEntries.map((entry) => ({
      plugin: entry,
      kind: "boot",
      message: newEntrySet.has(entry) ? `${entry} \u6CA1\u6709\u6FC0\u6D3B\uFF08\u4E0D\u5728\u4E0A\u6B21\u901A\u8FC7\u7684\u57FA\u7EBF\u91CC\uFF09` : `${entry} \u6CA1\u6709\u6FC0\u6D3B\uFF08\u4E0A\u6B21\u901A\u8FC7\u65F6\u4E5F\u662F\u8FD9\u6837\uFF09`
    }));
    const bootFailures = smoke.failures;
    const bootOk = smoke.ok && smoke.health && bootFailures.length === 0;
    options.onStage?.({
      stage: "boot",
      ok: bootOk,
      failures: bootFailures,
      warnings: bootWarnings,
      entries: smoke.failedEntries,
      added,
      health: smoke.health
    });
    const ok = configFailures.length === 0 && bootOk;
    const failures = [...configFailures, ...bootFailures];
    const warnings = [...pluginWarnings, ...bootWarnings];
    let fingerprint = null;
    try {
      fingerprint = await io.computeFingerprint(target.dir, version);
    } catch {
      fingerprint = null;
    }
    if (cancelled()) return cancelledOutcome(smoke);
    if (fingerprint !== null) {
      const result = {
        at: io.now().toISOString(),
        ok,
        fingerprint,
        failures,
        warnings,
        durationMs: elapsed()
      };
      try {
        const patch = ok ? { precheck: result, baseline: [...smoke.failedEntries].sort(), fingerprint } : { precheck: result, fingerprint };
        await io.writeLast(io.logDir, patch);
      } catch (error) {
        const saveError = "\u9884\u68C0\u7ED3\u679C\u5199\u76D8\u5931\u8D25\uFF1A" + messageOf2(error);
        console.error("[dsh-restart] " + saveError);
        return {
          ok,
          saved: false,
          cancelled: false,
          fingerprint,
          failures,
          warnings,
          entries: smoke.failedEntries,
          health: smoke.health,
          durationMs: elapsed(),
          error: saveError
        };
      }
    }
    return {
      ok,
      saved: fingerprint !== null,
      cancelled: false,
      fingerprint,
      failures,
      warnings,
      entries: smoke.failedEntries,
      health: smoke.health,
      durationMs: elapsed()
    };
  } catch (error) {
    const message = "\u9884\u68C0\u5F02\u5E38\u7EC8\u6B62\uFF1A" + messageOf2(error);
    console.error("[dsh-restart] " + message);
    return {
      ok: false,
      saved: false,
      cancelled: false,
      fingerprint: null,
      failures: [],
      warnings: [],
      entries: [],
      health: false,
      durationMs: elapsed(),
      error: message
    };
  }
}
async function safeReadLast(io) {
  try {
    return await io.readLast(io.logDir);
  } catch {
    return {};
  }
}
async function stage(kind, run) {
  try {
    return await run();
  } catch (error) {
    return [{ kind, message: "\u5FEB\u68C0\u6267\u884C\u5931\u8D25\uFF1A" + messageOf2(error) }];
  }
}
function messageOf2(error) {
  return error instanceof Error ? error.message : String(error);
}

// src/server/issue.ts
import { join as join5 } from "path";

// src/server/restart.ts
import { spawn as spawnProcess } from "child_process";
import {
  accessSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync as readFileSync2,
  statSync,
  unlinkSync,
  writeSync
} from "fs";
import { access } from "fs/promises";
import { homedir } from "os";
import { basename as basename2, dirname as dirname3, join as join4, resolve as resolve2 } from "path";
import { setTimeout as delay2 } from "timers/promises";
import { fileURLToPath } from "url";
var HEALTH_PATH = "/health";
var PLUGIN_STATUS_PATH = "/dsh-restart/api/status";
var POLL_INTERVAL_MS = 250;
var PROBE_TIMEOUT_MS = 1500;
var STALE_LOCK_MS = 10 * 6e4;
var RESTART_LOCK_NAME = "restart.lock";
async function isRefused(lockPath) {
  try {
    await access(lockPath);
    return true;
  } catch {
    return false;
  }
}
async function probeHealth(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${HEALTH_PATH}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { accept: "text/plain" }
    });
    try {
      await response.body?.cancel();
    } catch {
    }
    return response.status === 200;
  } catch {
    return false;
  }
}
async function pollOnce(port, probe) {
  try {
    return await probe(port);
  } catch {
    return false;
  }
}
async function pollState(port, timeoutMs, wantUp, probe, clock) {
  const deadline = clock.now() + Math.max(0, timeoutMs);
  for (let spins = 0; spins < 1e5; spins += 1) {
    if (await pollOnce(port, probe) === wantUp) return true;
    const remaining = deadline - clock.now();
    if (remaining <= 0) return false;
    await clock.sleep(Math.min(clock.pollMs, remaining));
  }
  return false;
}
function waitForPort(port, timeoutMs, probe = probeHealth) {
  return pollState(port, timeoutMs, true, probe, { now: Date.now, sleep: delay2, pollMs: POLL_INTERVAL_MS });
}
function messageOf3(error) {
  return error instanceof Error ? error.message : String(error);
}
function scheduleRestart(options, deps = {}) {
  try {
    const helperPath = deps.helperPath ?? fileURLToPath(new URL("./helper.js", import.meta.url));
    const env = {
      ...deps.env ?? process.env,
      DSH_RESTART_PORT: String(options.port),
      DSH_RESTART_PROFILE: resolve2(options.profileDir),
      DSH_RESTART_LOG_DIR: resolve2(options.logDir),
      DSH_RESTART_WEB_PID: String(process.pid)
    };
    if (options.dshHome !== void 0) env.DSH_RESTART_DSH_HOME = resolve2(options.dshHome);
    if (options.profileName !== void 0) env.DSH_RESTART_PROFILE_NAME = options.profileName;
    if (options.dshBin !== void 0) env.DSH_RESTART_DSH_BIN = options.dshBin;
    const spawnHelper = deps.spawn;
    if (spawnHelper === void 0) {
      accessSync(helperPath);
    }
    const child = (spawnHelper ?? spawnProcess)(process.execPath, [helperPath], {
      detached: true,
      stdio: "ignore",
      env,
      // 换个 cwd，避免当前目录被删/不可读时影响 helper 起步。
      cwd: homedir()
    });
    child.on?.("error", (error) => {
      console.error(`[dsh-restart] \u91CD\u542F helper \u542F\u52A8\u5931\u8D25\uFF1A${messageOf3(error)}`);
    });
    child.unref();
  } catch (error) {
    console.error(`[dsh-restart] \u65E0\u6CD5\u542F\u52A8\u91CD\u542F helper\uFF1A${messageOf3(error)}`);
  }
}

// src/server/issue.ts
var RESTART_BUSY_ERROR = "\u5DF2\u6709\u4E00\u4E2A\u91CD\u542F\u5728\u8FDB\u884C\u4E2D\uFF0C\u7B49\u5B83\u7ED3\u675F\u518D\u8BD5";
var restartStarting = false;
function tryBeginRestart() {
  if (restartStarting) return false;
  restartStarting = true;
  return true;
}
function endRestart() {
  restartStarting = false;
}
async function restartGuards(io, target, port) {
  if (target === void 0) {
    return { ok: false, status: 503, error: "\u53D6\u4E0D\u5230 profileContext\uFF0C\u65E0\u6CD5\u91CD\u542F" };
  }
  if (port === void 0) {
    return { ok: false, status: 503, error: "webServer \u8FD8\u6CA1\u76D1\u542C\u7AEF\u53E3\uFF0C\u65E0\u6CD5\u91CD\u542F" };
  }
  let refused = false;
  try {
    refused = await io.isRefused(join5(io.logDir, RESTART_LOCK_NAME));
  } catch {
    refused = false;
  }
  if (refused) return { ok: false, status: 409, error: RESTART_BUSY_ERROR };
  return { ok: true };
}
function armRestart(io, target, port) {
  io.scheduleRestart({
    port,
    profileDir: target.dir,
    logDir: io.logDir,
    dshHome: target.home,
    profileName: target.name
  });
}
function issueRestartLater(io, target, port, delayMs) {
  let fired = false;
  const fire = () => {
    if (fired) return;
    fired = true;
    armRestart(io, target, port);
  };
  const delay3 = Number.isFinite(delayMs) && delayMs > 0 ? delayMs : 0;
  const timer = setTimeout(fire, delay3);
  if (typeof timer.unref === "function") timer.unref();
  return {
    cancel() {
      if (fired) return;
      fired = true;
      clearTimeout(timer);
    }
  };
}

// src/server/profile.ts
import { basename as basename3, dirname as dirname4 } from "path";
function profileOf(ctx) {
  let value;
  try {
    value = ctx.get("profileContext");
  } catch {
    return void 0;
  }
  if (!isRecord(value)) return void 0;
  const dir = value.dir;
  if (typeof dir !== "string" || dir.trim() === "") return void 0;
  const name2 = typeof value.name === "string" && value.name !== "" ? value.name : basename3(dir);
  const home = typeof value.home === "string" && value.home !== "" ? value.home : dirname4(dirname4(dir));
  return { dir, name: name2, home };
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// src/tools/schema.ts
var FAILURE_SCHEMA = {
  type: "object",
  properties: {
    plugin: { type: "string" },
    kind: { type: "string", enum: ["config", "compat", "boot"] },
    message: { type: "string" },
    expected: { type: "string" },
    actual: { type: "string" }
  },
  required: ["kind", "message"],
  additionalProperties: false
};
function summaryTextOf(value) {
  if (typeof value === "object" && value !== null) {
    const summary = value.summary;
    if (typeof summary === "string") return summary;
  }
  return "\uFF08\u6CA1\u6709\u6458\u8981\uFF09";
}
function redSummaryOf(outcome) {
  const first = outcome.failures[0];
  const error = typeof outcome.error === "string" && outcome.error !== "" ? outcome.error : void 0;
  if (first !== void 0) return "\u68C0\u67E5\u6CA1\u901A\u8FC7\uFF1A" + first.message + (error === void 0 ? "" : "\uFF08" + error + "\uFF09");
  return error ?? "\u68C0\u67E5\u6CA1\u901A\u8FC7\uFF0C\u4F46\u6CA1\u62FF\u5230\u5931\u8D25\u539F\u56E0";
}
function failureLineOf(failure) {
  if (typeof failure !== "object" || failure === null) return "\uFF08\u65E0\u6CD5\u8BC6\u522B\u7684\u6761\u76EE\uFF09";
  const record = failure;
  const kind = typeof record.kind === "string" ? record.kind : "";
  const message = typeof record.message === "string" ? record.message : "";
  const details = [];
  if (typeof record.plugin === "string" && record.plugin !== "") details.push(record.plugin);
  if (typeof record.expected === "string" && record.expected !== "") details.push("\u671F\u671B " + record.expected);
  if (typeof record.actual === "string" && record.actual !== "") details.push("\u5B9E\u9645 " + record.actual);
  const head = kind === "" ? message : "[" + kind + "] " + message;
  return details.length === 0 ? head : head + "\uFF08" + details.join("\uFF1B") + "\uFF09";
}
function renderWithIssues(_args, value) {
  const record = typeof value === "object" && value !== null ? value : {};
  const blocks = [{ type: "text", text: summaryTextOf(value) }];
  for (const failure of listOf(record.failures)) blocks.push({ type: "text", text: "\u5931\u8D25\uFF1A" + failureLineOf(failure) });
  for (const warning of listOf(record.warnings)) blocks.push({ type: "text", text: "\u63D0\u793A\uFF1A" + failureLineOf(warning) });
  return blocks;
}
function listOf(value) {
  return Array.isArray(value) ? value : [];
}

// src/tools/precheck.ts
var PARAMETERS = { type: "object", properties: {}, additionalProperties: false };
var OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    busy: { type: "boolean" },
    cancelled: { type: "boolean" },
    saved: { type: "boolean" },
    durationMs: { type: "number" },
    health: { type: "boolean" },
    failures: { type: "array", items: FAILURE_SCHEMA },
    warnings: { type: "array", items: FAILURE_SCHEMA },
    entries: { type: "array", items: { type: "string" } },
    fingerprint: { type: "string" },
    summary: { type: "string" }
  },
  required: [
    "ok",
    "busy",
    "cancelled",
    "saved",
    "durationMs",
    "health",
    "failures",
    "warnings",
    "entries",
    "fingerprint",
    "summary"
  ],
  additionalProperties: false
};
var NO_PROFILE_SUMMARY = "\u53D6\u4E0D\u5230 profileContext\uFF0C\u65E0\u6CD5\u9884\u68C0";
var BUSY_SUMMARY = "\u5DF2\u6709\u4E00\u8F6E\u9884\u68C0\u5728\u8FDB\u884C\uFF0C\u7B49\u5B83\u7ED3\u675F\u518D\u8BD5";
var CANCELLED_SUMMARY = "\u8FD9\u8F6E\u9884\u68C0\u88AB\u53D6\u6D88\uFF0C\u4E0D\u4F5C\u6570";
function createPrecheckTool(ctx, io) {
  return {
    name: "dsh_restart_precheck",
    description: "\u8DD1\u4E00\u8F6E dsh web \u542F\u52A8\u9884\u68C0\uFF08\u914D\u7F6E\u5408\u6210\u3001\u63D2\u4EF6\u517C\u5BB9\u3001\u514B\u9686 profile \u8BD5\u542F\u52A8\uFF09\uFF0C\u53EA\u68C0\u67E5\u3001\u4E0D\u91CD\u542F\uFF1B\u8FD4\u56DE\u662F\u5426\u901A\u8FC7\u3001\u5931\u8D25/\u63D0\u793A\u6E05\u5355\u4E0E profile \u6307\u7EB9\u3002",
    parameters: PARAMETERS,
    output: { schema: OUTPUT_SCHEMA, render: renderWithIssues },
    async execute(_args, exec) {
      const target = profileOf(ctx);
      if (target === void 0) return valueOf({ summary: NO_PROFILE_SUMMARY });
      if (!acquirePrecheck()) return valueOf({ busy: true, summary: BUSY_SUMMARY });
      let outcome;
      try {
        outcome = await runPrecheckRun(io, target, {
          isCancelled: () => exec.signal?.aborted === true
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return valueOf({ summary: "\u9884\u68C0\u5F02\u5E38\u7EC8\u6B62\uFF1A" + message });
      } finally {
        releasePrecheck();
      }
      return valueOfOutcome(outcome);
    }
  };
}
function valueOf(overrides = {}) {
  return {
    ok: false,
    busy: false,
    cancelled: false,
    saved: false,
    durationMs: 0,
    health: false,
    failures: [],
    warnings: [],
    entries: [],
    fingerprint: "",
    summary: "",
    ...overrides
  };
}
function valueOfOutcome(outcome) {
  return {
    ok: outcome.ok,
    busy: false,
    cancelled: outcome.cancelled,
    saved: outcome.saved,
    durationMs: outcome.durationMs,
    health: outcome.health,
    failures: copyFailures(outcome.failures),
    warnings: copyFailures(outcome.warnings),
    entries: [...outcome.entries],
    fingerprint: outcome.fingerprint ?? "",
    summary: summaryOf(outcome)
  };
}
function summaryOf(outcome) {
  if (outcome.cancelled) return CANCELLED_SUMMARY;
  const error = typeof outcome.error === "string" && outcome.error !== "" ? outcome.error : void 0;
  if (!outcome.ok) return redSummaryOf(outcome);
  if (outcome.saved) return `\u68C0\u67E5\u901A\u8FC7\uFF1A\u914D\u7F6E\u80FD\u5408\u6210\uFF0C\u8BD5\u8DD1\u5B9E\u4F8B\u8D77\u6765\u4E86\uFF08${outcome.warnings.length} \u6761\u63D0\u793A\uFF09`;
  return error ?? "\u68C0\u67E5\u901A\u8FC7\uFF0C\u4F46\u62FF\u4E0D\u5230 profile \u6307\u7EB9\uFF0C\u7ED3\u679C\u6CA1\u843D\u76D8";
}
function copyFailures(failures) {
  return failures.map((failure) => {
    const copy = { kind: failure.kind, message: failure.message };
    if (typeof failure.plugin === "string") copy.plugin = failure.plugin;
    if (typeof failure.expected === "string") copy.expected = failure.expected;
    if (typeof failure.actual === "string") copy.actual = failure.actual;
    return copy;
  });
}

// src/tools/restart.ts
var PARAMETERS2 = {
  type: "object",
  properties: {
    force: {
      type: "boolean",
      description: "\u8DF3\u8FC7\u9884\u68C0\u76F4\u63A5\u91CD\u542F\uFF1B\u6B63\u5E38\u60C5\u51B5\u4E0D\u8981\u4F20\uFF0C\u5148\u8BA9\u9884\u68C0\u62E6\u4E00\u904D\u518D\u51B3\u5B9A\u3002"
    }
  },
  additionalProperties: false
};
var OUTPUT_SCHEMA2 = {
  type: "object",
  properties: {
    ok: { type: "boolean" },
    restarted: { type: "boolean" },
    reason: { type: "string" },
    port: { type: "number" },
    profileName: { type: "string" },
    failures: { type: "array", items: FAILURE_SCHEMA },
    warnings: { type: "array", items: FAILURE_SCHEMA },
    summary: { type: "string" }
  },
  required: ["ok", "restarted", "reason", "port", "profileName", "failures", "warnings", "summary"],
  additionalProperties: false
};
var TOOL_RESTART_DELAY_MS = 2500;
function valueOf2(patch) {
  return {
    ok: patch.ok,
    restarted: patch.restarted,
    reason: patch.reason,
    port: patch.port ?? 0,
    profileName: patch.profileName ?? "",
    failures: patch.failures ?? [],
    warnings: patch.warnings ?? [],
    summary: patch.summary
  };
}
function portOf(ctx) {
  try {
    const webServer = ctx.get("webServer");
    const port = webServer?.port;
    return typeof port === "number" && Number.isInteger(port) && port > 0 ? port : void 0;
  } catch {
    return void 0;
  }
}
async function freshPassed(io, target) {
  const record = await io.readLast(io.logDir);
  if (record?.precheck?.ok !== true) return false;
  const fingerprint = await io.computeFingerprint(target.dir, io.runtimeVersion());
  return !isStale(record, fingerprint);
}
function messageOf4(err) {
  return err instanceof Error ? err.message : String(err);
}
function conclude(exec) {
  if (typeof exec.concludeTurn !== "function") return;
  try {
    exec.concludeTurn();
  } catch {
  }
}
function createRestartTool(ctx, io) {
  return {
    name: "dsh_restart",
    description: "\u91CD\u542F\u672C\u673A dsh web\uFF1A\u5148\u8DD1\u9884\u68C0\uFF08\u9664\u975E force=true\uFF09\uFF0C\u901A\u8FC7\u540E\u5EF6\u8FDF\u6D3E\u751F helper \u5E76\u4E2D\u65AD\u5F53\u524D\u4F1A\u8BDD\uFF1B\u91CD\u542F\u5B8C\u6210\u540E\u786C\u5237\u9875\u9762\u3002",
    parameters: PARAMETERS2,
    output: { schema: OUTPUT_SCHEMA2, render: renderWithIssues },
    async execute(args, exec) {
      const target = profileOf(ctx);
      const port = portOf(ctx);
      const base = { port: port ?? 0, profileName: target?.name ?? "" };
      try {
        if (target === void 0) {
          return valueOf2({
            ...base,
            ok: false,
            restarted: false,
            reason: "no-profile",
            summary: "\u91CD\u542F\u4E0D\u4E86\uFF1A\u53D6\u4E0D\u5230 profileContext"
          });
        }
        if (exec.signal?.aborted === true) {
          return valueOf2({ ...base, ok: false, restarted: false, reason: "cancelled", summary: "\u9884\u68C0\u5DF2\u53D6\u6D88\uFF0C\u6CA1\u6709\u91CD\u542F" });
        }
        if (!tryBeginRestart()) {
          return valueOf2({
            ...base,
            ok: false,
            restarted: false,
            reason: "busy",
            summary: "\u65E0\u6CD5\u91CD\u542F\uFF1A" + RESTART_BUSY_ERROR
          });
        }
        let released = false;
        const release = () => {
          if (released) return;
          released = true;
          endRestart();
        };
        try {
          const guard2 = await restartGuards(io, target, port);
          if (!guard2.ok) {
            return valueOf2({
              ...base,
              ok: false,
              restarted: false,
              reason: guard2.status === 409 ? "busy" : port === void 0 ? "no-port" : "error",
              summary: "\u65E0\u6CD5\u91CD\u542F\uFF1A" + guard2.error
            });
          }
          if (port === void 0) {
            return valueOf2({
              ...base,
              ok: false,
              restarted: false,
              reason: "no-port",
              summary: "\u65E0\u6CD5\u91CD\u542F\uFF1AwebServer \u8FD8\u6CA1\u76D1\u542C\u7AEF\u53E3\uFF0C\u65E0\u6CD5\u91CD\u542F"
            });
          }
          const force = typeof args === "object" && args !== null && args.force === true;
          if (!force && !await freshPassed(io, target)) {
            if (!acquirePrecheck()) {
              return valueOf2({
                ...base,
                ok: false,
                restarted: false,
                reason: "precheck-busy",
                summary: "\u53E6\u4E00\u4E2A\u9884\u68C0\u6B63\u5728\u8FDB\u884C\uFF0C\u7B49\u5B83\u7ED3\u675F\u518D\u8BD5"
              });
            }
            let outcome;
            try {
              outcome = await runPrecheckRun(io, target, { isCancelled: () => exec.signal?.aborted === true });
            } finally {
              releasePrecheck();
            }
            if (outcome.cancelled) {
              return valueOf2({
                ...base,
                ok: false,
                restarted: false,
                reason: "cancelled",
                summary: "\u9884\u68C0\u5DF2\u53D6\u6D88\uFF0C\u6CA1\u6709\u91CD\u542F"
              });
            }
            if (!outcome.ok) {
              return valueOf2({
                ...base,
                ok: false,
                restarted: false,
                reason: "precheck-failed",
                failures: outcome.failures,
                warnings: outcome.warnings,
                summary: redSummaryOf(outcome)
              });
            }
          }
          release();
          issueRestartLater(io, target, port, TOOL_RESTART_DELAY_MS);
          conclude(exec);
          return valueOf2({
            ...base,
            ok: true,
            restarted: true,
            reason: "restarting",
            summary: "\u5DF2\u53D1\u51FA\u91CD\u542F\uFF0C\u672C\u4F1A\u8BDD\u5F88\u5FEB\u4F1A\u88AB\u4E2D\u65AD\uFF1A\u7EA6 2.5 \u79D2\u540E\u91CD\u542F dsh web\uFF08\u7AEF\u53E3 " + port + "\uFF0Cprofile " + target.name + "\uFF09\uFF1B\u91CD\u542F\u5B8C\u6210\u540E\u786C\u5237\u9875\u9762\u3002"
          });
        } finally {
          release();
        }
      } catch (err) {
        return valueOf2({
          ...base,
          ok: false,
          restarted: false,
          reason: "error",
          summary: "\u91CD\u542F\u524D\u68C0\u67E5\u51FA\u9519\uFF1A" + messageOf4(err)
        });
      }
    }
  };
}

// src/tools/index.ts
function toolsOf(ctx) {
  let value;
  try {
    value = ctx.get("tools");
  } catch {
    return void 0;
  }
  if (typeof value !== "object" || value === null) return void 0;
  const register = value.register;
  if (typeof register !== "function") return void 0;
  return { register: register.bind(value) };
}
function toolDefinitions(ctx, io) {
  return [createPrecheckTool(ctx, io), createRestartTool(ctx, io)];
}
function registerTools(ctx, io) {
  const tools = toolsOf(ctx);
  if (tools === void 0) {
    console.warn("[dsh-restart] \u5BBF\u4E3B\u6CA1\u6709 tools \u670D\u52A1\uFF0C\u4E24\u4E2A agent \u5DE5\u5177\u4E0D\u6CE8\u518C");
    return 0;
  }
  let count = 0;
  for (const definition of toolDefinitions(ctx, io)) {
    ctx.effect(() => {
      const dispose = tools.register(definition);
      return () => dispose();
    }, "dsh-restart: " + definition.name);
    count += 1;
  }
  return count;
}

// src/index.ts
var name = "dsh-restart";
var inject = ["webServer"];
var STATUS_PATH = PLUGIN_STATUS_PATH;
var PRECHECK_PATH = "/dsh-restart/api/precheck";
var RESTART_PATH = "/dsh-restart/api/restart";
var ALLOWED_METHODS = /* @__PURE__ */ new Set(["GET", "POST"]);
var GUARD_HEADER = "x-dsh-restart";
var HEALTH_TIMEOUT_MS = 1500;
var Config = {
  "~standard": {
    version: 1,
    vendor: "dsh-restart",
    validate(value) {
      if (value === void 0 || value === null) return { value: {} };
      if (typeof value !== "object" || Array.isArray(value)) {
        return { issues: [{ message: "dsh-restart \u6CA1\u6709\u914D\u7F6E\u9879\uFF0C\u4F46\u914D\u7F6E\u5FC5\u987B\u662F\u5BF9\u8C61" }] };
      }
      if (Object.keys(value).length > 0) {
        return { issues: [{ message: "dsh-restart \u6CA1\u6709\u914D\u7F6E\u9879\uFF0C\u4E0D\u80FD\u5E26\u4EFB\u4F55\u914D\u7F6E\u5B57\u6BB5" }] };
      }
      return { value: {} };
    }
  }
};
function isAllowed(input) {
  if (input.rejection !== void 0) return false;
  if (!ALLOWED_METHODS.has(input.method.toUpperCase())) return false;
  if (headerOf(input.headers, GUARD_HEADER) !== "1") return false;
  const origin = headerOf(input.headers, "origin");
  if (origin === void 0) return true;
  const host = headerOf(input.headers, "host");
  if (host === void 0 || host === "") return false;
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}
function apply(ctx) {
  const io = defaultIo();
  const handlers = createHandlers(ctx, {}, io);
  const routes = [
    [STATUS_PATH, handlers.status],
    [PRECHECK_PATH, handlers.precheck],
    [RESTART_PATH, handlers.restart]
  ];
  for (const [path, handler] of routes) {
    ctx.effect(() => ctx.webServer.register({ kind: "exact", path, handler }), `dsh-restart: ${path}`);
  }
  registerTools(ctx, io);
}
function createHandlers(ctx, overrides = {}, io = withOverrides(defaultIo(), overrides)) {
  const status = async (req, res) => {
    if (!guard(ctx, req, res, "GET", STATUS_PATH)) return;
    const profile = profileOf(ctx);
    if (profile === void 0) {
      respondJson(res, 503, { ok: false, error: "\u53D6\u4E0D\u5230 profileContext\uFF0C\u65E0\u6CD5\u5224\u65AD\u5F53\u524D profile" });
      return;
    }
    const port = currentPort(ctx);
    const version = io.runtimeVersion();
    const [record, fingerprint, health, restarting] = await Promise.all([
      safeReadLast2(io, io.logDir),
      safeFingerprint(io, profile.dir, version),
      port === void 0 ? Promise.resolve(false) : io.probeHealth(port).catch(() => false),
      io.isRefused(join6(io.logDir, RESTART_LOCK_NAME)).catch(() => false)
    ]);
    respondJson(res, 200, {
      ok: true,
      at: io.now().toISOString(),
      port: port ?? null,
      health,
      stale: isStale(record, fingerprint),
      fingerprint,
      restarting,
      logDir: io.logDir,
      profileName: profile.name,
      last: record
    });
  };
  const precheck = async (req, res) => {
    if (!guard(ctx, req, res, "POST", PRECHECK_PATH)) return;
    const profile = profileOf(ctx);
    if (profile === void 0) {
      respondJson(res, 503, { ok: false, error: "\u53D6\u4E0D\u5230 profileContext\uFF0C\u65E0\u6CD5\u9884\u68C0" });
      return;
    }
    if (!acquirePrecheck()) {
      respondJson(res, 409, { ok: false, error: "\u5DF2\u6709\u4E00\u8F6E\u9884\u68C0\u5728\u8FDB\u884C\uFF0C\u7B49\u5B83\u7ED3\u675F\u518D\u8BD5" });
      return;
    }
    try {
      let cancelled = false;
      const markCancelled = () => {
        if (!res.writableEnded) cancelled = true;
      };
      res.once("close", markCancelled);
      res.statusCode = 200;
      res.setHeader("content-type", "application/x-ndjson; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.setHeader("x-accel-buffering", "no");
      try {
        res.flushHeaders();
      } catch {
      }
      const write = (payload) => {
        if (res.writableEnded) return;
        if (res.destroyed === true) return;
        try {
          res.write(JSON.stringify(payload) + "\n");
        } catch (error) {
          console.error("[dsh-restart] NDJSON \u5199\u5931\u8D25\uFF1A" + messageOf5(error));
        }
      };
      const cancelledPayload = (outcome) => {
        write({
          stage: "boot",
          ok: false,
          cancelled: true,
          failures: outcome.failures,
          warnings: [],
          entries: outcome.entries,
          added: [],
          health: outcome.health
        });
        write({ done: true, ok: false, saved: false, cancelled: true, reason: "cancelled" });
      };
      try {
        const outcome = await runPrecheckRun(io, profile, {
          onStage: (stage2) => write(stage2),
          isCancelled: () => cancelled
        });
        if (outcome.cancelled) {
          cancelledPayload(outcome);
        } else if (outcome.error !== void 0) {
          write({ done: true, ok: false, saved: false, error: outcome.error });
        } else if (!outcome.saved) {
          write({ done: true, ok: outcome.ok, saved: false, reason: "fingerprint-unavailable" });
        } else {
          write({ done: true, ok: outcome.ok, saved: true, fingerprint: outcome.fingerprint });
        }
      } catch (error) {
        console.error("[dsh-restart] \u9884\u68C0\u5F02\u5E38\u7EC8\u6B62\uFF1A" + messageOf5(error));
        write({ done: true, ok: false, saved: false, error: "\u9884\u68C0\u5F02\u5E38\u7EC8\u6B62\uFF1A" + messageOf5(error) });
      }
    } finally {
      releasePrecheck();
      if (!res.writableEnded) {
        try {
          res.end();
        } catch {
        }
      }
    }
  };
  const restart = async (req, res) => {
    if (!guard(ctx, req, res, "POST", RESTART_PATH)) return;
    if (!tryBeginRestart()) {
      respondJson(res, 409, { ok: false, error: RESTART_BUSY_ERROR });
      return;
    }
    let clientGone = false;
    res.once("close", () => {
      clientGone = true;
    });
    try {
      const profile = profileOf(ctx);
      const port = currentPort(ctx);
      const gate = await restartGuards(io, profile, port);
      if (!gate.ok) {
        endRestart();
        respondJson(res, gate.status, { ok: false, error: gate.error });
        return;
      }
      const target = profile;
      const listenPort = port;
      const at = io.now().toISOString();
      let armed = false;
      const arm = () => {
        if (armed) return;
        armed = true;
        armRestart(io, target, listenPort);
      };
      res.once("finish", arm);
      res.once("close", arm);
      res.once("close", endRestart);
      res.statusCode = 202;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      const body = JSON.stringify({
        ok: true,
        at,
        port: listenPort,
        logDir: io.logDir,
        profileName: target.name
      });
      if (clientGone) {
        arm();
        endRestart();
        try {
          res.end(body);
        } catch {
        }
        return;
      }
      res.end(body);
    } catch (error) {
      endRestart();
      if (!res.headersSent) {
        respondJson(res, 500, { ok: false, error: "\u91CD\u542F\u8BF7\u6C42\u5904\u7406\u5931\u8D25\uFF1A" + messageOf5(error) });
      } else {
        try {
          res.end();
        } catch {
        }
      }
    }
  };
  return { status, precheck, restart };
}
function defaultIo() {
  return {
    now: () => /* @__PURE__ */ new Date(),
    readLast,
    writeLast,
    computeFingerprint,
    runtimeVersion: () => {
      const version = hostRuntimeVersion();
      return version.trim() === "" ? null : version;
    },
    probeHealth: (port) => waitForPort(port, HEALTH_TIMEOUT_MS),
    runDumpConfig,
    readInstalled: (profileDir, onWarning) => readInstalled(profileDir, onWarning === void 0 ? void 0 : { onWarning }),
    compatFailures,
    runSmoke: (options) => runSmoke(options),
    scheduleRestart,
    isRefused,
    tmpRoot: join6(tmpdir(), "dsh-restart-smoke"),
    logDir: process.env.DSH_RESTART_LOG_DIR?.trim() || join6(homedir2(), ".dsh", "dsh-restart")
  };
}
function withOverrides(base, overrides) {
  const merged = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== void 0) merged[key] = value;
  }
  return merged;
}
function currentPort(ctx) {
  try {
    const port = ctx.webServer.port;
    return typeof port === "number" && Number.isFinite(port) && port > 0 ? port : void 0;
  } catch {
    return void 0;
  }
}
function connectionOf(ctx) {
  try {
    const viaGet = ctx.get("connection");
    if (isConnection(viaGet)) return viaGet;
  } catch {
  }
  try {
    const direct = Reflect.get(ctx, "connection");
    if (isConnection(direct)) return direct;
  } catch {
  }
  return void 0;
}
function isConnection(value) {
  return isRecord2(value) && typeof value.requestRejection === "function";
}
function rejectionOf(ctx, req) {
  const connection = connectionOf(ctx);
  if (connection === void 0) return 503;
  try {
    const rejection = connection.requestRejection(req);
    return typeof rejection === "number" ? rejection : void 0;
  } catch {
    return 403;
  }
}
function isLocalReadinessProbe(req, expected, routePath) {
  if (routePath !== STATUS_PATH) return false;
  if (expected !== "GET") return false;
  if ((req.method ?? "").toUpperCase() !== "GET") return false;
  if (pathOf(req.url) !== STATUS_PATH) return false;
  const headers = headersRecord(req.headers);
  if (headerOf(headers, GUARD_HEADER) !== "1") return false;
  if (headerOf(headers, "origin") !== void 0) return false;
  if (headerOf(headers, "x-forwarded-for") !== void 0) return false;
  if (headerOf(headers, "forwarded") !== void 0) return false;
  const host = headerOf(headers, "host");
  if (host === void 0 || !isLoopbackAuthority(host)) return false;
  const address = req.socket?.remoteAddress;
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
function isLoopbackAuthority(authority) {
  try {
    const hostname = new URL("http://" + authority).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
  } catch {
    return false;
  }
}
function pathOf(url) {
  const raw = url ?? "";
  const query = raw.indexOf("?");
  return query === -1 ? raw : raw.slice(0, query);
}
function guard(ctx, req, res, expected, routePath) {
  let rejection = rejectionOf(ctx, req);
  if (rejection === 401 && isLocalReadinessProbe(req, expected, routePath)) rejection = void 0;
  if (!isAllowed({ method: req.method ?? "", headers: headersRecord(req.headers), rejection })) {
    respondJson(res, rejection ?? 403, { ok: false, error: "\u8BF7\u6C42\u672A\u901A\u8FC7\u6765\u6E90\u68C0\u67E5" });
    return false;
  }
  if ((req.method ?? "").toUpperCase() !== expected) {
    respondJson(res, 403, { ok: false, error: `\u8BE5\u8DEF\u7531\u53EA\u6536 ${expected}` });
    return false;
  }
  return true;
}
function headersRecord(headers) {
  const out = {};
  for (const [name2, value] of Object.entries(headers)) {
    if (typeof value === "string") out[name2.toLowerCase()] = value;
    else if (Array.isArray(value)) out[name2.toLowerCase()] = value.join(",");
  }
  return out;
}
function headerOf(headers, name2) {
  const direct = headers[name2];
  if (direct !== void 0) return direct;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name2) return value;
  }
  return void 0;
}
async function safeReadLast2(io, dir) {
  try {
    return await io.readLast(dir);
  } catch {
    return {};
  }
}
async function safeFingerprint(io, profileDir, version) {
  try {
    return await io.computeFingerprint(profileDir, version);
  } catch {
    return null;
  }
}
function respondJson(res, status, payload) {
  try {
    if (res.writableEnded) return;
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(payload));
  } catch (error) {
    console.error("[dsh-restart] \u54CD\u5E94\u5931\u8D25\uFF1A" + messageOf5(error));
  }
}
function isRecord2(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function messageOf5(error) {
  return error instanceof Error ? error.message : String(error);
}
export {
  Config,
  PRECHECK_PATH,
  RESTART_PATH,
  STATUS_PATH,
  apply,
  createHandlers,
  inject,
  isAllowed,
  name
};
//# sourceMappingURL=index.js.map