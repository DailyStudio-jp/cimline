import assert from "node:assert/strict";
import test from "node:test";
import {
  countReviewFilterResults,
  filterActiveSessions,
  isUnreviewedTerminal,
  nextReviewingSessionIdAfterReopen,
  retainReviewingSessionId,
} from "../src/session-filter.mjs";

const sessions = [
  { id: "done", title: "Build UI", cwd: "F:/cimline", cli: "codex", status: "completed", unreviewed: true, closed: false },
  { id: "approval", title: "Review API", cwd: "F:/service", cli: "claude", status: "approval", unreviewed: true, closed: false },
  { id: "running", title: "Running", cwd: "F:/worker", cli: "codex", status: "running", unreviewed: true, closed: false },
  { id: "reviewed", title: "Old work", cwd: "F:/archive", cli: "claude", status: "completed", unreviewed: false, closed: false },
];

test("only completed or approval sessions marked unreviewed enter the review filter", () => {
  assert.equal(isUnreviewedTerminal(sessions[0]), true);
  assert.equal(isUnreviewedTerminal(sessions[1]), true);
  assert.equal(isUnreviewedTerminal(sessions[2]), false);
  assert.equal(isUnreviewedTerminal(sessions[3]), false);
  assert.deepEqual(filterActiveSessions(sessions, { showUnreviewedOnly: true }).map(({ id }) => id), ["done", "approval"]);
});

test("search and review filter intersect without changing the default full list", () => {
  assert.deepEqual(filterActiveSessions(sessions).map(({ id }) => id), ["done", "approval", "running", "reviewed"]);
  assert.deepEqual(filterActiveSessions(sessions, { query: "  SERVICE ", showUnreviewedOnly: true }).map(({ id }) => id), ["approval"]);
  assert.deepEqual(filterActiveSessions(sessions, { query: "claude" }).map(({ id }) => id), ["approval", "reviewed"]);
});

test("the active item stays visible while it is being reviewed, then leaves when focus moves", () => {
  const acknowledged = sessions.map((session) => session.id === "done" ? { ...session, unreviewed: false } : session);
  assert.deepEqual(filterActiveSessions(acknowledged, { showUnreviewedOnly: true, reviewingSessionId: "done" }).map(({ id }) => id), ["done", "approval"]);
  assert.deepEqual(filterActiveSessions(acknowledged, { showUnreviewedOnly: true, reviewingSessionId: "approval" }).map(({ id }) => id), ["approval"]);
  assert.deepEqual(filterActiveSessions(acknowledged, { showUnreviewedOnly: true }).map(({ id }) => id), ["approval"]);
});

test("the badge count reflects search, true unreviewed items, and the current review item", () => {
  assert.equal(countReviewFilterResults(sessions), 2);
  assert.equal(countReviewFilterResults(sessions, { query: "service" }), 1);
  assert.equal(countReviewFilterResults(sessions, { showUnreviewedOnly: true, reviewingSessionId: "running" }), 3);
});

test("closed, exited, and deleted review sessions cannot leave a stale pin for a reopened id", () => {
  assert.equal(retainReviewingSessionId(sessions, "done"), "done");
  const closedPin = retainReviewingSessionId([{ ...sessions[0], closed: true }], "done");
  assert.equal(closedPin, null);
  assert.equal(retainReviewingSessionId([{ ...sessions[0], status: "exited" }], "done"), null);
  assert.equal(retainReviewingSessionId(sessions.filter(({ id }) => id !== "done"), "done"), null);
  const staleExitPin = retainReviewingSessionId([{ ...sessions[0], status: "exited", unreviewed: false }], "done");
  assert.equal(staleExitPin, null);
  const reopenedSession = { ...sessions[0], status: "idle", unreviewed: false, closed: false };
  const immediateReopenPin = nextReviewingSessionIdAfterReopen(reopenedSession.id, "done");
  assert.equal(immediateReopenPin, null);
  assert.deepEqual(filterActiveSessions([reopenedSession], { showUnreviewedOnly: true, reviewingSessionId: immediateReopenPin }), []);
  assert.equal(nextReviewingSessionIdAfterReopen("other", "done"), "done");
});
