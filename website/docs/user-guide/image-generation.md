---
title: Image Generation
description: Provider-backed image generation workflow.
sidebar_position: 13
---

# Image Generation

Image generation is a provider-backed tool workflow. The agent calls `image.generate` with a text prompt; the configured provider returns an image URL; EstaCoda downloads, caches, and records the result as a local artifact.

It is not a built-in model capability. You need a provider account, an API key, and a selected profile configured to use it.

## Supported providers in v0.1.0

| Provider | Default model | Default env var | Base URL |
|----------|---------------|-----------------|----------|
| FAL | `fal-ai/flux-2/klein/9b` | `FAL_KEY` | `https://fal.run` |
| BytePlus / Seedream | `seedream-5-0-260128` | `BYTEPLUS_ARK_API_KEY` | `https://ark.ap-southeast.bytepluses.com/api/v3` |

FAL is the default provider. BytePlus model access is version-specific; the model must be activated in your Ark Console account before use.

## Setup

Configure the provider in the selected profile:

```bash
estacoda image setup --provider fal --model fal-ai/flux-2/klein/9b --api-key-env FAL_KEY
estacoda image setup --provider byteplus --model-version seedream-5 --api-key-env BYTEPLUS_ARK_API_KEY
estacoda image setup --provider fal --api-key <key>
```

Setup writes provider configuration into `~/.estacoda/profiles/<id>/config.json` under the `imageGen` key. If you pass `--api-key`, the command stores the secret in the profile `.env` file and references it by env var name.

Check current configuration:

```bash
estacoda image status
```

Verify readiness (key presence and optional provider probe):

```bash
estacoda image verify
estacoda image verify --skip-provider-check
```

List available models and aliases:

```bash
estacoda image models --provider fal
estacoda image models --provider byteplus
```

## Configuration file

Image generation config lives in the selected profile:

```text
~/.estacoda/profiles/<profile-id>/config.json
```

Example:

```json
{
  "imageGen": {
    "provider": "fal",
    "model": "fal-ai/flux-2/klein/9b",
    "useGateway": false,
    "fal": {
      "model": "fal-ai/flux-2/klein/9b",
      "apiKeyEnv": "FAL_KEY",
      "baseUrl": "https://fal.run"
    }
  }
}
```

- `provider`: `fal` or `byteplus`.
- `model`: exact provider model id or an alias resolved at runtime.
- `useGateway`: whether to route through a gateway broker. In v0.1.0 this remains `false` for direct provider calls.
- Provider blocks (`fal`, `byteplus`) can override `model`, `apiKeyEnv`, and `baseUrl`.

## Tool behavior

The agent invokes `image.generate` automatically when you ask for an image. You can also reason about it in tool-use contexts.

Parameters:

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `prompt` | `string` | yes | The text prompt. |
| `aspectRatio` | `string` | no | `square`, `landscape`, or `portrait`. Defaults to square. |
| `model` | `string` | no | Overrides the configured model for this request. |
| `seed` | `number` | no | Optional seed for reproducibility. |

Aspect ratio mapping:

| Aspect | FAL | BytePlus |
|--------|-----|----------|
| `square` | `square_hd` | `1920x1920` |
| `landscape` | `landscape_16_9` | `2560x1440` |
| `portrait` | `portrait_16_9` | `1440x2560` |

Result:

- The image is written to `~/.estacoda/profiles/<id>/image-cache/`.
- An artifact is recorded with metadata: provider, model, aspect ratio, seed, source URL.
- The tool returns the artifact path, provider, model, and artifact ID.
- Telegram delivery sends the image as a photo when the gateway and channel are ready.

## Failure modes

| Symptom | Likely cause | Recovery |
|---------|--------------|----------|
| Missing provider key | The env var referenced by `apiKeyEnv` is absent. | Add the key to the selected profile `.env` and retry. |
| Unsupported provider | Only `fal` and `byteplus` are implemented. | Select a supported provider. |
| Remote provider error | HTTP 4xx/5xx, auth failure, or model not activated. | Check provider status, credentials, and model activation. |
| Generated URL download failed | Provider returned a URL that could not be fetched. | Retry the request; transient network issues are possible. |
| Invalid output path | Cache directory missing or unwritable. | EstaCoda creates the directory recursively; check filesystem permissions. |
| Safety / provider refusal | Provider rejected the prompt for policy reasons. | Rephrase the prompt or check provider content policies. |
| BytePlus `ModelNotOpen` | The Seedream model is not activated for your account. | Activate it in the Ark Console, or choose another model with `estacoda image models --provider byteplus`. |

## State and files

| Path | Purpose |
|------|---------|
| `~/.estacoda/profiles/<profile-id>/image-cache/` | Downloaded generated images. |
| `~/.estacoda/profiles/<profile-id>/config.json` key `imageGen` | Provider and model configuration. |
| `~/.estacoda/profiles/<profile-id>/.env` | API key secrets (if stored by setup). |

## Related docs

- [Providers](./providers.md) — provider configuration and credential rules
- [Tools](./tools.md) — tool risk classes and availability
- [Gateway](./gateway.md) — channel delivery of generated images
