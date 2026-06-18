---
title: القنوات
description: إعداد القنوات، والنضج، والحدود التشغيلية لـ v0.1.0.
sidebar_position: 10
---

# القنوات

القنوات هي الأسطح التي يتفاعل من خلالها المستخدمون مع EstaCoda. CLI هو السطح المباشر. البوابة (gateway) تضيف قنوات بعيدة: Telegram و Discord و Email و WhatsApp. لكل قناة تصنيف نضج، ومجموعة قدرات مُنفذة، وقائمة ثغرات معروفة.

لا تفترض أن القناة مُثبتة للإصدار فقط لأنها موثقة. تحقق من تصنيف النضج.

---

## ملخص نضج القنوات

| القناة | النضج | Inbound | Outbound | Attachments | Threads | Approvals | Progress |
|---|---|---|---|---|---|---|---|
| **CLI** | `live-proven` | مباشر | مباشر | N/A | N/A | تفاعلي | N/A |
| **Telegram** | `live-proven` | polling | push | نعم | نعم | نعم | نعم |
| **Discord** | `present-not-live-proven` | websocket | push | لا | لا | نعم | لا |
| **Email** | `present-not-live-proven` | polling | push | لا | نعم | لا | لا |
| **WhatsApp** | `operational-with-external-risk` | websocket | push | نعم | محدود | لا | محدود |

**التعريفات:**

- `live-proven` — مُختبر في استخدام واقعي.
- `present-not-live-proven` — الكود موجود، والمحولات تبدأ، واختبارات الدخان المحلية تنجح. التحقق النهائي الحي يعتمد على نشر المشغل.
- `operational-with-external-risk` — المسار مُنفذ ومدعوم في الإعداد، لكنه يستخدم واجهة غير رسمية عبر bridge معزول. مخاطر الحساب خارج سيطرة EstaCoda.

---

## CLI

CLI هو السطح المباشر للتفاعل. إنه ليس قناة بوابة، لكنه السلوك المرجعي الذي تقاس ضده جميع قنوات البوابة.

- جلسات تفاعلية مع تنفيذ أدوات فوري
- مطالبات موافقة مُقدمة في الطرفية
- ربط/فصل الجلسات عبر أوامر `estacoda sessions`
- التحكم في البوابة عبر أوامر `estacoda gateway`
- تشخيصات المشغل عبر `estacoda gateway diagnose`

CLI لا يستخدم DeliveryRouter. يكتب مباشرة إلى stdout ويقرأ من stdin.

---

## Telegram

Telegram هي القناة البعيدة الحية المُثبتة لـ v0.1.0.

**القدرات:**

| القدرة | الحالة |
|---|---|
| الردود النصية | `live-proven` |
| تحليل المستندات | `live-proven` |
| فهم الصور | `live-proven` |
| توصيل الصور المُنشأة | `live-proven` |
| الموافقات المضمنة | `implemented` |
| استمرارية الجلسة | `implemented` |
| تحميل المرفقات | `implemented` |
| رموز الربط | `implemented` |
| رموز التسليم | `implemented` |
| ضغط التقدم | `implemented` |
| بث النص التجريبي | `default-on when Telegram is configured` |

**السلوك:**

- رسالة تقدم واحدة متطورة لكل دور نشط
- أزرار الموافقة المضمنة تُعيّن إلى `/approve` و `/deny`
- الردود النهائية مُنسقة بـ HTML آمن لـ Telegram
- يكون البث مفعلاً افتراضيًا لقنوات Telegram المُعدّة ويحرر رسائل Telegram تدريجيًا أثناء الدور؛ يبقى `response.text` النهائي هو المرجع
- تسميات النشاط مُترجمة (`en`، `ar`)
- جلسات المجموعات افتراضيًا لكل مستخدم
- جلسات الخيوط مشتركة افتراضيًا
- ربط المحادثة النشطة بالجلسة يستمر عبر إعادة تشغيل البوابة

**الإعداد:**

```bash
estacoda telegram configure --bot-token-env ESTACODA_TELEGRAM_BOT_TOKEN --allow-user 123456789
estacoda channels enable telegram
estacoda gateway install
estacoda gateway start
```

الإعداد الموجّه العادي يطلب:

- رمز API لبوت Telegram.
- معرفات مستخدمي Telegram المسموح لهم.
- معرفات محادثات مجموعات Telegram المسموح لها.

الإعداد الموجّه العادي لا يطلب اسم متغير البيئة الخاص برمز البوت. يخزن الرمز تحت `ESTACODA_TELEGRAM_BOT_TOKEN`، وتشير الإعدادات إليه عبر `botTokenEnv: "ESTACODA_TELEGRAM_BOT_TOKEN"`. يجب ألا يظهر رمز البوت في مراجعة الإعداد أو مخرجات الإعداد.

استخدم `@BotFather` و`/newbot` لإنشاء بوت ونسخ رمز API. استخدم `@userinfobot` و`/start` للحصول على معرفات مستخدمي Telegram. لمحادثات المجموعات، أضف بوت EstaCoda وأحد البوتين `@getidsbot` أو `@chatIDrobot` إلى المجموعة. يرد بوت المعرفات بمعرف محادثة المجموعة؛ وفي المجموعات يكون هذا عادةً رقمًا سالبًا طويلًا.

**متطلبات الجاهزية:**

- `enabled: true`
- `botTokenEnv` مُعيّن
- متغير البيئة المُشار إليه موجود

### بث Telegram (تجريبي)

بث Telegram خيار لتجربة التوصيل فقط. لا يغير حقيقة الجلسة، أو الذاكرة، أو تنفيذ الأدوات، أو الموافقات، أو المنتجات، أو حالة سير العمل. ما زال runtime ينتج `response.text` نهائيًا، وهذا النص النهائي هو المرجع.

يكون بث Telegram مفعلاً افتراضيًا لقنوات Telegram المُعدّة. عندما تكون `channels.telegram.streaming.enabled` بقيمة `true`، تُستخدم provider tokens لتحرير رسائل Telegram تدريجيًا. حدود الأدوات تغلق رسالة البث الحالية. provider tokens اللاحقة تبدأ رسالة Telegram جديدة تحت رسالة تقدم الأداة. الرسائل المبثوثة التي أُغلقت لا تُحرر لاحقًا لتصبح الرد النهائي. لتعطيله، اضبط `channels.telegram.streaming.enabled` على `false`.

الترتيب المرئي هو:

```text
streamed text -> tool progress -> streamed continuation -> final edit
```

اضبطه تحت `channels.telegram.streaming`:

```json
{
  "channels": {
    "telegram": {
      "streaming": {
        "enabled": true,
        "editIntervalMs": 750,
        "minInitialChars": 24,
        "cursor": "▌",
        "maxFloodStrikes": 2,
        "cleanupFailedAttempts": true,
        "transport": "auto",
        "freshFinalAfterSeconds": 0
      }
    }
  }
}
```

| الإعداد | الافتراضي | السلوك |
|---|---:|---|
| `channels.telegram.streaming.enabled` | `true` | يفعّل بث Telegram للقنوات المُعدّة. اضبطه على `false` لتعطيله. |
| `channels.telegram.streaming.editIntervalMs` | `750` | يجمع تعديلات Telegram بعد أول رسالة مبثوثة. |
| `channels.telegram.streaming.minInitialChars` | `24` | حد الأحرف المرئية بعد التصفية قبل إرسال أول رسالة بث. |
| `channels.telegram.streaming.cursor` | `"▌"` | مؤشر مؤقت يُلحق بالرسائل الجزئية أثناء البث. |
| `channels.telegram.streaming.maxFloodStrikes` | `2` | حد تدهور flood-control لمقبض البث النشط. |
| `channels.telegram.streaming.cleanupFailedAttempts` | `true` | يحذف أو يحيد الرسائل المبثوثة المؤقتة بعد فشل المزود أو fallback. |
| `channels.telegram.streaming.transport` | `"auto"` | وضع التوصيل. يختار `"auto"` معاينات المسودات للرسائل المباشرة عند دعمها، وإلا يستخدم edit streaming. يستخدم `"edit"` تعديلات الرسائل العادية. يستخدم `"draft"` معاينات مسودات Telegram في الرسائل المباشرة فقط عندما يدعمها Bot API. |
| `channels.telegram.streaming.freshFinalAfterSeconds` | `0` | القيمة `0` تعطل fresh-final delivery. القيمة الموجبة ترسل الرد المكتمل كرسالة جديدة بعد ظهور المعاينة لذلك العدد من الثواني، ثم تحذف المعاينة best-effort. |

أوضاع التوصيل:

- `auto` هو الافتراضي. يحاول استخدام معاينات المسودات للرسائل المباشرة عند دعمها ويستخدم edit streaming في غير ذلك.
- `edit` يبث عبر إرسال رسالة Telegram ثم تعديلها عند وصول نص إضافي.
- `draft` يستخدم معاينات مسودات Telegram للرسائل المباشرة فقط عندما يدعم Bot API عمليات المسودات. إذا لم يتوفر دعم المسودات، يرجع التوصيل إلى edit streaming.
- rich message delivery انتهازي. يعتمد على دعم Telegram وBot API ويرجع إلى تنسيق Telegram العادي عندما يكون غير مدعوم، أو طويلًا جدًا، أو ملتبسًا.

الحدود التشغيلية:

- البث يعمل لتوصيل Telegram فقط.
- يعمل بث Telegram قبل توجيه النص النهائي العادي. إذا لم يتمكن البث من توصيل الرد المكتمل، يرجع `ChannelGateway` إلى توصيل `DeliveryRouter` العادي.
- يتطلب البث إشارة إلغاء دور من البوابة.
- تستخدم تعديلات البث الجزئية HTML escaping خفيفًا، وليس تنسيق Telegram النهائي.
- التوصيل النهائي ما زال يستخدم تنسيق Telegram وتقسيمه العاديين إلا إذا نجح rich delivery الانتهازي.
- flood control أو الحمولات الجزئية الكبيرة تفرض fallback للنص النهائي لذلك الدور فقط. لا تُعطل أدوار بث Telegram المستقبلية عالميًا.

أنماط الفشل والرجوع:

- تنظيف provider fallback أو provider failure يحذف الرسالة المبثوثة المؤقتة الحالية عندما يمكن ذلك، أو يحيدها إذا فشل الحذف. حذف المعاينة بعد fresh-final delivery هو أيضًا best-effort.
- حدود الموافقة والمنتجات تفرض fallback للنص النهائي العادي لأن ترتيب التوصيل يصبح ملتبسًا.
- الإلغاء يوقف مقبض البث ويزيل المؤشر عندما يمكن ذلك. فشل التنظيف لا يغير نتيجة الإلغاء.
- لا يُتخطى النص النهائي المكرر إلا عندما ينجح التوصيل النهائي عبر البث ولا توجد حدود موافقة أو منتجات.
- لتعطيل البث، اضبط `channels.telegram.streaming.enabled` على `false` وأعد تشغيل أو إعادة تحميل عملية البوابة لذلك profile.

---

## Discord

Discord موجود في الكود لكنه غير مُثبت حيًا لـ v0.1.0.

**القدرات:**

| القدرة | الحالة |
|---|---|
| الردود النصية | `present-not-live-proven` |
| دعم الرسائل المباشرة | `present-not-live-proven` |
| دعم قنوات الخادم | `present-not-live-proven` |
| دعم الخيوط | `present-not-live-proven` |
| تحميل المرفقات | `present-not-live-proven` |
| قوائم السماح (مستخدمين/خوادم/قنوات) | `present-not-live-proven` |
| أزرار الموافقة المضمنة | `implemented` |

**الثغرات:**

- مرفقات Discord والخيوط وتدفق التقدم غير مدعومة في سجل القدرات.
- تسجيل أوامر الشرطة المائلة ليس جزءًا من مسار الإعداد الرسمي الحالي.
- اختبار الدخان الحي للاعتمادات اختياري ويدوي.

**القنوات الصوتية:** دعم قنوات Discord الصوتية الاختياري موجود فقط عندما يكون `channels.discord.voiceChannel.enabled` صحيحًا ويكون مكدس Discord الصوتي الاختياري مثبتًا. الحزم أو الصلاحيات المفقودة تعيد أخطاء إعداد قبل الانضمام.

**الإعداد:**

```bash
estacoda discord configure --bot-token-env ESTACODA_DISCORD_TOKEN --allow-user 123456789
estacoda channels enable discord
estacoda gateway install
estacoda gateway start
```

**متطلبات الجاهزية:**

- `enabled: true`
- `botTokenEnv` مُعيّن

---

## Email

Email موجود في الكود لكنه غير مُثبت حيًا لـ v0.1.0.

**القدرات:**

| القدرة | الحالة |
|---|---|
| استقبال IMAP | `present-not-live-proven` |
| إرسال SMTP | `present-not-live-proven` |
| الرد في الخيط | `present-not-live-proven` |
| استيعاب المرفقات | `present-not-live-proven` |
| تصفية المرسلين المسموح بهم | `present-not-live-proven` |
| العنوان الرئيسي | `present-not-live-proven` |

**الثغرات:**

- مرفقات Email غير مدعومة في سجل القدرات.
- لا احتكاك موافقة خاص بـ Email؛ يستخدم سياسة الأمان العامة.
- اختبار الدخان الحي للاعتمادات اختياري ويدوي.

**السلوك:**

- يستطلع صندوق بريد IMAP بفاصل زمني مُعيّن
- يربط خيوط Email بالجلسات عبر ترويسات `In-Reply-To` / `References`
- سطور الموضوع الجديدة تنشئ جلسات جديدة
- الردود تُرسل عبر SMTP مع ترويسات الخيوط
- `allowAllUsers: true` يتجاوز تصفية المرسلين

**الإعداد:**

```bash
estacoda email configure \
  --imap-host imap.example.com \
  --smtp-host smtp.example.com \
  --username bot@example.com \
  --password-env EMAIL_PASSWORD \
  --home-address operator@example.com
```

**متطلبات الجاهزية:**

- `enabled: true`
- `imapHost` و `smtpHost` و `username` و `passwordEnv` و `ownAddress` جميعها مُعيّنة

---

## WhatsApp

WhatsApp محصور بـ `channels.whatsapp.experimental: true` ويعمل عبر bridge معزول تحت `scripts/whatsapp-bridge/`.

**القدرات:**

| القدرة | الحالة |
|---|---|
| تسجيل دخول Baileys كجهاز مرتبط | `implemented` |
| تسجيل دخول برمز QR | `implemented` |
| توصيل نصي مباشر | `implemented` |
| ضبط سياسة المجموعات | `implemented` |
| تحميل/رفع الوسائط | `implemented` |
| تقسيم الرسائل | `implemented` |
| ردود نهائية فقط | `implemented` |
| توصيل voice bubble | يتطلب `ffmpeg` اختيارياً |

**هام:** يستخدم WhatsApp الحزمة `@whiskeysockets/baileys` عبر حزمة npm المعزولة `scripts/whatsapp-bridge/`. Baileys واجهة غير رسمية؛ قد تُعلّق Meta حسابات WhatsApp التي تستخدم مكتبات غير رسمية. استخدمها على مسؤوليتك. لا يثبت runtime الجذري Baileys أو معالجة `@hapi/boom` الخاصة بـ WhatsApp ولا يستوردهما.

**الثغرات:**

- لا موافقات.
- لا توجد رسائل تقدم مرئية؛ يحصل WhatsApp على الرد النهائي فقط، مع حضور typing بأفضل جهد أثناء العمل.
- اختبار الدخان الحي للاعتمادات اختياري ويدوي.

**الإعداد:**

```bash
estacoda whatsapp
```

يمكن تشغيل إعداد ⁨WhatsApp⁩ من القدرات الاختيارية في onboarding الأول، أو من ⁨Setup Editor⁩، أو من الأمر المستقل ⁨estacoda whatsapp⁩. تستخدم الأسطح الثلاثة تدفق إعداد ⁨QR⁩ نفسه: يسأل قبل إصلاح اعتمادات الجسر، ويعرض رمز ⁨QR⁩ في الطرفية، ولا يكتب إعدادات profile أو حالة الجلسة إلا بعد نجاح الاقتران. رفض الاعتمادات، أو فشلها، أو انتهاء مهلة ⁨QR⁩، أو فشل الاقتران يسجل ⁨WhatsApp⁩ كتخطي/إعداد غير مكتمل ويترك إعداد ⁨WhatsApp⁩ دون تغيير. تنتهي مهلة ⁨QR⁩ بعد 120 ثانية برسالة `Pairing timed out - run estacoda whatsapp to try again.` ولا توجد واجهة لإعداد pairing code لجهاز ⁨WhatsApp⁩.

إذا لم تُدخل مرسلين مسموحين، يكتب الإعداد `dmPolicy: "pairing"`. هذه حالة انتظار لتفويض المستخدم الآمن وليست وصولاً مفتوحاً. رموز تفويض مستخدمي WhatsApp أحادية الاستخدام، تنتهي بعد 10 دقائق، ولا تُخزن إلا كـ salted SHA-256 hashes. يبقى ربط Telegram مدعوماً بالإعدادات كما هو حالياً ودون تغيير.

الوضع `mode: "bot"` يتجاهل رسائل `fromMe`. الوضع `mode: "self-chat"` يقبل إدخال self-chat المقصود، ويضيف `replyPrefix` إلى ردود البوت، ويمنع الأصداء. السياسة `groupPolicy` افتراضياً `"disabled"`؛ وتتطلب `"allowlist"` قيمة `allowedGroups`، أما `"open"` فيجب ضبطها صراحة.

رسائل ⁨WhatsApp⁩ النصية العادية والسريعة من المحادثة/المرسل نفسه تُجمع في دورة runtime واحدة بعد نافذة هدوء قصيرة. الأوامر، ورموز التفويض/الاقتران، والموافقات، والرفض، و`/stop`، و`/status`، والرسائل التي تحتوي على وسائط أو مرفقات تتجاوز هذا التجميع وتُنفذ فوراً.

يدعم ⁨WhatsApp⁩ الوارد الصور، والفيديو، والصوت العادي، والرسائل الصوتية، والمستندات. ينزّل جسر ⁨WhatsApp⁩ هذه الوسائط إلى cache وسائط خاص بـ profile، ثم يمررها إلى runtime كمرفقات محلية مُتحقق منها. هذا cache يعيش داخل حالة profile وليس داخل مساحة العمل. التنزيلات الفاشلة أو الأكبر من الحد تظهر كبيانات فشل للمرفق بدلاً من إسقاط الرسالة النصية كاملة.

تتحقق main runtime من الوسائط الصادرة قبل أن يستقبل الجسر مساراً محلياً. الصوت غير المتوافق مع voice hint يحتاج `ffmpeg` للتحويل إلى WhatsApp voice/PTT؛ وإذا لم يكن التحويل متاحاً، ترسل EstaCoda صوتاً عادياً مع توضيح fallback.

**متطلبات الجاهزية:**

- `enabled: true`
- `experimental: true`
- حالة مصادقة مربوطة عبر QR
- تحقق `dmPolicy`/`groupPolicy`، بما في ذلك `allowedUsers` أو `allowedGroups` عند الحاجة

---

## سياسة الانشغال

كل قناة تُهيئ كيف تُعالج الرسائل الواردة عندما يعالج الوكيل بالفعل دورًا:

- `reject` — يرد برسالة انشغال (افتراضي)
- `queue` — يخزّن الرسائل، يعالج تسلسليًا بعد الدور الحالي
- `interrupt` — يلغي الدور الحالي ويبدأ الجديد فورًا

عمق الطابور مُقيّد إلى `[1, 10]`، افتراضي `3`. يُهيّأ بشكل مستقل لكل قناة.

---

## الجلسات عبر الأسطح

الجلسات منفصلة افتراضيًا. جلسة CLI وجلسة Telegram لنفس المستخدم لا تشارك السياق تلقائيًا.

الربط/الفصل الصريح مطلوب:

```bash
# من طرف CLI
estacoda sessions attach telegram <chat-id> <session-id>
estacoda sessions detach telegram <chat-id>
```

```text
# من طرف Telegram
/attach <handoff-code>
/detach
```

مؤشرات الأسطح تُخزّن في حالة البوابة الخاصة بالملف الشخصي المرتبط.

---

## أوامر البوابة

جميع قنوات البوابة تدعم مجموعة مشتركة من أوامر التحكم:

| الأمر | الغرض |
|---|---|
| `/help` | عرض الأوامر المتاحة |
| `/status` | عرض حالة الجلسة والقناة الحالية |
| `/sessions` | عرض الجلسات الأخيرة |
| `/switch <session-id>` | التبديل إلى جلسة مختلفة |
| `/attach <code>` | الربط بجلسة CLI عبر رمز تسليم |
| `/detach` | فصل وإنشاء جلسة جديدة |
| `/new` | إنشاء جلسة جديدة |
| `/reset` | إعادة تعيين الجلسة الحالية |
| `/model` | عرض النماذج الجاهزة |
| `/model <provider>/<model>` | تعيين تجاوز نموذج محدود بالمحادثة |
| `/model clear` | إلغاء التجاوز المحدود بالمحادثة |
| `/approve [once|session|always]` | حل الموافقة المعلقة |
| `/deny` | رفض الموافقة المعلقة |
| `/approvals` | عرض الموافقات المعلقة |
| `/revoke <id>` | إلغاء موافقة دائمة |
| `/stop` | إلغاء الدور النشط أو مسح الطابور |
| `/voice on|all|off|status` | التحكم في وضع الرد الصوتي |
| `/cron` | عرض مهام cron |
| `/diagnostics` | تشغيل تشخيصات البوابة |

أوامر التحكم في النموذج تتجاوز طوابير الجلسات المشغولة حتى يستطيع المشغل تغيير حالة النموذج أثناء محادثة نشطة.

إذا كان الدور النشط يحتوي على subagents قيد التشغيل، تُصفّ الرسائل العادية في الطابور تحت سياسة `interrupt` بدل إلغاء دور الأب. `/stop` ما زال يلغي دور الأب النشط وعمل الأطفال. `/approve` و`/deny` و`/status` وأوامر النموذج/التحكم تحافظ على سلوك تجاوز أوامر التحكم. يمكن أن يعرض `/status` ملخصات active-subagent محدودة دون كشف prompts، أو transcripts، أو raw provider token streams، أو credentials، أو tool arguments.

---

## DeliveryRouter

`DeliveryRouter` هو مسار التوصيل المُسوّى لجميع القنوات. يتولى:

- التوصيل متعدد الأهداف (رسالة واحدة إلى قنوات متعددة)
- اقتطاع النص مع علامة حذف عند تطبيق حدود القناة
- استمرارية الأخطاء (أخطاء التوصيل مُسجلة في حالة البوابة)
- توصيل المنتجات (صور، صوت، مستندات)
- توجيه المنتجات الصوتية المُلمحة

أهداف التوصيل تستخدم الصياغة:

```text
telegram:<chatId>
discord:<channelId>
whatsapp:<number>
email:<address>
local
origin
silent
```

---

## أوضاع الفشل

**فشل بدء محول القناة:** تحقق من `estacoda gateway diagnose`. الأمر التشخيصي يبلغ الجاهزية لكل محول، لا حيوية العملية الخلفية.

**بوت Telegram لا يستجيب:** تحقق من `botTokenEnv` مُعيّن، المتغير موجود في `.env` الخاص بالملف الشخصي، و `estacoda channels enable telegram` مُشغّل.

**بوت Discord لا يتصل:** تحقق من الرمز، والنوايا، وصلاحيات الخادم. راجع سجلات البوابة لأخطاء الاتصال.

**Email لا يستطلع:** تحقق من مضيف IMAP ومضيف SMTP واسم المستخدم وكلمة المرور. تأكد من تصدير متغير البيئة.

**رمز QR لـ WhatsApp لا يُمسح:** شغّل `estacoda whatsapp` مرة أخرى. يظهر QR code في الطرفية فقط وتنتهي مهلته بعد 120 ثانية. إذا أبلغت التشخيصات عن نقص اعتمادات الجسر، وافق على خطوة الإصلاح الصريحة أو شغّل `npm ci` داخل `scripts/whatsapp-bridge/`؛ لا تثبت Baileys في حزمة الجذر.

---

## مرتبطات

- [البوابة](./gateway.md) — إعداد البوابة وإدارة الخدمة
- [الأمان والموافقات](./security-and-approvals.md) — سلوك الموافقة
- [مرجع المزودين](../reference/provider-reference.md) — جدول نضج المزودين
