---
title: First Run
description: Initialize EstaCoda and continue with the onboarding wizard.
sidebar_position: 4
---

# First Run

This page documents **First Run** for EstaCoda v0.1.0.

## Purpose

Initialize EstaCoda and continue with the onboarding wizard.

## Optional Channels

First-run onboarding can configure optional channels. Choosing WhatsApp launches the same shared WhatsApp QR setup flow used by the Setup Editor and `estacoda whatsapp`: it checks the isolated bridge package, asks before dependency repair, renders the QR code in the terminal, and writes WhatsApp config/session state only after successful pairing.

If dependency repair is declined or fails, or QR pairing times out or fails, onboarding records WhatsApp as skipped or setup incomplete and continues. No partial WhatsApp config is written on those failure paths.

## Source of Truth

This Docusaurus documentation set is the public source for v0.1.0 user-facing claims. When it disagrees with implemented behavior, fix the docs or the code before shipping.

## TODO

- [ ] Migrate and rewrite content from existing repo docs.
- [ ] Align claims with v0.1.0 release scope.
- [ ] Add code examples, CLI snippets, and configuration samples.
- [ ] Cross-link related docs pages.
- [ ] Validate technical accuracy against current codebase.
