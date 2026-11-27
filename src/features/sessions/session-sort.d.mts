import type { TerminalSession } from "./types";

export type SessionSortMode = "manual" | "added-asc" | "added-desc" | "updated-asc" | "updated-desc" | "completed-asc" | "completed-desc";

export function sortSessions(sessions: TerminalSession[], order: string[], mode: SessionSortMode): TerminalSession[];
export function moveSessionInOrder(sessionIds: string[], sourceId: string, targetId: string): string[] | null;
export function preserveSessionOrder<T extends { id: string }>(sessions: T[], preferredOrder: string[] | null): T[];
export function sessionOrderDiffers(sessions: Array<{ id: string }>, order: string[]): boolean;
export function isSessionSortMode(value: unknown): value is SessionSortMode;
