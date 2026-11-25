const cliLabels = { codex: "Codex CLI", claude: "Claude Code" };

export function isUnreviewedTerminal(session) {
  return Boolean(session?.unreviewed && (session.status === "completed" || session.status === "approval"));
}

function matchesQuery(session, query) {
  const normalizedQuery = query.trim().toLowerCase();
  return !normalizedQuery || [session.title, session.cwd, cliLabels[session.cli] ?? session.cli]
    .some((value) => value.toLowerCase().includes(normalizedQuery));
}

function matchesReviewFilter(session, { showUnreviewedOnly, reviewingSessionId }) {
  return !showUnreviewedOnly || isUnreviewedTerminal(session) || session.id === reviewingSessionId;
}

export function filterActiveSessions(sessions, options = {}) {
  const normalizedOptions = {
    query: options.query ?? "",
    showUnreviewedOnly: options.showUnreviewedOnly ?? false,
    reviewingSessionId: options.reviewingSessionId ?? null,
  };
  return sessions.filter((session) =>
    matchesReviewFilter(session, normalizedOptions) && matchesQuery(session, normalizedOptions.query));
}

export function countReviewFilterResults(sessions, options = {}) {
  const normalizedOptions = {
    query: options.query ?? "",
    showUnreviewedOnly: true,
    reviewingSessionId: options.showUnreviewedOnly ? options.reviewingSessionId ?? null : null,
  };
  return sessions.filter((session) =>
    matchesReviewFilter(session, normalizedOptions) && matchesQuery(session, normalizedOptions.query)).length;
}

export function retainReviewingSessionId(sessions, reviewingSessionId) {
  if (!reviewingSessionId) return null;
  const session = sessions.find((item) => item.id === reviewingSessionId);
  return session && !session.closed && session.status !== "exited" ? reviewingSessionId : null;
}

export function nextReviewingSessionIdAfterReopen(reopenedSessionId, reviewingSessionId) {
  return reopenedSessionId === reviewingSessionId ? null : reviewingSessionId;
}
