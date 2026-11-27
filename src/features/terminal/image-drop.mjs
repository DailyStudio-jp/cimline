export const MAX_DROPPED_IMAGES = 10;

const imageFilePattern = /\.(png|jpe?g|gif|webp)$/i;

export function isSupportedImageName(fileName) {
  return typeof fileName === "string" && imageFilePattern.test(fileName);
}

export function shouldClearImageDropOverlay(isActive, relatedTargetInsidePane) {
  return isActive && !relatedTargetInsidePane;
}

export function quoteDroppedImagePath(filePath, platform) {
  if (platform === "win32") return `"${filePath.replace(/"/g, "\\\"")}"`;
  return "'" + filePath.replace(/'/g, "'\\''") + "'";
}

export function sanitizeDroppedImagePaths(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((filePath) =>
    typeof filePath === "string" && filePath.length > 0 && filePath.length <= 32768
      && !/[\u0000-\u001f\u007f]/.test(filePath));
}

export function buildImagePastePayloads(filePaths, platform) {
  return sanitizeDroppedImagePaths(filePaths)
    .slice(0, MAX_DROPPED_IMAGES)
    .map((filePath, index) => (index > 0 ? " " : "") + quoteDroppedImagePath(filePath, platform));
}

export function pasteOrQueueImagePayloads(queue, terminal, payloads) {
  if (!terminal) {
    const available = Math.max(0, MAX_DROPPED_IMAGES - queue.length);
    queue.push(...payloads.slice(0, available));
    return Math.max(0, payloads.length - available);
  }
  payloads.forEach((payload) => terminal.paste(payload));
  terminal.focus();
  return 0;
}

export function flushQueuedImagePastePayloads(queue, terminal) {
  const payloads = queue.splice(0);
  payloads.forEach((payload) => terminal.paste(payload));
  return payloads.length;
}
