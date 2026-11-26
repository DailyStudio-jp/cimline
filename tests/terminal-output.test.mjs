import assert from "node:assert/strict";
import test from "node:test";
import { ScrollbackClearFilter } from "../src/terminal-output.mjs";

test("removes complete scrollback-clear sequences and keeps surrounding output", () => {
  const filter = new ScrollbackClearFilter();
  assert.equal(filter.push("before\u001b[3Jafter\u001b[3J"), "beforeafter");
  assert.equal(filter.flush(), "");
});

test("removes the sequence when split at every boundary", () => {
  const filter = new ScrollbackClearFilter();
  const output = ["one\u001b", "[", "3", "Jtwo"].map((chunk) => filter.push(chunk)).join("");
  assert.equal(output + filter.flush(), "onetwo");
});

test("preserves other CSI sequences and near matches", () => {
  const filter = new ScrollbackClearFilter();
  const input = "\u001b[2J\u001b[31mred\u001b[33J\u001b[3;1J\u001b[?25l";
  assert.equal(filter.push(input), input);
});

test("flush returns an incomplete possible prefix unchanged", () => {
  const filter = new ScrollbackClearFilter();
  assert.equal(filter.push("output\u001b[3"), "output");
  assert.equal(filter.flush(), "\u001b[3");
  assert.equal(filter.push("J"), "J");
});

test("reset discards a partial sequence before a different stream", () => {
  const filter = new ScrollbackClearFilter();
  assert.equal(filter.push("\u001b["), "");
  filter.reset();
  assert.equal(filter.push("new stream"), "new stream");
});
