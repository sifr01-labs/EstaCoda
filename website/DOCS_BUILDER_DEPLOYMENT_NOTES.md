# Docs Builder Deployment Notes

## Hosting Context

- **Domain:** `estacoda.kemetresearch.com`
- **Host:** Replit
- **Repo:** `sifr01-labs/EstaCoda`
- **Docs site root:** `website/`

## Scope of This Handoff

This repository contains the Docusaurus docs source. The docs builder agent is responsible for installing dependencies, building the static site, and serving or redeploying `website/build/` from the Replit environment.

## Docs Builder Agent Steps

When the docs builder agent picks this up, the expected workflow is:

1. Ensure Node.js >= 22.18.0 is available.
2. From the repo root:
   ```bash
   cd website
   pnpm install --ignore-workspace --frozen-lockfile
   pnpm build
   ```
3. The static build output will be at:
   ```
   website/build/
   ```
4. Serve the `website/build/` directory with Replit's web serving mechanism or:
   ```bash
   pnpm serve
   ```

## Notes

- Do not assume GitHub Pages, Cloudflare, or Vercel.
- Docusaurus `baseUrl` is `/docs/`.
- No versioning is configured for v0.1.0.
- Arabic locale (`ar`) is configured; RTL styles are handled by Docusaurus.
- Search is configured with `@easyops-cn/docusaurus-search-local`.
- The search index is generated during `pnpm build`.
- No hosted search backend or Algolia credentials are required.
