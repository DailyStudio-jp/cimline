const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const { spawn, execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

const tasks = new Map();
const MAX_LOGS = 100;
const MAX_LOG_TEXT = 8000;

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
    usage: task.usage,
    status: task.status,
    startedAt: task.startedAt,
    endedAt: task.endedAt,
    threadId: task.threadId,
    exitCode: task.exitCode,
    logs: task.logs,
  };
}

function broadcastTasks() {
  const snapshot = [...tasks.values()].map(serializeTask);
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("tasks:updated", snapshot);
  }
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

function consumeCliEvent(task, line) {
  if (!line.trim()) return;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    appendLog(task, "notice", line);
    return;
  }

  if (event.type === "thread.started" && event.thread_id) task.threadId = event.thread_id;
  if (event.type === "turn.started") appendLog(task, "system", "Codex が作業を始めました");
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
  if (event.type === "turn.completed" && event.usage) {
    const usage = event.usage;
    task.usage.inputTokens += Number(usage.input_tokens || 0);
    task.usage.cachedInputTokens += Number(usage.cached_input_tokens || 0);
    task.usage.cacheWriteInputTokens += Number(usage.cache_write_input_tokens || 0);
    task.usage.outputTokens += Number(usage.output_tokens || 0);
    task.usage.reasoningOutputTokens += Number(usage.reasoning_output_tokens || 0);
    task.usage.totalTokens = task.usage.inputTokens + task.usage.outputTokens;
    task.usage.turns += 1;
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

function getCodexRateLimits() {
  const scriptPath = requireCodexScript();
  const nodeBinary = process.env.CODEX_NODE_EXE || (process.platform === "win32" ? "node.exe" : "node");

  return new Promise((resolve, reject) => {
    let settled = false;
    let initialized = false;
    let stdoutBuffer = "";
    const child = spawn(nodeBinary, [scriptPath, "app-server", "--stdio"], {
      cwd: app.getPath("home"),
      env: process.env,
      windowsHide: true,
      stdio: ["pipe", "pipe", "ignore"],
    });

    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result);
      child.kill();
    };
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
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
      params: { clientInfo: { name: "codex-cli-run-desk", title: "Codex Run Desk", version: app.getVersion() } },
    });
  });
}

function runCodexProcess(task, prompt, { resume = false } = {}) {
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
  task.stdoutBuffer = "";
  task.stderrBuffer = "";
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
    task.status = "failed";
    task.endedAt = new Date().toISOString();
    appendLog(task, "error", error.message);
    broadcastTasks();
  });
  child.on("close", (code) => {
    if (task.child !== child) return;
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
    usage: { inputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0, turns: 0 },
    status: "running",
    startedAt: new Date().toISOString(),
    endedAt: null,
    threadId: null,
    exitCode: null,
    logs: [],
    stdoutBuffer: "",
    stderrBuffer: "",
    stopRequested: false,
    child: null,
  };
  tasks.set(task.id, task);
  runCodexProcess(task, prompt);
  return serializeTask(task);
}

function continueTask(taskId, rawPrompt) {
  const task = tasks.get(String(taskId));
  if (!task) throw new Error("実行が見つかりません。");
  if (["running", "stopping"].includes(task.status)) throw new Error("実行が完了してから会話を続けてください。");
  if (!task.threadId) throw new Error("Codex の会話IDがまだ受信されていません。");
  const prompt = String(rawPrompt || "").trim();
  if (!prompt) throw new Error("追加の依頼文を入力してください。");
  if (prompt.length > 20000) throw new Error("依頼文は20,000文字以内で入力してください。");
  requireCodexScript();

  task.status = "running";
  task.endedAt = null;
  task.exitCode = null;
  task.stopRequested = false;
  appendLog(task, "user", prompt);
  runCodexProcess(task, prompt, { resume: true });
  return serializeTask(task);
}

function stopTask(task) {
  if (!task || !["running", "stopping"].includes(task.status)) return serializeTask(task);
  task.stopRequested = true;
  task.status = "stopping";
  appendLog(task, "system", "停止しています…");
  if (process.platform === "win32" && task.child?.pid) {
    execFile("taskkill.exe", ["/PID", String(task.child.pid), "/T", "/F"], (error) => {
      if (error) task.child?.kill();
    });
  } else {
    task.child?.kill("SIGTERM");
  }
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
    title: "Codex Run Desk",
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
  registerIpc();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("before-quit", () => {
  for (const task of tasks.values()) stopTask(task);
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
