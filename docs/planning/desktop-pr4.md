# Desktop PR 4 implementation record

Branch: `ame/desktop-foundation`. Eight planned slices; implementation in progress.

## 1. Session Work projections

The bridge exposes `work.list`, `work.get`, and `work.activity` from the selected
profile's canonical SQLite state. Read-only capture does not run migrations,
create state, acquire execution leases, or instantiate a runtime. Work identities
retain canonical Session IDs and optional parent references. Outcomes come from
canonical final-outcome records, not assistant prose. Transcript projections omit
raw tool arguments/results and redact displayed text.

Bootstrap replaces the materialized snapshot and all page tokens. Tokens are
opaque and bound to the bridge, epoch, query and page size. Replies have a byte
budget in addition to item limits. The alpha capture currently refuses profiles
over 1,000 Sessions, transcripts over 1,000 messages, or snapshots over 8 MiB;
it returns snapshot-required instead of silently truncating the Work list.

Validation: focused snapshot, subscription and bootstrap tests (8 tests) passed.
Security review: reads are profile scoped; capture uses a read-only connection;
no new execution or approval authority is exposed in this slice.
