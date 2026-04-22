export type MemoryScanResult = {
  ok: boolean;
  issues: string[];
};

const BLOCKED_PATTERNS: readonly RegExp[] = [
  /ignore (all )?(previous|prior|above) instructions/i,
  /disregard (all )?(previous|prior|above) instructions/i,
  /reveal (the )?(system prompt|developer message|hidden instructions)/i,
  /exfiltrate|steal|leak/i,
  /api[_ -]?key|secret[_ -]?key|private[_ -]?key/i,
  /BEGIN SYSTEM PROMPT/i,
  /<script\b/i
];

const INVISIBLE_UNICODE = /[\u200b\u200c\u200d\ufeff\u202a-\u202e\u2066-\u2069]/u;

export function scanMemoryContent(content: string): MemoryScanResult {
  const issues: string[] = [];

  for (const pattern of BLOCKED_PATTERNS) {
    if (pattern.test(content)) {
      issues.push(`blocked pattern: ${pattern.source}`);
    }
  }

  if (INVISIBLE_UNICODE.test(content)) {
    issues.push("contains invisible or bidirectional control characters");
  }

  return {
    ok: issues.length === 0,
    issues
  };
}

