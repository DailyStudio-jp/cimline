const test = require("node:test");
const assert = require("node:assert/strict");
const { selectCodexRateLimits } = require("../electron/features/usage/rate-limits.cjs");

const window = (usedPercent, windowDurationMins, resetsAt) => ({ usedPercent, windowDurationMins, resetsAt });

test("prefers only the Codex bucket in the current app-server response", () => {
  const result = selectCodexRateLimits({
    rateLimitsByLimitId: {
      codex_bengalfox: { primary: window(99, 60, 10), secondary: window(98, 10080, 20) },
      codex: { primary: window(25, 300, 30), secondary: window(40, 10080, 40) },
    },
    rateLimits: { primary: window(90, 300, 50), secondary: window(90, 10080, 60) },
  });

  assert.deepEqual(result, {
    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 30 },
    secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 40 },
  });
});

test("supports snake-case Codex buckets and window fields", () => {
  const result = selectCodexRateLimits({
    rate_limits_by_limit_id: {
      codex: {
        primary: { used_percent: 12.5, window_duration_mins: 300, resets_at: 1234 },
        secondary: null,
      },
    },
  });

  assert.deepEqual(result, {
    primary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1234 },
    secondary: null,
  });
});

test("falls back to the legacy Codex rate limits response", () => {
  assert.deepEqual(selectCodexRateLimits({
    rateLimits: {
      limitId: "codex",
      primary: window(15, 300, 100),
      secondary: window(35, 10080, 200),
    },
  }), {
    primary: { usedPercent: 15, windowDurationMins: 300, resetsAt: 100 },
    secondary: { usedPercent: 35, windowDurationMins: 10080, resetsAt: 200 },
  });

  assert.deepEqual(selectCodexRateLimits({
    rate_limits: { primary: { used_percent: 22 } },
  }), {
    primary: { usedPercent: 22, windowDurationMins: null, resetsAt: null },
    secondary: null,
  });
});

test("does not show a non-Codex legacy bucket or substitute another bucket", () => {
  assert.equal(selectCodexRateLimits({
    rateLimits: { limitId: "codex_bengalfox", primary: window(99, 300, 100) },
  }), null);
  assert.equal(selectCodexRateLimits({
    rateLimitsByLimitId: { codex_bengalfox: { primary: window(99, 300, 100) } },
    rateLimits: { primary: window(80, 300, 100) },
  }), null);
});

test("ignores malformed or empty usage windows", () => {
  assert.equal(selectCodexRateLimits({
    rateLimitsByLimitId: {
      codex: {
        primary: { usedPercent: "unknown", windowDurationMins: 300 },
        secondary: null,
      },
    },
  }), null);
});
