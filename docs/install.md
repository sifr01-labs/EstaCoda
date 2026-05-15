# Install EstaCoda

## One-line install (recommended)

```bash
curl -fsSL https://estacoda.kemetresearch.com/install.sh | bash
```

This will:
- Detect your OS and architecture
- Check for Node.js >= 22.18.0 and Corepack
- Install the `estacoda` binary into `~/.estacoda/bin/`
- Add `~/.estacoda/bin` to your shell PATH

After install, restart your shell or run:

```bash
export PATH="$HOME/.estacoda/bin:$PATH"
```

## Manual install

### Prerequisites
- Node.js >= 22.18.0
- Corepack / pnpm

### Steps

1. Clone the repository:
   ```bash
   git clone https://github.com/kemetresearch/estacoda.git
   cd estacoda
   ```

2. Install dependencies and build:
   ```bash
   corepack enable
   pnpm install
   pnpm run build
   ```

3. Run the install script:
   ```bash
   bash scripts/install.sh
   ```

4. Or use the wrapper directly:
   ```bash
   bash scripts/estacoda-wrapper.sh --version
   ```

## Post-install

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

**No prebuilt binary**: The v0.1.0 installer builds `dist/` from the local checkout and installs a Node-backed wrapper. This is expected until release artifacts are published.
