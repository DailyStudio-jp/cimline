import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from "react";
import {
  Activity,
  AlertCircle,
  Check,
  CircleDot,
  Code2,
  ChevronLeft,
  ChevronRight,
  Copy,
  Folder,
  FolderOpen,
  LoaderCircle,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Terminal as TerminalIcon,
  Trash2,
  X,
} from "lucide-react";
import { TerminalPane, type TerminalSession } from "@/components/TerminalPane";
import { countReviewFilterResults, filterActiveSessions, isUnreviewedTerminal, nextReviewingSessionIdAfterReopen, retainReviewingSessionId } from "@/session-filter.mjs";
import { isSessionSortMode, moveSessionInOrder, preserveSessionOrder, sessionOrderDiffers, sortSessions, type SessionSortMode } from "@/session-sort.mjs";
import type { SessionStatus, ThemeSetting } from "@/vite-env";
import { Separator } from "@/components/ui/separator";

type CliKind = "codex" | "claude";
type RateWindow = { usedPercent: number; windowDurationMins: number | null; resetsAt: number | null };
type RateLimits = { primary: RateWindow | null; secondary: RateWindow | null };
type AppState = { sessions: TerminalSession[]; focusedSessionId?: string | null; restoreLegacySessionOrder?: boolean; cliAvailable: { codex: boolean; claude: boolean }; defaultDirectory: string; theme: ThemeSetting; zoomFactor: number };
type CimLineBridge = {
  platform?: string;
  getState?: () => Promise<AppState>;
  chooseFolder?: () => Promise<string | null>;
  writeClipboardText?: (text: string) => Promise<void>;
  createSession?: (input: { cwd: string; cli: CliKind }) => Promise<TerminalSession>;
  closeSession?: (id: string) => Promise<unknown>;
  reopenSession?: (id: string) => Promise<TerminalSession>;
  deleteSession?: (id: string) => Promise<boolean>;
  onSessionsUpdated?: (callback: (sessions: TerminalSession[]) => void) => () => void;
  setFocusedSession?: (id: string | null) => Promise<unknown>;
  getRateLimits?: () => Promise<RateLimits>;
  setTheme?: (theme: ThemeSetting) => Promise<ThemeSetting>;
  adjustZoom?: (delta: number) => Promise<number>;
};
type RecentFolder = { path: string; name: string };
const recentFolderStorageKey = "cimline-recent-folders";
const sessionOrderStorageKey = "cimline-session-order";
const sessionSortStorageKey = "cimline-session-sort";
const terminalColumnsStorageKey = "cimline-terminal-columns";
const lastCliStorageKey = "cimline-last-cli";
const sidebarCollapsedStorageKey = "cimline-sidebar-collapsed";
const SORT_INTERACTION_HOLD_MS = 4000;

function bridge(): CimLineBridge {
  return (window.codexDesk || {}) as unknown as CimLineBridge;
}

function readJson<T>(key: string, fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return value ? JSON.parse(value) as T : fallback;
  } catch {
    return fallback;
  }
}

function folderName(value: string) {
  if (/^[a-z]:[\\/]+$/i.test(value) || /^\/+$/u.test(value)) return value;
  const normalized = value.replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).pop() || normalized || "フォルダー";
}

function sessionDisplayTitle(session: Pick<TerminalSession, "title" | "agentTitle" | "cwd">) {
  return session.agentTitle || session.title || folderName(session.cwd);
}

function cliName(cli: CliKind) {
  return cli === "codex" ? "Codex CLI" : "Claude Code";
}

function errorText(error: unknown) {
  return (error instanceof Error ? error.message : String(error || "不明なエラー"))
    .replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\b(?:sk|sess|rk)-[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .replace(/[\r\n\t]+/g, " ")
    .slice(0, 320);
}

function resetLabel(timestamp: number | null) {
  if (!timestamp) return "リセット時刻不明";
  return new Intl.DateTimeFormat("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp * 1000));
}

function windowLabel(window: RateWindow) {
  if (window.windowDurationMins && window.windowDurationMins >= 10000) return "週間枠";
  if (window.windowDurationMins && window.windowDurationMins >= 300) return "5時間枠";
  return "利用枠";
}

function loadRecentFolders() {
  const value = readJson<RecentFolder[]>(recentFolderStorageKey, []);
  return Array.isArray(value) ? value.filter((item) => item && typeof item.path === "string").slice(0, 8) : [];
}

function loadTerminalColumns() {
  try {
    const stored = localStorage.getItem(terminalColumnsStorageKey);
    if (stored === null) return 2;
    const value = Number(stored);
    return Number.isInteger(value) ? Math.max(1, Math.min(6, value)) : 2;
  } catch {
    return 2;
  }
}

function isSessionStatus(value: unknown): value is SessionStatus {
  return value === "idle" || value === "running" || value === "completed" || value === "approval" || value === "exited";
}

function normalizeSessions(value: unknown): TerminalSession[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((valueItem): TerminalSession[] => {
    if (!valueItem || typeof valueItem !== "object") return [];
    const item = valueItem as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.cwd !== "string" || (item.cli !== "codex" && item.cli !== "claude")) return [];
    const closed = item.closed === true;
    return [{
      id: item.id,
      title: folderName(item.cwd),
      agentTitle: typeof item.agentTitle === "string"
        ? item.agentTitle
        : typeof item.title === "string" && item.title.toLocaleLowerCase() !== folderName(item.cwd).toLocaleLowerCase()
          ? item.title
          : "",
      cwd: item.cwd,
      cli: item.cli,
      closed,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : new Date(0).toISOString(),
      status: isSessionStatus(item.status) ? item.status : closed ? "exited" : "idle",
      statusAt: typeof item.statusAt === "string" && !Number.isNaN(Date.parse(item.statusAt)) ? item.statusAt : null,
      unreviewed: item.unreviewed === true,
    }];
  });
}

function sessionStatusLabel(status: SessionStatus) {
  switch (status) {
    case "running": return "実行中";
    case "completed": return "完了";
    case "approval": return "承認待ち";
    case "exited": return "終了";
    default: return "待機中";
  }
}

function statusAgeLabel(statusAt: string | null, now: number) {
  if (!statusAt) return "";
  const timestamp = Date.parse(statusAt);
  if (Number.isNaN(timestamp)) return "";
  const elapsed = Math.max(0, now - timestamp);
  if (elapsed < 60_000) return "たった今";
  if (elapsed < 60 * 60_000) return `${Math.floor(elapsed / 60_000)}分前`;
  if (elapsed < 24 * 60 * 60_000) return `${Math.floor(elapsed / (60 * 60_000))}時間前`;
  return `${Math.floor(elapsed / (24 * 60 * 60_000))}日前`;
}

export default function App() {
  const [sessions, setSessions] = useState<TerminalSession[]>([]);
  const [sessionsInitialized, setSessionsInitialized] = useState(false);
  const [cliAvailable, setCliAvailable] = useState<{ codex: boolean; claude: boolean }>({ codex: false, claude: false });
  const [defaultDirectory, setDefaultDirectory] = useState("");
  const [recentFolders, setRecentFolders] = useState<RecentFolder[]>(loadRecentFolders);
  const [sessionOrder, setSessionOrder] = useState<string[]>(() => readJson<string[]>(sessionOrderStorageKey, []));
  const [sessionSortMode, setSessionSortMode] = useState<SessionSortMode>(() => {
    const storedMode = readJson<unknown>(sessionSortStorageKey, "updated-asc");
    if (storedMode === "completed-asc") return "updated-asc";
    if (storedMode === "completed-desc") return "updated-desc";
    return isSessionSortMode(storedMode) ? storedMode : "updated-asc";
  });
  const [terminalColumns, setTerminalColumns] = useState(loadTerminalColumns);
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const [heldSessionOrder, setHeldSessionOrder] = useState<string[] | null>(null);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => readJson<boolean>(sidebarCollapsedStorageKey, false));
  const [search, setSearch] = useState("");
  const [showUnreviewedOnly, setShowUnreviewedOnly] = useState(false);
  const [folderPath, setFolderPath] = useState("");
  const [folderPathCopied, setFolderPathCopied] = useState(false);
  const [selectedCli, setSelectedCli] = useState<CliKind>(() => localStorage.getItem(lastCliStorageKey) === "claude" ? "claude" : "codex");
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null);
  const [reviewingSessionId, setReviewingSessionId] = useState<string | null>(null);
  const [statusClock, setStatusClock] = useState(() => Date.now());
  const [composerOpen, setComposerOpen] = useState(false);
  const [usageOpen, setUsageOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [themeSetting, setThemeSetting] = useState<ThemeSetting>("system");
  const [rateLimits, setRateLimits] = useState<RateLimits | null>(null);
  const [rateLimitsLoading, setRateLimitsLoading] = useState(false);
  const [rateLimitsError, setRateLimitsError] = useState("");
  const [creatingSession, setCreatingSession] = useState(false);
  const [workingSessionId, setWorkingSessionId] = useState<string | null>(null);
  const [bridgeError, setBridgeError] = useState("");
  const [toast, setToast] = useState<{ message: string; error?: boolean } | null>(null);
  const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
  const [dropTargetSessionId, setDropTargetSessionId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const terminalGridRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const displayedOrderRef = useRef<string[]>([]);
  const heldSessionOrderRef = useRef<string[] | null>(null);
  const sortHoldUntilRef = useRef(0);
  const sortHoldTimerRef = useRef<number | null>(null);
  const previousTerminalPositionsRef = useRef(new Map<string, { left: number; top: number }>());
  const terminalMoveAnimationsRef = useRef(new Map<string, Animation>());
  const composerRef = useRef<HTMLDialogElement>(null);
  const usageRef = useRef<HTMLDialogElement>(null);
  const settingsRef = useRef<HTMLDialogElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const focusedSessionIdRef = useRef<string | null>(null);
  const reviewingSessionIdRef = useRef<string | null>(null);
  const sessionsRef = useRef(sessions);
  sessionsRef.current = sessions;

  const clearReviewingSession = useCallback((sessionId?: string) => {
    if (sessionId && reviewingSessionIdRef.current !== sessionId) return;
    reviewingSessionIdRef.current = null;
    setReviewingSessionId(null);
  }, []);

  const notify = useCallback((message: string, error = false) => {
    setToast({ message, error });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  const clearDeferredSort = useCallback(() => {
    if (sortHoldTimerRef.current !== null) window.clearTimeout(sortHoldTimerRef.current);
    sortHoldTimerRef.current = null;
    sortHoldUntilRef.current = 0;
    heldSessionOrderRef.current = null;
    setHeldSessionOrder(null);
  }, []);

  const deferSortAfterInteraction = useCallback(() => {
    if (sessionSortMode === "manual") return;
    if (!heldSessionOrderRef.current) {
      const currentOrder = [...displayedOrderRef.current];
      heldSessionOrderRef.current = currentOrder;
      setHeldSessionOrder(currentOrder);
    }
    sortHoldUntilRef.current = Date.now() + SORT_INTERACTION_HOLD_MS;
    if (sortHoldTimerRef.current !== null) window.clearTimeout(sortHoldTimerRef.current);
    const releaseWhenQuiet = () => {
      const remaining = sortHoldUntilRef.current - Date.now();
      if (remaining > 0) {
        sortHoldTimerRef.current = window.setTimeout(releaseWhenQuiet, remaining);
        return;
      }
      sortHoldTimerRef.current = null;
      sortHoldUntilRef.current = 0;
      heldSessionOrderRef.current = null;
      setHeldSessionOrder(null);
    };
    sortHoldTimerRef.current = window.setTimeout(releaseWhenQuiet, SORT_INTERACTION_HOLD_MS);
  }, [sessionSortMode]);

  const focusSession = useCallback((sessionId: string) => {
    focusedSessionIdRef.current = sessionId;
    setFocusedSessionId(sessionId);
    const session = sessionsRef.current.find((item) => item.id === sessionId);
    if (showUnreviewedOnly && (isUnreviewedTerminal(session) || reviewingSessionIdRef.current === sessionId)) {
      reviewingSessionIdRef.current = sessionId;
      setReviewingSessionId(sessionId);
    } else {
      clearReviewingSession();
    }
    setSessions((current) => current.some((item) => item.id === sessionId && item.unreviewed)
      ? current.map((item) => item.id === sessionId ? { ...item, unreviewed: false } : item)
      : current);
    const api = bridge();
    if (typeof api.setFocusedSession === "function") void api.setFocusedSession(sessionId).catch(() => {});
  }, [clearReviewingSession, showUnreviewedOnly]);

  const toggleUnreviewedOnly = () => {
    if (showUnreviewedOnly) clearReviewingSession();
    setShowUnreviewedOnly(!showUnreviewedOnly);
  };

  const refreshUsage = useCallback(async () => {
    const api = bridge();
    if (typeof api.getRateLimits !== "function") {
      setRateLimitsError("利用枠APIがありません。CimLineを完全終了して再起動してください。");
      return;
    }
    setRateLimitsLoading(true);
    setRateLimitsError("");
    try {
      const result = await api.getRateLimits();
      setRateLimits(result);
    } catch (error) {
      setRateLimitsError(errorText(error));
    } finally {
      setRateLimitsLoading(false);
    }
  }, []);

  useEffect(() => {
    let disposed = false;
    const api = bridge();
    if (typeof api.getState !== "function") {
      setBridgeError("CimLineの画面とElectron本体の版がずれています。アプリを完全終了して再起動してください。");
      setSessionsInitialized(true);
      return;
    }
    const unsubscribe = api.onSessionsUpdated?.((next) => {
      if (!disposed) setSessions(normalizeSessions(next));
    });
    void api.getState().then(async (state) => {
      if (disposed) return;
      let nextSessions = normalizeSessions(state.sessions);
      let startupFocusedSessionId = state.focusedSessionId;
      if (state.restoreLegacySessionOrder === true && !nextSessions.some((session) => !session.closed) && sessionOrder.length > 0 && typeof api.reopenSession === "function") {
        const restoreCandidates = sessionOrder
          .map((id) => nextSessions.find((session) => session.id === id && session.closed))
          .filter((session): session is TerminalSession => Boolean(session))
          .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));
        const restoredDirectories = new Set<string>();
        const restoredSessions: TerminalSession[] = [];
        for (const session of restoreCandidates) {
          if (disposed) return;
          const directory = bridge().platform === "win32" ? session.cwd.toLowerCase() : session.cwd;
          const restoreKey = `${session.cli}\u0000${directory}`;
          if (restoredDirectories.has(restoreKey)) continue;
          restoredDirectories.add(restoreKey);
          try {
            restoredSessions.push(await api.reopenSession(session.id));
          } catch {
            // Older app versions did not mark which sessions were open at shutdown.
          }
        }
        if (restoredSessions.length > 0) {
          nextSessions = normalizeSessions([...nextSessions, ...restoredSessions]);
          startupFocusedSessionId = restoredSessions[0].id;
        }
      }
      setSessions(nextSessions);
      setCliAvailable(state.cliAvailable || { codex: false, claude: false });
      setDefaultDirectory(state.defaultDirectory || "");
      setThemeSetting(state.theme === "light" || state.theme === "dark" ? state.theme : "system");
      setFolderPath((current) => current || state.defaultDirectory || recentFolders[0]?.path || "");
      setSessionsInitialized(true);
      const focusedAtStartup = startupFocusedSessionId;
      if (focusedAtStartup && nextSessions.some((session) => session.id === focusedAtStartup && !session.closed)) {
        focusSession(focusedAtStartup);
      }
      if (nextSessions.length === 0) setComposerOpen(true);
    }).catch((error) => {
      if (disposed) return;
      setBridgeError("セッション情報を読み込めません: " + errorText(error));
      setSessionsInitialized(true);
    });
    void refreshUsage();
    return () => {
      disposed = true;
      unsubscribe?.();
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  useEffect(() => {
    const retainedId = retainReviewingSessionId(sessions, reviewingSessionIdRef.current);
    if (retainedId !== reviewingSessionIdRef.current) {
      reviewingSessionIdRef.current = retainedId;
      setReviewingSessionId(retainedId);
    }
  }, [sessions]);

  useEffect(() => {
    const timer = window.setInterval(() => setStatusClock(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const updateWidth = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", updateWidth);
    return () => window.removeEventListener("resize", updateWidth);
  }, []);

  useEffect(() => {
    localStorage.setItem(terminalColumnsStorageKey, String(terminalColumns));
  }, [terminalColumns]);

  useEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const onKeyDown = () => deferSortAfterInteraction();
    const onPointerDown = () => deferSortAfterInteraction();
    const onScroll = () => deferSortAfterInteraction();
    const onWheel = (event: WheelEvent) => {
      if (event.altKey) {
        deferSortAfterInteraction();
        event.preventDefault();
        event.stopPropagation();
        workspace.scrollBy({ top: event.deltaY || event.deltaX, behavior: "auto" });
        return;
      }
      const isMac = bridge().platform === "darwin";
      if (event.ctrlKey || (isMac && event.metaKey)) {
        deferSortAfterInteraction();
        event.preventDefault();
        event.stopPropagation();
        if (event.deltaY !== 0) setTerminalColumns((current) => Math.max(1, Math.min(6, current + (event.deltaY < 0 ? 1 : -1))));
        return;
      }
      deferSortAfterInteraction();
    };
    workspace.addEventListener("keydown", onKeyDown, true);
    workspace.addEventListener("pointerdown", onPointerDown, true);
    workspace.addEventListener("scroll", onScroll, true);
    workspace.addEventListener("wheel", onWheel, { capture: true, passive: false });
    return () => {
      workspace.removeEventListener("keydown", onKeyDown, true);
      workspace.removeEventListener("pointerdown", onPointerDown, true);
      workspace.removeEventListener("scroll", onScroll, true);
      workspace.removeEventListener("wheel", onWheel, true);
    };
  }, [deferSortAfterInteraction]);

  useEffect(() => () => {
    if (sortHoldTimerRef.current !== null) window.clearTimeout(sortHoldTimerRef.current);
  }, []);

  useEffect(() => {
    const dialog = composerRef.current;
    if (!dialog) return;
    if (composerOpen && !dialog.open) {
      dialog.showModal();
      requestAnimationFrame(() => document.getElementById("new-session-folder")?.focus());
    } else if (!composerOpen && dialog.open) dialog.close();
  }, [composerOpen]);

  useEffect(() => {
    const dialog = usageRef.current;
    if (!dialog) return;
    if (usageOpen && !dialog.open) dialog.showModal();
    else if (!usageOpen && dialog.open) dialog.close();
  }, [usageOpen]);

  useEffect(() => {
    const dialog = settingsRef.current;
    if (!dialog) return;
    if (settingsOpen && !dialog.open) dialog.showModal();
    else if (!settingsOpen && dialog.open) dialog.close();
  }, [settingsOpen]);

  useEffect(() => {
    const handleZoomShortcut = (event: KeyboardEvent) => {
      const isMac = bridge().platform === "darwin";
      if (!(isMac ? event.metaKey : event.ctrlKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      const delta = key === "0" ? 0
        : key === "+" || key === "=" || event.code === "NumpadAdd" ? 0.1
        : key === "-" || key === "_" || event.code === "NumpadSubtract" ? -0.1
        : null;
      if (delta === null) return;
      event.preventDefault();
      event.stopPropagation();
      const api = bridge();
      if (typeof api.adjustZoom !== "function") return;
      void api.adjustZoom(delta).catch((error) => notify("表示倍率を変更できません: " + errorText(error), true));
    };
    window.addEventListener("keydown", handleZoomShortcut, true);
    return () => window.removeEventListener("keydown", handleZoomShortcut, true);
  }, [notify]);

  useEffect(() => {
    const focusSearchShortcut = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, [contenteditable='true']"))) return;
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener("keydown", focusSearchShortcut, true);
    return () => window.removeEventListener("keydown", focusSearchShortcut, true);
  }, []);

  useEffect(() => {
    const openNewTerminalShortcut = (event: KeyboardEvent) => {
      const isMac = bridge().platform === "darwin";
      if (!(isMac ? event.metaKey : event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "n") return;
      if (document.querySelector("dialog[open]")) return;
      event.preventDefault();
      event.stopPropagation();
      setFolderPath((current) => current || defaultDirectory || recentFolders[0]?.path || "");
      setSelectedCli((current) => localStorage.getItem(lastCliStorageKey) === "claude" ? "claude" : current);
      setComposerOpen(true);
    };
    window.addEventListener("keydown", openNewTerminalShortcut, true);
    return () => window.removeEventListener("keydown", openNewTerminalShortcut, true);
  }, [defaultDirectory, recentFolders]);

  useEffect(() => {
    if (!sessionsInitialized) return;
    const active = sessions.filter((session) => !session.closed);
    const currentIds = new Set(active.map((session) => session.id));
    const retained = sessionOrder.filter((id) => currentIds.has(id));
    const added = active.filter((session) => !retained.includes(session.id))
      .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
      .map((session) => session.id);
    const nextOrder = retained.concat(added);
    if (nextOrder.length !== sessionOrder.length || nextOrder.some((id, index) => sessionOrder[index] !== id)) {
      setSessionOrder(nextOrder);
      localStorage.setItem(sessionOrderStorageKey, JSON.stringify(nextOrder));
    }
  }, [sessions, sessionsInitialized, sessionOrder]);

  const sortedActiveSessions = useMemo(() => {
    const active = sessions.filter((session) => !session.closed);
    return sortSessions(active, sessionOrder, sessionSortMode);
  }, [sessions, sessionOrder, sessionSortMode]);
  const displayedSortedActiveSessions = useMemo(
    () => preserveSessionOrder(sortedActiveSessions, heldSessionOrder),
    [sortedActiveSessions, heldSessionOrder],
  );
  const displayedOrder = displayedSortedActiveSessions.map((session) => session.id);
  displayedOrderRef.current = displayedOrder;
  const sortUpdatePending = heldSessionOrder !== null && sessionOrderDiffers(sortedActiveSessions, displayedOrder);
  const sidebarWidth = sidebarCollapsed ? 58 : 212;
  const maxVisibleColumns = Math.max(1, Math.min(6, Math.floor(Math.max(320, viewportWidth - sidebarWidth - 32) / 320)));
  const visibleColumns = Math.min(terminalColumns, maxVisibleColumns);

  const query = search.trim().toLowerCase();
  const filterOptions = { query, showUnreviewedOnly, reviewingSessionId };
  const reviewFilterCount = countReviewFilterResults(displayedSortedActiveSessions, filterOptions);
  const filteredActiveSessions = filterActiveSessions(displayedSortedActiveSessions, filterOptions);
  const visibleSessionOrder = filteredActiveSessions.map((session) => session.id).join("\u0000");
  const historySessions = useMemo(() => sessions
    .filter((session) => session.closed)
    .filter((session) => !query || [sessionDisplayTitle(session), session.title, session.cwd, cliName(session.cli)].some((value) => value.toLowerCase().includes(query)))
    .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()), [sessions, query]);
  const rateWindows = useMemo(() => rateLimits
    ? [rateLimits.primary, rateLimits.secondary].filter((item): item is RateWindow => Boolean(item))
      .sort((left, right) => (left.windowDurationMins ?? Number.MAX_SAFE_INTEGER) - (right.windowDurationMins ?? Number.MAX_SAFE_INTEGER))
    : [], [rateLimits]);

  useLayoutEffect(() => {
    const grid = terminalGridRef.current;
    if (!grid) {
      previousTerminalPositionsRef.current.clear();
      for (const animation of terminalMoveAnimationsRef.current.values()) animation.cancel();
      terminalMoveAnimationsRef.current.clear();
      return;
    }

    const panes = Array.from(grid.querySelectorAll<HTMLElement>("[data-session-id]"));
    const visibleIds = new Set(panes.map((pane) => pane.dataset.sessionId).filter((id): id is string => Boolean(id)));
    for (const [id, animation] of terminalMoveAnimationsRef.current) {
      if (!visibleIds.has(id)) {
        animation.cancel();
        terminalMoveAnimationsRef.current.delete(id);
      }
    }

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const nextPositions = new Map<string, { left: number; top: number }>();
    for (const pane of panes) {
      const id = pane.dataset.sessionId;
      if (!id) continue;
      terminalMoveAnimationsRef.current.get(id)?.cancel();
      terminalMoveAnimationsRef.current.delete(id);

      const rect = pane.getBoundingClientRect();
      const position = { left: rect.left, top: rect.top };
      nextPositions.set(id, position);
      const previous = previousTerminalPositionsRef.current.get(id);
      if (!previous || reducedMotion || typeof pane.animate !== "function") continue;

      const deltaX = previous.left - position.left;
      const deltaY = previous.top - position.top;
      if (Math.abs(deltaX) < 2 && Math.abs(deltaY) < 2) continue;

      const animation = pane.animate([
        { transform: `translate(${deltaX}px, ${deltaY}px)`, outline: "2px solid rgb(200 243 108 / 85%)", outlineOffset: "2px" },
        { transform: "translate(0, 0)", outline: "0 solid transparent", outlineOffset: "0px" },
      ], { duration: 420, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
      terminalMoveAnimationsRef.current.set(id, animation);
      animation.onfinish = () => {
        if (terminalMoveAnimationsRef.current.get(id) === animation) terminalMoveAnimationsRef.current.delete(id);
      };
    }
    previousTerminalPositionsRef.current = nextPositions;
  }, [visibleSessionOrder]);

  function openComposer(path?: string) {
    setFolderPath(path || folderPath || defaultDirectory || recentFolders[0]?.path || "");
    setSelectedCli((localStorage.getItem(lastCliStorageKey) === "claude" ? "claude" : selectedCli));
    setComposerOpen(true);
  }

  async function chooseFolder() {
    const api = bridge();
    if (typeof api.chooseFolder !== "function") {
      notify("フォルダー選択APIがありません。CimLineを完全終了して再起動してください。", true);
      return;
    }
    try {
      const selected = await api.chooseFolder();
      if (selected) {
        setFolderPath(selected);
        setFolderPathCopied(false);
      }
    } catch (error) {
      notify("フォルダーを選択できません: " + errorText(error), true);
    }
  }

  async function copyFolderPath() {
    const path = folderPath.trim();
    if (!path) {
      notify("コピーするフォルダーのパスがありません。", true);
      return;
    }
    const api = bridge();
    if (typeof api.writeClipboardText !== "function") {
      notify("クリップボードAPIがありません。CimLineを完全終了して再起動してください。", true);
      return;
    }
    try {
      await api.writeClipboardText(path);
      setFolderPathCopied(true);
      notify("フォルダーのパスをコピーしました。");
    } catch (error) {
      setFolderPathCopied(false);
      notify("パスをコピーできません: " + errorText(error), true);
    }
  }

  function rememberFolder(path: string) {
    const next = [{ path, name: folderName(path) }, ...recentFolders.filter((folder) => folder.path.toLowerCase() !== path.toLowerCase())].slice(0, 8);
    setRecentFolders(next);
    localStorage.setItem(recentFolderStorageKey, JSON.stringify(next));
  }

  async function createSession(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cwd = folderPath.trim();
    if (!cwd) {
      notify("作業フォルダーを指定してください。", true);
      return;
    }
    const api = bridge();
    if (typeof api.createSession !== "function") {
      notify("ターミナル作成APIがありません。CimLineを完全終了して再起動してください。", true);
      return;
    }
    setCreatingSession(true);
    try {
      const session = normalizeSessions([await api.createSession({ cwd, cli: selectedCli })])[0];
      if (!session) throw new Error("ターミナル情報を読み取れませんでした。");
      setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
      setSessionOrder((current) => [session.id, ...current.filter((id) => id !== session.id)]);
      focusSession(session.id);
      setComposerOpen(false);
      rememberFolder(cwd);
      localStorage.setItem(lastCliStorageKey, selectedCli);
    } catch (error) {
      notify(cliName(selectedCli) + "を起動できません: " + errorText(error), true);
    } finally {
      setCreatingSession(false);
    }
  }

  const closeSession = useCallback(async (sessionId: string) => {
    const api = bridge();
    if (typeof api.closeSession !== "function") {
      notify("ターミナルを閉じるAPIがありません。CimLineを完全終了して再起動してください。", true);
      return;
    }
    try {
      await api.closeSession(sessionId);
      clearReviewingSession(sessionId);
      setSessions((current) => current.map((session) => session.id === sessionId
        ? { ...session, closed: true, status: "exited", statusAt: new Date().toISOString(), unreviewed: false }
        : session));
      if (focusedSessionIdRef.current === sessionId) {
        focusedSessionIdRef.current = null;
        setFocusedSessionId(null);
        const focusedApi = bridge();
        if (typeof focusedApi.setFocusedSession === "function") void focusedApi.setFocusedSession(null).catch(() => {});
      }
    } catch (error) {
      notify("ターミナルを閉じられません: " + errorText(error), true);
    }
  }, [clearReviewingSession, notify]);

  async function reopenSession(sessionId: string) {
    const api = bridge();
    if (typeof api.reopenSession !== "function") {
      notify("ターミナル再開APIがありません。CimLineを完全終了して再起動してください。", true);
      return;
    }
    setWorkingSessionId(sessionId);
    try {
      const session = normalizeSessions([await api.reopenSession(sessionId)])[0];
      if (!session) throw new Error("ターミナル情報を読み取れませんでした。");
      const nextReviewingId = nextReviewingSessionIdAfterReopen(session.id, reviewingSessionIdRef.current);
      if (nextReviewingId !== reviewingSessionIdRef.current) {
        reviewingSessionIdRef.current = nextReviewingId;
        setReviewingSessionId(nextReviewingId);
      }
      setSessions((current) => [session, ...current.filter((item) => item.id !== session.id)]);
      setSessionOrder((current) => [session.id, ...current.filter((id) => id !== session.id)]);
      focusSession(session.id);
    } catch (error) {
      notify("ターミナルを再開できません: " + errorText(error), true);
    } finally {
      setWorkingSessionId(null);
    }
  }

  async function deleteSession(sessionId: string) {
    const session = sessions.find((item) => item.id === sessionId);
    if (!session) return;
    if (!window.confirm("履歴から「" + sessionDisplayTitle(session) + "」を削除しますか？")) return;
    const api = bridge();
    if (typeof api.deleteSession !== "function") {
      notify("履歴削除APIがありません。CimLineを完全終了して再起動してください。", true);
      return;
    }
    try {
      await api.deleteSession(sessionId);
      clearReviewingSession(sessionId);
      setSessions((current) => current.filter((item) => item.id !== sessionId));
      setSessionOrder((current) => current.filter((id) => id !== sessionId));
    } catch (error) {
      notify("履歴を削除できません: " + errorText(error), true);
    }
  }

  const onDragStart = useCallback((sessionId: string, event: DragEvent<HTMLElement>) => {
    setDraggingSessionId(sessionId);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", sessionId);
  }, []);

  const onDragOver = useCallback((sessionId: string, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDropTargetSessionId(sessionId);
    if (event.clientY < 82) window.scrollBy({ top: -14, behavior: "auto" });
    else if (event.clientY > window.innerHeight - 82) window.scrollBy({ top: 14, behavior: "auto" });
  }, []);

  const onDrop = useCallback((sessionId: string, event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const sourceId = draggingSessionId || event.dataTransfer.getData("text/plain");
    if (!sourceId || sourceId === sessionId) {
      setDraggingSessionId(null);
      setDropTargetSessionId(null);
      return;
    }
    const next = moveSessionInOrder(displayedSortedActiveSessions.map((session) => session.id), sourceId, sessionId);
    if (!next) {
      setDraggingSessionId(null);
      setDropTargetSessionId(null);
      return;
    }
    setSessionOrder(next);
    localStorage.setItem(sessionOrderStorageKey, JSON.stringify(next));
    if (sessionSortMode !== "manual") {
      setSessionSortMode("manual");
      localStorage.setItem(sessionSortStorageKey, "manual");
    }
    clearDeferredSort();
    setDraggingSessionId(null);
    setDropTargetSessionId(null);
  }, [clearDeferredSort, draggingSessionId, displayedSortedActiveSessions, sessionSortMode]);

  function showUsage() {
    setUsageOpen(true);
    void refreshUsage();
  }

  async function chooseTheme(theme: ThemeSetting) {
    const api = bridge();
    if (typeof api.setTheme !== "function") {
      notify("テーマ設定APIがありません。CimLineを完全終了して再起動してください。", true);
      return;
    }
    try {
      const savedTheme = await api.setTheme(theme);
      setThemeSetting(savedTheme);
    } catch (error) {
      notify("テーマを保存できません: " + errorText(error), true);
    }
  }

  function toggleSidebar() {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    localStorage.setItem(sidebarCollapsedStorageKey, JSON.stringify(next));
  }

  return (
    <div className={"app-shell" + (sidebarCollapsed ? " is-sidebar-collapsed" : "")}>
      <aside className="sidebar" id="primary-sidebar">
        <div className="brand-lockup">
          <div className="brand-mark"><span /></div>
          <div className="brand-copy"><strong>CimLine</strong><small>CLI WORKSPACE</small></div>
          <button className="sidebar-toggle" type="button" onClick={toggleSidebar} aria-controls="primary-sidebar" aria-expanded={!sidebarCollapsed} aria-label={sidebarCollapsed ? "サイドバーを展開" : "サイドバーを収納"} title={sidebarCollapsed ? "サイドバーを展開" : "サイドバーを収納"}>
            {sidebarCollapsed ? <ChevronRight size={17} /> : <ChevronLeft size={17} />}
          </button>
        </div>
        <button className="sidebar-new" type="button" onClick={() => openComposer()} aria-label="新しいターミナル" title="新しいターミナル"><Plus size={17} /><span>新しいターミナル</span><kbd>{bridge().platform === "darwin" ? "⌘ N" : "Ctrl N"}</kbd></button>
        <nav className="sidebar-nav" aria-label="メインメニュー">
          <button className="sidebar-nav-item is-active" type="button" aria-label="ターミナル" title="ターミナル"><TerminalIcon size={16} /><span>ターミナル</span><span className="nav-count">{sessions.filter((session) => !session.closed).length}</span></button>
          <button className="sidebar-nav-item" type="button" onClick={showUsage} aria-label="使用量" title="使用量"><Activity size={15} /><span>使用量</span></button>
        </nav>
        <Separator className="sidebar-separator" />
        <div className="sidebar-scroll">
          <section className="sidebar-section">
            <div className="sidebar-section-heading"><span>最近使ったフォルダー</span><span>{recentFolders.length}</span></div>
            <div className="recent-folder-list">
              {recentFolders.length ? recentFolders.map((folder) => (
                <button type="button" className="recent-folder" key={folder.path} title={folder.path} onClick={() => openComposer(folder.path)}>
                  <Folder size={14} /><span>{folder.name}</span>
                </button>
              )) : <div className="sidebar-empty">選んだフォルダーがここに並びます。</div>}
            </div>
          </section>
          <section className="sidebar-section history-section">
            <div className="sidebar-section-heading"><span>履歴</span><span>{historySessions.length}</span></div>
            <div className="history-list">
              {historySessions.length ? historySessions.map((session) => (
                <article className={"history-row" + (session.unreviewed && (session.status === "completed" || session.status === "approval") ? ` is-unreviewed is-unreviewed-${session.status}` : "")} key={session.id}>
                  <button type="button" className="history-open" onClick={() => void reopenSession(session.id)} disabled={workingSessionId === session.id} title={session.cwd}>
                    <span className={"history-cli-dot is-" + session.cli} />
                    <span className="history-copy">
                      <strong>{sessionDisplayTitle(session)}</strong>
                      <small>{cliName(session.cli)} · {session.cwd}</small>
                      <span className={"history-status is-" + session.status} title={sessionStatusLabel(session.status) + (statusAgeLabel(session.statusAt, statusClock) ? " " + statusAgeLabel(session.statusAt, statusClock) : "")}>
                        {sessionStatusLabel(session.status)}{statusAgeLabel(session.statusAt, statusClock) && <span className="history-status-age">{statusAgeLabel(session.statusAt, statusClock)}</span>}
                      </span>
                    </span>
                    {workingSessionId === session.id ? <LoaderCircle size={13} className="spin" /> : <RefreshCw size={13} />}
                  </button>
                  <button type="button" className="history-delete" aria-label={sessionDisplayTitle(session) + " の履歴を削除"} title="履歴を削除" onClick={() => void deleteSession(session.id)}><Trash2 size={13} /></button>
                </article>
              )) : <div className="sidebar-empty">{sessionsInitialized ? "閉じたターミナルはありません。" : "履歴を読み込んでいます…"}</div>}
            </div>
          </section>
        </div>
        <div className="sidebar-bottom">
          <div className="cli-state"><span className="connection-dot" /><span>ローカル接続</span></div>
          <p>{cliAvailable.codex ? "Codex" : "Codex 未検出"}<span> · </span>{cliAvailable.claude ? "Claude" : "Claude 未検出"}</p>
        </div>
      </aside>

      <div className="main-column">
        <header className="topbar">
          <div className="topbar-left">
            <label className="search-box"><Search size={14} /><input ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="ターミナルを検索" aria-label="ターミナルを検索" /><kbd>/</kbd></label>
            <button
              className={"review-filter" + (showUnreviewedOnly ? " is-active" : "")}
              type="button"
              aria-label={`未確認のターミナルだけを表示（${reviewFilterCount}件）`}
              aria-pressed={showUnreviewedOnly}
              title={(showUnreviewedOnly ? "未確認のみ表示中" : "未確認のみ表示") + `（${reviewFilterCount}件）`}
              onClick={toggleUnreviewedOnly}
            >
              <CircleDot size={14} aria-hidden="true" />
              <span className="review-filter-label">未確認のみ</span>
              <span className="review-filter-count" aria-hidden="true">{reviewFilterCount}</span>
            </button>
            <label className="sort-control" title="ターミナルの自動並び替え">
              <span>並び順</span>
              <select
                aria-label="ターミナルの並び順"
                value={sessionSortMode}
                onChange={(event) => {
                  const mode = event.currentTarget.value;
                  if (!isSessionSortMode(mode)) return;
                  clearDeferredSort();
                  setSessionSortMode(mode);
                  localStorage.setItem(sessionSortStorageKey, mode);
                }}
              >
                <option value="added-asc">追加日時・古い順</option>
                <option value="added-desc">追加日時・新しい順</option>
                <option value="updated-asc">更新日時・古い順</option>
                <option value="updated-desc">更新日時・新しい順</option>
                <option value="manual">手動（ドラッグ）</option>
              </select>
            </label>
            {sortUpdatePending && <button className="sort-pending" type="button" onClick={clearDeferredSort} title="保留中の並び替えをすぐに適用">並び替えを適用</button>}
          </div>
          <div className="topbar-right">
            <button className="settings-trigger" type="button" aria-label="設定" title="設定" onClick={() => setSettingsOpen(true)}><Settings2 size={15} /><span>設定</span></button>
            <span className="connection-badge"><span className="connection-dot" />ローカル接続</span>
          </div>
        </header>
        {bridgeError && <div className="bridge-error"><AlertCircle size={15} /><span>{bridgeError}</span></div>}
        <main className="workspace" ref={workspaceRef}>
          {filteredActiveSessions.length ? (
            <div
              className={"terminal-grid" + (visibleColumns === 2 ? " has-two-columns" : "")}
              ref={terminalGridRef}
              style={{ gridTemplateColumns: `repeat(${visibleColumns}, minmax(0, 1fr))` }}
            >
              {filteredActiveSessions.map((session) => (
                <TerminalPane
                  key={session.id}
                  session={session}
                  statusLabel={sessionStatusLabel(session.status)}
                  statusAge={statusAgeLabel(session.statusAt, statusClock)}
                  focused={focusedSessionId === session.id}
                  reorderable={true}
                  dragging={draggingSessionId === session.id}
                  dropTarget={dropTargetSessionId === session.id}
                  onClose={closeSession}
                  onFocus={focusSession}
                  onDragStart={onDragStart}
                  onDragOver={onDragOver}
                  onDrop={onDrop}
                  onError={notify}
                />
              ))}
            </div>
          ) : sessionsInitialized ? (
            <section className="empty-workspace">
              <div className="empty-terminal-icon"><TerminalIcon size={25} /></div>
              <h1>{query ? "一致するターミナルがありません" : showUnreviewedOnly ? "未確認のターミナルはありません" : historySessions.length ? "開いているターミナルはありません" : "ターミナルを作成"}</h1>
              <p>{query ? showUnreviewedOnly ? "検索語か未確認フィルターを変えてください。" : "検索語を変えてください。" : showUnreviewedOnly ? "未確認のターミナルが追加されると、ここに表示されます。" : "フォルダーとCLIを選ぶと、すぐに対話できるターミナルが開きます。"}</p>
              {!query && !showUnreviewedOnly && <button type="button" onClick={() => openComposer()}><Plus size={15} />新しいターミナル</button>}
            </section>
          ) : (
            <section className="startup-screen" role="status" aria-live="polite">
              <img className="startup-logo" src="./dailystudio-logo.webp" alt="デイリースタジオ" />
              <h1>CimLine</h1>
              <p>CLI WORKSPACE</p>
              <div className="startup-loading"><LoaderCircle size={16} className="spin" /><span>ターミナルを準備しています…</span></div>
            </section>
          )}
        </main>
      </div>

      <dialog ref={settingsRef} className="app-dialog settings-dialog" onCancel={(event) => { event.preventDefault(); setSettingsOpen(false); }} onClose={() => setSettingsOpen(false)} onClick={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
        <div className="dialog-card">
          <div className="dialog-heading"><div><div className="dialog-kicker">CIMLINE</div><h2>設定</h2><p>表示テーマを選べます。拡大率は Ctrl / Cmd + / − で調整、0 でリセットできます。</p></div><button type="button" className="icon-button" aria-label="閉じる" onClick={() => setSettingsOpen(false)}><X size={17} /></button></div>
          <fieldset className="settings-group">
            <legend>テーマ</legend>
            {([
              ["system", "システムに合わせる", "WindowsまたはmacOSの外観設定を使います。"],
              ["light", "ライト", "明るい配色を使います。"],
              ["dark", "ダーク", "暗い配色を使います。"],
            ] as const).map(([value, label, description]) => (
              <label className={"settings-option" + (themeSetting === value ? " selected" : "")} key={value}>
                <input type="radio" name="theme" value={value} checked={themeSetting === value} onChange={() => void chooseTheme(value)} />
                <span><strong>{label}</strong><small>{description}</small></span>
              </label>
            ))}
          </fieldset>
        </div>
      </dialog>

      <dialog ref={composerRef} className="app-dialog new-session-dialog" onCancel={(event) => { event.preventDefault(); setComposerOpen(false); }} onClose={() => setComposerOpen(false)} onClick={(event) => { if (event.target === event.currentTarget) setComposerOpen(false); }}>
        <form className="dialog-card" onSubmit={createSession}>
          <div className="dialog-heading">
            <div><div className="dialog-kicker">NEW TERMINAL</div><h2>新しいターミナル</h2><p>フォルダーとCLIを選んで、対話型セッションを開始します。</p></div>
            <button type="button" className="icon-button" aria-label="閉じる" onClick={() => setComposerOpen(false)}><X size={17} /></button>
          </div>
          {bridgeError && <div className="inline-error"><AlertCircle size={14} />{bridgeError}</div>}
          <label className="field-label" htmlFor="new-session-folder">作業フォルダー</label>
          <div className="folder-field">
            <FolderOpen size={16} />
            <input id="new-session-folder" value={folderPath} onChange={(event) => { setFolderPath(event.target.value); setFolderPathCopied(false); }} placeholder={defaultDirectory || "フォルダーを選択"} spellCheck={false} required />
            <button type="button" className={"folder-copy-button" + (folderPathCopied ? " is-copied" : "")} aria-label={folderPathCopied ? "パスをコピーしました" : "パスをコピー"} title={folderPathCopied ? "コピー済み" : "パスをコピー"} disabled={!folderPath.trim()} onClick={() => void copyFolderPath()}>{folderPathCopied ? <Check size={14} /> : <Copy size={14} />}{folderPathCopied && <span>コピー済み</span>}</button>
            <button type="button" className="outline-button" onClick={() => void chooseFolder()}>選択</button>
          </div>
          <div className="field-label cli-picker-label">CLI</div>
          <div className="cli-picker">
            <label className={"cli-choice is-codex" + (selectedCli === "codex" ? " is-selected" : "")}>
              <input type="radio" name="cli" value="codex" checked={selectedCli === "codex"} onChange={() => setSelectedCli("codex")} />
              <Code2 size={20} /><span><strong>Codex CLI</strong><small>{cliAvailable.codex ? "利用できます" : "インストールされていない可能性があります"}</small></span>
              {selectedCli === "codex" && <Check size={17} />}
            </label>
            <label className={"cli-choice is-claude" + (selectedCli === "claude" ? " is-selected" : "")}>
              <input type="radio" name="cli" value="claude" checked={selectedCli === "claude"} onChange={() => setSelectedCli("claude")} />
              <Sparkles size={20} /><span><strong>Claude Code</strong><small>{cliAvailable.claude ? "利用できます" : "インストールされていない可能性があります"}</small></span>
              {selectedCli === "claude" && <Check size={17} />}
            </label>
          </div>
          <div className="dialog-footer">
            <span>{cliAvailable[selectedCli] ? "選択したCLIをシェル内で起動します。" : cliName(selectedCli) + "が見つからない場合は環境変数で実行パスを指定できます。"}</span>
            <button type="button" className="text-button" onClick={() => setComposerOpen(false)}>キャンセル</button>
            <button type="submit" className="primary-button" disabled={creatingSession || !folderPath.trim()}>{creatingSession ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />}{creatingSession ? "起動中…" : "作成"}</button>
          </div>
        </form>
      </dialog>

      <dialog ref={usageRef} className="app-dialog usage-dialog" onCancel={(event) => { event.preventDefault(); setUsageOpen(false); }} onClose={() => setUsageOpen(false)} onClick={(event) => { if (event.target === event.currentTarget) setUsageOpen(false); }}>
        <div className="dialog-card">
          <div className="dialog-heading"><div><div className="dialog-kicker">CODEX CLI</div><h2>使用量</h2><p>Codex CLIの5時間枠・週間枠を表示します。Claude Codeは対象外です。</p></div><div className="dialog-heading-actions"><button className="icon-button" type="button" aria-label="利用枠を更新" title="利用枠を更新" onClick={() => void refreshUsage()} disabled={rateLimitsLoading}><RefreshCw size={15} className={rateLimitsLoading ? "spin" : ""} /></button><button type="button" className="icon-button" aria-label="閉じる" onClick={() => setUsageOpen(false)}><X size={17} /></button></div></div>
          {rateLimitsLoading && !rateLimits ? <div className="dialog-state"><LoaderCircle size={16} className="spin" />利用枠を取得しています…</div> : rateWindows.length ? <div className="rate-window-list">{rateWindows.map((window, index) => {
            const used = Math.max(0, Math.min(100, window.usedPercent));
            const remaining = 100 - used;
            const kind = used >= 90 ? " is-critical" : used >= 70 ? " is-warning" : "";
            return <section className={"rate-window" + kind} key={window.windowDurationMins || index}>
              <div className="rate-window-heading"><span>{windowLabel(window)}</span><strong>{Math.round(remaining)}% <small>残り</small></strong></div>
              <div className="rate-window-track"><span style={{ width: used + "%" }} /></div>
              <div className="rate-window-foot"><span>{Math.round(used)}% 使用済み</span><small>リセット {resetLabel(window.resetsAt)}</small></div>
            </section>;
          })}</div> : <div className="dialog-state is-error">{rateLimitsError || "利用枠の情報を取得できませんでした。"}</div>}
          <div className="usage-note"><CircleDot size={12} />Codex CLIの5時間・週間利用枠を表示しています。</div>
        </div>
      </dialog>

      {toast && <div className={"toast" + (toast.error ? " is-error" : "")} role="status">{toast.message}</div>}
    </div>
  );
}
