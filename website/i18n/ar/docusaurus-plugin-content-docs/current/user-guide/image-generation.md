---
title: توليد الصور
description: سير عمل توليد الصور المدعوم من المزود.
sidebar_position: 13
---

# توليد الصور

توليد الصور هو سير عمل أداة مدعوم من المزود. يستدعي العميل `image.generate` مع مطالبة نصية؛ يُرجع المزود المُعد رابط صورة؛ تقوم EstaCoda بتنزيل الصورة وتخزينها مؤقتًا وتسجيلها كـ artifact محلي.

هو ليس إمكانية نموذج مدمجة. تحتاج إلى حساب مزود، ومفتاح API، وملف شخصي مُعد لاستخدامه.

## المزودون المدعومون في v0.1.0

| المزود | النموذج الافتراضي | متغير البيئة الافتراضي | عنوان URL الأساسي |
|--------|-------------------|------------------------|-------------------|
| FAL | `fal-ai/flux-2/klein/9b` | `FAL_KEY` | `https://fal.run` |
| BytePlus / Seedream | `seedream-5-0-260128` | `BYTEPLUS_ARK_API_KEY` | `https://ark.ap-southeast.bytepluses.com/api/v3` |

FAL هو المزود الافتراضي. الوصول إلى نماذج BytePlus يعتمد على الإصدار؛ يجب تفعيل النموذج في حساب Ark Console قبل الاستخدام.

## الإعداد

اضبط المزود في الملف الشخصي المحدد:

```bash
estacoda image setup --provider fal --model fal-ai/flux-2/klein/9b --api-key-env FAL_KEY
estacoda image setup --provider byteplus --model-version seedream-5 --api-key-env BYTEPLUS_ARK_API_KEY
estacoda image setup --provider fal --api-key <key>
```

يكتب الإعداد إعدادات المزود في `~/.estacoda/profiles/<id>/config.json` تحت مفتاح `imageGen`. إذا مررت بـ `--api-key`، يخزن الأمر السر في ملف `.env` الخاص بالملف الشخصي ويُشير إليه باسم متغير البيئة.

تحقق من الإعداد الحالي:

```bash
estacoda image status
```

تحقق من الجاهزية (وجود المفتاح والتحقق الاختياري من المزود):

```bash
estacoda image verify
estacoda image verify --skip-provider-check
```

اعرض النماذج والأسماء المستعارة المتاحة:

```bash
estacoda image models --provider fal
estacoda image models --provider byteplus
```

## ملف الإعدادات

إعدادات توليد الصور موجودة في الملف الشخصي المحدد:

```text
~/.estacoda/profiles/<profile-id>/config.json
```

مثال:

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

- `provider`: `fal` أو `byteplus`.
- `model`: معرف نموذج المزود الدقيق أو اسم مستعار يُحل وقت التشغيل.
- `useGateway`: ما إذا كان التوجيه عبر وسيط البوابة. في v0.1.0 يبقى `false` للاستدعاءات المباشرة.
- كتل المزود (`fal`، `byteplus`) يمكن أن تُجاوز `model` و `apiKeyEnv` و `baseUrl`.

## سلوك الأداة

يستدعي العميل `image.generate` تلقائيًا عندما تطلب صورة. يمكنك أيضًا استخدامها في سياقات أدوات أخرى.

المعاملات:

| المعامل | النوع | مطلوب | ملاحظات |
|---------|-------|-------|---------|
| `prompt` | `string` | نعم | المطالبة النصية. |
| `aspectRatio` | `string` | لا | `square`، `landscape`، أو `portrait`. الافتراضي square. |
| `model` | `string` | لا | يُجاوز النموذج المُعد لهذا الطلب. |
| `seed` | `number` | لا | بذرة اختيارية لإعادة الإنتاج. |

تعيين نسبة العرض إلى الارتفاع:

| النسبة | FAL | BytePlus |
|--------|-----|----------|
| `square` | `square_hd` | `1920x1920` |
| `landscape` | `landscape_16_9` | `2560x1440` |
| `portrait` | `portrait_16_9` | `1440x2560` |

النتيجة:

- تُكتب الصورة إلى `~/.estacoda/profiles/<id>/image-cache/`.
- يُسجَّل artifact مع بيانات وصفية: المزود، النموذج، النسبة، البذرة، عنوان URL المصدر.
- تُرجع الأداة مسار الـ artifact والمزود والنموذج ومعرف الـ artifact.
- توصيل Telegram يرسل الصورة كصورة عندما تكون البوابة والقناة جاهزتين.

## أنماط الفشل

| العرض | السبب المحتمل | الاستعادة |
|-------|---------------|-----------|
| مفتاح المزود مفقود | متغير البيئة المُشار إليه في `apiKeyEnv` غير موجود. | أضف المفتاح إلى `.env` الخاص بالملف الشخصي وأعد المحاولة. |
| مزود غير مدعوم | فقط `fal` و `byteplus` مُنفذان. | اختر مزودًا مدعومًا. |
| خطأ من المزود البعيد | HTTP 4xx/5xx، فشل مصادقة، أو نموذج غير مُفعّل. | تحقق من حالة المزود، والبيانات الاعتماد، وتفعيل النموذج. |
| فشل تنزيل عنوان URL المُنشأ | أرجع المزود عنوان URL لا يمكن جلبه. | أعد طلب الطلب؛ قد تحدث مشكلات شبكة عابرة. |
| مسار إخراج غير صالح | مجلد ذاكرة التخزين المؤقت مفقود أو غير قابل للكتابة. | تنشئ EstaCoda المجلد بشكل متكرر؛ تحقق من أذونات نظام الملفات. |
| رفض المزود / السلامة | رفض المزود المطالبة لأسباب سياسية. | أعد صياغة المطالبة أو تحقق من سياسات المحتوى للمزود. |
| BytePlus `ModelNotOpen` | نموذج Seedream غير مُفعّل لحسابك. | فعّله في Ark Console، أو اختر نموذجًا آخر باستخدام `estacoda image models --provider byteplus`. |

## الحالة والملفات

| المسار | الغرض |
|--------|-------|
| `~/.estacoda/profiles/<profile-id>/image-cache/` | الصور المُنشأة والمُنزَّلة. |
| `~/.estacoda/profiles/<profile-id>/config.json` مفتاح `imageGen` | إعدادات المزود والنموذج. |
| `~/.estacoda/profiles/<profile-id>/.env` | أسرار مفتاح API (إذا خزّنها الإعداد). |

## صفحات ذات صلة

- [المزودون](./providers.md) — إعداد المزودين وقواعد بيانات الاعتماد
- [الأدوات](./tools.md) — فئات مخاطر الأدوات وتوفرها
- [البوابة](./gateway.md) — توصيل الصور المُنشأة عبر القنوات
