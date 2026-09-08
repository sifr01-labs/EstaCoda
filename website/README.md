# EstaCoda Documentation Site

This is the Docusaurus v3 documentation site for EstaCoda.

## Local Development

```bash
cd website
pnpm install --ignore-workspace
pnpm start
```

The dev server starts at `http://localhost:3000`.

## Build

```bash
cd website
pnpm install --ignore-workspace --frozen-lockfile
pnpm typecheck
pnpm build
```

Static output goes to `website/build/`.

## Serve Locally

```bash
cd website
pnpm serve
```

Serves the built site at `http://localhost:3000`.

Local search uses content-hashed index filenames for cache invalidation. Avoid
query-string hashing here: with `/docs/` and trailing slashes, Docusaurus's local
server redirects those asset requests to nonexistent paths.

## Locales

- **English (canonical):** `website/docs/`
- **Arabic:** `website/i18n/ar/docusaurus-plugin-content-docs/current/`

To start the dev server in Arabic:

```bash
pnpm start -- --locale ar
```

To build all locales:

```bash
pnpm build
```

## Replit Deployment

See `DOCS_BUILDER_DEPLOYMENT_NOTES.md` for docs builder deployment instructions.

## Dependency security maintenance

The website has its own lockfile and dependency policy. Use `--ignore-workspace`
when installing or updating it so root runtime dependencies remain separate.

The website-only `express@4.22.2>qs` override selects `qs@6.16.0` to address
GHSA-4mjr-xmp4-gh2g and GHSA-x5fp-wj9c-mxmx. Express 4.22.2's `~6.15.1` range
does not admit this fix. Remove the override when an upstream Express update
resolves a patched version without it.

As of 2026-09-08, five advisories remain across `serialize-javascript`, `uuid`,
and `image-size`. The first two require compatibility review beyond their
parents' declared major versions; `image-size` has no published patched release.
These advisories are not suppressed. Review `pnpm audit --ignore-workspace`
before accepting untrusted build inputs or exposing development servers.
