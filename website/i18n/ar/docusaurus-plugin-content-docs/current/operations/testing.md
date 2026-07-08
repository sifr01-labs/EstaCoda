---
title: الاختبار
description: أوامر التحقق، وتغطية smoke، وفحوصات الإصدار، وأدلة المشغّل.
sidebar_position: 1
---

# الاختبار

تعتمد EstaCoda على طبقات تحقق متعددة. اختبارات الوحدة هي بوابة الكود الأساسية، وتغطي اختبارات smoke السلوك العابر للأنظمة الفرعية، وتكشف eval fixtures الانحدارات الحتمية في سلوك الوكيل، بينما تتحقق أدوات التثبيت والحزم من الملفات التي سيشغلها المستخدم فعليًا.

الأوامر في هذه الصفحة مبنية على ما هو موجود فعليًا في `package.json` و`vitest.node.config.ts` و`src/smoke.ts` و`src/smoke/cases/` و`scripts/run-eval-fixtures.ts` وسكربتات التحقق تحت `scripts/`.

## مسار التحقق الأساسي

شغّل هذا المسار قبل اعتبار أي تغيير عادي جاهزًا:

```bash
pnpm run typecheck
pnpm run test
pnpm run smoke
pnpm run build
pnpm run audit:runtime-imports
pnpm run audit:esm
pnpm run smoke:dist
```

ماذا يثبت كل أمر:

| الأمر | المصدر | ما يتحقق منه |
|---|---|---|
| `pnpm run typecheck` | `tsc --noEmit` | تجميع TypeScript دون إخراج ملفات. |
| `pnpm run test` | `vitest run --config vitest.node.config.ts` | اختبارات Node/Vitest تحت `src/**/*.test.ts`. |
| `pnpm run smoke` | `node --import tsx src/smoke.ts` | smoke في وضع المصدر مع مزوّدين ومحولات محاكاة. |
| `pnpm run build` | `tsc -p tsconfig.build.json` بعد `clean:dist` | بناء مخرجات الإنتاج في `dist/`. |
| `pnpm run audit:runtime-imports` | `scripts/audit-runtime-imports.mjs` | سلامة رسم الاستيراد في وقت التشغيل قبل الشحن. |
| `pnpm run audit:esm` | `scripts/audit-esm.mjs dist` | صحة حزمة ESM في المخرجات المبنية. |
| `pnpm run smoke:dist` | `node dist/smoke.js` | smoke على المخرجات المبنية. هذا هو فحص سلامة الأثر النهائي. |

لا تتجاوز `typecheck`. قد تمر أخطاء النوع في الاختبارات لكنها تكسر البناء.

## التحقق حسب نوع التغيير

استخدم المسارات المستهدفة لتسريع التغذية الراجعة، ثم شغّل مسار التحقق الأساسي قبل الدمج أو الإصدار.

| نوع التغيير | ما يجب تشغيله |
|---|---|
| أغلب تغييرات TypeScript أو runtime | `pnpm run typecheck`، `pnpm run test` |
| سلوك عابر للأنظمة الفرعية | `pnpm run smoke`، ثم `pnpm run smoke:dist` بعد البناء |
| منطق الوكيل أو eval | `pnpm run eval:fixtures` |
| توجيه المزوّدين أو التفكير أو continuation أو message normalization | `pnpm run provider:hardening` مع اختبارات Vitest المستهدفة للملفات التي تغيّرت |
| تغييرات benchmark harness أو adapter | `pnpm run benchmark:smoke`، `pnpm run benchmark:terminal-bench:adapter-test`، والاختبارات المستهدفة تحت `src/benchmark` و`src/cli/bench-command.test.ts` |
| سلوك التثبيت أو التحديث | `pnpm run validate:install`، `pnpm run validate:source-install` |
| سلوك إزالة التثبيت | `pnpm run validate:uninstall` |
| جاهزية npm أو الحزمة | `pnpm run verify:local-bin`، `pnpm run pack:dry-run`، `pnpm run verify:package-bin` |
| تسليم Docker | `pnpm run validate:docker` |
| تسليم Homebrew | `pnpm run validate:homebrew` |
| تغييرات skills catalog | `pnpm run skills:catalog`، ثم افحص مخرجات website API المولدة |
| تغييرات docs فقط | `git diff --check`؛ ابنِ موقع Docusaurus عند تغيير sidebars أو الروابط أو frontmatter أو ملفات i18n |

## اختبارات smoke

اختبارات smoke هي شبكة أمان التكامل. تشغّل مسارات المنتج باستخدام مزوّدين ومحولات محاكاة، لذلك تبقى سريعة وحتمية. لكنها لا تثبت سلوك APIs الحية.

**نقطة الدخول:** `src/smoke.ts`

**المشغّل:** `src/smoke/smoke-runner.ts`

**الحالات:** `src/smoke/cases/*.ts`

تشمل حالات smoke الحالية:

- bare launch
- init lifecycle
- update dry run
- pack lifecycle
- bundled skill sync
- corrupt skill usage recovery
- evolution lifecycle وevolution safety
- delegation MVP
- gateway stop behavior
- WhatsApp support

أوامر smoke المفيدة:

```bash
# All cases
pnpm run smoke

# List cases
pnpm run smoke --list

# By tag
pnpm run smoke --tag skills
pnpm run smoke --tag memory

# By case ID
pnpm run smoke --id corrupt-skill-usage

# Fail fast + JSON
pnpm run smoke --fail-fast --json
```

### ما لا تثبته smoke

تستخدم اختبارات smoke المحاكاة لعدة أسطح خارجية. اعتبر هذه حدود اختبار، لا حدودًا للمنتج:

- استدعاءات مزوّدين حقيقية
- جلسات Telegram أو WhatsApp gateway حقيقية
- أتمتة متصفح حقيقية عبر خدمة متصفح حية
- تنفيذ خادم MCP حقيقي
- مخرجات صوت أو صور حقيقية من المزوّدين
- التقاط ميكروفون حقيقي، جلسات Discord voice حية، وتنزيلات faster-whisper عند التشغيل الأول

السلوك الحي يحتاج تحقق مشغّل عندما يمس التغيير مزوّدًا حيًا، قناة، backend للمتصفح، مسار صوت، مثبّتًا، مسار تحديث، أو أثر حزمة.

## فحوصات Benchmark

فحوصات benchmark هي مسارات تحقق للمشغّل، وليست UX عاديًا للمستخدم. المسارات الآمنة لـ CI هي:

```bash
pnpm run benchmark:smoke
pnpm run benchmark:terminal-bench:adapter-test
```

استخدم Harbor يدويًا لتشغيل Terminal-Bench smoke وbaseline الكامل. لا تشغّل Terminal-Bench الكامل في CI العادي.

راجع [Benchmarking](./benchmarking.md) للحصول على runbook قابل للإعادة، وعقد artifacts، وقاعدة no-tuning، وإرشادات الإبلاغ العام.

## Eval fixtures

شغّل مجموعة eval الافتراضية عبر:

```bash
pnpm run eval:fixtures
```

شغّل fixture واحدًا بالمعرّف:

```bash
pnpm run eval:fixtures -- <fixture-id>
```

تُعرّف المجموعة الافتراضية في `src/eval/fixtures/index.ts` وتغطي حاليًا:

- سلوك runtime الأساسي
- أمان الأدوات وتصنيف فشل الأداة المفقودة
- تنظيم الذاكرة، ترقيتها، إلغاء تنشيطها، عرضها الانتقائي، وحماية ملفات الأمان
- بحث رسم تبعية الكود وإبطال cache
- Agent Evolution manifests، المقترحات، تسجيل تصحيح المستخدم، routing metadata، routing baseline، بوابات جاهزية semantic routing، وشكل التصدير
- حالة workflow run، القفل، الهجرة، ذرية التخزين، دورة حياة المحرك، التعافي بعد إعادة التشغيل، تحكم الأوامر، ملخصات الأحداث، والتكامل

فضّل وصف الفئات في الوثائق بدل تثبيت أعداد fixtures. معرّفات fixtures تتغير مع توسع مجموعة eval.

## فحوصات المزوّدين والتفكير

ابدأ فحوصات provider hardening بهذا الأمر:

```bash
pnpm run provider:hardening
```

عند تغيير provider streaming أو tool-call planning أو reasoning extraction أو continuation أو prompt compression أو مستهلكي transcript، شغّل أيضًا الاختبارات المركزة التي تطابق النظام الفرعي الذي تغيّر. أمثلة شائعة:

```bash
pnpm exec vitest run src/providers/provider-executor-fallback.test.ts
pnpm exec vitest run src/providers/provider-executor-route.test.ts
pnpm exec vitest run src/providers/openai-compatible-provider.test.ts
pnpm exec vitest run src/providers/openai-responses-provider.test.ts
pnpm exec vitest run src/providers/provider-reasoning.test.ts
pnpm exec vitest run src/providers/provider-message-normalizer.test.ts
pnpm exec vitest run src/runtime/provider-turn-loop.test.ts
pnpm exec vitest run src/runtime/agent-loop.test.ts
pnpm exec vitest run src/prompt/semantic-compressor.test.ts
```

افحص أوضاع الفشل هذه قبل قبول تغييرات provider runtime:

- يبقى `incomplete-stream` فشلًا أو يستخدم fallback؛ يجب ألا يتحول إلى جواب نهائي للمساعد.
- استدعاءات الأدوات المقطوعة بسبب الطول تعاد مرة واحدة أو تُرفض بأمان؛ يجب ألا تصل المحاولة الأولى المقطوعة إلى التخطيط أو التنفيذ.
- JSON النهائي المشوه للأدوات يبقى خطأ في تخطيط الأدوات.
- الاستجابات التي تحتوي على تفكير فقط تستخدم مسار إعادة محاولة الجواب المرئي دون كشف التفكير الخام.
- continuation للنص المرئي المقطوع يحفظ رسالة مساعد نهائية واحدة دون رسائل continuation اصطناعية.
- الملخصات، الذاكرة، المهارات، وآثار التصدير تزيل التفكير الخام وتحافظ على النص المرئي العادي.

## أدوات CLI التشخيصية

هذه الأوامر تفحص أدلة runtime. ليست بديلًا للاختبارات.

```bash
# Inspect execution history
estacoda trace list [--session <id>] [--limit <n>]
estacoda trace dump <trajectory-id> [--raw]
estacoda trace timeline <trajectory-id> [--raw]
estacoda trace failures <trajectory-id>

# Run eval fixtures from the CLI
estacoda eval [fixture-id]
```

للفحص اليدوي بعد تشغيل محلي:

```bash
pnpm run dev
estacoda trace list --limit 5
estacoda trace dump <trajectory-id> --raw
```

يجب ألا تظهر بيانات التفكير الخام، أو `reasoning_content`، أو `reasoning_details`، أو وسائط الأدوات المقطوعة والمستبعدة، أو رسائل continuation/prefill الاصطناعية في رسائل الجلسة المرئية المحفوظة، أو أحداث runtime/session، أو الملخصات، أو ملفات الذاكرة، أو سجلات المهارات، أو آثار التصدير. قد تظهر بيانات آمنة مثل سبب الإنهاء، والاستخدام، و`reasoningMetadata`، وحالة القطع، وحالة continuation.

## التحقق من التثبيت والتحديث والحزم وإزالة التثبيت

سطح الإصدار ليس TypeScript فقط. للمثبّت، والمحدّث، والحزمة، وسكربتات التسليم بوابات تحقق خاصة:

```bash
pnpm run verify:local-bin
pnpm run pack:dry-run
pnpm run verify:package-bin
pnpm run validate:install
pnpm run validate:source-install
pnpm run validate:uninstall
pnpm run validate:docker
pnpm run validate:homebrew
```

استخدم هذه الأوامر عند تغيير:

- `package.json` أو بيانات الحزمة أو `bin` أو `files`
- `scripts/install.sh` أو `scripts/setup-estacoda.sh` أو `scripts/uninstall.sh` أو `scripts/estacoda-wrapper.sh`
- توجيه التحديث أو سلوك managed-source
- توثيق Docker أو Homebrew أو npm أو source-install
- حدود حزم WhatsApp bridge

يفحص `verify-package-bin.sh` أيضًا أن npm tarball يحتوي الملفات التشغيلية المطلوبة ويستبعد source وwebsite وtest وnode_modules ومسارات الأسرار والحالة.

## تحقق المشغّل اليدوي

تحافظ المحاكاة على حتمية CI، لكن بعض السلوك يجب اختباره حيًا قبل وصفه بأنه live-proven:

- استدعاءات المزوّدين مع النموذج/المزوّد المستهدف
- جلسات Telegram وWhatsApp gateway
- Browserbase أو جلسات متصفح حية
- hosted TTS/STT وتنزيل Local STT عند التشغيل الأول
- التقاط الميكروفون ومسارات Discord voice
- مسارات تثبيت Docker/Homebrew/npm في بيئات نظيفة
- عرض العربية في الطرفية داخل سير عمل حقيقي

اجمع الأدلة عبر:

- مخرجات الأوامر
- السجلات وtrace IDs
- لقطات شاشة لمشاكل UI أو عرض الطرفية
- المزوّد/القناة/الإعدادات المستخدمة بدقة
- خطوات إعادة إنتاج الأعطال

## الممارسة الموصى بها

1. شغّل `pnpm run typecheck` أولًا.
2. شغّل الاختبارات المستهدفة للنظام الفرعي الذي غيّرته.
3. شغّل مسار التحقق الأساسي قبل إعلان النجاح.
4. شغّل أدوات التثبيت والحزم عند تغيير أسطح الإصدار.
5. شغّل تحققًا حيًا عند تغيير المزوّدين، القنوات، المتصفح، الصوت، المثبّت، أو سلوك العربية في الطرفية.
6. وثّق الأعطال بالسجلات، الآثار، لقطات الشاشة، وخطوات إعادة الإنتاج.

## صفحات ذات صلة

- [المشكلات المعروفة](./known-issues.md) — القيود التي تؤثر على نطاق الاختبار
- [تشغيل البوابة](./gateway-operations.md) — أوامر المشغّل للتشخيص
- [تشغيل التحديث](./update-operations.md) — سلوك التحديث والتعافي
- [النسخ الاحتياطي والحالة](./backups-and-state.md) — الحالة التي يجب حمايتها قبل الاختبارات المدمّرة
