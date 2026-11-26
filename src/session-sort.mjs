const SORT_MODES = new Set(["manual", "added-asc", "added-desc", "updated-asc", "updated-desc", "completed-asc", "completed-desc"]);

function getPosition(position, id) {
  return position.has(id) ? position.get(id) : Number.MAX_SAFE_INTEGER;
}

function getTimestamp(session, key) {
  const value = session[key];
  if (typeof value !== "string") return null;
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function compareTimestamp(left, right, direction) {
  if (left === right) return 0;
  if (left === null) return direction === "asc" ? -1 : 1;
  if (right === null) return direction === "asc" ? 1 : -1;
  return direction === "asc" ? left - right : right - left;
}

function compareCreatedAtDescending(left, right) {
  return (getTimestamp(right, "createdAt") ?? 0) - (getTimestamp(left, "createdAt") ?? 0);
}

function isCompletedSession(session) {
  return session.status === "completed" || session.status === "approval";
}

/** Sort sessions by manual order, added time, update time, or completion time. */
export function sortSessions(sessions, order, mode) {
  const safeMode = SORT_MODES.has(mode) ? mode : "added-desc";
  const position = new Map((Array.isArray(order) ? order : []).map((id, index) => [id, index]));

  return [...sessions].sort((left, right) => {
    const leftPosition = getPosition(position, left.id);
    const rightPosition = getPosition(position, right.id);

    if (safeMode === "manual") {
      if (leftPosition !== rightPosition) return leftPosition - rightPosition;
      return compareCreatedAtDescending(left, right);
    }

    const direction = safeMode.endsWith("asc") ? "asc" : "desc";
    if (safeMode.startsWith("completed-")) {
      const leftCompleted = isCompletedSession(left);
      const rightCompleted = isCompletedSession(right);
      if (leftCompleted !== rightCompleted) return leftCompleted ? -1 : 1;
    }

    const field = safeMode.startsWith("added-") ? "createdAt" : "statusAt";
    const timestampOrder = compareTimestamp(getTimestamp(left, field), getTimestamp(right, field), direction);
    if (timestampOrder) return timestampOrder;

    if (leftPosition !== rightPosition) return leftPosition - rightPosition;
    return compareCreatedAtDescending(left, right);
  });
}

export function moveSessionInOrder(sessionIds, sourceId, targetId) {
  if (!Array.isArray(sessionIds) || typeof sourceId !== "string" || typeof targetId !== "string" || sourceId === targetId) return null;
  const next = [...sessionIds];
  const sourceIndex = next.indexOf(sourceId);
  const targetIndex = next.indexOf(targetId);
  if (sourceIndex < 0 || targetIndex < 0) return null;
  next.splice(sourceIndex, 1);
  next.splice(targetIndex, 0, sourceId);
  return next;
}

/** Keep the current visual order while letting additions appear at the end. */
export function preserveSessionOrder(sessions, preferredOrder) {
  if (!Array.isArray(sessions)) return [];
  if (!Array.isArray(preferredOrder)) return [...sessions];
  const sessionsById = new Map(sessions.map((session) => [session.id, session]));
  const seen = new Set();
  const preserved = [];
  for (const id of preferredOrder) {
    if (seen.has(id) || !sessionsById.has(id)) continue;
    seen.add(id);
    preserved.push(sessionsById.get(id));
  }
  for (const session of sessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    preserved.push(session);
  }
  return preserved;
}

export function sessionOrderDiffers(sessions, order) {
  if (!Array.isArray(sessions) || !Array.isArray(order)) return false;
  return sessions.length !== order.length || sessions.some((session, index) => session.id !== order[index]);
}

export function isSessionSortMode(value) {
  return SORT_MODES.has(value);
}
