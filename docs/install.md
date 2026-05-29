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

The package has local installability metadata for tarball validation. `npm install -g estacoda` will work once the package is published.

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
estacoda setup      # Reviewed setup flow for provider, trust, security, Agent Evolution, and optional capabilities
estacoda setup --interactive
estacoda verify     # Check readiness
estacoda            # Start interactive session
```

`estacoda setup --interactive` routes new users into the Onboarding Wizard, opens the Setup Editor for configured or degraded setup (supporting primary provider/model, fallback route, auxiliary route, Agent Evolution, and optional capability editing), and shows repair-first diagnostics for missing credentials, broken provider routes, broken config, untrusted workspaces, and state paths that are not writable.

Onboarding Wizard users see a configuration summary, confirm it, then setup applies and verifies. The redacted manifest and apply plan still exist internally for operator inspection, but they are not the normal first screen after setup questions. Cancelling before apply does not write config, trust, state, or `.env`. Workspace trust is required before EstaCoda can run in that workspace; if trust is deferred, setup may be saved but launch is blocked with `Setup saved. Workspace trust is still required before EstaCoda can run here.`

`Start EstaCoda now?` appears only after successful apply and verification. If selected, setup reloads the selected profile config, reloads trust state, verifies workspace trust, rebuilds runtime from fresh config, and enters the normal interactive launcher.

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
