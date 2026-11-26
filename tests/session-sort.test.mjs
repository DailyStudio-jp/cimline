import assert from "node:assert/strict";
import test from "node:test";
import { moveSessionInOrder, sortSessions } from "../src/session-sort.mjs";

const sessions = [
  { id: "older", createdAt: "2026-01-01T00:00:00.000Z", statusAt: "2026-01-01T02:00:00.000Z" },
  { id: "newer", createdAt: "2026-01-03T00:00:00.000Z", statusAt: "2026-01-03T02:00:00.000Z" },
  { id: "middle", createdAt: "2026-01-02T00:00:00.000Z", statusAt: "2026-01-02T02:00:00.000Z" },
  { id: "not-yet-updated", createdAt: "2026-01-04T00:00:00.000Z", statusAt: null },
];

test("added sessions sort in both ascending and descending order", () => {
  assert.deepEqual(sortSessions(sessions, [], "added-asc").map(({ id }) => id), ["older", "middle", "newer", "not-yet-updated"]);
  assert.deepEqual(sortSessions(sessions, [], "added-desc").map(({ id }) => id), ["not-yet-updated", "newer", "middle", "older"]);
});

test("updated sessions sort by status change time and move new activity to the correct end", () => {
  assert.deepEqual(sortSessions(sessions, [], "updated-asc").map(({ id }) => id), ["not-yet-updated", "older", "middle", "newer"]);
  assert.deepEqual(sortSessions(sessions, [], "updated-desc").map(({ id }) => id), ["newer", "middle", "older", "not-yet-updated"]);
});

test("manual order remains available and places new entries by addition date", () => {
  assert.deepEqual(sortSessions(sessions, ["middle", "older"], "manual").map(({ id }) => id), ["middle", "older", "not-yet-updated", "newer"]);
});

test("dragging in an automatic order can preserve the visible order as manual", () => {
  const visibleOrder = sortSessions(sessions, [], "updated-asc").map(({ id }) => id);
  assert.deepEqual(moveSessionInOrder(visibleOrder, "older", "middle"), ["not-yet-updated", "middle", "older", "newer"]);
  assert.equal(moveSessionInOrder(visibleOrder, "older", "missing"), null);
});

test("submitting a prompt refreshes status time and moves the session to the last position", () => {
  const updated = sessions.map((session) => session.id === "middle"
    ? { ...session, statusAt: "2026-01-05T00:00:00.000Z" }
    : session);
  assert.deepEqual(sortSessions(updated, [], "updated-asc").map(({ id }) => id), ["not-yet-updated", "older", "newer", "middle"]);
});

test("ties preserve the existing manual order", () => {
  const tied = sessions.slice(0, 2).map((session) => ({ ...session, createdAt: "2026-01-01T00:00:00.000Z" }));
  assert.deepEqual(sortSessions(tied, ["newer", "older"], "added-asc").map(({ id }) => id), ["newer", "older"]);
});
