---
title: الصوت
description: TTS، STT، auto-TTS، و CLI push-to-talk.
sidebar_position: 12
---

# الصوت

الصوت هو إمكانية وسائط اختيارية. هو منفصل عن مسار مزود LLM الأساسي ويستخدم بيانات اعتماد متغيرات البيئة المباشرة فقط.

إذا كانت مزودات الصوت أو أدوات الصوت المحلية أو بيانات الاعتماد الحية غير متوفرة، يستمر تشغيل CLI والبوابة النصي الأساسي دون تغيير. الصوت لا يحظر بقية النظام.

## ما يغطيه الصوت

| الإمكانية | الوظيفة |
|-----------|---------|
| TTS | تحويل ردود العميل النصية إلى صوت. |
| STT | تحويل صوت المستخدم إلى نص مكتوب. |
| Auto-TTS | ت vocalizing ردود البوابة اختياريًا لكل محادثة. |
| CLI push-to-talk | تسجيل إدخال الميكروفون المحلي وإدخال النص في جلسة CLI الحالية. |

## نضج المزود في v0.1.0

### TTS المستضاف — مستقر

| المزود | ملاحظات |
|--------|---------|
| OpenAI | الافتراضي. يستخدم محلل بيانات اعتماد OpenAI الصوتي المشترك. |
| ElevenLabs | يستخدم `xi-api-key` وحودود النص الخاصة بالمزود. |
| MiniMax | يفك تشفير استجابات الصوت base64 JSON. |
| Gemini | يرسل `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`. |
| xAI | يستخدم نقطة النهاية الأصلية `{baseUrl}/tts`؛ غير متوافق مع OpenAI. |

### STT المستضاف — مستقر

| المزود | ملاحظات |
|--------|---------|
| OpenAI | يستخدم محلل بيانات اعتماد OpenAI الصوتي المشترك. |
| Groq | بحث مباشر عن مفتاح البيئة. |
| xAI | يستخدم نقطة النهاية الأصلية `{baseUrl}/stt`؛ غير متوافق مع OpenAI. |

### STT المحلي — مستقر

| المحرك | ملاحظات |
|--------|---------|
| `faster-whisper` | الافتراضي عند `stt.provider: "local"` في v0.1.0. يستخدم بيئة Python المُدارة من EstaCoda ما لم تُضبط Python مخصصة. |
| `command` | اختيار صريح عبر `stt.local.engine: "command"`. يشغل قالب أمر مُعد؛ يفضل نص transcript من stdout. |

### مؤجل أو تجريبي

- مزودات TTS المحلية — غير مُنفذة في v0.1.0.
- Mistral TTS/STT — قد توجد أشكال الإعدادات، لكن التنفيذ غير متاح.

لا تُعد مزودات مؤجلة للإنتاج.

## الإعدادات

إعدادات الصوت موجودة في الملف الشخصي المحدد:

```text
~/.estacoda/profiles/<profile-id>/config.json
```

مثال:

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
  },
  "stt": {
    "enabled": true,
    "provider": "openai",
    "openai": {
      "model": "gpt-4o-mini-transcribe",
      "apiKeyEnv": "VOICE_TOOLS_OPENAI_KEY"
    }
  },
  "voice": {
    "autoTts": false,
    "autoTtsMaxCharsPerReply": 1200,
    "autoTtsMaxCharsPerHourPerChat": 5000
  }
}
```

الحقول الأساسية:

| الحقل | المعنى |
|-------|--------|
| `tts.provider` | القيم المستضافة المنفذة: `openai`، `elevenlabs`، `minimax`، `gemini`، `xai`. |
| `tts.enabled` | عند `false`، يفشل TTS حتى لو كانت البيانات الاعتماد موجودة. |
| `stt.provider` | القيم المنفذة: `openai`، `groq`، `xai`، `local`. |
| `stt.enabled` | عند `false`، يفشل STT قبل آثار النسخ. |
| `voice.autoTts` | الإعداد الافتراضي العام لـ auto-TTS في البوابة. الافتراضي `false`. |
| `voice.autoTtsMaxCharsPerReply` | حد اختياري لكل رد يُفحص قبل التوليف. |
| `voice.autoTtsMaxCharsPerHourPerChat` | حد اختياري ساعيّ لكل منصة/محادثة. |

### بيانات الاعتماد

بيانات اعتماد الصوت هي متغيرات بيئة مباشرة فقط. لا توجد مجمعات بيانات اعتماد أو وسطاء بوابة أو بدائل.

ترتيب محلل بيانات اعتماد OpenAI الصوتي:

1. `config.openai.apiKeyEnv`
2. `VOICE_TOOLS_OPENAI_KEY`
3. `OPENAI_API_KEY`، فقط عندما يكون المتغير المُعد هو الافتراضي `VOICE_TOOLS_OPENAI_KEY`

متغير بيئة مخصص مفقود لا يعود إلى `OPENAI_API_KEY`. لا يتم تسجيل المفاتيح المحلولة أو إرجاعها في الأخطاء.

ملاحظات خاصة بالمزود:

- xAI TTS يستخدم `voiceId`، `language`، `sampleRate`، `bitRate`، `baseUrl`، `apiKeyEnv`، و `speed` الاختياري. لا يستخدم `tts.xai.model`.
- xAI STT يستخدم `baseUrl`/`base_url`، `apiKeyEnv`/`api_key_env`، `language` الاختياري، `format`، `diarize`، `keyterms`، `fillerWords`، وتلميحات raw-audio. لا يستخدم `stt.xai.model`.
- Gemini TTS يرسل `speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName`.

## CLI push-to-talk

وضع صوت CLI محلي للملف الشخصي:

```bash
estacoda voice mode on       # تفعيل إدخال push-to-talk
estacoda voice mode tts      # تفعيل push-to-talk مع تشغيل TTS محلي على أفضل وجه
estacoda voice mode off      # إلغاء التفعيل
estacoda voice mode status   # عرض الوضع الحالي
```

ملف الحالة:

```text
~/.estacoda/profiles/<profile-id>/cli-voice-mode.json
```

السلوك:

- تسجيل إدخال الميكروفون المحلي بصيغة WAV أحادية 16 كيلوهرتز.
- كتابة الصوت فقط في مساحة temp audio الخاصة بالملف الشخصي المحدد.
- النسخ عبر مزود STT المُعد.
- طباعة النص المكتوب.
- إدخال النص غير الفارغ كدورة مستخدم تالية في جلسة CLI الحالية.
- في وضع `tts`، التشغيل المحلي على أفضل وجه بعد توفر الرد.
- أوامر التشغيل المدعومة: `afplay`، `aplay`، `paplay`، `ffplay`.
- إذا لم يكن مشغل محلي متاحًا، يتم تخطي التشغيل بسلاسة.

كشف الميكروفون:

| البيئة | السلوك |
|--------|--------|
| جلسة SSH | يُبلغ بأن الميكروفون المحلي غير متاح؛ يقترح تسجيل محلي أو إدخال مسار. |
| Termux | يستخدم `termux-microphone-record` عند توفره. |
| WSL / PulseAudio | يفحص `pactl list sources`. |
| Linux / macOS أصلي | يستخدم أوامر تسجيل مدعومة (`sox`، `arec`، `rec`) عند توفرها. |

إضافات الصوت الأصلية لـ Node خارج النطاق.

## Auto-TTS في البوابة

تُحلل أوامر `/voice` في البوابة بواسطة `ChannelGateway`، وليس بواسطة المحولات. تُعرض المحولات methods القدرات حيثما لزم.

حالة الصوت لكل محادثة محلية للملف الشخصي:

```text
~/.estacoda/profiles/<profile-id>/gateway/voice-mode.json
```

الأوضاع:

| الوضع | المعنى |
|-------|--------|
| `off` | عدم auto-TTS ردود البوابة لهذه المحادثة. |
| `voice_only` | auto-TTS فقط للردود على الرسائل الصوتية الواردة التي أنتجت نصًا. |
| `all` | auto-TTS للردود النصية المؤهلة في هذه المحادثة. |

الأوامر:

| الأمر | السلوك |
|-------|--------|
| `/voice on` | ضبط المحادثة على `voice_only`. |
| `/voice voice` | بديل لـ `voice_only`. |
| `/voice all` | ضبط المحادثة على `all`. |
| `/voice tts` | بديل لـ `all`. |
| `/voice off` | ضبط المحادثة على `off`. |
| `/voice status` | الإبلاغ عن الوضع المحلول للمحادثة. |
| `/voice channel` | Discord فقط؛ ينضم إلى قناة الصوت الحالية للمتصل عند السماح. |
| `/voice leave` | Discord فقط؛ يغادر قناة صوت Discord النشطة. |

معالجة `/voice` في محادثات المجموعة تتبع مصادقة البوابة الحالية، ومنطق الذكر، وبوابة الاستجابة الحرة. المستخدمون غير المصرح لهم لا يمكنهم تغيير حالة الصوت لكل محادثة.

### حقن النص المكتوب

يستخدم STT الناجح بالضبط:

```text
[Voice message transcript]
{text}
```

بعد النسخ الناجح، تُزال مرفق الصوت الأصلي من سياق النموذج. فشل النسخ لا يحول ملف صوتي غير صالح إلى نص مرئي للنموذج.

كبت النصوص المكررة هو لكل `(platform, chatId)`:

- مخزن دائري لآخر 5 نصوص مُطابقة.
- نافذة مقارنة مدتها 12 ثانية.
- التطبيع يقلم، يحول لأحرف صغيرة، يضغط المسافات، ويحذف علامات الترقيم.
- التطابقات الدقيقة للتجزئة/النص تُسقط.
- نسبة التطابق القريب تُطبق فقط عندما يكون كلا النصين 16 حرفًا على الأقل.

### سلوك Auto-TTS

Auto-TTS في البوابة اختياري والنص أولًا:

- `voice.autoTts` افتراضيًا `false`.
- إذا لم يكن هناك تجاوز لكل محادثة، فإن `voice.autoTts: true` يعيّن `voice_only`، وليس `all`.
- توصيل النص يبقى أساسيًا.
- Auto-TTS هو أفضل جهد وفتح للفشل إلى النص.
- فشل المزود أو التوصيل يسجل تحذيرات آمنة ويترك النص سليمًا.

Auto-TTS يتخطى:

- الوضع `off`
- `voice_only` عندما كانت الرسالة الواردة ليست رسالة صوتية مكتوبة
- نص الرد فارغ أو مسافة فقط
- ردود الأخطاء، بما في ذلك `Error:`
- ردود أوامر البوابة مثل `/voice status`
- الدورات حيث أنتج العميل أداة TTS/صوت أو استدعى `voice.speak`
- الردود التي تحتوي بالفعل على مخرج صوتي
- تجاوز حدود المزود
- تجاوز `voice.autoTtsMaxCharsPerReply`
- تجاوز `voice.autoTtsMaxCharsPerHourPerChat`
- فشل جاهزية المزود

وسائط Auto-TTS مؤقتة. تُكتب الملفات في مساحة temp audio الخاصة بالملف الشخصي، تُسلَّم ككائنات Artifact مع `metadata.deliveryHint: "voice"` و `metadata.ephemeral: true`، وتُحذف في كتلة `finally` على أفضل وجه بعد نجاح أو فشل التوصيل.

نص `MEDIA:/path` الصادر عن النموذج بشكل عشوائي ليس إشارة auto-TTS.

## faster-whisper محلي STT

يعمل faster-whisper المحلي عبر عامل Python JSONL طويل الأجل مملوك من قبل بيئة التشغيل لكل runtime/profile. في v0.1.0، يعني `stt.provider: "local"` مسار faster-whisper المُدار افتراضياً.

المسارات المُدارة:

```text
~/.estacoda/python-env
~/.estacoda/cache/huggingface
```

`~/.estacoda/python-env` هي بيئة venv المُدارة. `~/.estacoda/cache/huggingface` هي ذاكرة تخزين النموذج الافتراضية. ذاكرة النموذج لا تعيش داخل venv.

شكل الإعدادات:

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

وضع الأوامر:

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

`stt.local.engine: "command"` هو الحاكم ولا يستخدم faster-whisper المُدار.

### إعداد البيئة المُدارة

```bash
estacoda voice setup --stt-provider local
```

عند عدم توفير Python مخصصة، يقوم الإعداد بما يلي:

1. يفحص `~/.estacoda/python-env`
2. ينشئه أو يصلحه عندما يكون مفقوداً أو تالفاً
3. يثبّت بالضبط `faster-whisper==1.2.1`
4. يتحقق من `import faster_whisper`
5. يكتب إعداد STT المحلي فقط بعد نجاح الإعداد

يعرض الإعداد رسائل تقدم منتقاة، وليس سجلات pip الخام. لا تثبت EstaCoda حزم مستخدم عشوائية في البيئة المُدارة. يُستخدم Python النظام فقط لإنشاء venv؛ لا تُعدّل EstaCoda Python النظام أو conda envs أو project venvs أو poetry envs أو uv envs. تُحصر ذاكرة pip المؤقتة أثناء الإعداد المُدار تحت حالة EstaCoda.

Python مخصص:

```bash
estacoda voice setup --stt-provider local --python-binary /path/to/python
```

هذا يتخطى فحص/إنشاء البيئة المُدارة ويخزن المسار المخصص. المشغل يملك بيئة Python هذه، بما في ذلك تثبيت `faster-whisper`.

إعداد TTS فقط يبقى TTS فقط:

```bash
estacoda voice setup --tts-provider openai
```

لا يغيّر إعداد STT ولا يلمس بيئة Python المُدارة.

### حدود مرحلة التشغيل

- يحل runtime مسار `stt.local.pythonBinary` المُعد أولاً، وإلا يستخدم مسار venv المُدار تحت `~/.estacoda/python-env`.
- يضبط runtime قيم `HF_HOME` / `TRANSFORMERS_CACHE` دائمة تحت `~/.estacoda/cache/huggingface`.
- لا ينشئ runtime البيئة المُدارة، ولا يثبّت الحزم، ولا يصلح Python في Phase 1.
- تثبيت الحزم عند أول استخدام عبر البوابة ليس جزءاً من Phase 1.
- قد يضيف أمر `voice doctor` لاحقاً فحص/إصلاح هذا المسار. وقد يُسمح لاحقاً بتثبيت أول استخدام عبر البوابة لـ STT المحلي المضبوط صراحةً، لكنه غير مُنفذ هنا.

سلوك تشغيلي:

- النموذج الافتراضي هو `base`. الإعدادات المدعومة: `tiny`، `small`، `medium`، `large-v1`، `large-v2`، `large-v3`.
- بروتوكول العامل يتضمن `protocolVersion: 1`.
- النماذج مخبأة حسب `(model, device, computeType)`.
- فشل CUDA/الجهاز يعيد المحاولة مرة واحدة بـ `device: "cpu"` و `computeType: "int8"` عبر نفس العامل.
- خروج العامل غير المتوقع يُعيد التشغيل مرة واحدة، ثم يُعلّم faster-whisper غير متاح للـ runtime الحالي.
- `runtime.dispose()` يُوقف العامل.
- المهلة الافتراضية 300 ثانية.
- عمق الطابور الافتراضي 1 ما لم يُعدل.
- تجاوز الطابور يفشل سريعًا.
- ترفض البوابة تنزيلات النموذج الأولى افتراضيًا قبل بدء العامل. اضبط `gatewayAllowModelDownload: true` فقط عندما يكون هذا التأثير الجانبي مقبولًا.
- يسمح faster-whisper المحلي غير المُطلق من البوابة بتنزيل النماذج افتراضياً.
- يُمرَّر `hfHome` إلى العامل عند ضبطه. وإلا تضبط EstaCoda `HF_HOME` افتراضياً إلى `~/.estacoda/cache/huggingface` وتحافظ على `TRANSFORMERS_CACHE` الموجود إذا ضبطته بيئة العملية مسبقاً.

ملف العامل مُعبَّأ في:

```text
workers/faster-whisper/faster-whisper-worker.py
```

## أنماط الفشل

| العرض | السبب المحتمل | الاستعادة |
|-------|---------------|-----------|
| `missing key` | متغير البيئة المُشار إليه من المزود غير موجود. | أضفه إلى `.env` الخاص بالملف الشخصي أو بيئة الخدمة. |
| `disabled` | `tts.enabled` أو `stt.enabled` هي `false`. | فعّل المزود في إعدادات الملف الشخصي إذا كان مقصودًا. |
| `not implemented` | مزود مؤجل مُحدد (مثل Mistral). | اختر مزودًا منفذًا. |
| `python package missing` | فشل استيراد faster-whisper. | شغّل `estacoda voice setup --stt-provider local`، أو أصلح `~/.estacoda/python-env`. عند استخدام `--python-binary`، أصلح بيئة Python المملوكة للمشغل. |
| `download required` | النموذج المحدد غير مخبأ والتنزيلات ممنوعة. | خزّن النموذج مسبقًا أو اسمح بالتنزيل صراحةً. |
| `queue full` | تجاوز عمق طابور faster-whisper. | انتظر، أو زِد عمق الطابور، أو قلل الطلبات المتزامنة. |
| `timeout` | تجاوز طلب STT المهلة. | تحقق من أداء النموذج/الجهاز وإعدادات المهلة. |
| المزود غير متاح | خطأ شبكة أو 5xx من المزود. | تحقق من الاتصال وحالة المزود. |
| تجاوز حد auto-TTS في البوابة | تجاوز الحد لكل رد أو ساعة. | انتظر النافذة الساعية أو ارفع الحد. |
| تبعية صوت مفقودة | ffmpeg مفقود لتطبيع التنسيق. | ثبّت ffmpeg؛ العملية تتدهور بسلاسة بدونه. |

## مواقع الحالة والملفات المؤقتة والتخزين المؤقت

| المسار | الغرض |
|--------|-------|
| `~/.estacoda/profiles/<profile-id>/temp/audio/` | تسجيلات CLI، ملفات auto-TTS المؤقتة، تحويلات Telegram، استقبال Discord. |
| `~/.estacoda/profiles/<profile-id>/audio-cache/` | ذاكرة التخزين المؤقت للصوت ومساحة عمل إخراج الأمر المحلي. |
| `~/.estacoda/profiles/<profile-id>/channel-media/` | مرفقات القنوات التي تم تنزيلها عبر البوابة. |
| `~/.estacoda/profiles/<profile-id>/gateway/logs/voice-stt-preprocess.jsonl` | أحداث تدقيق معالجة STT المسبقة في البوابة. |
| `~/.estacoda/python-env` | بيئة Python الافتراضية المُدارة لـ STT المحلي عبر faster-whisper. |
| `~/.estacoda/cache/huggingface` | ذاكرة تخزين النموذج الافتراضية لـ faster-whisper / Hugging Face. منفصلة عن venv. |
| `~/.estacoda/cache/pip` | ذاكرة pip المؤقتة أثناء تثبيت البيئة المُدارة. |
| `hfHome` أو متغير بيئة Hugging Face cache | تجاوز اختياري لذاكرة نماذج faster-whisper. |

لا تسجل أحداث التدقيق المسارات الخاصة الكاملة. تستخدم تجزئات مسارات مستقرة وبيانات وصفية آمنة للمرفقات.

## حدود الأمان

تجري معالجة STT المسبقة في البوابة قبل إرسال المزود، أو بدء العامل، أو ffmpeg، أو STT المستضاف، أو التنزيلات، أو الكتابات المؤقتة:

1. توحيد `attachment.localPath ?? attachment.path` ضمن جذور الوسائط/الصوت المسموح بها.
2. التحقق من نوع الملف والحجم باستخدام التحقق من صوت الإدخال.
3. فحص جاهزية STT و `stt.enabled !== false`.
4. رفض تنزيلات faster-whisper الأولى المُطلقة عبر البوابة ما لم يُسمح صراحةً.

الجذور المسموح بها هي وسائط القنوات المحلية للملف الشخصي، وذاكرة تخزين الصوت المؤقتة، وجذور temp audio المستخدمة في مسارات استقبال قنوات الصوت.

## صفحات ذات صلة

- [البوابة](./gateway.md) — بيئة تشغيل البوابة، وسياسات الانشغال، وإدارة الخدمة
- [القنوات](./channels.md) — إعداد القنوات والنضج
- [الأدوات](./tools.md) — توفر الأدوات وفئات المخاطر
