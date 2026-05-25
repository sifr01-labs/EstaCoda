# Replit Deployment Notes

## Hosting Context

- **Domain:** `estacoda.kemetresearch.com`
- **Host:** Replit
- **Repo:** `KemetResearch/EstaCoda`
- **Docs site root:** `website/`

## Scope of This Pass

This branch (`release/docusaurus-scaffold-v0.1.0`) only creates the Docusaurus scaffold and placeholder docs tree. It does **not** deploy anything.

## Later Replit Agent Steps

When the Replit agent picks this up, the expected workflow is:

1. Ensure Node.js >= 22.18.0 is available.
2. From the repo root:
   ```bash
   cd website
   pnpm install
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
- Docusaurus `baseUrl` is `/`.
- No versioning is configured for v0.1.0.
- Arabic locale (`ar`) is configured; RTL styles are handled by Docusaurus.
- Search is not yet configured; a TODO is left in the config if local search causes dependency friction.
