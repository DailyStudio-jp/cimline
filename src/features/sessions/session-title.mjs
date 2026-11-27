const CODEX_SPINNER = /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s*/u;
const CLAUDE_ACTIVITY_GLYPH = /^[◐◑✳✢✽✻✶✷✦]\uFE0F?\s*/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const GENERIC_TITLES = new Set([
  "codex",
  "codex cli",
  "claude",
  "claude code",
  "powershell",
  "powershell.exe",
  "windows powershell",
  "pwsh",
  "pwsh.exe",
  "cmd",
  "cmd.exe",
  "command prompt",
  "terminal",
  "zsh",
  "bash",
]);

function cleanTitle(value) {
  return String(value ?? "")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function folderName(cwd) {
  const normalized = String(cwd ?? "").replace(/[\\/]+$/, "");
  return normalized.slice(Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\")) + 1).toLocaleLowerCase();
}

function isGenericTitle(title, cli) {
  const normalized = title.toLocaleLowerCase().replace(/\\/g, "/");
  const executableName = normalized.slice(normalized.lastIndexOf("/") + 1);
  const shellPromptTitle = /^(?:ps\s+)?[a-z]:\/|^~(?:\/|$)|^[^\s@]+@[^:\s]+:\s*~?(?:\/|$)/i.test(normalized);
  return shellPromptTitle || GENERIC_TITLES.has(normalized) || GENERIC_TITLES.has(executableName) || normalized === cli;
}

/**
 * Extract a stable, human-readable session name from the OSC title emitted by a CLI.
 * Codex's default OSC title also contains an activity indicator and project name;
 * Claude Code prefixes its generated title with an activity glyph.
 */
export function getCliSessionTitle(rawTitle, { cli, cwd } = {}) {
  if (cli !== "codex" && cli !== "claude") return null;

  let title = cleanTitle(rawTitle);
  if (!title) return null;

  title = title.replace(/^\[\s*[!.]\s*\]\s*Action Required(?:\s*\|\s*|\s*)/i, "");
  title = title.replace(CODEX_SPINNER, "").replace(CLAUDE_ACTIVITY_GLYPH, "");
  title = title.replace(/^(?:Codex(?: CLI)?|Claude Code|Claude)\s*[|:—-]\s*/i, "");

  const segments = title.split(/\s+\|\s+/).map(cleanTitle).filter(Boolean);
  if (cli === "codex") {
    // Without the default project separator, a Codex title may only be the
    // activity indicator plus project name while the thread is still unnamed.
    if (segments.length < 2) return null;
    // Codex's default order is activity, thread name, project name. The activity
    // glyph is stripped above, and the final project segment duplicates the path.
    segments.pop();
    title = segments.join(" | ");
  } else {
    title = segments.join(" | ");
  }

  title = cleanTitle(title);
  if (!title) return null;

  const pathFolder = folderName(cwd);
  if (pathFolder && folderName(title) === pathFolder) return null;
  if (isGenericTitle(title, cli)) return null;

  return title;
}
