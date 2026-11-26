/// <reference types="vite/client" />

export type SessionCli = "claude" | "codex";
export type SessionStatus = "idle" | "running" | "completed" | "approval" | "exited";

export interface CimLineSession {
  id: string;
  title: string;
  cwd: string;
  cli: SessionCli;
  closed: boolean;
  createdAt: string;
  status: SessionStatus;
  statusAt: string | null;
  unreviewed: boolean;
}

export interface InitialState {
  sessions: CimLineSession[];
  cliAvailable: Record<SessionCli, boolean>;
  defaultDirectory: string;
}

export interface PtySnapshot {
  buffer: string;
  sequence: number;
}

export interface PtyDataEvent {
  sessionId: string;
  data: string;
  sequence: number;
}

export interface PtyExitEvent {
  sessionId: string;
  exitCode: number | null;
  signal: number | null;
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface CodexRateLimits {
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
}

export interface CodexDeskApi {
  platform: "win32" | "darwin" | "linux";
  getState: () => Promise<InitialState>;
  getRateLimits: () => Promise<CodexRateLimits>;
  chooseFolder: () => Promise<string | null>;
  createSession: (input: { cwd: string; cli: SessionCli }) => Promise<CimLineSession>;
  setSessionTitle: (id: string, title: string) => Promise<boolean>;
  closeSession: (id: string) => Promise<CimLineSession>;
  reopenSession: (id: string) => Promise<CimLineSession>;
  deleteSession: (id: string) => Promise<boolean>;
  attachPty: (id: string) => Promise<PtySnapshot>;
  writePty: (id: string, data: string) => Promise<void>;
  resizePty: (id: string, cols: number, rows: number) => Promise<void>;
  readClipboardText: () => Promise<string>;
  writeClipboardText: (text: string) => Promise<void>;
  getDroppedImagePaths?: (files: File[]) => string[];
  setFocusedSession?: (id: string | null) => Promise<unknown>;
  onSessionsUpdated: (callback: (sessions: CimLineSession[]) => void) => () => void;
  onPtyData: (callback: (event: PtyDataEvent) => void) => () => void;
  onPtyExit: (callback: (event: PtyExitEvent) => void) => () => void;
}

declare global {
  interface Window {
    codexDesk: CodexDeskApi;
  }
}
