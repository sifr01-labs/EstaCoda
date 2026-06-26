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

## Current Substrate Surface

This PR may expose only the intentional inert substrate APIs under this
namespace: terminal I/O sequence primitives, screen-local geometry and width
helpers, cell buffers, frame snapshots, pure frame diffs, an inert compositor
bridge, and an inert border primitive.

The root `src/ui/papyrus/index.ts` remains intentionally inert for this PR so
future integration can choose a reviewed public import surface. Nested barrels
may expose local substrate modules for tests and later integration work, but
they should not export product view-model builders, provider/runtime/session
types, prompt chrome, CLI commands, raw input handlers, or live terminal
lifecycle managers.

Raw input, widgets beyond the inert border primitive, autocomplete, clipboard,
shell-history, Slack/MCP integration, focus/mouse tracking, terminal lifecycle,
Vim-style editing, and live renderer adoption remain outside this PR.

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

Implementation files under `src/ui/papyrus` must not write to stdout or stderr,
toggle raw mode, spawn subprocesses, execute shell helpers, mutate terminal
state at module load, or introduce clipboard behavior. Dependency files should
change only in the same commit that first consumes the dependency and documents
why it is needed.
