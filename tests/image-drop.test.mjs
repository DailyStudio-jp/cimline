import assert from "node:assert/strict";
import test from "node:test";
import {
  buildImagePastePayloads,
  flushQueuedImagePastePayloads,
  isSupportedImageName,
  MAX_DROPPED_IMAGES,
  pasteOrQueueImagePayloads,
  quoteDroppedImagePath,
  sanitizeDroppedImagePaths,
  shouldClearImageDropOverlay,
} from "../src/image-drop.mjs";

test("image detection accepts common CLI image types and rejects ambiguous formats", () => {
  for (const name of ["screenshot.png", "画像.JPG", "photo.jpeg", "motion.gif", "capture.webp"]) {
    assert.equal(isSupportedImageName(name), true, name);
  }
  for (const name of ["notes.txt", "vector.svg", "photo.bmp", "scan.tiff", "camera.heic"]) {
    assert.equal(isSupportedImageName(name), false, name);
  }
  assert.equal(isSupportedImageName(undefined), false);
});

test("dropped paths are safely quoted for Windows and POSIX paths", () => {
  assert.equal(quoteDroppedImagePath("C:\\作業 folder\\画面 1.png", "win32"), '"C:\\作業 folder\\画面 1.png"');
  assert.equal(quoteDroppedImagePath("/tmp/利用者's file.png", "linux"), "'/tmp/利用者'\\''s file.png'");
});

test("multiple image paths become paste payloads without an Enter or newline", () => {
  const payloads = buildImagePastePayloads(["C:\\a.png", "C:\\b.png"], "win32");
  assert.deepEqual(payloads, ['"C:\\a.png"', ' "C:\\b.png"']);
  assert.ok(payloads.every((payload) => !/[\r\n]/.test(payload)));
});

test("the drop overlay clears only after an active file drag leaves its pane", () => {
  assert.equal(shouldClearImageDropOverlay(false, false), false);
  assert.equal(shouldClearImageDropOverlay(true, true), false);
  assert.equal(shouldClearImageDropOverlay(true, false), true);
});

test("invalid paths are skipped and image paste payloads are limited to ten", () => {
  const paths = ["", "bad\npath.png", ...Array.from({ length: 12 }, (_, index) => `C:\\${index}.png`)];
  const payloads = buildImagePastePayloads(paths, "win32");
  assert.equal(payloads.length, MAX_DROPPED_IMAGES);
  assert.equal(payloads[0], '"C:\\0.png"');
  assert.ok(payloads.every((payload) => !/[\r\n]/.test(payload)));
});

test("malformed preload results cannot crash or inject control characters", () => {
  assert.deepEqual(sanitizeDroppedImagePaths(null), []);
  assert.deepEqual(sanitizeDroppedImagePaths(undefined), []);
  assert.deepEqual(sanitizeDroppedImagePaths([null, 42, "", "bad\rpath", "x".repeat(32769), "C:\\valid.png"]), ["C:\\valid.png"]);
  assert.deepEqual(buildImagePastePayloads(null, "win32"), []);
});

test("image paths dropped before terminal initialization are queued and pasted after it is ready", () => {
  const queue = [];
  const pasted = [];
  pasteOrQueueImagePayloads(queue, null, ['"C:\\image.png"']);
  assert.deepEqual(queue, ['"C:\\image.png"']);

  const flushed = flushQueuedImagePastePayloads(queue, { paste: (payload) => pasted.push(payload) });
  assert.equal(flushed, 1);
  assert.deepEqual(queue, []);
  assert.deepEqual(pasted, ['"C:\\image.png"']);
});

test("the pre-initialization queue has a fixed size and reports omitted payloads", () => {
  const queue = [];
  const payloads = Array.from({ length: MAX_DROPPED_IMAGES }, (_, index) => `"C:\\${index}.png"`);
  assert.equal(pasteOrQueueImagePayloads(queue, null, payloads), 0);
  assert.equal(pasteOrQueueImagePayloads(queue, null, ['"C:\\overflow.png"']), 1);
  assert.equal(queue.length, MAX_DROPPED_IMAGES);
});

test("ready terminals receive image paste payloads and focus without submitting them", () => {
  const queue = [];
  const pasted = [];
  let focused = false;
  pasteOrQueueImagePayloads(queue, {
    paste: (payload) => pasted.push(payload),
    focus: () => { focused = true; },
  }, ['"C:\\one.png"', ' "C:\\two.png"']);
  assert.deepEqual(pasted, ['"C:\\one.png"', ' "C:\\two.png"']);
  assert.ok(pasted.every((payload) => !/[\r\n]/.test(payload)));
  assert.equal(focused, true);
  assert.deepEqual(queue, []);
});
