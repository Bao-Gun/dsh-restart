#!/usr/bin/env node

// src/helper/restart.ts
import { appendFileSync, mkdirSync as mkdirSync2 } from "fs";
import { homedir as homedir2 } from "os";
import { join as join2 } from "path";
import { pathToFileURL } from "url";

// src/server/restart.ts
import { spawn as spawnProcess } from "child_process";
import {
  accessSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeSync
} from "fs";
import { access } from "fs/promises";
import { homedir } from "os";
import { basename, dirname, join, resolve } from "path";
import { setTimeout as delay } from "timers/promises";
import { fileURLToPath } from "url";
var HEALTH_PATH = "/health";
var PLUGIN_STATUS_PATH = "/dsh-restart/api/status";
var PLUGIN_STATUS_HEADER = "x-dsh-restart";
var PLUGIN_READY_GRACE_MS = 5e3;
var POLL_INTERVAL_MS = 250;
var PROBE_TIMEOUT_MS = 1500;
var DEFAULT_WAIT_MS = 6e4;
var TAKEOVER_WAIT_MS = 1e4;
var STALE_LOCK_MS = 10 * 6e4;
var RESTART_LOCK_NAME = "restart.lock";
var LOG_FILE_PREFIX = "helper-";
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
async function probePluginStatus(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}${PLUGIN_STATUS_PATH}`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { accept: "application/json", [PLUGIN_STATUS_HEADER]: "1" }
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
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}
function compactTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}
function openHelperLog(logDir, at) {
  try {
    mkdirSync(logDir, { recursive: true });
    const file = join(logDir, `${LOG_FILE_PREFIX}${compactTimestamp(at)}.log`);
    const fd = openSync(file, "a", 384);
    let closed = false;
    return {
      file,
      fd,
      write: (message) => {
        if (closed) return;
        try {
          writeSync(fd, `${(/* @__PURE__ */ new Date()).toISOString()} [pid ${process.pid}] ${message}
`);
        } catch {
        }
      },
      close: () => {
        if (closed) return;
        closed = true;
        try {
          closeSync(fd);
        } catch {
        }
      }
    };
  } catch (error) {
    process.stderr.write(`[dsh-restart] \u65E0\u6CD5\u521B\u5EFA helper \u65E5\u5FD7\uFF08${logDir}\uFF09\uFF1A${messageOf(error)}
`);
    return null;
  }
}
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
function readLock(lockPath) {
  try {
    const raw = readFileSync(lockPath, "utf8");
    const ageMs = Date.now() - statSync(lockPath).mtimeMs;
    let pid = null;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && typeof parsed.pid === "number") {
        pid = parsed.pid;
      }
    } catch {
    }
    return { pid, ageMs };
  } catch {
    return null;
  }
}
function lockIsStale(lockPath) {
  const lock = readLock(lockPath);
  if (lock === null) return true;
  if (lock.ageMs > STALE_LOCK_MS) return true;
  if (lock.pid === null) return lock.ageMs > 1e4;
  return !isAlive(lock.pid);
}
function acquireLock(lockPath, write) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx", 384);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, at: (/* @__PURE__ */ new Date()).toISOString() }));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") {
        write(`\u65E0\u6CD5\u521B\u5EFA\u9501\u6587\u4EF6 ${lockPath}\uFF1A${messageOf(error)}`);
        return false;
      }
      if (attempt === 0 && lockIsStale(lockPath)) {
        write(`\u6E05\u7406\u6B8B\u7559\u9501\u6587\u4EF6 ${lockPath}`);
        try {
          unlinkSync(lockPath);
        } catch {
        }
        continue;
      }
      return false;
    }
  }
  return false;
}
function daemonRestartEnv(base = process.env) {
  const env = { ...base, DSH_DAEMON_OPEN_BROWSER: "0" };
  if (!env.SSH_CONNECTION && !env.SSH_TTY) env.SSH_CONNECTION = "dsh-restart 0 dsh-restart 0";
  return env;
}
function defaultStartDaemonRestart(logFd) {
  const command = process.env.DSH_RESTART_DAEMON_BIN?.trim() || "dsh-daemon";
  let child;
  try {
    child = spawnProcess(command, ["restart"], { stdio: ["ignore", logFd, logFd], env: daemonRestartEnv() });
  } catch (error) {
    return { exited: Promise.resolve({ code: null, signal: null, error: messageOf(error) }) };
  }
  const exited = new Promise((resolvePromise) => {
    child.once("error", (error) => {
      resolvePromise({ code: null, signal: null, error: messageOf(error) });
    });
    child.once("exit", (code, signal) => {
      resolvePromise({ code, signal });
    });
  });
  return { exited };
}
function defaultStartWeb(options) {
  const command = options.dshBin?.trim() || process.env.DSH_RESTART_DSH_BIN?.trim() || "dsh";
  try {
    const child = spawnProcess(
      command,
      ["--profile", options.profileName, "--port", String(options.port), "--no-open"],
      {
        detached: true,
        stdio: ["ignore", options.logFd, options.logFd],
        env: options.env
      }
    );
    child.once("error", (error) => {
      try {
        writeSync(
          options.logFd,
          `${(/* @__PURE__ */ new Date()).toISOString()} [pid ${process.pid}] spawn dsh web \u5931\u8D25\uFF1A${messageOf(error)}
`
        );
      } catch {
      }
    });
    child.unref();
    return child.pid === void 0 ? {} : { pid: child.pid };
  } catch (error) {
    return { error: messageOf(error) };
  }
}
function defaultKillWeb(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
  }
}
function webEnv(dshHome, profileDir) {
  return {
    ...process.env,
    DSH_HOME: dshHome ?? dirname(dirname(profileDir)),
    DSH_DAEMON_OPEN_BROWSER: "0"
  };
}
async function runRestartHelper(options, deps = {}) {
  const probe = deps.probe ?? probeHealth;
  const pluginProbe = deps.probePlugin ?? probePluginStatus;
  const pluginGraceMs = deps.pluginGraceMs ?? options.pluginGraceMs ?? PLUGIN_READY_GRACE_MS;
  const clock = {
    now: deps.now ?? Date.now,
    sleep: deps.sleep ?? delay,
    pollMs: deps.pollMs ?? POLL_INTERVAL_MS
  };
  const startedAt = clock.now();
  const port = options.port;
  const profileDir = resolve(options.profileDir);
  const profileName = options.profileName ?? basename(profileDir);
  const dshHome = options.dshHome === void 0 ? void 0 : resolve(options.dshHome);
  const waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
  const logDir = resolve(
    options.logDir ?? (process.env.DSH_RESTART_LOG_DIR?.trim() || join(homedir(), ".dsh", "dsh-restart"))
  );
  const startDaemonRestart = deps.startDaemonRestart ?? defaultStartDaemonRestart;
  const startWeb = deps.startWeb ?? defaultStartWeb;
  const killWeb = deps.killWeb ?? defaultKillWeb;
  const log = openHelperLog(logDir, new Date(startedAt));
  const logFd = log?.fd ?? 2;
  const write = log?.write ?? ((message) => {
    process.stderr.write(`${(/* @__PURE__ */ new Date()).toISOString()} ${message}
`);
  });
  const lockPath = join(logDir, RESTART_LOCK_NAME);
  let locked = false;
  const confirmPlugin = async (label) => {
    const ready = await pollState(port, pluginGraceMs, true, pluginProbe, clock);
    if (ready) {
      write(`\u2705 web healthy on port ${port} after ${clock.now() - startedAt}ms\uFF08${label}\uFF0Cweb + \u63D2\u4EF6\u5747\u5C31\u7EEA\uFF09`);
      return true;
    }
    write(
      `web \u5DF2\u8D77\u6765\u4F46\u63D2\u4EF6\u672A\u52A0\u8F7D\uFF08${PLUGIN_STATUS_PATH} \u672A\u5728 ${pluginGraceMs}ms \u5185\u8FD4\u56DE 200\uFF09\uFF1B\u672C\u6B21\u91CD\u542F\u4E0D\u7B97\u6210\u529F`
    );
    return false;
  };
  const derivedHome = dirname(dirname(profileDir));
  const effectiveHome = dshHome ?? derivedHome;
  const pathSource = options.dshHome !== void 0 && options.profileName !== void 0 ? "explicit" : "derived";
  try {
    write(
      `restart helper start port=${port} profileDir=${profileDir} home=${effectiveHome} profile=${profileName} source=${pathSource} waitMs=${waitMs} log=${log?.file ?? "(stderr)"}`
    );
    if (!acquireLock(lockPath, write)) {
      write(`refused: \u9501 ${lockPath} \u88AB\u5360\u7528\uFF0C\u53E6\u4E00\u4E2A helper \u6B63\u5728\u91CD\u542F`);
      return 1;
    }
    locked = true;
    write(`lock acquired ${lockPath} pid=${process.pid}`);
    const initialUp = await pollOnce(port, probe);
    write(`port before: ${initialUp ? "up" : "down"}`);
    const state = { outcome: null };
    let handle;
    try {
      handle = startDaemonRestart(logFd);
    } catch (error) {
      handle = { exited: Promise.resolve({ code: null, signal: null, error: messageOf(error) }) };
    }
    void handle.exited.then(
      (value) => {
        state.outcome = value;
      },
      (error) => {
        state.outcome = { code: null, signal: null, error: messageOf(error) };
      }
    );
    const outcomeNow = () => state.outcome;
    const deadline = clock.now() + waitMs;
    const remaining = () => Math.max(0, deadline - clock.now());
    let lastUp = initialUp;
    let sawDown = !initialUp;
    let healthy = false;
    let skipped = false;
    let failure = null;
    let loggedOutcome = false;
    for (let spins = 0; spins < 1e5; spins += 1) {
      const up = await pollOnce(port, probe);
      if (up !== lastUp) write(`port: ${up ? "up" : "down"} (+${clock.now() - startedAt}ms)`);
      if (!up) sawDown = true;
      if (up && sawDown) {
        healthy = true;
        break;
      }
      lastUp = up;
      const finished2 = outcomeNow();
      if (finished2 !== null && !loggedOutcome) {
        loggedOutcome = true;
        write(
          `dsh-daemon restart ${finished2.error !== void 0 ? `\u542F\u52A8\u5931\u8D25\uFF1A${finished2.error}` : `\u9000\u51FA code=${String(finished2.code)} signal=${finished2.signal ?? "null"}`}`
        );
        if (finished2.error !== void 0) failure = `\u65E0\u6CD5\u542F\u52A8 dsh-daemon restart\uFF1A${finished2.error}`;
        else if (finished2.code !== 0) failure = `dsh-daemon restart \u9000\u51FA\u7801 ${String(finished2.code)}`;
        else if (up && !sawDown) {
          skipped = true;
          break;
        }
      }
      if (failure !== null) break;
      if (clock.now() >= deadline) break;
      await clock.sleep(clock.pollMs);
    }
    if (healthy) {
      return await confirmPlugin("daemon \u8DEF\u5F84") ? 0 : 1;
    }
    const finished = outcomeNow();
    if (skipped) {
      write("daemon \u8DF3\u8FC7\u4E86\u91CD\u542F\uFF08dsh web \u521A\u542F\u52A8\u4E0D\u5230 15s\uFF09\uFF0C\u672C\u6B21\u4E0D\u91CD\u542F");
      return 1;
    }
    if (finished === null) write(`dsh-daemon restart \u672A\u5728 ${waitMs}ms \u5185\u9000\u51FA`);
    else if (failure !== null) write(`daemon \u8DEF\u5F84\u5931\u8D25\uFF1A${failure}`);
    const nowUp = await pollOnce(port, probe);
    if (nowUp && !sawDown && finished?.code === 0) {
      write("daemon \u62A5\u6210\u529F\u4F46\u672A\u89C2\u5BDF\u5230\u7AEF\u53E3\u4E0B\u6389\uFF1B\u6309\u8DF3\u8FC7\u5904\u7406\uFF0C\u4E0D\u81EA\u62C9\u8D77");
      return 1;
    }
    if (nowUp && failure === null) {
      write(
        finished === null ? `dsh-daemon restart \u4ECD\u5728\u8FD0\u884C\uFF08\u672A\u5728 ${waitMs}ms \u5185\u9000\u51FA\uFF09\uFF0C\u4E14 /health \u4E00\u76F4\u4E3A 200\uFF1B\u4E0D\u81EA\u62C9\u8D77` : "daemon \u62A5\u6210\u529F\u4F46 /health \u5728\u9884\u7B97\u5185\u672A\u63A2\u5230\uFF1B\u4E0D\u81EA\u62C9\u8D77\uFF08\u907F\u514D\u548C daemon \u62A2\u7AEF\u53E3\uFF09"
      );
      return 1;
    }
    if (nowUp) {
      if (options.webPid === void 0 || !isAlive(options.webPid)) {
        write(`\u63A5\u7BA1\u5931\u8D25\uFF1A/health \u4ECD\u4E3A 200\uFF0C\u4F46\u6CA1\u6709\u5B58\u6D3B\u7684 web PID\uFF08${String(options.webPid)}\uFF09\u53EF\u7528`);
        return 1;
      }
      write(`\u63A5\u7BA1\uFF1ASIGTERM \u65E7 web pid=${options.webPid}`);
      killWeb(options.webPid);
      const takeoverBudget = Math.min(TAKEOVER_WAIT_MS, remaining());
      const down = await pollState(port, takeoverBudget, false, probe, clock);
      if (!down) {
        write(`SIGTERM \u540E ${takeoverBudget}ms \u5185 /health \u4ECD\u4E3A 200\uFF0C\u653E\u5F03\u81EA\u62C9\u8D77`);
        return 1;
      }
      write("\u65E7 web \u5DF2\u9000\u51FA\uFF0C\u5F00\u59CB\u81EA\u62C9\u8D77");
    }
    write(`\u81EA\u62C9\u8D77\uFF1Adsh --profile ${profileName} --port ${port} --no-open`);
    const launchOptions = {
      logFd,
      profileName,
      port,
      env: webEnv(dshHome, profileDir)
    };
    if (options.dshBin !== void 0) launchOptions.dshBin = options.dshBin;
    const launch = startWeb(launchOptions);
    if (launch.error !== void 0) {
      write(`\u81EA\u62C9\u8D77\u5931\u8D25\uFF1A${launch.error}`);
      return 1;
    }
    write(`\u81EA\u62C9\u8D77\u8FDB\u7A0B\u5DF2\u6D3E\u751F${launch.pid === void 0 ? "\uFF08\u65E0 pid\uFF09" : ` pid=${launch.pid}`}`);
    const selfStartBudget = remaining();
    const back = await pollState(port, selfStartBudget, true, probe, clock);
    if (back) {
      return await confirmPlugin("\u81EA\u62C9\u8D77") ? 0 : 1;
    }
    write(`\u274C \u81EA\u62C9\u8D77\u540E ${selfStartBudget}ms \u5185 /health \u672A\u8FD4\u56DE 200`);
    return 1;
  } finally {
    if (locked) {
      try {
        unlinkSync(lockPath);
      } catch {
      }
    }
    log?.close();
  }
}

// src/helper/restart.ts
function parsePort(raw) {
  const text = raw?.trim() ?? "";
  if (text === "") return null;
  const value = Number(text);
  if (!Number.isInteger(value) || value < 1 || value > 65535) return null;
  return value;
}
function parsePositiveInt(raw) {
  const text = raw?.trim() ?? "";
  if (text === "") return null;
  const value = Number(text);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}
function parseHelperConfig(env) {
  const rawPort = env.DSH_RESTART_PORT;
  const port = parsePort(rawPort);
  if (port === null) {
    return { ok: false, error: `DSH_RESTART_PORT \u4E0D\u662F\u5408\u6CD5\u7AEF\u53E3\uFF1A${JSON.stringify(rawPort ?? "")}` };
  }
  const profileDir = env.DSH_RESTART_PROFILE?.trim() ?? "";
  if (profileDir === "") {
    return { ok: false, error: "DSH_RESTART_PROFILE \u672A\u8BBE\u7F6E" };
  }
  const config = {
    port,
    profileDir,
    logDir: env.DSH_RESTART_LOG_DIR?.trim() || join2(homedir2(), ".dsh", "dsh-restart")
  };
  const rawWait = env.DSH_RESTART_WAIT_MS;
  if (rawWait !== void 0 && rawWait.trim() !== "") {
    const waitMs = parsePositiveInt(rawWait);
    if (waitMs === null) return { ok: false, error: `DSH_RESTART_WAIT_MS \u4E0D\u5408\u6CD5\uFF1A${JSON.stringify(rawWait)}` };
    config.waitMs = waitMs;
  }
  const dshHome = env.DSH_RESTART_DSH_HOME?.trim() ?? "";
  if (dshHome !== "") config.dshHome = dshHome;
  const profileName = env.DSH_RESTART_PROFILE_NAME?.trim() ?? "";
  if (profileName !== "") config.profileName = profileName;
  const dshBin = env.DSH_RESTART_DSH_BIN?.trim() ?? "";
  if (dshBin !== "") config.dshBin = dshBin;
  const rawGrace = env.DSH_RESTART_PLUGIN_GRACE_MS;
  if (rawGrace !== void 0 && rawGrace.trim() !== "") {
    const pluginGraceMs = parsePositiveInt(rawGrace);
    if (pluginGraceMs === null) {
      return { ok: false, error: `DSH_RESTART_PLUGIN_GRACE_MS \u4E0D\u5408\u6CD5\uFF1A${JSON.stringify(rawGrace)}` };
    }
    config.pluginGraceMs = pluginGraceMs;
  }
  const rawPid = env.DSH_RESTART_WEB_PID;
  if (rawPid !== void 0 && rawPid.trim() !== "") {
    const webPid = parsePositiveInt(rawPid);
    if (webPid === null) return { ok: false, error: `DSH_RESTART_WEB_PID \u4E0D\u5408\u6CD5\uFF1A${JSON.stringify(rawPid)}` };
    config.webPid = webPid;
  }
  return { ok: true, config };
}
function appendHelperErrorLog(env, message) {
  try {
    const logDir = env.DSH_RESTART_LOG_DIR?.trim() || join2(homedir2(), ".dsh", "dsh-restart");
    mkdirSync2(logDir, { recursive: true });
    appendFileSync(
      join2(logDir, "helper-last-error.log"),
      `${(/* @__PURE__ */ new Date()).toISOString()} [pid ${process.pid}] ${message}
`
    );
  } catch {
  }
}
async function helperMain(options = {}) {
  const env = options.env ?? process.env;
  const stderr = options.stderr ?? ((text) => {
    process.stderr.write(text);
  });
  const parsed = parseHelperConfig(env);
  if (!parsed.ok) {
    appendHelperErrorLog(env, `\u914D\u7F6E\u9519\u8BEF\uFF1A${parsed.error}`);
    stderr(`[dsh-restart] helper \u914D\u7F6E\u9519\u8BEF\uFF1A${parsed.error}
`);
    return 1;
  }
  return runRestartHelper(parsed.config, options.deps ?? {});
}
function invokedDirectly() {
  const entry = process.argv[1];
  if (entry === void 0) return false;
  try {
    return pathToFileURL(entry).href === import.meta.url;
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  void helperMain().then(
    (code) => {
      process.exit(code);
    },
    (error) => {
      const detail = error instanceof Error ? error.stack ?? error.message : String(error);
      process.stderr.write(`[dsh-restart] helper \u5D29\u6E83\uFF1A${detail}
`);
      process.exit(1);
    }
  );
}
export {
  helperMain,
  parseHelperConfig
};
//# sourceMappingURL=helper.js.map