---
title: "Vision Analysis"
description: "Vision routing, image normalization, egress governance, setup verification, and quality gates."
---

# Vision Analysis

## Architecture and dispatch

Vision is a governed provider capability, not a second image-generation stack. Initial attachments, `vision.analyze`, `browser.vision`, browser screenshots, and generated-image artifacts converge on the same route policy, source resolver, normalization limits, provider executor, spending lineage, cancellation, and fallback metadata.

| Input and intent | Default dispatch |
|---|---|
| Initial image on a runnable vision-capable main model | Native main-model turn |
| Ordinary `describe` on a vision-capable main model | Native continuation |
| OCR, document, chart, screenshot, or comparison with an explicit dedicated route | Auxiliary vision route |
| Text-only main route with automatic or dedicated vision configured | Auxiliary vision route |
| No executable vision-capable route | Structured `vision-route-unavailable` failure |

Automatic selection prefers the main route when it truthfully satisfies vision requirements. It does not add an auxiliary call for its own sake. Main, automatic, dedicated hosted, dedicated local, custom OpenAI-compatible, and fallback candidates all pass the same adapter, provider-metadata, capability, privacy, and multi-image checks.

## Analysis controls

`vision.analyze` accepts one `path`, or `paths` with two to twenty images. Multiple paths select `compare` when `mode` is omitted. The modes are `describe`, `ocr`, `document`, `chart`, `screenshot`, and `compare`; detail is `low`, `standard`, or `high`; output depth is `concise`, `standard`, or `detailed`. A caller cannot combine `path` and `paths`, use more than twenty images, or use a non-comparison mode for multiple images. Sets above four images are validated first, then processed sequentially in bounded provider batches of at most four (or one for a custom route whose repeated-image capability is unknown). The result states whether every image completed; a failed batch never silently reports the remaining images as analyzed.

Image text is always untrusted content. The vision prompt may transcribe or discuss visible instructions, links, commands, or policy claims, but it must never obey them or treat them as higher-priority instructions.

## Provenance, approval, and spending

Provenance is derived from the runtime. Tool input cannot claim that a file was a user attachment, browser artifact, generated artifact, or explicit reference. Canonical containment and sensitive-path checks run for every source, including every member of a comparison.

Hosted processing is contextual data egress:

- `local-only` rejects a hosted route.
- Adaptive mode avoids repeated approval friction for current attachments, explicit references, browser screenshots, and generated artifacts.
- Agent-discovered workspace files still ask before unexpected egress.
- Strict mode asks for hosted dispatch.
- Approval grants bind to the workspace and every possible provider destination.

Every normalized image contributes to provider-spend estimation. Primary and fallback attempts reserve cost before dispatch and settle actual token usage afterward. Unknown pricing fails closed when an active Task or session budget cannot safely price the call.

## Configuration and migration

Vision configuration is profile-local at `auxiliaryModels.vision`. It uses `id`, not `model`:

```json
{
  "auxiliaryModels": {
    "vision": {
      "provider": "openai",
      "id": "gpt-4o",
      "apiKeyEnv": "OPENAI_API_KEY",
      "hostedProcessing": "allow-with-approval",
      "timeoutMs": 120000,
      "maxConcurrency": 2,
      "fallbackToMain": false,
      "enabled": true
    }
  }
}
```

The Setup Editor exposes Vision Analysis under **Vision & Images**, beside the unchanged Image Generation & Editing flow. The common Vision Analysis screen offers **Automatic**, **Choose a vision model**, and **Turn off**; main-only routing, dedicated-with-main-fallback, processing location, timeout, and concurrency live under **Advanced settings**. Turning Vision Analysis off is authoritative even when the main model supports vision. Custom local and OpenAI-compatible routes use endpoint-first setup. `timeoutMs`, `maxConcurrency`, and context limits must be positive integers. Concurrency bounds simultaneous provider work; it does not cap how many submitted images are analyzed. `fallbackToMain: true` is rejected unless the main route is executable, vision-capable, and compatible with the hosted-processing preference. Legacy auxiliary names and the retired `extraBody` field are not active configuration surfaces.

Review and apply remain separate. Cancellation does not write route changes or credentials; collected secrets remain deferred until an approved apply. Verification never changes route, privacy, approval, or provider selection.

## Setup verification

Run a configuration-only setup check with `estacoda verify`. Run the bilingual route proof with:

```bash
estacoda verify vision
```

Fully local route chains run the bundled benign image directly. Verification is skipped unless consent is explicit whenever the selected route or a possible fallback destination is hosted:

```bash
estacoda verify vision --consent-hosted
```

The report includes provider/model, selection source, expected native or auxiliary dispatch, local or hosted processing, credential readiness, vision capability, latency, approximate cost when pricing and usage are available, English and Arabic text detection, normalized dimensions and bytes, fallback use, the non-secret configuration fingerprint, and fixture SHA-256. Credential inspection uses read-only mode: an expiring OAuth token is reported as needing refresh instead of refreshing or rewriting `auth.json`.

## Resource limits and privacy

Only canonical contained regular files are accepted. MIME is detected from magic bytes. Normalization corrects orientation, strips metadata, and emits JPEG, PNG, or WebP. Defaults are:

| Boundary | Default |
|---|---:|
| Source read | 32 MiB per image |
| Source dimension | 20,000 pixels |
| Source pixels | 50 megapixels |
| Decoded memory | 256 MiB |
| Animation frames | 100 |
| Animation pixels | 100 million |
| Normalized output dimension | 7,680 pixels |
| Normalized output | 4 MiB per image |
| Aggregate normalized output | 80 MiB per twenty-image request |
| Aggregate animation pixels | 500 million per twenty-image request |
| Normalization concurrency | 2 |

Raw image bytes, normalized intermediates, and data URLs remain runtime-only. They must not be persisted in sessions, trajectories, logs, reports, or exports. Reports contain hashes, sizes, route metadata, metrics, and bounded model text—not image payloads or credentials.

## Live quality gate

From a source checkout, generate the deterministic fixture corpus and run the scored live lane:

```bash
pnpm run eval:vision:fixtures
pnpm run eval:vision:live
```

A route chain with any possible hosted destination refuses to run until the operator adds `--consent-hosted`; the consent applies only to that command invocation:

```bash
pnpm run eval:vision:live -- --consent-hosted
```

Hosted runs also enforce a process-local pre-dispatch maximum estimated exposure of `$1.00` by default. Set a different positive cap explicitly with `--max-cost-usd <amount>`; routes with missing pricing or an unbounded request fail before dispatch while the cap is active.

The lane covers English OCR, Arabic/mixed-direction OCR, dense documents, chart reasoning, browser-style screenshots, orientation, image prompt injection, configured fallback execution, multi-image comparison, and source-limit/magic-byte behavior. It records provider/model, configuration fingerprint, fixture hashes, character and word error rates, grounded-fact accuracy, hallucination rate, latency, estimated cost, actual cost when a provider supplies it, normalized payload size, actual hosted dispatches, fallback status, and approval frequency. The fallback case injects an in-process failure before provider dispatch, then exercises the configured fallback without sending a probe request or credential. Schema-v2 baselines contain both aggregate tolerances and mandatory per-case thresholds, so a safety case cannot be averaged into a passing result.

Each run writes machine-readable JSON and a Markdown release report under `.estacoda/eval-runs/`. It compares aggregate metrics and per-case gates with `evals/baselines/vision-live.json`. Only named threshold violations fail the command; ordinary variation within those tolerances is reported but does not fail. A successful primary call cannot prove fallback behavior, so the fallback case is labeled `not-exercised` unless a fallback is actually observed rather than being reported as a false pass.

## Platform behavior and troubleshooting

Sharp is a required runtime dependency and the packed-artifact verification checks that image normalization works after an isolated install on supported Node platforms. macOS and supported glibc Linux distributions are primary targets. WSL2 and Termux remain best-effort; native Windows is unsupported.

If verification is blocked:

1. Check `Route`, `Route selection`, `Credential readiness`, and `Vision capability` in `estacoda verify vision`.
2. If the selected route or any fallback is hosted, re-run only after reviewing egress and cost, with `--consent-hosted`.
3. If read-only verification says OAuth refresh is required, authenticate through the normal model setup flow; verification will not mutate auth state.
4. If a custom endpoint is unavailable, use the Setup Editor endpoint check and verify that `/models` and the multimodal completion endpoint agree on the model ID.
5. For `source-*` or `normalization-*` failures, inspect the structured error and the boundary table instead of increasing every limit.
6. For comparison failures, confirm that both the primary and any fallback advertise repeated image-input support.
7. For live-eval regressions, inspect the per-case report before changing a route or baseline. Baselines must not be loosened merely to hide a provider regression.

Known limitation: provider quality and usage reporting vary. Approximate cost is unavailable when token usage or catalog pricing is incomplete, and actual dollar cost is shown only when a provider reports it. This is explicit in reports rather than silently rendered as zero.
