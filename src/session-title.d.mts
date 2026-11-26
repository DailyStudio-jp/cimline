import type { SessionCli } from "./vite-env";

export function getCliSessionTitle(rawTitle: string, options: { cli: SessionCli; cwd?: string }): string | null;
