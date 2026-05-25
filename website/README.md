# EstaCoda Documentation Site

This is the Docusaurus v3 documentation site for EstaCoda.

## Local Development

```bash
cd website
pnpm install
pnpm start
```

The dev server starts at `http://localhost:3000`.

## Build

```bash
cd website
pnpm build
```

Static output goes to `website/build/`.

## Serve Locally

```bash
cd website
pnpm serve
```

Serves the built site at `http://localhost:3000`.

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

See `REPLIT_DEPLOYMENT_NOTES.md` for Replit-specific instructions.
