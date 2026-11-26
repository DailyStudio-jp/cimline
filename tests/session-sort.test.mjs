import assert from "node:assert/strict";
import test from "node:test";
import { sortSessions } from "../src/session-sort.mjs";

const sessions = [
  { id: "older", createdAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T02:00:00.000Z" },
  { id: "newer", createdAt: "2026-01-03T00:00:00.000Z", completedAt: "2026-01-03T02:00:00.000Z" },
  { id: "middle", createdAt: "2026-01-02T00:00:00.000Z", completedAt: "2026-01-02T02:00:00.000Z" },
  { id: "not-yet-completed", createdAt: "2026-01-04T00:00:00.000Z", completedAt: null },
];

test("added sessions sort in both ascending and descending order", () => {
  assert.deepEqual(sortSessions(sessions, [], "added-asc").map(({ id }) => id), ["older", "middle", "newer", "not-yet-completed"]);
  assert.deepEqual(sortSessions(sessions, [], "added-desc").map(({ id }) => id), ["not-yet-completed", "newer", "middle", "older"]);
});

test("completion order sorts by completion time and keeps incomplete sessions last in newest-first order", () => {
  assert.deepEqual(sortSessions(sessions, [], "completed-asc").map(({ id }) => id), ["not-yet-completed", "older", "middle", "newer"]);
  assert.deepEqual(sortSessions(sessions, [], "completed-desc").map(({ id }) => id), ["newer", "middle", "older", "not-yet-completed"]);
});

test("manual order remains available and places new entries by addition date", () => {
  assert.deepEqual(sortSessions(sessions, ["middle", "older"], "manual").map(({ id }) => id), ["middle", "older", "not-yet-completed", "newer"]);
});

test("ties preserve the existing manual order", () => {
  const tied = sessions.slice(0, 2).map((session) => ({ ...session, createdAt: "2026-01-01T00:00:00.000Z" }));
  assert.deepEqual(sortSessions(tied, ["newer", "older"], "added-asc").map(({ id }) => id), ["newer", "older"]);
});
