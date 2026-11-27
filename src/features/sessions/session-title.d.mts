import type { SessionCli } from "./types";

export function getCliSessionTitle(rawTitle: string, options: { cli: SessionCli; cwd?: string }): string | null;
