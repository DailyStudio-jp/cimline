import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Activity,
  ArrowUpRight,
  Check,
  CircleDot,
  Clock3,
  Copy,
  Folder,
  FolderOpen,
  GitBranch,
  LayoutDashboard,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Terminal,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import type { CodexRateLimits, RunTask } from "@/vite-env";

type Project = { path: string; name: string };

const projectStorageKey = "codex-run-desk-projects";
const statusText: Record<RunTask["status"], string> = {
  running: "実行中",
  stopping: "停止中",
  completed: "完了",
  failed: "エラー",
  stopped: "停止",
};

function loadProjects(): Project[] {
  try {
    const value = JSON.parse(localStorage.getItem(projectStorageKey) || "[]");
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function getFolderName(folderPath: string) {
  const normalized = folderPath.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || normalized || "フォルダー";
}

function timeLabel(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("ja-JP", { hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function durationLabel(task: RunTask, now: number) {
  const start = new Date(task.startedAt).getTime();
  const end = task.endedAt ? new Date(task.endedAt).getTime() : now;
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}秒`;
  return `${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, "0")}秒`;
}

function shortText(value: string, length = 110) {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > length ? `${normalized.slice(0, length)}…` : normalized;
}

function numberLabel(value: number) {
  return new Intl.NumberFormat("ja-JP").format(value || 0);
}

function rateWindowLabel(windowMinutes: number | null) {
  if (!windowMinutes) return "利用枠";
  if (windowMinutes >= 10000) return "週間枠";
  if (windowMinutes >= 300) return `${Math.round(windowMinutes / 60)}時間枠`;
  if (windowMinutes >= 60) return `${Math.round(windowMinutes / 60)}時間枠`;
  return `${windowMinutes}分枠`;
}

function resetTimeLabel(timestamp: number | null) {
  if (!timestamp) return null;
  return new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp * 1000));
}

function terminalPrefix(kind: RunTask["logs"][number]["kind"]) {
  return ({ user: "you $", assistant: "codex ›", command: "$", activity: "tool ·", system: "·", notice: "!", error: "error:" } as Record<string, string>)[kind] || "·";
}

function statusBadge(task: RunTask) {
  return (
    <Badge variant="outline" className={`state-badge state-${task.status}`}>
      {task.status === "running" ? <span className="status-dot is-pulsing" /> : task.status === "completed" ? <Check size={11} /> : <span className="status-dot" />}
      {statusText[task.status]}
    </Badge>
  );
}

export default function App() {
  const [tasks, setTasks] = useState<RunTask[]>([]);
  const [folderPath, setFolderPath] = useState(() => loadProjects()[0]?.path || "F:\\cimline");
  const [prompt, setPrompt] = useState("");
  const [followup, setFollowup] = useState("");
  const [taskDrafts, setTaskDrafts] = useState<Record<string, string>>({});
  const [continuingTaskIds, setContinuingTaskIds] = useState<string[]>([]);
  const [useWorktree, setUseWorktree] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [projects, setProjects] = useState<Project[]>(loadProjects);
  const [cliAvailable, setCliAvailable] = useState<boolean | null>(null);
  const [rateLimits, setRateLimits] = useState<CodexRateLimits | null>(null);
  const [rateLimitsLoading, setRateLimitsLoading] = useState(false);
  const [rateLimitsError, setRateLimitsError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null);
  const [now, setNow] = useState(Date.now());
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const followupRef = useRef<HTMLTextAreaElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const composerDialogRef = useRef<HTMLDialogElement>(null);
  const detailsDialogRef = useRef<HTMLDialogElement>(null);
  const usageDialogRef = useRef<HTMLDialogElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rateLimitsRequest = useRef(false);

  useEffect(() => {
    const unsubscribe = window.codexDesk.onTasksUpdated(setTasks);
    window.codexDesk.getState().then((state) => {
      setTasks(state.tasks);
      setCliAvailable(state.cliAvailable);
      if (state.defaultDirectory && projects.length === 0) setFolderPath(state.defaultDirectory);
      if (state.tasks.length === 0) setComposerOpen(true);
    }).catch(() => { setCliAvailable(false); setComposerOpen(true); });
    return unsubscribe;
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => setFollowup(""), [selectedTaskId]);

  useEffect(() => {
    const dialog = composerDialogRef.current;
    if (!dialog) return;
    if (composerOpen && !dialog.open) {
      dialog.showModal();
      requestAnimationFrame(() => promptRef.current?.focus());
    } else if (!composerOpen && dialog.open) {
      dialog.close();
    }
  }, [composerOpen]);

  useEffect(() => {
    const dialog = detailsDialogRef.current;
    if (!dialog) return;
    const hasSelectedTask = tasks.some((task) => task.id === selectedTaskId);
    if (detailsOpen && hasSelectedTask && !dialog.open) dialog.showModal();
    else if ((!detailsOpen || !hasSelectedTask) && dialog.open) dialog.close();
  }, [detailsOpen, selectedTaskId, tasks]);

  useEffect(() => {
    const dialog = usageDialogRef.current;
    if (!dialog) return;
    if (usageOpen && !dialog.open) dialog.showModal();
    else if (!usageOpen && dialog.open) dialog.close();
  }, [usageOpen]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        if (document.activeElement === followupRef.current) {
          followupRef.current?.closest("form")?.requestSubmit();
          return;
        }
        const activeElement = document.activeElement;
        const activeForm = activeElement instanceof HTMLElement ? activeElement.closest("form") : null;
        if (activeForm && (activeForm.classList.contains("terminal-followup-form") || activeForm.closest(".composer-dialog"))) {
          activeForm.requestSubmit();
          return;
        }
        setComposerOpen(true);
      } else if (event.key === "/" && !(document.activeElement instanceof HTMLInputElement) && !(document.activeElement instanceof HTMLTextAreaElement)) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

  const sortedTasks = useMemo(() => [...tasks].sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()), [tasks]);
  const activeCount = tasks.filter((task) => task.status === "running" || task.status === "stopping").length;
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) || null;
  const usageTotals = tasks.reduce((total, task) => ({
    inputTokens: total.inputTokens + (task.usage?.inputTokens || 0),
    cachedInputTokens: total.cachedInputTokens + (task.usage?.cachedInputTokens || 0),
    outputTokens: total.outputTokens + (task.usage?.outputTokens || 0),
    totalTokens: total.totalTokens + (task.usage?.totalTokens || 0),
    turns: total.turns + (task.usage?.turns || 0),
  }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0 });
  const topUsageTasks = sortedTasks.filter((task) => (task.usage?.totalTokens || 0) > 0).slice(0, 5);
  const filteredTasks = sortedTasks.filter((task) => {
    const query = search.trim().toLowerCase();
    const matchesSearch = !query || [task.title, task.prompt, task.cwd].some((value) => value.toLowerCase().includes(query));
    return matchesSearch;
  });

  const rateWindows = rateLimits ? [rateLimits.primary, rateLimits.secondary].filter((window): window is NonNullable<typeof window> => Boolean(window)) : [];

  function notify(message: string, error = false) {
    setToast({ message, error });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3200);
  }

  function rememberProject(nextPath: string) {
    const next = [{ path: nextPath, name: getFolderName(nextPath) }, ...projects.filter((project) => project.path.toLowerCase() !== nextPath.toLowerCase())].slice(0, 7);
    setProjects(next);
    localStorage.setItem(projectStorageKey, JSON.stringify(next));
  }

  async function chooseFolder() {
    try {
      const selected = await window.codexDesk.chooseFolder();
      if (selected) setFolderPath(selected);
    } catch (error) {
      notify(error instanceof Error ? error.message : "フォルダーを選択できませんでした", true);
    }
  }

  async function submitTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!folderPath.trim() || !prompt.trim()) {
      notify("作業フォルダーと依頼文を入力してください", true);
      return;
    }
    setLoading(true);
    try {
      const task = await window.codexDesk.createTask({ cwd: folderPath.trim(), prompt: prompt.trim(), worktree: useWorktree });
      setTasks((current) => [task, ...current.filter((existing) => existing.id !== task.id)]);
      setSelectedTaskId(task.id);
      rememberProject(folderPath.trim());
      setPrompt("");
      setComposerOpen(false);
      notify("Codex CLI を起動しました");
    } catch (error) {
      notify(error instanceof Error ? error.message : "依頼を開始できませんでした", true);
    } finally {
      setLoading(false);
    }
  }

  async function stopTask(id: string) {
    try {
      const updated = await window.codexDesk.stopTask(id);
      setTasks((current) => current.map((task) => task.id === updated.id ? updated : task));
      notify("停止をリクエストしました");
    } catch (error) {
      notify(error instanceof Error ? error.message : "停止できませんでした", true);
    }
  }

  async function continueTask(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedTask || !followup.trim()) return;
    setLoading(true);
    try {
      const updated = await window.codexDesk.continueTask(selectedTask.id, followup.trim());
      setTasks((current) => current.map((task) => task.id === updated.id ? updated : task));
      setFollowup("");
      notify("同じ会話で依頼を続けました");
    } catch (error) {
      notify(error instanceof Error ? error.message : "会話を続けられませんでした", true);
    } finally {
      setLoading(false);
    }
  }

  async function continueTerminalTask(taskId: string, event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const task = tasks.find((candidate) => candidate.id === taskId);
    const draft = (taskDrafts[taskId] || "").trim();
    if (!task || !draft || !task.threadId || ["running", "stopping"].includes(task.status) || continuingTaskIds.includes(taskId)) return;

    setContinuingTaskIds((current) => current.includes(taskId) ? current : [...current, taskId]);
    try {
      const updated = await window.codexDesk.continueTask(taskId, draft);
      setTasks((current) => current.map((candidate) => candidate.id === updated.id ? updated : candidate));
      setTaskDrafts((current) => ({ ...current, [taskId]: "" }));
      notify("同じ会話で依頼を続けました");
    } catch (error) {
      notify(error instanceof Error ? error.message : "会話を続けられませんでした", true);
    } finally {
      setContinuingTaskIds((current) => current.filter((id) => id !== taskId));
    }
  }

  async function openUsage() {
    setUsageOpen(true);
    if (rateLimitsRequest.current) return;
    rateLimitsRequest.current = true;
    setRateLimitsLoading(true);
    setRateLimitsError(false);
    try {
      setRateLimits(await window.codexDesk.getRateLimits());
    } catch {
      setRateLimitsError(true);
    } finally {
      setRateLimitsLoading(false);
      rateLimitsRequest.current = false;
    }
  }

  async function deleteTask(id: string) {
    try {
      await window.codexDesk.deleteTask(id);
      setTasks((current) => current.filter((task) => task.id !== id));
      if (selectedTaskId === id) {
        setSelectedTaskId(null);
        setDetailsOpen(false);
      }
      notify("履歴から削除しました");
    } catch (error) {
      notify(error instanceof Error ? error.message : "履歴を削除できませんでした", true);
    }
  }

  async function copyFolder() {
    try {
      await navigator.clipboard.writeText(folderPath);
      notify("パスをコピーしました");
    } catch {
      notify("パスをコピーできませんでした", true);
    }
  }

  function openDetails(task: RunTask) {
    setSelectedTaskId(task.id);
    setDetailsOpen(true);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span>
          <span className="brand-copy"><strong>codex</strong><small>RUN DESK</small></span>
        </div>

        <Button variant="outline" className="sidebar-new" onClick={() => setComposerOpen(true)}>
          <Plus size={16} className="plus-icon" /><span>新しい依頼</span><kbd>CTRL ↵</kbd>
        </Button>

        <button className="sidebar-nav-item active" type="button" onClick={() => document.getElementById("overview")?.scrollIntoView({ behavior: "smooth" })}>
          <LayoutDashboard size={15} /><span>ターミナル</span>{activeCount > 0 && <span className="nav-count">{activeCount}</span>}
        </button>
        <button className="sidebar-nav-item" type="button" onClick={openUsage}>
          <Activity size={15} /><span>使用量</span>{usageTotals.totalTokens > 0 && <span className="nav-count">{numberLabel(usageTotals.totalTokens)}</span>}
        </button>

        <div className="recent-heading"><span className="sidebar-group-label">最近のフォルダー</span><span className="recent-dot" /></div>
        <div className="recent-projects">
          {projects.length === 0 ? <p className="recent-empty">依頼を実行すると<br />ここに表示されます</p> : projects.map((project) => (
            <button key={project.path} className={`recent-project ${folderPath === project.path ? "selected" : ""}`} type="button" title={project.path} onClick={() => setFolderPath(project.path)}>
              <Folder size={14} /><span>{project.name}</span>
            </button>
          ))}
        </div>

        <div className="sidebar-bottom">
          <div className="cli-state"><span className={`status-dot ${cliAvailable === false ? "offline" : "online"}`} /><span>{cliAvailable === null ? "CLIを確認中" : cliAvailable ? "Codex CLI 利用可能" : "Codex CLI が未検出"}</span></div>
          <p>履歴はアプリを閉じるとリセットされます</p>
        </div>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <div className="topbar-right">
            <label className="search-box"><Search size={14} /><input ref={searchRef} aria-label="依頼を検索" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="依頼を検索" /><kbd>/</kbd></label>
            <Badge variant="outline" className="connection-badge"><span className={`status-dot ${cliAvailable === false ? "offline" : "online"}`} />{cliAvailable ? "ローカル接続" : cliAvailable === false ? "CLI未検出" : "接続中"}</Badge>
          </div>
        </header>

        <main className="page-content terminal-only-content" id="overview">
          <section className="runs-section">
            <div className="terminal-grid">
                {filteredTasks.length > 0 ? filteredTasks.map((task) => {
                  const recentLogs = task.logs.slice(-8);
                  return <Card className="terminal-pane" key={task.id}>
                    <div className="terminal-titlebar">
                      <div className="terminal-lights"><i /><i /><i /></div>
                      <div className="terminal-context terminal-context-task">
                        <Terminal size={15} />
                        <div className="terminal-context-copy">
                          <strong className="terminal-context-title" title={task.title}>{task.title}</strong>
                          <div className="terminal-context-location">
                            <span className="terminal-context-path" title={task.cwd}>{task.cwd}</span>
                            <small className="terminal-context-mode">{task.worktree ? "worktree" : "workspace"}</small>
                          </div>
                        </div>
                      </div>
                      {statusBadge(task)}
                      <Button variant="ghost" size="icon-sm" className="terminal-context-details" title="実行詳細" aria-label="実行詳細" onClick={() => openDetails(task)}><ArrowUpRight size={14} /></Button>
                    </div>
                    <div className="terminal-screen">
                      <div className="terminal-initial-prompt"><span>codex@{getFolderName(task.cwd)}</span><b>$</b>{shortText(task.prompt, 150)}</div>
                      <div className="terminal-output">
                        {recentLogs.length ? recentLogs.map((log) => log.kind === "system" || log.kind === "command" ? (
                          <details key={log.id} className={`terminal-line terminal-line-${log.kind} terminal-line-collapsible`}>
                            <summary className="terminal-line-summary">
                              <span>{terminalPrefix(log.kind)}</span>
                              <p title={log.text}>{shortText(log.text, 180)}</p>
                            </summary>
                            <pre className="terminal-line-expanded">{log.text}</pre>
                          </details>
                        ) : <div key={log.id} className={`terminal-line terminal-line-${log.kind}`}><span>{terminalPrefix(log.kind)}</span><p>{log.text}</p></div>) : <div className="terminal-line terminal-line-system"><span>·</span><p>Codex CLI の応答を待っています…</p></div>}
                        {(task.status === "running" || task.status === "stopping") && <div className="terminal-line terminal-live"><span>·</span><p><i /></p></div>}
                      </div>
                    </div>
                    <form className="terminal-followup-form" onSubmit={(event) => continueTerminalTask(task.id, event)}>
                      <Textarea
                        className="terminal-followup-input"
                        value={taskDrafts[task.id] || ""}
                        onChange={(event) => setTaskDrafts((current) => ({ ...current, [task.id]: event.target.value }))}
                        rows={2}
                        maxLength={20000}
                        placeholder="このターミナルの会話に追加で依頼…"
                        aria-label={`${task.title}への追加依頼`}
                      />
                      <div className="terminal-followup-controls">
                        <span className="terminal-followup-hint">
                          {task.status === "running" || task.status === "stopping" ? "実行完了後に送信できます" : !task.threadId ? "会話IDを待っています" : "Ctrl + Enter で送信"}
                        </span>
                        <Button
                          type="submit"
                          size="sm"
                          className="terminal-followup-submit"
                          disabled={continuingTaskIds.includes(task.id) || task.status === "running" || task.status === "stopping" || !task.threadId || !(taskDrafts[task.id] || "").trim()}
                        >
                          {continuingTaskIds.includes(task.id) ? "送信中…" : "送信"}<ArrowUpRight size={13} />
                        </Button>
                      </div>
                    </form>
                    <div className="terminal-footer"><div><span><Clock3 size={11} />{durationLabel(task, now)}</span><i /><span><Activity size={11} />{numberLabel(task.usage?.totalTokens || 0)} tokens</span></div><div className="terminal-actions"><Button variant="ghost" size="sm" onClick={() => openDetails(task)}>詳細</Button>{task.status === "running" || task.status === "stopping" ? <Button variant="outline" size="sm" className="terminal-stop" onClick={() => stopTask(task.id)}><Square size={10} />停止</Button> : null}</div></div>
                  </Card>;
                }) : null}
            </div>
          </section>
        </main>
      </div>

      <dialog
        ref={composerDialogRef}
        className="run-dialog composer-dialog"
        aria-labelledby="composer-dialog-title"
        onCancel={(event) => { event.preventDefault(); setComposerOpen(false); }}
        onClose={() => setComposerOpen(false)}
        onClick={(event) => { if (event.target === event.currentTarget) setComposerOpen(false); }}
      >
        <Card className="dialog-card composer-dialog-card">
          <CardContent className="dialog-content">
            <div className="dialog-heading"><div><h2 id="composer-dialog-title">新しい依頼</h2><p>作業フォルダーとCodexへの依頼を入力。</p></div><Button variant="ghost" size="icon-sm" aria-label="閉じる" onClick={() => setComposerOpen(false)}><X size={16} /></Button></div>
            {cliAvailable === false && <div className="cli-warning">Codex CLI を見つけられません。Node.js と npm のグローバルインストールを確認してください。</div>}
            <form onSubmit={submitTask}>
              <label className="field-label" htmlFor="folder-path">作業フォルダー <span>必須</span></label>
              <div className="folder-field">
                <FolderOpen size={15} />
                <Input id="folder-path" value={folderPath} onChange={(event) => setFolderPath(event.target.value)} spellCheck={false} autoComplete="off" placeholder="例: F:\\projects\\my-app" className="folder-input" required />
                <Button variant="ghost" size="icon-sm" type="button" title="パスをコピー" aria-label="パスをコピー" onClick={copyFolder}><Copy size={14} /></Button>
                <Button variant="outline" size="sm" type="button" className="browse-button" onClick={chooseFolder}><FolderOpen size={13} />選択</Button>
              </div>
              <div className="field-label prompt-label"><label htmlFor="prompt-input">Codexへの依頼</label><span>具体的に書くほど正確です</span></div>
              <div className="prompt-field">
                <Textarea ref={promptRef} id="prompt-input" value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={5} maxLength={20000} placeholder="例: このプロジェクトの構成を確認して、READMEにセットアップ手順を追記してください。変更したファイルと内容を最後にまとめてください。" required />
                <div className="run-options"><label><input type="checkbox" checked={useWorktree} onChange={(event) => setUseWorktree(event.target.checked)} /><GitBranch size={12} /><span>Git worktreeで分離</span></label><small>並行実行時に作業フォルダーを分ける</small></div>
                <div className="prompt-footer"><span><ShieldCheck size={12} /> 現在のCLI設定で実行</span><Button type="submit" disabled={loading || cliAvailable === false} className="submit-button"><span>{loading ? "起動しています…" : "依頼を実行"}</span>{loading ? <LoaderCircle size={14} className="spin" /> : <ArrowUpRight size={15} />}</Button></div>
              </div>
            </form>
          </CardContent>
        </Card>
      </dialog>

      <dialog
        ref={detailsDialogRef}
        className="run-dialog details-dialog"
        aria-labelledby="details-dialog-title"
        onCancel={(event) => { event.preventDefault(); setDetailsOpen(false); }}
        onClose={() => setDetailsOpen(false)}
        onClick={(event) => { if (event.target === event.currentTarget) setDetailsOpen(false); }}
      >
        {selectedTask && <Card className="dialog-card details-dialog-card"><CardContent className="details-dialog-content">
          <div className="dialog-heading"><div><div className="section-kicker"><span>SESSION</span> TERMINAL DETAILS</div><h2 id="details-dialog-title">{selectedTask.title}</h2></div><Button variant="ghost" size="icon-sm" aria-label="閉じる" onClick={() => setDetailsOpen(false)}><X size={16} /></Button></div>
          <div className="detail-meta">{statusBadge(selectedTask)}<span>{timeLabel(selectedTask.startedAt)} · {durationLabel(selectedTask, now)}</span><span className="detail-token-count">{numberLabel(selectedTask.usage?.totalTokens || 0)} tokens</span></div>
          <div className="detail-path"><Folder size={13} /><span title={selectedTask.cwd}>{selectedTask.cwd}</span></div>
          <div className="detail-prompt"><span>最初の依頼</span><p>{selectedTask.prompt}</p></div>
          <div className="activity-title"><span>TERMINAL OUTPUT</span><Separator /><small>{selectedTask.logs.length} LINES</small></div>
          <div className="activity-list details-log-list">
            {selectedTask.logs.length ? selectedTask.logs.map((log) => <article className={`activity-item activity-${log.kind}`} key={log.id}><div className="activity-item-head"><span>{({ user: "YOU", assistant: "CODEX", activity: "ACTIVITY", command: "COMMAND", system: "SYSTEM", notice: "NOTICE", error: "ERROR" } as Record<string, string>)[log.kind] || "ACTIVITY"}</span><time>{timeLabel(log.at)}</time></div><p>{log.text}</p></article>) : <div className="activity-waiting"><LoaderCircle size={14} className="spin" />Codex の応答を待っています…</div>}
          </div>
          {selectedTask.threadId && <form className="followup-form" onSubmit={continueTask}>
            <label htmlFor="followup-input">会話を続ける</label>
            <Textarea ref={followupRef} id="followup-input" rows={2} maxLength={20000} value={followup} onChange={(event) => setFollowup(event.target.value)} placeholder="この会話の続きとして依頼できます…" disabled={selectedTask.status === "running" || selectedTask.status === "stopping"} />
            <div className="followup-footer"><span>{selectedTask.worktree ? "Git worktree の会話" : "同じCodex会話を続行"}</span><Button size="sm" type="submit" disabled={loading || !followup.trim() || selectedTask.status === "running" || selectedTask.status === "stopping"}>送信 <ArrowUpRight size={13} /></Button></div>
          </form>}
          <div className="detail-actions">{selectedTask.status === "running" || selectedTask.status === "stopping" ? <Button variant="outline" size="sm" className="danger-button" onClick={() => stopTask(selectedTask.id)}><Square size={11} />この依頼を停止</Button> : <Button variant="ghost" size="sm" onClick={() => deleteTask(selectedTask.id)}><Trash2 size={12} />履歴から削除</Button>}</div>
        </CardContent></Card>}
      </dialog>

      <dialog
        ref={usageDialogRef}
        className="run-dialog usage-dialog"
        aria-labelledby="usage-dialog-title"
        onCancel={(event) => { event.preventDefault(); setUsageOpen(false); }}
        onClose={() => setUsageOpen(false)}
        onClick={(event) => { if (event.target === event.currentTarget) setUsageOpen(false); }}
      >
        <Card className="dialog-card usage-dialog-card"><CardContent className="usage-content">
          <div className="dialog-heading"><div><h2 id="usage-dialog-title">使用量</h2></div><div className="usage-heading-actions"><Button variant="ghost" size="icon-sm" aria-label="利用枠を更新" title="利用枠を更新" onClick={openUsage} disabled={rateLimitsLoading}><RefreshCw size={15} className={rateLimitsLoading ? "spin" : ""} /></Button><Button variant="ghost" size="icon-sm" aria-label="閉じる" onClick={() => setUsageOpen(false)}><X size={16} /></Button></div></div>
          <section className="remaining-section">
            <div className="usage-section-heading"><h3>利用枠の残り</h3><span>Codexアカウント</span></div>
            {rateLimitsLoading && !rateLimits ? <div className="usage-empty">利用枠を取得しています…</div> : rateWindows.length ? <div className="rate-window-list">{rateWindows.map((window, index) => {
              const remaining = Math.max(0, Math.min(100, 100 - window.usedPercent));
              const resetAt = resetTimeLabel(window.resetsAt);
              return <div className="rate-window" key={`${window.windowDurationMins || "limit"}-${index}`}>
                <div className="rate-window-heading"><span>{rateWindowLabel(window.windowDurationMins)}</span><strong>{Math.round(remaining)}% <small>残り</small></strong></div>
                <div className="rate-window-track"><span style={{ width: `${remaining}%` }} /></div>
                {resetAt && <small className="rate-window-reset">リセット {resetAt}</small>}
              </div>;
            })}</div> : <div className="usage-empty">{rateLimitsError ? "利用枠を取得できませんでした。更新してください。" : "利用枠の情報はありません。"}</div>}
            <p className="usage-footnote">Codexが返す利用枠の残り割合です。正確な残りトークン数は取得できません。</p>
          </section>
          <Separator className="usage-separator" />
          <div className="usage-panel-heading"><div><h3>トークン使用量</h3></div><span className="usage-live-tag"><CircleDot size={10} /> このアプリ</span></div>
          <div className="usage-total"><strong>{numberLabel(usageTotals.totalTokens)}</strong><span>tokens</span><small>起動中の合計</small></div>
          <div className="usage-bar"><span className="usage-input-bar" style={{ width: `${usageTotals.totalTokens ? usageTotals.inputTokens / usageTotals.totalTokens * 100 : 0}%` }} /><span className="usage-output-bar" style={{ width: `${usageTotals.totalTokens ? usageTotals.outputTokens / usageTotals.totalTokens * 100 : 0}%` }} /></div>
          <div className="usage-legend"><span><i className="legend-input" />入力</span><span><i className="legend-output" />出力</span></div>
          <div className="usage-breakdown"><div><span>入力トークン</span><strong>{numberLabel(usageTotals.inputTokens)}</strong></div><div><span>出力トークン</span><strong>{numberLabel(usageTotals.outputTokens)}</strong></div><div><span>キャッシュ入力</span><strong>{numberLabel(usageTotals.cachedInputTokens)}</strong></div><div><span>完了ターン</span><strong>{numberLabel(usageTotals.turns)}</strong></div></div>
          <Separator className="usage-separator" />
          <div className="usage-runs-heading"><span>実行別</span><small>{topUsageTasks.length} SESSIONS</small></div>
          <div className="usage-run-list">{topUsageTasks.length ? topUsageTasks.map((task) => <div className="usage-run-row" key={task.id}><span title={task.title}>{getFolderName(task.cwd)}<small>{task.title}</small></span><strong>{numberLabel(task.usage.totalTokens)}</strong></div>) : <div className="usage-empty">実行後にトークン使用量が表示されます。</div>}</div>
          <div className="usage-footnote">CLIが各ターンで返したトークン数の合計です。</div>
        </CardContent></Card>
      </dialog>

      {toast && <div className={`toast ${toast.error ? "is-error" : ""}`} role="status">{toast.message}</div>}
    </div>
  );
}
