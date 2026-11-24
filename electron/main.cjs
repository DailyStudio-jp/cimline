const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

const tasks = new Map();
const MAX_LOGS = 100;
const MAX_LOG_TEXT = 8000;
const TASK_STORE_FILE = "tasks.json";
const TASK_SAVE_DEBOUNCE_MS = 300;
const APP_SERVER_REQUEST_TIMEOUT_MS = 30000;
const APP_SERVER_INTERRUPT_TIMEOUT_MS = 5000;
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

let taskStorePath = null;
let taskSaveTimer = null;
let taskWriteChain = Promise.resolve();
let taskPersistenceReady = false;
let quitFlushStarted = false;
let quitFlushComplete = false;
let codexStartupQueue = Promise.resolve();

function resolveCodexScript() {
  const appData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const candidates = [
    process.env.CODEX_CLI_JS,
    path.join(appData, "npm", "node_modules", "@openai", "codex", "bin", "codex.js"),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function serializeTask(task) {
  return {
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    cwd: task.cwd,
    worktree: task.worktree,
    runner: task.runner,
    usage: task.usage,
    status: task.status,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    threadId: task.threadId,
    exitCode: task.exitCode,
    logs: task.logs,
    closed: task.closed === true,
  };
}

function normalizePersistedUsage(usage) {
  const fields = [
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteInputTokens",
    "outputTokens",
    "reasoningOutputTokens",
    "totalTokens",
    "turns",
  ];
  const normalized = {};
  for (const field of fields) {
    const value = usage?.[field];
    normalized[field] = Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }
  return normalized;
}

function restoreTask(record) {
  if (!record || typeof record !== "object" || typeof record.id !== "string") return null;
  const allowedStatuses = new Set(["running", "stopping", "completed", "failed", "stopped"]);
  const savedStatus = allowedStatuses.has(record.status) ? record.status : "stopped";
  const wasActive = savedStatus === "running" || savedStatus === "stopping";
  const logs = Array.isArray(record.logs)
    ? record.logs
      .filter((log) => log && typeof log === "object" && typeof log.text === "string")
      .slice(-MAX_LOGS)
      .map((log) => ({
        id: typeof log.id === "string" ? log.id : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        kind: typeof log.kind === "string" ? log.kind : "notice",
        text: log.text.slice(0, MAX_LOG_TEXT),
        at: typeof log.at === "string" ? log.at : new Date().toISOString(),
      }))
    : [];
  const task = {
    id: record.id,
    title: typeof record.title === "string" ? record.title : "保存された依頼",
    prompt: typeof record.prompt === "string" ? record.prompt : "",
    cwd: typeof record.cwd === "string" ? record.cwd : "",
    worktree: record.worktree === true,
    usage: normalizePersistedUsage(record.usage),
    runner: record.runner === "app-server" || record.runner === "exec"
      ? record.runner
      : (record.worktree === true || Object.prototype.hasOwnProperty.call(process.env, "CODEX_API_KEY") ? "exec" : "app-server"),
    status: wasActive ? "stopped" : savedStatus,
    startedAt: typeof record.startedAt === "string" ? record.startedAt : new Date().toISOString(),
    endedAt: wasActive ? new Date().toISOString() : (typeof record.endedAt === "string" ? record.endedAt : null),
    threadId: typeof record.threadId === "string" ? record.threadId : null,
    exitCode: Number.isSafeInteger(record.exitCode) ? record.exitCode : null,
    logs,
    closed: record.closed === true,
    stdoutBuffer: "",
    stderrBuffer: "",
    stopRequested: false,
    child: null,
  };
  if (wasActive) {
    const reason = task.threadId
      ? "アプリ終了前に実行中だったため停止しました。保存済みのCodex会話から再開できます。"
      : "アプリ終了前に実行中だったため停止しました。Codex会話IDがないため、この依頼は続行できません。";
    task.logs.push({
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      kind: "system",
      text: reason,
      at: new Date().toISOString(),
    });
    if (task.logs.length > MAX_LOGS) task.logs.splice(0, task.logs.length - MAX_LOGS);
  }
  return task;
}

function scheduleTaskSave() {
  if (!taskPersistenceReady || !taskStorePath) return;
  if (taskSaveTimer) clearTimeout(taskSaveTimer);
  taskSaveTimer = setTimeout(() => {
    taskSaveTimer = null;
    queueTaskSave();
  }, TASK_SAVE_DEBOUNCE_MS);
  taskSaveTimer.unref?.();
}

function queueTaskSave() {
  if (!taskPersistenceReady || !taskStorePath) return taskWriteChain;
  const snapshot = {
    version: 1,
    tasks: [...tasks.values()].map(serializeTask),
  };
  const content = JSON.stringify(snapshot, null, 2);
  const write = async () => {
    const directory = path.dirname(taskStorePath);
    await fs.promises.mkdir(directory, { recursive: true });
    const tempPath = `${taskStorePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await fs.promises.writeFile(tempPath, content, "utf8");
      await fs.promises.rename(tempPath, taskStorePath);
    } catch (error) {
      await fs.promises.rm(tempPath, { force: true }).catch(() => {});
      throw error;
    }
  };
  taskWriteChain = taskWriteChain.catch(() => {}).then(write);
  taskWriteChain.catch((error) => console.error("タスク履歴の保存に失敗しました:", error));
  return taskWriteChain;
}

async function flushTaskSave() {
  if (taskSaveTimer) {
    clearTimeout(taskSaveTimer);
    taskSaveTimer = null;
  }
  await queueTaskSave();
  await taskWriteChain;
}

function loadPersistedTasks() {
  taskStorePath = path.join(app.getPath("userData"), TASK_STORE_FILE);
  const currentPathKey = path.resolve(taskStorePath).toLowerCase();
  const legacyPaths = ["Codex Run Desk", "codex-cli-run-desk"]
    .map((name) => path.join(app.getPath("appData"), name, TASK_STORE_FILE))
    .filter((candidate) => path.resolve(candidate).toLowerCase() !== currentPathKey);
  let contents = null;
  let loadedFromLegacyPath = false;
  try {
    contents = fs.readFileSync(taskStorePath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("タスク履歴を読み込めませんでした:", error);
    } else {
      for (const legacyPath of legacyPaths) {
        try {
          contents = fs.readFileSync(legacyPath, "utf8");
          loadedFromLegacyPath = true;
          break;
        } catch (legacyError) {
          if (legacyError.code !== "ENOENT") {
            console.error("旧アプリのタスク履歴を読み込めませんでした:", legacyError);
          }
        }
      }
    }
  }
  let recoveredActiveTask = false;
  if (contents !== null) {
    try {
    const saved = JSON.parse(contents);
    const records = Array.isArray(saved) ? saved : saved?.tasks;
    if (Array.isArray(records)) {
      for (const record of records) {
        const task = restoreTask(record);
        if (!task) continue;
        if (record.status === "running" || record.status === "stopping") recoveredActiveTask = true;
        tasks.set(task.id, task);
      }
    }
    } catch (error) {
      console.error("タスク履歴を読み込めませんでした:", error);
    }
  }
  taskPersistenceReady = true;
  if (recoveredActiveTask || loadedFromLegacyPath) scheduleTaskSave();
}

function broadcastTasks() {
  const snapshot = [...tasks.values()].map(serializeTask);
  scheduleTaskSave();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("tasks:updated", snapshot);
  }
}

function acquireCodexStartupLock() {
  let releaseGate;
  const gate = new Promise((resolve) => {
    releaseGate = resolve;
  });
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

function releaseTaskStartupLock(task) {
  if (!task?.startupLockRelease) return;
  const release = task.startupLockRelease;
  task.startupLockRelease = null;
  release();
}

function appendLog(task, kind, text) {
  const message = String(text || "").trim();
  if (!message) return;
  task.logs.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    kind,
    text: message.slice(0, MAX_LOG_TEXT),
    at: new Date().toISOString(),
  });
  if (task.logs.length > MAX_LOGS) task.logs.splice(0, task.logs.length - MAX_LOGS);
  broadcastTasks();
}

function extractItemText(item) {
  if (!item || typeof item !== "object") return "";
  if (item.type === "agent_message") return item.text || "";
  if (item.type === "command_execution") {
    const command = Array.isArray(item.command) ? item.command.join(" ") : item.command;
    const output = item.aggregated_output || item.output || "";
    return [command ? `$ ${command}` : "コマンドを実行", output].filter(Boolean).join("\n");
  }
  if (item.type === "file_change") {
    return (item.changes || []).map((change) => `${change.kind || "変更"}: ${change.path || ""}`).join("\n") || "ファイルを変更しました";
  }
  if (item.type === "mcp_tool_call") {
    const result = item.result || item.arguments || item.tool || "ツールを実行しました";
    return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  }
  return item.text || "";
}

function readUsageCount(usage, snakeCaseKey, camelCaseKey) {
  const value = usage?.[snakeCaseKey] ?? usage?.[camelCaseKey];
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeTurnUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;

  const inputTokens = readUsageCount(usage, "input_tokens", "inputTokens");
  const cachedInputTokens = readUsageCount(usage, "cached_input_tokens", "cachedInputTokens");
  const cacheWriteInputTokens = readUsageCount(usage, "cache_write_input_tokens", "cacheWriteInputTokens");
  const outputTokens = readUsageCount(usage, "output_tokens", "outputTokens");
  const reasoningOutputTokens = readUsageCount(usage, "reasoning_output_tokens", "reasoningOutputTokens");
  const totalTokens = readUsageCount(usage, "total_tokens", "totalTokens");

  const counts = [inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningOutputTokens, totalTokens];
  if (counts.every((value) => value === null) || counts.every((value) => value === null || value === 0)) {
    return null;
  }

  return {
    inputTokens: inputTokens ?? 0,
    cachedInputTokens: cachedInputTokens ?? 0,
    cacheWriteInputTokens: cacheWriteInputTokens ?? 0,
    outputTokens: outputTokens ?? 0,
    reasoningOutputTokens: reasoningOutputTokens ?? 0,
    totalTokens: totalTokens ?? ((inputTokens ?? 0) + (outputTokens ?? 0)),
  };
}

function consumeCliEvent(task, line) {
  if (!line.trim()) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    appendLog(task, "notice", line);
    return;
  }

  if (event.type === "thread.started" && event.thread_id) {
    task.threadId = event.thread_id;
    broadcastTasks();
  }
  if (event.type === "turn.started") appendLog(task, "system", "Codex が作業を始めました");
  if (event.type === "turn.started") releaseTaskStartupLock(task);
  if (event.type === "item.started" && event.item?.type === "command_execution") {
    const command = Array.isArray(event.item.command) ? event.item.command.join(" ") : event.item.command;
    if (command) appendLog(task, "system", `コマンド実行中: ${command}`);
  }
  if (event.type === "item.completed") {
    const item = event.item || {};
    const text = extractItemText(item);
    if (text) appendLog(task, item.type === "agent_message" ? "assistant" : item.type === "command_execution" ? "command" : "activity", text);
  }
  if (event.type === "turn.completed") appendLog(task, "system", "この依頼の応答が完了しました");
  if (event.type === "turn.completed") {
    task.usage.turns += 1;
    const usage = normalizeTurnUsage(event.usage);
    if (usage) {
      // Codex exec --json reports the thread's accumulated usage in turn.completed.
      // Assign the reported snapshot so resumed turns do not count earlier turns twice.
      task.usage.inputTokens = usage.inputTokens;
      task.usage.cachedInputTokens = usage.cachedInputTokens;
      task.usage.cacheWriteInputTokens = usage.cacheWriteInputTokens;
      task.usage.outputTokens = usage.outputTokens;
      task.usage.reasoningOutputTokens = usage.reasoningOutputTokens;
      task.usage.totalTokens = usage.totalTokens;
    } else {
      appendLog(task, "notice", "Codex CLI の完了イベントにトークン数が含まれていません");
    }
    broadcastTasks();
  }
  if (event.type === "turn.failed" || event.type === "error") {
    appendLog(task, "error", event.message || event.error?.message || "Codex CLI がエラーを返しました");
  }
}

function requireCodexScript() {
  const scriptPath = resolveCodexScript();
  if (!scriptPath) {
    throw new Error("Codex CLI の場所を確認できません。Node.js と npm のグローバルインストールを確認するか、CODEX_CLI_JS に codex.js のパスを設定してください。");
  }
  return scriptPath;
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

async function getCodexRateLimits() {
  const scriptPath = requireCodexScript();
  const nodeBinary = process.env.CODEX_NODE_EXE || (process.platform === "win32" ? "node.exe" : "node");
  const releaseStartup = await acquireCodexStartupLock();

  return new Promise((resolve, reject) => {
    let settled = false;
    let initialized = false;
    let stdoutBuffer = "";
    let startupReleased = false;
    let child;
    const releaseStartupOnce = () => {
      if (startupReleased) return;
      startupReleased = true;
      releaseStartup();
    };
    try {
      child = spawn(nodeBinary, [scriptPath, "app-server", "--stdio"], {
        cwd: app.getPath("home"),
        env: process.env,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch (error) {
      releaseStartupOnce();
      reject(error);
      return;
    }

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      releaseStartupOnce();
      if (error) reject(error);
      else resolve(result);
      child?.kill();
    };
    const send = (message) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
        return true;
      } catch (error) {
        finish(new Error(`Codex app-serverへ接続できませんでした: ${error.message}`));
        return false;
      }
    };
    const timeout = setTimeout(() => finish(new Error("Codexの利用枠情報の取得がタイムアウトしました。")), 15000);

    child.on("error", (error) => finish(new Error(`Codex app-serverを起動できませんでした: ${error.message}`)));
    child.on("close", (code) => {
      if (!settled) finish(new Error(`Codex app-serverが応答前に終了しました (終了コード ${code ?? "不明"})。`));
    });
    child.stdin.on("error", (error) => finish(new Error(`Codex app-serverへ接続できませんでした: ${error.message}`)));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }

        if (message.id === 1) {
          if (message.error) {
            finish(new Error(message.error.message || "Codex app-serverの初期化に失敗しました。"));
            return;
          }
          if (!initialized) {
            initialized = true;
            releaseStartupOnce();
            send({ method: "initialized", params: {} });
            send({ id: 2, method: "account/rateLimits/read", params: {} });
          }
          continue;
        }

        if (message.id !== 2) continue;
        if (message.error) {
          finish(new Error(message.error.message || "Codexの利用枠情報を取得できませんでした。"));
          return;
        }
        const snapshot = message.result?.rateLimits ?? message.result?.rate_limits;
        if (!snapshot) {
          finish(new Error("Codexから利用枠情報が返されませんでした。"));
          return;
        }
        finish(null, {
          primary: normalizeRateLimitWindow(snapshot.primary),
          secondary: normalizeRateLimitWindow(snapshot.secondary),
        });
        return;
      }
    });

    send({
      id: 1,
      method: "initialize",
      params: { clientInfo: { name: "cimline", title: "CimLine", version: app.getVersion() } },
    });
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

function markTaskStartupFailure(task, error) {
  releaseTaskStartupLock(task);
  task.status = task.stopRequested ? "stopped" : "failed";
  task.endedAt = new Date().toISOString();
  if (!task.stopRequested) appendLog(task, "error", error?.message || String(error));
  broadcastTasks();
}

function readProtocolTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function updateThreadTokenUsage(task, tokenUsage) {
  if (!tokenUsage || typeof tokenUsage !== "object") return;
  const total = tokenUsage.total;
  const fields = [
    ["inputTokens", "inputTokens"],
    ["cachedInputTokens", "cachedInputTokens"],
    ["cacheWriteInputTokens", "cacheWriteInputTokens"],
    ["outputTokens", "outputTokens"],
    ["reasoningOutputTokens", "reasoningOutputTokens"],
    ["totalTokens", "totalTokens"],
  ];
  for (const [taskField, usageField] of fields) {
    const value = readProtocolTokenCount(total?.[usageField]);
    if (value !== null) task.usage[taskField] = value;
  }

  broadcastTasks();
}

function extractAppServerItemText(item) {
  if (!item || typeof item !== "object") return "";
  const type = item.type;
  if (type === "agentMessage" || type === "agent_message") return item.text || "";
  if (type === "commandExecution" || type === "command_execution") {
    const command = Array.isArray(item.command) ? item.command.join(" ") : item.command;
    const output = item.aggregatedOutput || item.aggregated_output || item.output || "";
    return [command ? `$ ${command}` : "コマンドを実行", output].filter(Boolean).join("\n");
  }
  if (type === "fileChange" || type === "file_change") {
    return (item.changes || []).map((change) => `${change.kind || "変更"}: ${change.path || ""}`).join("\n") || "ファイルを変更しました";
  }
  if (type === "mcpToolCall" || type === "mcp_tool_call") {
    const result = item.result || item.arguments || item.tool || "ツールを実行しました";
    return typeof result === "string" ? result : JSON.stringify(result, null, 2);
  }
  return item.text || "";
}

function terminateChildProcess(child) {
  if (!child) return;
  if (process.platform === "win32" && child.pid) {
    execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], (error) => {
      if (error) child.kill();
    });
  } else {
    child.kill("SIGTERM");
  }
}

function launchCodexExec(task, prompt, { resume = false, releaseStartup }) {
  const scriptPath = requireCodexScript();
  const nodeBinary = process.env.CODEX_NODE_EXE || (process.platform === "win32" ? "node.exe" : "node");
  const args = resume
    ? [scriptPath, "exec", "--json", "--skip-git-repo-check", "resume", "--all", task.threadId, "-"]
    : [scriptPath, "exec", "--json", "--skip-git-repo-check", ...(task.worktree ? ["--worktree"] : []), "-C", task.cwd, "-"];
  const child = spawn(nodeBinary, args, {
    cwd: task.cwd,
    env: process.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  task.child = child;
  task.appServerMode = false;
  task.stdoutBuffer = "";
  task.stderrBuffer = "";
  task.startupLockRelease = releaseStartup;
  broadcastTasks();
  appendLog(task, "system", resume ? "会話を再開しました" : "Codex CLI を起動しました");

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    task.stdoutBuffer += chunk;
    const lines = task.stdoutBuffer.split(/\r?\n/);
    task.stdoutBuffer = lines.pop() || "";
    for (const line of lines) consumeCliEvent(task, line);
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    task.stderrBuffer += chunk;
    const lines = task.stderrBuffer.split(/\r?\n/);
    task.stderrBuffer = lines.pop() || "";
    for (const line of lines) appendLog(task, "notice", line);
  });
  child.on("error", (error) => {
    releaseTaskStartupLock(task);
    task.status = "failed";
    task.endedAt = new Date().toISOString();
    appendLog(task, "error", error.message);
    broadcastTasks();
  });
  child.on("close", (code) => {
    if (task.child !== child) return;
    releaseTaskStartupLock(task);
    if (task.stdoutBuffer.trim()) consumeCliEvent(task, task.stdoutBuffer);
    if (task.stderrBuffer.trim()) appendLog(task, "notice", task.stderrBuffer);
    task.exitCode = code;
    if (task.stopRequested) {
      task.status = "stopped";
    } else {
      task.status = code === 0 ? "completed" : "failed";
      if (code !== 0) appendLog(task, "error", `Codex CLI が終了コード ${code} で終了しました`);
    }
    task.endedAt = new Date().toISOString();
    broadcastTasks();
  });
  child.stdin.on("error", () => {});
  child.stdin.end(prompt);
}

function launchCodexAppServer(task, prompt, { resume = false, releaseStartup }) {
  const scriptPath = requireCodexScript();
  const nodeBinary = process.env.CODEX_NODE_EXE || (process.platform === "win32" ? "node.exe" : "node");
  const child = spawn(nodeBinary, [scriptPath, "app-server", "--stdio"], {
    cwd: task.cwd,
    env: process.env,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdoutBuffer = "";
  let requestId = 1;
  let turnStartSent = false;
  let settledTurn = false;
  const pendingRequests = new Map();
  let resolveExit;
  task.appServerExitPromise = new Promise((resolve) => {
    resolveExit = resolve;
  });
  task.appServerMode = true;
  task.appServerTurnId = null;
  task.appServerTurnFinished = false;
  task.appServerRequest = null;
  task.child = child;
  task.startupLockRelease = releaseStartup;
  broadcastTasks();
  appendLog(task, "system", resume ? "Codex app-serverで保存済み会話を再開しました" : "Codex app-serverを起動しました");

  const send = (message) => {
    if (child.stdin.destroyed || child.stdin.writableEnded) throw new Error("Codex app-serverへの接続が閉じています。");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = requestId++;
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Codex app-serverの${method}がタイムアウトしました。`));
    }, APP_SERVER_REQUEST_TIMEOUT_MS);
    pendingRequests.set(id, { resolve, reject, timer, method });
    try {
      send({ id, method, params });
    } catch (error) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      reject(error);
    }
  });
  task.appServerRequest = request;

  const clearPending = (error) => {
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    pendingRequests.clear();
  };
  const startupTimeout = setTimeout(() => {
    if (task.child !== child || task.appServerTurnFinished) return;
    appendLog(task, "error", "Codex app-serverの初期化がタイムアウトしました。");
    terminateChildProcess(child);
  }, APP_SERVER_REQUEST_TIMEOUT_MS * 2);
  const releaseStartupOnce = () => {
    clearTimeout(startupTimeout);
    releaseTaskStartupLock(task);
  };
  const finishTurn = (turn) => {
    if (settledTurn) return;
    settledTurn = true;
    task.appServerTurnFinished = true;
    releaseStartupOnce();
    clearTimeout(task.appServerInterruptTimer);
    task.appServerInterruptTimer = null;
    const status = turn?.status;
    const errorText = turn?.error?.message || turn?.error?.codexErrorInfo || "Codex app-serverのターンが失敗しました。";
    if (task.stopRequested || status === "interrupted") {
      task.status = "stopped";
      task.exitCode = null;
    } else if (status === "completed") {
      task.status = "completed";
      task.exitCode = 0;
    } else {
      task.status = "failed";
      task.exitCode = 1;
      appendLog(task, "error", errorText);
    }
    task.endedAt = new Date().toISOString();
    task.usage.turns += 1;
    appendLog(task, "system", status === "completed" ? "この依頼の応答が完了しました" : task.status === "stopped" ? "Codexの作業を停止しました" : "Codexの作業が失敗しました");
    broadcastTasks();
    try {
      child.stdin.end();
    } catch {}
  };

  const handleMessage = (message) => {
    if (message && typeof message.method === "string" && message.id !== undefined && message.id !== null) {
      appendLog(task, "notice", `Codex app-serverの要求「${message.method}」は自動承認せず拒否しました`);
      try {
        send({ id: message.id, error: { code: -32601, message: "CimLine does not handle interactive approval requests" } });
      } catch {}
      return;
    }

    if (message?.id !== undefined && message.id !== null) {
      const pending = pendingRequests.get(message.id);
      if (!pending) return;
      pendingRequests.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || `Codex app-serverの${pending.method}に失敗しました。`));
      else pending.resolve(message.result || {});
      return;
    }

    const params = message?.params || {};
    if (message?.method === "thread/started") {
      const id = params.thread?.id || params.threadId;
      if (id) task.threadId = id;
      broadcastTasks();
    } else if (message?.method === "turn/started") {
      task.appServerTurnId = params.turn?.id || task.appServerTurnId;
      appendLog(task, "system", "Codex が作業を始めました");
      releaseStartupOnce();
    } else if (message?.method === "thread/tokenUsage/updated") {
      updateThreadTokenUsage(task, params.tokenUsage || params.token_usage);
    } else if (message?.method === "item/started") {
      const item = params.item?.payload || params.item || {};
      if (item.type === "commandExecution" || item.type === "command_execution") {
        const command = Array.isArray(item.command) ? item.command.join(" ") : item.command;
        if (command) appendLog(task, "system", `コマンド実行中: ${command}`);
      }
    } else if (message?.method === "item/completed") {
      const item = params.item?.payload || params.item || {};
      const text = extractAppServerItemText(item);
      if (text) appendLog(task, item.type === "agentMessage" || item.type === "agent_message" ? "assistant" : item.type === "commandExecution" || item.type === "command_execution" ? "command" : "activity", text);
    } else if (message?.method === "turn/completed") {
      finishTurn(params.turn || params);
    } else if (message?.method === "error") {
      const errorText = params.error?.message || params.message;
      if (errorText) appendLog(task, "error", errorText);
    }
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        handleMessage(JSON.parse(line));
      } catch (error) {
        appendLog(task, "notice", `Codex app-serverの応答を読み取れませんでした: ${error.message}`);
      }
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => appendLog(task, "notice", chunk));
  child.stdin.on("error", () => {});
  child.on("error", (error) => {
    clearTimeout(startupTimeout);
    releaseStartupOnce();
    clearPending(error);
    if (task.child === child) {
      task.child = null;
      task.appServerMode = false;
      markTaskStartupFailure(task, error);
    }
  });
  child.on("close", (code) => {
    clearTimeout(startupTimeout);
    releaseStartupOnce();
    clearPending(new Error("Codex app-serverが終了しました。"));
    clearTimeout(task.appServerInterruptTimer);
    task.appServerInterruptTimer = null;
    if (task.child === child) {
      task.child = null;
      task.appServerMode = false;
      task.appServerRequest = null;
      task.appServerTurnId = null;
      if (!task.appServerTurnFinished) {
        task.exitCode = code;
        task.status = task.stopRequested ? "stopped" : "failed";
        task.endedAt = new Date().toISOString();
        if (!task.stopRequested) appendLog(task, "error", `Codex app-server がターン完了前に終了しました (終了コード ${code ?? "不明"})。`);
      }
      broadcastTasks();
    }
    resolveExit?.();
  });

  const start = async () => {
    await request("initialize", {
      clientInfo: { name: "cimline", title: "CimLine", version: app.getVersion() },
      capabilities: { experimentalApi: true },
    });
    send({ method: "initialized", params: {} });
    const threadResponse = resume
      ? await request("thread/resume", { threadId: task.threadId })
      : await request("thread/start", {});
    const threadId = threadResponse.thread?.id || threadResponse.threadId;
    if (!task.threadId && !threadId) throw new Error("Codex app-serverから会話IDが返されませんでした。");
    if (threadId) task.threadId = threadId;
    const reviewer = threadResponse.approvalsReviewer ?? threadResponse.approvals_reviewer;
    if (typeof reviewer !== "string") throw new Error("Codex app-serverの承認設定を確認できず、安全に開始できません。");
    broadcastTasks();

    const turnParams = {
      threadId: task.threadId,
      input: [{ type: "text", text: prompt }],
    };
    // `codex exec` uses the configured reviewer unless it is auto_review;
    // in that case it forces headless approval to never. The workspace policy remains config-derived.
    if (reviewer !== "auto_review") turnParams.approvalPolicy = "never";
    turnStartSent = true;
    const turnResponse = await request("turn/start", turnParams);
    task.appServerTurnId = turnResponse.turn?.id || task.appServerTurnId;
  };
  start().catch((error) => {
    if (!turnStartSent || !task.appServerTurnId) appendLog(task, "error", error.message || String(error));
    releaseStartupOnce();
    clearTimeout(startupTimeout);
    terminateChildProcess(child);
  });
}

function runCodexProcess(task, prompt, { resume = false } = {}) {
  acquireCodexStartupLock().then((releaseStartup) => {
    if (task.stopRequested || task.status !== "running") {
      releaseStartup();
      return;
    }
    task.startupLockRelease = releaseStartup;
    try {
      if (task.runner === "app-server") {
        launchCodexAppServer(task, prompt, { resume, releaseStartup });
      } else {
        launchCodexExec(task, prompt, { resume, releaseStartup });
      }
    } catch (error) {
      releaseStartup();
      markTaskStartupFailure(task, error);
    }
  }).catch((error) => markTaskStartupFailure(task, error));
}

function startTask(input) {
  const prompt = String(input.prompt || "").trim();
  const rawCwd = String(input.cwd || "").trim();
  if (!prompt) throw new Error("依頼文を入力してください。");
  if (prompt.length > 20000) throw new Error("依頼文は20,000文字以内で入力してください。");
  if (!rawCwd) throw new Error("作業フォルダーを入力してください。");
  const cwd = path.resolve(rawCwd);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error("作業フォルダーが見つからないか、フォルダーではありません。");
  requireCodexScript();

  const task = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: String(input.title || prompt.replace(/\s+/g, " ").slice(0, 64)),
    prompt,
    cwd,
    worktree: input.worktree === true,
    runner: input.worktree === true || Object.prototype.hasOwnProperty.call(process.env, "CODEX_API_KEY") ? "exec" : "app-server",
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      totalTokens: 0,
      turns: 0,
    },
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    threadId: null,
    exitCode: null,
    logs: [],
    closed: false,
    stdoutBuffer: "",
    stderrBuffer: "",
    stopRequested: false,
    child: null,
  };
  tasks.set(task.id, task);
  runCodexProcess(task, prompt);
  return serializeTask(task);
}

async function continueTask(taskId, rawPrompt) {
  const task = tasks.get(String(taskId));
  if (!task) throw new Error("実行が見つかりません。");
  if (["running", "stopping"].includes(task.status)) throw new Error("実行が完了してから会話を続けてください。");
  if (!task.threadId) throw new Error("Codex の会話IDがまだ受信されていません。");
  const prompt = String(rawPrompt || "").trim();
  if (!prompt) throw new Error("追加の依頼文を入力してください。");
  if (prompt.length > 20000) throw new Error("依頼文は20,000文字以内で入力してください。");
  requireCodexScript();
  if (task.appServerExitPromise) await task.appServerExitPromise;

  task.status = "running";
  task.endedAt = null;
  task.exitCode = null;
  task.stopRequested = false;
  appendLog(task, "user", prompt);
  runCodexProcess(task, prompt, { resume: true });
  return serializeTask(task);
}

function stopTask(task, { force = false } = {}) {
  if (!task || !["running", "stopping"].includes(task.status)) return serializeTask(task);
  task.stopRequested = true;
  task.status = "stopping";
  appendLog(task, "system", "停止しています…");
  if (task.appServerMode && task.child && !force && task.appServerRequest && task.threadId && task.appServerTurnId) {
    task.appServerRequest("turn/interrupt", { threadId: task.threadId, turnId: task.appServerTurnId }).catch(() => {});
    clearTimeout(task.appServerInterruptTimer);
    task.appServerInterruptTimer = setTimeout(() => terminateChildProcess(task.child), APP_SERVER_INTERRUPT_TIMEOUT_MS);
  } else if (task.child) {
    terminateChildProcess(task.child);
  } else {
    releaseTaskStartupLock(task);
    task.status = "stopped";
    task.endedAt = new Date().toISOString();
  }
  broadcastTasks();
  return serializeTask(task);
}

function setTaskClosed(taskId, closed) {
  const task = tasks.get(String(taskId));
  if (!task) throw new Error("実行が見つかりません。");
  task.closed = closed;
  broadcastTasks();
  return serializeTask(task);
}

function registerIpc() {
  ipcMain.handle("app:get-state", () => ({
    tasks: [...tasks.values()].map(serializeTask),
    cliAvailable: Boolean(resolveCodexScript()),
    defaultDirectory: process.env.CODEX_DEFAULT_PROJECT || (app.isPackaged ? app.getPath("documents") : process.cwd()),
  }));

  ipcMain.handle("usage:get-rate-limits", () => getCodexRateLimits());
  ipcMain.handle("skills:list", (_event, projectPaths) => getSkills(projectPaths));

  ipcMain.handle("dialog:choose-folder", async () => {
    const options = {
      title: "作業フォルダーを選択",
      defaultPath: process.env.CODEX_DEFAULT_PROJECT || (app.isPackaged ? app.getPath("documents") : process.cwd()),
      properties: ["openDirectory", "createDirectory"],
    };
    const owner = BrowserWindow.getFocusedWindow();
    const result = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : result.filePaths[0] || null;
  });

  ipcMain.handle("tasks:create", (_event, input) => startTask(input || {}));
  ipcMain.handle("tasks:continue", (_event, id, prompt) => continueTask(id, prompt));
  ipcMain.handle("tasks:stop", (_event, id) => {
    const task = tasks.get(String(id));
    if (!task) throw new Error("実行が見つかりません。");
    return stopTask(task);
  });
  ipcMain.handle("tasks:stop-all", () => {
    for (const task of tasks.values()) stopTask(task);
    return true;
  });
  ipcMain.handle("tasks:close", (_event, id) => setTaskClosed(id, true));
  ipcMain.handle("tasks:reopen", (_event, id) => setTaskClosed(id, false));
  ipcMain.handle("tasks:delete", (_event, id) => {
    const task = tasks.get(String(id));
    if (!task) return false;
    if (["running", "stopping"].includes(task.status)) throw new Error("実行中の依頼は削除できません。");
    tasks.delete(task.id);
    broadcastTasks();
    return true;
  });
}

function isAppUrl(url) {
  try {
    const parsed = new URL(url);
    if (!app.isPackaged && process.argv.includes("--dev")) return parsed.origin === "http://127.0.0.1:5173";
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

  if (!app.isPackaged && process.argv.includes("--dev")) window.loadURL("http://127.0.0.1:5173");
  else window.loadFile(path.join(app.getAppPath(), "dist", "index.html"));
}

app.whenReady().then(() => {
  loadPersistedTasks();
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
  for (const task of tasks.values()) stopTask(task, { force: true });
  flushTaskSave()
    .catch((error) => console.error("終了前にタスク履歴を保存できませんでした:", error))
    .finally(() => {
      quitFlushComplete = true;
      app.quit();
    });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
