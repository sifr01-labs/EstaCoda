# Desktop conversation activity

Conversation presents a durable activity disclosure above each run's responses. User messages and recorded outcomes delimit runs; new work after an outcome receives its own disclosure. The component derives its display from paginated activity, without changing execution or storage.

- The latest plan is shown once. Earlier plan versions and progress messages remain expandable.
- Tool starts and results share one row only when their scoped call identities match. Separate calls, including retry attempts, remain inspectable. Older records without an identity stay separate and are counted as events, not calls.
- Failures remain visible in the collapsed summary. Recovery is labeled only when the recorded execution outcome explicitly reports recovered errors. A later successful call alone does not prove recovery.
- Final responses remain outside the activity disclosure. A running turn can show its latest recorded progress and the existing live response preview. Updates do not automatically close an expanded disclosure.
- Registered outputs are listed beneath the response and opened with the existing artifact API. Integrity and truncation information accompany previews. Results remains the destination for full execution evidence.
- Counts describe loaded records. A pending page cursor is disclosed; bounded or older history is not represented as the complete history or current live work. Duration is the recorded span to the outcome, not an inferred active-execution timer.
- English, Arabic, bidirectional technical labels, light/dark appearances, keyboard disclosures, and narrow layouts use the existing desktop design system.

## Data and security boundary

The read-only display projection includes a hash of the persisted tool-call identity, the allowlisted message phase, registered artifact references and bounded display metadata, and the canonical recovered-error flag. SQLite reads only the necessary fields. Tool arguments, raw results, provider replay data, artifact storage keys, and local storage paths are excluded.

Output references are routing handles, never permission grants. Profile/session ownership is checked in projection and again by existing artifact APIs. Disconnect or profile change invalidates pending previews. Existing approvals, secure input, browser control, and connector recovery paths remain authoritative; expanding history does not execute tools or replay a failed action.

New display fields require a current desktop and control-service build. Legacy records without call IDs remain supported.
