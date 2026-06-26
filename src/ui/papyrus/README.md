# Papyrus

Papyrus is EstaCoda’s native terminal UI substrate.

## Owns
- screen buffer and frame diffing
- terminal control primitives
- text measurement, wrapping, bidi-safe rendering
- raw prompt rendering
- widget state models and render helpers
- overlays, select menus, fuzzy pickers, approval cards
- suggestion UI plumbing and ghost text state

## Does not own
- approval/security decisions
- workspace trust policy
- provider/model routing semantics
- command execution
- gateway approval queues
- persistence of secrets
- model/runtime behavior

## Boundaries
- `src/ui/papyrus/screen` owns cells, frames, output, compositor.
- `src/ui/papyrus/termio` owns ANSI/CSI/OSC/SGR primitives.
- `src/ui/papyrus/input` owns prompt-local input state, typeahead, secret input, ghost text.
- `src/ui/papyrus/widgets` owns pure widget models and render helpers.
- `src/cli` maps product flows into Papyrus surfaces.
- `src/security` remains authoritative for permission decisions.

## Security rules
- Secret values must never enter render state.
- Approval widgets display decisions; they do not grant authority.
- Suggestions must respect workspace/profile/capability gates.
- Clipboard and shell-history features remain opt-in.

## No React / No Ink component layer
Papyrus uses terminal state machines and a compositor, not React, Yoga, or Ink’s component runtime.
