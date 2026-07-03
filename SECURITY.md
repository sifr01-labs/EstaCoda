# Security Policy

EstaCoda is agent infrastructure with local file access, terminal execution, browser automation, scheduled work, and messaging interfaces. Treat it as security-sensitive software.

This document defines how to report vulnerabilities, the trust model EstaCoda claims, which boundaries are security-relevant, and how dependency alerts are triaged.

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

Report privately via [GitHub Security Advisories](https://github.com/sifr01-labs/EstaCoda/security/advisories/new).

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

---

## Disclosure

- Coordinated disclosure target: 90 days from report, or until a fix is released, whichever comes first.
- Channel: the GitHub Security Advisory thread.
- Credit: reporters are credited in release notes unless anonymity is requested.
- No bug bounty is currently offered.

---

## Trust Model

EstaCoda assumes a single trusted operator controlling a local or self-hosted agent runtime. The operator chooses the model provider, security mode, enabled tools, profiles, channels, skills, browser backends, and deployment environment.

EstaCoda's approval gates, hardline blocks, redaction, URL-safety checks, channel allowlists, profile scoping, and spend-approval checks reduce accidental and opportunistic risk. They are not a sandbox against adversarial code running with the same operating-system privileges as the EstaCoda process.

The strongest isolation boundary is the deployment boundary the operator chooses: OS user separation, containerization, VM isolation, firewall/VPN policy, Tailscale, or another external sandbox. Operators who ingest untrusted content at scale, run unattended gateways, or expose services beyond their local machine should choose an isolation posture deliberately.

EstaCoda does not protect against malicious co-tenants on the same machine, a compromised operating-system account, an attacker with write access to EstaCoda configuration or credential files, or a maintainer intentionally approving malicious code.

### In-process safety controls

The following controls are important, but they are not full isolation boundaries:

- The approval system asks before actions that match configured risk classes.
- The hardline floor denies known dangerous command patterns in all modes.
- Redaction removes known secret-like values from supported internal displays, logs, previews, gateway metadata, tool outputs, memory surfaces, and persisted diagnostics. Redaction is a defense-in-depth display/logging control, not a guarantee that arbitrary model-generated final text cannot repeat sensitive content.
- URL-safety checks block private/internal targets and cloud metadata endpoints for browser and web tools.
- Channel allowlists and pairing policies limit who can dispatch work through configured channels.

Bypasses that cross a documented boundary are in scope. Bypasses that only demonstrate the limits of a heuristic, without tool execution, persistence, credential exposure, unauthorized access, or another boundary crossing, should be reported as regular bugs or hardening improvements rather than private security advisories.

### Skills, MCP, scripts, and integrations

Skills, MCP servers, local scripts, browser sessions, channel bridges, and other integrations are code or code-adjacent execution surfaces. Treat third-party or locally modified integrations as trusted code. Review them before enabling them, especially when they can access files, credentials, network services, subprocesses, or long-running gateway state.

---

## Security Controls

### Security Modes

EstaCoda supports three security modes:

- `strict` — manual approval for non-trivial actions.
- `adaptive` — deterministic triage first, with optional smart assessment for ambiguous cases. Default.
- `open` — allows by default unless a hard block matches. Not "security off."

The hard safety floor remains active in all modes. Hard-block decisions are non-overridable.

### Hardline Floor

The hardline floor runs before one-time approvals, session approvals, persistent approvals, `/yolo`, `open` mode, smart assessment, gateway queues, and final tool execution.

Hard-blocked categories include:

- Broad or root-like recursive deletes.
- Destructive disk operations and device overwrites.
- Shutdown, reboot, fork-bomb, kill-all, and self-termination patterns.
- Explicit secret reads and obvious network exfiltration patterns.
- Pipe-to-interpreter installs such as `curl ... | bash`.
- Git force-pushes and destructive Git resets.
- Permission destruction such as recursive `chmod 777 /` or `chmod 000 /`.
- Firewall flushes, Terraform destroy, destructive package removals, container-escape patterns, crypto-mining patterns, and destructive SQL patterns.

The command safety detector normalizes commands before matching, including ANSI stripping and Unicode NFKC normalization. Pattern matching is a safety floor, not a complete shell sandbox.

### Approvals and Workspace Trust

Workspace trust is explicit and path-scoped. A trusted workspace allows normal local file and terminal work under the configured security policy. It does not enable project config loading and does not change which profile config is used.

Persistent approvals match normalized target keys that include operation type and normalized targets. Display summaries are not the approval boundary.

Approval bypasses that execute gated actions without the required operator approval are security issues.

### Credential Handling

Credentials belong in the active profile `.env` or `auth.json`. Profile `.env` is created with `0600` permissions when written by the env secret store.

Subprocess environments are sanitized where EstaCoda launches lower-trust child processes: only narrow runtime variables are inherited by default, `HOME` is isolated for child environments that use the safe child-env path, and parent secrets are not forwarded unless explicitly configured.

Secrets must not be committed, logged, displayed, or persisted into memory. Redaction protects supported terminal output, logs, tool previews, gateway metadata, and memory/prompt surfaces. Redaction is a display and logging control, not permission to pass secrets into untrusted code.

### Browser and URL Safety

Browser navigation requires `http` or `https`. Private and internal URLs are blocked by default unless explicitly allowed. Cloud metadata endpoints are always blocked.

Browserbase is implemented as a cloud browser backend, but credentials alone do not authorize billable session creation. `BROWSERBASE_API_KEY` and `BROWSERBASE_PROJECT_ID` satisfy credential readiness only. Cloud session creation remains blocked until `browser.cloudSpendApproved === true`, normally set with `estacoda browser approve-cloud` and revoked with `estacoda browser revoke-cloud`.

Hybrid routing does not bypass URL safety. Public HTTP(S) URLs may route to Browserbase only when the cloud provider is configured and spend approval is true. Private and internal URLs route to local only when `security.allowPrivateUrls` is explicitly true. Metadata endpoints remain hard-blocked in all cases. Cloud approval failure does not fall back to local. Unsafe redirects are navigated to `about:blank` when possible; otherwise the unsafe session is closed.

Website blocklists support exact domains, wildcard domains, and shared files. `browser.cdp` is approval-gated by default.

### Gateway and Channel Authorization

External surfaces include CLI handoff, Telegram, WhatsApp, Discord, Email where configured, gateway service mode, browser automation, MCP servers, and any future API surface.

All channels share the same runtime security policy. There is no channel-specific approval escalation: the configured `strict`, `adaptive`, or `open` mode applies uniformly.

Network-facing adapters must deny by default unless an allowlist, pairing policy, or explicit open-access policy is configured. Session identifiers and surface pointers are routing handles, not authorization boundaries.

Gateway approvals are durable in the `pending_approvals` table inside the session database and are scoped by profile plus session where applicable. Pending approvals are ask-only: deterministic denies and hardline results must not become approvable queue rows.

WhatsApp is live-proven operationally, but it uses an isolated Baileys bridge under `scripts/whatsapp-bridge/`. Baileys is an unofficial WhatsApp API, so provider account enforcement, suspension, or upstream protocol changes are outside EstaCoda's control. Security issues in EstaCoda's bridge isolation, bearer-token handling, loopback binding, media path policy, authorization checks, alias handling, or profile-scoped state remain in scope.

### Install, Update, and Uninstall Boundaries

EstaCoda update and uninstall behavior is part of the security surface because it can modify installed code.

- Managed-source updates may mutate only the managed install path and must respect installer ownership metadata.
- Manual source checkouts are operator-owned and should not self-mutate as a managed install.
- Package-manager and container installs should route updates and removals through their package or container tooling.
- Uninstall preserves user data by default unless the operator explicitly requests purge behavior.
- Install/update/uninstall bugs that write outside the selected install method's ownership boundary are in scope.

---

## What Is In Scope

The following are security vulnerabilities in EstaCoda:

- Hardline-floor bypasses that allow a hard-blocked command to execute.
- Approval bypasses that execute gated actions without operator approval.
- Unauthorized gateway or channel callers dispatching work, receiving output, resolving approvals, or attaching to sessions.
- Cross-profile leakage of credentials, approvals, sessions, memory, logs, gateway state, or channel state.
- Leakage of credentials through logs, traces, gateway messages, memory, final answers, persisted state, or provider-visible prompts where EstaCoda promised redaction or isolation.
- Private/internal URL access or cloud metadata access despite URL-safety controls.
- Browserbase or other billable cloud session creation without explicit spend approval.
- Path traversal or arbitrary file write through media, browser, gateway, archive, installer, updater, or tool handling.
- Gateway bridge exposure that bypasses intended loopback binding, bearer-token checks, profile scoping, or allowlist/pairing policy.
- Dependency, install, update, package, or uninstall behavior that mutates outside the selected install method's ownership boundary.
- Documentation violations where code behaves contrary to a security boundary this policy explicitly claims.

---

## What Is Out of Scope

The following are not considered security vulnerabilities in EstaCoda itself:

- **Native Windows installer** — not part of the supported install surface.
- **WhatsApp account risk from Baileys itself** — Baileys is an unofficial WhatsApp API. EstaCoda isolates its bridge and controls local authorization, but it cannot guarantee WhatsApp account standing or upstream protocol stability.
- **Cloud browser providers except Browserbase** — browser-use, Firecrawl, and Camofox are registered stubs, not live-supported. Browserbase is implemented behind explicit spend approval.
- **Registered-but-not-live web research providers** — Firecrawl, Parallel, Tavily, Exa, SearXNG, Brave, and DDGS are registered stubs; guarded fetch extraction is the live baseline.
- **Local environment compromise not caused by EstaCoda** — a compromised OS account, malicious co-tenant, or physical access to the machine.
- **Model hallucination or prompt injection by itself** without tool execution, persistence, credential exposure, unauthorized access, or another boundary crossing.
- **Operator-selected permissive posture** such as intentionally using `open` mode, explicitly approving risky actions, enabling private URLs, approving cloud spend, or exposing gateway surfaces without external access control.
- **Denial-of-service through intentionally huge local inputs**, unless it affects default public workflows or crosses another security boundary.
- **Third-party or locally modified skills/integrations behaving as their code says** after the operator installed or enabled them. Bugs in EstaCoda's install, disclosure, approval, or isolation path for those integrations remain in scope.

---

## Dependency Alert Triage

EstaCoda separates runtime dependency alerts from documentation-site dependency alerts.

Runtime alerts affect the CLI, gateway, channels, provider runtime, tools, skills, memory, installer, updater, uninstaller, WhatsApp bridge package, or published package artifact.

Website/docs alerts affect only the Docusaurus documentation and marketing site under `website/` or `website/pnpm-lock.yaml`.

Website/docs alerts are still tracked and fixed, but they are not automatically treated as runtime release blockers unless they affect served user input, deployment security, credential handling, CI/CD publishing, or package artifacts.

This distinction matches the current repository layout: the root package artifact is defined by root `package.json`, the public runtime package file list does not include `website/`, and the Docusaurus site has its own `website/package.json` and `website/pnpm-lock.yaml`.

---

## Deployment Hardening

- Run EstaCoda as a non-root OS user.
- Use separate profiles for separate trust zones, such as personal work, production gateway use, and risky experimentation.
- Keep `~/.estacoda` private and backed up.
- Do not expose gateway or API surfaces publicly without VPN, firewall, Tailscale, or equivalent access control.
- Configure channel allowlists or pairing policy before enabling messaging adapters.
- Avoid `open` mode for unattended, multi-channel, or production-like deployments.
- Treat skills, MCP servers, local scripts, browser profiles, and channel bridges as code execution surfaces.
- Use container, VM, OS-user, or network-level isolation when ingesting untrusted content at scale.
- Keep dependencies updated and triage runtime alerts separately from website/docs alerts.

---

## Secret Handling Rules

- Store provider API keys, tokens, and OAuth credentials in the active profile `.env` or `auth.json`.
- Do not commit `.env`, `auth.json`, browser profiles, channel auth state, gateway logs, or any file containing real secrets.
- Do not paste secrets into issues, pull requests, logs, screenshots, docs, or model prompts.
- Documentation and examples must use obvious placeholders.
- If a secret may have been exposed, rotate it. Do not rely on redaction as proof that exposure did not happen.

---

## Documentation

For the user-facing security and approvals guide, see [Security and Approvals](https://estacoda.kemetresearch.com/docs/user-guide/security-and-approvals).

For CLI gateway approval commands, see [CLI Commands](https://estacoda.kemetresearch.com/docs/reference/cli-commands).
