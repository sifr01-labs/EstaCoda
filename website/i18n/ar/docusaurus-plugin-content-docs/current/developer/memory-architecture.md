---
title: بنية الذاكرة
description: ملفات الذاكرة، والترقية، والاسترجاع، والحفظ، وحدود تركيب الموجه.
sidebar_position: 5
---

# بنية الذاكرة

ذاكرة EstaCoda هي سياق تشغيل دائم مركب من ملفات الملف الشخصي، والملفات المشتركة، وبيانات الترقية، ومصادر الاسترجاع الاختيارية. ليست تاريخ الجلسات، وليست قناة سياسة مخفية.

هذه الصفحة للمحافظين الذين يفحصون قراءات الذاكرة، أو كتاباتها، أو ترقيتها، أو استرجاعها، أو ضغطها، أو حفظها. السلوك الموجه للمستخدم موثق في [الذاكرة](../user-guide/memory.md).

---

## المكونات

| المكون | المسؤولية |
|---|---|
| `MemoryStore` | تمثيل `USER.md` و`MEMORY.md` و`SOUL.md` والذاكرة المشتركة داخل الذاكرة. يفرض الميزانيات وفحص المحتوى. |
| `LocalMemoryProvider` | مزود وقت التشغيل الذي يكتب الاستنتاجات إلى `MemoryStore`، ويحفظ الملفات، ويتراجع عند فشل الكتابة، ويعرض search/context. |
| `MemoryPromotionStore` | يقرأ ويكتب `promotions.json`، ويتتبع الترقيات النشطة، والمستبدلة، والمقواة، والمنسية. |
| `MemoryPersistenceService` | كتابات قرصية ذرية وواعية بالانحراف لملفات الذاكرة و`promotions.json`. |
| `MemoryPromptContextBuilder` | يبني كتل الذاكرة الموثوقة وكتل الاسترجاع غير الموثوقة لتركيب الموجه. |
| `MemoryRecallOrchestrator` | يقرر متى يضاف استرجاع الجلسة أو الاسترجاع الخارجي إلى الدور. |
| `LocalMemoryRetrievalService` | قراءة/بحث لفظي فوق ملفات الذاكرة صاحبة السلطة والذاكرة المشتركة. |
| `MemoryFileCompactionService` | مسار ضغط صريح لـ `USER.md` و`MEMORY.md`. |
| `AgentLoop` | يستدعي الترقية بعد دور المستخدم المباشر ويسجل أحداث وتشخيصات الترقية. |

مسارات الحالة المهمة تأتي من `src/config/profile-home.ts`.

```text
~/.estacoda/
├── sessions.sqlite
├── memory/shared/
└── profiles/<id>/
    ├── USER.md
    ├── SOUL.md
    ├── MEMORY.md
    ├── promotions.json
    ├── external-memory/
    └── temp/
```

---

## طبقات الثقة

يفصل تركيب الموجه بين الذاكرة المتعلمة الموثوقة والاسترجاع غير الموثوق.

| الطبقة | الثقة | ملاحظات |
|---|---|---|
| `SHARED.md`, `USER.md`, `MEMORY.md` | ذاكرة متعلمة موثوقة | لكنها تبقى أدنى من تعليمات النظام/المطور/المستودع/المستخدم الحالي. |
| `SOUL.md` | ذاكرة هوية وسلامة موثوقة | محمية من القراءة/البحث العاديين إلا عند الطلب الصريح. |
| استرجاع الجلسة | سياق مرجعي غير موثوق | يضاف فقط للأدوار التي تطلب الاسترجاع. |
| الاسترجاع الخارجي | سياق مرجعي غير موثوق | مدعوم بمزود، محدود، وموسوم. |
| ملخصات ضغط الجلسة | سياق مرجعي غير موثوق | ليست ذاكرة متعلمة. |

الاسترجاع لا يجوز أن يتجاوز سياسة الأمان، أو حالة الموافقات، أو تعليمات المستودع، أو إدخال المستخدم المباشر الحالي.

---

## مسار الترقية في وقت التشغيل

يستدعي `AgentLoop` الترقية بعد حدث إدخال المستخدم:

```ts
await this.#promoteRepeatedPreferences(input.text, userInputEvent.id);
```

حد الإدخال المباشر مهم. `input.text` هو نص المستخدم الأصلي. قد يحتوي `effectiveText` على scaffolding استئناف أو نص موسع من وقت التشغيل، ولا يجب أن يدخل الترقية.

يحاول `#promoteRepeatedPreferences` مسارين مستقلين:

1. `resolveUserPreferencePromotion(...)` يكتب تفضيلات المستخدم إلى `USER.md`.
2. `resolveProjectFactPromotion(...)` يكتب حقائق المشروع إلى `MEMORY.md`.

تجاوز ميزانية تفضيلات المستخدم غير قاتل للدور ويسجل تشخيصًا بأفضل جهد. الأخطاء غير المتوقعة تحافظ على سلوك وقت التشغيل الحالي وتبقى قاتلة ما لم تصنف صراحة كفشل ترقية آمن. ترقية حقائق المشروع تبقى مستقلة عن ترقية تفضيلات المستخدم.

---

## استخراج المرشحين

تبدأ الترقية باستخراج مرشحين مباشرين ذوي نوع:

```ts
type PromotionStatementCandidate = {
  text: string;
  source: "direct-user-input";
  index: number;
};
```

الاستخراج محدود بـ `MAX_PROMOTION_STATEMENT_CANDIDATES` ويحتفظ حاليًا بثمانية مرشحين كحد أقصى.

المستخرج:

- يزيل inline hidden reasoning
- يزيل كتل الكود
- يقسم العبارات المباشرة عند الأسطر الجديدة وعلامات نهاية الجملة
- يرفض النص المقتبس، أو المحاط بـ backticks، أو بعلامات اقتباس typographic
- يرفض scaffolding التفويض، والمساعد، والأداة، والسيرة، وsummarize-this
- يرفض العبارات العرضية الطويلة
- يرفض أحرف التحكم غير المرئية وثنائية الاتجاه

يبقى المصدر `direct-user-input`. لا تضف مصادر مساعد، أو أداة، أو جلسة فرعية، أو سيرة، أو نص مفوض دون تصميم أمان جديد.

---

## بحث الأدلة

تحتاج الترقية إلى أدلة تاريخية داعمة. مسارا تفضيلات المستخدم وحقائق المشروع يستدعيان `SessionDB.search(...)` مع:

```ts
rootSessionsOnly: true
```

هذا يستبعد الجلسات الفرعية من أدلة الترقية. مستدعو البحث العام الحاليون ما زالوا يحصلون على الجلسات الفرعية افتراضيًا ما لم يمرروا `rootSessionsOnly: true`.

يجب أن تكون المطابقات التاريخية رسائل مستخدم. يعاد تشغيل detector على الرسالة التاريخية، ولا تحسب إلا مساواة المفتاح الحتمي.

العتبة الحالية هي جلستان جذريتان سابقتان مطابقتان. ويجب أن يحتوي الدور الحالي أيضًا على مرشح مدعوم.

---

## Detectors حتمية

منطق الترقية يجب أن يبقى حتميًا. لا تستخدم نموذجًا أو LLM لتقرير:

- الأهلية
- تقسيم العبارات
- التوحيد المعياري
- التكافؤ الدلالي
- فئة التعارض
- قرارات الترقية أو النسيان

detectors التفضيلات تدعم صيغًا إنجليزية وعربية ضيقة. لا توحد إلا عندما تكون الصيغة صريحة.

أمثلة:

| الإدخال | محتوى المرشح |
|---|---|
| `I prefer TypeScript` | `Prefer TypeScript.` |
| `I'd prefer TypeScript` | `Prefer TypeScript.` |
| `My preference is TypeScript` | `Prefer TypeScript.` |
| `We prefer TypeScript` | `Prefer TypeScript.` |
| `Default to TypeScript` | `Prefer TypeScript.` |
| `Use TypeScript by default` | `Prefer TypeScript.` |
| `Please switch to TypeScript by default` | `Prefer TypeScript.` |
| `أفضل TypeScript` | `Prefer TypeScript.` |
| `استخدم pnpm test افتراضياً` | `Prefer pnpm test.` |
| `خلّي الردود مختصرة` | `Prefer concise replies.` |

العبارات القريبة مثل `I like TypeScript` و`Maybe use TypeScript` و`Could you use TypeScript` و`Switch to TypeScript` تبقى مرفوضة.

التقاط `X` العربي العام محدود عمدًا إلى قيم تقنية: لغات افتراضية معروفة، أوامر مدير الحزم، ثوابت شبيهة بمتغيرات البيئة، مسارات، ورموز نموذج/إصدار. هذا يحافظ على `TypeScript` و`pnpm test` و`~/.estacoda/foo` و`GPT-5` دون قبول عبارات لغة طبيعية واسعة.

كشف حقائق المشروع منفصل وأضيق. يعالج صيغًا مثل `project uses X` و`run tests with X` و`X is stored under Y`. ولا يستخدم فئات تعارض التفضيلات.

---

## التوحيد والتعارض

التفضيلات المعيارية تستخدم محتوى ومفاتيح مستقرة. مثلًا:

```text
I prefer TypeScript
Default to TypeScript
Use TypeScript by default
```

كلها تصبح:

```text
Prefer TypeScript.
```

فئات التعارض المشتقة وقت التشغيل حصرية عمدًا:

| الفئة | أمثلة |
|---|---|
| `reply-verbosity` | `Prefer concise replies.`, `Prefer detailed replies.` |
| `language-default` | `Prefer TypeScript.`, `Prefer JavaScript.` |
| `test-command` | `Prefer pnpm test.`, `Prefer npm test.` |
| `package-manager` | `Prefer pnpm.`, `Prefer npm.` |
| `code-style` | `Always use strict mode.`, `Always use semicolons.` |

يشتق `MemoryPromotionStore` الفئات من المحتوى وقت المقارنة. لا تضاف metadata فئة إلى `MemoryPromotionRecord`. لذلك تبقى السجلات القديمة بدون حقول فئة قابلة للتحميل والمشاركة في التعارض الحتمي.

لا يحدث الاستبدال إلا عندما يقع تفضيلان نشطان في الفئة الحصرية المشتقة نفسها. حقائق المشروع لا تستخدم هذه الفئات.

---

## سلوك مخزن الترقية

شكل ملف `promotions.json`:

```ts
type PromotionFile = {
  version: 1;
  records: MemoryPromotionRecord[];
};
```

يطبع `MemoryPromotionStore` السجلات بمفتاح محتوى normalized. يدعم:

- إنشاء ترقية جديدة
- تقوية ترقية موجودة
- استبدال تفضيل نشط متعارض
- نسيان تفضيل نشط
- تعطيل سجل بالمعرف
- استعادة السجلات أثناء rollback

في تفضيلات المستخدم، قد يضع المخزن سجلًا متعارضًا كغير نشط ويضبط `supersededBy`. في حقائق المشروع، ينشئ أو يقوي فقط، ولا يشغل تعارضات التفضيلات.

يفرغ المخزن السجلات مرتبة حسب المحتوى. إذا فشل التفريغ، تعود السجلات في الذاكرة إلى الخريطة السابقة.

---

## الحفظ والتراجع

يحمي `MemoryPersistenceService` الكتابات القرصية بفحصين:

1. drift detection يقارن snapshot القرص الحالية مع snapshot المحملة.
2. atomic write ينشئ ملفًا مؤقتًا في الدليل الهدف ثم يعيد تسميته.

تتضمن snapshots المسار، والنوع، و`mtimeMs`، والحجم، وcontent hash. إذا عدلت عملية أخرى الملف بعد تحميله، يرمى `MemoryPersistenceDriftError` ويبقى الملف محفوظًا.

يضيف `LocalMemoryProvider` rollback أعلى مستوى:

- إذا فشل حفظ Markdown لتفضيل مستخدم بعد تغيير metadata، يستعيد `USER.md` وسجلات الترقية السابقة.
- إذا فشل حفظ Markdown لحقيقة مشروع بعد تغيير metadata، يستعيد `MEMORY.md` وسجلات الترقية السابقة.
- إذا فشل حفظ تفضيل يستبدل آخر، يستعيد السجل المستبدل وMarkdown.
- إذا حدث scanner rejection بعد تغيير metadata، يتراجع عن metadata وMarkdown.

النسخ الاحتياطية اختيارية عبر write policy. ضغط ملف الذاكرة يستخدم النسخ الاحتياطية قبل التطبيق؛ كتابات الترقية العادية لا تنشئ نسخًا احتياطية افتراضيًا.

---

## ماسح السلامة

كتابات الذاكرة تمر عبر الفحص في `MemoryStore` والتطهير في `LocalMemoryProvider`.

المسار يرفض أو يزيل:

- inline hidden reasoning
- محتوى يشبه حقن الموجهات
- محتوى يشبه الاعتمادات
- مخرجات ضغط ذاكرة غير آمنة
- محتوى يتجاوز الميزانية
- أحرف تحكم غير مرئية أو ثنائية الاتجاه مشبوهة في مرشحي الترقية

قد يتعرف detector على الصيغة قبل أن يرفضها provider/store. مثلًا، قد تنتج الصيغة العربية `Prefer OPENAI_API_KEY.`، لكن مسار السلامة يرفضها قبل الحفظ.

لا تضعف الماسح لجعل اختبارات الترقية تمر. يجب أن تؤكد الاختبارات الرفض وrollback.

---

## الاسترجاع والفهرسة

يوفر `LocalMemoryRetrievalService` قراءة/بحثًا لفظيًا فوق ملفات الذاكرة والذاكرة المشتركة. الفهرس حالة مشتقة قابلة لإعادة البناء:

```text
~/.estacoda/profiles/<id>/memory-index.sqlite
```

إذا كان الفهرس معطلًا أو مفقودًا أو غير متاح، يمكن للقراءة/البحث الرجوع إلى قراءة الملفات مباشرة أو بحث substring. يبقى `SOUL.md` محميًا ومستبعدًا إلا إذا كان `includeProtected` صريحًا.

لا يجب أن يصبح الفهرس طبقة سلطة جديدة. تبقى `USER.md` و`MEMORY.md` و`SOUL.md` وملفات الذاكرة المشتركة و`promotions.json` مصادر السلطة.

---

## الضغط والذاكرة الخارجية

يستهدف `MemoryFileCompactionService` فقط `USER.md` و`MEMORY.md`. يستخدم route المساعد `memory_compaction`، ثم يطبق فحوصات الماسح والميزانية نفسها قبل الكتابة. الضغط المطبق ينشئ نسخة احتياطية مؤرخة ويدعم الاستعادة.

الذاكرة الخارجية معطلة افتراضيًا. المزود المبني على الملفات يخزن السجلات تحت `external-memory/` المحلي للملف الشخصي. كتل الاسترجاع الخارجي سياق مرجعي غير موثوق. إخفاقات المزود الخارجي لا يجب أن تفسد أو تستبدل الذاكرة المحلية.

---

## أسطح الاختبار

فحوصات مركزة:

```bash
pnpm exec vitest run src/memory/memory-promotion.test.ts
pnpm exec vitest run src/memory/memory-hardening-evals.test.ts
pnpm exec vitest run src/runtime/agent-loop.test.ts
pnpm exec vitest run src/session/sqlite-session-db.test.ts src/session/in-memory-session-db.test.ts
pnpm exec vitest run src/memory/memory-persistence-service.test.ts
pnpm exec vitest run src/memory/local-memory-provider.test.ts
pnpm exec vitest run src/memory/memory-store.test.ts
pnpm exec vitest run src/memory/memory-prompt-context-builder.test.ts
pnpm exec vitest run src/memory/memory-retrieval-service.test.ts
pnpm exec vitest run src/memory/memory-file-compaction-service.test.ts
```

عند فحص الترقية، افحص بالترتيب:

1. `input.text` المباشر الحالي.
2. المرشحين المباشرين المستخرجين.
3. استعلام session search وسلوك `rootSessionsOnly`.
4. رسائل المستخدم التاريخية في الجلسات الجذرية.
5. مساواة المفتاح المعياري.
6. `promotions.json`.
7. كتابة ملف Markdown وسلوك rollback.

اعتبر أي استدعاء LLM/model في أهلية الترقية، أو التكافؤ، أو التعارض، أو الفئة regression.

---

## مرتبط

- [الذاكرة](../user-guide/memory.md) - دليل الذاكرة الموجه للمستخدم
- [بيئة التشغيل](./runtime.md) - إنشاء وقت التشغيل وحدود الجلسة
- [بيئة تشغيل المزود](./provider-runtime.md) - حدود تنفيذ المزود
- [الحالة والملفات](../reference/state-and-files.md) - مسارات حالة الملف الشخصي والحالة العامة
