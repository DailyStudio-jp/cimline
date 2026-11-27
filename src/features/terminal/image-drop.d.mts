export const MAX_DROPPED_IMAGES: number;
export function isSupportedImageName(fileName: string): boolean;
export function shouldClearImageDropOverlay(isActive: boolean, relatedTargetInsidePane: boolean): boolean;
export function quoteDroppedImagePath(filePath: string, platform?: string): string;
export function sanitizeDroppedImagePaths(value: unknown): string[];
export function buildImagePastePayloads(filePaths: unknown, platform?: string): string[];
export function pasteOrQueueImagePayloads(queue: string[], terminal: { paste(payload: string): void; focus(): void } | null, payloads: string[]): number;
export function flushQueuedImagePastePayloads(queue: string[], terminal: { paste(payload: string): void }): number;
