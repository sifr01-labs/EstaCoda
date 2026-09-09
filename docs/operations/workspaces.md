---
title: "Named workspaces and session ownership"
description: "Local workspace selection, immutable execution targets, trust boundaries, and migration."
---

# Named workspaces and session ownership

Named workspaces are optional shortcuts to existing local directories. Ordinary launch still works with `cd my-project && estacoda`. Bare launch starts fresh; `--continue` explicitly resumes the selected profile/workspace's last CLI session.

## Select and manage workspaces

```bash
estacoda workspace add app /path/to/app
estacoda workspace list
estacoda workspace show app
estacoda workspace open app
estacoda --workspace app "Review the current changes"
estacoda --profile work --workspace app --continue
estacoda workspace rename app product
estacoda workspace move product /new/existing/path
estacoda workspace remove product
```

`add` defaults to the current workspace when its path is omitted. Aliases are profile-local, case-insensitive ASCII names: 1–64 letters, digits or hyphens, beginning with a letter. Management commands accept the stable `ws_...` ID as well as an alias. Directories must exist; files and missing paths are rejected. `open` enters the ordinary launcher for the selected directory, including its existing setup and trust checks.

Place `--workspace <alias>` before the command or prompt. After the first command/prompt token, that option belongs to the command or prompt instead. In particular, `estacoda bench run --workspace /benchmark/path` retains the benchmark's path option. Profile selection remains command-local and does not update `active-profile.json`.

| Operation | Effect |
|---|---|
| Add | Saves a name and stable ID for a verified canonical directory |
| Rename | Changes the alias; preserves ID, path identity and location revision |
| Move | Updates the registration to another existing directory and advances its location revision; does not move files |
| Remove | Removes the registration; preserves files, target history, Sessions and Tasks |
| Select | Chooses a working directory for new work; does not retarget an existing Session or Task |

A move uses the location revision read by that operation. A competing move fails with a retry/inspection message rather than overwriting another move. Independent processes coordinate registry writes through SQLite transactions; alias uniqueness is enforced in the database.

## Trust and identity

Registration, rename and move never grant workspace trust or persistent approvals. Existing directory trust rules still apply at the selected path. A newly selected path needs its own applicable trust grant; an alias cannot carry the old path's authorization to it. Profile configuration still loads exactly one selected profile and is not merged with project configuration.

Workspace identity preserves the existing Task algorithm: SHA-256 of the canonical absolute path returned by `realpath`. This identifies a path, not repository contents, an inode, or a sandbox. Aliases and symlinks resolving to the same directory have the same path identity. Replacing a registered canonical directory with a symlink to a different directory blocks selection until an explicit move. Replacing contents at the same canonical path does not change identity.

## Targets and Sessions

Core code stores names and local execution targets in `~/.estacoda/profiles/<profile-id>/workspaces.sqlite` (registry format 1). This is profile-local runtime state, not project configuration. The database file uses mode `0600`; the registry rejects a database symlink and unknown registry versions.

A local target records its profile, stable ID, generation, source snapshot, actual working directory and status. A named source reference, when supplied on acquisition, also records the registered workspace ID and location revision. Existing bound Sessions retain their original target even if later selected through another alias. Local targets currently use generation 1; no operator generation-refresh, worktree, copy, remote-target or target-cleanup API is shipped here.

Durable runtime Session creation records the target binding and compatibility `metadata.workspaceRoot` together. Child Sessions inherit their parent's binding. New Tasks inherit their creator/parent binding and retain the existing Task workspace fields; these bindings cannot be changed through updates. Old unbound Tasks remain readable and retain their existing Task workspace/lease checks.

Runtime construction, subsequent runtime entry, child execution, resume, ACP load, and CLI/channel attachment validate the selected profile and actual workspace. A bound Session also requires an available target with the matching generation in that profile's target store. Missing, stale, cross-profile or cross-workspace targets fail closed. Attachment failures preserve the existing surface pointer; an attempted channel attach may consume its one-use handoff code, so create a fresh code after correcting the scope. ACP validates before replaying transcripts and lists only its selected profile's Sessions.

A moved or removed alias cannot change a historical target. Existing work can continue at its original directory if that directory and target remain valid. If the old directory is gone, start new work at the explicitly selected new location. There is no implicit migration of running work.

## Upgrade and legacy data

Session schema 33 adds nullable execution-target fields to Sessions and Tasks and immutability checks. Existing messages and workspace compatibility fields remain readable. The target store and global Session database are separate files: target acquisition followed by Session creation is a recoverable reference sequence, not a cross-file transaction. A failed Session insert can leave an unused target that later acquisition safely reuses.

An unbound legacy Session with consistent existing workspace metadata can be validated against its real directory and bound once on runtime construction. Canonical path aliases are accepted. The bind uses a write transaction and compares the metadata snapshot to avoid overwriting a concurrent update. A rootless legacy Session is eligible only in an explicit local flow when it is already identified as a CLI root Session. Ambiguous remote, conflicting, ended or cross-profile records are not adopted. Open established local work in its original workspace, or start a new Session when ownership cannot be established; do not repair this by editing ownership JSON.

Back up runtime state before upgrading, with all EstaCoda processes stopped. Preserve the global `sessions.sqlite` and the profile's `workspaces.sqlite` together. The Session migrator attempts a version-labelled SQLite backup beside the database, but that backup is best-effort; verify your own snapshot. Downgrading older binaries against migrated state is unsupported: pre-PR1 binaries do not reliably reject this new format. Restore a compatible pre-upgrade snapshot before running an older version. This version rejects future Session database versions and unknown binding formats.

Profile IDs remain ownership boundaries. Renaming a profile directory does not migrate historical Session/Task ownership or embedded workspace/target profile IDs. Keep the owning profile ID when continuing existing work; cross-profile migration is outside this slice.

## Execution approvals

Workspace selection also supplies core-verified host facts for approval scope. Alias changes preserve equivalent authority; changing the actual workspace does not carry a grant with it. See [Execution authority and approval reuse](execution-approvals.md) for exact-action approval, persistent reuse, legacy renewal and revocation. Host facts do not claim containment.

## Limits and verification

The implemented workspace and authority slices validate profile/workspace ownership, recheck Session/target ownership before dispatch, and coordinate persistent registry/approval writes. They do not implement cross-process exclusive execution, shared supervisor control IPC, continuous revocation/termination of already dispatched work, managed worktrees, Docker, or containment. Two clients passing the same workspace check do not thereby acquire a single execution owner. Those guarantees require the later ownership and environment work.

Coverage includes independent-process alias/move/target/Session races, legacy database reopening, canonical path aliases, trust separation, immutable Session/Task bindings, CLI and channel pointer preservation, and ACP rejection before transcript replay. The session-continuation smoke case uses real temporary directories and SQLite targets. These are local deterministic tests, not live-provider, Desktop or multi-tenant isolation evidence.
