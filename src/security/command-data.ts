/** Project only demonstrably literal data out of command matching. This is not a
 * shell evaluator: ambiguous syntax, substitutions and execution carriers retain
 * the original source. Offsets and command separators stay intact. */
export function commandDetectionSource(source: string): string {
  // Quoted cat heredocs are data only when this is the entire invocation. Keep
  // the destination visible for path policy. Additional commands fall back.
  const heredoc = /^\s*cat\s+>\s*([\w./-]+)\s+<<(['"])([A-Za-z_]\w*)\2\s*\r?\n([\s\S]*?)\r?\n\3\s*$/u.exec(source);
  if (heredoc && !new RegExp(`^${heredoc[3]}\\r?$`, "mu").test(heredoc[4]!)) return source.slice(0, source.indexOf(heredoc[4]!, source.indexOf("\n") + 1)) + "\n";

  type Word = { start: number; end: number; value: string; quoted: boolean };
  const segments: Word[][] = [[]];
  let segment = segments[0]!;
  for (let i = 0; i < source.length;) {
    const char = source[i]!;
    if (/\s/u.test(char)) { if (char === "\n") { segment = []; segments.push(segment); } i++; continue; }
    // Pipelines, substitutions, redirects and shell grouping require contextual
    // evaluation. Do not hide potential code flowing into another command.
    if ("|&()<>`$\\".includes(char)) return source;
    if (char === ";") { segment = []; segments.push(segment); i++; continue; }
    const start = i;
    let value = "", quoted = false;
    while (i < source.length && !/[\s;|&()<>]/u.test(source[i]!)) {
      const c = source[i]!;
      if (c === "'" || c === '"') {
        quoted = true;
        const quote = c;
        i++;
        while (i < source.length && source[i] !== quote) {
          if (quote === '"' && "`$\\".includes(source[i]!)) return source;
          value += source[i++]!;
        }
        if (source[i] !== quote) return source;
        i++;
      } else {
        if ("`$\\".includes(c)) return source;
        value += c; i++;
      }
    }
    segment.push({ start, end: i, value, quoted });
  }
  const carriers = /^(?:.*\/)?(?:sh|bash|dash|zsh|ksh|fish|python[\d.]*|node|bun|deno|ruby|perl|php|Rscript|R|expect|eval|source|exec|xargs|sudo|env|command|time|timeout|\.)$/u;
  if (segments.some(words => words.some(word => carriers.test(word.value)))) return source;
  const masks: Word[] = [];
  for (const words of segments) {
    const name = words[0]?.value;
    if (name === "printf" || name === "echo") masks.push(...words.slice(1).filter(word => word.quoted));
    if (name === "git" && words[1]?.value === "commit") {
      for (let i = 2; i < words.length - 1; i++) {
        if (["-m", "--message"].includes(words[i]!.value) && words[i + 1]!.quoted) masks.push(words[++i]!);
      }
    }
    if (name === "grep" || name === "rg") {
      // Only a first, explicitly quoted pattern after simple flag-only options.
      // Other arguments (including credential paths) remain visible.
      let i = 1;
      while (words[i] && /^-[invHhFlwxc]+$/u.test(words[i]!.value)) i++;
      if (words[i]?.quoted && i < words.length - 1) masks.push(words[i]!);
    }
  }
  let result = source;
  for (const word of masks.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, word.start) + " ".repeat(word.end - word.start) + result.slice(word.end);
  }
  return result;
}
