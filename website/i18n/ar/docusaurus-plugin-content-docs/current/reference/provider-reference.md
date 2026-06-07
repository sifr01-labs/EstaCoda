---
title: مرجع المزودين
description: جدول نضج المزودين، الحالة، وحدود القدرات لـ v0.1.0.
sidebar_position: 5
---

# مرجع المزودين

يُرسِل كلّ طلب استدلال في EstaCoda عبر مزوّد. تعرض هذه الصفحة كلّ مزوّد يعرفه النظام، والتصنيف الذي يحمله، وما يعني هذا التصنيف في الممارسة. التصنيف يحدّد ما يمكنك ادّعاءه، وما يمكنك تصحيحه، وما لا يجب أن تتوقّعه.

معرفة المزوّد لا تعني أنه قابل للتشغيل. وتسجيله لا يعني أنه مؤهّل. افحص التصنيف قبل الإعداد.

---

## تصنيفات النضج

| التصنيف | المعنى | ما يمكنك فعله |
|---|---|---|
| `live-proven` | مُعدَّ ومُختبَ ومتمحّن في استخدام واقعي. | اجعله مسارًا رئيسيًا بثقة. |
| `implemented` | يوجد الكود، وتتم معالجة البيانات المعتمدة، والطلبات تتنفّذ. لم يُحقّق بعد في استخدام حيّ مستمر. | اعدّده واختبره. أبلغ عن أيّ فجوات. |
| `configurable` | يظهر في الكاتالوغ ويمكن اختياره في الإعداد. قد يفتقر محوّل قابل للتشغيل في هذا الإصدار. | اعدّده إذا كنت تختبر أو تُرسِل. |
| `catalog-known` | مسجّل في كاتالوغ النماذج المحلّي. لا محوّل استدلال قابل للتشغيل في الإصدار الحالي. | ليس مسارًا رئيسيًا في v0.1.0. |
| `experimental` | مُحاصر بواسطة أدوات الميزات أو غير مستقر بالطبيعة. | فعّله بشكل صريح. توقّع الأعطال. |
| `unsupported` | لا توجد تنفيذ. لا محوّل. لا دعم. | لا تُعدّده. |

التصنيفات تتراكم صعودًا. المزوّد `live-proven` هو أيضًا `implemented`. المزوّد `catalog-known` ليس `configurable` للاستدلال.

---

## مزوّد النماذج اللغوية (LLM)

| المزوّد | النضج | ملاحظات |
|---|---|---|
| **Kimi** | `live-proven` | هدف التحقّق الأساسي. دقة الإجراءات الأدواتية مؤهّلة. |
| **OpenAI** | `live-proven` | يدعم وضعي المحادثات ووضعي الإجابات. |
| **DeepSeek** | `live-proven` | مؤهّل للمحادثات مع دعم الأدوات. |
| **OpenRouter** | `live-proven` | يعمل في وقت التشغيل. دقة الإجراءات الأدواتية قد تكون غير متساقية أحيانًا. |
| **Codex** | `implemented` | مسار إعداد عبر CLI عام: `estacoda model setup codex`. مصادقة OAuth عبر رمز الجهاز، تخزين الرموز في `~/.estacoda/auth.json`، إعداد مسار `codex/o3`. مستبعد عن معالج التهيئة بتصميم، ليس مخفيًا. |
| **Google** | `configurable` | مؤهّل في الكاتالوغ. الاختبار الحيّ محدود في هذا الإصدار. |
| **Anthropic** | `configurable` | معروف في الكاتالوغ. غير قابل للتشغيل كمسار لغوي رئيس في هذا الإصدار. |
| **MiniMax** | `catalog-known` | مسجّل في كاتالوغ النماذج. غير قابل للتشغيل في الإصدار الحالي. |
| **Nous** | `catalog-known` | مسجّل في كاتالوغ النماذج. غير قابل للتشغيل في الإصدار الحالي. |
| **Custom (OpenAI-compatible)** | `implemented` | أي معرف مزوّد مع `baseUrl` صريح يعامل كمزوّد OpenAI-compatible. يتطلب `baseUrl`. متغير مفتاح API الافتراضي هو `OPENAI_COMPATIBLE_API_KEY`. |
| **unconfigured** | `unsupported` | نائب. غير قابل للتشغيل. |

### أنماط تنفيذ API

الأنماط التالية قابلة للتشغيل في الكود الحالي:

- `openai_chat_completions`
- `custom_openai_compatible`
- `openai_responses`

### طرق المصادقة

- `apiKey` — يُقرَّأ من `apiKeyEnv` في وقت التشغيل
- `none` — لا تلزم بيانات الاعتماد
- `codex_oauth_device_pkce` — تدفق محدّد رمز الجهاز الخاص بـ Codex

---

## مزوّد الصوت (Voice)

### TTS (النص إلى ملف صوتي)

| المزوّد | النضج | ملاحظات |
|---|---|---|
| **OpenAI** | `live-proven` | TTS مستضاف. يتطلب `OPENAI_API_KEY`. |
| **ElevenLabs** | `live-proven` | TTS مستضاف. يتطلب `ELEVENLABS_API_KEY`. |
| **MiniMax** | `live-proven` | TTS مستضاف. |
| **Gemini** | `live-proven` | TTS مستضاف. |
| **xAI** | `live-proven` | TTS مستضاف. |
| **Edge** | `implemented` | Microsoft Edge TTS. لا يتطلب مفتاح API. |
| **Mistral** | `experimental` | مؤجل لـ v0.1.0. محصور. |
| **Local TTS** | `unsupported` | لا يوجد محوّل TTS محلي في هذا الإصدار. |

### STT (الملف الصوتي إلى نص)

| المزوّد | النضج | ملاحظات |
|---|---|---|
| **OpenAI** | `live-proven` | STT مستضاف. |
| **Groq** | `live-proven` | STT مستضاف. |
| **xAI** | `live-proven` | STT مستضاف. |
| **local** | `implemented` | `faster-whisper` مُدار افتراضياً عند `stt.provider: "local"`؛ محرك الأوامر عبر `stt.local.engine: "command"` صراحةً. تنزيل نموذج faster-whisper عبر البوابة معطّل افتراضيًا. |
| **Mistral** | `experimental` | مؤجل لـ v0.1.0. |

---

## مزوّد إنتاج الصور

| المزوّد | النضج | ملاحظات |
|---|---|---|
| **FAL** | `live-proven` | مزوّد الإنتاج الافتراضي. يتطلب `FAL_KEY`. |
| **BytePlus / Seedream** | `live-proven` | يتطلب `BYTEPLUS_API_KEY`. |

---

## مزوّد البحث على الويب

فقط مسار واحد للبحث على الويب هو حيّ في v0.1.0. الباقي نماذج مسجّلة.

| المزوّد | القدرات المعلنة | النضج | ملاحظات |
|---|---|---|---|
| **fetch** | extract | `live-proven` | المسار الافتراضي للاستخراج المحمي. لا يتطلب مفتاح API. |
| **Firecrawl** | search, extract, crawl | `unsupported` | نموذج مسجّل. غير متوفّر حتى بعد الإعداد. |
| **Parallel** | search | `unsupported` | نموذج مسجّل. |
| **Tavily** | search, extract | `unsupported` | نموذج مسجّل. |
| **Exa** | search | `unsupported` | نموذج مسجّل. |
| **SearXNG** | search | `unsupported` | نموذج مسجّل. |
| **Brave** | search | `unsupported` | نموذج مسجّل. |
| **DDGS** | search | `unsupported` | نموذج مسجّل. |

يوجد `web.search` و `web.crawl` كبنية أدوات، لكن لا توجد استدعاءات بحث أو زحف مستضافة مُنفّذة. يرجع `web.extract` إلى الاستخراج المحمي فقط عندما لا يكون هناك مزوّد مصرّح مكوّن.

---

## مزوّد المتصفّح السحابي

| المزوّد | النضج | ملاحظات |
|---|---|---|
| **local-cdp** | `live-proven` | بروتوكول Chrome DevTools المحلي. الوضع المُشرف عليه اختياري. |
| **mock** | `implemented` | واجهة اختبار. لا متصفّح حقيقي. |
| **Browserbase** | `implemented` | خلفية متصفح سحابية. تتطلب بيانات اعتماد وموافقة صريحة على إنفاق السحابة. |
| **browser-use** | `unsupported` | نموذج مسجّل. غير مُنفّذ. |
| **Firecrawl (browser)** | `unsupported` | نموذج مسجّل. غير مُنفّذ. |
| **Camofox** | `unsupported` | نموذج مسجّل. غير مُنفّذ. |

يتطلب Browserbase كلًا من `BROWSERBASE_API_KEY` و`BROWSERBASE_PROJECT_ID` و`browser.cloudSpendApproved: true` صريحة قبل إنشاء جلسات سحابية. يوافق `estacoda browser approve-cloud` على إنشاء الجلسات القابلة للفوترة، ويحظرها `estacoda browser revoke-cloud` مرة أخرى. لا تزال استدعاءات `createSession()` المباشرة في سجل مزود Browserbase ترمي خطأ لأن موافقة إنفاق السحابة تُفرض عبر خلفية المتصفح. تبقى قيم `firecrawl` و`camofox` القديمة لـ `browser.backend` مقبولة للتوافق لكنها تُبلغ حالة غير متاحة.

---

## المسارات الإضافية للنماذج

المسارات الإضافية هي ميّالات تفضيل، ليست بيئات تشغيل منفصلة. تتم المعالجة عبر نفس بنية المزوّد الرئيسي.

| المسار | الغرض | النضج |
|---|---|---|
| `vision` | تحليل الصور | `implemented` |
| `compression` | الضغط الدلالي للجلسات | `experimental` |
| `assessor` | تصنيف الموافقة الأمنية الذكي | `implemented` |
| `web_extract` | استخراج الويب | `implemented` |
| `session_search` | البحث الدلالي في الجلسات | `implemented` |
| `mcp` | تفويض أدوات MCP | `implemented` |
| `memory_flush` | عمليات الذاكرة | `implemented` |
| `delegation` | تفويض الوكيل الفرعي | `implemented` |
| `skills_library` | توزيع المهارات | `implemented` |
| `title_generation` | توليد عناوين الجلسات | `implemented` |
| `curator` | التنظيم المنطقي للذاكرة | `implemented` |
| `memory_compaction` | ضغط ملفات الذاكرة | `implemented` |
| `profile_context` | توليد سياق الملف الشخصي | `implemented` |

أسماء المسارات الإضافية غير المعتمدة ترمي خطأ أثناء تطبيع الإعداد. لا تستخدم أسماء موروثة مثل `models.auxiliary` أو `auxiliary.default`.

---

## غير المدعوم في v0.1.0

التالي محدّد بشكل صريح للإصدار الحالي:

- محوّل Anthropic Messages API كمسار رئيسي
- محوّلات MiniMax أو Nous
- البحث الحيّ عبر Firecrawl، Parallel، Tavily، Exa، SearXNG، Brave، أو DDGS
- جلسات المتصفّح السحابي عبر browser-use، Firecrawl، أو Camofox
- مزوّدات ذاكرة خارجية مُعدّة بالاسم دون تنفيذ مدمج

---

## مرتبطات

- [المزوّدون](../user-guide/providers.md) — إعداد المزوّدين وتبديل النماذج
- [الإعداد](./configuration.md) — مَخطّط ملف الإعداد
- [متغيرات البيئة](./environment-variables.md) — مرجع متغيرات البيئة
