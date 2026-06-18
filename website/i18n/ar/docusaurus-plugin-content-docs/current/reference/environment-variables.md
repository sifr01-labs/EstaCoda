---
title: متغيرات البيئة
description: مرجع متغيرات البيئة التشغيلية.
sidebar_position: 4
---

# متغيرات البيئة

متغيرات البيئة هي مدخلات تشغيلية تُحمّل للملف الشخصي المحدد. يقرأها EstaCoda من بيئة العملية ومن ملف `.env` الخاص بالملف الشخصي المحدد.

موقع التخزين المفضل للأسرار:

```text
~/.estacoda/profiles/<profile-id>/.env
```

تكتب عمليات الإعداد الأسرار هناك بأذونات `0600`. يمكنك أيضًا الإشارة إلى متغير بيئة موجود بالاسم في الإعدادات.

## عزل الحالة

| المتغير | الغرض |
|---------|-------|
| `ESTACODA_HOME` | يتجاوز جذر الحالة الافتراضي (`~/.estacoda`). استخدمه لتشغيل إصدارات التطوير مقابل حالة معزولة دون لمس بيانات المستخدم الحقيقية. |

## مفاتيح API لمزودي LLM

| المتغير | المزود | الحالة |
|---------|--------|--------|
| `KIMI_API_KEY` | Kimi | مثبت عمليًا |
| `OPENAI_API_KEY` | OpenAI | مثبت عمليًا |
| `DEEPSEEK_API_KEY` | DeepSeek | مثبت عمليًا |
| `OPENROUTER_API_KEY` | OpenRouter | مثبت عمليًا |
| `GOOGLE_API_KEY` | Google | قابل للإعداد/معروف في الكتالوج |
| `ANTHROPIC_API_KEY` | Anthropic | معروف في الكتالوج؛ غير قابل للتشغيل كمسار LLM رئيسي |

MiniMax وNous معروفان في الكتالوج لكن غير قابلين للتشغيل في البنية الحالية.

## Codex OAuth

يخزن مصادقة Codex الرموز في `~/.estacoda/auth.json` بعد تدفق رمز الجهاز OAuth. لا تدير مخزن الأسرار البيئية رموز Codex.

## مفاتيح مزودي الصوت

| المتغير | الغرض |
|---------|-------|
| `VOICE_TOOLS_OPENAI_KEY` | مفتاح OpenAI الصوتي الافتراضي لـ TTS/STT |
| `OPENAI_API_KEY` | بديل OpenAI الصوتي فقط عندما يكون المتغير البيئي المُعدّ هو الافتراضي `VOICE_TOOLS_OPENAI_KEY` |
| `ELEVENLABS_API_KEY` | ElevenLabs TTS |
| `MINIMAX_API_KEY` | MiniMax TTS |
| `GEMINI_API_KEY` | Gemini TTS |
| `XAI_API_KEY` | xAI TTS/STT الأصلي |
| `GROQ_API_KEY` | Groq STT |
| `HF_HOME` | جذر ذاكرة التخزين المؤقت الاختياري لـ faster-whisper / Hugging Face |
| `TRANSFORMERS_CACHE` | متغير بيئة اختياري لذاكرة التخزين المؤقت لـ Hugging Face يحترمه بيئة العامل |

بيانات اعتماد الصوت هي مراجع متغيرات بيئة مباشرة فقط. لا توجد مجموعات بيانات اعتماد صوتية أو وسطاء بوابة أو بدائل مدارة أو مصادر غير بيئية.

يستخدم STT المحلي المُدار `~/.estacoda/cache/huggingface` افتراضياً لذاكرة نماذج faster-whisper عندما لا يكون `hfHome` مضبوطاً. إذا كان `TRANSFORMERS_CACHE` مضبوطاً مسبقاً في بيئة العملية، يحافظ عليه runtime. تبقى بيئة Python المُدارة منفصلة في `~/.estacoda/python-env`.

## مفاتيح توليد الصور

| المتغير | المزود |
|---------|--------|
| `FAL_KEY` | FAL |
| `BYTEPLUS_ARK_API_KEY` | BytePlus / Seedream |

## مفاتيح مزود المتصفح

| المتغير | المزود | الغرض |
|---------|--------|-------|
| `BROWSERBASE_API_KEY` | Browserbase | مصادقة API لـ Browserbase. |
| `BROWSERBASE_PROJECT_ID` | Browserbase | مشروع Browserbase المستخدم لجلسات المتصفح السحابية. |

هذه البيانات تحقق جاهزية Browserbase فقط. لا توافق على إنشاء جلسات قابلة للفوترة. تبقى جلسات Browserbase محظورة حتى تكون `browser.cloudSpendApproved === true`، وعادة تُضبط عبر `estacoda browser approve-cloud` وتُلغى عبر `estacoda browser revoke-cloud`.

## مفاتيح مزود بحث الويب

| المتغير | المزود | الغرض |
|---------|--------|-------|
| `BRAVE_SEARCH_API_KEY` | Brave Search | متغير البيئة الافتراضي لمصادقة Brave Search API. |

تخزن إعدادات Brave مرجع متغير البيئة في `web.brave.apiKeyEnv`؛ ولا تخزن المفتاح الخام. لا يستخدم DDGS مفتاح API. تأتي جاهزية DDGS من قدرة Python المُدارة:

```bash
estacoda python-env setup ddgs
estacoda python-env verify ddgs
```

## مفاتيح القنوات

| المتغير | القناة |
|---------|--------|
| `ESTACODA_TELEGRAM_BOT_TOKEN` | رمز بوت Telegram الذي يستخدمه الإعداد الموجّه |
| `ESTACODA_DISCORD_TOKEN` | رمز بوت Discord |
| `ESTACODA_WHATSAPP_BRIDGE_INSTALL_TIMEOUT` | مهلة اختيارية بالميلي ثانية لخطوة إصلاح/تثبيت اعتمادات الجسر الصريحة في `estacoda whatsapp` |

يستخدم البريد الإلكتروني مفاتيح `passwordEnv` في الإعدادات تشير إلى متغيرات بيئة عشوائية، مثل `EMAIL_PASSWORD`.

لا يستخدم ⁨WhatsApp⁩ متغير بيئة لرمز بوت. مصادقة الجهاز تتم عبر ⁨QR⁩ فقط من خلال تدفق إعداد ⁨WhatsApp⁩ المشترك، المتاح من onboarding الأول، و⁨Setup Editor⁩، والأمر ⁨estacoda whatsapp⁩. تبقى اعتمادات الجسر معزولة داخل `scripts/whatsapp-bridge/`.

## تصحيح أخطاء المتصفح والويب

| المتغير | التأثير |
|---------|---------|
| `ESTACODA_BROWSER_DEBUG` | يُفعّل تليمتري تصحيح أخطاء المتصفح |
| `ESTACODA_WEB_TOOLS_DEBUG` | يُفعّل تليمتري تصحيح أخطاء أدوات الويب |

يتم حذف بيانات التصحيح قبل التخزين أو الإرجاع.

## تجاوز عناوين URL الخاصة

| المتغير | التأثير |
|---------|---------|
| `ESTACODA_ALLOW_PRIVATE_URLS` | يتجاوز إعداد `security.allowPrivateUrls`. يقبل `1`، `true`، `yes`، `on` للتفعيل؛ و`0`، `false`، `no`، `off` للتعطيل. أي قيمة أخرى تُفشل تحميل الإعدادات. |

## قواعد

- لا تُدرج الأسرار في ملفات المستودع.
- لا تُلزم المفاتيح الحقيقية.
- يخزن الإعداد الافتراضي الأسرار الملصقة في `.env` الخاص بالملف الشخصي المحدد.
- يمكن للإعداد المتقدم الإشارة إلى متغير بيئة موجود بالاسم.
- المتغير البيئي الصوتي المخصص المفقود لا يعود إلى `OPENAI_API_KEY`.
- القيم المحلولة لا تُسجل أبدًا ولا تُرجع في الأخطاء.

## صفحات ذات صلة

- [الإعدادات](./configuration.md) — عائلات ملف الإعدادات
- [الحالة والملفات](./state-and-files.md) — مكان وجود `.env`
- [المزودون](../user-guide/providers.md) — إعداد المزودين
