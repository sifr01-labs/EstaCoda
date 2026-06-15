---
title: الإعدادات
description: عائلات إعدادات الملف الشخصي التشغيلية والأشكال الشائعة.
sidebar_position: 3
---

# الإعدادات

يحمّل EstaCoda إعدادات ملف شخصي واحد محدد في كل جلسة. لا يوجد دمج إعدادات عام، ولا تغطية على مستوى المشروع، ولا سطح إعدادات لتجميع بيانات الاعتماد. الملف الشخصي الذي تختاره هو ما تحصل عليه.

توجد الإعدادات في:

```text
~/.estacoda/profiles/<profile-id>/config.json
```

تنتمي الأسرار إلى `.env` أو `auth.json` الخاص بالملف الشخصي المحدد، وليس في `config.json` أو أمثلة من الوثائق.

## عائلات الإعدادات

تدعم إعدادات الملف الشخصي هذه العائلات على المستوى الأعلى. ليس كل عائلة مطلوبة. العائلات المُهملة تستخدم القيم الافتراضية الآمنة أو تبقى غير نشطة.

### model

مسار النموذج الأساسي. يقرر أي مزود ونموذج يتولى حلقة الاستدلال الرئيسية.

```json
{
  "model": {
    "provider": "openai",
    "id": "gpt-4.1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "maxTokens": 8192
  }
}
```

الشكل المكافئ:

```yaml
model:
  provider: openai
  id: gpt-4.1
  maxTokens: 8192
```

الحقل `model.maxTokens` هو حد الخرج على مستوى المسار. إذا كان غير مضبوط، يُستخدم الافتراضي لدى المزود. تُقبل الأعداد الصحيحة الموجبة، سواء كانت أرقامًا أو سلاسل نصية. تُرفض القيم `0`، والقيم السالبة، والكسور، والسلاسل غير الرقمية. تعرض التشخيصات `provider default` عندما يكون غير مضبوط، وتحذر من القيم المضبوطة تحت `2048`.

الحقل `maxTokens` على مستوى الطلب يتجاوز إعداد المسار لتلك مكالمة المزود فقط. لا يغيّر إعداد الملف الشخصي، ولا تجاوزات الجلسة، ولا الأسماء المستعارة، ولا الاحتياطيات، ولا البصمات.

تُختار أسماء معاملات حد الرموز حسب وضع API:

| المزود/وضع API | المعامل المرسل |
|---|---|
| OpenAI Chat Completions | `max_completion_tokens` |
| دردشة طرف ثالث متوافقة مع OpenAI | `max_tokens` |
| OpenAI Responses API | `max_output_tokens` |

إذا كان الحد غير مضبوط، لا يُرسل أي معامل حد رموز.

تملك طلبات المزود أيضًا ضوابط مهلة:

```json
{
  "model": {
    "provider": "kimi",
    "id": "kimi-k2.6",
    "timeoutMs": 1800000,
    "staleTimeoutMs": 120000
  },
  "providers": {
    "kimi": {
      "timeoutMs": 1800000,
      "staleTimeoutMs": 120000
    }
  }
}
```

`timeoutMs` هي ميزانية الطلب الكلية للمزود. قيمتها الافتراضية `1800000` مللي ثانية، أي 30 دقيقة. `staleTimeoutMs` هي ميزانية انعدام التقدم. قيمتها الافتراضية `120000` مللي ثانية، أي دقيقتان.

الأسبقية:

```text
model.timeoutMs / model.fallbacks[].timeoutMs
→ providers.<id>.timeoutMs
→ 1800000

model.staleTimeoutMs / model.fallbacks[].staleTimeoutMs
→ providers.<id>.staleTimeoutMs
→ 120000
```

في طلبات المزود غير المتدفقة، تقيس `staleTimeoutMs` مدة انتظار رؤوس الاستجابة فقط. بعد وصول الرؤوس، تحكم المهلة الكلية قراءة جسم الاستجابة. في الطلبات المتدفقة، يعاد ضبط `staleTimeoutMs` بعد كل بايتات مستلمة، فتلتقط تعطل أول بايت وتعطل منتصف التدفق. مهلات النماذج المساعدة تضبط بشكل منفصل عبر `auxiliaryModels.*.timeoutMs`؛ مهلات الركود للنماذج المساعدة وأعلام CLI لضبط مهلات المزود ليست جزءًا من هذا السطح.

### modelAliases / model_aliases

اختصارات مُسمّاة لتركيبات مزود/نموذج.

```json
{
  "modelAliases": {
    "fast": { "provider": "openai", "model": "gpt-4o-mini" }
  }
}
```

### providers

مسارات مزود إضافية، وبدائل، وبيانات وصفية.

```json
{
  "providers": {
    "fallback": { "provider": "openrouter", "model": "openrouter/auto" }
  }
}
```

### auxiliaryModels

مسارات متخصصة للمهام غير الأساسية. الأسماء غير المدعومة تُلقي أخطاء أثناء تطبيع الإعدادات.

| المسار | الغرض |
|--------|-------|
| `vision` | تحليل الصور |
| `compression` | ضغط الجلسة الدلالي |
| `assessor` | مقيّم الموافقة الأمنية |
| `web_extract` | استخراج الويب |
| `session_search` | تلخيص استدعاء الجلسة |
| `mcp` | تفويض أدوات MCP |
| `memory_flush` | عمليات الذاكرة |
| `delegation` | تفويض الوكيل الفرعي |
| `skills_library` | توزيع المهارات |
| `title_generation` | توليد عنوان الجلسة |
| `curator` | تأهيل المهارات |
| `memory_compaction` | ضغط ملف الذاكرة |
| `profile_context` | توليد سياق الملف الشخصي |

### delegation

إعدادات تفويض الوكلاء الفرعيين تُطبّع بالقيم الافتراضية عندما تكون محذوفة.

| المفتاح | الافتراضي | السلوك |
|---------|-----------|--------|
| `maxSpawnDepth` | `1` | أقصى عمق لتفويض الأطفال recursively. أطفال `leaf` لا يفوضون. |
| `maxConcurrentChildren` | `3` | أقصى عدد أطفال نشطين في دفعة. |
| `maxDelegateCallsPerTurn` | `3` | سقف كل provider turn لاستدعاءات `delegate_task` المنفصلة. |
| `maxBatchTasks` | `10` | أقصى طول لـ `tasks[]`. |
| `childTimeoutSeconds` | `600` | حد timeout للطفل؛ الحد الأدنى 30 ثانية. |
| `heartbeatSeconds` | `30` | فترة heartbeat للأب أثناء عمل الأطفال. |
| `heartbeatStaleCyclesIdle` | `3` | عتبة stale-heartbeat عندما يكون الطفل idle. |
| `heartbeatStaleCyclesInTool` | `6` | عتبة stale-heartbeat عندما يكون الطفل داخل أداة. |
| `recoverJsonStringTasks` | `true` | استرداد صارم لمصفوفات `tasks` المرسلة كسلسلة JSON. |
| `diagnostics.enabled` | `true` | كتابة تشخيصات timeout/stale محدودة عندما يوجد diagnostics root للملف التعريفي. |
| `diagnostics.includePromptPreview` | `false` | معاينات prompt الكاملة تبقى معطلة افتراضيًا. |
| `outcomeMemory.enabled` | `false` | ذاكرة نتائج التفويض اختيارية ومحدودة. |
| `defaultAllowedRiskClasses` | `read-only-local`, `read-only-network` | فئات مخاطر أدوات الطفل الافتراضية بعد التقاطع مع أدوات الأب المرئية. |
| `defaultExcludedToolsets` | `browser`, `media`, `mcp` | toolsets تُزال من مخططات الأطفال الافتراضية. |
| `defaultAllowedToolsets` | فارغ | لا يوجد grant افتراضي واسع لـ toolset. |
| `blockedToolNames` / `blockedToolPrefixes` | deny list مدمجة | إزالة أدوات exact/prefix قبل بناء مخططات الطفل. |
| `childRuntime` | recall/learning/compression معطلة، project context محدود | تعطيل ميزات runtime الشبيهة بالأب داخل حلقات الأطفال. |

`terminal.run`، وأدوات الكتابة/التحكم بالعمليات، والذاكرة/بحث الجلسات، وتعديل المهارات/الإعداد/cron/الثقة، وأس surfaces بيانات الاعتماد تُزال افتراضيًا. `terminal.inspect` هي أداة `read-only-local` وقد تظهر للطفل فقط عندما تكون مرئية للأب وتسمح بها سياسة القراءة فقط. إعدادات التفويض تدخل في runtime fingerprint حتى تعيد تغييرات المخطط بناء provider tool schemas.

### web

اختيار خلفية أبحاث الويب.

```json
{
  "web": {
    "backend": "fetch",
    "searchBackend": "fetch",
    "extractBackend": "fetch"
  }
}
```

فقط `fetch` مُنفذ مباشرة. Firecrawl وParallel وTavily وExa وSearXNG وBrave وDDGS هي أطر مسجلة وستُبلّغ أنها غير متاحة حتى لو تم تكوينها.

### compression

ضغط الجلسة الدلالي. تجريبي فقط في v0.1.0.

```json
{
  "compression": {
    "enabled": false,
    "experimental": false,
    "threshold": 0.50,
    "targetRatio": 0.20,
    "protectFirstTurns": 3,
    "protectLastTurns": 20
  }
}
```

يجب أن يكون كل من `enabled` و `experimental` `true` حتى يُفعّل الضغط.

### externalMemory / external_memory

استدعاء خارجي اختياري ونسخ متطابق. معطل افتراضيًا.

```json
{
  "externalMemory": {
    "enabled": false,
    "provider": "file",
    "timeoutMs": 750,
    "maxResults": 3,
    "maxChars": 2500,
    "mirrorWrites": false
  }
}
```

فقط موفر `file` المدمج مُنفذ. المسارات المطلقة مرفوضة.

### browser

اختيار خلفية المتصفح.

```json
{
  "browser": {
    "backend": "local-cdp",
    "supervised": true,
    "autoLaunch": true,
    "launchExecutable": "/path/to/chrome",
    "launchArgs": ["--headless=new"],
    "chromeFlags": ["--no-first-run"],
    "summarizeSnapshots": "auto",
    "snapshotSummarizeThreshold": 8000
  }
}
```

يدعم `local-cdp` الاتصال اليدوي عبر CDP والتشغيل التلقائي المُشرف عليه. استخدم `launchExecutable` و`launchArgs` و`chromeFlags` لإعداد التشغيل المنظم. يبقى `launchCommand` مقبولًا فقط كبيانات توافق مهملة ولا يُحلل كـ shell.

| المفتاح | النوع | ملاحظات |
|---|---|---|
| `browser.launchExecutable` | string | مسار Chrome/Chromium الصريح والمفضل للتشغيل التلقائي المحلي عبر CDP المُشرف عليه. |
| `browser.launchArgs` | string array | وسائط تشغيل منظمة. كرر `--launch-arg` في إعداد CLI للإضافة. |
| `browser.chromeFlags` | string array | أعلام Chrome منظمة. كرر `--chrome-flag` في إعداد CLI للإضافة. |
| `browser.launchCommand` | string | بيانات توافق مهملة فقط. لا تُقسم ولا تُخمن ولا تُحلل كـ shell. |
| `browser.hybridRouting` | boolean | يوجّه عناوين HTTP(S) العامة إلى السحابة والعناوين الخاصة/الداخلية المسموحة إلى المحلي عند الإعداد. لا يتجاوز أمان URL. |
| `browser.cloudFallback` | boolean | يسمح لإخفاقات Browserbase المؤهلة بالرجوع إلى المحلي. إخفاقات موافقة الإنفاق لا ترجع. |
| `browser.cloudSpendApproved` | boolean أو `"pending"` | موافقة صريحة لإنشاء جلسات متصفح سحابية قابلة للفوترة. بيانات الاعتماد وحدها لا توافق على الإنفاق. |
| `browser.summarizeSnapshots` | boolean أو `"auto"` | يتحكم في إمكانية تلخيص اللقطات المعروضة الضخمة. |
| `browser.snapshotSummarizeThreshold` | number | عتبة أحرف عرض اللقطة قبل التفكير في التلخيص. |

Browserbase مُنفّذ عبر خلفية المتصفح، ويتطلب `BROWSERBASE_API_KEY` و`BROWSERBASE_PROJECT_ID` و`browser.cloudSpendApproved: true` صريحة قبل إنشاء جلسات قابلة للفوترة. يضبط `estacoda browser approve-cloud` الموافقة، ويعطلها `estacoda browser revoke-cloud`. الإعداد وحده لا ينشئ جلسات Browserbase. تبقى browser-use وFirecrawl browser وCamofox مزودات مؤجلة.

يتبع التوجيه الهجين سياسة أمان URL للمتصفح: تبقى العناوين الخاصة/الداخلية محظورة ما لم تكن `security.allowPrivateUrls` مفعّلة صراحةً، وتبقى نقاط metadata محظورة دائمًا، وتُفرّغ التحويلات غير الآمنة إلى `about:blank` عندما يمكن ذلك أو تُغلق الجلسة غير الآمنة.

### imageGen / image_gen

مزود توليد الصور والنموذج.

```json
{
  "imageGen": {
    "provider": "fal",
    "model": "fal-ai/flux-2/klein/9b",
    "useGateway": false
  }
}
```

المزودون المدعومون: `fal`، `byteplus`.

### tts

مزود تحويل النص إلى كلام وإعدادات الصوت.

```json
{
  "tts": {
    "enabled": true,
    "provider": "openai",
    "openai": {
      "model": "gpt-4o-mini-tts",
      "voice": "alloy",
      "apiKeyEnv": "VOICE_TOOLS_OPENAI_KEY"
    }
  }
}
```

TTS المستضاف المستقر: OpenAI، ElevenLabs، MiniMax، Gemini، xAI. TTS المحلي وMistral مؤجلان.

### stt

مزود تحويل الكلام إلى نص والنموذج.

```json
{
  "stt": {
    "enabled": true,
    "provider": "openai",
    "openai": {
      "model": "gpt-4o-mini-transcribe",
      "apiKeyEnv": "VOICE_TOOLS_OPENAI_KEY"
    }
  }
}
```

STT المستضاف المستقر: OpenAI، Groq، xAI. STT المحلي يدعم `command` و `faster-whisper`. Mistral STT مؤجل.

في v0.1.0، يعني `stt.provider: "local"` faster-whisper المُدار افتراضياً:

```json
{
  "stt": {
    "provider": "local",
    "local": {
      "engine": "faster-whisper",
      "model": "base",
      "pythonBinary": "/optional/custom/python",
      "fasterWhisper": {
        "enabled": true,
        "model": "base",
        "device": "auto",
        "computeType": "default",
        "hfHome": "/optional/model-cache",
        "allowModelDownload": true,
        "gatewayAllowModelDownload": true,
        "queueDepth": 1,
        "timeoutMs": 300000
      }
    }
  }
}
```

اترك `pythonBinary` غير مضبوط لاستخدام المسار المُدار تحت `~/.estacoda/python-env`، أو اضبطه على Python يملكه المشغل عند استخدام `estacoda voice setup --stt-provider local --python-binary /path/to/python`. ذاكرة النموذج الافتراضية هي `~/.estacoda/cache/huggingface` وهي منفصلة عن venv.

ترث تنزيلات النموذج عبر البوابة `allowModelDownload`. لأن `allowModelDownload` افتراضياً `true`، تكون تنزيلات التشغيل الأول التي تطلقها البوابة مسموحة افتراضياً؛ اضبط `gatewayAllowModelDownload: false` فقط عندما يجب أن تتطلب رسائل البوابة الصوتية نموذجاً مخزناً مسبقاً.

وضع الأوامر صريح:

```json
{
  "stt": {
    "provider": "local",
    "local": {
      "engine": "command",
      "command": "/path/to/transcriber {input}"
    }
  }
}
```

`engine: "command"` هو الحاكم ولا يستخدم faster-whisper المُدار.

### voice

سلوك auto-TTS في البوابة.

```json
{
  "voice": {
    "autoTts": false,
    "autoTtsMaxCharsPerReply": 1200,
    "autoTtsMaxCharsPerHourPerChat": 5000
  }
}
```

### mcpServers / mcp_servers

تعريفات خوادم MCP.

```json
{
  "mcpServers": {
    "my-server": {
      "command": "node",
      "args": ["/path/to/server.js"],
      "cwd": "/optional/cwd",
      "env": { "KEY": "value" },
      "includeTools": ["tool1"],
      "excludeTools": ["tool2"],
      "trust": "conservative",
      "timeout": 30000
    }
  }
}
```

مستويات الثقة: `conservative`، `read-only-network`، `read-only-local`.

### skills

تحميل المهارات وسياسة Agent Evolution.

```json
{
  "skills": {
    "autonomy": "suggest",
    "externalDirs": ["/optional/external/skill/root"]
  }
}
```

أوضاع الاستقلالية: `none`، `suggest`، `proactive`، `autonomous`.

`skills.autonomy` هو مفتاح التوافق المحفوظ لـ Agent Evolution. في Phase 1A يتحكم فقط في سلوك الأدلة وproposal القابل للمراجعة. وضع `autonomous` هو وضع ظل فقط: يسجّل القرارات للمراجعة ولا ينفذ ترقية تلقائية أو استرجاعًا تلقائيًا أو تعديلًا لملفات المهارات.

### ui

تفضيلات واجهة المستخدم الطرفية.

```json
{
  "ui": {
    "theme": "dark",
    "locale": "en"
  }
}
```

### profile

بيانات وصفية للملف الشخصي.

```json
{
  "profile": {
    "name": "work",
    "description": "Production work profile"
  }
}
```

### security

وضع الأمان وتجاوزات السياسة.

```json
{
  "security": {
    "mode": "adaptive",
    "allowPrivateUrls": false,
    "websiteBlocklist": {
      "domains": ["*.example.com"]
    }
  }
}
```

الأوضاع: `strict`، `adaptive`، `open`. الافتراضي هو `adaptive`.

### channels

إعدادات محول القنوات. راجع [إعدادات القنوات](../user-guide/channels.md) للمخطط الكامل.

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botTokenEnv": "ESTACODA_TELEGRAM_BOT_TOKEN",
      "streaming": {
        "enabled": true,
        "editIntervalMs": 750,
        "minInitialChars": 24,
        "cursor": "▌",
        "maxFloodStrikes": 2,
        "cleanupFailedAttempts": true,
        "transport": "auto",
        "freshFinalAfterSeconds": 0
      },
      "busyPolicy": "reject",
      "queueDepth": 3
    }
  }
}
```

الإعداد الموجّه لـ Telegram يخزن رمز البوت في `.env` الخاص بالملف الشخصي المحدد تحت `ESTACODA_TELEGRAM_BOT_TOKEN`، ويكتب `botTokenEnv: "ESTACODA_TELEGRAM_BOT_TOKEN"` في الإعدادات. يجب ألا يظهر رمز بوت Telegram الخام في مراجعة الإعدادات أو مخرجات الإعداد.

يُضبط بث Telegram تحت `channels.telegram.streaming`. يكون مفعلاً افتراضيًا لقنوات Telegram المُعدّة، ويؤثر في توصيل Telegram فقط. لتعطيله، اضبط `channels.telegram.streaming.enabled` على `false`. لا يغير حالة الجلسة، أو الذاكرة، أو الموافقات، أو تنفيذ الأدوات، أو المنتجات، أو `response.text` النهائي.

| الإعداد | النوع / القيم المسموحة | الافتراضي | ملاحظات |
|---|---|---:|---|
| `channels.telegram.streaming.enabled` | `boolean` | `true` | يفعّل بث Telegram للقنوات المُعدّة. اضبطه على `false` لتعطيله. |
| `channels.telegram.streaming.editIntervalMs` | عدد صحيح غير سالب | `750` | فاصل تجميع تعديلات Telegram الجزئية. |
| `channels.telegram.streaming.minInitialChars` | عدد صحيح غير سالب | `24` | حد الأحرف المرئية بعد التصفية قبل أول إرسال جزئي. |
| `channels.telegram.streaming.cursor` | `string` | `"▌"` | مؤشر بث مؤقت يُلحق بالرسائل الجزئية. |
| `channels.telegram.streaming.maxFloodStrikes` | عدد صحيح غير سالب | `2` | حد تدهور flood-control للدور النشط. |
| `channels.telegram.streaming.cleanupFailedAttempts` | `boolean` | `true` | حذف أو تحييد الرسائل المبثوثة المؤقتة بعد فشل المزود أو fallback. |
| `channels.telegram.streaming.transport` | `"auto"`، `"edit"`، أو `"draft"` | `"auto"` | يختار `"auto"` معاينات المسودات للرسائل المباشرة عند دعمها، وإلا يستخدم edit streaming. يستخدم `"edit"` تعديلات الرسائل العادية. يستخدم `"draft"` معاينات مسودات Telegram في الرسائل المباشرة فقط عندما يدعمها Bot API. |
| `channels.telegram.streaming.freshFinalAfterSeconds` | عدد صحيح غير سالب | `0` | القيمة `0` تعطل fresh-final delivery. القيمة الموجبة ترسل الرد المكتمل كرسالة جديدة بعد ظهور المعاينة لذلك العدد من الثواني، ثم تحذف المعاينة best-effort. |

يعمل بث Telegram قبل توجيه النص النهائي العادي. إذا لم يتمكن البث من توصيل الرد المكتمل، يرجع `ChannelGateway` إلى توصيل `DeliveryRouter` العادي. يستخدم البث الجزئي HTML escaping خفيفًا؛ أما التوصيل النهائي فيستخدم تنسيق Telegram العادي. تعتمد معاينات المسودات وrich message delivery على دعم Telegram وBot API. يكون rich message delivery انتهازيًا ويرجع إلى تنسيق Telegram العادي عندما يكون غير مدعوم، أو طويلًا جدًا، أو ملتبسًا. flood control، أو الحمولات الجزئية الكبيرة، أو حدود الموافقة، أو حدود المنتجات، أو فشل final edit تفرض fallback للنص النهائي العادي للدور النشط فقط. يبقى البث تجربة توصيل فقط؛ يبقى `response.text` النهائي هو المرجع.

## التعامل مع الأسرار

- تكتب عمليات إعداد المزود مفاتيح API الخام فقط إلى `.env` الخاص بالملف الشخصي المحدد، وليس إلى `config.json`.
- يتم تعيين أذونات `.env` للملف الشخصي على `0600` عند الكتابة بواسطة مخزن الأسرار البيئية.
- تحمّل إعدادات التشغيل `.env` الخاص بالملف الشخصي المحدد قبل التنفيذ.
- لا تلصق أسرار حقيقية في مقتطفات الإعدادات.

## التحقق من الصحة

يتحقق EstaCoda من الإعدادات أثناء التحميل. القيم غير الصالحة تعود إلى الإعدادات الافتراضية أو تُقيّد ضمن الحدود الآمنة. بيانات الاعتماد المطلوبة المفقودة تُنتج تلميحات تحتاج إلى إعداد، ولي أعطال.

## صفحات ذات صلة

- [متغيرات البيئة](./environment-variables.md) — أسماء متغيرات البيئة والسلوك
- [الحالة والملفات](./state-and-files.md) — مكان وجود ملفات الإعدادات
- [المزودون](../user-guide/providers.md) — إعداد المزودين والنضج
- [القنوات](../user-guide/channels.md) — إعداد القنوات
- [الأمان والموافقات](../user-guide/security-and-approvals.md) — أوضاع الأمان
