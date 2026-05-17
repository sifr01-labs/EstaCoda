# Onboarding Copy Register

Status: PR12 audit/register only. Do not treat proposed copy as implemented until a later copy PR wires it into `setup-copy.ts`, view models, or renderers.

Baseline: `integration/v0.1.0` after PR14 OAuth token-store foundations.

## Summary

This register covers guided setup/editor copy after Onboarding PR1-PR11. The implementation already has a central setup copy inventory in `src/onboarding/setup-copy.ts`, but several user-facing setup strings still live directly in router, renderer, prompt, and runner code. Those strings should move to setup-owned copy keys in a later implementation PR so English and Arabic behavior stay consistent and technical tokens receive the same LTR isolation guarantees.

Counts in this register:

- Total copy items logged: 30
- Required: 24
- Polish: 4
- Future/deferred: 2

Required implementation copy changes:

- Move guided editor shell, route summaries, post-apply next-action, optional capability prompt, and diagnostic guidance copy into setup copy keys.
- Add Arabic copy for all guided editor and post-apply surfaces.
- Ensure degraded/limited-mode copy includes concrete verification warning lines before acceptance.
- Add copy keys for credential-only active-route diagnostics and shared-flow provider/model diagnostics.

Polish-only copy changes:

- Tighten direct setup examples, action descriptions, section status labels, and review/end-state tone.
- Make first-run/local-provider copy less informal.
- Normalize optional media capability wording so voice, vision, image generation, and browser remain separate from primary LLM routing.

Future/deferred copy:

- OAuth/Codex setup copy must remain deferred until an onboarding PR explicitly implements those setup flows.
- `/model` switching copy must remain outside onboarding copy until the model switcher surface is implemented.
- Gateway model cards are not part of guided setup and should not be introduced here.
- Runtime setup mutation tools are not exposed; copy must not imply that they exist.

Unsupported feature claims found:

- No onboarding source currently claims OAuth/Codex setup is implemented. PR14 added provider-owned OAuth storage foundations only.
- Docs mention `/model` in non-onboarding architecture/manual QA contexts; this PR should not copy that into guided setup.
- `config-editor/prompts.ts` includes "Use image gateway if configured?" for the vision/image-generation capability. That is an existing optional capability setting, not a gateway card. Keep wording narrow so it does not imply new gateway setup cards.

Arabic/LTR-isolation risks:

- Hardcoded strings in `config-editor/render.ts`, `config-editor/prompts.ts`, `setup-router.ts`, `setup-state-renderer.ts`, and `config-editor/runner.ts` bypass `setup-copy.ts` Arabic token isolation.
- Tokens requiring isolation include env vars, commands, paths, provider IDs, model IDs, route/auth IDs, capability IDs, config keys, URLs, and browser commands.
- Proposed Arabic copy below preserves technical tokens as literals and marks them in the token column.

Recommended implementation order for a later copy PR:

1. Add setup copy keys for required items in router, state summary, editor render, prompt, and post-apply handoff surfaces.
2. Replace hardcoded English in `config-editor/render.ts` and `config-editor/prompts.ts` with setup copy lookups.
3. Add tests that Arabic copy isolates env vars, commands, paths, provider/model IDs, route/auth IDs, and optional capability IDs.
4. Update snapshot/behavior tests only after copy keys are wired and reviewed.
5. Leave future OAuth/Codex, `/model`, gateway cards, and runtime mutation-tool copy out of this implementation pass.

## Audit Searches Run

- `rg "setupEditor|setup-copy|copy|diagnostic|verification|launch|limited|credential|provider|workflow|security|Telegram|browser|voice|vision|image" src/onboarding src/cli docs README.md`
- `rg "OPENAI_API_KEY|KIMI_API_KEY|authMethod|apiKeyEnv|baseUrl|model|provider" src/onboarding`
- `rg "Codex|OAuth|openai_responses|gateway|/model" src/onboarding docs README.md`
- Additional hardcoded-string sweep: `rg '"[^"]*(setup|Setup|Choose|Review|Launch|Verify|Warning|Credential|Provider|Telegram|Browser|Voice|Image|Exit|Repair|Trust|Security|Workflow|Optional|config|provider|credential|launch|verify|browser|voice|vision|image)[^"]*"' src/onboarding -n`

## Register

| # | Copy key / proposed key | Current location/file | Current copy | Problem/gap | Proposed English copy | Proposed Arabic copy | Technical tokens requiring isolation | State/surface | Priority | Notes/dependencies |
|---:|---|---|---|---|---|---|---|---|---|---|
| 1 | `setupRouter.firstRun.title` | `src/onboarding/setup-router.ts` | `First-run setup` | Hardcoded router copy; no Arabic key. | First-run setup | إعداد أول تشغيل | none | first-run route title | required | Move router title into setup copy. |
| 2 | `setupRouter.firstRun.summary` | `src/onboarding/setup-router.ts` | `No usable setup config was found. Start first-run onboarding.` | Hardcoded; should clarify review-before-apply. | No usable setup config was found. Start reviewed first-run setup. | لم يتم العثور على إعداد صالح. ابدأ إعداد أول تشغيل مع المراجعة قبل التطبيق. | none | first-run route summary | required | Reflects implemented reviewed first-run flow only. |
| 3 | `setupRouter.configured.title` | `src/onboarding/setup-router.ts` | `EstaCoda is already configured` | Hardcoded; no Arabic key. | EstaCoda is already configured | EstaCoda مهيأة بالفعل | `EstaCoda` | configured-ready route title | required | Isolate `EstaCoda` in Arabic. |
| 4 | `setupRouter.configured.summary` | `src/onboarding/setup-router.ts` | `Setup looks ready. Choose whether to launch, review config, verify, or exit.` | Hardcoded; should align with PR11 explicit launch handoff. | Setup looks ready. Choose launch, guided review, read-only verification, or exit. | يبدو الإعداد جاهزًا. اختر التشغيل أو المراجعة الموجّهة أو التحقق للقراءة فقط أو الخروج. | none | configured-ready route summary | required | Keep launch explicit. |
| 5 | `setupRouter.degraded.title` | `src/onboarding/setup-router.ts` | `EstaCoda is configured with warnings` | Hardcoded; no Arabic key. | EstaCoda is configured with warnings | EstaCoda مهيأة مع تحذيرات | `EstaCoda` | configured-degraded route title | required | Isolate `EstaCoda`. |
| 6 | `setupRouter.degraded.summary` | `src/onboarding/setup-router.ts` | `Setup is usable, but verification found warnings. Review or repair before launch if needed.` | Does not mention explicit limited-mode acceptance. | Setup is usable with warnings. Review, repair, or explicitly accept limited mode before launch. | الإعداد قابل للاستخدام مع تحذيرات. راجع أو أصلح أو اقبل الوضع المحدود صراحة قبل التشغيل. | none | configured-degraded route summary | required | Must match PR11 behavior. |
| 7 | `setupRouter.repair.title` | `src/onboarding/setup-router.ts` | `Setup needs repair` | Hardcoded; no Arabic key. | Setup needs repair | الإعداد يحتاج إلى إصلاح | none | repair-first route title | required | Used across partial-provider, missing-secret, broken config, state-not-writable. |
| 8 | `setupRoute.action.launchAgent` | `src/onboarding/setup-router.ts` | `Launch agent`, `Continue in limited mode` | Duplicated action intent; limited launch needs warning context. | Launch after verification | شغّل بعد التحقق | none | route action | required | Degraded variant should be `Accept limited mode after reviewing warnings`. |
| 9 | `setupRoute.action.verifySetup` | `src/onboarding/setup-router.ts`, `config-editor/render.ts` | `Verify setup`, `Run read-only setup verification again.` | Repeated hardcoded labels/descriptions. | Run read-only verification | شغّل تحققًا للقراءة فقط | none | route action, synthetic editor action | required | Avoid implying mutation. |
| 10 | `setupRoute.action.exit` | `src/onboarding/setup-router.ts`, `config-editor/render.ts` | `Exit`, `Leave setup without changing config.` | Repeated hardcoded label/description. | Exit without changes | اخرج دون تغييرات | none | route action, synthetic editor action | polish | Can reuse `setupEditor.actions.cancelSetupEditor`. |
| 11 | `setupStateSummary.title` | `src/onboarding/setup-state-renderer.ts` | `EstaCoda setup`, `EstaCoda advanced setup` | Hardcoded noninteractive summary; no Arabic key. | EstaCoda setup | إعداد EstaCoda | `EstaCoda` | noninteractive setup summary | required | Also add advanced variant. |
| 12 | `setupStateSummary.directProviderExample` | `src/onboarding/setup-state-renderer.ts` | `estacoda setup --provider deepseek --model deepseek-chat --api-key-env DEEPSEEK_API_KEY` | Hardcoded command; no token isolation metadata. | Direct provider example: `estacoda setup --provider deepseek --model deepseek-chat --api-key-env DEEPSEEK_API_KEY` | مثال إعداد مزوّد مباشر: `estacoda setup --provider deepseek --model deepseek-chat --api-key-env DEEPSEEK_API_KEY` | `estacoda setup --provider deepseek --model deepseek-chat --api-key-env DEEPSEEK_API_KEY`, `deepseek`, `deepseek-chat`, `DEEPSEEK_API_KEY` | noninteractive setup summary | polish | Keep as advanced/direct compatibility, not guided repair copy. |
| 13 | `setupEditor.shell.title` | `src/onboarding/config-editor/render.ts` | `EstaCoda guided setup editor` | Hardcoded shell title. | EstaCoda guided setup editor | محرر إعداد EstaCoda الموجّه | `EstaCoda` | guided editor shell | required | First obvious hardcoded editor string. |
| 14 | `setupEditor.shell.stateLabels` | `src/onboarding/config-editor/render.ts` | `State:`, `kind`, `route`, `editor mode`, `recommended`, `model`, `configuration` | Hardcoded labels include paths and IDs without Arabic isolation path. | State, route, editor mode, recommended action, model, configuration | الحالة، المسار، وضع المحرر، الإجراء المقترح، النموذج، الإعداد | state kind, route kind, provider/model ID, config paths | guided editor shell | required | Register labels as a group; values must remain isolated. |
| 15 | `setupEditor.sections.heading` | `src/onboarding/config-editor/render.ts` | `Sections:` | Hardcoded structural label. | Sections | الأقسام | section IDs | guided editor shell | polish | Section IDs remain technical. |
| 16 | `setupEditor.actions.heading` | `src/onboarding/config-editor/render.ts` | `Available setup actions:` | Hardcoded structural label. | Available setup actions | إجراءات الإعداد المتاحة | action IDs | guided editor shell | polish | Action IDs should be isolated. |
| 17 | `setupEditor.actions.descriptions.*` | `src/onboarding/config-editor/render.ts` | Descriptions returned by `editorActionDescription()` | Hardcoded English-only descriptions for PR6/PR8/PR9 actions. | Use action-specific descriptions from setup copy. Example: `Repair the primary provider/model route through the shared setup flow.` | استخدم وصفًا خاصًا بكل إجراء من نسخة الإعداد. مثال: `Repair the primary provider/model route` عبر مسار الإعداد المشترك. | action IDs, `provider.route`, `provider.credentialReference` | guided editor action descriptions | required | Add one key per action in implementation PR. |
| 18 | `setupEditor.diagnostics.title` | `src/onboarding/config-editor/render.ts` | `Setup diagnostics` | Hardcoded diagnostics heading. | Setup diagnostics | تشخيص الإعداد | none | diagnostics view | required | Needed for broken config/state-not-writable Arabic. |
| 19 | `setupEditor.diagnostics.manualRepair.brokenConfig` | `src/onboarding/config-editor/render.ts` | `Normal config edits are blocked until the config file can be parsed.` etc. | Hardcoded multi-line guidance; no Arabic. | Normal config edits are blocked until the config file can be parsed. Fix the listed parse/load error, then run read-only verification again. | تعديلات الإعداد العادية محظورة حتى يمكن قراءة ملف الإعداد. أصلح خطأ القراءة/التحميل المعروض، ثم شغّل التحقق للقراءة فقط مرة أخرى. | config paths, error text, `estacoda verify` if included | broken-config diagnostics | required | Must not imply automatic repair. |
| 20 | `setupEditor.diagnostics.manualRepair.stateNotWritable` | `src/onboarding/config-editor/render.ts` | `EstaCoda cannot safely apply setup changes while its state/config path is not writable.` etc. | Hardcoded multi-line guidance; no Arabic. | Normal writes are blocked until the state/config path is writable. Restore write permission, then run read-only verification again. | الكتابة العادية محظورة حتى يصبح مسار الحالة/الإعداد قابلًا للكتابة. أعد أذونات الكتابة، ثم شغّل التحقق للقراءة فقط مرة أخرى. | state path, config path, permissions | state-not-writable diagnostics | required | Must stay diagnostic-only. |
| 21 | `setupEditor.prompt.action.title` | `src/onboarding/config-editor/prompts.ts` | `Guided setup editor`, `Choose a setup action.` | Hardcoded prompt; no Arabic key. | Guided setup editor. Choose a setup action. | محرر الإعداد الموجّه. اختر إجراء إعداد. | action IDs | editor action prompt | required | Prompt body and title should be separate keys. |
| 22 | `setupEditor.prompt.postApply.*` | `src/onboarding/config-editor/prompts.ts`, `runner.ts` | `Setup next action`, `Launch`, `Accept limited mode`, `Repair again`, `Exit` | Hardcoded PR11 handoff prompt; limited mode must include concrete warning context. | Choose what to do after setup apply. Launch only after verified-ready; accept limited mode only after reviewing warnings. | اختر ما يحدث بعد تطبيق الإعداد. لا يتم التشغيل إلا بعد جاهزية مؤكدة؛ ولا يُقبل الوضع المحدود إلا بعد مراجعة التحذيرات. | warning text, action IDs | post-apply handoff | required | Keep warning block from PR11. |
| 23 | `setupEditor.postApply.warningList` | `src/onboarding/config-editor/runner.ts` | `Verification warnings:` | Hardcoded PR11 warning header. | Verification warnings | تحذيرات التحقق | warning text, provider/model IDs, env vars in warning text | degraded handoff | required | Warning values are dynamic and may contain technical tokens. |
| 24 | `setupEditor.prompt.optionalCapabilityAction.*` | `src/onboarding/config-editor/prompts.ts` | `Leave unchanged`, `Skip`, `Enable/configure`, descriptions | Hardcoded optional capability choices; no Arabic. | Leave unchanged; Skip; Enable/configure | اتركه كما هو؛ تخطَّ؛ فعّل/اضبط | capability IDs: `telegram`, `voice`, `vision`, `browser` | optional capability editor | required | Preserve PR9 semantics: skip hidden for configured capabilities. |
| 25 | `setupEditor.prompt.telegram.*` | `src/onboarding/config-editor/prompts.ts` | `Telegram bot token environment variable [ESTACODA_TELEGRAM_BOT_TOKEN]:`, allowed IDs prompts | Hardcoded; must emphasize env ref only and remote-control allowlist. | Telegram bot token environment variable name; Allowed Telegram user IDs; Allowed Telegram chat IDs | اسم متغير بيئة رمز Telegram؛ معرّفات مستخدمي Telegram المسموح بها؛ معرّفات محادثات Telegram المسموح بها | `Telegram`, `ESTACODA_TELEGRAM_BOT_TOKEN`, user/chat IDs | Telegram optional capability | required | Must not collect raw token in PR9 surface. |
| 26 | `setupEditor.prompt.voice.*` | `src/onboarding/config-editor/prompts.ts` | `Choose a TTS provider.`, `TTS model:`, `TTS API key environment variable:` etc. | Hardcoded; could blur voice provider with LLM provider route. | Choose voice providers and env-var references. Voice setup is optional and separate from the primary LLM route. | اختر مزوّدي الصوت ومراجع متغيرات البيئة. إعداد الصوت اختياري ومنفصل عن مسار LLM الأساسي. | `TTS`, `STT`, provider IDs, model IDs, env vars | voice optional capability | required | Explicitly separate from core provider route. |
| 27 | `setupEditor.prompt.vision.*` | `src/onboarding/config-editor/prompts.ts` | `Choose an image generation provider.`, `Use image gateway if configured?` | Hardcoded; "gateway" can sound like gateway cards. | Choose image-generation provider references. This does not change the primary LLM route. | اختر مراجع مزوّد توليد الصور. هذا لا يغيّر مسار LLM الأساسي. | image provider IDs, model IDs, `FAL_KEY`, `fal-ai/imagen4/preview` | vision/image optional capability | required | Keep gateway wording scoped to existing `useGateway` config. |
| 28 | `setupEditor.prompt.browser.*` | `src/onboarding/config-editor/prompts.ts` | `Choose a browser backend. Browser setup will not launch a browser during planning.`, CDP/command prompts | Hardcoded; no Arabic; contains URL/command tokens. | Choose a browser backend. Setup records references only and will not launch a browser during planning. | اختر واجهة متصفح. يسجّل الإعداد المراجع فقط ولن يشغّل متصفحًا أثناء التخطيط. | backend IDs, `http://127.0.0.1:9222`, launch command | browser optional capability | required | Preserve PR9 no-auto-launch guarantee. |
| 29 | `setupCopy.future.oauthCodex` | no onboarding implementation copy | none | Provider PR14 added OAuth storage foundations, but onboarding must not claim OAuth/Codex setup. | Future: OAuth/Codex setup copy is intentionally absent until onboarding implements that flow. | مستقبلي: نسخة إعداد OAuth/Codex غائبة عمدًا حتى يطبّق الإعداد هذا المسار. | `OAuth`, `Codex`, provider IDs | future provider setup | future | Register boundary; do not add UI copy yet. |
| 30 | `setupCopy.future.modelSwitcherGatewayCards` | non-onboarding docs mention `/model` and gateway | none in onboarding setup copy | Avoid importing future `/model` or gateway card claims into setup. | Future: `/model` and gateway card copy belongs to those surfaces, not guided setup. | مستقبلي: نسخة `/model` وبطاقات gateway تخص تلك الواجهات، لا الإعداد الموجّه. | `/model`, `gateway`, route IDs | future model/gateway surfaces | future | Keep PR12 out of model switcher/gateway card work. |

## Additional Observations

- `src/onboarding/setup-copy.ts` already contains many good Arabic entries with placeholder isolation metadata, but hardcoded strings outside this file bypass that model.
- `src/onboarding/setup-modules.ts` has blocker strings such as "Hosted providers require a credential environment-variable reference." These should either become setup copy keys or remain internal diagnostics that are rendered through a copy-aware layer.
- `src/onboarding/config-editor/runner.ts` contains diagnostic output strings for provider/model selection failures and active-route credential repair. These are behaviorally correct but should be registered as copy keys before Arabic guided repair is considered complete.
- `src/onboarding/setup-state-renderer.ts` is deterministic and useful for tests, but its direct provider examples and command strings need explicit token-isolation metadata if rendered in Arabic later.
- Existing `README.md` setup text reflects current implemented behavior after PR11. Do not add OAuth/Codex or `/model` claims to setup docs until those flows exist.
