# Uninstall EstaCoda

## Remove binary and state

```bash
# Remove the binary
rm -f ~/.estacoda/bin/estacoda
rm -f ~/.local/bin/estacoda

# Remove state (this deletes all config, memory, skills, and sessions)
rm -rf ~/.estacoda

# Remove PATH entries from shell rc files
# Edit ~/.bashrc, ~/.zshrc, or ~/.config/fish/config.fish
# and remove any lines that reference ESTACODA_HOME
# (only if you manually added them for dev isolation).
```

`~/.estacoda` is shorthand for the default state location when `ESTACODA_HOME` is not set. If you run EstaCoda with a separate state home, remove that state root instead:

```bash
ESTACODA_HOME=/srv/estacoda-state
rm -rf "$ESTACODA_HOME/.estacoda"
```

Do not confuse this with the operating-system user home. `ESTACODA_HOME` controls EstaCoda state only. `HOME` remains the OS user home used for shell rc files, systemd user units, launchd plists, and generated service `HOME`.

Example split:

```bash
HOME=/home/agent ESTACODA_HOME=/srv/estacoda-state
```

Expected locations:

```text
EstaCoda state:
  /srv/estacoda-state/.estacoda/...

OS/service files:
  /home/agent/.config/systemd/user/...
  /home/agent/Library/LaunchAgents/...
```

Service teardown and probing use the OS/service-user home for service files. State removal uses the `ESTACODA_HOME`-derived state paths. If `ESTACODA_HOME` and `HOME` differ, both locations may need inspection during a manual uninstall.

## Preserve state before removal

If you want to keep your configuration for a future reinstall:

```bash
# Back up state
cp -r ~/.estacoda ~/.estacoda-backup-$(date +%Y%m%d)

# Later, restore it:
mv ~/.estacoda-backup-YYYYMMDD ~/.estacoda
```

## Protected paths

The following paths are preserved during updates and should be backed up before uninstall. They are shown under the default state root; replace `~` with your `ESTACODA_HOME` value when state is isolated.

- `~/.estacoda/trust.json`
- `~/.estacoda/active-profile.json`
- `~/.estacoda/workspace-approvals.json`
- `~/.estacoda/sessions.sqlite`
- `~/.estacoda/memory/shared/`
- `~/.estacoda/packs/`
- `~/.estacoda/profiles/<id>/config.json`
- `~/.estacoda/profiles/<id>/.env`
- `~/.estacoda/profiles/<id>/auth.json`
- `~/.estacoda/profiles/<id>/USER.md`
- `~/.estacoda/profiles/<id>/SOUL.md`
- `~/.estacoda/profiles/<id>/MEMORY.md`
- `~/.estacoda/profiles/<id>/promotions.json`
- `~/.estacoda/profiles/<id>/skills/`
- `~/.estacoda/profiles/<id>/cron/`
