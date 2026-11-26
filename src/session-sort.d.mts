import type { CimLineSession } from "./vite-env";

export type SessionSortMode = "manual" | "added-asc" | "added-desc" | "updated-asc" | "updated-desc";

export function sortSessions(sessions: CimLineSession[], order: string[], mode: SessionSortMode): CimLineSession[];
export function moveSessionInOrder(sessionIds: string[], sourceId: string, targetId: string): string[] | null;
export function isSessionSortMode(value: unknown): value is SessionSortMode;
