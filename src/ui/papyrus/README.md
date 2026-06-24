# Papyrus

Papyrus is EstaCoda's no-React terminal surface substrate. It is the bounded
home for terminal cells, frame diffing, raw prompt input later, terminal
lifecycle later, overlays and widgets later, and scrollable transcript regions
later.

Papyrus must not become a catch-all for view-model builders, product copy,
provider or runtime behavior, session logic, or unrelated CLI commands. Existing
view-model construction and renderer-facing product decisions stay outside this
namespace unless a later integration PR explicitly moves a terminal-surface
concern here.

## PR 1 Boundary

The first Papyrus PR is inert. It establishes the namespace and porting notes
only; it must not change live CLI behavior, replace the current root
`src/ui/bidi.ts`, route renderer output through Papyrus, or migrate prompt
chrome, readline, provider, runtime, or session logic.

Renderer substrate work and raw input work should stay separate. The first PR
may add inert substrate modules and tests for those modules, but raw stdin,
terminal lifecycle, suspend/resume handling, autocomplete, widgets, clipboard,
filesystem providers, and command/provider features belong to later scoped PRs.

Current root UI behavior remains untouched until the later renderer integration
PRs intentionally opt into Papyrus behind reviewed rollout paths.

## Porting Rules

Reference material is adapted from the Papyrus/Ink renderer substrate inventory.
Files must not be copied blindly. Each future file port needs an import and
dependency audit for React, Yoga or DOM assumptions, Bun-only APIs, source-app
absolute imports, analytics, source-app config or state, subprocess helpers, and
missing utilities.

Dependencies are added only in the commit that first consumes them. Do not add
packages for planned files before a live imported module requires them.

Terminal lifecycle files must prove cleanup behavior before live use, including
raw mode, cursor visibility, bracketed paste, focus or mouse modes,
suspend/resume, normal exit, and error paths.

Filesystem, command, shell-history, clipboard, provider, Slack/MCP, and other
external or privacy-sensitive features are outside PR 1 unless explicitly
scoped and reviewed.

