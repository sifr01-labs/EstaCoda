---
title: Providers
description: Provider configuration, model routing, credential resolution, and fallback behavior.
sidebar_position: 4
---

# Providers

The provider configuration decides which model EstaCoda uses, how credentials are loaded, and what happens when the primary route fails. There is no hidden provider logic. Every route is inspectable, every credential is env-backed, and every fallback is explicit.

This page explains how provider configuration behaves, not which provider is "best." The best provider is the one you have credentials for, that supports the mode you need, and that passes a live test.

---

## What Provider Configuration Does

EstaCoda loads provider configuration from the active profile's `config.json`. At minimum, a provider route needs:

- `provider` — the provider ID
- `model` — the model name
- `apiKeyEnv` — the environment variable that holds the API key

Example primary route:

```json
{
  "model": {
    "provider": "openai",
    "model": "gpt-4o",
    "apiKeyEnv": "OPENAI_API_KEY"
  }
}
```

At runtime, EstaCoda reads `process.env[apiKeyEnv]` and passes it to the provider executor. The key is never stored in `config.json`. If the environment variable is missing, the route is non-runnable and the setup flow will tell you exactly which variable is absent.

---

## Model Catalog and Discovery

EstaCoda maintains an offline model catalog enriched from `models.dev` metadata. The catalog knows provider capabilities, context windows, and pricing hints. It does not fetch over the network unless you explicitly enable network catalog refresh.

The catalog is a safety net, not a guarantee. A provider being catalog-known does not mean it is runnable in this build. See the [Provider Reference](../reference/provider-reference.md) for the exact maturity label of every provider.

---

## Primary Route

The primary route is the model EstaCoda uses for normal inference. It is defined under `model` in profile config.

If the primary route becomes non-runnable — missing credentials, stale model name, or provider failure — EstaCoda does not silently fall back to a different provider. It reports the failure and, in interactive mode, offers repair guidance.

---

## Fallback Routes

Fallback routes are configured under `model.fallbacks`. They are ordered. EstaCoda tries each fallback only when the primary route fails at execution time, not at config load time.

```json
{
  "model": {
    "provider": "openai",
    "model": "gpt-4o",
    "apiKeyEnv": "OPENAI_API_KEY",
    "fallbacks": [
      { "provider": "deepseek", "model": "deepseek-chat", "apiKeyEnv": "DEEPSEEK_API_KEY" }
    ]
  }
}
```

Fallbacks preserve `apiKeyEnv`, `baseUrl`, `apiMode`, and `authMethod` metadata when available. Fallback evaluation is logged. If all fallbacks fail, the turn reports the error and stops.

Fallback routes are manageable through both the Setup Editor (`edit-fallback-model-route`) and `estacoda model fallback ...`.

---

## Model Switching During a Session

The `/model` command changes the model for the current session without editing profile config.

```text
/model openai/gpt-4o
```

This creates a session-scoped override. It persists with the session and is revalidated on every runtime construction. If the override route becomes stale or non-runnable, it is ignored non-fatally and the configured primary route is used.

Persistent changes require explicit authorization:

```text
/model --global openai/gpt-4o
```

Global writes mutate the profile-level primary route after trust checks pass. They do not collect credentials inside the chat session. Use `estacoda model setup` for credential collection.

To clear a session override:

```text
/model clear
```

`/model --global clear` is rejected.

---

## Codex Setup Path

Codex is not an option in the onboarding wizard. It is a public CLI setup path for advanced users who want to use the Codex CLI model.

```bash
estacoda model setup codex
```

This command runs OAuth device-code authentication, stores tokens in `~/.estacoda/auth.json`, and configures the `codex/o3` route. Raw OAuth tokens are not printed. Route config remains separate from token storage.

Codex is excluded from the onboarding wizard by design. If you need Codex, run the setup command explicitly.

---

## Auxiliary Routes

Auxiliary routes handle specialized tasks: vision, compression, security assessment, web extraction, session search, and others. They resolve through the same provider infrastructure as the primary route.

Config example:

```json
{
  "auxiliaryModels": {
    "assessor": { "provider": "openai", "model": "gpt-4o-mini", "apiKeyEnv": "OPENAI_API_KEY" },
    "vision": { "provider": "openai", "model": "gpt-4o", "apiKeyEnv": "OPENAI_API_KEY" }
  }
}
```

The `assessor` route drives smart approval classification. It requires a working provider executor and a runnable model. If the assessor route is missing, malformed, or fails, the system falls back to manual approval. There is no `auxiliaryModels.approval` route. The assessor route is configurable through the Setup Editor (`edit-auxiliary-model-route`) in addition to direct config edits.

Missing auxiliary routes fail closed or fall back as documented by the calling subsystem. They do not crash the session.

Auxiliary route management is available through the Setup Editor (`edit-auxiliary-model-route`).

---

## Inspecting Provider State

Check the current primary route and its readiness:

```bash
estacoda model show
```

Run a live diagnostic against the configured provider:

```bash
estacoda model diagnose
```

List all catalog-known providers:

```bash
estacoda model list
```

The setup command repairs a broken route:

```bash
estacoda model setup
```

---

## Failure Modes and Recovery

**Missing API key:** The route is non-runnable. Run `estacoda model setup` or set the environment variable.

**Invalid model name:** The catalog does not recognize the model. Check the provider's documentation and update `config.json`.

**Provider timeout:** The request exceeded the configured timeout. Check network connectivity and provider status. Fallbacks are tried if configured.

**Tool-call exactness failure:** Some providers (notably OpenRouter) return tool calls in formats that require normalization. If tool calls fail, check the provider-specific normalization path in the executor logs.

**Smart approval fallback:** If the `assessor` auxiliary route is missing or fails, the system falls back to manual approval. This is safe but slower.

---

## Related

- [Provider Reference](../reference/provider-reference.md) — maturity matrix and capability boundaries
- [Configuration](../reference/configuration.md) — full config schema
- [Environment Variables](../reference/environment-variables.md) — env var reference
- [Security and Approvals](./security-and-approvals.md) — approval behavior
