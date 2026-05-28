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
    "model": "gpt-4o",
    "apiKeyEnv": "OPENAI_API_KEY"
  }
}
```

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
    "autoLaunch": false,
    "allowPrivateUrls": false
  }
}
```

`local-cdp` هو الخلفية الوحيدة المُنفذة مباشرة. Browserbase وbrowser-use وFirecrawl وCamofox مسجلة لكن لا يمكنها إنشاء جلسات مباشرة.

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
        "gatewayAllowModelDownload": false,
        "queueDepth": 1,
        "timeoutMs": 300000
      }
    }
  }
}
```

اترك `pythonBinary` غير مضبوط لاستخدام المسار المُدار تحت `~/.estacoda/python-env`، أو اضبطه على Python يملكه المشغل عند استخدام `estacoda voice setup --stt-provider local --python-binary /path/to/python`. ذاكرة النموذج الافتراضية هي `~/.estacoda/cache/huggingface` وهي منفصلة عن venv.

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

تحميل المهارات والاستقلالية.

```json
{
  "skills": {
    "autonomy": "suggest",
    "externalDirs": ["/optional/external/skill/root"]
  }
}
```

أوضاع الاستقلالية: `none`، `suggest`، `proactive`، `autonomous`.

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
      "botTokenEnv": "ESTACODA_TELEGRAM_TOKEN",
      "busyPolicy": "reject",
      "queueDepth": 3
    }
  }
}
```

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
