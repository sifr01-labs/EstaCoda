import type { ToolRiskClass } from "../contracts/tool.js";

export type HardCommandBlockCode =
  | "destructive-delete-root-or-broad-path"
  | "disk-destructive"
  | "system-power"
  | "fork-bomb-or-killall"
  | "secret-read"
  | "pipe-to-interpreter"
  | "git-force-push";

export type CommandSafetyAssessment = {
  normalized: string;
  riskClass?: ToolRiskClass;
  hardBlock?: {
    code: HardCommandBlockCode;
    reason: string;
  };
};

export function assessCommandSafety(command: string): CommandSafetyAssessment {
  const normalized = normalizeCommandForSafety(command);
  const hardBlock = detectHardBlock(normalized);

  if (hardBlock !== undefined) {
    return {
      normalized,
      riskClass: inferRiskClass(normalized),
      hardBlock
    };
  }

  return {
    normalized,
    riskClass: inferRiskClass(normalized)
  };
}

export function normalizeCommandForSafety(value: string): string {
  return value.trim().replace(/\s+/gu, " ");
}

function inferRiskClass(command: string): ToolRiskClass | undefined {
  if (looksCredentialSeeking(command)) {
    return "credential-access";
  }

  if (looksDestructive(command)) {
    return "destructive-local";
  }

  return undefined;
}

function detectHardBlock(command: string): { code: HardCommandBlockCode; reason: string } | undefined {
  if (matchesBroadDelete(command)) {
    return {
      code: "destructive-delete-root-or-broad-path",
      reason: "command attempts recursive deletion of a broad or root-like path"
    };
  }

  if (matchesDiskDestructive(command)) {
    return {
      code: "disk-destructive",
      reason: "command targets destructive disk or partition operations"
    };
  }

  if (matchesSystemPower(command)) {
    return {
      code: "system-power",
      reason: "command attempts shutdown, reboot, or power control"
    };
  }

  if (matchesForkBombOrKillall(command)) {
    return {
      code: "fork-bomb-or-killall",
      reason: "command matches a fork-bomb or mass-kill pattern"
    };
  }

  if (matchesSecretRead(command)) {
    return {
      code: "secret-read",
      reason: "command attempts to read or reveal secrets or credential material"
    };
  }

  if (matchesPipeToInterpreter(command)) {
    return {
      code: "pipe-to-interpreter",
      reason: "command pipes downloaded content directly into an interpreter"
    };
  }

  if (matchesGitForcePush(command)) {
    return {
      code: "git-force-push",
      reason: "command attempts a force push to a remote branch"
    };
  }

  return undefined;
}

function looksDestructive(command: string): boolean {
  return /\brm\s+-rf\b|\bsudo\b|\bchmod\s+-R\b|\bchown\s+-R\b|\bmkfs\.|\bdd\b.+\bof=|>\/dev\/sd[a-z]/iu.test(command);
}

function looksCredentialSeeking(command: string): boolean {
  return /\b(printenv|env|security\s+find|op\s+read|gh\s+auth\s+token|pass\s+show)\b/iu.test(command) ||
    /(\.env|\.ssh|\.aws|\.gnupg|id_rsa|id_ed25519|\.npmrc|token|secret|api[_-]?key|credentials)/iu.test(command);
}

function matchesBroadDelete(command: string): boolean {
  return /\brm\s+-rf(?:\s+--)?\s+(?:\/(?:\s|$)|~(?:\/|\s|$)|\.(?:\s|$)|\.\.(?:\s|$)|\/(?:usr|etc|var|home|Users|root|opt|bin|sbin|lib|lib64)(?:\/|\s|$))/iu.test(command);
}

function matchesDiskDestructive(command: string): boolean {
  return /\bmkfs\./iu.test(command) ||
    /\bdd\b.*\bof=\/dev\/(?:sd[a-z]|disk\d|nvme\d+n\d+)/iu.test(command) ||
    /\b(?:fdisk|parted)\b/iu.test(command) ||
    /\bdiskutil\s+erase(?:Disk|Volume)\b/iu.test(command);
}

function matchesSystemPower(command: string): boolean {
  return /\b(?:shutdown|reboot|halt|poweroff)\b/iu.test(command) ||
    /\bsystemctl\s+(?:poweroff|reboot)\b/iu.test(command) ||
    /\binit\s+(?:0|6)\b/iu.test(command);
}

function matchesForkBombOrKillall(command: string): boolean {
  const compact = command.replace(/\s+/gu, "");
  return compact.includes(":(){:|:&};:") ||
    /\bkill\s+-1\b/iu.test(command) ||
    /\bpkill\s+-9\s+-u\b/iu.test(command) ||
    /\bkillall\s+-u\b/iu.test(command);
}

function matchesSecretRead(command: string): boolean {
  return /\b(?:cat|less|more|head|tail|grep|sed|awk)\b.*(?:\.env(?:\b|$)|\.ssh\/|id_rsa\b|id_ed25519\b|\.aws\/credentials\b|\.npmrc\b|\.gnupg\/)/iu.test(command) ||
    /\bsecurity\s+find-(?:generic-password|internet-password)\b/iu.test(command) ||
    /\bop\s+read\b/iu.test(command) ||
    /\bgh\s+auth\s+token\b/iu.test(command);
}

function matchesPipeToInterpreter(command: string): boolean {
  return /\b(?:curl|wget)\b[^|]*\|\s*(?:sh|bash|zsh|fish|python|python3|node|ruby|perl)\b/iu.test(command);
}

function matchesGitForcePush(command: string): boolean {
  return /\bgit\s+push\b.*(?:--force|-f|--force-with-lease)\b/iu.test(command);
}
