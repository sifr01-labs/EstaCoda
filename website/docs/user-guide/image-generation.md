---
title: Image Generation
description: Provider-backed image generation workflow.
sidebar_position: 13
---

# Image Generation

Image generation is a provider-backed tool workflow. The agent calls `image.generate` with a text prompt; the configured provider returns an image URL; EstaCoda downloads, caches, and records the result as a local artifact. When the selected model has an editing endpoint, the agent can also call `image.edit` to edit or blend source images with a text instruction.

It is not a built-in model capability. You need a provider account, an API key, and a selected profile configured to use it.

## Desktop image canvas

In the desktop conversation, image generation appears as a canvas with the actual tool status and elapsed time. A verified retained image loads automatically when its canvas approaches the visible area. The canvas follows the app's light or dark appearance and supports Arabic, keyboard navigation, and reduced motion.

- Open an image at full size, inspect its details, or save it through the desktop save dialog.
- Describe a change beneath the image. The request names the selected image and routes to `image.edit` with that source, through the normal chat submission, model selection, permissions, and approval flow.
- After a refinement, switch between the reference and result or use the comparison slider. These links are reconstructed from the recorded refinement request when you reopen the conversation.
- An unfinished message or pending submission disables refinement so your draft is preserved. If a submission response is lost, use the composer's **Check status** action before sending again.
- **Retry preview** reloads retained media only. **Retry image request** starts a new request after a failed or stopped image operation. Provider support and the chat's permissions still apply.

Previews use verified retained raster files, not arbitrary image URLs in assistant text. Missing, changed, or expired images show an unavailable state. Disconnecting or switching profiles clears displayed media. Other saved files remain in the existing file viewer.

## Supported providers in v0.1.0

| Provider | Default model | Default env var | Base URL |
|----------|---------------|-----------------|----------|
| FAL | `fal-ai/flux-2/klein/9b` | `FAL_KEY` | `https://fal.run` |
| BytePlus / Seedream | `seedream-5-0-260128` | `BYTEPLUS_ARK_API_KEY` | `https://ark.ap-southeast.bytepluses.com/api/v3` |
| OpenAI | `gpt-image-2-medium` | `OPENAI_API_KEY` | `https://api.openai.com/v1` |

FAL is the default provider. BytePlus model access is version-specific; the model must be activated in your Ark Console account before use. EstaCoda also recognizes an existing BytePlus `ARK_API_KEY` credential during reviewed setup, matching BytePlus examples. OpenAI image generation can reuse an existing selected-profile OpenAI credential env var, including the primary model route's OpenAI key reference.

FAL model choices shown by setup are:

- `fal-ai/flux-2/klein/9b` (`flux-2`)
- `fal-ai/flux-2-pro` (`flux-2-pro`)
- `fal-ai/z-image/turbo` (`z-image`)
- `fal-ai/nano-banana-pro` (`nano-banana-pro`)
- `fal-ai/gpt-image-1.5` (`gpt-image-1.5`)
- `fal-ai/gpt-image-2` (`gpt-image-2`)
- `fal-ai/ideogram/v3` (`ideogram-v3`)
- `fal-ai/recraft/v4/pro/text-to-image` (`recraft-v4-pro`)
- `fal-ai/qwen-image` (`qwen-image`)
- `fal-ai/krea/v2/medium/text-to-image` (`krea-2-medium`)
- `fal-ai/krea/v2/large/text-to-image` (`krea-2-large`)

BytePlus model choices shown by setup are:

- `seedream-5-0-260128` (`seedream-5`)
- `seedream-5-0-lite-260128` (`seedream-5-lite`)
- `seedream-4-5-251128` (`seedream-4.5`)
- `seedream-4-0-250828` (`seedream-4`)

OpenAI model choices shown by setup are virtual GPT Image 2 quality tiers:

- `gpt-image-2-low`
- `gpt-image-2-medium` (`gpt-image-2`)
- `gpt-image-2-high`

## Setup

Configure the provider in the selected profile:

```bash
estacoda image setup --provider fal --model fal-ai/flux-2/klein/9b --api-key-env FAL_KEY
estacoda image setup --provider byteplus --model-version seedream-5 --api-key-env BYTEPLUS_ARK_API_KEY
estacoda image setup --provider openai --model-version gpt-image-2-medium --api-key-env OPENAI_API_KEY
estacoda image setup --provider byteplus --api-key <key>
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
estacoda image models --provider openai
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

- `provider`: `fal`, `byteplus`, or `openai`.
- `model`: exact provider model id or an alias resolved during setup and runtime tool calls.
- `useGateway`: legacy config field. Image generation currently uses direct provider calls.
- Provider blocks (`fal`, `byteplus`, `openai`) can override `model`, `apiKeyEnv`, and `baseUrl`.

## Tool behavior

The agent invokes `image.generate` automatically when you ask for an image. You can also reason about it in tool-use contexts.

Parameters:

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `prompt` | `string` | yes | The text prompt. |
| `aspectRatio` | `string` | no | `square`, `landscape`, or `portrait`. Defaults to square. |
| `model` | `string` | no | Overrides the configured model for this request. |
| `seed` | `number` | no | Optional seed for FAL requests. BytePlus and OpenAI requests omit this field. |

Aspect ratio mapping:

| Aspect | FAL | BytePlus | OpenAI |
|--------|-----|----------|--------|
| `square` | `square_hd` | `1920x1920` | `1024x1024` |
| `landscape` | `landscape_16_9` | `2560x1440` | `1536x1024` |
| `portrait` | `portrait_16_9` | `1440x2560` | `1024x1536` |

FAL requests use the cataloged payload shape for the selected model. Some FAL models use `image_size`, some use `aspect_ratio`, and GPT Image 1.5 uses literal dimensions. EstaCoda filters outgoing FAL payload fields against the catalog so models do not receive unsupported keys.

BytePlus requests use ModelArk's OpenAI-compatible endpoint with `response_format: "url"`, `output_format: "png"`, and `watermark: false`. EstaCoda can also consume BytePlus `b64_json` responses if a provider or future configuration returns them.

OpenAI requests use `/v1/images/generations` with the actual API model `gpt-image-2`. The selected EstaCoda model controls the OpenAI `quality` value: `low`, `medium`, or `high`.

### Image editing

`image.edit` uses the same provider configuration, API key, model, and endpoint family as `image.generate`; there is no separate editing setup step.

For BytePlus, the tool sends the documented `image` request field with one source image or an array of source images (safe HTTPS URLs or runtime-created base64 data URIs for verified retained images), and sets `sequential_image_generation: "disabled"` for a single edited result.

For FAL, the tool is enabled only when the selected catalog entry has an `editEndpoint`. It calls that endpoint with the documented `image_urls` field and any cataloged defaults supported by that edit endpoint.

For OpenAI, the tool calls `/v1/images/edits` with multipart `image[]` file parts. Safe HTTPS source images are downloaded by EstaCoda and uploaded to OpenAI. Local image artifacts are accepted from the selected profile image cache or from verified retained images owned by the current session and profile.

Parameters:

| Parameter | Type | Required | Notes |
|-----------|------|----------|-------|
| `prompt` | `string` | yes | The edit instruction. |
| `sourceImages` | `string[]` | yes, unless `sourceImage` is set | HTTPS image URLs, `artifact://` references, or artifact ids. All three providers accept verified retained images from the current session and profile. OpenAI also accepts selected-profile image-cache artifacts. Maximum 16 sources. |
| `sourceImage` | `string` | yes, unless `sourceImages` is set | Convenience single-image input. |
| `aspectRatio` | `string` | no | `square`, `landscape`, or `portrait`. Defaults to square. |
| `model` | `string` | no | Overrides the configured provider model for this request. |

Arbitrary local image paths and user-supplied data URIs are not uploaded by this tool. Use a safe HTTPS image URL or an artifact reference. Retained session images are reverified for ownership, content, and digest before upload, with an 8 MiB limit per retained image. FAL and BytePlus receive these verified bytes as data URIs; OpenAI receives multipart file parts. The source reference, rather than the encoded image, is recorded in result metadata. Legacy FAL and BytePlus artifacts still require safe provider `sourceUrl` metadata; legacy OpenAI artifacts must belong to the selected profile image cache.

Result:

- The image is written to `~/.estacoda/profiles/<id>/image-cache/`.
- An artifact is recorded with metadata: provider, model, aspect ratio, seed, source URL.
- The tool returns the artifact path, provider, model, and artifact ID.
- Telegram delivery sends the image as a photo when the gateway and channel are ready.

## Failure modes

| Symptom | Likely cause | Recovery |
|---------|--------------|----------|
| Missing provider key | The env var referenced by `apiKeyEnv` is absent. | Add the key to the selected profile `.env` and retry. |
| Unsupported provider | The configured provider is not implemented for image generation. | Select `fal`, `byteplus`, or `openai`. |
| Remote provider error | HTTP 4xx/5xx, auth failure, or model not activated. | Check provider status, credentials, and model activation. |
| Generated URL download failed | Provider returned a URL that could not be fetched. | Retry the request; transient network issues are possible. |
| Local source image rejected by `image.edit` | Editing accepts safe HTTPS sources or verified retained images from the current session and profile. OpenAI also accepts selected-profile image-cache artifacts. | Use an HTTPS image URL or a compatible prior generated artifact. |
| FAL model does not support `image.edit` | The selected cataloged FAL model has no edit endpoint. | Choose an edit-capable FAL model with `estacoda image models --provider fal`. |
| OpenAI source image too large or unsupported | OpenAI edit sources must be PNG, JPEG, or WebP images of 50 MB or less. | Use a supported source image format and size. |
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
