---
title: أوامر CLI
description: مرجع تشغيلي لسطح أوامر estacoda CLI.
sidebar_position: 1
---

# أوامر CLI

EstaCoda نظام وكيل سطر أوامر. كل سطح يُعدّل الحالة أو يفحص الإعدادات أو يغيّر سلوك التشغيل يُصل إليه من الطرفية. توثق هذه الصفحة عائلات الأوامر المُطبّقة. لا توثق سلوكاً مخططاً أو معلّقاً.

## الخيار العام

```bash
estacoda --profile <id> <command>
estacoda -p <id> <command>
```

يختار `--profile` / `-p` ملف تعريف للأمر الحالي فقط. لا يغيّر `active-profile.json`. فقط `estacoda profile use <name>` يغيّر الملف التعريف النشط. العلامة صالحة قبل أي أمر.

---

## الإعداد

### `estacoda setup`

يفتح محرّر الإعدادات.

```bash
estacoda setup                          # إعداد تفاعلي/إصلاح
estacoda setup --interactive            # الوضع التفاعلي الصريح
estacoda setup --advanced               # خيارات متقدمة في الوضع التفاعلي
estacoda setup --provider <p> --model <m> --api-key-env <env>
```

**الحالة المُعدّلة:**
- `~/.estacoda/profiles/<id>/config.json`
- `~/.estacoda/profiles/<id>/.env` (مراجع بيانات الاعتماد، لا القيم الخام)
- `~/.estacoda/profiles/<id>/trust.json`

**حدود الملف التعريف:** يستخدم الملف التعريف النشط، أو الملف المختار عبر `--profile`.

**السلوك:** يوجّه عبر قرار إعداد محدد بناءً على الحالة الحالية (first-run، configured-ready، configured-degraded، partial-provider، missing-credential، broken-config، untrusted-workspace، state-not-writable). حالة configured-ready تفتح Setup Editor وفيه تعديل المسار الرئيسي للنموذج، وتعديل مسار الاحتياطي، وتعديل المسار الإضافي، وإعداد القدرات الاختيارية، وتعديل وضع الأمان، وتعديل `Agent Evolution`، و`EstaCoda Doctor`، والخروج. Doctor هو إجراء الصحة للقراءة فقط للإصلاحات المطلوبة وحالة مسارات المزوّدين. إلغاء المراجعة لا ينتج تعديلاً. البيانات السرية الخام لا تُعرض أبدًا في بيانات المراجعة.

**أنماط الفشل:**
- الإعداد التالف يحظر التعديلات العادية حتى يصبح التحليل آمناً.
- state-not-writable يحظر الكتابات حتى تصحح الأذونات.
- بيانات الاعتماد المفقودة تُوجّه لإصلاح بيانات الاعتماد دون جمع قيم خام مباشرة.

### `estacoda init`

يبني هيكل أدلة الحالة والإعداد الافتراضي.

```bash
estacoda init                           # إنشاء الهيكل الأساسي للحالة
estacoda init --home <dir>              # دليل حالة مخصص
estacoda init --yes                     # غير تفاعلي؛ يستخدم الافتراضيات
```

**الحالة المُعدّلة:** `~/.estacoda/`، الهيكل الأساسي للملف التعريف الافتراضي، `active-profile.json`.

**أنماط الفشل:** فشل إنشاء الدليل يُظهر رمز خروج 1 مع المسار الفاشل.

### `estacoda verify`

ينفذ تحقيقاً للقراءة فقط من جاهزية الإعداد.

```bash
estacoda verify
```

الفحوصات:
- صلاحية بناء جملة إعداد المزود
- جاهزية بيانات الاعتماد ونقطة النهاية للمزود
- جاهزية نسخ الحالة الاحتياطي
- صلاحية سجل الحزم

**رمز الخروج:** 0 إذا جاهز، 1 إذا توجد تحذيرات.

---

## بيئات Python

```bash
estacoda python-env list
estacoda python-env status <id>
estacoda python-env setup <id>
estacoda python-env verify <id>
estacoda python-env upgrade <id>
estacoda python-env reset <id>
```

تدير هذه الأوامر بيئات Python التي يملكها وقت التشغيل للقدرات التي تحتاج إلى حزم Python مثبتة بإصدارات محددة.

| الأمر | السلوك |
|---|---|
| `python-env list` | يعرض قدرات Python المسجلة وحالة بيئة كل قدرة. |
| `python-env status <id>` | يعرض مسار البيئة، ومسار Python عند توفره، وحالة ملف البيان، والمجموعات المثبتة، وتلميح الإصلاح. |
| `python-env setup <id>` | ينشئ البيئة، ويثبت الحزم المحددة في مواصفة وقت التشغيل المسجلة، ويتحقق من الاستيرادات، ويكتب ملف البيان. |
| `python-env verify <id>` | يتحقق من الاستيرادات المضبوطة فقط. لا يثبت الحزم. |
| `python-env upgrade <id>` | يحدث بيئة مثبتة عندما تتغير المواصفة المسجلة، ثم يتحقق منها. |
| `python-env reset <id>` | يحذف البيئة المدارة لهذه القدرة بعد التأكيد. |

يتطلب `setup` و`upgrade` موافقة محلية صريحة قبل تثبيت الحزم عبر الشبكة. أمر `reset` تدميري.

يمكن اختيار المجموعات الاختيارية بأعلام المجموعات عندما تعرفها القدرة:

```bash
estacoda python-env setup <id> --group <name>
estacoda python-env setup <id> --groups <a,b>
estacoda python-env status <id> --group <name>
```

لا تثبت المهارات الحزم أثناء التنفيذ العادي. إذا كانت بيئة قدرة مفقودة، يعرض النظام أمر إصلاح للمشغل المحلي.

---

## النموذج والمزود

### `estacoda model`

تدير عائلة أوامر النموذج أي نموذج لغوي يستخدمه EstaCoda، وكيف تُحمّل بيانات الاعتماد، وما يحدث عند فشل المسار الأساسي.

```bash
estacoda model                          # منتقي تفاعلي أو نظرة عامة
estacoda model status                   # حالة المسار الأساسي والاحتياطي والمساعد
estacoda model list                     # النماذج القابلة للتهيئة في الكتالوج
estacoda model list --live              # يتضمن تحقيقات الشبكة الحية
estacoda model search <query>           # البحث في الكتالوج بالاسم أو المزود
estacoda model providers                # قائمة المزودين المعروفين
estacoda model refresh                  # تحديث كتالوج المزود من الشبكة
estacoda model diagnose                 # تشخيص كامل مع حالة التنفيذ
estacoda model auxiliary status         # جاهزية المسارات المساعدة
estacoda model fallback                 # إدارة سلسلة الاحتياطي
estacoda model setup local [--base-url <url>] [--model <id>] [--api-key <key>] [--context-window <n>]
                                        # تهيئة نقطة نهاية محلية / مخصصة متوافقة مع OpenAI
estacoda model setup custom --base-url <url> [--provider-id <id>] [--model <id>] [--api-key-env <env>] [--context-window <n>]
                                        # تهيئة مزود مخصص باسم منفصل ومتوافق مع OpenAI
estacoda model setup codex              # إعداد OAuth device-code لـ Codex
```

**الحالة المُعدّلة:**
- `~/.estacoda/profiles/<id>/config.json` (المسار الأساسي، سلسلة الاحتياطي، تسجيل المزود)
- `~/.estacoda/profiles/<id>/.env` (قيم مفاتيح API الاختيارية بعد تطبيق مُراجع)
- `~/.estacoda/profiles/<id>/auth.json` (رموز OAuth لـ Codex في الملف الشخصي المحدد)

**حدود الملف التعريف:** كل إعدادات النموذج مرتبطة بالملف التعريف.

**السلوك:**
- `estacoda model` الصافي يفتح منتقي تفاعلي في وضع الإعداد عند توفر TTY؛ وإلا يطبع نظرة عامة.
- `model setup local` يهيئ المزود المدمج `local` لـ Ollama أو LM Studio أو llama.cpp أو vLLM أو نقطة نهاية محلية/مخصصة أخرى متوافقة مع OpenAI. القيمة الافتراضية هي `http://localhost:11434/v1`، ولا يحتاج مفتاح API افتراضيًا، ويخزن `--api-key` الاختياري باسم `OPENAI_COMPATIBLE_API_KEY`.
- `model setup custom` يهيئ معرف مزود OpenAI-compatible منفصلًا مع `baseUrl` صريح؛ استخدمه عندما تحتاج هوية مزود مستقلة عن المزود المدمج `local`.
- `model setup codex` يُ authenticate عبر تدفق رمز الجهاز OAuth، ويخزن الرموز في `auth.json` داخل الملف الشخصي المحدد، ويُهيئ مسار `codex/gpt-5.5` مع طريقة المصادقة `oauth_device_pkce` ونمط API `openai_responses`.
- يمكن لأمر `estacoda model` الصافي أيضًا إعداد Codex عندما يكون خيار OpenAI المتداخل مفعّلًا: اختر `OpenAI`، ثم `Codex`. خيار `OpenAI Models` هو مسار مفتاح API لـ OpenAI؛ وخيار `Codex` هو مسار OAuth.
- يمكن لتعديلات المسار الأساسي والاحتياطي في محرّر الإعدادات إعداد Codex عبر تطبيق مُراجع. رموز OAuth لا تُكتب إلا بعد موافقة المراجعة؛ إلغاء المراجعة بعد OAuth لا يحفظ الرموز. لا يضيف onboarding الأولي ولا مسارات النماذج المساعدة إعداد Codex عبر OAuth في هذا المرور.
- `model fallback` تدير سلسلة الاحتياطي المرتبة وهي متوفرة أيضًا عبر محرّر الإعدادات (`edit-fallback-model-route`). `estacoda model set` مرفوض كأمر مهمل.

**أنماط الفشل:**
- إدخال نموذج غير معروف يرجع رمز خروج 1 مع اقتراحات للمرشحين.
- الإدخال الغامض يسرد المرشحين المتطابقين.
- بيانات الاعتماد المطلوبة دون وجود prompt متاح يرجع تعليمات إصلاح.
- فشل حفظ الإعداد يُبلّغ المسار والخطأ.

---

## إدارة الملفات التعريفية

تفصل الملفات التعريفية الإعدادات والأسرار والذاكرة الهوية والمهارات وحالة cron وحالة البوابة والسجلات والذاكرة المؤقتة ووسائط القنوات تحت `~/.estacoda/profiles/<id>/`.

```bash
estacoda profile create <name>
estacoda profile create <name> --blank
estacoda profile create <name> --from <profile> --files user,memory,soul
estacoda profile list
estacoda profile use <name>
estacoda profile show [name]
estacoda profile delete <name>
estacoda profile delete <name> --force
estacoda profile rename <old> <new>
```

**الحالة المُعدّلة:**
- `~/.estacoda/profiles/<id>/` (الهيكل الكامل)
- `~/.estacoda/active-profile.json`

**حدود الملف التعريف:** `profile use` يغيّر الملف التعريف النشط العام. بقية أوامر الملف التعريف تعمل على الملف المسمى.

**أنماط الفشل:**
- `profile delete` يرفض الملف النشط أو غير الفارغ ما لم يُزوّد بـ `--force`.
- `profile rename` يُحدّث سجل الملف النشط عند إعادة تسمية الملف النشط.

---

## البوابة والقنوات

### `estacoda gateway`

تدير دورة حياة بوابة القنوات، وتثبيت الخدمة، والتشخيصات.

```bash
estacoda gateway run                    # مشرف البوابة في المقدمة
estacoda gateway run --dry-run          # فحص الجاهزية؛ بدون كتابة PID/lock
estacoda gateway run --once             # تمريرة مشرف واحدة ثم خروج
estacoda gateway run --profile <id>     # ربط بوابة المقدمة بملف تعريف محدد
estacoda gateway start                  # بدء خدمة نطاق المستخدم المثبتة
estacoda gateway start --system         # بدء خدمة نطاق النظام المثبتة
estacoda gateway stop                   # SIGTERM؛ يفضل الخدمة المُدارة إن وُجدت
estacoda gateway stop --force           # SIGKILL للغير مُدارة؛ systemd stop للمُدارة
estacoda gateway restart                # إعادة تشغيل خدمة نطاق المستخدم المثبتة
estacoda gateway restart --graceful     # alias لـ restart في v0.1.0
estacoda gateway restart --system       # إعادة تشغيل خدمة نطاق النظام
estacoda gateway status                 # الحالة الكاملة: مدير الخدمة، القنوات، cron، الموافقات، إنهاء الذاكرة
estacoda gateway diagnose               # جاهزية لكل قناة؛ يخرج 1 عند التحذيرات
estacoda gateway approvals              # عدد الموافقات المعلقة
estacoda gateway install                # تثبيت خدمة systemd/launchd نطاق المستخدم
estacoda gateway install --force        # استبدال وحدة خدمة موجودة
estacoda gateway install --profile <id> # تثبيت خدمة مرتبطة بملف تعريف
estacoda gateway install --system --run-as-user <user>
estacoda gateway uninstall              # إزالة خدمة نطاق المستخدم
estacoda gateway uninstall --system     # إزالة خدمة نطاق النظام
```

**الحالة المُعدّلة:**
- `~/.estacoda/profiles/<id>/gateway.pid`
- `~/.estacoda/profiles/<id>/gateway.lock`
- `~/.estacoda/profiles/<id>/gateway-state/`
- وحدات systemd للمستخدم / ملفات plist لـ launchd (عند التشغيل المُدار)

**حدود دورة الحياة:** `gateway run` هو وضع المقدمة والتشخيص. `gateway start` يتطلب خدمة مثبتة ويستهدف خدمة نطاق المستخدم افتراضياً. استخدم `gateway start --system` عندما تكون خدمة نطاق النظام هي المثبتة. الخيار `gateway start --background` مُهمَل؛ استخدم `gateway install` ثم `gateway start`. لم يعد `gateway restart` يبدأ عملية خلفية غير مُدارة عند عدم وجود خدمة. يبقى `gateway stop` محتفظاً بمسار تنظيف PID/lock للعمليات غير المُدارة حيث يكون مدعوماً.

**حدود الملف التعريف:** عمليات البوابة ترتبط بالملف التعريف المختار عند التشغيل في المقدمة أو تثبيت الخدمة. تغيير `active-profile.json` لا يُعدّل بوابة قيد التشغيل.

**أنماط الفشل:**
- `start` يفشل إذا لم توجد خدمة مثبتة. للتشغيل في المقدمة استخدم `gateway run`.
- `stop` و`restart` يفضلان خدمة مُدارة نطاق المستخدم؛ إن وُجدت فقط خدمة النظام، أعد التشغيل مع `--system`.
- خدمات systemd نطاق المستخدم قد تتوقف عند الخروج ما لم يُفعّل linger.
- التثبيتات في وضع المصدر تُثبّت المسار المطلق؛ نقل ال repo يتطلب إعادة التثبيت.

### `estacoda channels`

```bash
estacoda channels list                  # جدول مدمج لكل القنوات
estacoda channels status <name>         # الحالة التفصيلية لقناة واحدة
estacoda channels enable <name>         # تعيين enabled: true في الإعداد
estacoda channels disable <name>        # تعيين enabled: false في الإعداد
```

أسماء القنوات الصالحة: `telegram`، `discord`، `email`، `whatsapp` (غير حساسة لحالة الأحرف).

**الحالة المُعدّلة:** `~/.estacoda/profiles/<id>/config.json` (كتلة القنوات).

**أنماط الفشل:** أسماء قنوات غير صالحة ترجع رمز خروج 1.

---

## Cron

```bash
estacoda cron list                      # كل المهام مع الجدولة والتشغيل التالي
estacoda cron show <job-id>             # تفاصيل المهمة + آخر 5 تنفيذات
estacoda cron history [job-id]          # سجل التنفيذ
estacoda cron add --schedule <schedule> --command "<prompt>"
estacoda cron edit <job-id> [flags]
estacoda cron run <job-id>              # طلب تشغيل يدوي
estacoda cron pause <job-id>
estacoda cron resume <job-id>
estacoda cron remove <job-id>
estacoda cron tick                      # دورة مجدول يدوية
```

أعلام add/edit المفيدة تشمل `--skill`، و`--script`، و`--script-arg`، و`--script-timeout-ms`، و`--no-agent`، و`--agent`، و`--context-from`، و`--clear-context-from`، و`--model`، و`--provider`، و`--clear-model`، و`--toolset`، و`--clear-toolsets`، و`--workdir`، و`--clear-workdir`.

**الحالة المُعدّلة:**
- `~/.estacoda/profiles/<id>/cron/jobs.json`
- `~/.estacoda/sessions.sqlite` (سجل التنفيذ)
- `~/.estacoda/profiles/<id>/cron/output/`

**حدود الملف التعريف:** مهام cron مرتبطة بالملف التعريف. قد يستخدم `CronStore` الافتراضي/اليدوي أيضًا دليل cron العلوي الافتراضي.

**أنماط الفشل:**
- الأقفال القديمة من العمليات المنهارة تُستعاد عند بدء التشغيل.
- runtimes الخاصة بالـ cron معزولة ولا تستطيع استخدام toolsets: `cron` أو `messaging` أو `clarify`.
- مدخلات context أو provider/model أو toolset أو workdir غير الصالحة، وكذلك prompts غير الآمنة، تُرفض قبل الحفظ عندما يتوفر سياق التحقق.
- فشل التسليم يُصنّف ويُخزّن في سجل التنفيذ.
- مهام no-agent لا تنشئ runtime trajectories.

راجع [المهام المجدولة](../user-guide/cron.md) للنموذج الكامل.

---

## الجلسات

```bash
estacoda sessions list                  # الجلسات الأخيرة مع الأسطح المرتبطة
estacoda sessions show <session-id>     # تفاصيل الجلسة + مؤشرات الأسطح
estacoda sessions current               # جلسة التشغيل الحالية
estacoda sessions attach <surface> <id> <session-id>
estacoda sessions detach <surface> <id>
estacoda sessions recall <query>        # تلخيص تطابقات الجلسات التاريخية
estacoda session recall <query>         # alias
estacoda sessions compact <session-id> [--topic <topic>]
```

الأسطح الصالحة: `cli`، `telegram`، `discord`، `whatsapp`، `email`.

**الحالة المُعدّلة:** قاعدة بيانات جلسات SQLite (`~/.estacoda/sessions.sqlite`).

**حدود الملف التعريف:** الجلسات مرتبطة بالملف التعريف. `sessions recall` مُقيّد بالملف التعريف النشط ومساحة العمل عند توفر البيانات الوصفية.

**أنماط الفشل:**
- `sessions compact` غير دوّار في هذه التطبيقة؛ لا يتبنى جلسة فرعية مضغوطة.
- attach/detach تتطلب وجود الجلسة في الملف التعريف النشط.

---

## الذاكرة

```bash
estacoda memory status
estacoda memory index path
estacoda memory index status
estacoda memory index rebuild
estacoda memory search <query> [--include-protected] [--max-results N] [--max-chars N]
estacoda memory read <USER.md|MEMORY.md|SOUL.md|shared> [key] [--include-protected] [--max-chars N]
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

**الحالة المُعدّلة:**
- `~/.estacoda/profiles/<id>/config.json` عند `memory mode`
- `~/.estacoda/profiles/<id>/USER.md` و`MEMORY.md` عند الكتابة/المسح
- `~/.estacoda/profiles/<id>/memory-curation.json` لسجل التنظيم
- `memory-index.sqlite` المحلي للملف الشخصي عند إعادة بناء/مزامنة الفهرس

**السلوك:**
- يعرض `memory status` إعدادات وسجل ذاكرة الملف الشخصي مع أعداد الإنهاء الخلفي `pending` و`running` و`retrying` و`failed`.
- يعرض `memory mode` أو يحدّث وضع تنظيم الذاكرة المحلي للملف الشخصي. `auto` هو الافتراضي ويطبق فقط مرشحين محافظين منخفضي المخاطر.
- يعرض `memory recent` سجلات التنظيم الحديثة، ومنها auto-applied وpending-review وignored وfailed.
- يعرض `memory review` سجلات pending-review وعمليات المرشحين منخفضة المخاطر المحفوظة.
- يطبق `memory apply <record-id> [candidate-id|all]` مرشحي المراجعة عبر مسار تعديل الذاكرة المشترك.
- يرفض `memory reject <record-id> [candidate-id|all]` مرشحي المراجعة دون كتابة الذاكرة.
- يعكس `memory undo <record-id>` العمليات المطبقة لسجل تنظيم.
- يزيل `memory forget <USER.md|MEMORY.md> <exact text>` نصًا مطابقًا من الذاكرة المتعلمة.
- يرسل `memory populate` نقطة تنظيم يدوية عبر runtime نشطة. استخدم `/memory populate` داخل جلسة CLI نشطة أو قناة مصرح بها عندما لا تتوفر runtime مرتبطة للأمر الأعلى.
- يطبع `memory edit` أهداف التحرير الآمنة وإرشادات الإصلاح لـ `USER.md` و`MEMORY.md`; يبقى `SOUL.md` محميًا.
- يتطلب `memory clear` العلم `--yes`، وينشئ نسخًا احتياطية للملفات الموجودة، ولا يمسح `SOUL.md` أو الذاكرة المشتركة.

**تكافؤ البوابة:** تعرض جلسات Telegram المصرح بها أوامر التنظيم نفسها عبر `/memory ...`.

---

## Workflow

يتطلب قاعدة بيانات جلسات SQLite. ترفض قاعدة بيانات الذاكرة أوامر Workflow.

```bash
estacoda workflow begin --session <sessionId> <objective>
estacoda workflow begin --skill <skillName> --session <sessionId> <objective>
estacoda workflow list                      # تشغيلات Workflow النشطة (غير النهائية)
estacoda workflow show <runId>
estacoda workflow status <runId>
estacoda workflow trace <runId> [limit]
estacoda workflow pause <runId> [reason]
estacoda workflow resume <runId>
estacoda workflow interrupt <runId> [reason]
estacoda workflow cancel <runId> [reason]
estacoda workflow steer <runId> <instruction>
estacoda workflow approve <stepId>
estacoda workflow reject <stepId> [reason]
estacoda workflow retry <stepId>
estacoda workflow skip <stepId> [reason]
estacoda workflow checkpoint <runId> <name>
estacoda workflow summarize <runId>
```

**الحالة المُعدّلة:** قاعدة بيانات جلسات SQLite (جداول `workflow_events`، `workflow_steps`).

**السلوك:**
- `estacoda workflow begin --session <sessionId> <objective>` ينشئ ويبدأ تشغيل Workflow بخطوة محافظة واحدة لجلسة موجودة. يسجل `activationReason: "explicit"` والهدف في metadata التشغيل.
- `estacoda workflow begin --skill <skillName> --session <sessionId> <objective>` يحل اسم المهارة، ويجمع playbook الخاص بها، ويحوله إلى `WorkflowPlan`، ثم ينشئ التشغيل ويبدأه.
- أمر CLI المستقل لا يفعّل جلسات تفاعلية لاحقة. استخدم `/workflow activate <runId>` داخل جلسة تفاعلية للتفعيل الحي.
- `begin` بدون `--skill` لا يستخدم تحويل playbook. خيار `--skill` اشتراك صريح.

ناتج النجاح في CLI المستقل:

```text
Created workflow: <runId>
Started workflow: <runId>
Not activated. Use /workflow activate <runId> inside an interactive session.
```

**أنماط الفشل:**
- معرف جلسة مفقود أو غير معروف يرجع خطأ. لا تُنشأ hidden sessions.
- مهارة غير معروفة ترجع خطأ واضحاً.
- إعادة المحاولة تعمل فقط إن كان `idempotent` أو `safeToRetry` صحيحاً وتحت `maxRetries`.
- التخطي يعمل فقط إن لم يبدأ الخطوة وكان `allowSkipIfSkippable` صحيحاً.
- يُرفض التوجيه لتشغيلات Workflow في حالات نهائية.
- الإيقاف يرسل SIGTERM مع مهلة 5 ثوانٍ للعمليات النشطة، ثم ينتقل الحالة.
- لا يوجد automatic workflow promotion، ولا complex-request detection، ولا مشاركة Agent Evolution، ولا إنشاء Workflow تلقائي من اختيار المهارة العادي داخل AgentLoop، ولا خيار `--use-selected-playbook`.

---

## الأمن والموافقات

```bash
estacoda security                       # عرض وضع الأمن الحالي
estacoda security --mode <mode>         # تعيين وضع الموافقة
```

الأوضاع الصالحة: `strict`، `normal`، `open`. كتل الأمان الصلبة تنطبق في كل الأوضاع.

**الحالة المُعدّلة:** `~/.estacoda/profiles/<id>/config.json`.

---

## المتصفح

```bash
estacoda browser status
estacoda browser setup --backend local-cdp --cdp-url http://127.0.0.1:9222 --launch-executable /path/to/chrome --launch-arg --headless=new --chrome-flag --no-first-run --auto-launch
estacoda browser setup --backend browserbase --cloud-provider browserbase --hybrid-routing
estacoda browser approve-cloud
estacoda browser revoke-cloud
estacoda browser test
estacoda browser disable
```

**الحالة المُعدّلة:** `~/.estacoda/profiles/<id>/config.json`.

**السلوك:**
- يضبط `setup --backend local-cdp` اتصال CDP اليدوي أو التشغيل التلقائي المحلي المُشرف عليه.
- تكتب `--launch-executable` و`--launch-arg` المتكررة و`--chrome-flag` المتكررة إعداد تشغيل منظم.
- يبقى `--launch-command` مقبولًا كبيانات توافق مهملة ولا يُحلل كـ shell.
- يضبط `setup --backend browserbase --cloud-provider browserbase --hybrid-routing` Browserbase والتوجيه الهجين لكنه لا ينشئ جلسة سحابية.
- يضبط `approve-cloud` القيمة `browser.cloudSpendApproved: true`؛ ويعطل `revoke-cloud` إنشاء الجلسات السحابية القابلة للفوترة مرة أخرى.

**أنماط الفشل:**
- يتطلب Browserbase كلًا من `BROWSERBASE_API_KEY` و`BROWSERBASE_PROJECT_ID`.
- قد تُسبب جلسات Browserbase رسومًا وتبقى محظورة حتى تشغيل `estacoda browser approve-cloud`.
- فشل موافقة إنفاق السحابة لا يرجع إلى المحلي.
- يبلغ `test` جاهزية الإعداد؛ يتم التحقق من التنقل الحي عبر أدوات المتصفح أثناء runtime.

---

## الأدوات و MCP

```bash
estacoda tools                          # قائمة الأدوات المتاحة مجمعة حسب toolset
estacoda mcp status                     # خوادم MCP المُهيأة والجاهزية
estacoda mcp reload                     # إعادة تحميل إعداد MCP
```

**الحالة المُعدّلة:** لا شيء لـ `tools`. `mcp reload` يُعيد بناء سجل أدوات التشغيل من الإعداد الحالي.

**أنماط الفشل:** خوادم MCP المفقودة من الإعداد ليست أخطاء؛ ببساطة لا تظهر.

---

## التشخيص

```bash
estacoda doctor                         # تقرير الصحة والإصلاحات المطلوبة
estacoda doctor --live                  # يتضمن تحقيقات نقاط النهاية الحية
estacoda doctor --json                  # DoctorReport منظّم للأتمتة
estacoda doctor --fix                   # إصلاحات آمنة لهيكل الحالة المحلي
```

**الحالة المُعدّلة:** لا شيء افتراضيًا. `--fix` و`--fix-config` و`--repair-sessions` و`--ack` مسارات إصلاح أو إقرار صريحة.

**رمز الخروج:** 0 إذا جاهز، 1 إذا توجد تحذيرات أو عوائق.

**المزيد:** [الطبيب](../user-guide/doctor.md).

---

## الصوت

```bash
estacoda voice status
estacoda voice setup --stt-provider local
estacoda voice setup --stt-provider local --python-binary /path/to/python
estacoda voice setup --tts-provider openai
estacoda voice mode on|off|tts|status
```

**الحالة المُعدّلة:**
- `~/.estacoda/profiles/<id>/config.json`
- `~/.estacoda/profiles/<id>/.env` عند تخزين أسرار مزود الصوت
- `~/.estacoda/python-env` لإعداد STT المحلي المُدار
- `~/.estacoda/cache/huggingface` لذاكرة نموذج faster-whisper أثناء التشغيل

**السلوك:**
- `estacoda voice setup --stt-provider local` يفحص بيئة Python المُدارة، وينشئها أو يصلحها عند الحاجة، ويثبت `faster-whisper==1.2.1` المثبت بالإصدار، ولا يكتب إعداد STT المحلي إلا بعد نجاح الإعداد.
- رسائل التقدم منتقاة. سجلات pip الخام ليست UX الطبيعي للـ CLI.
- `--python-binary /path/to/python` يتخطى فحص/إنشاء البيئة المُدارة ويخزن المسار المخصص. المشغل يملك بيئة Python هذه.
- `estacoda voice setup --tts-provider openai` هو TTS فقط. لا يغيّر إعداد STT ولا يلمس بيئة Python المُدارة.
- يحل runtime Python المُعد أولاً، ثم مسار venv المُدار. لا يثبت runtime الحزم في Phase 1.

**أنماط الفشل:**
- بيئة Python المُدارة المفقودة/التالفة تُصلح أثناء إعداد STT المحلي الصريح.
- فشل تثبيت الحزمة يخرج دون كتابة إعداد STT محلي مكسور.
- فشل Python المخصص يصلحه المشغل، لا EstaCoda.

---

## المسارات والتقييم

```bash
estacoda trace list [--session <id>] [--limit <n>]
estacoda trace dump <trajectory-id> [--raw]
estacoda trace timeline <trajectory-id> [--raw]
estacoda trace failures <trajectory-id>
estacoda eval [fixture-id]
```

**الحالة المُعدّلة:** قاعدة بيانات جلسات SQLite (تخزين المسارات).

**أنماط الفشل:** `--raw` يتجاوز التحريض. استخدم بحذر.

---

## الحزم والمهارات

```bash
estacoda packs list                     # الحزم المُثبّتة
estacoda packs inspect <id>             # البيان الوصفي الكامل والبيانات الوصفية
estacoda packs install <path>           # التثبيت من مسار محلي
estacoda packs enable <id>
estacoda packs disable <id>
estacoda packs uninstall <id>

estacoda skills list                    # المهارات المتاحة من الحزم المُفعلة
estacoda skills inspect <name>          # بيانات وصفية للمهارة
estacoda skills view <name>             # محتوى SKILL.md الكامل
```

**الحالة المُعدّلة:**
- `~/.estacoda/profiles/<id>/packs.json`
- `~/.estacoda/packs/` (تخزين الحزم المشترك)

**حدود الملف التعريف:** الحزم تُثبّت عالمياً؛ التفعيل لكل ملف تعريف. رؤية المهارات تعتمد على الحزم المُفعلة.

---

## الإعدادات

```bash
estacoda settings                       # نظرة عامة على كل الفئات
estacoda settings profile               # وضع الملف التعريف ولغة الاستجابة
estacoda settings profile --mode <mode> --response-language <lang>
estacoda settings ui                    # لغة واجهة المستخدم، النمط، تسميات النشاط
estacoda settings ui --language <en|ar> --flavor <f> --activity-labels <l>
estacoda settings skills                # استقلالية المهارات
estacoda settings skills --autonomy <level>
estacoda settings security              # وضع الأمن
estacoda settings browser               # إعداد backend المتصفح
estacoda settings voice                 # جاهزية مزود الصوت
estacoda settings image                 # إعداد توليد الصور
estacoda settings telegram              # إعداد قناة Telegram
estacoda settings provider              # ملخص تشخيصي للمزود
```

**الحالة المُعدّلة:** `~/.estacoda/profiles/<id>/config.json`.

---

## المعرفة، التطوير، المنسق، البيان، الاقتراح

عائلات أوامر موجهة للتطوير. تعمل على بيانات المهارات ورسوم المعرفة واقتراحات التطوير.

```bash
estacoda knowledge <subcommand>
estacoda evolution <subcommand>
estacoda curator <subcommand>
estacoda manifest diff <id>
estacoda proposal <subcommand>
```

هذه أسطح متقدمة. شغّل `--help` على كل منها للأوامر الفرعية.

---

## التحديث

```bash
estacoda update --check                 # فحص فقط; لا يُعدّل الملفات
estacoda update                         # تطبيق التحديث (managed-source) أو طباعة التوجيه
estacoda update --backup                # فرض نسخ احتياطي قبل التطبيق
estacoda update --no-backup             # تخطي نسخ احتياطي لحالة المستخدم
estacoda update --gateway               # وضع تحديث غير تفاعلي للبوابة/الخدمة
```

**توجيه طريقة التثبيت:** يكتشف `estacoda update` طريقة تثبيتك ويوجّه السلوك وفقاً لها.

| الطريقة | السلوك |
|---|---|
| `managed-source` | تحديث مصدري محمي: fetch، فحص ff-only، فحص شجرة العمل، pull، تثبيت التبعيات، build، تحقق. استعادة عند الفشل. |
| `manual-source` | فحص وتوجيه فقط. لا تعديل ذاتي. |
| `homebrew` | يطبع `brew upgrade kemetresearch/tap/estacoda`. |
| `docker` | يطبع `docker pull ghcr.io/sifr01-labs/estacoda:latest`. |
| `npm-global` | يطبع `npm install -g estacoda@latest`. |
| `pnpm-global` | يطبع `pnpm add -g estacoda@latest`. |
| `unknown` | يطبع توجيه إعادة التثبيت. |

**الحالة المُعدّلة:**
- `~/.estacoda/update-cache.json` — ذاكرة تخزين مؤقت لفحص التحديث
- `~/.estacoda/logs/update.log` — سجل عملية التحديث (وضع البوابة)
- `~/.estacoda/.backups/<label>/` — نسخة احتياطية لحالة المستخدم قبل تعديل managed-source

**رموز الخروج:** 0 عند النجاح/التوجيه، 1 عند الخطأ، 2 إذا كان محدثاً، 3 إذا كانت شجرة العمل متسخة.

**صفحات ذات صلة:** [التحديث](../getting-started/updating.md)، [تشغيل التحديث](../operations/update-operations.md)

## إلغاء التثبيت

```bash
estacoda uninstall                      # الاحتفاظ بالبيانات; إزالة الكود/الملفات المُغلقة/الخدمات
estacoda uninstall --purge --yes        # إزالة بيانات المستخدم أيضاً
```

**السلوك:** الوضع الافتراضي يزيل كود managed-source، الملفات المُغلقة المعروفة، إدخالات PATH المملوكة للمثبت، وخدمات البوابة مع الحفاظ على `~/.estacoda`. `--yes` وحده لا يزيل البيانات. يتطلب الحذف الكامل للبيانات كلاً من `--purge` و`--yes`.

**توجيه طريقة التثبيت:**

| الطريقة | السلوك |
|---|---|
| `managed-source` | إيقاف البوابة، إزالة الملفات المُغلقة/إدخالات PATH، إزالة دليل التثبيت (إذا كان الختم موثوقاً)، الحفاظ على `~/.estacoda` |
| `manual-source` | إيقاف البوابة، إزالة الملفات المُغلقة/إدخالات PATH، الحفاظ على clone و`~/.estacoda` |
| `homebrew` | يطبع `brew uninstall estacoda` |
| `docker` | يطبع توجيه الحاوية/الصورة |
| `npm-global` | يطبع `npm uninstall -g estacoda` |
| `pnpm-global` | يطبع `pnpm remove -g estacoda` |
| `unknown` | إزالة الملفات المُغلقة/إدخالات PATH المعروفة، الحفاظ على بيانات المستخدم |

**الحالة المُعدّلة:** قد يزيل دليل التثبيت، الملفات المُغلقة، إدخالات PATH، خدمات البوابة. مع `--purge --yes`، يزيل `~/.estacoda`.

**صفحات ذات صلة:** [إلغاء التثبيت](../getting-started/uninstall.md)

---

## الإصدار والمساعدة

```bash
estacoda --version
estacoda -v
estacoda --help
estacoda -h
estacoda help
```

---

## خادم ACP

```bash
estacoda acp                            # تشغيل خادم ACP stdio
```

يبدأ خادم بروتوكول اتصال الوكيل stdio للتكامل الخارجي.

---

## التسليم

```bash
estacoda handoff <surface>
```

يُنشئ رمز تسليم لمشاركة جلسة CLI الحالية مع سطح قناة. يدعم حالياً `telegram` فقط.

**الحالة المُعدّلة:** `~/.estacoda/profiles/<id>/gateway-state/handoff-codes.json`.

---

## رموز الخروج

| الرمز | المعنى |
|-------|--------|
| 0 | نجاح |
| 1 | خطأ، تحذير، أو أمر مرفوض |
| 2 | محدّث (أمر التحديث) |
| 3 | شجرة عمل متسخة; ارتكِم أو stash قبل إعادة المحاولة (أمر التحديث) |

معظم الأوامر تخرج 0 عند النجاح و1 عند أي فشل أو تحذير تشخيصي أو إدخال غير صالح. أمر التحديث يستخدم 2 عندما يكون محدثاً و3 عندما تكون شجرة عمل managed-source متسخة. عائلة البوابة تتبع نفس الاتفاقية.

---

## صفحات ذات صلة

- [أوامر الشرطة المائلة](./slash-commands.md) — مرجع الأوامر داخل الجلسة
- [مرجع الأدوات](./tools-reference.md) — فئات الأدوات وحدود التوفر
- [الحالة والملفات](./state-and-files.md) — مواقع حالة الملف التعريف
- [مرجع المزود](./provider-reference.md) — نضج المزود وطريقة الإعداد
