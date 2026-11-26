import type { CimLineSession } from "./vite-env";

export type SessionSortMode = "manual" | "added-asc" | "added-desc" | "completed-asc" | "completed-desc";

export function sortSessions(sessions: CimLineSession[], order: string[], mode: SessionSortMode): CimLineSession[];
export function isSessionSortMode(value: unknown): value is SessionSortMode;
