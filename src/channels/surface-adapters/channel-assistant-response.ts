// v0.95 Channel-Safe Assistant Response Renderer
// Strips ANSI, avoids terminal-only frames, produces plain text safe for all channels.

export function renderChannelAssistantResponse(
  label: string,
  text: string,
  options?: { matchedSkills?: readonly string[]; progress?: readonly string[] }
): string {
  const safeLabel = stripAnsi(label) || "Assistant";
  const safeText = stripAnsi(text);
  const lines: string[] = [`${safeLabel}:`, ...safeText.split("\n")];

  if (options?.matchedSkills !== undefined && options.matchedSkills.length > 0) {
    lines.push("");
    lines.push(`skills: ${options.matchedSkills.join(", ")}`);
  }

  if (options?.progress !== undefined && options.progress.length > 0) {
    lines.push(`progress: ${options.progress.join(" -> ")}`);
  }

  return lines.join("\n");
}

function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}
