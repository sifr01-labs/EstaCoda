# Obsidian Headless And Sync

Load this reference only when the user asks to connect a wiki to Obsidian, sync a vault, run on a headless/server machine, or browse the same wiki from another device.

## Desktop Obsidian

The wiki directory can be opened as an Obsidian vault:

- `[[wikilinks]]` render as clickable links.
- Graph View visualizes relationships.
- YAML frontmatter supports Dataview workflows.
- `raw/assets/` can be used as the attachment folder.

Suggested settings:

- Keep Obsidian wikilinks enabled.
- Set the attachment folder to `raw/assets/`.
- Use Dataview only if the user already wants richer local queries.

## Headless Sync

On a server or headless machine, `obsidian-headless` can sync a vault through Obsidian Sync. This is optional and requires the user's Obsidian account and subscription.

Do not install packages, run login commands, write systemd services, or enter credentials without explicit user approval.

Example flow, after approval:

```bash
npm install -g obsidian-headless
ob login --email <email>
ob sync-create-remote --name "Wiki Builder"
cd <wiki-path>
ob sync-setup --vault "<vault-id>"
ob sync
ob sync --continuous
```

Avoid passing passwords directly on the command line. Prefer interactive login or a safer credential flow supported by the installed tool.

## Background Service Sketch

Use this only on Linux systems where the user wants a persistent user service.

```ini
[Unit]
Description=Obsidian Wiki Sync
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/path/to/ob sync --continuous
WorkingDirectory=/path/to/wiki
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
```

Commands such as `systemctl --user enable --now ...`, `sudo loginctl enable-linger`, and service-file writes require explicit approval and should be explained before running.
