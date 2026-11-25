const { app, BrowserWindow, clipboard, dialog, ipcMain, nativeImage, Notification, shell } = require("electron");
const { spawn, execFile, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { randomBytes, randomUUID, timingSafeEqual } = require("node:crypto");
const { fileURLToPath } = require("node:url");
const pty = require("node-pty");

const sessions = new Map();
const livePtys = new Map();
const SESSION_STORE_FILE = "sessions.json";
const MAX_SESSIONS = 2000;
const MAX_PTY_BUFFER_BYTES = 512 * 1024;
const MAX_PTY_WRITE_CHARS = 1024 * 1024;
const MAX_CLIPBOARD_CHARS = 1024 * 1024;
const SESSION_SAVE_DEBOUNCE_MS = 300;
const SESSION_READ_LIMIT_BYTES = 8 * 1024 * 1024;
const DEV_SERVER_URL = process.env.CIMLINE_DEV_SERVER_URL || "http://127.0.0.1:5173";
const MAX_SKILL_PROJECT_PATHS = 24;
const MAX_SKILL_PATH_CHARS = 4096;
const MAX_SKILL_ENTRIES_PER_ROOT = 1000;
const MAX_SKILL_TOTAL_ENTRIES = 5000;
const MAX_SKILL_CHILD_DIRS_PER_ROOT = 250;
const MAX_SKILL_MANIFESTS = 400;
const MAX_SKILL_MANIFEST_BYTES = 16 * 1024;
const MAX_SKILL_NAME_CHARS = 128;
const MAX_SKILL_DESCRIPTION_CHARS = 4000;
const MAX_SKILL_TOTAL_RETURN_CHARS = 250000;
const MAX_SKILL_WARNINGS = 100;
const MAX_PLUGIN_MARKETPLACES = 40;
const MAX_PLUGIN_PLUGINS_PER_MARKETPLACE = 80;
const MAX_PLUGIN_VERSIONS_PER_PLUGIN = 20;
const MAX_PLUGIN_SKILLS_PER_VERSION = 100;
const MAX_PLUGIN_ENTRIES_PER_DIRECTORY = 500;
const MAX_PLUGIN_MANIFEST_CHECKS = 1000;
const MAX_PLUGIN_MANIFEST_BYTES = 16 * 1024;
const MAX_PLUGIN_SKILL_PATHS = 20;
const MAX_PLUGIN_SKILL_ROOTS = 1000;
const MAX_PLUGIN_SKILL_PATH_DEPTH = 12;
const MAX_RATE_LIMIT_STDERR_CHARS = 1536;
const MAX_RATE_LIMIT_STDERR_BUFFER_CHARS = 4096;
const MAX_RATE_LIMIT_ERROR_CHARS = 2048;
const MAX_NOTIFY_BODY_BYTES = 8 * 1024;
const MAX_INPUT_LINE_CHARS = 16 * 1024;
const SESSION_STATUSES = new Set(["idle", "running", "completed", "approval", "exited"]);
const NOTIFY_EVENTS = new Set(["idle", "running", "completed", "approval"]);
const NOTIFY_ENDPOINT = "/notify";

let sessionStorePath = null;
let notifyServer = null;
let notifyToken = null;
let notifyUrl = null;
let focusedSessionId = null;
let sessionSaveTimer = null;
let sessionWriteChain = Promise.resolve();
let sessionPersistenceReady = false;
let quitFlushStarted = false;
let quitFlushComplete = false;
let codexStartupQueue = Promise.resolve();

function serializeSession(session) {
  return {
    id: session.id,
    title: session.title,
    cwd: session.cwd,
    cli: session.cli,
    closed: session.closed === true,
    createdAt: session.createdAt,
    status: SESSION_STATUSES.has(session.status) ? session.status : session.closed ? "exited" : "idle",
    statusAt: typeof session.statusAt === "string" ? session.statusAt : null,
    unreviewed: session.unreviewed === true,
  };
}

function normalizeSession(record) {
  if (!record || typeof record !== "object" || typeof record.id !== "string" || !record.id.trim()) return null;
  if (typeof record.cwd !== "string" || !record.cwd.trim() || !path.isAbsolute(record.cwd)) return null;
  const cli = record.cli === "claude" ? "claude" : record.cli === "codex" ? "codex" : null;
  if (!cli) return null;
  const cwd = path.resolve(record.cwd);
  return {
    id: record.id.slice(0, 160),
    title: typeof record.title === "string" && record.title.trim() ? record.title.slice(0, 300) : path.basename(cwd) || cwd,
    cwd,
    cli,
    closed: true,
    createdAt: typeof record.createdAt === "string" && !Number.isNaN(Date.parse(record.createdAt)) ? record.createdAt : new Date().toISOString(),
    status: "exited",
    statusAt: new Date().toISOString(),
    unreviewed: false,
    buffer: "",
    bufferBytes: 0,
    sequence: 0,
    inputLine: "",
  };
}

function serializeSessions() {
  return [...sessions.values()].map(serializeSession);
}

function scheduleSessionSave() {
  if (!sessionPersistenceReady || !sessionStorePath) return;
  if (sessionSaveTimer) clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(() => {
    sessionSaveTimer = null;
    queueSessionSave();
  }, SESSION_SAVE_DEBOUNCE_MS);
}

function queueSessionSave() {
  if (!sessionPersistenceReady || !sessionStorePath) return Promise.resolve();
  const contents = JSON.stringify({ version: 1, sessions: [...sessions.values()].slice(-MAX_SESSIONS).map(serializeSession) }, null, 2);
  const write = async () => {
    await fs.promises.mkdir(path.dirname(sessionStorePath), { recursive: true });
    const temporaryPath = sessionStorePath + "." + process.pid + "." + Date.now() + "." + Math.random().toString(16).slice(2) + ".tmp";
    try {
      await fs.promises.writeFile(temporaryPath, contents, "utf8");
      await fs.promises.rename(temporaryPath, sessionStorePath);
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  };
  sessionWriteChain = sessionWriteChain.catch(() => {}).then(write);
  sessionWriteChain.catch((error) => console.error("セッション履歴の保存に失敗しました:", error));
  return sessionWriteChain;
}

async function flushSessionSave() {
  if (sessionSaveTimer) {
    clearTimeout(sessionSaveTimer);
    sessionSaveTimer = null;
  }
  await queueSessionSave();
  await sessionWriteChain;
}

function readJsonFile(filePath) {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile() || stats.size > SESSION_READ_LIMIT_BYTES) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") console.error("セッション履歴を読み込めませんでした:", error?.message || error);
    return null;
  }
}

function legacyTaskFiles() {
  const names = ["Codex Run Desk", "codex-cli-run-desk"];
  return [path.join(path.dirname(sessionStorePath), "tasks.json"), ...names.map((name) => path.join(app.getPath("appData"), name, "tasks.json"))]
    .filter((candidate, index, items) => items.findIndex((item) => path.resolve(item).toLowerCase() === path.resolve(candidate).toLowerCase()) === index);
}

function loadPersistedSessions() {
  sessionStorePath = path.join(app.getPath("userData"), SESSION_STORE_FILE);
  const stored = readJsonFile(sessionStorePath);
  const storedSessions = Array.isArray(stored?.sessions) ? stored.sessions : Array.isArray(stored) ? stored : null;
  if (storedSessions) {
    for (const record of storedSessions.slice(-MAX_SESSIONS)) {
      const session = normalizeSession(record);
      if (session && !sessions.has(session.id)) sessions.set(session.id, session);
    }
  } else {
    const migratedIds = new Set();
    for (const legacyPath of legacyTaskFiles()) {
      const legacy = readJsonFile(legacyPath);
      if (!Array.isArray(legacy?.tasks)) continue;
      for (const record of legacy.tasks.slice(-MAX_SESSIONS)) {
        if (!record || typeof record.id !== "string" || typeof record.cwd !== "string" || !path.isAbsolute(record.cwd)) continue;
        const session = normalizeSession({
          id: record.id,
          title: record.title,
          cwd: record.cwd,
          cli: "codex",
          closed: true,
          createdAt: record.startedAt,
        });
        if (!session || migratedIds.has(session.id)) continue;
        migratedIds.add(session.id);
        sessions.set(session.id, session);
        if (sessions.size >= MAX_SESSIONS) break;
      }
      if (sessions.size >= MAX_SESSIONS) break;
    }
  }
  sessionPersistenceReady = true;
  if (sessions.size > 0) scheduleSessionSave();
  updateUnreviewedBadge();
}

function broadcastSessions() {
  const snapshot = serializeSessions();
  scheduleSessionSave();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("sessions:updated", snapshot);
  }
}

function isApplicationFocused() {
  try {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && !focused.isDestroyed()) return true;
    return BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && typeof window.isFocused === "function" && window.isFocused());
  } catch {
    return false;
  }
}

function countUnreviewedSessions() {
  let count = 0;
  for (const session of sessions.values()) {
    if (session.unreviewed && (session.status === "completed" || session.status === "approval")) count += 1;
  }
  return count;
}

let windowsBadgeImage = null;
function updateUnreviewedBadge() {
  const count = countUnreviewedSessions();
  if (process.platform === "darwin") {
    try { app.dock?.setBadge(count ? String(count) : ""); } catch {}
  } else if (process.platform === "win32") {
    if (!windowsBadgeImage && nativeImage?.createFromDataURL) {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#ef554b" stroke="#ffffff" stroke-width="1"/></svg>';
      windowsBadgeImage = nativeImage.createFromDataURL("data:image/svg+xml;base64," + Buffer.from(svg).toString("base64"));
    }
    const tooltip = count ? `未確認 ${count} 件` : "未確認なし";
    for (const window of BrowserWindow.getAllWindows()) {
      if (window.isDestroyed()) continue;
      try { window.setOverlayIcon?.(count ? windowsBadgeImage : null, tooltip); } catch {}
    }
  } else if (process.platform === "linux") {
    try { app.setBadgeCount?.(count); } catch {}
  }
}

function notifyAttention(session, status) {
  if (isApplicationFocused()) return;
  try {
    if (typeof Notification?.isSupported === "function" && !Notification.isSupported()) return;
    const message = status === "approval" ? "承認または入力を待っています" : "作業が完了しました";
    new Notification({ title: `CimLine · ${session.title}`, body: message }).show();
  } catch {}
}

function setSessionStatus(session, status, { timestamp = new Date().toISOString(), broadcast = true } = {}) {
  if (!session || !SESSION_STATUSES.has(status)) return false;
  const previousStatus = session.status;
  const wasUnreviewed = session.unreviewed === true;
  session.status = status;
  session.statusAt = timestamp;
  if (status === "completed" || status === "approval") {
    session.unreviewed = focusedSessionId !== session.id || !isApplicationFocused();
    if (session.unreviewed && !wasUnreviewed && previousStatus !== status) notifyAttention(session, status);
  } else {
    session.unreviewed = false;
  }
  updateUnreviewedBadge();
  if (broadcast) broadcastSessions();
  else scheduleSessionSave();
  return true;
}

function focusSession(sessionId) {
  if (sessionId !== null && (typeof sessionId !== "string" || sessionId.length > 160)) throw new Error("フォーカス対象が無効です。");
  if (sessionId !== null && !sessions.has(sessionId)) return false;
  focusedSessionId = sessionId;
  const session = sessionId === null ? null : sessions.get(sessionId);
  if (session?.unreviewed) {
    session.unreviewed = false;
    updateUnreviewedBadge();
    broadcastSessions();
  }
  return true;
}

function sendNotifyResponse(response, statusCode) {
  if (response.writableEnded) return;
  response.writeHead(statusCode, { "content-length": "0", "cache-control": "no-store" });
  response.end();
}

function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function isValidNotifyToken(candidate) {
  if (typeof candidate !== "string" || !notifyToken) return false;
  const expected = Buffer.from(notifyToken, "utf8");
  const received = Buffer.from(candidate, "utf8");
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function handleNotifyRequest(request, response) {
  if (request.method !== "POST" || request.url !== NOTIFY_ENDPOINT) return sendNotifyResponse(response, 404);
  if (!isLoopbackAddress(request.socket.remoteAddress)) return sendNotifyResponse(response, 403);
  const contentLength = Number(request.headers["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > MAX_NOTIFY_BODY_BYTES) {
    request.resume();
    return sendNotifyResponse(response, 413);
  }
  const chunks = [];
  let bytes = 0;
  let rejected = false;
  request.on("data", (chunk) => {
    if (rejected) return;
    bytes += chunk.byteLength;
    if (bytes > MAX_NOTIFY_BODY_BYTES) {
      rejected = true;
      chunks.length = 0;
      sendNotifyResponse(response, 413);
      request.resume();
      return;
    }
    chunks.push(chunk);
  });
  request.on("end", () => {
    if (rejected) return;
    let payload;
    try { payload = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8")); } catch { return sendNotifyResponse(response, 400); }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return sendNotifyResponse(response, 400);
    const keys = Object.keys(payload).sort();
    if (keys.length !== 3 || keys[0] !== "event" || keys[1] !== "sessionId" || keys[2] !== "token") return sendNotifyResponse(response, 400);
    if (!isValidNotifyToken(payload.token)) return sendNotifyResponse(response, 401);
    if (typeof payload.event !== "string" || !NOTIFY_EVENTS.has(payload.event) || typeof payload.sessionId !== "string" || payload.sessionId.length > 160) {
      return sendNotifyResponse(response, 400);
    }
    const session = sessions.get(payload.sessionId);
    if (!session || session.closed || !livePtys.has(session.id)) return sendNotifyResponse(response, 404);
    setSessionStatus(session, payload.event);
    sendNotifyResponse(response, 202);
  });
  request.on("error", () => sendNotifyResponse(response, 400));
}

function startNotifyServer() {
  if (notifyServer) return Promise.resolve(notifyUrl);
  notifyToken = randomBytes(32).toString("hex");
  notifyServer = http.createServer(handleNotifyRequest);
  notifyServer.on("clientError", (_error, socket) => { try { socket.destroy(); } catch {} });
  notifyServer.unref?.();
  return new Promise((resolve, reject) => {
    const server = notifyServer;
    server.once("error", (error) => {
      if (notifyServer === server) {
        notifyServer = null;
        notifyToken = null;
        notifyUrl = null;
      }
      reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("通知サーバーのアドレスを取得できません。"));
      notifyUrl = `http://127.0.0.1:${address.port}${NOTIFY_ENDPOINT}`;
      resolve(notifyUrl);
    });
  });
}

function stopNotifyServer() {
  const server = notifyServer;
  notifyServer = null;
  notifyToken = null;
  notifyUrl = null;
  try { server?.close(); } catch {}
}

function acquireCodexStartupLock() {
  let releaseGate;
  const gate = new Promise((resolve) => { releaseGate = resolve; });
  const previous = codexStartupQueue;
  codexStartupQueue = previous.catch(() => {}).then(() => gate);
  return previous.catch(() => {}).then(() => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      releaseGate();
    };
  });
}

function resolveOnPath(command) {
  if (typeof command !== "string" || !command.trim()) return null;
  const value = command.trim();
  const extensions = process.platform === "win32"
    ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  const candidates = [];
  if (path.isAbsolute(value) || value.includes(path.sep) || (path.sep === "\\" && value.includes("/"))) {
    candidates.push(value);
    if (process.platform === "win32" && !path.extname(value)) candidates.push(...extensions.map((extension) => value + extension));
  } else {
    for (const directory of String(process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
      const normalizedDirectory = directory.replace(/^"|"$/g, "");
      candidates.push(path.join(normalizedDirectory, value));
      if (process.platform === "win32" && !path.extname(value)) candidates.push(...extensions.map((extension) => path.join(normalizedDirectory, value + extension)));
    }
  }
  return candidates.find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  }) || null;
}

function globalNodeModulesRoots() {
  const roots = [];
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    roots.push(path.join(appData, "npm", "node_modules"));
    roots.push(path.join(os.homedir(), ".npm-global", "lib", "node_modules"));
  } else {
    try {
      const npmPath = resolveOnPath("npm") || "npm";
      const root = execFileSync(npmPath, ["root", "-g"], { encoding: "utf8", timeout: 3000, windowsHide: true }).trim();
      if (root) roots.push(root);
    } catch {}
    roots.push("/usr/local/lib/node_modules", "/opt/homebrew/lib/node_modules", path.join(os.homedir(), ".npm-global", "lib", "node_modules"));
  }
  return [...new Set(roots.map((root) => path.resolve(root)))];
}

function resolveCodexScript() {
  const candidates = [
    process.env.CODEX_CLI_JS,
    ...globalNodeModulesRoots().map((root) => path.join(root, "@openai", "codex", "bin", "codex.js")),
  ].filter(Boolean);
  return candidates.find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  }) || null;
}

function requireCodexScript() {
  const scriptPath = resolveCodexScript();
  if (!scriptPath) throw new Error("Codex CLIの場所を確認できません。Node.js/npmのグローバルインストールを確認するか、CODEX_CLI_JSにcodex.jsのパスを設定してください。");
  return scriptPath;
}

function getNodeBinary() {
  return process.env.CODEX_NODE_EXE || resolveOnPath("node.exe") || resolveOnPath("node") || (process.platform === "win32" ? "node.exe" : "node");
}

function normalizeRateLimitWindow(window) {
  if (!window || typeof window !== "object") return null;
  const usedPercent = Number(window.usedPercent ?? window.used_percent);
  if (!Number.isFinite(usedPercent)) return null;
  const duration = window.windowDurationMins ?? window.window_duration_mins;
  const resetsAt = window.resetsAt ?? window.resets_at;
  return {
    usedPercent,
    windowDurationMins: duration == null ? null : Number(duration),
    resetsAt: resetsAt == null ? null : Number(resetsAt),
  };
}

function redactRateLimitDiagnostic(value) {
  return String(value || "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/((?:[\w.-]*)(?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|client[_-]?secret|credential|cookie|password))\s*[:=]\s*(?:"(?:Bearer\s+)?[^"]*"|'(?:Bearer\s+)?[^']*'|(?:Bearer\s+|Basic\s+)?[^\s,;&}\]]+)/gi, "$1=[redacted]")
    .replace(/\bBearer\s+[^\s,;&}\]]+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|sess|tok|ghp|gho|ghu|ghs|ghr|github_pat)-[A-Za-z0-9_-]{10,}\b/gi, "[redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[redacted JWT]");
}

async function getCodexRateLimits() {
  const scriptPath = requireCodexScript();
  const releaseStartup = await acquireCodexStartupLock();
  return new Promise((resolve, reject) => {
    let settled = false;
    let initialized = false;
    let stdoutBuffer = "";
    let stderrBuffer = "";
    let startupReleased = false;
    let child;
    let rateLimitRequestId = 2;
    let retriedWithNullParams = false;
    const releaseStartupOnce = () => {
      if (startupReleased) return;
      startupReleased = true;
      releaseStartup();
    };
    const appendStderr = (chunk) => {
      stderrBuffer = redactRateLimitDiagnostic(stderrBuffer + chunk).slice(-MAX_RATE_LIMIT_STDERR_BUFFER_CHARS);
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      releaseStartupOnce();
      if (error) reject(error);
      else resolve(result);
      child?.kill();
    };
    const fail = (message) => {
      const safeMessage = redactRateLimitDiagnostic(message).replace(/\s+/g, " ").trim().slice(0, 420);
      const safeStderr = stderrBuffer.trim().slice(-MAX_RATE_LIMIT_STDERR_CHARS);
      const detail = safeStderr ? "\nCodex app-server stderr: " + safeStderr : "";
      finish(new Error((safeMessage + detail).slice(0, MAX_RATE_LIMIT_ERROR_CHARS)));
    };
    const send = (message) => {
      try { child.stdin.write(JSON.stringify(message) + "\n"); return true; }
      catch (error) { fail("Codex app-serverへ接続できませんでした: " + error.message); return false; }
    };
    const timeout = setTimeout(() => fail("Codexの利用枠情報の取得がタイムアウトしました。"), 15000);
    try {
      child = spawn(getNodeBinary(), [scriptPath, "app-server", "--stdio"], {
        cwd: app.getPath("home"), env: process.env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      clearTimeout(timeout);
      releaseStartupOnce();
      reject(new Error(redactRateLimitDiagnostic(error?.message || error).slice(0, MAX_RATE_LIMIT_ERROR_CHARS)));
      return;
    }
    child.on("error", (error) => fail("Codex app-serverを起動できませんでした: " + error.message));
    child.on("close", (code) => { if (!settled) fail("Codex app-serverが応答前に終了しました (終了コード " + (code ?? "不明") + ")。"); });
    child.stdin.on("error", (error) => fail("Codex app-serverへ接続できませんでした: " + error.message));
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", appendStderr);
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) { fail(message.error.message || "Codex app-serverの初期化に失敗しました。"); return; }
          if (!initialized) {
            initialized = true;
            releaseStartupOnce();
            send({ method: "initialized", params: {} });
            send({ id: rateLimitRequestId, method: "account/rateLimits/read", params: { supportsLunaReserve: true } });
          }
          continue;
        }
        if (message.id !== rateLimitRequestId) continue;
        if (message.error) {
          if (!retriedWithNullParams && (message.error.code === -32600 || message.error.code === -32602)) {
            retriedWithNullParams = true;
            rateLimitRequestId += 1;
            send({ id: rateLimitRequestId, method: "account/rateLimits/read", params: null });
            continue;
          }
          const errorCode = Number.isInteger(message.error.code) ? " (JSON-RPC " + message.error.code + ")" : "";
          fail("Codexの利用枠情報の取得に失敗しました" + errorCode + ": " + (message.error.message || "詳細不明"));
          return;
        }
        const snapshot = message.result?.rateLimits ?? message.result?.rate_limits;
        if (!snapshot) { fail("Codex app-serverの応答にrateLimitsが含まれていません。"); return; }
        finish(null, { primary: normalizeRateLimitWindow(snapshot.primary), secondary: normalizeRateLimitWindow(snapshot.secondary) });
        return;
      }
    });
    send({ id: 1, method: "initialize", params: { clientInfo: { name: "cimline", title: "CimLine", version: app.getVersion() } } });
  });
}
function decodeSkillFrontmatterScalar(rawValue) {
  let value = String(rawValue || "").trim();
  if (!value) return "";

  const quote = value[0];
  if (quote === "'" || quote === '"') {
    let closingIndex = -1;
    for (let index = 1; index < value.length; index += 1) {
      if (quote === '"' && value[index] === "\\") {
        index += 1;
        continue;
      }
      if (value[index] !== quote) continue;
      if (quote === "'" && value[index + 1] === "'") {
        index += 1;
        continue;
      }
      closingIndex = index;
      break;
    }
    if (closingIndex < 0) throw new Error("引用符が閉じていません");
    const trailing = value.slice(closingIndex + 1).trim();
    if (trailing && !trailing.startsWith("#")) throw new Error("引用符の後ろに余分な値があります");
    const scalar = value.slice(0, closingIndex + 1);
    const inner = scalar.slice(1, -1);
    if (quote === '"') {
      try {
        return JSON.parse(scalar);
      } catch {
        return inner.replace(/\\([\\"nrt])/g, (_match, escaped) => ({ "\\": "\\", '"': '"', n: "\n", r: "\r", t: "\t" })[escaped]);
      }
    }
    return inner.replace(/''/g, "'");
  }

  let quoteState = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === "'" || char === '"') && value[index - 1] !== "\\") {
      quoteState = quoteState === char ? null : quoteState || char;
    } else if (char === "#" && !quoteState && (index === 0 || /\s/.test(value[index - 1]))) {
      value = value.slice(0, index).trimEnd();
      break;
    }
  }
  return value;
}

function parseSkillFrontmatter(text) {
  const source = String(text || "");
  const opening = source.match(/^\uFEFF?---\r?\n/);
  if (!opening) return { error: "frontmatterがありません" };
  const remainder = source.slice(opening[0].length);
  const closing = /^(?:---|\.\.\.)[ \t]*(?:\r?\n|$)|(?:\r?\n)(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/m.exec(remainder);
  if (!closing) return { error: `frontmatterが${MAX_SKILL_MANIFEST_BYTES / 1024}KB以内に閉じていません` };
  const frontmatter = remainder.slice(0, closing.index).replace(/\r?\n$/, "");
  const lines = frontmatter ? frontmatter.split(/\r?\n/) : [];

  const fields = {};
  let blockField = null;
  let blockFolded = false;
  let blockLines = [];
  const finishBlock = () => {
    if (!blockField) return;
    const value = blockLines.join(blockFolded ? " " : "\n").trim();
    fields[blockField] = value;
    blockField = null;
    blockLines = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (blockField) {
      if (!line.trim()) {
        blockLines.push("");
        continue;
      }
      if (/^[ \t]/.test(line)) {
        blockLines.push(line.replace(/^[ \t]+/, ""));
        continue;
      }
      finishBlock();
    }

    const match = line.match(/^(name|description)\s*:\s*(.*)$/);
    if (!match) continue;
    const [, field, rawValue] = match;
    if (/^[|>][+-]?$/.test(rawValue.trim())) {
      blockField = field;
      blockFolded = rawValue.trim().startsWith(">");
      blockLines = [];
      continue;
    }
    try {
      fields[field] = decodeSkillFrontmatterScalar(rawValue);
    } catch (error) {
      return { error: `${field}の値を読み取れません (${error.message})` };
    }
  }
  finishBlock();

  const name = typeof fields.name === "string" ? fields.name.trim() : "";
  const description = typeof fields.description === "string" ? fields.description.trim() : "";
  if (!name) return { error: "frontmatterにnameがありません" };
  if (!description) return { error: "frontmatterにdescriptionがありません" };
  if (name.length > MAX_SKILL_NAME_CHARS) return { error: `nameが${MAX_SKILL_NAME_CHARS}文字を超えています` };
  return {
    skill: {
      name,
      description: description.slice(0, MAX_SKILL_DESCRIPTION_CHARS),
      descriptionTruncated: description.length > MAX_SKILL_DESCRIPTION_CHARS,
    },
  };
}

function describeSkillReadError(error) {
  if (error?.code === "EACCES" || error?.code === "EPERM") return "アクセスが拒否されました";
  if (error?.code === "ENOENT") return "ファイルまたはフォルダーが見つかりません";
  return `読み取りに失敗しました${error?.code ? ` (${error.code})` : ""}`;
}

async function checkSkillDirectoryChain(directoryPath) {
  const absolutePath = path.resolve(directoryPath);
  const parsed = path.parse(absolutePath);
  let currentPath = parsed.root;
  const segments = absolutePath.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const segment of segments) {
    currentPath = path.join(currentPath, segment);
    const info = await fs.promises.lstat(currentPath);
    if (info.isSymbolicLink()) return { valid: false, reason: "symlink", path: currentPath };
    if (!info.isDirectory()) return { valid: false, reason: "not-directory", path: currentPath };
  }
  return { valid: true };
}

async function readSkillManifest(manifestPath, addWarning) {
  let fileHandle;
  try {
    const fileInfo = await fs.promises.lstat(manifestPath);
    if (fileInfo.isSymbolicLink()) {
      addWarning(`${manifestPath}: シンボリックリンクは読み飛ばしました`);
      return null;
    }
    if (!fileInfo.isFile()) {
      addWarning(`${manifestPath}: 通常ファイルではないため読み飛ばしました`);
      return null;
    }

    const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    fileHandle = await fs.promises.open(manifestPath, openFlags);
    const openedInfo = await fileHandle.stat();
    if (!openedInfo.isFile()) {
      addWarning(`${manifestPath}: 通常ファイルではないため読み飛ばしました`);
      return null;
    }

    const buffer = Buffer.alloc(MAX_SKILL_MANIFEST_BYTES);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await fileHandle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    const parsed = parseSkillFrontmatter(buffer.subarray(0, bytesRead).toString("utf8"));
    if (parsed.error) {
      addWarning(`${manifestPath}: ${parsed.error}`);
      return null;
    }
    if (parsed.skill.descriptionTruncated) addWarning(`${manifestPath}: descriptionを${MAX_SKILL_DESCRIPTION_CHARS}文字で切り詰めました`);
    delete parsed.skill.descriptionTruncated;
    return parsed.skill;
  } catch (error) {
    if (error?.code !== "ENOENT") addWarning(`${manifestPath}: ${describeSkillReadError(error)}`);
    return null;
  } finally {
    await fileHandle?.close().catch(() => {});
  }
}

async function readPluginSkillsManifest(manifestPath, addWarning) {
  if (manifestPath.length > MAX_SKILL_PATH_CHARS) {
    addWarning(`${manifestPath.slice(0, 120)}: pathが長すぎるためmanifestを読み飛ばしました`);
    return { exists: false, skillsSpecified: false, paths: [] };
  }

  try {
    const parentStatus = await checkSkillDirectoryChain(path.dirname(manifestPath));
    if (!parentStatus.valid) {
      const reason = parentStatus.reason === "symlink"
        ? "シンボリックリンクまたはreparse pointを含むためmanifestを読み飛ばしました"
        : "manifestの親がディレクトリではないため読み飛ばしました";
      addWarning(`${parentStatus.path}: ${reason}`);
      return { exists: false, skillsSpecified: false, paths: [] };
    }
  } catch (error) {
    if (error?.code !== "ENOENT") addWarning(`${path.dirname(manifestPath)}: ${describeSkillReadError(error)}`);
    return { exists: false, skillsSpecified: false, paths: [] };
  }

  let fileHandle;
  try {
    const fileInfo = await fs.promises.lstat(manifestPath);
    if (fileInfo.isSymbolicLink()) {
      addWarning(`${manifestPath}: シンボリックリンクまたはreparse pointのmanifestを読み飛ばしました`);
      return { exists: true, skillsSpecified: false, paths: [] };
    }
    if (!fileInfo.isFile()) {
      addWarning(`${manifestPath}: 通常ファイルではないmanifestを読み飛ばしました`);
      return { exists: true, skillsSpecified: false, paths: [] };
    }
    if (fileInfo.size > MAX_PLUGIN_MANIFEST_BYTES) {
      addWarning(`${manifestPath}: manifestが${MAX_PLUGIN_MANIFEST_BYTES} bytesを超えるため読み飛ばしました`);
      return { exists: true, skillsSpecified: false, paths: [] };
    }

    const openFlags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
    fileHandle = await fs.promises.open(manifestPath, openFlags);
    const openedInfo = await fileHandle.stat();
    if (!openedInfo.isFile()) {
      addWarning(`${manifestPath}: 通常ファイルではないmanifestを読み飛ばしました`);
      return { exists: true, skillsSpecified: false, paths: [] };
    }
    if (openedInfo.size > MAX_PLUGIN_MANIFEST_BYTES) {
      addWarning(`${manifestPath}: manifestが${MAX_PLUGIN_MANIFEST_BYTES} bytesを超えるため読み飛ばしました`);
      return { exists: true, skillsSpecified: false, paths: [] };
    }

    const buffer = Buffer.alloc(MAX_PLUGIN_MANIFEST_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await fileHandle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!result.bytesRead) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > MAX_PLUGIN_MANIFEST_BYTES) {
      addWarning(`${manifestPath}: manifestが${MAX_PLUGIN_MANIFEST_BYTES} bytesを超えるため読み飛ばしました`);
      return { exists: true, skillsSpecified: false, paths: [] };
    }

    let manifest;
    try {
      manifest = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
    } catch {
      addWarning(`${manifestPath}: JSON manifestを解析できません`);
      return { exists: true, skillsSpecified: false, paths: [] };
    }
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      addWarning(`${manifestPath}: JSON manifestの形式が不正です`);
      return { exists: true, skillsSpecified: false, paths: [] };
    }
    if (!Object.hasOwn(manifest, "skills")) {
      return { exists: true, skillsSpecified: false, paths: [] };
    }

    const rawPaths = typeof manifest.skills === "string"
      ? [manifest.skills]
      : Array.isArray(manifest.skills)
        ? manifest.skills
        : null;
    if (!rawPaths) {
      addWarning(`${manifestPath}: skillsは文字列または文字列配列で指定してください`);
      return { exists: true, skillsSpecified: true, paths: [] };
    }

    if (rawPaths.length > MAX_PLUGIN_SKILL_PATHS) {
      addWarning(`${manifestPath}: skills pathは先頭${MAX_PLUGIN_SKILL_PATHS}件のみ読み込みました`);
    }
    const paths = [];
    for (const rawPath of rawPaths.slice(0, MAX_PLUGIN_SKILL_PATHS)) {
      if (typeof rawPath !== "string") {
        addWarning(`${manifestPath}: skills pathに文字列以外があるため読み飛ばしました`);
        continue;
      }
      paths.push(rawPath);
    }
    return { exists: true, skillsSpecified: true, paths };
  } catch (error) {
    if (error?.code !== "ENOENT") addWarning(`${manifestPath}: ${describeSkillReadError(error)}`);
    return { exists: error?.code !== "ENOENT", skillsSpecified: false, paths: [] };
  } finally {
    await fileHandle?.close().catch(() => {});
  }
}

function resolvePluginSkillsPath(pluginRoot, manifestPath, rawPath, addWarning) {
  if (rawPath.length > MAX_SKILL_PATH_CHARS) {
    addWarning(`${manifestPath}: skills pathが長すぎるため読み飛ばしました`);
    return null;
  }
  if (!rawPath.startsWith("./")) {
    addWarning(`${manifestPath}: skills pathはplugin rootからの ./ 相対パスで指定してください`);
    return null;
  }

  const relativePath = rawPath.slice(2);
  if (!relativePath || path.isAbsolute(relativePath) || path.posix.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    addWarning(`${manifestPath}: skills pathはplugin root内の相対パスで指定してください`);
    return null;
  }

  const normalizedPath = relativePath.replace(/[\\/]+$/, "");
  const pathParts = normalizedPath.split(/[\\/]/);
  if (!normalizedPath || pathParts.some((part) => !part || part === ".." || part.includes(":"))) {
    addWarning(`${manifestPath}: skills pathに空の要素、絶対パス、または..を含められません`);
    return null;
  }
  const normalizedParts = pathParts.filter((part) => part !== ".");
  if (!normalizedParts.length || normalizedParts.length > MAX_PLUGIN_SKILL_PATH_DEPTH) {
    addWarning(`${manifestPath}: skills pathの深さが上限${MAX_PLUGIN_SKILL_PATH_DEPTH}を超えるため読み飛ばしました`);
    return null;
  }

  let resolvedPath;
  try {
    resolvedPath = path.resolve(pluginRoot, ...normalizedParts);
  } catch {
    addWarning(`${manifestPath}: skills pathを解決できません`);
    return null;
  }
  const relativeToRoot = path.relative(pluginRoot, resolvedPath);
  if (!relativeToRoot || relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
    addWarning(`${manifestPath}: skills pathはplugin root内を指定してください`);
    return null;
  }
  if (resolvedPath.length > MAX_SKILL_PATH_CHARS) {
    addWarning(`${manifestPath}: 解決後のskills pathが長すぎるため読み飛ばしました`);
    return null;
  }
  return resolvedPath;
}

async function getSkills(projectPaths) {
  const warnings = [];
  let warningsTruncated = false;
  const addWarning = (warning) => {
    if (warnings.length < MAX_SKILL_WARNINGS - 1) warnings.push(warning);
    else if (!warningsTruncated) {
      warningsTruncated = true;
      warnings.push("警告が多いため、残りは省略しました");
    }
  };
  const skills = [];
  const codexHome = path.resolve(String(process.env.CODEX_HOME || path.join(os.homedir(), ".codex")));
  const roots = [
    { scope: "user", skillsPath: path.join(os.homedir(), ".agents", "skills") },
    { scope: "codex-home", skillsPath: path.join(codexHome, "skills") },
    { scope: "system", skillsPath: path.join(codexHome, "skills", ".system") },
  ];
  if (!Array.isArray(projectPaths)) {
    addWarning("projectPathsは文字列配列で指定してください");
  } else {
    if (projectPaths.length > MAX_SKILL_PROJECT_PATHS) addWarning(`projectPathsは先頭${MAX_SKILL_PROJECT_PATHS}件のみ走査しました`);
    for (const candidate of projectPaths.slice(0, MAX_SKILL_PROJECT_PATHS)) {
      if (typeof candidate !== "string" || !candidate.trim() || candidate.length > MAX_SKILL_PATH_CHARS || !path.isAbsolute(candidate)) {
        addWarning("無効なproject pathを読み飛ばしました");
        continue;
      }
      const projectPath = path.resolve(candidate);
      roots.push({ scope: "project", projectPath, skillsPath: path.join(projectPath, ".agents", "skills") });
    }
  }

  const seenRoots = new Set();
  let manifestCount = 0;
  let returnedChars = 0;
  let totalEntryCount = 0;
  let totalEntryCapWarned = false;
  const warnTotalEntryCap = () => {
    if (totalEntryCapWarned) return;
    totalEntryCapWarned = true;
    addWarning(`skillsディレクトリエントリ数が上限${MAX_SKILL_TOTAL_ENTRIES}件に達しました`);
  };
  const listImmediateDirectories = async (directoryPath, maxEntries, maxDirectories) => {
    if (directoryPath.length > MAX_SKILL_PATH_CHARS) {
      addWarning(`${directoryPath.slice(0, 120)}: pathが長すぎるため読み飛ばしました`);
      return [];
    }
    let status;
    try {
      status = await checkSkillDirectoryChain(directoryPath);
    } catch (error) {
      if (error?.code !== "ENOENT") addWarning(`${directoryPath}: ${describeSkillReadError(error)}`);
      return [];
    }
    if (!status.valid) {
      const reason = status.reason === "symlink"
        ? "シンボリックリンクまたはreparse pointを含むため読み飛ばしました"
        : "ディレクトリではないため読み飛ばしました";
      addWarning(`${status.path}: ${reason}`);
      return [];
    }

    let directory;
    try {
      directory = await fs.promises.opendir(directoryPath);
    } catch (error) {
      addWarning(`${directoryPath}: ${describeSkillReadError(error)}`);
      return [];
    }

    const directories = [];
    let entryCount = 0;
    try {
      while (entryCount < maxEntries && totalEntryCount < MAX_SKILL_TOTAL_ENTRIES) {
        const entry = await directory.read();
        if (!entry) break;
        entryCount += 1;
        totalEntryCount += 1;
        if (entry.isSymbolicLink()) {
          addWarning(`${path.join(directoryPath, entry.name)}: シンボリックリンクまたはreparse pointを読み飛ばしました`);
          continue;
        }
        if (!entry.isDirectory()) continue;
        if (directories.length >= maxDirectories) {
          addWarning(`${directoryPath}: 直下ディレクトリは先頭${maxDirectories}件のみ走査しました`);
          break;
        }
        const childPath = path.join(directoryPath, entry.name);
        if (childPath.length > MAX_SKILL_PATH_CHARS) {
          addWarning(`${childPath.slice(0, 120)}: pathが長すぎるため読み飛ばしました`);
          continue;
        }
        try {
          const childStatus = await checkSkillDirectoryChain(childPath);
          if (!childStatus.valid) {
            const reason = childStatus.reason === "symlink"
              ? "シンボリックリンクまたはreparse pointを含むため読み飛ばしました"
              : "ディレクトリではないため読み飛ばしました";
            addWarning(`${childStatus.path}: ${reason}`);
            continue;
          }
        } catch (error) {
          if (error?.code !== "ENOENT") addWarning(`${childPath}: ${describeSkillReadError(error)}`);
          continue;
        }
        directories.push(childPath);
      }
      if (entryCount >= maxEntries) addWarning(`${directoryPath}: エントリは先頭${maxEntries}件のみ走査しました`);
      if (totalEntryCount >= MAX_SKILL_TOTAL_ENTRIES) warnTotalEntryCap();
    } catch (error) {
      addWarning(`${directoryPath}: ${describeSkillReadError(error)}`);
    } finally {
      await directory.close().catch(() => {});
    }
    return directories.sort((left, right) => left.localeCompare(right));
  };
  for (const root of roots) {
    if (totalEntryCount >= MAX_SKILL_TOTAL_ENTRIES) {
      warnTotalEntryCap();
      break;
    }
    const rootPath = path.resolve(root.skillsPath);
    if (rootPath.length > MAX_SKILL_PATH_CHARS) {
      addWarning(`${rootPath.slice(0, 120)}: pathが長すぎるため読み飛ばしました`);
      continue;
    }
    const rootKey = process.platform === "win32" ? rootPath.toLowerCase() : rootPath;
    const scopeKey = `${root.scope}:${rootKey}`;
    if (seenRoots.has(scopeKey)) continue;
    seenRoots.add(scopeKey);

    let rootStatus;
    try {
      rootStatus = await checkSkillDirectoryChain(rootPath);
    } catch (error) {
      if (error?.code !== "ENOENT") addWarning(`${rootPath}: ${describeSkillReadError(error)}`);
      continue;
    }
    if (!rootStatus.valid && rootStatus.reason === "symlink") {
      addWarning(`${rootStatus.path}: シンボリックリンクまたはreparse pointを含むため読み飛ばしました`);
      continue;
    }
    if (!rootStatus.valid) {
      addWarning(`${rootStatus.path}: ディレクトリではないため読み飛ばしました`);
      continue;
    }

    let directory;
    try {
      directory = await fs.promises.opendir(rootPath);
    } catch (error) {
      addWarning(`${rootPath}: ${describeSkillReadError(error)}`);
      continue;
    }

    let entryCount = 0;
    const childDirectories = [];
    try {
      while (entryCount < MAX_SKILL_ENTRIES_PER_ROOT && totalEntryCount < MAX_SKILL_TOTAL_ENTRIES) {
        const entry = await directory.read();
        if (!entry) break;
        entryCount += 1;
        totalEntryCount += 1;
        if (entry.isSymbolicLink()) {
          addWarning(`${path.join(rootPath, entry.name)}: シンボリックリンクを読み飛ばしました`);
          continue;
        }
        if (!entry.isDirectory()) continue;
        if (childDirectories.length >= MAX_SKILL_CHILD_DIRS_PER_ROOT) {
          addWarning(`${rootPath}: 直下ディレクトリは先頭${MAX_SKILL_CHILD_DIRS_PER_ROOT}件のみ走査しました`);
          break;
        }
        childDirectories.push(entry.name);
      }
      if (entryCount >= MAX_SKILL_ENTRIES_PER_ROOT) addWarning(`${rootPath}: エントリは先頭${MAX_SKILL_ENTRIES_PER_ROOT}件のみ走査しました`);
      if (totalEntryCount >= MAX_SKILL_TOTAL_ENTRIES) warnTotalEntryCap();
    } catch (error) {
      addWarning(`${rootPath}: ${describeSkillReadError(error)}`);
    } finally {
      await directory.close().catch(() => {});
    }

    childDirectories.sort((left, right) => left.localeCompare(right));
    for (const childName of childDirectories) {
      const skillDirectory = path.join(rootPath, childName);
      if (skillDirectory.length > MAX_SKILL_PATH_CHARS) {
        addWarning(`${skillDirectory.slice(0, 120)}: pathが長すぎるため読み飛ばしました`);
        continue;
      }
      try {
        const childInfo = await fs.promises.lstat(skillDirectory);
        if (childInfo.isSymbolicLink() || !childInfo.isDirectory()) {
          addWarning(`${skillDirectory}: 通常のディレクトリではないため読み飛ばしました`);
          continue;
        }
      } catch (error) {
        addWarning(`${skillDirectory}: ${describeSkillReadError(error)}`);
        continue;
      }

      if (manifestCount >= MAX_SKILL_MANIFESTS) {
        addWarning(`manifest数が上限${MAX_SKILL_MANIFESTS}件に達しました`);
        return { skills, warnings };
      }
      const manifestPath = path.join(skillDirectory, "SKILL.md");
      if (manifestPath.length > MAX_SKILL_PATH_CHARS) {
        addWarning(`${manifestPath.slice(0, 120)}: pathが長すぎるため読み飛ばしました`);
        continue;
      }
      manifestCount += 1;
      const skill = await readSkillManifest(manifestPath, addWarning);
      if (!skill) continue;
      if (returnedChars + skill.name.length + skill.description.length > MAX_SKILL_TOTAL_RETURN_CHARS) {
        addWarning(`返却テキストが上限${MAX_SKILL_TOTAL_RETURN_CHARS}文字に達しました`);
        return { skills, warnings };
      }
      returnedChars += skill.name.length + skill.description.length;
      skills.push({
        name: skill.name,
        description: skill.description,
        scope: root.scope,
        path: manifestPath,
        ...(root.scope === "project" ? { projectPath: root.projectPath } : {}),
      });
    }
  }

  const pluginCacheRoot = path.join(codexHome, "plugins", "cache");
  let pluginManifestCheckCount = 0;
  let pluginSkillsRootCount = 0;
  const seenPluginManifests = new Set();
  const appendPluginSkill = async (skillDirectory) => {
    const manifestPath = path.join(skillDirectory, "SKILL.md");
    if (manifestPath.length > MAX_SKILL_PATH_CHARS) {
      addWarning(`${manifestPath.slice(0, 120)}: pathが長すぎるため読み飛ばしました`);
      return true;
    }
    const manifestKey = process.platform === "win32" ? manifestPath.toLowerCase() : manifestPath;
    if (seenPluginManifests.has(manifestKey)) return true;
    seenPluginManifests.add(manifestKey);
    if (manifestCount >= MAX_SKILL_MANIFESTS) {
      addWarning(`manifest数が上限${MAX_SKILL_MANIFESTS}件に達しました`);
      return false;
    }
    manifestCount += 1;
    const skill = await readSkillManifest(manifestPath, addWarning);
    if (!skill) return true;
    if (returnedChars + skill.name.length + skill.description.length > MAX_SKILL_TOTAL_RETURN_CHARS) {
      addWarning(`返却テキストが上限${MAX_SKILL_TOTAL_RETURN_CHARS}文字に達しました`);
      return false;
    }
    returnedChars += skill.name.length + skill.description.length;
    skills.push({ name: skill.name, description: skill.description, scope: "plugin", path: manifestPath });
    return true;
  };
  const marketplaces = await listImmediateDirectories(
    pluginCacheRoot,
    MAX_PLUGIN_ENTRIES_PER_DIRECTORY,
    MAX_PLUGIN_MARKETPLACES,
  );
  for (const marketplacePath of marketplaces) {
    const pluginPaths = await listImmediateDirectories(
      marketplacePath,
      MAX_PLUGIN_ENTRIES_PER_DIRECTORY,
      MAX_PLUGIN_PLUGINS_PER_MARKETPLACE,
    );
    for (const pluginPath of pluginPaths) {
      const versionPaths = await listImmediateDirectories(
        pluginPath,
        MAX_PLUGIN_ENTRIES_PER_DIRECTORY,
        MAX_PLUGIN_VERSIONS_PER_PLUGIN,
      );
      for (const versionPath of versionPaths) {
        if (totalEntryCount >= MAX_SKILL_TOTAL_ENTRIES) {
          warnTotalEntryCap();
          return { skills, warnings };
        }

        if (pluginManifestCheckCount >= MAX_PLUGIN_MANIFEST_CHECKS) {
          addWarning(`plugin manifest pathの確認数が上限${MAX_PLUGIN_MANIFEST_CHECKS}件に達しました`);
          return { skills, warnings };
        }
        pluginManifestCheckCount += 1;
        const rootManifestPath = path.join(versionPath, "plugin.json");
        let pluginManifest = await readPluginSkillsManifest(rootManifestPath, addWarning);
        let skillsManifestPath = rootManifestPath;
        if (!pluginManifest.exists) {
          if (pluginManifestCheckCount >= MAX_PLUGIN_MANIFEST_CHECKS) {
            addWarning(`plugin manifest pathの確認数が上限${MAX_PLUGIN_MANIFEST_CHECKS}件に達しました`);
            return { skills, warnings };
          }
          pluginManifestCheckCount += 1;
          skillsManifestPath = path.join(versionPath, ".codex-plugin", "plugin.json");
          pluginManifest = await readPluginSkillsManifest(skillsManifestPath, addWarning);
        }

        const rawSkillsPaths = pluginManifest.skillsSpecified ? pluginManifest.paths : ["./skills/"];
        const skillsRoots = [];
        for (const rawSkillsPath of rawSkillsPaths) {
          if (pluginSkillsRootCount >= MAX_PLUGIN_SKILL_ROOTS) {
            addWarning(`plugin skills root数が上限${MAX_PLUGIN_SKILL_ROOTS}件に達しました`);
            return { skills, warnings };
          }
          pluginSkillsRootCount += 1;
          const skillsRoot = pluginManifest.skillsSpecified
            ? resolvePluginSkillsPath(versionPath, skillsManifestPath, rawSkillsPath, addWarning)
            : path.join(versionPath, "skills");
          if (skillsRoot) skillsRoots.push(skillsRoot);
        }
        const seenSkillsRoots = new Set();
        const uniqueSkillsRoots = skillsRoots.filter((skillsRoot) => {
          const rootKey = process.platform === "win32" ? skillsRoot.toLowerCase() : skillsRoot;
          if (seenSkillsRoots.has(rootKey)) return false;
          seenSkillsRoots.add(rootKey);
          return true;
        });

        for (const skillsPath of uniqueSkillsRoots) {
          if (totalEntryCount >= MAX_SKILL_TOTAL_ENTRIES) {
            warnTotalEntryCap();
            return { skills, warnings };
          }

          if (skillsPath.length > MAX_SKILL_PATH_CHARS) {
            addWarning(`${skillsPath.slice(0, 120)}: pathが長すぎるため読み飛ばしました`);
            continue;
          }

          let skillsPathStatus;
          try {
            skillsPathStatus = await checkSkillDirectoryChain(skillsPath);
          } catch (error) {
            if (error?.code !== "ENOENT") addWarning(`${skillsPath}: ${describeSkillReadError(error)}`);
            else if (pluginManifest.skillsSpecified) addWarning(`${skillsPath}: manifestが指定するskills pathが見つかりません`);
            continue;
          }
          if (!skillsPathStatus.valid) {
            const reason = skillsPathStatus.reason === "symlink"
              ? "シンボリックリンクまたはreparse pointを含むため読み飛ばしました"
              : "ディレクトリではないため読み飛ばしました";
            addWarning(`${skillsPathStatus.path}: ${reason}`);
            continue;
          }

          const rootManifest = path.join(skillsPath, "SKILL.md");
          try {
            await fs.promises.lstat(rootManifest);
            if (!await appendPluginSkill(skillsPath)) return { skills, warnings };
          } catch (error) {
            if (error?.code !== "ENOENT") addWarning(`${rootManifest}: ${describeSkillReadError(error)}`);
          }

          const skillDirectories = await listImmediateDirectories(
            skillsPath,
            MAX_PLUGIN_ENTRIES_PER_DIRECTORY,
            MAX_PLUGIN_SKILLS_PER_VERSION,
          );
          for (const skillDirectory of skillDirectories) {
            if (!await appendPluginSkill(skillDirectory)) return { skills, warnings };
          }
        }
      }
    }
  }

  return { skills, warnings };
}
function shellQuote(value, kind) {
  const text = String(value);
  if (kind === "powershell") return "'" + text.replace(/'/g, "''") + "'";
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

function powershellLiteral(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function resolvePowerShellBinary() {
  return resolveOnPath("pwsh.exe") || resolveOnPath("pwsh") || resolveOnPath("powershell.exe") || resolveOnPath("powershell") || path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function ensureSessionHooks(session) {
  if (!notifyUrl || !notifyToken) return null;
  try {
    const safeId = Buffer.from(session.id, "utf8").toString("base64url") || "session";
    const hookDirectory = path.join(app.getPath("userData"), "hooks", safeId);
    const hookScript = path.join(__dirname, "notify-hook.cjs");
    fs.mkdirSync(hookDirectory, { recursive: true });

    let wrapperPath;
    let codexNotifyArgs;
    let claudeHookCommand;
    let buildClaudeHookArgs;
    if (process.platform === "win32") {
      wrapperPath = path.join(hookDirectory, "notify-wrapper.ps1");
      const wrapper = [
        "$ErrorActionPreference = 'SilentlyContinue'",
        "$env:ELECTRON_RUN_AS_NODE = '1'",
        `try { & ${powershellLiteral(process.execPath)} ${powershellLiteral(hookScript)} @args 2>$null | Out-Null } catch {}`,
        "exit 0",
        "",
      ].join("\r\n");
      fs.writeFileSync(wrapperPath, wrapper, { encoding: "utf8" });
      const powershell = resolvePowerShellBinary();
      const powershellPrefix = ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", wrapperPath];
      codexNotifyArgs = [powershell, ...powershellPrefix, "codex"];
      claudeHookCommand = powershell;
      buildClaudeHookArgs = (event) => [...powershellPrefix, "claude", event];
    } else {
      wrapperPath = path.join(hookDirectory, "notify-wrapper.sh");
      const wrapper = [
        "#!/bin/sh",
        `ELECTRON_RUN_AS_NODE=1 exec ${shellQuote(process.execPath, "posix")} ${shellQuote(hookScript, "posix")} \"$@\"`,
        "",
      ].join("\n");
      fs.writeFileSync(wrapperPath, wrapper, { encoding: "utf8", mode: 0o700 });
      fs.chmodSync(wrapperPath, 0o700);
      codexNotifyArgs = [wrapperPath, "codex"];
      claudeHookCommand = wrapperPath;
      buildClaudeHookArgs = (event) => ["claude", event];
    }

    const settingsPath = path.join(hookDirectory, "claude-settings.json");
    const claudeHook = (event) => ({ hooks: [{ type: "command", command: claudeHookCommand, args: buildClaudeHookArgs(event), timeout: 2 }] });
    const settings = {
      hooks: {
        UserPromptSubmit: [claudeHook("running")],
        Stop: [claudeHook("completed")],
        Notification: ["permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]
          .map((matcher) => ({ matcher, ...claudeHook("approval") })),
      },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { encoding: "utf8", mode: 0o600 });
    try { fs.chmodSync(settingsPath, 0o600); } catch {}
    return { settingsPath, codexNotifyArgs };
  } catch (error) {
    console.warn("セッション専用hookを作成できませんでした:", error?.message || error);
    return null;
  }
}

function resolveCliCommand(cli) {
  const override = cli === "codex" ? process.env.CIMLINE_CODEX_CMD : process.env.CIMLINE_CLAUDE_CMD;
  if (override && override.trim()) return { file: override.trim(), args: [] };
  if (cli === "codex") {
    const codexScript = resolveCodexScript();
    if (codexScript) return { file: getNodeBinary(), args: [codexScript] };
    return { file: "codex", args: [] };
  }
  return { file: "claude", args: [] };
}

function isCliAvailable(cli) {
  const command = resolveCliCommand(cli);
  if (resolveOnPath(command.file)) return true;
  return cli === "codex" && command.args.length > 0 && fs.existsSync(command.args[0]);
}

function getShellInfo() {
  if (process.platform === "win32") {
    const override = process.env.CIMLINE_SHELL?.trim();
    const shellPath = override
      ? resolveOnPath(override) || override
      : resolveOnPath("pwsh.exe") || resolveOnPath("pwsh") || resolveOnPath("powershell.exe") || path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const baseName = path.basename(shellPath).toLowerCase();
    return { file: shellPath, args: ["-NoLogo", "-NoExit"], kind: /^(pwsh|powershell)(\.exe)?$/.test(baseName) ? "powershell" : "posix" };
  }
  const override = process.env.CIMLINE_SHELL?.trim();
  const shellPath = override || process.env.SHELL || (fs.existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/bash");
  return { file: shellPath, args: ["-l"], kind: "posix" };
}

function buildLaunchCommand(session, resume, shellKind, hooks) {
  const cli = resolveCliCommand(session.cli);
  const args = [...cli.args];
  if (session.cli === "codex" && hooks?.codexNotifyArgs?.length) {
    args.push("-c", "notify=" + JSON.stringify(hooks.codexNotifyArgs));
  } else if (session.cli === "claude" && hooks?.settingsPath) {
    args.push("--settings", hooks.settingsPath);
  }
  if (resume) args.push(...(session.cli === "codex" ? ["resume", "--last"] : ["--continue"]));
  const command = [shellQuote(cli.file, shellKind), ...args.map((argument) => shellQuote(argument, shellKind))].join(" ");
  const directory = shellQuote(session.cwd, shellKind);
  if (shellKind === "powershell") return "Set-Location -LiteralPath " + directory + "; & " + command;
  return "cd -- " + directory + " && " + command;
}

function appendPtyBuffer(session, data) {
  const combined = session.buffer + data;
  const bytes = Buffer.from(combined, "utf8");
  if (bytes.byteLength <= MAX_PTY_BUFFER_BYTES) {
    session.buffer = combined;
    session.bufferBytes = bytes.byteLength;
  } else {
    session.buffer = bytes.subarray(bytes.byteLength - MAX_PTY_BUFFER_BYTES).toString("utf8").replace(/^\uFFFD/, "");
    session.bufferBytes = Buffer.byteLength(session.buffer, "utf8");
  }
  session.sequence += 1;
}

function sendPtyEvent(channel, payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function detectNonEmptyEnter(session, data) {
  let line = session.inputLine || "";
  let submitted = false;
  for (let index = 0; index < data.length; index += 1) {
    const character = data[index];
    if (character === "\r" || character === "\n") {
      if (line.trim()) submitted = true;
      line = "";
      if (character === "\r" && data[index + 1] === "\n") index += 1;
    } else if (character === "\u0008" || character === "\u007f") {
      line = line.slice(0, -1);
    } else if (character === "\u0003" || character === "\u0015") {
      line = "";
    } else if (character >= " " && character !== "\u007f") {
      line += character;
      if (line.length > MAX_INPUT_LINE_CHARS) line = line.slice(-MAX_INPUT_LINE_CHARS);
    }
  }
  session.inputLine = line;
  return submitted;
}

function startPty(session, resume = false) {
  const shell = getShellInfo();
  const hooks = ensureSessionHooks(session);
  const environment = { ...process.env, TERM: "xterm-256color" };
  if (notifyUrl && notifyToken) {
    environment.CIMLINE_SESSION_ID = session.id;
    environment.CIMLINE_NOTIFY_URL = notifyUrl;
    environment.CIMLINE_NOTIFY_TOKEN = notifyToken;
  }
  const terminal = pty.spawn(shell.file, shell.args, {
    name: "xterm-256color",
    cols: 100,
    rows: 28,
    cwd: session.cwd,
    env: environment,
  });
  livePtys.set(session.id, terminal);
  session.closed = false;
  session.status = "idle";
  session.statusAt = new Date().toISOString();
  session.unreviewed = false;
  session.inputLine = "";
  updateUnreviewedBadge();
  terminal.onData((data) => {
    if (!sessions.has(session.id)) return;
    appendPtyBuffer(session, data);
    sendPtyEvent("pty:data", { sessionId: session.id, data, sequence: session.sequence });
  });
  terminal.onExit(({ exitCode, signal }) => {
    livePtys.delete(session.id);
    const current = sessions.get(session.id);
    if (current) {
      current.closed = true;
      current.inputLine = "";
      setSessionStatus(current, "exited", { broadcast: false });
      broadcastSessions();
    }
    sendPtyEvent("pty:exit", { sessionId: session.id, exitCode, signal });
  });
  scheduleSessionSave();
  const launchCommand = buildLaunchCommand(session, resume, shell.kind, hooks);
  const startupTimer = setTimeout(() => {
    if (livePtys.get(session.id) === terminal) terminal.write(launchCommand + "\r");
  }, 180);
  startupTimer.unref?.();
  return terminal;
}

function readPosixDescendants(rootPid) {
  try {
    const output = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8", timeout: 3000, windowsHide: true });
    const children = new Map();
    for (const line of output.split(/\r?\n/)) {
      const match = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const ppid = Number(match[2]);
      if (!children.has(ppid)) children.set(ppid, []);
      children.get(ppid).push(pid);
    }
    const descendants = [];
    const visit = (parent) => {
      for (const child of children.get(parent) || []) { visit(child); descendants.push(child); }
    };
    visit(rootPid);
    return descendants;
  } catch {
    return [];
  }
}

function signalProcess(pid, signal) {
  try { process.kill(pid, signal); } catch (error) { if (error?.code !== "ESRCH") throw error; }
}

async function stopPtyTree(terminal) {
  if (!terminal) return;
  const pid = terminal.pid;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      let settled = false;
      let terminalKillTimer = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (terminalKillTimer) clearTimeout(terminalKillTimer);
        try { terminal.kill(); } catch {}
        resolve();
      };
      const taskkill = resolveOnPath("taskkill.exe") || "taskkill.exe";
      try {
        const child = execFile(taskkill, ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 1500 }, () => finish());
        child.once("spawn", () => {
          terminalKillTimer = setTimeout(() => {
            try { terminal.kill(); } catch {}
          }, 100);
        });
        child.once("error", finish);
      } catch {
        finish();
      }
    });
    return;
  }
  const descendants = readPosixDescendants(pid);
  for (const childPid of descendants) { try { signalProcess(childPid, "SIGTERM"); } catch {} }
  try { signalProcess(pid, "SIGTERM"); } catch {}
  await new Promise((resolve) => setTimeout(resolve, 2000));
  for (const childPid of descendants) { try { signalProcess(childPid, "SIGKILL"); } catch {} }
  try { signalProcess(pid, "SIGKILL"); } catch {}
  try { terminal.kill(); } catch {}
}

function validateDirectory(cwd) {
  if (typeof cwd !== "string" || !cwd.trim() || cwd.length > 32768 || !path.isAbsolute(cwd)) throw new Error("有効な作業フォルダーを選択してください。");
  const absolute = path.resolve(cwd);
  let stats;
  try { stats = fs.statSync(absolute); } catch { throw new Error("選択したフォルダーが見つかりません。"); }
  if (!stats.isDirectory()) throw new Error("作業フォルダーを指定してください。");
  return absolute;
}

function createSession(input) {
  const cwd = validateDirectory(input?.cwd);
  const cli = input?.cli === "codex" || input?.cli === "claude" ? input.cli : null;
  if (!cli) throw new Error("Claude CodeまたはCodexを選択してください。");
  const session = {
    id: randomUUID(),
    title: path.basename(cwd) || cwd,
    cwd,
    cli,
    closed: true,
    createdAt: new Date().toISOString(),
    status: "idle",
    statusAt: new Date().toISOString(),
    unreviewed: false,
    buffer: "",
    bufferBytes: 0,
    sequence: 0,
    inputLine: "",
  };
  sessions.set(session.id, session);
  try {
    startPty(session, false);
  } catch (error) {
    sessions.delete(session.id);
    throw new Error("ターミナルを起動できませんでした: " + (error?.message || error));
  }
  broadcastSessions();
  return serializeSession(session);
}

async function closeSession(sessionId) {
  const session = sessions.get(String(sessionId));
  if (!session) throw new Error("セッションが見つかりません。");
  session.closed = true;
  session.inputLine = "";
  setSessionStatus(session, "exited", { broadcast: false });
  scheduleSessionSave();
  const terminal = livePtys.get(session.id);
  if (terminal) await stopPtyTree(terminal);
  if (livePtys.get(session.id) === terminal) livePtys.delete(session.id);
  broadcastSessions();
  return serializeSession(session);
}

function reopenSession(sessionId) {
  const session = sessions.get(String(sessionId));
  if (!session) throw new Error("セッションが見つかりません。");
  if (livePtys.has(session.id)) return serializeSession(session);
  session.buffer = "";
  session.bufferBytes = 0;
  session.sequence = 0;
  session.inputLine = "";
  try {
    startPty(session, true);
  } catch (error) {
    session.closed = true;
    setSessionStatus(session, "exited", { broadcast: false });
    broadcastSessions();
    throw new Error("ターミナルを再開できませんでした: " + (error?.message || error));
  }
  broadcastSessions();
  return serializeSession(session);
}

function deleteSession(sessionId) {
  const session = sessions.get(String(sessionId));
  if (!session) return false;
  const terminal = livePtys.get(session.id);
  livePtys.delete(session.id);
  sessions.delete(session.id);
  if (focusedSessionId === session.id) focusedSessionId = null;
  try {
    const safeId = Buffer.from(session.id, "utf8").toString("base64url") || "session";
    fs.rmSync(path.join(app.getPath("userData"), "hooks", safeId), { recursive: true, force: true });
  } catch {}
  if (terminal) void stopPtyTree(terminal);
  updateUnreviewedBadge();
  broadcastSessions();
  return true;
}

function attachPty(sessionId) {
  const session = sessions.get(String(sessionId));
  if (!session) throw new Error("セッションが見つかりません。");
  return { buffer: session.buffer, sequence: session.sequence };
}

function writePty(sessionId, data) {
  const id = String(sessionId);
  const terminal = livePtys.get(id);
  if (!terminal) throw new Error("ターミナルは閉じています。");
  if (typeof data !== "string" || data.length > MAX_PTY_WRITE_CHARS) throw new Error("ターミナル入力が無効です。");
  terminal.write(data);
  const session = sessions.get(id);
  if (session && detectNonEmptyEnter(session, data)) setSessionStatus(session, "running");
  return true;
}

function resizePty(sessionId, columns, rows) {
  const terminal = livePtys.get(String(sessionId));
  if (!terminal) return false;
  const cols = Number.isInteger(columns) ? Math.min(500, Math.max(2, columns)) : null;
  const lines = Number.isInteger(rows) ? Math.min(300, Math.max(2, rows)) : null;
  if (cols === null || lines === null) throw new Error("ターミナルのサイズが無効です。");
  terminal.resize(cols, lines);
  return true;
}

function readClipboardText() {
  return clipboard.readText().slice(0, MAX_CLIPBOARD_CHARS);
}

function writeClipboardText(text) {
  if (typeof text !== "string" || text.length > MAX_CLIPBOARD_CHARS) throw new Error("クリップボードのテキストが無効です。");
  clipboard.writeText(text);
  return true;
}

function registerIpc() {
  ipcMain.handle("app:get-state", () => ({
    sessions: serializeSessions(),
    cliAvailable: { codex: isCliAvailable("codex"), claude: isCliAvailable("claude") },
    defaultDirectory: process.env.CIMLINE_DEFAULT_PROJECT || process.env.CODEX_DEFAULT_PROJECT || (app.isPackaged ? app.getPath("documents") : process.cwd()),
  }));
  ipcMain.handle("usage:get-rate-limits", () => getCodexRateLimits());
  ipcMain.handle("skills:list", (_event, projectPaths) => getSkills(projectPaths));
  ipcMain.handle("dialog:choose-folder", async () => {
    const options = {
      title: "作業フォルダーを選択",
      defaultPath: process.env.CIMLINE_DEFAULT_PROJECT || process.env.CODEX_DEFAULT_PROJECT || (app.isPackaged ? app.getPath("documents") : process.cwd()),
      properties: ["openDirectory", "createDirectory"],
    };
    const owner = BrowserWindow.getFocusedWindow();
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] || null;
  });
  ipcMain.handle("sessions:create", (_event, input) => createSession(input || {}));
  ipcMain.handle("sessions:close", (_event, id) => closeSession(id));
  ipcMain.handle("sessions:reopen", (_event, id) => reopenSession(id));
  ipcMain.handle("sessions:delete", (_event, id) => deleteSession(id));
  ipcMain.handle("sessions:focus", (_event, id) => focusSession(id));
  ipcMain.handle("pty:attach", (_event, id) => attachPty(id));
  ipcMain.handle("pty:write", (_event, id, data) => writePty(id, data));
  ipcMain.handle("pty:resize", (_event, id, columns, rows) => resizePty(id, columns, rows));
  ipcMain.handle("clipboard:read-text", () => readClipboardText());
  ipcMain.handle("clipboard:write-text", (_event, text) => writeClipboardText(text));
}

function isAppUrl(url) {
  try {
    const parsed = new URL(url);
    if (!app.isPackaged && process.argv.includes("--dev")) return parsed.origin === new URL(DEV_SERVER_URL).origin;
    if (parsed.protocol !== "file:") return false;
    return path.resolve(fileURLToPath(parsed)).toLowerCase() === path.resolve(app.getAppPath(), "dist", "index.html").toLowerCase();
  } catch {
    return false;
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 990,
    minHeight: 700,
    backgroundColor: "#11120f",
    title: "CimLine",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) shell.openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (!isAppUrl(url)) {
      event.preventDefault();
      if (url.startsWith("https://") || url.startsWith("http://")) shell.openExternal(url);
    }
  });
  if (!app.isPackaged && process.argv.includes("--dev")) window.loadURL(DEV_SERVER_URL);
  else window.loadFile(path.join(app.getAppPath(), "dist", "index.html"));
}

app.whenReady().then(async () => {
  loadPersistedSessions();
  try { await startNotifyServer(); }
  catch (error) { console.warn("状態通知サーバーを起動できませんでした:", error?.message || error); }
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", (event) => {
  if (quitFlushComplete) return;
  event.preventDefault();
  if (quitFlushStarted) return;
  quitFlushStarted = true;
  const stops = [...livePtys.values()].map((terminal) => stopPtyTree(terminal));
  livePtys.clear();
  for (const session of sessions.values()) {
    session.closed = true;
    session.inputLine = "";
    session.status = "exited";
    session.statusAt = new Date().toISOString();
    session.unreviewed = false;
  }
  updateUnreviewedBadge();
  stopNotifyServer();
  Promise.allSettled(stops)
    .then(() => flushSessionSave())
    .catch((error) => console.error("終了前にセッション履歴を保存できませんでした:", error))
    .finally(() => {
      quitFlushComplete = true;
      app.quit();
    });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
