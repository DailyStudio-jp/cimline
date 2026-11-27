export type FilterableTerminalSession = {
  id: string;
  title: string;
  cwd: string;
  cli: "codex" | "claude";
  status: string;
  unreviewed: boolean;
  closed?: boolean;
};

export type SessionFilterOptions = {
  query?: string;
  showUnreviewedOnly?: boolean;
  reviewingSessionId?: string | null;
};

export function isUnreviewedTerminal(session: FilterableTerminalSession | undefined): boolean;
export function filterActiveSessions<T extends FilterableTerminalSession>(sessions: T[], options?: SessionFilterOptions): T[];
export function countReviewFilterResults(sessions: FilterableTerminalSession[], options?: SessionFilterOptions): number;
export function retainReviewingSessionId(sessions: FilterableTerminalSession[], reviewingSessionId: string | null): string | null;
export function nextReviewingSessionIdAfterReopen(reopenedSessionId: string, reviewingSessionId: string | null): string | null;
