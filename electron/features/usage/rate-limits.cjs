function normalizeRateLimitWindow(window) {
  if (!window || typeof window !== "object") return null;
  const usedPercent = Number(window.usedPercent ?? window.used_percent);
  if (!Number.isFinite(usedPercent)) return null;
  const duration = window.windowDurationMins ?? window.window_duration_mins;
  const resetsAt = window.resetsAt ?? window.resets_at;
  const normalizedDuration = duration == null ? null : Number(duration);
  const normalizedReset = resetsAt == null ? null : Number(resetsAt);
  return {
    usedPercent,
    windowDurationMins: Number.isFinite(normalizedDuration) ? normalizedDuration : null,
    resetsAt: Number.isFinite(normalizedReset) ? normalizedReset : null,
  };
}

function selectCodexRateLimits(result) {
  if (!result || typeof result !== "object") return null;

  const buckets = result.rateLimitsByLimitId ?? result.rate_limits_by_limit_id;
  let snapshot = null;
  if (buckets != null) {
    if (typeof buckets === "object" && !Array.isArray(buckets) && Object.prototype.hasOwnProperty.call(buckets, "codex")) {
      snapshot = buckets.codex;
    }
  } else {
    const legacy = result.rateLimits ?? result.rate_limits;
    const limitId = legacy?.limitId ?? legacy?.limit_id;
    if (legacy && typeof legacy === "object" && (!limitId || limitId === "codex")) snapshot = legacy;
  }

  if (!snapshot || typeof snapshot !== "object") return null;
  const primary = normalizeRateLimitWindow(snapshot.primary);
  const secondary = normalizeRateLimitWindow(snapshot.secondary);
  if (!primary && !secondary) return null;
  return { primary, secondary };
}

module.exports = { selectCodexRateLimits };
