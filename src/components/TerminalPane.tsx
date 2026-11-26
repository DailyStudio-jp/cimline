import { memo, useEffect, useRef, useState, type DragEvent as ReactDragEvent } from "react";
import { Terminal as TerminalIcon, X } from "lucide-react";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { buildImagePastePayloads, flushQueuedImagePastePayloads, isSupportedImageName, MAX_DROPPED_IMAGES, pasteOrQueueImagePayloads, shouldClearImageDropOverlay } from "@/image-drop.mjs";
import { getCliSessionTitle } from "@/session-title.mjs";
import { ScrollbackClearFilter } from "@/terminal-output.mjs";
import type { CimLineSession } from "@/vite-env";

export type TerminalSession = CimLineSession;

type PtyBridge = {
  platform?: string;
  attachPty?: (id: string) => Promise<{ buffer: string; sequence: number }>;
  writePty?: (id: string, data: string) => Promise<unknown>;
  setAgentTitle?: (id: string, title: string) => Promise<unknown>;
  setSessionTitle?: (id: string, title: string) => Promise<unknown>;
  resizePty?: (id: string, cols: number, rows: number) => Promise<unknown>;
  onPtyData?: (callback: (event: { sessionId: string; data: string; sequence: number }) => void) => () => void;
  onPtyExit?: (callback: (event: { sessionId: string; exitCode: number | null; signal: number | null }) => void) => () => void;
  readClipboardText?: () => Promise<string>;
  writeClipboardText?: (text: string) => Promise<void>;
  getDroppedImagePaths?: (files: File[]) => string[];
};

type Props = {
  session: TerminalSession;
  statusLabel: string;
  statusAge: string;
  focused: boolean;
  reorderable: boolean;
  dragging: boolean;
  dropTarget: boolean;
  onClose: (sessionId: string) => void;
  onFocus: (sessionId: string) => void;
  onDragStart: (sessionId: string, event: ReactDragEvent<HTMLElement>) => void;
  onDragOver: (sessionId: string, event: ReactDragEvent<HTMLElement>) => void;
  onDrop: (sessionId: string, event: ReactDragEvent<HTMLElement>) => void;
  onError: (message: string) => void;
};

function getBridge(): PtyBridge {
  return (window.codexDesk || {}) as unknown as PtyBridge;
}

function hasFileItems(event: ReactDragEvent<HTMLElement>) {
  return Array.from(event.dataTransfer.items).some((item) => item.kind === "file")
    || Array.from(event.dataTransfer.types).includes("Files");
}

const DARK_TERMINAL_THEME = {
  background: "#10110f",
  foreground: "#e5e8df",
  cursor: "#c8f36c",
  cursorAccent: "#10110f",
  selectionBackground: "#556a3980",
  black: "#171914",
  red: "#ee8e80",
  green: "#b9df72",
  yellow: "#e7c86f",
  blue: "#91b9e0",
  magenta: "#d3a8db",
  cyan: "#92d7d0",
  white: "#e4e8dc",
  brightBlack: "#7b8073",
  brightRed: "#ffaca0",
  brightGreen: "#d4fa8c",
  brightYellow: "#ffe39a",
  brightBlue: "#b5d5f6",
  brightMagenta: "#e6b9ed",
  brightCyan: "#b0efea",
  brightWhite: "#ffffff",
};

const LIGHT_TERMINAL_THEME = {
  background: "#f6f7f3",
  foreground: "#24261f",
  cursor: "#526b21",
  cursorAccent: "#f6f7f3",
  selectionBackground: "#b8d98480",
  black: "#20221c",
  red: "#9f382c",
  green: "#4f6e1e",
  yellow: "#75520b",
  blue: "#2f5c83",
  magenta: "#74477b",
  cyan: "#28645e",
  white: "#e3e6de",
  brightBlack: "#6e7268",
  brightRed: "#79291f",
  brightGreen: "#3d5816",
  brightYellow: "#614306",
  brightBlue: "#244b70",
  brightMagenta: "#60376a",
  brightCyan: "#1d504b",
  brightWhite: "#ffffff",
};

function terminalThemeForSystem(): typeof DARK_TERMINAL_THEME {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME;
}

function TerminalPaneView({ session, statusLabel, statusAge, focused, reorderable, dragging, dropTarget, onClose, onFocus, onDragStart, onDragOver, onDrop, onError }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const pendingImagePastePayloadsRef = useRef<string[]>([]);
  const latestSessionTitleRef = useRef(session.agentTitle);
  const pendingSessionTitleRef = useRef<string | null>(null);
  const sessionTitleTimerRef = useRef<number | null>(null);
  const [imageDropActive, setImageDropActive] = useState(false);
  const displayTitle = session.agentTitle || session.title;
  latestSessionTitleRef.current = session.agentTitle;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const bridge = getBridge();
    const terminal = new XTerm({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: '"Cascadia Code", "Cascadia Mono", "SFMono-Regular", Consolas, "Liberation Mono", monospace',
      fontSize: 14,
      lineHeight: 1.25,
      scrollback: 10000,
      theme: terminalThemeForSystem(),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    let disposed = false;
    let attached = false;
    let lastSequence = -1;
    const scrollbackFilter = new ScrollbackClearFilter();
    const colorScheme = window.matchMedia("(prefers-color-scheme: light)");
    const updateTerminalTheme = () => {
      terminal.options.theme = colorScheme.matches ? LIGHT_TERMINAL_THEME : DARK_TERMINAL_THEME;
    };
    colorScheme.addEventListener("change", updateTerminalTheme);
    const queuedEvents: Array<{ data: string; sequence: number }> = [];

    const writeEvent = (event: { data: string; sequence: number }) => {
      if (!Number.isFinite(event.sequence) || event.sequence <= lastSequence) return;
      terminal.write(scrollbackFilter.push(event.data));
      lastSequence = event.sequence;
    };
    const unsubscribeData = bridge.onPtyData?.((event) => {
      if (event.sessionId !== session.id) return;
      if (!attached) queuedEvents.push({ data: event.data, sequence: event.sequence });
      else writeEvent(event);
    });
    const unsubscribeExit = bridge.onPtyExit?.((event) => {
      if (event.sessionId !== session.id) return;
      const trailingOutput = scrollbackFilter.flush();
      if (trailingOutput) terminal.write(trailingOutput);
      if (!disposed && event.exitCode !== null && event.exitCode !== 0) {
        onError("ターミナルプロセスが終了しました (exit " + event.exitCode + ")");
      }
    });
    const dataDisposable = terminal.onData((data) => {
      if (typeof bridge.writePty !== "function") {
        onError("PTY入力APIがありません。CimLineを完全終了して再起動してください。");
        return;
      }
      void bridge.writePty(session.id, data).catch((error) => onError("入力を送信できません: " + String(error)));
    });
    const titleDisposable = terminal.onTitleChange((rawTitle) => {
      const updateSessionTitle = bridge.setAgentTitle || bridge.setSessionTitle;
      if (typeof updateSessionTitle !== "function") return;
      const title = getCliSessionTitle(rawTitle, { cli: session.cli, cwd: session.cwd });
      if (!title || title === latestSessionTitleRef.current || title === pendingSessionTitleRef.current) return;
      pendingSessionTitleRef.current = title;
      if (sessionTitleTimerRef.current !== null) window.clearTimeout(sessionTitleTimerRef.current);
      sessionTitleTimerRef.current = window.setTimeout(() => {
        sessionTitleTimerRef.current = null;
        pendingSessionTitleRef.current = null;
        if (title === latestSessionTitleRef.current) return;
        void updateSessionTitle(session.id, title).catch((error) => onError("セッション名を更新できません: " + String(error)));
      }, 1800);
    });
    flushQueuedImagePastePayloads(pendingImagePastePayloadsRef.current, terminal);
    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (typeof bridge.resizePty === "function") void bridge.resizePty(session.id, cols, rows).catch(() => {});
    });
    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit();
      } catch {
        // Ignore transient zero-size layout while the grid is mounting.
      }
    });
    resizeObserver.observe(host);

    const copySelection = () => {
      const selectedText = terminal.getSelection();
      if (!selectedText) return false;
      if (typeof bridge.writeClipboardText !== "function") {
        onError("クリップボードAPIがありません。CimLineを再起動してください。");
        return true;
      }
      void bridge.writeClipboardText(selectedText).catch((error) => onError("コピーに失敗しました: " + String(error)));
      return true;
    };
    const pasteClipboard = () => {
      if (typeof bridge.readClipboardText !== "function") {
        onError("クリップボードAPIがありません。CimLineを再起動してください。");
        return;
      }
      void bridge.readClipboardText().then((text) => {
        if (text) terminal.paste(text);
      }).catch((error) => onError("貼り付けに失敗しました: " + String(error)));
    };
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const key = event.key.toLowerCase();
      const isMac = bridge.platform === "darwin";
      const command = isMac ? event.metaKey : event.ctrlKey;
      const copyShortcut = command && key === "c";
      const pasteShortcut = command && key === "v";
      if (!isMac && event.ctrlKey && event.shiftKey && key === "c") {
        copySelection();
        return false;
      }
      if (copyShortcut) {
        if (terminal.hasSelection()) {
          copySelection();
          return false;
        }
        return isMac ? false : true;
      }
      if (pasteShortcut || (!isMac && event.ctrlKey && event.shiftKey && key === "v")) {
        pasteClipboard();
        return false;
      }
      return true;
    });
    host.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      if (!copySelection()) pasteClipboard();
    });

    if (typeof bridge.attachPty !== "function") {
      onError("PTY接続APIがありません。CimLineを完全終了して再起動してください。");
      terminal.writeln("\x1b[31mこの画面とElectron本体のバージョンが一致しません。\x1b[0m");
    } else {
      void bridge.attachPty(session.id).then((snapshot) => {
        if (disposed) return;
        terminal.reset();
        scrollbackFilter.reset();
        terminal.write(scrollbackFilter.push(snapshot.buffer || ""));
        lastSequence = Number.isFinite(snapshot.sequence) ? snapshot.sequence : -1;
        attached = true;
        queuedEvents.sort((left, right) => left.sequence - right.sequence).forEach(writeEvent);
        queuedEvents.length = 0;
      }).catch((error) => {
        if (!disposed) {
          onError("ターミナルへ接続できません: " + String(error));
          terminal.writeln("\x1b[31mターミナルへ接続できませんでした。\x1b[0m");
        }
      });
    }

    requestAnimationFrame(() => {
      try {
        fitAddon.fit();
        if (focused) terminal.focus();
      } catch {
        // The terminal will be fit again when ResizeObserver fires.
      }
    });
    return () => {
      disposed = true;
      resizeObserver.disconnect();
      colorScheme.removeEventListener("change", updateTerminalTheme);
      unsubscribeData?.();
      unsubscribeExit?.();
      dataDisposable.dispose();
      titleDisposable.dispose();
      if (sessionTitleTimerRef.current !== null) window.clearTimeout(sessionTitleTimerRef.current);
      sessionTitleTimerRef.current = null;
      pendingSessionTitleRef.current = null;
      resizeDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [session.id, onError]);

  useEffect(() => {
    if (!focused || !terminalRef.current) return;
    try {
      fitAddonRef.current?.fit();
      terminalRef.current.focus();
    } catch {
      // The ResizeObserver will retry after the pane has a measurable size.
    }
  }, [focused]);

  const unreviewed = session.unreviewed && (session.status === "completed" || session.status === "approval");
  const statusDescription = statusAge ? `${statusLabel} ${statusAge}` : statusLabel;

  const handleImageDrop = (event: ReactDragEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setImageDropActive(false);
    const files = Array.from(event.dataTransfer.files).filter((file) => isSupportedImageName(file.name)).slice(0, MAX_DROPPED_IMAGES);
    if (!files.length) {
      onError("PNG、JPEG、GIF、WebPの画像をドロップしてください。");
      return;
    }
    const bridge = getBridge();
    if (typeof bridge.getDroppedImagePaths !== "function") {
      onError("画像ドロップAPIがありません。CimLineを完全終了して再起動してください。");
      return;
    }
    let paths: unknown;
    try {
      paths = bridge.getDroppedImagePaths(files);
    } catch (error) {
      onError("画像パスを取得できません: " + String(error));
      return;
    }
    const pastePayloads = buildImagePastePayloads(paths, bridge.platform);
    if (!pastePayloads.length) {
      onError("ドロップした画像のパスを取得できませんでした。");
      return;
    }
    const terminal = terminalRef.current;
    const notQueuedCount = pasteOrQueueImagePayloads(pendingImagePastePayloadsRef.current, terminal, pastePayloads);
    if (notQueuedCount) onError(`${notQueuedCount}枚はターミナル準備前の上限を超えたため、もう一度ドロップしてください。`);
    onFocus(session.id);
  };

  return (
    <article
      data-session-id={session.id}
      className={"terminal-pane" + (reorderable ? " is-reorderable" : "") + (dragging ? " is-dragging" : "") + (dropTarget ? " is-drop-target" : "") + (focused ? " is-focused" : "") + (unreviewed ? ` is-unreviewed is-unreviewed-${session.status}` : "")}
      aria-label={(session.cli === "codex" ? "Codex" : "Claude") + " terminal " + displayTitle}
      onMouseDown={() => onFocus(session.id)}
      onFocusCapture={() => onFocus(session.id)}
      onDragEnter={(event) => {
        if (!hasFileItems(event)) return;
        event.preventDefault();
        event.stopPropagation();
        setImageDropActive(true);
      }}
      onDragOver={(event) => {
        if (!hasFileItems(event)) {
          onDragOver(session.id, event);
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "copy";
        setImageDropActive(true);
      }}
      onDragLeave={(event) => {
        if (!imageDropActive) return;
        event.preventDefault();
        event.stopPropagation();
        const relatedTarget = event.relatedTarget;
        const relatedTargetInsidePane = relatedTarget instanceof Node && event.currentTarget.contains(relatedTarget);
        if (shouldClearImageDropOverlay(imageDropActive, relatedTargetInsidePane)) setImageDropActive(false);
      }}
      onDrop={(event) => {
        if (!hasFileItems(event)) {
          onDrop(session.id, event);
          return;
        }
        handleImageDrop(event);
      }}
    >
      <header className="terminal-titlebar" draggable={reorderable} onDragStart={(event) => { if (reorderable) onDragStart(session.id, event); else event.preventDefault(); }}>
        <div className="terminal-lights" aria-hidden="true"><i /><i /><i /></div>
        <div className="terminal-context">
          <TerminalIcon size={15} />
          <span className="terminal-title" title={displayTitle}>{displayTitle}</span>
          <span className="terminal-separator">/</span>
          <span className="terminal-path" title={session.cwd}>{session.cwd}</span>
        </div>
        <div className="terminal-header-meta">
          <span className={"terminal-status is-" + session.status} title={statusDescription}>
            {statusLabel}{statusAge && <span className="terminal-status-age">{statusAge}</span>}
          </span>
          <span className={"cli-badge is-" + session.cli}>{session.cli === "codex" ? "Codex CLI" : "Claude Code"}</span>
        </div>
        <button className="terminal-close" type="button" title="ターミナルを閉じる" aria-label={displayTitle + " を閉じる"} onDragStart={(event) => event.preventDefault()} onClick={(event) => { event.stopPropagation(); onClose(session.id); }}><X size={16} /></button>
      </header>
      <div className="terminal-body">
        {imageDropActive && <div className="image-drop-overlay" aria-hidden="true">画像をドロップして添付</div>}
        <div ref={hostRef} className="xterm-host" />
      </div>
    </article>
  );
}

export const TerminalPane = memo(TerminalPaneView);
