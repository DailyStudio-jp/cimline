const SORT_MODES = new Set(["manual", "added-asc", "added-desc", "updated-asc", "updated-desc"]);

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

/** Sort sessions by manual order, added time, or last status update time. */
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

    const [field, direction] = safeMode.startsWith("added-")
      ? ["createdAt", safeMode.endsWith("asc") ? "asc" : "desc"]
      : ["statusAt", safeMode.endsWith("asc") ? "asc" : "desc"];
    const timestampOrder = compareTimestamp(getTimestamp(left, field), getTimestamp(right, field), direction);
    if (timestampOrder) return timestampOrder;

    if (leftPosition !== rightPosition) return leftPosition - rightPosition;
    return compareCreatedAtDescending(left, right);
  });
}

export function isSessionSortMode(value) {
  return SORT_MODES.has(value);
}
