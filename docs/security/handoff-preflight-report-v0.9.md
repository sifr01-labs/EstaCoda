# Phase 2 Handoff Security Preflight Report — v0.9

**Commit:** `3891894` on `main`  
**Date:** 2026-05-04  
**Audited Files:**
- `src/channels/handoff-store.ts`
- `src/channels/handoff-store.test.ts`
- `src/channels/channel-gateway.ts` (/attach, /detach handlers)
- `src/channels/gateway-runner.ts` (handoff store wiring)

---

## 1. Handoff Code Randomness

| Check | Result | Evidence |
|-------|--------|----------|
| Cryptographic RNG | **PASS** | `generateCode()` uses `crypto.randomInt(chars.length)` from Node.js `node:crypto`. Not `Math.random`. |
| Character set | **PASS** | Crockford-like base-32 alphabet: `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (32 chars, visually unambiguous). |
| Keyspace | **PASS** | 32^6 = ~1.07 billion combinations for a 6-character code. |
| Collision handling | **PASS** | `create()` loops up to 100 attempts to guarantee uniqueness against the in-memory map before falling through. |

**Exact Implementation:**
```typescript
import { randomInt } from "node:crypto";

function generateCode(length = 6): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[randomInt(chars.length)];
  }
  return result;
}
```

**Verdict:** Codes are generated with cryptographically secure randomness. No patch required.

---

## 2. Handoff Code Leakage

| Check | Result | Evidence |
|-------|--------|----------|
| Failed /attach reveals session ID? | **PASS** | `redeem()` returns only `reason` strings: `"Invalid handoff code."`, `"Handoff code already used."`, `"Handoff code expired."`, `"Handoff code is for {surfaceType}, not {input.surfaceType}."`. No sessionId is ever returned on failure. |
| Expired/redeemed/invalid safe messages? | **PASS** | See above. Generic, safe messages only. Surface-type mismatch reveals only the surface type label, not the session. |
| Runtime logs contain codes? | **PASS** | No `console.log/warn/error/info` statements in `handoff-store.ts`, `channel-gateway.ts`, or `gateway-runner.ts` that emit handoff codes. Codes only exist in: (a) CLI output (intentional, user-facing), (b) `handoff-codes.json` persistence file, (c) in-memory Map during runtime. |
| Persistence file exposure? | **PASS** | `handoff-codes.json` is written with `0o600` permissions (see Section 3). |

**Verdict:** No leakage of sensitive data on failed redemption. No patch required.

---

## 3. Handoff Store File Handling

| Check | Result | Evidence |
|-------|--------|----------|
| Atomic writes | **PASS** | `#flush()` writes to `${path}.tmp`, then `rename()` into final path. Crash during write leaves the previous file intact. |
| Restrictive permissions | **PASS** | `writeFile(tempPath, ..., { mode: 0o600 })` sets owner-read-write only. Follow-up `chmod(this.#path, 0o600)` reinforces it. |
| Platform fallback | **PASS** | `chmod()` is wrapped in `try/catch`; Windows (which lacks POSIX chmod) falls through silently with comment: `// Platform may not support chmod (e.g. Windows); atomic write already succeeded.` |
| Default path | **PASS** | `~/.estacoda/handoff-codes.json` — user-local, not world-readable. |

**Exact Implementation:**
```typescript
async #flush(): Promise<void> {
  const file: HandoffCodeFile = { version: 1, codes: [...this.#codes.values()] };
  const tempPath = `${this.#path}.tmp`;
  await mkdir(dirname(this.#path), { recursive: true });
  await writeFile(tempPath, `${JSON.stringify(file, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, this.#path);
  try {
    await chmod(this.#path, 0o600);
  } catch {
    // Platform may not support chmod (e.g. Windows); atomic write already succeeded.
  }
}
```

**Verdict:** Atomic writes and restrictive permissions are implemented. Windows limitation is documented inline. No patch required.

---

## 4. Brute-Force Posture

| Check | Result | Evidence |
|-------|--------|----------|
| Valid + unexpired + single-use only? | **PASS** | `redeem()` checks: (1) code exists in map, (2) not already redeemed, (3) `expiresAt > now`, (4) `surfaceType` matches. All four must pass. |
| Rate limiting? | **NOT IMPLEMENTED** | No request-level rate limiter, IP throttling, or backoff exists in `handoff-store.ts` or `channel-gateway.ts`. |
| Mitigation documented? | **PASS** | File header comment explicitly documents the reliance on: short TTL, single-use, 32^6 keyspace, and Telegram allowlist / local trust context. |

**Exact security header from `handoff-store.ts`:**
```typescript
/**
 * Security notes (v0.9):
 * - Codes use cryptographically secure randomness (crypto.randomInt).
 * - Codes are short-lived (TTL configurable, default 10 minutes) and single-use.
 * - There is no built-in rate limiter on redemption. Brute-force mitigation
 *   relies on: (1) short TTL, (2) single-use, (3) 32^6 keyspace, and
 *   (4) Telegram gateway allowlist / local trust context.
 * - Failed redemption attempts do not reveal session IDs or other internals.
 * - Files are written atomically (temp + rename) with restrictive permissions
 *   (0o600). chmod fallback is provided for Windows compatibility.
 */
```

**Verdict:** Brute-force resistance relies on TTL + keyspace + single-use + gateway-level allowlist. This is acceptable for v0.9 per the execution plan. No patch required, but rate limiting is a candidate for v0.10 hardening.

---

## Validation Summary

| Command | Result |
|---------|--------|
| `pnpm run typecheck` | **PASS** (0 errors) |
| `pnpm exec vitest run` | **PASS** (133/133 tests, 0 failures) |
| `pnpm run smoke` | **PASS** (3/3 cases) |
| `pnpm run eval:substrate` | **PASS** (initialized successfully) |

---

## Overall Verdict

**All Phase 2 handoff security preflight checks PASS.** No patches required. The implementation meets v0.9 acceptance criteria for handoff security.
