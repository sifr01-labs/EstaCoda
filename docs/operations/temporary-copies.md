# Temporary copies and authorized change application

PR 7 adds temporary-copy execution targets. A copy keeps its own working directory and immutable source-manifest reference. It can run with Local host or the selected Docker policy. Writes in the copy do not synchronize to the source. A writable Docker bind to a local target still writes that target immediately; it is not a temporary-copy workflow.

## Prepare a copy

Register and trust the source using the existing workspace and local setup flows. Prepare a JSON manifest listing each input file; paths are relative to the registered source. For example, `copy-inputs.json` can contain:

```json
{
  "version": 1,
  "files": [
    { "path": "src/counter.ts", "origin": "tracked" },
    { "path": "tests/counter.test.ts", "origin": "tracked" },
    { "path": "notes.txt", "origin": "untracked" }
  ],
  "application": {
    "version": 1,
    "outcome": "apply",
    "paths": [
      { "path": "src/counter.ts", "operations": ["update"] },
      { "path": "tests/counter.test.ts", "operations": ["update"] },
      { "path": "CHANGELOG.md", "operations": ["create"] }
    ]
  }
}
```

The application section is an explicit local operator authorization for this copy, source baseline, exact paths, and mutation types. It does not permit other paths, copies, profiles, or remote surfaces to borrow that authority. `update` includes file-content and permission-mode changes. `delete` must be explicitly listed and records destructive-local authority through the existing approval store. Path and command hardline checks remain non-overridable. Review the manifest before running the command; model-generated manifests do not approve themselves.

```bash
estacoda --profile work workspace add app /path/to/app
estacoda --profile work workspace copy app /path/to/app-copy /path/to/copy-inputs.json
```

The destination must not exist and must be separate from, and outside, the source directory. Host roots, credential directories and EstaCoda state cannot be source or destination roots. Use an engine-shared destination for Docker. Preparation prints a target record; retain its `id` for inspection, finishing and recovery.

Copies have a separate workspace-trust decision. Preparation does not grant trust or change the active profile. Use the existing local setup/trust flow before executing in the copy, then start a **new** Session there:

```bash
cd /path/to/app-copy
estacoda --profile work "Fix counter.ts and run its tests."
```

Core runtime acquisition recognizes the recorded copy root and binds the new Session to that temporary-copy target. It never resumes a source Session against the copy. A missing or replaced copy directory blocks acquisition rather than falling back to the source. You may register the copy directory under its own alias for selection; naming does not change the target's original source provenance.

## Apply or export

For successful local foreground CLI work, the runtime exports a durable change artifact after the provider/tool loop settles. If task-start authorization covers every change and current trust/grants and baselines still match, it applies the changes without another approval prompt. Review-only work exports instead. Cancelled, failed or uncertain foreground work is not automatically applied. Active managed processes, subagents or nonterminal Tasks in the copy also defer automatic finishing. Conflicts or application errors are reported as partial completion with attention details. Application finishing precedes the final outcome, transcript, checkpoint settlement and trajectory completion, so persisted completion agrees with the returned response.

To make the copy review-only, omit `application` or use:

```json
{ "version": 1, "outcome": "review", "paths": [] }
```

The outcome/scope is fixed for that copy. Expanded authority requires a freshly prepared copy and reviewed application plan. Revoke an application grant through the existing workspace approval store/controller; exports cannot create or renew a grant. A revoked grant blocks application and automated rollback.

These local operator commands also support explicit workflows (add `--json` to finish/apply/recover for detailed local inspection):

```bash
estacoda --profile work workspace changes <copy-target-id>
estacoda --profile work workspace finish <copy-target-id>
estacoda --profile work workspace apply <change-artifact-id>
estacoda --profile work workspace recover <change-artifact-id>
```

`changes` only exports. `finish` exports and applies when already covered, otherwise returns a review artifact. `apply` accepts an artifact ID from the selected profile's store, not an arbitrary patch/archive path, and rechecks provenance, trust, exact grant scope, file modes/hashes, source selection and containment. Conflicts are checked for the whole batch before mutation. Status `conflict` or `attention` exits nonzero; a retained artifact remains reviewable. No command silently widens the grant.

Automatic finishing is currently limited to successful local foreground CLI turns. New remote Sessions, remote input attached to CLI-originated Sessions, ACP and background/child work do not consume that local application authority automatically. After that work settles, a local operator can use the commands above. Runtime exports are registered in the Session's existing artifact events and artifact store; command-line-only exports use the copy ID as their operator capture scope.

No-change exports do not consume the copy. A copy has one nonempty application receipt. An explicit `apply` retry of that artifact cannot execute the mutations twice. A later `finish` or automatic finish returns attention and explains that no new changes were applied; further work needs a new copy/baseline. An `applied` receipt records a historical application, not continuing synchronization or a guarantee that the source still contains those bytes.

## Inputs, dependencies and bounds

- Manifests select 1–512 individual regular files, at most 8 MiB each and 32 MiB total. Exported working content has the same total bound; enumeration is bounded to 2,048 entries. Filesystem modes and binary bytes are preserved. Symlinks, hard links, sockets, devices, FIFOs and special permission bits are rejected.
- `tracked` checks Git's index and captures current working-file bytes, including existing local edits. It does not substitute HEAD contents. Git metadata is never copied.
- `untracked` selects an explicit existing file; ignored Git inputs are rejected. Plain directories without a Git repository can use explicit untracked inputs.
- `dependency` explicitly selects regular dependency inputs, including ignored dependency files. It does not install packages or traverse dependency symlinks. Dependency changes and `node_modules`, `.git` and `.estacoda` trees are excluded from exports/application. Prepare necessary regular dependencies explicitly or use dependencies already present in the execution environment.
- Sensitive paths, credential/state directories and secret-looking file types remain excluded even when tracked or declared as dependencies. This is path filtering, not a guarantee that otherwise selected source content contains no secrets.
- Only files are applied. Empty-directory deletion, directory renames, symlink changes, package installation, ownership/ACL/xattr copying and Git metadata application are unsupported. New parent directories may be created; empty directories can remain after failures or rollback. A rename is represented as an explicit create plus delete.

## Interrupted application and recovery

Application uses a shared source mutex across cooperating processes/profiles, durable intent/progress rows in the existing profile workspace database, and per-file staging. A process crash does not authorize replay of an uncertain mutation. `recover` reconciles the artifact and journal and attempts guarded rollback; it does not resume forward application automatically.

Rollback restores only files still matching the applied bytes and mode. Later user edits produce attention and remain untouched. An interrupted exclusive-create hard link is reconciled using its journaled staging path, inode identity and content hash. Unknown or changed staging files remain for inspection. Original source baselines and artifacts remain retained after recovery.

This is recoverable per-file application, not an atomic multi-file filesystem transaction or a power-loss durability guarantee. Keep unrelated editors and external writers settled while applying or recovering: the mutex coordinates EstaCoda application processes, not arbitrary applications. Host operators and same-user processes remain trusted; there is no hostile multi-tenant filesystem isolation. External effects such as network calls, commands, dependency installation and database writes cannot be undone by this file journal.

Partial preparation can leave a nonempty destination for inspection. This release does not automatically delete copy directories or garbage-collect their manifests, artifacts or journals. Stop all execution/inspection borrowers before manually removing backing files, and keep the provenance needed for unresolved recovery.

The first copy advances the profile workspace database to version 2. PR 0–6 readers reject that version instead of treating a copy as an unrestricted local directory. Preserve compatible backups of profile workspace state, global Sessions, approval/trust state, artifacts and needed copy/source directories before upgrading or downgrading.
