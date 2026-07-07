---
title: الذاكرة
description: كيف تخزن EstaCoda الذاكرة الدائمة وترقيها وتفحصها وتصلحها.
sidebar_position: 7
---

# الذاكرة

ذاكرة EstaCoda هي سياق دائم محفوظ في ملفات. تساعد الجلسات اللاحقة على تذكر التفضيلات الدائمة، وحقائق المشروع، وأسلوب التشغيل، والقيود المتكررة، والملاحظات التي نظمها المشغل.

الذاكرة ليست طبقة سلطة مخفية. تعليمات النظام، وتعليمات المطور، وتعليمات المستودع، و`AGENTS.md`، وسياسة الأمان، وطلب المستخدم الحالي تبقى أعلى أولوية.

استخدم هذه الصفحة لمعرفة ما الذي يمكن حفظه، وأين يعيش، وكيف يعمل التنظيم والترقية، وكيف تفحص الذاكرة أو تصلحها.

---

## ما هي الذاكرة

لدى EstaCoda عدة مخازن مرتبطة بالذاكرة. ليست كلها الشيء نفسه.

| المخزن | المكان | الغرض |
|---|---|---|
| تاريخ الجلسات | قاعدة بيانات الجلسات | الأدوار والأحداث السابقة. يستخدم للنصوص، والاسترجاع، ونقاط تنظيم الذاكرة، وأدلة الترقية. |
| ذاكرة الملف الشخصي | `~/.estacoda/profiles/<id>/USER.md`, `MEMORY.md`, `SOUL.md` | سياق دائم لملف شخصي واحد. |
| ذاكرة المشروع/مساحة العمل | غالبًا `MEMORY.md` مع سياق المستودع مثل `AGENTS.md` | حقائق المشروع، والاتفاقيات، وملاحظات سير العمل. |
| الذاكرة المشتركة | `~/.estacoda/memory/shared/` | مقتطفات عامة متاحة عبر الملفات الشخصية. |
| بيانات الترقية | `~/.estacoda/profiles/<id>/promotions.json` | تتبع الحقائق المرقاة، وحالتها، وجلسات المصدر، والثقة. |
| سجل التنظيم | `~/.estacoda/profiles/<id>/memory-curation.json` | يتتبع نقاط تنظيم الذاكرة، والمحفزات، والنتائج، وبيانات العمليات المجزأة. |

`AGENTS.md` ليس ملف ذاكرة. هو سياق تعليمات لمساحة العمل. لا ترفعه أدوات الذاكرة، ولا تضغطه، ولا تعدله.

---

## ما ليست عليه الذاكرة

الذاكرة لا تفعل الآتي:

- لا تحفظ كل جملة تبدو مثيرة للاهتمام
- لا ترقي مخرجات المساعد، أو الأدوات، أو الجلسات الفرعية، أو السير الذاتية، أو النص المفوض
- لا تجعل التاريخ المسترجع يتجاوز سياسة الأمان أو طلب المستخدم الحالي
- لا تخزن الأسرار أو النصوص التي تشبه حقن الموجهات
- لا تجعل نموذج الاستخراج يفرض سياسة الكتابة
- لا تعامل محتوى الجلسات القديم كتعليمات موثوقة تلقائيًا

استرجاع الجلسات والاسترجاع الخارجي سياق مرجعي غير موثوق. ملفات الذاكرة المنظمة أقوى من الاسترجاع، لكنها ما زالت أدنى من التعليمات الحالية وسياسة الأمان.

---

## ملفات الملف الشخصي

تعيش ذاكرة الملف الشخصي تحت:

```text
~/.estacoda/profiles/<id>/
```

الملفات المهمة:

| الملف | الغرض | الميزانية الافتراضية |
|---|---|---:|
| `USER.md` | تفضيلات المستخدم وأسلوب التواصل | 1,375 حرفًا |
| `MEMORY.md` | حقائق المشروع وسير العمل والعمليات الدائمة | 2,200 حرف |
| `SOUL.md` | إرشادات الهوية والسلامة | قابلة للتكوين |
| `promotions.json` | بيانات الترقية | لا ميزانية Markdown |

تعيش الذاكرة المشتركة تحت:

```text
~/.estacoda/memory/shared/
```

ترتيب الذاكرة في الموجه:

```text
memory/shared/ -> USER.md -> SOUL.md -> MEMORY.md
```

---

## كيف يعمل تنظيم الذاكرة

تنظيم الذاكرة هو مسار الذاكرة الاستباقي. يراجع مقاطع حديثة من النص عند نقاط طبيعية، ويطلب من نموذج مساعد استخراج حقائق دائمة منظمة مع أدلة، ثم يطبق وقت التشغيل سياسة حتمية.

النموذج يستخرج الحقائق. وقت التشغيل يقرر ماذا يحدث لها.

كل حقيقة مستخرجة تتضمن:

| الحقل | المعنى |
|---|---|
| `statement` | الحقيقة الدائمة بلغة واضحة. |
| `evidence` | مقاطع نصية دقيقة من رسائل المصدر. |
| `category` | work أو project أو preference أو operating-style أو recurring-constraint أو technical-default أو personal أو other. |
| `explicitness` | `explicit` أو `strongly-implied` أو `inferred`. |
| `sensitivity` | `none` أو `private` أو `sensitive` أو `secret`. |
| `confidence` | درجة معيارية تستخدمها سياسة وقت التشغيل. |

الوضع الافتراضي هو `auto`. يبقى `auto` محافظًا: لا يطبق تلقائيًا إلا الحقائق الصريحة، غير الحساسة، منخفضة المخاطر، والتي تنجح في فحوصات الدليل، والتكرار، والماسح، والميزانية، والثقة. عتبة الثقة الافتراضية هي `0.7`.

الأوضاع الأخرى:

| الوضع | السلوك |
|---|---|
| `auto` | يطبق تلقائيًا الحقائق منخفضة المخاطر المؤهلة؛ ويضع الباقي في المراجعة أو يتجاهله. |
| `review` | يسجل سجلات مراجعة معلقة دون كتابة الذاكرة. |
| `manual` | يتجاوز نقاط الخلفية؛ تبقى أوامر التنظيم اليدوية الصريحة متاحة. |

يعمل التنظيم عند نقاط طبيعية مضبوطة:

- كل `memory.curation.checkpointEveryTurns` أدوار مكتملة في جلسة جذرية
- `/compact` وضغط الجلسة عند تفعيله
- `/handoff` عند تفعيله
- التخلص من وقت التشغيل عند تفعيله ونجاح حدود الرسائل/الفترة الدنيا
- `memory populate` أو `/memory populate` الصريح

عندما يكتب التنظيم الذاكرة، يستهدف `USER.md` أو `MEMORY.md`. لا يكتب `SOUL.md`، أو الذاكرة المشتركة، أو `AGENTS.md`، أو تاريخ الجلسة. الكتابات التلقائية تسجل في سجل التنظيم وأحداث وقت التشغيل/الجلسة؛ هي مرئية دون مقاطعة كل دور.

عناصر التحكم مشتركة بين CLI الأعلى، وأوامر slash داخل الجلسة، والأسطح المصرح بها مثل Telegram:

```bash
estacoda memory mode [auto|review|manual]
estacoda memory recent [--limit N]
estacoda memory review [--limit N]
estacoda memory apply <record-id> [candidate-id|all]
estacoda memory reject <record-id> [candidate-id|all]
estacoda memory undo <record-id>
estacoda memory forget <USER.md|MEMORY.md> <exact text>
estacoda memory populate
estacoda memory edit
estacoda memory clear [USER.md|MEMORY.md|all] --yes
```

داخل جلسة أو محادثة Telegram، استخدم الأوامر نفسها عبر `/memory`:

```text
/memory mode review
/memory populate
/memory recent
/memory review
/memory apply <record-id> [candidate-id|all]
/memory reject <record-id> [candidate-id|all]
/memory undo <record-id>
/memory forget <USER.md|MEMORY.md> <exact text>
/memory edit
/memory clear [USER.md|MEMORY.md|all] --yes
```

يعرض `memory review` سجلات المراجعة المعلقة وعمليات المرشحين منخفضة المخاطر المحفوظة. استخدم `memory apply` أو `memory reject` لحسمها، و`memory undo` لعكس سجل تنظيم مطبق، و`memory forget` لإزالة نص مطابق من `USER.md` أو `MEMORY.md`.

---

## كيف تعمل الترقية

الترقية حتمية. تعمل بعد الدور، وتنظر فقط إلى إدخال المستخدم المباشر في الدور الحالي مع أدلة مطابقة من جلسات جذرية سابقة.

يمكن أن تنشئ الترقية:

| المحتوى المرقى | الوجهة |
|---|---|
| تفضيلات مستخدم متكررة | `USER.md` |
| حقائق مشروع متكررة | `MEMORY.md` |

يمرر وقت التشغيل `input.text` الأصلي إلى الترقية. النص الموسع للاستئناف وscaffolding وقت التشغيل لا يدخلان مسار الترقية.

تحتاج الترقية إلى:

1. أن يحتوي إدخال المستخدم المباشر الحالي على مرشح مدعوم.
2. أن توجد جلستان جذريتان سابقتان على الأقل فيهما المرشح الحتمي نفسه.
3. أن تكون الرسائل التاريخية المطابقة من دور المستخدم.
4. أن ينجح المحتوى في فحص السلامة وميزانية ملف الذاكرة.

الجلسات الفرعية مستبعدة من أدلة الترقية. العمل المفوض قد يكون سياقًا مفيدًا، لكنه لا يعلّم تفضيلات دائمة بمفرده.

---

## ما الذي يمكن ترقيته

أنماط تفضيلات المستخدم ضيقة عمدًا.

أمثلة إنجليزية:

| الإدخال | الذاكرة المرقاة |
|---|---|
| `I prefer TypeScript` | `Prefer TypeScript.` |
| `I'd prefer TypeScript` | `Prefer TypeScript.` |
| `My preference is TypeScript` | `Prefer TypeScript.` |
| `We prefer TypeScript` | `Prefer TypeScript.` |
| `Default to TypeScript` | `Prefer TypeScript.` |
| `Use TypeScript by default` | `Prefer TypeScript.` |
| `Please switch to TypeScript by default` | `Prefer TypeScript.` |
| `I prefer concise replies` | `Prefer concise replies.` |

أمثلة عربية:

| الإدخال | الذاكرة المرقاة |
|---|---|
| `أفضل TypeScript` | `Prefer TypeScript.` |
| `أفضّل TypeScript` | `Prefer TypeScript.` |
| `افضل TypeScript` | `Prefer TypeScript.` |
| `استخدم pnpm افتراضياً` | `Prefer pnpm.` |
| `استخدم pnpm افتراضيا` | `Prefer pnpm.` |
| `استخدم pnpm كافتراضي` | `Prefer pnpm.` |
| `خلّي الردود مختصرة` | `Prefer concise replies.` |
| `خلي الردود مختصرة` | `Prefer concise replies.` |
| `خلّي الردود مفصلة` | `Prefer detailed replies.` |
| `خلي الردود مفصلة` | `Prefer detailed replies.` |

قيم التفضيل العربية المختلطة تقبل فقط رموزًا تقنية محدودة، مثل:

- `TypeScript`
- `pnpm test`
- `~/.estacoda/foo`
- `GPT-5`

هذا يحافظ على حالة الأحرف، والمسافات، والمسارات، وأسماء المزود/النموذج حيث تكون مدعومة. عبارات اللغة الطبيعية مثل `أفضل لغة آمنة` أو `استخدم careful release notes كافتراضي` لا تترقى.

ترقية حقائق المشروع منفصلة عن تفضيلات المستخدم. أمثلة:

| الإدخال | الذاكرة المرقاة |
|---|---|
| `project uses TypeScript` | `Project uses TypeScript.` |
| `run tests with pnpm test` | <code>Run tests with `pnpm test`.</code> |
| `foo is stored under ~/.estacoda/foo` | <code>Foo is stored under `~/.estacoda/foo`.</code> |

---

## ما الذي لا يترقى

هذه المدخلات لا تصلح كدليل ترقية:

- النص المقتبس أو المحاط بـ backticks
- كتل الكود
- الفقرات العرضية الطويلة
- ملاحظات المساعد
- مخرجات الأدوات
- نص السير الذاتية
- النص المفوض أو نص الجلسات الفرعية
- النص الذي يشبه حقن الموجهات
- النص الذي يشبه الأسرار
- النص الذي يحتوي أحرف تحكم غير مرئية أو ثنائية الاتجاه

أمثلة لا تترقى:

```text
Please summarize this: "I prefer concise replies."
The attached resume says: "I prefer concise replies."
Agent note: I prefer concise replies.
Earlier assistant said: "User prefers concise replies."
لخّص هذا: "أفضل TypeScript"
لخّص هذا: «أفضل TypeScript»
ملاحظة الوكيل: أفضل TypeScript
السيرة تقول: أفضل TypeScript
قال المساعد سابقاً: المستخدم يفضل TypeScript
```

عبارات إنجليزية قريبة لكنها غير مدعومة:

```text
I like TypeScript
It would be nice if TypeScript
Maybe use TypeScript
Could you use TypeScript
Can we use TypeScript
For this one, use TypeScript
Try TypeScript
Switch to TypeScript
```

---

## التعارض والنسيان

بعض فئات التفضيلات حصرية عمدًا:

| الفئة | أمثلة |
|---|---|
| تفصيل الردود | `Prefer concise replies.`, `Prefer detailed replies.` |
| لغة افتراضية | `Prefer TypeScript.`, `Prefer JavaScript.` |
| أمر الاختبار | `Prefer pnpm test.`, `Prefer npm test.` |
| مدير الحزم | `Prefer pnpm.`, `Prefer npm.` |
| أسلوب الكود | `Always use strict mode.`, `Always use semicolons.` |

عند ترقية تفضيل نشط جديد داخل إحدى هذه الفئات، يستبدل التفضيل النشط القديم في الفئة نفسها. التفضيلات غير المرتبطة تتعايش.

فئات التعارض مشتقة وقت التشغيل من المحتوى المعياري. لا تخزن كحقول schema في `promotions.json`، لذلك تبقى السجلات القديمة صالحة.

لنسيان تفضيل مرقى، استخدم طلب نسيان مباشرًا مثل:

```text
forget that i prefer concise replies
```

إذا وجد التفضيل النشط، تضع EstaCoda علامة forgotten عليه في `promotions.json` وتحذف السطر المقابل من `USER.md`.

---

## سلامة الكتابة

كتابات الذاكرة تمر بفحوصات قبل الحفظ.

يرفض المسار:

- محتوى يشبه الاعتمادات، مثل `OPENAI_API_KEY` عندما سيصبح ذاكرة دائمة
- محتوى يشبه حقن الموجهات
- مخرجات ضغط ذاكرة غير آمنة
- محتوى يتجاوز ميزانية ملف الذاكرة

قد تطابق عبارة عربية مثل `استخدم OPENAI_API_KEY كافتراضي` الصيغة الحتمية، لكن مسار provider/store يرفضها قبل الحفظ.

تستخدم كتابات الذاكرة استبدالًا ذريًا: تكتب ملفًا مؤقتًا في الدليل الهدف ثم تعيد تسميته. إذا فشلت الكتابة، يبقى الملف السابق.

الحفظ واع بالانحراف. قبل الكتابة، تقارن الخدمة ملف القرص الحالي بالنسخة التي حُملت سابقًا. إذا عدلته عملية أخرى، ترفض EstaCoda الكتابة افتراضيًا.

إذا فشلت خطوة لاحقة في الترقية، يتراجع المسار عن Markdown وعن `promotions.json` معًا.

النسخ الاحتياطية لا تنشأ للكتابات العادية افتراضيًا. تنشأ فقط في عمليات تطلبها صراحة، مثل ضغط ملف الذاكرة المطبق.

---

## فحص الذاكرة

استخدم سجل التنظيم عندما تريد فهم ما تذكره الوكيل مؤخرًا أو وضعه في المراجعة:

```bash
estacoda memory recent
estacoda memory review
estacoda memory mode
```

استخدم قراءة/بحث CLI عندما تريد محتوى الذاكرة صاحب السلطة الحالي:

```bash
estacoda memory read USER.md
estacoda memory read MEMORY.md
estacoda memory search <query>
estacoda memory read shared <key>
```

`SOUL.md` محمي. اقرأه فقط بعلم صريح:

```bash
estacoda memory read SOUL.md --include-protected
```

لإصلاح الحالة، افحص الملفات مباشرة:

```bash
ls ~/.estacoda/profiles/<id>/
sed -n '1,160p' ~/.estacoda/profiles/<id>/USER.md
sed -n '1,160p' ~/.estacoda/profiles/<id>/MEMORY.md
sed -n '1,160p' ~/.estacoda/profiles/<id>/promotions.json
```

لا تعدل `promotions.json` بلا مراجعة. هو يتتبع الترقيات النشطة، والمستبدلة، والمنسية.

---

## تعديل الذاكرة بأمان

ملفات الذاكرة Markdown عادي. استخدم مساعد التحرير أو أوقف وقت التشغيل قبل التعديل اليدوي عندما يكون ذلك ممكنًا:

```bash
estacoda memory edit
$EDITOR ~/.estacoda/profiles/<id>/USER.md
$EDITOR ~/.estacoda/profiles/<id>/MEMORY.md
```

استخدم سطرًا واحدًا لكل حقيقة أو تفضيل دائم. أبق المدخلات قصيرة وقابلة للمراجعة.

انسخ الملفات قبل التعديلات الكبيرة:

```bash
cp ~/.estacoda/profiles/<id>/USER.md ~/.estacoda/profiles/<id>/USER.md.bak
cp ~/.estacoda/profiles/<id>/MEMORY.md ~/.estacoda/profiles/<id>/MEMORY.md.bak
```

إذا حذفت سطرًا مرقى يدويًا، افحص `promotions.json` أيضًا. يفضل استخدام طلب النسيان الصريح لتبقى metadata وMarkdown متطابقين.

لمسح الذاكرة المتعلمة عبر مسار أمر محروس:

```bash
estacoda memory clear USER.md --yes
estacoda memory clear MEMORY.md --yes
estacoda memory clear all --yes
```

لا يمسح `memory clear` ملف `SOUL.md` أو الذاكرة المشتركة. قد تحتاج الجلسات الحية الحالية إلى `/new` أو إعادة تشغيل لإعادة تحميل ذاكرة الموجه بعد التحرير اليدوي أو المسح.

---

## الاسترجاع اللفظي المحلي

قراءة/بحث الذاكرة المحلي هو استرجاع لفظي حتمي فوق ملفات الذاكرة صاحبة السلطة. ليس استرجاعًا دلاليًا ولا بحث vectors.

الفهرس القابل لإعادة البناء يعيش تحت حالة الملف الشخصي:

```text
<profile-state-dir>/memory-index.sqlite
```

حذف هذا الملف لا يحذف `USER.md`، أو `SOUL.md`، أو `MEMORY.md`، أو الذاكرة المشتركة، أو `promotions.json`.

أصلح الفهرس عبر:

```bash
estacoda memory index path
estacoda memory index status
estacoda memory index rebuild
```

إذا كان الفهرس معطلًا أو مفقودًا، يمكن أن يرجع `memory.read` و`memory.search` وCLI إلى قراءة ملفات محدودة أو بحث substring حيثما أمكن.

---

## ذاكرة نتائج التفويض

ذاكرة نتائج التفويض منفصلة عن استرجاع نصوص الجلسات الفرعية. هي معطلة افتراضيًا تحت `delegation.outcomeMemory.enabled`.

عند تفعيلها، تسجل metadata محدودة مثل معرف جلسة الأب، ومعرف جلسة الطفل، والدور، والعمق، وفهرس المهمة، والحالة، والسبب، والطابع الزمني، واستخدام الرموز، ومعاينة محدودة للمهمة.

لا تخزن مخرجات الطفل الخام، أو prompts، أو transcripts، أو tool arguments، أو محتوى الملفات، أو diagnostic payloads، أو credentials. وتبقى نصوص الجلسات الفرعية مستبعدة من أدلة الترقية.

---

## ضغط الجلسات وضغط ملفات الذاكرة

ضغط الجلسة وضغط ملف الذاكرة عمليتان مختلفتان.

| العملية | ما الذي تغيره |
|---|---|
| ضغط الجلسة | تاريخ الجلسة الأقدم. ينتج ملخصات تاريخية غير موثوقة. |
| ضغط ملف الذاكرة | `USER.md` أو `MEMORY.md`. ينتج محتوى بديلًا بعد الفحوصات. |

ضغط ملف الذاكرة يستخدم route المساعد `memory_compaction`، ويدعم `dryRun`، وينشئ نسخة احتياطية مؤرخة قبل التطبيق. لا يضغط `SOUL.md`، أو `AGENTS.md`، أو الذاكرة المشتركة، أو تاريخ الجلسة، أو `promotions.json`.

---

## الذاكرة الخارجية

الذاكرة الخارجية معطلة افتراضيًا. المزود المنفذ مبني على الملفات ومحلي للملف الشخصي تحت:

```text
~/.estacoda/profiles/<id>/external-memory/
```

الاسترجاع الخارجي سياق مرجعي غير موثوق. لا يمكنه استبدال `USER.md`، أو `MEMORY.md`، أو `SOUL.md`، أو الذاكرة المشتركة، أو `promotions.json`، أو استرجاع الجلسات.

---

## استكشاف الأخطاء

| العرض | السبب المحتمل | أول فحص |
|---|---|---|
| تفضيل متوقع لم يترق | ظهر في أقل من جلستين جذريتين سابقتين، أو استخدم صيغة غير مدعومة، أو ظهر فقط في نص مفوض/مقتبس/سيرة | افحص تاريخ الجلسات الجذرية وشكل العبارة |
| عبارة عربية أو مختلطة لم تترق | القيمة لغة طبيعية وليست رمزًا تقنيًا مدعومًا، أو تحتوي أحرف bidi/invisible | جرب `أفضل TypeScript` أو `استخدم pnpm test افتراضياً` |
| ظهرت ذاكرة خاطئة | قد تختلف metadata النشطة عن Markdown، أو بقيت ترقية قديمة نشطة | افحص `USER.md` و`MEMORY.md` و`promotions.json` |
| لم تُكتب ذاكرة تلقائية | وضع التنظيم `review` أو `manual`، أو الحقيقة غير صريحة، أو حساسة، أو مكررة، أو فشلت في الماسح، أو تجاوزت الميزانية، أو بلا دليل، أو ثقتها أقل من `0.7` | شغل `estacoda memory recent` و`estacoda memory review` و`estacoda memory mode` |
| `/memory populate` يقول إنه لا توجد runtime نشطة | شُغّل الأمر الأعلى خارج runtime مرتبطة | شغل `/memory populate` داخل جلسة CLI نشطة أو جلسة Telegram مصرح بها |
| تغير ملف الذاكرة خارجيًا | رفض drift detection الكتابة | أعد تشغيل وقت التشغيل أو صالح التعديل اليدوي |
| فشلت كتابة الذاكرة | رفض الماسح، أو تجاوز الميزانية، أو drift، أو خطأ حفظ | افحص التشخيصات وحجم الملفات؛ اضغط أو حرر الذاكرة عند الحاجة |
| لم يحفظ محتوى يشبه سرًا | رفضه ماسح السلامة | ضع الاعتمادات في `.env` أو مخزن أسرار، لا في الذاكرة |
| البحث في الفهرس قديم | الفهرس اللفظي المشتق قديم | شغل `estacoda memory index rebuild` |

عند فحص التنظيم، ابدأ بـ `memory recent` و`memory review`، ثم افحص `USER.md` أو `MEMORY.md`. وعند فحص الترقية الحتمية، ابدأ بإدخال المستخدم المباشر الحالي، ثم رسائل المستخدم في الجلسات الجذرية المطابقة، ثم `promotions.json`.

---

## مرتبطات

- [الملفات الشخصية](./profiles.md) - حالة الملف الشخصي وعزل الذاكرة
- [الجلسات](./sessions.md) - تاريخ الجلسات وحدود الاسترجاع
- [بيئة التشغيل](../developer/runtime.md) - إنشاء وقت التشغيل وتركيب الموجه
- [بنية الذاكرة](../developer/memory-architecture.md) - تفاصيل التنفيذ
- [الأمان والموافقات](./security-and-approvals.md) - حدود الثقة
