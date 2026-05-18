import type { EnvironmentType } from "../contracts/security.js";
import type { ToolRiskClass } from "../contracts/tool.js";

export type { EnvironmentType } from "../contracts/security.js";

export type CommandSafetySeverity = "critical" | "high" | "medium" | "low";

export type HardCommandBlockCode =
  | "destructive-delete-root-or-broad-path"
  | "disk-destructive"
  | "system-power"
  | "fork-bomb-or-killall"
  | "secret-read"
  | "pipe-to-interpreter"
  | "inline-code-destructive"
  | "git-force-push"
  | "container-escape"
  | "privilege-escalation"
  | "network-exfil"
  | "crypto-mining"
  | "sql-destructive"
  | "self-termination"
  | "firewall-flush"
  | "permission-destruction"
  | "device-overwrite"
  | "package-removal-system"
  | "git-destructive"
  | "terraform-destruction";

export type CommandSafetyAssessment = {
  normalized: string;
  riskClass?: ToolRiskClass;
  severity?: CommandSafetySeverity;
  hardBlock?: {
    code: HardCommandBlockCode;
    reason: string;
    severity: CommandSafetySeverity;
  };
};

type Detection = {
  code: HardCommandBlockCode;
  reason: string;
  riskClass?: ToolRiskClass;
  severity: CommandSafetySeverity;
};

export function assessCommandSafety(
  command: string,
  options: { environmentType?: EnvironmentType } = {}
): CommandSafetyAssessment {
  const normalized = normalizeCommandForSafety(command);
  const environmentType = options.environmentType ?? "host";
  const hardline = detectHardlineBlock(normalized);

  if (hardline !== undefined) {
    return toAssessment(normalized, hardline);
  }

  if (environmentType === "host") {
    const hostBlock = detectHostOnlyBlock(normalized);
    if (hostBlock !== undefined) {
      return toAssessment(normalized, hostBlock);
    }
  }

  const riskClass = inferRiskClass(normalized, environmentType);
  return {
    normalized,
    riskClass,
    severity: riskClass === undefined ? undefined : "medium"
  };
}

export function normalizeCommandForSafety(value: string): string {
  return stripAnsi(value.normalize("NFKC")).trim().replace(/\s+/gu, " ");
}

function toAssessment(normalized: string, detection: Detection): CommandSafetyAssessment {
  return {
    normalized,
    riskClass: detection.riskClass ?? inferRiskClass(normalized, "host"),
    severity: detection.severity,
    hardBlock: {
      code: detection.code,
      reason: detection.reason,
      severity: detection.severity
    }
  };
}

function stripAnsi(value: string): string {
  return value.replace(
    // Covers CSI, OSC, and one-byte ANSI escape sequences.
    /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/gu,
    ""
  );
}

function inferRiskClass(command: string, environmentType: EnvironmentType): ToolRiskClass | undefined {
  if (looksCredentialSeeking(command)) {
    return "credential-access";
  }

  if (environmentType === "host" && looksDestructive(command)) {
    return "destructive-local";
  }

  return undefined;
}

function detectHardlineBlock(command: string): Detection | undefined {
  if (matchesRootDelete(command)) {
    return {
      code: "destructive-delete-root-or-broad-path",
      reason: "command attempts recursive deletion of the filesystem root or root glob",
      riskClass: "destructive-local",
      severity: "critical"
    };
  }

  if (matchesHardlineDiskDestructive(command)) {
    return {
      code: "device-overwrite",
      reason: "command targets destructive disk formatting or device overwrite operations",
      riskClass: "destructive-local",
      severity: "critical"
    };
  }

  if (matchesForkBomb(command)) {
    return {
      code: "fork-bomb-or-killall",
      reason: "command matches a fork-bomb pattern",
      riskClass: "destructive-local",
      severity: "critical"
    };
  }

  if (matchesHardlinePermissionDestruction(command)) {
    return {
      code: "permission-destruction",
      reason: "command recursively destroys root filesystem permissions",
      riskClass: "destructive-local",
      severity: "critical"
    };
  }

  if (matchesSelfTermination(command)) {
    return {
      code: "self-termination",
      reason: "command attempts system termination or mass process termination",
      riskClass: "destructive-local",
      severity: "critical"
    };
  }

  if (matchesFirewallFlush(command)) {
    return {
      code: "firewall-flush",
      reason: "command attempts to flush firewall rules",
      riskClass: "destructive-local",
      severity: "critical"
    };
  }

  return undefined;
}

function detectHostOnlyBlock(command: string): Detection | undefined {
  if (matchesBroadDelete(command)) {
    return {
      code: "destructive-delete-root-or-broad-path",
      reason: "command attempts recursive deletion of a broad system path",
      riskClass: "destructive-local",
      severity: "high"
    };
  }

  if (matchesHostDiskDestructive(command)) {
    return {
      code: "disk-destructive",
      reason: "command targets destructive disk or partition operations",
      riskClass: "destructive-local",
      severity: "high"
    };
  }

  if (matchesPermissionDestruction(command)) {
    return {
      code: "permission-destruction",
      reason: "command attempts unsafe ownership or permission changes on system paths",
      riskClass: "destructive-local",
      severity: "high"
    };
  }

  if (matchesNetworkPipeToInterpreter(command)) {
    return {
      code: "network-exfil",
      reason: "command pipes downloaded content directly into an interpreter",
      riskClass: "destructive-local",
      severity: "high"
    };
  }

  if (matchesDynamicEvalOrExec(command)) {
    return {
      code: "inline-code-destructive",
      reason: "command uses dynamic eval or exec syntax",
      riskClass: "destructive-local",
      severity: "high"
    };
  }

  if (matchesPrivilegeEscalation(command)) {
    return {
      code: "privilege-escalation",
      reason: "command attempts privilege escalation or account modification",
      riskClass: "destructive-local",
      severity: "high"
    };
  }

  if (matchesPackageRemoval(command)) {
    return {
      code: "package-removal-system",
      reason: "command attempts system or global package removal",
      riskClass: "destructive-local",
      severity: "high"
    };
  }

  if (matchesGitDestructive(command)) {
    return {
      code: "git-destructive",
      reason: "command attempts destructive git history or remote operations",
      riskClass: "destructive-local",
      severity: "high"
    };
  }

  if (matchesContainerPrune(command)) {
    return {
      code: "disk-destructive",
      reason: "command attempts destructive container resource pruning",
      riskClass: "destructive-local",
      severity: "high"
    };
  }

  if (matchesKubernetesDelete(command)) {
    return {
      code: "destructive-delete-root-or-broad-path",
      reason: "command attempts to delete Kubernetes resources",
      riskClass: "destructive-local",
      severity: "high"
    };
  }

  if (matchesTerraformDestroy(command)) {
    return {
      code: "terraform-destruction",
      reason: "command attempts infrastructure destruction",
      riskClass: "destructive-local",
      severity: "high"
    };
  }

  if (matchesSecretRead(command)) {
    return {
      code: "secret-read",
      reason: "command attempts to read or reveal secrets or credential material",
      riskClass: "credential-access",
      severity: "high"
    };
  }

  if (matchesPipeToInterpreter(command)) {
    return {
      code: "pipe-to-interpreter",
      reason: "command pipes content directly into an interpreter",
      riskClass: "destructive-local",
      severity: "high"
    };
  }

  if (matchesInlineCodeDestructive(command)) {
    return {
      code: "inline-code-destructive",
      reason: "command runs inline code that can delete files, execute subprocesses, or bypass shell safety checks",
      riskClass: "destructive-local",
      severity: "high"
    };
  }

  if (matchesCryptoMining(command)) {
    return {
      code: "crypto-mining",
      reason: "command appears to launch cryptocurrency mining software",
      riskClass: "destructive-local",
      severity: "high"
    };
  }

  if (matchesSqlDestructive(command)) {
    return {
      code: "sql-destructive",
      reason: "command contains destructive SQL operations",
      riskClass: "destructive-local",
      severity: "high"
    };
  }

  return undefined;
}

/* ------------------------------------------------------------------ */
/* Token-aware rm parsing                                              */
/*                                                                    */
/* Supported safety boundary:                                         */
/* - Simple command segmentation for common shell separators          */
/*   (&&, ||, ;, |).                                                  */
/* - Basename detection for rm (e.g. /bin/rm, /usr/bin/rm).           */
/* - Known wrapper option skipping (sudo -n, sudo --non-interactive). */
/* - No alias/function expansion.                                     */
/* ------------------------------------------------------------------ */

const BROAD_SYSTEM_SEGMENTS = new Set([
  "usr", "etc", "var", "home", "Users", "root", "opt", "bin", "sbin", "lib", "lib64"
]);

const WRAPPER_COMMANDS = new Set(["sudo", "command", "env"]);

function getBasename(token: string): string {
  const idx = token.lastIndexOf("/");
  return idx >= 0 ? token.slice(idx + 1) : token;
}

function tokenizeCommand(command: string): string[] {
  return command.trim().split(/\s+/u);
}

function splitShellSegments(command: string): string[] {
  return command.split(/\s*(?:\|\||&&|;|\|)\s*/u).filter(s => s.length > 0);
}

function parseRmTokens(tokens: string[]): {
  hasRecursive: boolean;
  hasForce: boolean;
  targets: string[];
} | undefined {
  let index = 0;

  while (index < tokens.length) {
    const token = tokens[index]!;
    if (WRAPPER_COMMANDS.has(token)) {
      index++;
      // Skip wrapper options (tokens starting with '-').
      while (index < tokens.length && tokens[index]!.startsWith("-")) {
        index++;
      }
      continue;
    }
    break;
  }

  if (index >= tokens.length || getBasename(tokens[index]!) !== "rm") {
    return undefined;
  }

  index++;

  let hasRecursive = false;
  let hasForce = false;
  let afterTerminator = false;
  const targets: string[] = [];

  for (; index < tokens.length; index++) {
    const token = tokens[index]!;

    if (token === "--") {
      afterTerminator = true;
      continue;
    }

    if (afterTerminator) {
      targets.push(token);
      continue;
    }

    if (token.startsWith("--")) {
      if (token === "--recursive") {
        hasRecursive = true;
      } else if (token === "--force") {
        hasForce = true;
      }
      continue;
    }

    if (token.startsWith("-") && token.length > 1) {
      for (const ch of token.slice(1)) {
        if (ch === "r" || ch === "R") {
          hasRecursive = true;
        } else if (ch === "f") {
          hasForce = true;
        }
      }
      continue;
    }

    targets.push(token);
  }

  return { hasRecursive, hasForce, targets };
}

function isRootDeleteTarget(target: string): boolean {
  return target === "/" || target === "/*";
}

function isBroadDeleteTarget(target: string): boolean {
  if (isRootDeleteTarget(target) || target === "~" || target === "." || target === "..") {
    return true;
  }

  if (target.startsWith("~/")) {
    return true;
  }

  if (target.startsWith("/")) {
    const segments = target.split("/");
    const first = segments[1];
    if (first !== undefined && BROAD_SYSTEM_SEGMENTS.has(first)) {
      return true;
    }
  }

  return false;
}

function rmTargetsMatch(command: string, predicate: (target: string) => boolean): boolean {
  const segments = splitShellSegments(command);
  for (const segment of segments) {
    const tokens = tokenizeCommand(segment);
    const rm = parseRmTokens(tokens);
    if (rm === undefined) {
      continue;
    }
    if (!rm.hasRecursive || !rm.hasForce) {
      continue;
    }
    if (rm.targets.some(predicate)) {
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Classification helpers                                              */
/* ------------------------------------------------------------------ */

function looksDestructive(command: string): boolean {
  const segments = splitShellSegments(command);
  for (const segment of segments) {
    const tokens = tokenizeCommand(segment);
    const rm = parseRmTokens(tokens);
    if (rm !== undefined && rm.hasRecursive && rm.hasForce) {
      return true;
    }
  }

  return /\bsudo\b|\bchmod\s+-R\b|\bchown\s+-R\b|\bmkfs\.|\bdd\b.+\bof=|>\s*\/dev\/(?:sd[a-z]|nvme\d+n\d+)/iu.test(command);
}

function looksCredentialSeeking(command: string): boolean {
  return /\b(printenv|env|security\s+find|op\s+read|gh\s+auth\s+token|pass\s+show)\b/iu.test(command) ||
    /(\.env|\.ssh|\.aws|\.gnupg|id_rsa|id_ed25519|\.npmrc|token|secret|api[_-]?key|credentials)/iu.test(command);
}

function matchesRootDelete(command: string): boolean {
  return rmTargetsMatch(command, isRootDeleteTarget);
}

function matchesBroadDelete(command: string): boolean {
  return rmTargetsMatch(command, isBroadDeleteTarget);
}

function matchesHardlineDiskDestructive(command: string): boolean {
  return /\bmkfs\./iu.test(command) ||
    /\bdd\b(?=.*\bif=\/dev\/zero\b)(?=.*\bof=\/dev\/)/iu.test(command) ||
    /(^|[\s;&|])>\s*\/dev\/sd[a-z]\d*\b/iu.test(command);
}

function matchesHostDiskDestructive(command: string): boolean {
  return /\bdd\b.*\bof=\/dev\/(?:sd[a-z]\d*|disk\d|nvme\d+n\d+)/iu.test(command) ||
    /(^|[\s;&|])>\s*\/dev\/(?:sd[a-z]\d*|nvme\d+n\d+)/iu.test(command) ||
    /\b(?:fdisk|parted)\b/iu.test(command) ||
    /\bdiskutil\s+erase(?:Disk|Volume)\b/iu.test(command);
}

function matchesForkBomb(command: string): boolean {
  const compact = command.replace(/\s+/gu, "");
  return compact.includes(":(){:|:&};:") ||
    splitShellSegments(command).some(segment => {
      const tokens = unwrappedCommandTokens(tokenizeCommand(segment));
      const commandName = firstCommandName(tokens);
      return (commandName === "kill" && tokens[1] === "-1") ||
        (commandName === "pkill" && tokens[1] === "-9" && tokens[2] === "-u") ||
        (commandName === "killall" && tokens[1] === "-u");
    });
}

function matchesHardlinePermissionDestruction(command: string): boolean {
  return /\bchmod\s+-R\s+(?:777|000)\s+\/(?:\s|$)/iu.test(command);
}

function matchesPermissionDestruction(command: string): boolean {
  return /\bchmod\s+(?:-[A-Za-z]*\s+)?777\s+\/(?:\s|$)/iu.test(command) ||
    /\bchown\s+-R\b.*\s\/(?:usr|etc|var|home|Users|root|opt|bin|sbin|lib|lib64)(?:\s|\/|$)/iu.test(command);
}

function matchesNetworkPipeToInterpreter(command: string): boolean {
  return /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:sh|bash)\b/iu.test(command);
}

function matchesDynamicEvalOrExec(command: string): boolean {
  return /\b(?:eval|exec)\s*\(/iu.test(command);
}

function matchesPrivilegeEscalation(command: string): boolean {
  if (matchesSudoWithoutWhitelist(command)) {
    return true;
  }

  return splitShellSegments(command).some(segment => {
    const tokens = tokenizeCommand(segment);
    const commandName = firstCommandName(tokens);
    return (commandName === "su" && tokens[1] === "-") ||
      commandName === "passwd" ||
      commandName === "usermod";
  });
}

function matchesSudoWithoutWhitelist(command: string): boolean {
  const segments = splitShellSegments(command);
  for (const segment of segments) {
    const tokens = tokenizeCommand(segment);
    const sudoIndex = sudoCommandIndex(tokens);
    if (sudoIndex === -1) {
      continue;
    }

    const remaining = tokens.slice(sudoIndex + 1);
    if (remaining.length === 0) {
      return true;
    }

    if (remaining.every(isWhitelistedSudoTarget)) {
      continue;
    }

    let index = 0;
    while (index < remaining.length && remaining[index]!.startsWith("-")) {
      if (!isWhitelistedSudoTarget(remaining[index]!)) {
        index++;
        continue;
      }
      return false;
    }

    const nextToken = remaining[index];
    if (nextToken === undefined || !isWhitelistedSudoTarget(nextToken)) {
      return true;
    }
  }

  return false;
}

function sudoCommandIndex(tokens: string[]): number {
  let index = 0;

  while (index < tokens.length) {
    const commandName = getBasename(tokens[index]!).toLowerCase();
    if (commandName === "sudo") {
      return index;
    }

    if (!WRAPPER_COMMANDS.has(commandName)) {
      return -1;
    }

    index++;
    while (index < tokens.length && tokens[index]!.startsWith("-")) {
      index++;
    }
  }

  return -1;
}

function isWhitelistedSudoTarget(token: string): boolean {
  return token === "-v" || token === "-l" || token === "true" || token === "--version";
}

function firstCommandName(tokens: string[]): string | undefined {
  const first = tokens[0];
  return first === undefined ? undefined : getBasename(first).toLowerCase();
}

function unwrappedCommandTokens(tokens: string[]): string[] {
  let index = 0;

  while (index < tokens.length) {
    const commandName = getBasename(tokens[index]!).toLowerCase();
    if (!WRAPPER_COMMANDS.has(commandName)) {
      break;
    }

    index++;
    while (index < tokens.length && tokens[index]!.startsWith("-")) {
      index++;
    }
  }

  return tokens.slice(index);
}

function matchesPackageRemoval(command: string): boolean {
  return /\b(?:apt-get|yum)\b[^;&|]*\bremove\b/iu.test(command) ||
    /\bpip(?:3)?\s+uninstall\b/iu.test(command) ||
    /\bnpm\s+uninstall\b[^;&|]*\s-g(?:\s|$)/iu.test(command);
}

function matchesGitDestructive(command: string): boolean {
  return /\bgit\s+push\b.*(?:--force|-f|--force-with-lease)\b/iu.test(command) ||
    /\bgit\s+reset\s+--hard\b/iu.test(command);
}

function matchesContainerPrune(command: string): boolean {
  return /\bdocker\s+(?:system|volume)\s+prune\b/iu.test(command);
}

function matchesKubernetesDelete(command: string): boolean {
  return /\bkubectl\s+delete\b/iu.test(command);
}

function matchesTerraformDestroy(command: string): boolean {
  return /\bterraform\s+destroy\b/iu.test(command);
}

function matchesSecretRead(command: string): boolean {
  return /\b(?:cat|less|more|head|tail|grep|sed|awk)\b.*(?:\.env(?:\b|$)|\.ssh\/|id_rsa\b|id_ed25519\b|\.aws\/credentials\b|\.npmrc\b|\.gnupg\/)/iu.test(command) ||
    /(?:^|[;&|]\s*)(?:env|printenv|set)(?:\s|$)/iu.test(command) ||
    /\bsecurity\s+find-(?:generic-password|internet-password)\b/iu.test(command) ||
    /\bop\s+read\b/iu.test(command) ||
    /\bgh\s+auth\s+token\b/iu.test(command);
}

function matchesPipeToInterpreter(command: string): boolean {
  return /\b(?:curl|wget|fetch)\b[^|;&]*(?:\|\s*|>\s*>\([^)]*\)\s*|\|\s*(?:sudo\s+)?)(?:sudo\s+)?(?:sh|bash|zsh|fish|python|python3|node|bun|ruby|perl|php|deno)\b/iu.test(command) ||
    /\b(?:sh|bash|zsh|fish|python|python3|node|bun|ruby|perl|php|deno)\b\s*<\s*<\s*\(/iu.test(command);
}

function matchesInlineCodeDestructive(command: string): boolean {
  if (!/\b(?:python|python3)\s+-c\b|\b(?:node|bun|deno)\s+-e\b/iu.test(command)) {
    return false;
  }
  return /\b(?:shutil\.rmtree|os\.remove|os\.unlink|subprocess\.|os\.system|child_process|execSync|spawnSync|rmSync|unlinkSync|rmdirSync|Deno\.remove|Bun\.spawn|Bun\.spawnSync)\b/iu.test(command);
}

function matchesCryptoMining(command: string): boolean {
  return /\b(?:xmrig|minerd|cpuminer|ethminer)\b/iu.test(command);
}

function matchesSqlDestructive(command: string): boolean {
  return /\b(?:drop\s+database|drop\s+schema|drop\s+table|truncate\s+table)\b/iu.test(command);
}

function matchesSelfTermination(command: string): boolean {
  return splitShellSegments(command).some(segment => {
    const tokens = unwrappedCommandTokens(tokenizeCommand(segment));
    const commandName = firstCommandName(tokens);
    return commandName === "shutdown" ||
      commandName === "reboot" ||
      commandName === "halt" ||
      commandName === "poweroff" ||
      (commandName === "systemctl" && (tokens[1] === "poweroff" || tokens[1] === "reboot")) ||
      ((commandName === "init" || commandName === "telinit") && (tokens[1] === "0" || tokens[1] === "6")) ||
      (commandName === "kill" && tokens[1] === "-9" && (tokens[2] === "-1" || tokens[2] === "1")) ||
      (commandName === "mv" && tokens[1] === "/" && tokens[2] === "/dev/null") ||
      (commandName === "echo" && />\s*\/proc\/sysrq-trigger\b/iu.test(segment));
  });
}

function matchesFirewallFlush(command: string): boolean {
  return /\biptables\s+(?:-F|--flush)\b/iu.test(command);
}
