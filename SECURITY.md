# Security Policy

EstaCoda is agent infrastructure with local file access, terminal execution, and messaging interfaces. Treat it as security-sensitive software.

This document defines how to report vulnerabilities, what boundaries EstaCoda enforces, and what is in scope for security review.

---

## Supported Versions

| Version | Security support |
|---|---|
| `main` | Supported — fixes land here first |
| Latest `0.x` release | Supported |
| Older snapshots | Not supported |

Until a later release formalizes long-term support, security fixes target `main` and the latest tagged release.

---

## Reporting a Vulnerability

Do not open a public issue for a security vulnerability.

Report privately via [GitHub Security Advisories](https://github.com/KemetResearch/EstaCoda/security/advisories/new).

A security contact email will be listed here once its monitoring status is confirmed.

---

## What to Include

A useful security report should include:

- A concise title and severity estimate: critical, high, medium, or low.
- Affected component, file path, and relevant line range if known.
- EstaCoda version, commit SHA, operating system, and Node.js version.
- Clear reproduction steps against `main` or the latest release.
- Expected behavior and actual behavior.
- Impact: what trust boundary was crossed.
- Proof of concept, with secrets removed.
- Logs, screenshots, or terminal output, with credentials redacted.
- Whether the issue requires a malicious project file, malicious skill, malicious model output, compromised dependency, unauthorized gateway user, or local machine access.

---

## Response Process

Target handling process:

1. Confirm receipt privately.
2. Reproduce the issue.
3. Classify severity and affected versions.
4. Patch privately if public disclosure would increase user risk.
5. Add regression coverage where practical.
6. Publish a security advisory or release note after the fix is available.

Response times depend on maintainer availability and issue complexity. No formal SLA is guaranteed.

No bug bounty is currently offered.

---

## Security Model

EstaCoda assumes a single trusted operator controlling a local or self-hosted agent runtime. It protects the operator from unsafe agent behavior, unsafe model output, malicious project content, untrusted skills, unsafe tool execution, and accidental credential exposure.

It does not protect against malicious co-tenants on the same machine, a compromised operating system account, an attacker with write access to EstaCoda configuration files, or a maintainer intentionally approving malicious code.

### Security Modes

EstaCoda supports three security modes:

- `strict` — manual approval for non-trivial actions.
- `adaptive` — smart assessment with hard-block floor. Default.
- `open` — allows by default unless a hard block matches. Not "security off."

The hard safety floor remains active in all modes. Hard-block decisions are non-overridable.

### Approvals and Trust Boundaries

Workspace trust is explicit and path-scoped. A trusted workspace allows normal local file and terminal work under the configured security policy. It does not enable project config loading or change which profile config is used.

Dangerous commands — recursive deletion, permission weakening, remote script execution, writes to shell profiles or SSH configuration, force-pushes, secret exfiltration — require explicit approval unless the operator has intentionally chosen a permissive mode.

Approval bypasses are security issues.

### Credential Handling

Credentials belong in the active profile `.env` or `auth.json`. Profile `.env` is created with `0600` permissions when written by the env secret store.

Secrets must not be committed, logged, displayed, or persisted into memory. Redaction protects terminal output, logs, tool previews, gateway messages, and final responses. Redaction is a display and logging control, not permission to pass secrets into untrusted code.

### Browser and URL Safety

Browser navigation requires `http` or `https`. Private and internal URLs are blocked by default unless explicitly allowed. Cloud metadata endpoints are always blocked.

Browserbase is implemented as a cloud browser backend, but credentials alone do not authorize billable session creation. `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` satisfy credential readiness only. Cloud session creation remains blocked until `browser.cloudSpendApproved === true`, normally set with `estacoda browser approve-cloud` and revoked with `estacoda browser revoke-cloud`.

Hybrid routing does not bypass URL safety. Public HTTP(S) URLs may route to Browserbase only when the cloud provider is configured and spend approval is true. Private and internal URLs route to local only when `security.allowPrivateUrls` is explicitly true. Metadata endpoints remain hard-blocked in all cases. Cloud approval failure does not fall back to local. Unsafe redirects are navigated to `about:blank` when possible; otherwise the unsafe session is closed.

Website blocklists support exact domains, wildcard domains, and shared files. `browser.cdp` is approval-gated by default.

### Gateway Approval Boundaries

Gateway approvals are durable in the `pending_approvals` table inside `~/.estacoda/sessions.sqlite` and are scoped by `profile_id` plus session where applicable. `estacoda gateway approvals list|approve|deny` operates on the same durable rows that block live gateway executions.

Gateway access denies by default unless a platform is explicitly configured for open access.

---

## What Is Out of Scope

The following are not considered security vulnerabilities in EstaCoda itself:

- **Native Windows installer** — not part of the v0.1.0 support surface.
- **Experimental WhatsApp channel** — gated behind `experimental: true`; Baileys is an unofficial API with account-risk implications.
- **Cloud browser providers except Browserbase** — browser-use, Firecrawl, and Camofox are registered stubs, not live-supported. Browserbase is implemented behind explicit spend approval.
- **Registered-but-not-live web research providers** — Firecrawl, Parallel, Tavily, Exa, SearXNG, Brave, and DDGS are registered stubs; only guarded fetch extraction is live.
- **Local environment compromise** not caused by EstaCoda — a compromised OS account, malicious co-tenant, or physical access to the machine.
- **Model hallucination** without tool execution, persistence, or boundary crossing.
- **Unsafe behavior after the operator explicitly disables approvals** or runs in a permissive mode.
- **Denial-of-service through intentionally huge local inputs**, unless it affects default public workflows.

---

## Secret Handling Rules

- Store provider API keys, tokens, and OAuth credentials in the active profile `.env` or `auth.json`.
- Do not commit `.env`, `auth.json`, or any file containing real secrets.
- Do not paste secrets into issues, pull requests, logs, or screenshots.
- Documentation and examples must use obvious placeholders.

---

## Documentation

For the user-facing security and approvals guide, see [Security and Approvals](https://estacoda.kemetresearch.com/docs/user-guide/security-and-approvals).

For CLI gateway approval commands, see [CLI Commands](https://estacoda.kemetresearch.com/docs/reference/cli-commands).
