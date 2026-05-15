# Install EstaCoda

EstaCoda is not published as a public npm package yet. Keep install docs clear about which paths work now and which paths are planned.

## Local Developer Path

Use this inside a source checkout:

```bash
cd /path/to/EstaCoda
corepack enable
pnpm install
pnpm run build
node dist/index.js --help
node dist/index.js --version
```

For packaging regression checks:

```bash
pnpm run verify:local-bin
scripts/verify-package-bin.sh
```

`scripts/verify-package-bin.sh` builds the project, captures the tarball filename from `npm pack --json`, installs that tarball into a temporary prefix, runs the installed `estacoda` binary, and cleans up after itself.

## Local Manual Installer

Use this from a local checkout when you want an `estacoda` command on your PATH:

```bash
bash scripts/install.sh
```

The script checks Node.js >= 22.18.0 and Corepack, builds `dist/`, writes a Node-backed wrapper to `~/.estacoda/bin/estacoda`, and updates PATH where possible.

You can also run the wrapper directly from the checkout:

```bash
bash scripts/estacoda-wrapper.sh --version
```

After local manual install, restart your shell or run:

```bash
export PATH="$HOME/.estacoda/bin:$PATH"
```

## Planned Launch Installer

The intended launch install direction is the hosted curl installer:

```bash
curl -fsSL https://estacoda.kemetresearch.com/install.sh | bash
```

Do not treat this as a verified public path until the hosted installer is live and release validation has passed.

## Optional Future Npm Path

The package has local installability metadata for tarball validation, but public npm publication remains blocked with `private: true`.

Do not claim these work until the package is actually published:

```bash
npm install -g estacoda
npx estacoda --help
```

If npm publication stays in the release strategy, update this document only after `npm publish --dry-run`, real publication, and installed binary validation pass.

## Post-Install

For any path that gives you an `estacoda` command:

```bash
estacoda init       # Bootstrap state directories
estacoda setup      # Reviewed setup flow for provider, trust, security, workflow, and optional capabilities
estacoda setup --interactive
estacoda verify     # Check readiness
estacoda            # Start interactive session
```

`estacoda setup --interactive` uses the guided setup router. It runs first-run setup for new users, opens the guided editor for configured or degraded setup, and shows repair-first diagnostics for missing credentials, broken provider routes, broken config, untrusted workspaces, and state paths that are not writable.

Setup review appears before apply. Cancelling review does not write config, trust, state, or `.env`. Verification is read-only, and launch requires verified-ready setup or an explicit limited-mode choice after warnings are shown.

Advanced/direct provider setup can reference an existing environment variable:

```bash
estacoda setup --provider deepseek --model deepseek-chat --api-key-env DEEPSEEK_API_KEY
estacoda setup --advanced --provider deepseek --model deepseek-chat --api-key-env DEEPSEEK_API_KEY
```

Direct setup flags are advanced compatibility paths. Guided repair uses reviewed setup instead.

## Update

```bash
estacoda update          # Dry-run: see what would update
estacoda update --apply  # Apply update (requires ESTACODA_UPDATE_ARTIFACT)
```

## Troubleshooting

**Node too old**: Install Node.js >= 22.18.0.

**pnpm not found**: Run `corepack enable`, then retry.

**No prebuilt binary**: The current local installer builds `dist/` from the local checkout and installs a Node-backed wrapper. This is expected until release artifacts are published.
