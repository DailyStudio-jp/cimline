import type { CimLineSession } from "./vite-env";

export type SessionSortMode = "manual" | "added-asc" | "added-desc" | "updated-asc" | "updated-desc" | "completed-asc" | "completed-desc";

export function sortSessions(sessions: CimLineSession[], order: string[], mode: SessionSortMode): CimLineSession[];
export function moveSessionInOrder(sessionIds: string[], sourceId: string, targetId: string): string[] | null;
export function preserveSessionOrder<T extends { id: string }>(sessions: T[], preferredOrder: string[] | null): T[];
export function sessionOrderDiffers(sessions: Array<{ id: string }>, order: string[]): boolean;
export function isSessionSortMode(value: unknown): value is SessionSortMode;
