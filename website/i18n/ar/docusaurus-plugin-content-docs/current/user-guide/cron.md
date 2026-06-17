---
title: المهام المجدولة
description: مهام cron، وتشغيل مجدول معزول، وفحوص no-agent، وسلاسل السياق، وأدلة التنفيذ.
sidebar_position: 8
---

# المهام المجدولة

يشغّل cron في EstaCoda الأتمتة المجدولة من الملف التعريفي النشط. يمكن لمهمة cron أن تشغّل prompt للوكيل، أو تشغّل script قبل prompt الوكيل، أو تعمل كفحص script-only في وضع no-agent، أو تحمل تعليمات skills، أو تضمّن مخرجات مهام cron سابقة، أو تقيّد النموذج والأدوات ومساحة العمل المستخدمة في التشغيل.

cron هو أيضًا سطح أدلة لـ Agent Evolution. المهام المدعومة بوقت تشغيل تنشئ جلسات runtime معزولة وtrajectories قابلة للفحص لاحقًا. cron لا ينشئ skills ولا يرقّيها تلقائيًا في هذا الإصدار.

## التخزين

يعتمد تخزين مهام cron على طريقة إنشاء `CronStore` داخل runtime.

المسارات المرتبطة بالملف التعريفي تستخدم:

```text
~/.estacoda/profiles/<id>/cron/jobs.json
~/.estacoda/profiles/<id>/cron/output/
```

بعض المسارات الافتراضية أو اليدوية قد تستخدم:

```text
~/.estacoda/cron/jobs.json
~/.estacoda/cron/output/
```

سجل التنفيذ يُخزّن في `~/.estacoda/sessions.sqlite` داخل جدول `cron_executions`. يسجل الحالة، والطوابع الزمنية، وملخص المخرجات، وبيانات الفشل، ونتائج التسليم، ومعرفات جلسة runtime وtrajectory عندما يوجد runtime.

## إنشاء المهام

استخدم أوامر CLI، أو أوامر slash، أو أداة `cronjob`.

```bash
estacoda cron add --schedule "every 1h" --command "Summarize recent project changes"
/cron add --schedule "every 1h" --command "Summarize recent project changes"
```

أعلام مفيدة في add/edit:

```text
--skill <name>
--script <path>
--script-arg <arg>
--script-timeout-ms <ms>
--no-agent
--agent
--context-from <job-id>
--clear-context-from
--model <model>
--provider <provider>
--clear-model
--toolset <name>
--clear-toolsets
--workdir <absolute-path>
--clear-workdir
```

الجداول المدعومة تشمل التأخيرات النسبية مثل `10m`، والفواصل مثل `every 2h`، وتعبيرات cron ذات خمسة حقول، وسلاسل التاريخ التي يقبلها JavaScript date parsing.

## عزل وقت التشغيل

مسار gateway cron، و`/cron tick`، و`estacoda cron tick` كلها تستخدم runtimes معزولة للـ cron. العمل المجدول لا يعيد استخدام runtime المحادثة الحالية.

تعطّل runtimes الخاصة بالـ cron مجموعات الأدوات `cron` و`messaging` و`clarify` إجباريًا، وتمرر معرف جلسة cron مولدًا، ويتم التخلص منها بعد التنفيذ. إذا كانت المهمة تحتوي على allow-list باسم `enabledToolsets`، تُزال الأدوات الخارجة عنها من runtime المجدول. لا يمكن إعادة تمكين `cron` أو `messaging` أو `clarify`.

المجدول تسلسلي حاليًا. ينفذ المهام المستحقة واحدة تلو الأخرى تحت tick lock عام وأقفال لكل مهمة. non-blocking bounded dispatch غير مُنفّذ.

## Scripts وفحوص no-agent

مهام script المدعومة بوكيل تشغّل script أولًا، ثم تُنقّح النتيجة وتحقنها في prompt المجدول.

مهام no-agent تشغّل script فقط:

- `--no-agent` يتطلب `--script`.
- stdout غير الفارغ يتم تسليمه.
- stdout الفارغ نجاح صامت.
- آخر سطر غير فارغ بصيغة JSON يساوي `{ "wakeAgent": false }` يعني نجاحًا صامتًا.
- فشل script أو timeout ينتج تنبيهًا مصنّفًا ومنقّحًا.

مهام no-agent لا تنشئ جلسات runtime ولا trajectories.

## Skills والسياق

المهارات المرتبطة بمهام cron تحمّل أجسام تعليمات skill الفعلية. تستخدم EstaCoda `providerInstructions.content` عند وجوده، وإلا تستخدم `instructions`. المهارات المفقودة تضيف تحذيرًا داخل prompt المجدول بدل إسقاط المهمة. نص كل skill محقون له حد أقصى ويمر عبر فحص assembled prompt.

`contextFrom` يحقن أحدث مخرجات من مهام cron سابقة. تُحمّل المخرجات من output root الخاص بالـ cron، وتبقى بترتيب الطلب، وتُقصّر وتُنقّح وتوسم كبيانات لا كتعليمات. معرفات المهام المحفوظة بصورة غير سليمة ومحاولات path escape يتم تخطيها.

## النموذج والأدوات وworkdir

`--model` و`--provider` يحددان مسار نموذج لكل مهمة. إذا استُخدم `--model` بلا `--provider`، تثبّت EstaCoda المزود الحالي قبل تخزين المهمة. مسارات provider/model غير الصالحة تُرفض قبل الحفظ.

`--toolset` ينشئ allow-list يتم التحقق منها مقابل الأدوات المسجلة فعليًا في runtime. مجموعات الأدوات غير المعروفة أو المحظورة تُرفض.

`--workdir` يحدد workspace فعّالًا للمهمة. يجب أن يكون مسارًا مطلقًا موجودًا داخل جذر workspace مسموح. تستخدم EstaCoda `realpath` لتوحيد المسارات، وترفض symlink escapes، وتستمد الثقة من workspace trust store. cron لا يمنح الثقة لمسارات مطلقة عشوائية.

## الأمان

يتم فحص raw prompts عند create/update، ثم يُعاد فحصها عند التشغيل للمهام القديمة المحفوظة. مخرجات script، ومخرجات upstream، ونصوص skill تُنقّح قبل حقنها في prompt. يتم فحص assembled prompt النهائي وتنظيف invisible Unicode قبل `runtime.handle()`.

## الفحص والإصلاح

```bash
estacoda cron list
estacoda cron show <job-id>
estacoda cron history [job-id]
estacoda cron run <job-id>
estacoda cron pause <job-id>
estacoda cron resume <job-id>
estacoda cron remove <job-id>
estacoda cron tick
```

امسح عناصر التحكم المتقدمة باستخدام:

```bash
estacoda cron edit <job-id> --clear-model
estacoda cron edit <job-id> --clear-toolsets
estacoda cron edit <job-id> --clear-workdir
estacoda cron edit <job-id> --agent
```

## الحدود

- scheduler dispatch تسلسلي.
- لا توجد web dashboard للـ cron في هذا الإصدار.
- cron لا يطوّر skills ولا يرقّيها تلقائيًا.
- مهام no-agent لا تنشئ runtime trajectories.
- دعم workdir لا يثق بمسارات مطلقة عشوائية.
