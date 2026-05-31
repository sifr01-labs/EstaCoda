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
| **WhatsApp** | `experimental` | websocket | push | لا | لا | لا | لا |

**التعريفات:**

- `live-proven` — مُختبر في استخدام واقعي.
- `present-not-live-proven` — الكود موجود، والمحولات تبدأ، واختبارات الدخان المحلية تنجح. الاختبار النهائي الشامل لم يكتمل لـ v0.1.0.
- `experimental` — محصور بـ `experimental: true`. واجهة برمجة غير رسمية. مخاطر على الحساب.

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

**السلوك:**

- رسالة تقدم واحدة متطورة لكل دور نشط
- أزرار الموافقة المضمنة تُعيّن إلى `/approve` و `/deny`
- الردود النهائية مُنسقة بـ HTML آمن لـ Telegram
- تسميات النشاط مُترجمة (`en`، `ar`)
- جلسات المجموعات افتراضيًا لكل مستخدم
- جلسات الخيوط مشتركة افتراضيًا
- ربط المحادثة النشطة بالجلسة يستمر عبر إعادة تشغيل البوابة

**الإعداد:**

```bash
estacoda telegram configure --bot-token-env ESTACODA_TELEGRAM_TOKEN --allow-user 123456789
estacoda channels enable telegram
estacoda gateway install
estacoda gateway start
```

**متطلبات الجاهزية:**

- `enabled: true`
- `botTokenEnv` مُعيّن
- متغير البيئة المُشار إليه موجود

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
- أوامر الشرطة المائلة مؤجلة بعد v0.1.0.
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

## WhatsApp (تجريبي)

WhatsApp تجريبي ومحصور بـ `channels.whatsapp.experimental: true`.

**القدرات:**

| القدرة | الحالة |
|---|---|
| تسجيل دخول Baileys كجهاز مرتبط | `experimental` |
| تسجيل دخول برمز QR | `experimental` |
| تسجيل دخول برمز ربط | `experimental` |
| توصيل نصي مباشر | `experimental` |
| تحميل/رفع الوسائط | `experimental` |
| تقسيم الرسائل | `experimental` |

**هام:** المحول يستخدم `@whiskeysockets/baileys`، وهي واجهة برمجة غير رسمية. Meta قد تُعلّق حسابات WhatsApp التي تستخدم مكتبات غير رسمية. استخدمها على مسؤوليتك.

**الثغرات:**

- مباشر فقط. لا دعم للمجموعات.
- لا موافقات.
- لا توصيل تقدم.
- اختبار الدخان الحي للاعتمادات اختياري ويدوي.

**الإعداد:**

```bash
estacoda whatsapp configure --allowed-user 1234567890
```

ثم عيّن `channels.whatsapp.experimental: true` في الإعداد.

**متطلبات الجاهزية:**

- `enabled: true`
- `experimental: true`

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

**رمز QR لـ WhatsApp لا يُمسح:** توفر Baileys يُتحقق في وقت التشغيل. إذا فشل المحول بسلاسة، ثبّت `@whiskeysockets/baileys` في بيئة المشغل.

---

## مرتبطات

- [البوابة](./gateway.md) — إعداد البوابة وإدارة الخدمة
- [الأمان والموافقات](./security-and-approvals.md) — سلوك الموافقة
- [مرجع المزودين](../reference/provider-reference.md) — جدول نضج المزودين
