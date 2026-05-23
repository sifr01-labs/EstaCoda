# Security Policy

EstaCoda is agent infrastructure that can read files, write files, run tools, call model providers, and eventually operate through messaging interfaces. Treat it as security-sensitive software.

This document defines how to report vulnerabilities, what security boundaries EstaCoda intends to enforce, and what is considered in scope for security review.

For deeper implementation details, see `docs/SECURITY_MODEL.md` once available.

## Reporting a vulnerability

Do not open a public GitHub issue for a security vulnerability.

Report security issues through one of these private channels:

1. GitHub Security Advisories for the repository.
2. `security@kemetresearch.com`, once the inbox is active and monitored.
3. A private maintainer contact only if the first two channels are unavailable.

Before publishing this file publicly, confirm that the security inbox is active. If it is not active yet, remove the email address and rely on GitHub private vulnerability reporting.

## What to include

A useful security report should include:

- A concise title.
- Severity estimate: critical, high, medium, or low.
- Affected component, file path, and relevant line range if known.
- EstaCoda version, commit SHA, operating system, Node/Bun version, and relevant configuration.
- Clear reproduction steps against `main` or the latest release.
- Expected behavior and actual behavior.
- Impact: what trust boundary was crossed.
- Proof of concept, with secrets removed.
- Logs, screenshots, or terminal output, with credentials redacted.
- Whether the issue requires a malicious project file, malicious skill, malicious model output, compromised dependency, unauthorized gateway user, or local machine access.

## Response expectations

EstaCoda is currently pre-MVP. Security response will be best-effort until formal maintainership and release processes are finalized.

Target handling process:

1. Confirm receipt privately.
2. Reproduce the issue.
3. Classify severity and affected versions.
4. Patch privately if public disclosure would increase user risk.
5. Add regression coverage where practical.
6. Publish a security advisory or release note after the fix is available.

No bug bounty is currently offered.

## Supported versions

Until the first public stable release, security fixes target `main` and the latest tagged pre-release.

| Version | Security support |
| --- | --- |
| `main` | Supported on a best-effort basis |
| Latest `0.x` release | Supported once releases begin |
| Older pre-MVP snapshots | Not supported |

## Security model

EstaCoda assumes a single trusted operator controlling a local or self-hosted agent runtime.

EstaCoda is designed to protect the operator from unsafe agent behavior, unsafe model output, malicious project content, untrusted skills, unsafe tool execution, and accidental credential exposure.

EstaCoda is not designed to protect against malicious co-tenants on the same machine, a compromised operating system account, an attacker with write access to EstaCoda configuration files, or a maintainer intentionally approving malicious code.

## Core trust boundaries

### Operator trust

The operator is trusted. The model is not trusted. Project files are not trusted. Tool outputs are not trusted. Third-party skills are not trusted until reviewed and approved.

The operator may intentionally weaken protections through configuration. Those choices should be explicit, visible, and reversible.

### Workspace trust

A workspace should be treated as untrusted until the operator explicitly trusts it.

Workspace trust controls whether EstaCoda may perform local file and terminal work in that folder without repeated approval prompts. A workspace may contain prompt injection, malicious instructions, poisoned documentation, unsafe scripts, or dependency traps.

A report is security-relevant if untrusted workspace content can bypass approval, execute tools, mutate trusted files, persist unsafe memory, alter configuration, or escalate beyond the selected workspace boundary.

### Tool execution

Tool calls are a primary security boundary.

Security-sensitive tools include, but are not limited to:

- Terminal execution.
- File writes and replacements.
- File deletion.
- Credential access.
- Network calls.
- Package installation.
- Git operations.
- Skill installation and promotion.
- Gateway or messaging actions.
- Memory writes.

Provider-generated tool calls must be validated against the exposed schema. Invalid tool names, malformed arguments, unauthorized aliases, or tool calls outside the current capability set must fail closed.

### Dangerous command approval

Commands that can destroy data, alter system security, expose credentials, install unknown software, modify shell startup files, change Git history, overwrite system paths, or affect external services should require explicit approval unless the operator has placed the session in an intentionally permissive mode.

Approval bypasses are security issues.

Examples of high-risk command classes:

- Recursive deletion.
- Disk formatting or block-device writes.
- Permission weakening such as world-writable files.
- Ownership changes across large directory trees.
- Remote script execution such as piping downloaded content into a shell.
- Package manager operations from untrusted sources.
- Writes to shell profiles, SSH configuration, `.env` files, or system configuration.
- Force-pushes, destructive resets, or history rewrites.
- Secret printing or exfiltration.

### File access and mutation

File reads and writes must respect the active workspace boundary and configured policy.

Security-relevant cases include:

- Path traversal outside the trusted workspace.
- Symlink escapes.
- Writes to credential files or shell startup files without approval.
- Silent mutation of generated docs, config files, lockfiles, or source files outside the requested scope.
- Inconsistent restrictions where a file tool blocks an action but terminal access allows the same action without approval.

### Provider and prompt injection boundary

Model output is instructions, not authority.

A prompt injection is a security issue when it causes a concrete boundary failure, such as:

- Running a blocked tool.
- Bypassing approval.
- Reading or leaking secrets.
- Persisting malicious memory.
- Installing or promoting an unsafe skill.
- Modifying trusted configuration.
- Sending messages or network requests without authorization.
- Concealing tool activity or misleading the operator about what happened.

A prompt injection that only persuades the model to produce a bad answer, without crossing a tool, memory, credential, or approval boundary, is normally handled as a model-quality issue rather than a security vulnerability.

### Skills

Skills are high-trust procedural code and documentation.

A skill may contain instructions, templates, references, scripts, assets, required environment variables, and workflow expectations. This makes skills powerful and dangerous.

Security-relevant cases include:

- A skill that hides dangerous behavior behind harmless metadata.
- A skill that requests unnecessary credentials.
- A skill that causes unsafe terminal commands or file writes.
- A skill that bypasses workspace trust.
- A skill that modifies itself or another skill without review.
- A skill that smuggles prompt injection into references, templates, scripts, or assets.
- A skill promotion path that accepts unsafe learned behavior without evaluation and approval.

Third-party and external skills must be treated as untrusted until reviewed.

### Memory and learning

Memory and learning systems must not become an unreviewed persistence channel for malicious instructions.

Security-relevant cases include:

- Prompt injection persisted into user memory.
- Unsafe preferences promoted as durable instructions.
- Malicious observations influencing future sessions without review.
- Skill patches promoted without evaluation.
- Hidden instructions stored in summaries, memories, or learned workflow records.
- Sensitive data stored unnecessarily in memory.

Memory writes and skill-learning writes should be auditable, explainable, and reversible.

### Gateway and messaging interfaces

Messaging interfaces such as Telegram, Discord, Slack, email, or future channels are remote control surfaces.

Security-relevant cases include:

- Unauthorized users sending commands to the agent.
- Weak or missing allowlists.
- Pairing-code bypass.
- Message spoofing.
- Attachment handling that leads to unsafe file writes or execution.
- Remote users triggering local terminal commands without operator approval.
- Voice, image, or document inputs causing unsafe tool execution.

Gateway access must deny by default unless a platform is explicitly configured for open access.

Voice-specific gateway handling must preserve the deterministic STT preprocess gate: profile-local allowed roots, audio type/size validation, provider readiness checks, and faster-whisper download denial before worker startup. Auto-TTS must remain object/artifact based and must not treat arbitrary `MEDIA:/path` model text as a voice-delivery instruction. Voice credentials are direct env-var references only; do not add credential pools, gateway brokers, managed fallbacks, `useGateway`, or non-env credential sources for voice.

### Secrets and credentials

Secrets must not be committed, logged, displayed, or persisted into memory.

Secrets include:

- Provider API keys.
- GitHub tokens.
- Telegram bot tokens.
- OAuth tokens.
- SSH keys.
- `.env` values.
- Cloud credentials.
- Database credentials.
- Private webhook URLs.

Credential redaction should protect terminal output, logs, tool previews, gateway messages, and final responses. Redaction is a display and logging control, not permission to pass secrets into untrusted code.

### Supply chain

The dependency and skill supply chain is in scope.

Security-relevant cases include:

- Malicious dependencies.
- Dependency confusion.
- Unsafe lifecycle scripts.
- Generated lockfile changes that introduce unexpected packages.
- GitHub Actions that use unpinned third-party actions.
- Install scripts that execute remote code without review.
- Bundled skills or templates that include hidden executable behavior.

## In-scope vulnerability examples

The following are in scope:

- Bypassing dangerous command approval.
- Executing terminal commands from untrusted project content without approval.
- Reading files outside the trusted workspace through path traversal or symlink escape.
- Writing to sensitive files without approval.
- Leaking provider API keys, tokens, or secrets through logs, gateway messages, tool output, memory, or final responses.
- Unauthorized gateway user control.
- Skill installation or promotion bypass.
- Memory poisoning that persists malicious operational instructions.
- Malformed provider tool calls that execute despite schema failure.
- Dependency or install flow that enables arbitrary code execution unexpectedly.
- CI workflow injection or unsafe release automation.
- Sandbox escape once sandboxed backends exist.

## Out-of-scope or lower-priority reports

The following are usually not considered vulnerabilities unless they cross a concrete security boundary:

- Model hallucination without tool execution or persistence.
- Prompt injection that only affects the current answer and does not trigger unauthorized tools, memory, credentials, or file changes.
- Unsafe behavior after the operator explicitly disables approvals or runs in a permissive mode.
- Reports requiring prior write access to EstaCoda configuration, local credentials, or source files.
- Local host compromise outside EstaCoda.
- Denial-of-service through intentionally huge local inputs, unless it affects default public workflows.
- Complaints that local terminal execution can access local files when the operator intentionally enabled local terminal execution.
- Social engineering against a maintainer outside the software boundary.

## Secure configuration guidance

Recommended defaults for normal development:

- Keep dangerous command approval enabled.
- Trust only the workspace you intend EstaCoda to modify.
- Keep credentials in local environment files that are ignored by Git.
- Never commit `.env` files, provider keys, tokens, or private SSH material.
- Review generated diffs before committing.
- Treat third-party skills as code.
- Review skill metadata, scripts, templates, and required environment variables before use.
- Do not expose a gateway publicly without allowlists, network protection, and secret hygiene.
- Use containers or isolated environments for untrusted repositories once supported.
- Keep CI checks required before merging.

## Secure contribution expectations

Security-sensitive PRs must include:

- The affected boundary.
- Threat model summary.
- Tests or smoke coverage.
- Manual verification steps.
- Notes on backwards compatibility.
- Any new configuration flags and their failure mode.
- Whether behavior fails open or fails closed.

Agent-generated PRs must disclose agent involvement and include human review before merge.

## Disclosure policy

Do not publicly disclose unresolved vulnerabilities before maintainers have had a reasonable opportunity to investigate and patch.

After a fix is available, maintainers should publish a brief advisory or release note describing:

- Affected versions.
- Impact.
- Fixed version or commit.
- Workaround if available.
- Credit, if the reporter wants attribution.

## Maintainer checklist

Before publishing the repository publicly:

- Enable GitHub private vulnerability reporting.
- Confirm the security contact email or remove it.
- Add `SECURITY.md` to the root of the repository.
- Add `docs/SECURITY_MODEL.md` for deeper architecture details.
- Add CI checks that prevent committed secrets.
- Add dependency and supply-chain checks.
- Add CODEOWNERS for security-sensitive paths.
- Require review for changes to approval logic, tool execution, gateway auth, skills, memory, credentials, install scripts, and CI workflows.
