---
title: الاختبار
description: طبقات التحقق، واختبارات smoke، واختبارات eval، وفحوصات المشغل.
sidebar_position: 1
---

# الاختبار

يأتي EstaCoda مع مكدس تحقق متعدد الطبقات. البوابة الموثوقة هي مجموعة اختبارات الوحدة Vitest. تخدم اختبارات smoke كشبكة أمان للتكامل. تكشف اختبارات eval عن الانحدارات الحتمية. تلتقط عمليات تدقيق الاستيراد في وقت التشغيل وESM أخطاء التعبئة قبل أن تصل إلى المستخدمين.

شغل التحقق بالترتيب التالي:

```bash
pnpm run typecheck
pnpm run test
pnpm run smoke
pnpm run build
pnpm run audit:runtime-imports
pnpm run audit:esm
pnpm run smoke:dist
```

لا تتجاوز `typecheck`. يمكن لأخطاء النوع أن تمر في الاختبارات مع كسر البناء.

## طبقات التحقق

| الأمر | ما يتحقق منه | متى يُشغل |
|-------|-------------|----------|
| `pnpm run typecheck` | تجميع TypeScript بدون أخطاء | قبل كل التزام |
| `pnpm run test` | مجموعة اختبارات Vitest | قبل كل PR |
| `pnpm run smoke` | اختبار تكامل smoke في وضع المصدر | قبل كل PR |
| `pnpm run build` | تجميع `dist/` للإنتاج | قبل مرشح الإصدار |
| `pnpm run audit:runtime-imports` | سلامة رسم الاستيراد في وقت التشغيل | بعد التحركات البنيوية |
| `pnpm run audit:esm` | صحة تعبئة ESM | بعد تغييرات البناء |
| `pnpm run smoke:dist` | smoke على المخرجات المبنية | قبل مرشح الإصدار |
| `pnpm run eval:fixtures` | 27 اختبار eval حتمي | بعد تغييرات المنطق |

`pnpm run smoke:dist` هو البوابة النهائية. إذا فشل، فالأثر المبني معطل.

## اختبارات smoke

**نقطة الدخول:** `src/smoke.ts`
**المنفذ:** `src/smoke/smoke-runner.ts`
**الحالات:** `src/smoke/cases/*.ts`
**الأساس القديم:** `src/smoke/_legacy.ts` (التأكيدات محفوظة)

تغطي smoke السلوك عبر الأنظمة الفرعية باستخدام مزودات ومحولات وهمية. لا تستدعي APIs حية.

```bash
# جميع الحالات
pnpm run smoke

# حسب الوسم
pnpm run smoke --tag skills
pnpm run smoke --tag memory

# حسب معرف الحالة
pnpm run smoke --id corrupt-skill-usage

# سرد الحالات
pnpm run smoke --list

# الفشل السريع + JSON
pnpm run smoke --fail-fast --json
```

### ما تغطيه smoke

- تطبيع المزود والتوجيه
- استرداد استدعاء الأدوات والاستمرار
- أساسيات خلفية المتصفح
- توليد الصور (FAL، BytePlus/Seedream)
- الصوت (TTS، STT)
- تقدم Telegram، والموافقات، والمرفقات، ودورة حياة الجلسة
- تنفيذ المهارة، والطفرة، والتطور
- ترقية الذاكرة، والأصل، والعرض الانتقائي، والإلغاء، وحماية ملفات الأمان
- سياسة الأمان والحد الأدنى الصارم
- إنشاء/سرد/تحرير/tick Cron
- اكتشاف MCP وإعادة التحميل
- تدفق ACP الأساسي
- توسيع السياق وتعبئة الموجه
- التعامل مع المخرجات
- استمرار المسار وتصنيف الفشل
- أوامر CLI trace
- منفذ eval والاختبارات
- مقارنة التدفق الذهبي
- انتقالات حالة التغيير
- رسم تبعية الكود: البحث الأمامي/العكسي/المتأثر، الملخص، إبطال الذاكرة المؤقتة
- TaskFlow: انتقالات الحالة، والقفل، والهجرة، والذرية، ودورة حياة المحرك، واسترداد إعادة التشغيل، ولوحة تحكم المشغل، والضغط

### ما لا تغطيه smoke

- تنفيذ مزود حقيقي (وهمي)
- بوابة Telegram حقيقية (محول وهمي)
- أتمتة متصفح حقيقية (خلفية وهمية)
- تنفيذ خادم MCP حقيقي (وهمي)
- توليد صوت/صورة حقيقي (استجابات وهمية)
- جلسات قنوات صوت Discord حقيقية، وإدخال ميكروفون، ومزودات صوت حية، وتنزيلات نموذج faster-whisper الحية

قيود smoke ليست قيود منتج. هي حدود اختبار.

## اختبارات eval

27 اختبارًا حتميًا يُشغل بـ `pnpm run eval:fixtures`.

**وقت التشغيل الأساسي (3):**
- `provider-text-response` — المزود يُرجع نصًا بدون استدعاءات أدوات
- `tool-security-block` — الأمر الخطير محظور بسياسة الأمان
- `missing-tool-failure` — الأداة غير المسجلة تُرجع undefined

**الذاكرة (4):**
- `memory-promotion-provenance` — الترقية تحمل بيانات وصفية للأصل
- `memory-deactivate-suppresses` — الذاكرة المعطلة مُقمعَة من السياق
- `memory-selective-renders` — العارض الانتقائي يحترم قواعد البديل
- `memory-safety-files-protected` — ملفات الأمان لا يمكن إلغاء تنشيطها

**رسم تبعية الكود (5):**
- `knowledge-forward-deps` — البحث الأمامي عن التبعيات
- `knowledge-reverse-deps` — البحث العكسي عن التبعيات
- `knowledge-affected-files` — البحث عن الملفات المتأثرة انتقاليًا
- `knowledge-graph-summary` — عدادات ملخص الرسم
- `knowledge-cache-invalidates` — إبطال الذاكرة المؤقتة عند تغيير المصدر

**التطور (6):**
- `manifest-creation-from-observation` — الملاحظة تنشئ ChangeManifest
- `skill-proposal-manifest-bridge` — `skill.propose_patch` ينشئ manifest
- `user-correction-recording` — تصحيح المستخدم مسجل كحدث
- `tool-description-proposal` — هيكل وصف الأداة
- `routing-metadata-proposal` — هيكل بيانات وصفية للتوجيه
- `evolution-export-shape` — تصدير مجموعة البيانات يطابق المخطط

**أساس TaskFlow (5):**
- `taskflow-state-transitions` — انتقالات حالة التدفق والخطوة
- `taskflow-locking` — اكتساب القفل، والإصدار، ونبضة القلب، واسترداد القديم
- `taskflow-migration` — هجرة المخطط
- `taskflow-atomicity` — الانتقالات الذرية وسلامة الجولة
- `taskflow-engine-lifecycle` — دورة حياة محرك التدفق والخطوة

**محرك TaskFlow (1):**
- `taskflow-restart-recovery` — استرداد إعادة التشغيل يعلم التدفقات القديمة منقطعة

**لوحة تحكم المشغل (1):**
- `operator-control-plane` — الموزع يوجه ويتحقق من أوامر الشرطة المائلة

**الضغط (1):**
- `flow-compaction` — يدوي، تلقائي، سلامة الحدود، الحفظ

**تكامل Track 5 (1):**
- `track5-integration` — تكامل النظام: المحول، جسر CLI، توصيل وقت التشغيل

## أدوات CLI التشخيصية

```bash
# فحص تاريخ التنفيذ
estacoda trace list [--session <id>] [--limit <n>]
estacoda trace dump <trajectory-id> [--raw]
estacoda trace timeline <trajectory-id> [--raw]
estacoda trace failures <trajectory-id>

# تشغيل اختبارات eval
estacoda eval [fixture-id]
```

هذه أدوات فحص وقت التشغيل، وليست بديلاً لاختبارات الوحدة.

## ممارسات الاختبار المستهدفة

شغل المكدس الكامل قبل التغييرات البنيوية. شغل مجموعات مستهدفة للعمل على الأنظمة الفرعية.

```bash
# النظام الفرعي للصوت فقط
pnpm exec vitest run src/tools/voice-tools.test.ts src/tools/tts-providers.test.ts src/tools/stt-providers.test.ts
pnpm exec vitest run src/channels/voice-transcription.test.ts src/gateway/voice-state.test.ts
```

فحوصات إنهاء المزود ونظافة التفكير:

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
pnpm exec vitest run src/memory/local-memory-provider.test.ts
pnpm exec vitest run src/skills/skill-learning.test.ts
pnpm exec vitest run src/skills/skill-evolution.test.ts
pnpm exec vitest run src/evolution/export-format.test.ts
```

افحص أوضاع الفشل هذه قبل تغيير سلوك وقت تشغيل المزود:

- `incomplete-stream` يبقى فشلًا أو يستخدم الاحتياطي؛ ويجب ألا يصبح جوابًا نهائيًا للمساعد
- استدعاءات الأدوات المقطوعة بسبب `length` تُعاد محاولتها مرة واحدة أو تُرفض؛ ويجب ألا تصل المحاولة المقطوعة الأولى إلى التخطيط أو التنفيذ
- JSON النهائي المشوه للأدوات يبقى خطأ في تخطيط الأدوات
- الاستجابات التي تحتوي على تفكير فقط تستخدم مسار إعادة محاولة الجواب المرئي دون عرض التفكير الخام
- متابعة النص المرئي المقطوع بسبب `length` تحفظ رسالة مساعد نهائية واحدة ولا تحفظ رسائل متابعة اصطناعية
- اختبارات الملخصات والذاكرة والمهارات والتصدير تزيل التفكير مع الحفاظ على النص المرئي العادي

مسار الفحص اليدوي:

```bash
pnpm run dev
estacoda trace list --limit 5
estacoda trace dump <trajectory-id> --raw
```

يجب ألا تظهر بيانات التفكير الخام، أو `reasoning_content`، أو `reasoning_details`، أو وسائط الأدوات المقطوعة والمستبعدة، أو رسائل المتابعة/التمهيد الاصطناعية في رسائل الجلسة المرئية المحفوظة، أو أحداث وقت التشغيل/الجلسة، أو الملخصات، أو ملفات الذاكرة، أو سجلات المهارات، أو آثار التصدير. قد تظهر بيانات آمنة مثل سبب الإنهاء، والاستخدام، و`reasoningMetadata`، وحالة القطع، وحالة المتابعة.

تستخدم اختبارات المزود، وصوت Discord، وfaster-whisper المحاكاة حيث تكون الحزم الاختيارية أو الخدمات الحية غائبة. استدعاءات المزود الحية، وصوت Discord الحقيقي، والتقاط الميكروفون، وتنزيلات النموذج الأولى هي اختبارات تكامل المشغل، وليست متطلبات CI الأساسية.

## الممارسة الموصى بها

1. شغل `pnpm run typecheck` أولاً.
2. شغل `pnpm run test`، و`pnpm run smoke`، و`pnpm run smoke:dist` قبل إعلان النجاح.
3. للسلوك الحي، شغل التحقق اليدوي للمشغل.
4. سجّل الأعطال بلقطات شاشة، وسجلات، وخطوات إعادة الإنتاج.

## صفحات ذات صلة

- [المشكلات المعروفة](./known-issues.md) — القيود التي تؤثر على نطاق الاختبار
- [تشغيل البوابة](./gateway-operations.md) — أوامر المشغل للتشخيص
