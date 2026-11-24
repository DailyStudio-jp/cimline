import { useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent, type FormEvent } from "react";
import {
  Activity,
  ArrowDown,
  ArrowUpRight,
  Check,
  CircleDot,
  Copy,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  GitBranch,
  LayoutDashboard,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
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
type SkillItem = { name: string; description: string; scope: "user" | "project" | "system" | "plugin" | "codex-home"; path: string; projectPath?: string };

const projectStorageKey = "codex-run-desk-projects";
const taskOrderStorageKey = "codex-run-desk-task-order";
const reviewedTaskStorageKey = "codex-run-desk-reviewed-tasks";
const operationalLogVisibilityStorageKey = "codex-run-desk-operational-log-visibility";
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

function loadStoredIds(key: string): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function loadOperationalLogVisibility(): Record<string, boolean> {
  try {
    const value = JSON.parse(localStorage.getItem(operationalLogVisibilityStorageKey) || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
  } catch {
    return {};
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
  return ({ user: "あなた", assistant: "Codex", command: "コマンド", activity: "操作", system: "状態", notice: "通知", error: "エラー" } as Record<string, string>)[kind] || "ログ";
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
  const [tasksInitialized, setTasksInitialized] = useState(false);
  const [taskOrder, setTaskOrder] = useState<string[]>(() => loadStoredIds(taskOrderStorageKey));
  const [reviewedTaskIds, setReviewedTaskIds] = useState<string[]>(() => loadStoredIds(reviewedTaskStorageKey));
  const [operationalLogVisibility, setOperationalLogVisibility] = useState<Record<string, boolean>>(loadOperationalLogVisibility);
  const [autoFollowByTask, setAutoFollowByTask] = useState<Record<string, boolean>>({});
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dropTargetTaskId, setDropTargetTaskId] = useState<string | null>(null);
  const [folderPath, setFolderPath] = useState(() => loadProjects()[0]?.path || "F:\\cimline");
  const [prompt, setPrompt] = useState("");
  const [followup, setFollowup] = useState("");
  const [taskDrafts, setTaskDrafts] = useState<Record<string, string>>({});
  const [continuingTaskIds, setContinuingTaskIds] = useState<string[]>([]);
  const [useWorktree, setUseWorktree] = useState(false);
  const [composerOpen, setComposerOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [skillWarnings, setSkillWarnings] = useState<string[]>([]);
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
  const skillsDialogRef = useRef<HTMLDialogElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rateLimitsRequest = useRef(false);
  const draggedTaskId = useRef<string | null>(null);
  const dragAutoScrollFrame = useRef<number | null>(null);
  const dragAutoScrollState = useRef<{ container: HTMLElement | Window; direction: -1 | 1; speed: number } | null>(null);
  const terminalOutputRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const terminalScrollMetrics = useRef<Record<string, { scrollTop: number; scrollHeight: number; clientHeight: number }>>({});

  useEffect(() => {
    const unsubscribe = window.codexDesk.onTasksUpdated(setTasks);
    window.codexDesk.getState().then((state) => {
      setTasks(state.tasks);
      setTasksInitialized(true);
      setCliAvailable(state.cliAvailable);
      if (state.defaultDirectory && projects.length === 0) setFolderPath(state.defaultDirectory);
      if (state.tasks.length === 0) setComposerOpen(true);
    }).catch(() => { setCliAvailable(false); setTasksInitialized(true); setComposerOpen(true); });
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
    const dialog = skillsDialogRef.current;
    if (!dialog) return;
    if (skillsOpen && !dialog.open) dialog.showModal();
    else if (!skillsOpen && dialog.open) dialog.close();
  }, [skillsOpen]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.altKey && !event.shiftKey) {
        if (document.activeElement === promptRef.current && loading) return;
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
  }, [loading]);

  useEffect(() => () => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    stopTaskAutoScroll();
  }, []);

  useEffect(() => {
    if (!tasksInitialized) return;
    const currentIds = new Set(tasks.map((task) => task.id));
    const keptOrder = taskOrder.filter((id) => currentIds.has(id));
    const addedOrder = tasks
      .filter((task) => !keptOrder.includes(task.id))
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
      .map((task) => task.id);
    const nextOrder = [...keptOrder, ...addedOrder];
    if (nextOrder.length !== taskOrder.length || nextOrder.some((id, index) => id !== taskOrder[index])) {
      setTaskOrder(nextOrder);
      localStorage.setItem(taskOrderStorageKey, JSON.stringify(nextOrder));
    }

    const nextReviewedIds = reviewedTaskIds.filter((id) => currentIds.has(id));
    if (nextReviewedIds.length !== reviewedTaskIds.length) {
      setReviewedTaskIds(nextReviewedIds);
      localStorage.setItem(reviewedTaskStorageKey, JSON.stringify(nextReviewedIds));
    }

    const nextOperationalLogVisibility = Object.fromEntries(Object.entries(operationalLogVisibility).filter(([id]) => currentIds.has(id)));
    if (Object.keys(nextOperationalLogVisibility).length !== Object.keys(operationalLogVisibility).length) {
      setOperationalLogVisibility(nextOperationalLogVisibility);
      localStorage.setItem(operationalLogVisibilityStorageKey, JSON.stringify(nextOperationalLogVisibility));
    }
  }, [tasks, tasksInitialized, taskOrder, reviewedTaskIds, operationalLogVisibility]);

  useEffect(() => {
    for (const task of tasks) {
      if (autoFollowByTask[task.id] === false) continue;
      const output = terminalOutputRefs.current[task.id];
      if (output) output.scrollTop = output.scrollHeight;
    }
  }, [tasks, autoFollowByTask, operationalLogVisibility]);

  const sortedTasks = useMemo(() => {
    const orderIndex = new Map(taskOrder.map((id, index) => [id, index] as const));
    return [...tasks].sort((a, b) => {
      const aIndex = orderIndex.get(a.id);
      const bIndex = orderIndex.get(b.id);
      if (aIndex !== undefined && bIndex !== undefined) return aIndex - bIndex;
      if (aIndex !== undefined) return -1;
      if (bIndex !== undefined) return 1;
      return new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime();
    });
  }, [tasks, taskOrder]);
  const activeCount = tasks.filter((task) => task.status === "running" || task.status === "stopping").length;
  const selectedTask = tasks.find((task) => task.id === selectedTaskId) || null;
  const usageTotals = tasks.reduce((total, task) => ({
    inputTokens: total.inputTokens + (task.usage?.inputTokens || 0),
    cachedInputTokens: total.cachedInputTokens + (task.usage?.cachedInputTokens || 0),
    outputTokens: total.outputTokens + (task.usage?.outputTokens || 0),
    totalTokens: total.totalTokens + (task.usage?.totalTokens || 0),
    turns: total.turns + (task.usage?.turns || 0),
  }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0, turns: 0 });
  const filteredTasks = sortedTasks.filter((task) => {
    const query = search.trim().toLowerCase();
    const matchesSearch = !query || [task.title, task.prompt, task.cwd].some((value) => value.toLowerCase().includes(query));
    return matchesSearch;
  });
  const visibleTasks = filteredTasks.filter((task) => !task.closed);

  const rateWindows = rateLimits
    ? [rateLimits.primary, rateLimits.secondary]
        .filter((window): window is NonNullable<typeof window> => Boolean(window))
        .sort((left, right) => (left.windowDurationMins ?? Number.MAX_SAFE_INTEGER) - (right.windowDurationMins ?? Number.MAX_SAFE_INTEGER))
    : [];

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

  function saveTaskOrder(nextOrder: string[]) {
    setTaskOrder(nextOrder);
    localStorage.setItem(taskOrderStorageKey, JSON.stringify(nextOrder));
  }

  function toggleOperationalLogs(taskId: string, currentVisibility: boolean) {
    const next = { ...operationalLogVisibility, [taskId]: !currentVisibility };
    setOperationalLogVisibility(next);
    localStorage.setItem(operationalLogVisibilityStorageKey, JSON.stringify(next));
  }

  function clearTaskDrag() {
    stopTaskAutoScroll();
    draggedTaskId.current = null;
    setDraggingTaskId(null);
    setDropTargetTaskId(null);
  }

  function stopTaskAutoScroll() {
    dragAutoScrollState.current = null;
    if (dragAutoScrollFrame.current !== null) {
      cancelAnimationFrame(dragAutoScrollFrame.current);
      dragAutoScrollFrame.current = null;
    }
  }

  function findTaskScrollContainer(start: HTMLElement): HTMLElement | Window {
    let element = start.parentElement;
    while (element && element !== document.body && element !== document.documentElement) {
      const overflowY = getComputedStyle(element).overflowY;
      if ((overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay") && element.scrollHeight > element.clientHeight + 1) return element;
      element = element.parentElement;
    }
    return window;
  }

  function runTaskAutoScrollFrame() {
    const state = dragAutoScrollState.current;
    if (!state) {
      dragAutoScrollFrame.current = null;
      return;
    }

    const position = state.container === window ? window.scrollY : state.container.scrollTop;
    const maxPosition = state.container === window
      ? Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
      : Math.max(0, state.container.scrollHeight - state.container.clientHeight);
    if ((state.direction < 0 && position <= 0) || (state.direction > 0 && position >= maxPosition)) {
      stopTaskAutoScroll();
      return;
    }

    if (state.container === window) window.scrollBy(0, state.direction * state.speed);
    else state.container.scrollTop += state.direction * state.speed;
    dragAutoScrollFrame.current = requestAnimationFrame(() => runTaskAutoScrollFrame());
  }

  function updateTaskAutoScroll(event: ReactDragEvent<HTMLDivElement>) {
    const container = findTaskScrollContainer(event.currentTarget);
    const bounds = container === window ? { top: 0, bottom: window.innerHeight } : container.getBoundingClientRect();
    const edgeSize = Math.min(84, Math.max(42, (bounds.bottom - bounds.top) * 0.14));
    let direction: -1 | 1 | 0 = 0;
    let proximity = 0;
    if (event.clientY < bounds.top + edgeSize) {
      direction = -1;
      proximity = (bounds.top + edgeSize - event.clientY) / edgeSize;
    } else if (event.clientY > bounds.bottom - edgeSize) {
      direction = 1;
      proximity = (event.clientY - (bounds.bottom - edgeSize)) / edgeSize;
    }

    if (!direction) {
      stopTaskAutoScroll();
      return;
    }

    const position = container === window ? window.scrollY : container.scrollTop;
    const maxPosition = container === window
      ? Math.max(0, document.documentElement.scrollHeight - window.innerHeight)
      : Math.max(0, container.scrollHeight - container.clientHeight);
    if ((direction < 0 && position <= 0) || (direction > 0 && position >= maxPosition)) {
      stopTaskAutoScroll();
      return;
    }

    dragAutoScrollState.current = { container, direction, speed: Math.max(3, Math.ceil(Math.min(1, proximity) * 18)) };
    if (dragAutoScrollFrame.current === null) dragAutoScrollFrame.current = requestAnimationFrame(() => runTaskAutoScrollFrame());
  }

  function startTaskDrag(taskId: string, event: ReactDragEvent<HTMLDivElement>) {
    stopTaskAutoScroll();
    draggedTaskId.current = taskId;
    setDraggingTaskId(taskId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", taskId);
  }

  function handleTaskDrop(taskId: string, event: ReactDragEvent<HTMLDivElement>) {
    event.preventDefault();
    const sourceId = draggedTaskId.current || event.dataTransfer.getData("text/plain");
    if (!sourceId || sourceId === taskId) {
      clearTaskDrag();
      return;
    }

    const nextOrder = sortedTasks.map((task) => task.id);
    const sourceIndex = nextOrder.indexOf(sourceId);
    const targetIndex = nextOrder.indexOf(taskId);
    if (sourceIndex < 0 || targetIndex < 0) {
      clearTaskDrag();
      return;
    }

    const [movingId] = nextOrder.splice(sourceIndex, 1);
    const bounds = event.currentTarget.getBoundingClientRect();
    let insertionIndex = targetIndex + (event.clientY >= bounds.top + bounds.height / 2 ? 1 : 0);
    if (sourceIndex < insertionIndex) insertionIndex -= 1;
    nextOrder.splice(insertionIndex, 0, movingId);
    saveTaskOrder(nextOrder);
    clearTaskDrag();
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
      saveTaskOrder([task.id, ...sortedTasks.map((existing) => existing.id).filter((id) => id !== task.id)]);
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

  async function closeTask(id: string) {
    try {
      const updated = await window.codexDesk.closeTask(id);
      setTasks((current) => current.map((task) => task.id === updated.id ? updated : task));
      notify("ターミナルを閉じました");
    } catch (error) {
      notify(error instanceof Error ? error.message : "ターミナルを閉じられませんでした", true);
    }
  }

  async function reopenTask(id: string) {
    try {
      const updated = await window.codexDesk.reopenTask(id);
      setTasks((current) => current.map((task) => task.id === updated.id ? updated : task));
      notify("ターミナルを再表示しました");
    } catch (error) {
      notify(error instanceof Error ? error.message : "ターミナルを再表示できませんでした", true);
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

  async function openSkills() {
    setSkillsOpen(true);
    setSkillsLoading(true);
    setSkillsError(null);
    setSkills([]);
    setSkillWarnings([]);
    const seenPaths = new Set<string>();
    const projectPaths = [...tasks.map((task) => task.cwd), ...projects.map((project) => project.path), folderPath]
      .map((path) => path.trim())
      .filter((path) => {
        if (!path) return false;
        const key = path.toLowerCase();
        if (seenPaths.has(key)) return false;
        seenPaths.add(key);
        return true;
      });

    try {
      const result = await window.codexDesk.getSkills(projectPaths);
      setSkills(result.skills);
      setSkillWarnings(result.warnings);
    } catch (error) {
      setSkillsError(error instanceof Error ? error.message : "スキル一覧を取得できませんでした。");
    } finally {
      setSkillsLoading(false);
    }
  }

  async function deleteTask(id: string) {
    try {
      await window.codexDesk.deleteTask(id);
      setTasks((current) => current.filter((task) => task.id !== id));
      saveTaskOrder(taskOrder.filter((taskId) => taskId !== id));
      const nextReviewedIds = reviewedTaskIds.filter((taskId) => taskId !== id);
      setReviewedTaskIds(nextReviewedIds);
      localStorage.setItem(reviewedTaskStorageKey, JSON.stringify(nextReviewedIds));
      const nextOperationalLogVisibility = { ...operationalLogVisibility };
      delete nextOperationalLogVisibility[id];
      setOperationalLogVisibility(nextOperationalLogVisibility);
      localStorage.setItem(operationalLogVisibilityStorageKey, JSON.stringify(nextOperationalLogVisibility));
      setTaskDrafts((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setAutoFollowByTask((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      delete terminalOutputRefs.current[id];
      delete terminalScrollMetrics.current[id];
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
    const nextReviewedIds = [...reviewedTaskIds.filter((id) => id !== task.id), task.id];
    setReviewedTaskIds(nextReviewedIds);
    localStorage.setItem(reviewedTaskStorageKey, JSON.stringify(nextReviewedIds));
    setSelectedTaskId(task.id);
    setDetailsOpen(true);
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span>
          <span className="brand-copy"><strong>CimLine</strong><small>CLI MANAGER</small></span>
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
        <button className="sidebar-nav-item" type="button" title="スキル一覧" aria-label="スキル一覧を開く" onClick={openSkills}>
          <Sparkles size={15} /><span>スキル</span>
        </button>

        <div className="recent-heading"><span className="sidebar-group-label">最近のフォルダー</span><span className="recent-dot" /></div>
        <div className="recent-projects">
          {projects.length === 0 ? <p className="recent-empty">依頼を実行すると<br />ここに表示されます</p> : projects.map((project) => (
            <button key={project.path} className={`recent-project ${folderPath === project.path ? "selected" : ""}`} type="button" title={project.path} onClick={() => setFolderPath(project.path)}>
              <Folder size={14} /><span>{project.name}</span>
            </button>
          ))}
        </div>

        <div className="history-heading"><span className="sidebar-group-label">依頼履歴</span><span className="recent-dot" /></div>
        <div className="sidebar-history-list" aria-label="依頼履歴">
          {sortedTasks.length === 0 ? <p className="recent-empty">依頼はまだありません</p> : sortedTasks.map((task) => (
            <div className={`sidebar-history-row${task.closed ? " is-closed" : ""}`} key={task.id}>
              <button className="sidebar-history-item" type="button" title={`${task.title} · ${task.cwd}`} onClick={() => task.closed ? reopenTask(task.id) : openDetails(task)}>
                <strong>{task.title}</strong>
                <span><span>{getFolderName(task.cwd)}</span><i>·</i><small className={`sidebar-history-status state-${task.status}`}>{statusText[task.status]}{task.closed ? " · 非表示" : ""}</small></span>
              </button>
              {task.closed && <Button variant="ghost" size="icon-sm" className="sidebar-history-reopen" type="button" title="ターミナルを再表示" aria-label={`${task.title}を再表示`} onClick={() => reopenTask(task.id)}><Eye size={13} /></Button>}
            </div>
          ))}
        </div>

        <div className="sidebar-bottom">
          <div className="cli-state"><span className={`status-dot ${cliAvailable === false ? "offline" : "online"}`} /><span>{cliAvailable === null ? "CLIを確認中" : cliAvailable ? "Codex CLI 利用可能" : "Codex CLI が未検出"}</span></div>
          <p>履歴はアプリ終了後も保存されます</p>
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
                {visibleTasks.length > 0 ? visibleTasks.map((task) => {
                  const showOperationalLogs = operationalLogVisibility[task.id] ?? true;
                  const recentLogs = task.logs.filter((log) => showOperationalLogs || (log.kind !== "system" && log.kind !== "command")).slice(-8);
                  const unreviewed = task.status === "completed" && !reviewedTaskIds.includes(task.id);
                  return <Card
                    className={`terminal-pane${task.status === "running" ? " terminal-pane-running" : ""}${unreviewed ? " terminal-pane-unreviewed" : ""}${draggingTaskId === task.id ? " terminal-pane-dragging" : ""}${dropTargetTaskId === task.id ? " terminal-pane-drop-target" : ""}`}
                    key={task.id}
                    onDragOver={(event) => {
                      if (!draggedTaskId.current) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      updateTaskAutoScroll(event);
                      if (draggedTaskId.current === task.id) return;
                      setDropTargetTaskId(task.id);
                    }}
                    onDragLeave={(event) => {
                      const nextTarget = event.relatedTarget;
                      if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
                      setDropTargetTaskId((current) => current === task.id ? null : current);
                    }}
                    onDrop={(event) => handleTaskDrop(task.id, event)}
                  >
                    <div
                      className="terminal-titlebar terminal-titlebar-draggable"
                      draggable
                      onDragStart={(event) => {
                        if (event.target instanceof HTMLElement && event.target.closest(".terminal-close")) {
                          event.preventDefault();
                          event.stopPropagation();
                          return;
                        }
                        startTaskDrag(task.id, event);
                      }}
                      onDragEnd={clearTaskDrag}
                    >
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
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="terminal-close"
                        type="button"
                        draggable={false}
                        title="ターミナルを閉じる"
                        aria-label="ターミナルを閉じる"
                        onDragStart={(event) => { event.preventDefault(); event.stopPropagation(); }}
                        onPointerDown={(event) => event.stopPropagation()}
                        onClick={() => closeTask(task.id)}
                      ><X size={13} /></Button>
                    </div>
                    <div className="terminal-screen">
                      <div className="terminal-initial-prompt"><span>codex@{getFolderName(task.cwd)}</span><b>$</b>{shortText(task.prompt, 150)}</div>
                      <div
                        className="terminal-output"
                        ref={(element) => { terminalOutputRefs.current[task.id] = element; }}
                        onScroll={(event) => {
                          const element = event.currentTarget;
                          const previous = terminalScrollMetrics.current[task.id];
                          const manuallyScrolledUp = previous
                            && previous.scrollHeight === element.scrollHeight
                            && previous.clientHeight === element.clientHeight
                            && element.scrollTop < previous.scrollTop - 2;
                          terminalScrollMetrics.current[task.id] = {
                            scrollTop: element.scrollTop,
                            scrollHeight: element.scrollHeight,
                            clientHeight: element.clientHeight,
                          };
                          if (manuallyScrolledUp) {
                            setAutoFollowByTask((current) => current[task.id] === false ? current : { ...current, [task.id]: false });
                          }
                        }}
                      >
                        {recentLogs.length ? recentLogs.map((log) => log.kind === "system" || log.kind === "command" ? (
                          <details key={log.id} className={`terminal-line terminal-line-${log.kind} terminal-line-collapsible`}>
                            <summary className="terminal-line-summary">
                              <span className="terminal-line-kind">{terminalPrefix(log.kind)}</span>
                              <p title={log.text}>{shortText(log.text, 180)}</p>
                            </summary>
                            <pre className="terminal-line-expanded">{log.text}</pre>
                          </details>
                        ) : <div key={log.id} className={`terminal-line terminal-line-${log.kind}${log.kind === "user" || log.kind === "assistant" ? " terminal-line-conversation" : ""}`}><span className={log.kind === "user" || log.kind === "assistant" ? "terminal-line-speaker" : "terminal-line-kind"}>{terminalPrefix(log.kind)}</span><p>{log.text}</p></div>) : task.logs.length === 0 ? <div className="terminal-line terminal-line-system"><span className="terminal-line-kind">状態</span><p>Codex CLI の応答を待っています…</p></div> : null}
                        {(task.status === "running" || task.status === "stopping") && <div className="terminal-line terminal-live"><span>·</span><p><i /></p></div>}
                      </div>
                    </div>
                    <form className="terminal-followup-form" onSubmit={(event) => continueTerminalTask(task.id, event)}>
                      <Textarea
                        className="terminal-followup-input"
                        value={taskDrafts[task.id] || ""}
                        onChange={(event) => setTaskDrafts((current) => ({ ...current, [task.id]: event.target.value }))}
                        onKeyDown={(event) => {
                          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                          if (event.key === "Enter" && event.altKey) {
                            event.preventDefault();
                            const textarea = event.currentTarget;
                            const value = textarea.value;
                            const cursorStart = textarea.selectionStart;
                            const cursorEnd = textarea.selectionEnd;
                            const nextValue = `${value.slice(0, cursorStart)}\n${value.slice(cursorEnd)}`;
                            if (nextValue.length <= 20000) {
                              setTaskDrafts((current) => ({ ...current, [task.id]: nextValue }));
                              requestAnimationFrame(() => {
                                textarea.focus();
                                textarea.setSelectionRange(cursorStart + 1, cursorStart + 1);
                              });
                            }
                            return;
                          }
                          const canSubmit = !["running", "stopping"].includes(task.status) && !continuingTaskIds.includes(task.id) && Boolean(task.threadId) && Boolean((taskDrafts[task.id] || "").trim());
                          if (event.key === "Enter" && !event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey && canSubmit) {
                            event.preventDefault();
                            event.currentTarget.form?.requestSubmit();
                          }
                        }}
                        rows={1}
                        maxLength={20000}
                        placeholder="このターミナルの会話に追加で依頼…"
                        aria-label={`${task.title}への追加依頼`}
                      />
                      <div className="terminal-followup-controls">
                        <span className="terminal-followup-hint">
                          Enter 送信・Alt+Enter 改行
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
                    <div className="terminal-footer"><div><span className="terminal-token-count-footer" title="累積トークン使用量"><Activity size={11} />{numberLabel(task.usage?.totalTokens || 0)} tokens</span></div><div className="terminal-actions"><Button variant="ghost" size="sm" className={`terminal-operation-toggle${showOperationalLogs ? "" : " is-hidden"}`} type="button" aria-label={showOperationalLogs ? "操作ログを非表示" : "操作ログを表示"} aria-pressed={showOperationalLogs} title={showOperationalLogs ? "操作ログを非表示" : "操作ログを表示"} onClick={() => toggleOperationalLogs(task.id, showOperationalLogs)}>{showOperationalLogs ? <EyeOff size={12} /> : <Eye size={12} />}<span>操作ログ</span></Button><Button variant="ghost" size="sm" className={`terminal-autofollow-toggle${autoFollowByTask[task.id] === false ? " is-paused" : ""}`} type="button" aria-label={autoFollowByTask[task.id] === false ? "ログの自動追従を再開" : "ログの自動追従を一時停止"} aria-pressed={autoFollowByTask[task.id] !== false} title={autoFollowByTask[task.id] === false ? "自動追従を再開" : "自動追従中"} onClick={() => setAutoFollowByTask((current) => ({ ...current, [task.id]: current[task.id] === false }))}><ArrowDown size={12} /><span>{autoFollowByTask[task.id] === false ? "追従OFF" : "追従ON"}</span></Button><Button variant="ghost" size="sm" onClick={() => openDetails(task)}>詳細</Button>{task.status === "running" || task.status === "stopping" ? <Button variant="outline" size="sm" className="terminal-stop" onClick={() => stopTask(task.id)}><Square size={10} />停止</Button> : null}</div></div>
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
                <Textarea
                  ref={promptRef}
                  id="prompt-input"
                  value={prompt}
                  onChange={(event) => setPrompt(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                    if (event.key === "Enter" && event.altKey) {
                      event.preventDefault();
                      const textarea = event.currentTarget;
                      const value = textarea.value;
                      const cursorStart = textarea.selectionStart;
                      const cursorEnd = textarea.selectionEnd;
                      const nextValue = `${value.slice(0, cursorStart)}\n${value.slice(cursorEnd)}`;
                      if (nextValue.length <= 20000) {
                        setPrompt(nextValue);
                        requestAnimationFrame(() => {
                          textarea.focus();
                          textarea.setSelectionRange(cursorStart + 1, cursorStart + 1);
                        });
                      }
                      return;
                    }
                    if (event.key === "Enter" && !event.altKey && !event.shiftKey && !event.ctrlKey && !event.metaKey && !loading) {
                      event.preventDefault();
                      event.currentTarget.form?.requestSubmit();
                    }
                  }}
                  rows={5}
                  maxLength={20000}
                  placeholder="例: このプロジェクトの構成を確認して、READMEにセットアップ手順を追記してください。変更したファイルと内容を最後にまとめてください。"
                  required
                />
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
            {selectedTask.logs.length ? selectedTask.logs.map((log) => <article className={`activity-item activity-${log.kind}${log.kind === "user" || log.kind === "assistant" ? " activity-conversation" : ""}`} key={log.id}><div className="activity-item-head"><span className="activity-speaker">{terminalPrefix(log.kind)}</span><time>{timeLabel(log.at)}</time></div><p>{log.text}</p></article>) : <div className="activity-waiting"><LoaderCircle size={14} className="spin" />Codex の応答を待っています…</div>}
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
        ref={skillsDialogRef}
        className="run-dialog skills-dialog"
        aria-labelledby="skills-dialog-title"
        onCancel={(event) => { event.preventDefault(); setSkillsOpen(false); }}
        onClose={() => setSkillsOpen(false)}
        onClick={(event) => { if (event.target === event.currentTarget) setSkillsOpen(false); }}
      >
        <Card className="dialog-card skills-dialog-card"><CardContent className="skills-dialog-content">
          <div className="dialog-heading"><div><h2 id="skills-dialog-title">スキル一覧</h2><p>ローカルで見つかったCodexスキルをソース別に一覧表示します。</p></div><Button variant="ghost" size="icon-sm" aria-label="閉じる" onClick={() => setSkillsOpen(false)}><X size={16} /></Button></div>
          {skillsLoading ? <div className="skills-state"><LoaderCircle size={16} className="spin" />スキルを読み込んでいます…</div> : skillsError ? <div className="skills-state is-error">{skillsError}</div> : <>
            <div className="skills-source-list">
              {([
                { scope: "user", label: "ユーザー" },
                { scope: "project", label: "プロジェクト" },
                { scope: "system", label: "システム" },
                { scope: "plugin", label: "プラグイン" },
              ] as const).map(({ scope, label }) => {
                const sourceScopes = scope === "user" ? ["user", "codex-home"] : [scope];
                const sourceSkills = skills.filter((skill) => sourceScopes.includes(skill.scope));
                if (!sourceSkills.length) return null;
                return <section className="skills-source-group" key={scope}>
                  <div className="skills-source-heading"><h3>{label}</h3><span>{sourceSkills.length}</span></div>
                  <div className="skills-items">{sourceSkills.map((skill) => <article className="skill-item" key={`${scope}:${skill.projectPath || ""}:${skill.path}:${skill.name}`}>
                    <div className="skill-item-heading"><h4>{skill.name}</h4><span className={`skill-source-badge is-${skill.scope === "codex-home" ? "user" : skill.scope}`}>{label}</span></div>
                    <p>{skill.description || "説明はありません。"}</p>
                    <small className="skill-item-location" title={skill.projectPath || skill.path}>{scope === "project" ? skill.projectPath || skill.path : skill.path}</small>
                  </article>)}</div>
                </section>;
              })}
              {!skills.length && <div className="skills-state">スキルは見つかりませんでした。</div>}
            </div>
            {skillWarnings.length > 0 && <section className="skills-warnings">
              <h3>確認事項</h3>
              <ul>{skillWarnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}</ul>
            </section>}
          </>}
        </CardContent></Card>
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
            <div className="usage-section-heading"><h3>アカウント利用枠</h3><span>Codexアカウント</span></div>
            {rateLimitsLoading && !rateLimits ? <div className="usage-empty">利用枠を取得しています…</div> : rateWindows.length ? <div className="rate-window-list">{rateWindows.map((window, index) => {
              const used = Math.max(0, Math.min(100, window.usedPercent));
              const resetAt = resetTimeLabel(window.resetsAt);
              const intensity = used >= 90 ? " is-critical" : used >= 70 ? " is-warning" : "";
              return <div className={`rate-window${intensity}`} key={`${window.windowDurationMins || "limit"}-${index}`}>
                <div className="rate-window-heading"><span>{rateWindowLabel(window.windowDurationMins)}</span><strong>{Math.round(used)}% <small>使用済み</small></strong></div>
                <div className="rate-window-track"><span style={{ width: `${used}%` }} /></div>
                <small className="rate-window-reset">{resetAt ? `リセット ${resetAt}` : "リセット時刻を取得できません"}</small>
              </div>;
            })}</div> : <div className="usage-empty">{rateLimitsError ? "利用枠を取得できませんでした。更新してください。" : "利用枠の情報はありません。"}</div>}
            <p className="usage-footnote">Codexアカウントから取得した利用枠の消費割合です。</p>
          </section>
          <Separator className="usage-separator" />
          <section className="terminal-usage-section">
            <div className="usage-section-heading"><h3>ターミナル別トークン使用量</h3><span>{sortedTasks.length}件</span></div>
            <div className="terminal-usage-list">
              {sortedTasks.length ? sortedTasks.map((task) => <article className="terminal-usage-item" key={task.id}>
                <div className="terminal-usage-item-top">
                  <span className="terminal-usage-task"><strong title={task.title}>{task.title}</strong><small title={task.cwd}>{getFolderName(task.cwd)}{task.closed ? " · 非表示" : ""}</small></span>
                  <span className="terminal-usage-total"><strong>{numberLabel(task.usage?.totalTokens || 0)}</strong><small>合計 tokens</small></span>
                </div>
                <div className="terminal-usage-breakdown"><span><small>入力</small><strong>{numberLabel(task.usage?.inputTokens || 0)}</strong><em>tokens</em></span><span><small>出力</small><strong>{numberLabel(task.usage?.outputTokens || 0)}</strong><em>tokens</em></span></div>
              </article>) : <div className="usage-empty">ターミナルがありません。</div>}
            </div>
          </section>
          <Separator className="usage-separator" />
          <div className="usage-panel-heading"><div><h3>トークン使用量</h3></div><span className="usage-live-tag"><CircleDot size={10} /> このアプリ</span></div>
          <div className="usage-total"><strong>{numberLabel(usageTotals.totalTokens)}</strong><span>tokens</span><small>履歴の合計</small></div>
          <div className="usage-bar"><span className="usage-input-bar" style={{ width: `${usageTotals.totalTokens ? usageTotals.inputTokens / usageTotals.totalTokens * 100 : 0}%` }} /><span className="usage-output-bar" style={{ width: `${usageTotals.totalTokens ? usageTotals.outputTokens / usageTotals.totalTokens * 100 : 0}%` }} /></div>
          <div className="usage-legend"><span><i className="legend-input" />入力</span><span><i className="legend-output" />出力</span></div>
          <div className="usage-breakdown"><div><span>入力トークン</span><strong>{numberLabel(usageTotals.inputTokens)}</strong></div><div><span>出力トークン</span><strong>{numberLabel(usageTotals.outputTokens)}</strong></div><div><span>キャッシュ入力</span><strong>{numberLabel(usageTotals.cachedInputTokens)}</strong></div><div><span>完了ターン</span><strong>{numberLabel(usageTotals.turns)}</strong></div></div>
          <div className="usage-footnote">CLIが各ターンで返したトークン数の履歴合計です。</div>
        </CardContent></Card>
      </dialog>

      {toast && <div className={`toast ${toast.error ? "is-error" : ""}`} role="status">{toast.message}</div>}
    </div>
  );
}
