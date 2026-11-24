/// <reference types="vite/client" />

export interface RunLog {
  id: string;
  kind: "user" | "assistant" | "activity" | "command" | "system" | "notice" | "error";
  text: string;
  at: string;
}

export interface RunTask {
  id: string;
  title: string;
  prompt: string;
  cwd: string;
  worktree: boolean;
  usage: TokenUsage;
  status: "running" | "stopping" | "completed" | "failed" | "stopped";
  startedAt: string;
  endedAt: string | null;
  threadId: string | null;
  exitCode: number | null;
  logs: RunLog[];
}

export interface TokenUsage {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  turns: number;
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

export interface InitialState {
  tasks: RunTask[];
  cliAvailable: boolean;
  defaultDirectory: string;
}

export interface CodexDeskApi {
  getState: () => Promise<InitialState>;
  getRateLimits: () => Promise<CodexRateLimits>;
  chooseFolder: () => Promise<string | null>;
  createTask: (input: { cwd: string; prompt: string; title?: string; worktree?: boolean }) => Promise<RunTask>;
  continueTask: (id: string, prompt: string) => Promise<RunTask>;
  stopTask: (id: string) => Promise<RunTask>;
  stopAll: () => Promise<boolean>;
  deleteTask: (id: string) => Promise<boolean>;
  onTasksUpdated: (callback: (tasks: RunTask[]) => void) => () => void;
}

declare global {
  interface Window {
    codexDesk: CodexDeskApi;
  }
}
