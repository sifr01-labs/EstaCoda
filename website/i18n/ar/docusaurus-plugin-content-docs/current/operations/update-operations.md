---
title: تشغيل التحديث
description: كيف يتصرف محرك التحديث، وكيف يفشل، وكيف يستعيد.
sidebar_position: 7
---

# تشغيل التحديث

هذه الصفحة للمشغلين ومصيّلي النظام الذين بحاجة إلى فهم كيف يحدث نفسه EstaCoda، وأين تقع الحدود، وما يجب تفحصه عندما يفشل أمر ما. ليست صفحة تسويق. إذا كنت تبحث عن دليل المستخدم، انظر [التحديث](../getting-started/updating.md).

## ما هو محرك التحديث

محرك التحديث هو آلة حالة موجّهة بطريقة التثبيت. يكتشف كيف ثُبّت EstaCoda، ويتحقق أن البيئة الحالية تطابق ختم التثبيت، ثم يأم إما بتنفيذ تعديل مصدري محمي أم يرفض ويطبع أمر الأمر الخارجي الصحيح. لا يخمّن. ولا يعدّل تثبيتات الحزم. ولا يُعيد تشغيل الخدمات ما لم يثبت أنها مُدارة.

## التحديثات الداخلية لـ managed-source

`managed-source` هي الطريقة الوحيدة التي يسمح لـ `estacoda update` بتعديلها في المكان. التسلسل الكامل هو:

### 1. التحقق من الختم

يقرأ `.install-method.json` ويتحقق من:

- أن `method` هي `managed-source`
- أن `source` هي `stamp` (ليس استنتاجاً من المسار)
- أن `installDir` و`sourceUrl` والفرع موجودة وغير فارغة

إذا فشل أي منها، يتم رفض التحديث قبل لمس لمس النظام الملفي.

### 2. التحققات من سلامة المستودع

- يجب أن يحتوي `installDir` المختوم على مجلد `.git`.
- يجب أن يحل `git rev-parse --show-toplevel` إلى `installDir` المختوم.
- يجب أن يتطابق `git remote get-url origin` بعنوان origin في الختم (عناوين GitHub تُعادل إلى شكل `github.com/<owner>/<repo>`).
- يجب أن يطابق `git rev-parse --abbrev-ref HEAD` الفرع المتوقع.

أي اختلاف يولد خطأً مع طباعة الاختلاف التفصيلي.

### 3. بوابة شجرة العمل

يتم الفحص باستخدام `git status --porcelain`. إذا كان المخرج غير فارغ، يتم الرفض برمز خروج `3`:

```
Update refused: managed-source worktree has uncommitted changes.
Commit, stash, or discard local changes before running `estacoda update`.
Exit code: 3
```

الحفظ التلقائي للتغييرات غير المُلتزمة ليس مُطبّقاً في v0.1.0.

### 4. التقاط pre-pull SHA

يتم التقاط قيمة `git rev-parse HEAD` قبل أي تعديل. هذا الـ SHA هو هدف الاستعادة.

### 5. نسخ حالة المستخدم

تنسخ `backupState()` المسارات المحمية إلى `~/.estacoda/.backups/pre-source-update-<timestamp>/`:

- `active-profile.json`
- `profiles/`
- `trust.json`
- `workspace-approvals.json`
- `sessions.sqlite`
- `memory/`
- `packs/registry.jsonl`
- ملف `config.json` الخاص بالمشروع (إذا كان جذر المشروع معروفاً)

إذا لم ينشئ النسخ أي ملف ولم يُمرر `--no-backup`، يتم إلغاء التحديث.

`--no-backup` يتخطى هذه الخطوة. `--backup` مقبول ولكنه زائد عن الافتراضي لأن السلوك الافتراضي يُنشئ النسخة بالفعل.

### 6. الجلب وفحص المسافة

يشغّل `git fetch origin`، ثم `git rev-list --count HEAD..origin/<branch>`. إذا كان العدد صفراً أو غير معرف، يتم التقرير بأننا محدثون بالفعل ويخرج برمز `0`.

### 7. السحب fast-forward

الأمر `git pull --ff-only origin <branch>` هو أول المرحلات المسموح بها. حالات غير fast-forward تولد خطأً وتحرّك الاستعادة.

### 8. تثبيت التبعيات والبناء

```bash
pnpm install --frozen-lockfile
pnpm run build
```

الفشل هنا يحرّك الاستعادة.

### 9. التحقق بعد التحديث

```bash
node dist/index.js --version
node dist/index.js --help
```

يجب أن يكون خروج كلاهما `0`. الفشل يحرّك الاستعادة.

### 10. كتابة ذاكرة التخزين المؤقت

يتم كتابة `~/.estacoda/update-cache.json` بـ `versionStatus: "up-to-date"`.

## الاستعادة والتعافي

إذا فشلت أي خطوة في مرحلة التعديل (pull، install، build، التحقق)، ينفّذ المحرك `git reset --hard <prePullSha>` لإرجاع المستودع إلى حالته قبل التحديث.

نتيجة الاستعادة مُدرجة في مخرجات الخطأ:

- إذا نجحت الاستعادة: "Rolled back managed-source checkout to `<sha>`."
- إذا فشلت الاستعادة: "Rollback failed: ..." مع تعليمة إصلاح يدوي.

نسخ حالة المستخدم محفوظة بغض النظر عن نجاح الاستعادة. لا تتم استعادتها تلقائياً; يجب نسخها يدوياً إذا احتجت.

## سلوك manual-source

تثبيتات manual-source مُختومة بـ `.install-method.json` مع `method: manual-source`. يعاملهم المحرك كما لو كانت مساهمة مستخدم/مطور.

- `estacoda update --check`: يطبع عدد commits خلف `origin/<branch>` إذا كان متاحاً.
- `estacoda update`: يطبع نصيحة توجيه ويخرج برمز `0`. لا يتم تعديل أي ملف.
- `estacoda update --apply`: غير مسموح. يرجع الرمز `1` مع رسالة توجيه.

لا يشغّل المحرك `git pull` ولا `pnpm install` ولا build في مجلد manual-source أبداً.

## توجيه الحزم والحاويات

للتثبيتات التي لا تستطيع تحديث نفسها، يطبع `estacoda update` الأمر الخارجي الموصى به ويخرج برمز `0`:

| الطريقة | الأمر |
|---|---|
| Homebrew | `brew upgrade kemetresearch/tap/estacoda` |
| Docker | `docker pull ghcr.io/kemetresearch/estacoda:latest` |
| npm global | `npm install -g estacoda@latest` |
| pnpm global | `pnpm add -g estacoda@latest` |

تتم اكتشاف هذه التثبيتات باستخدام الاستدلال على المسارات وفحوصات التشغيل الحاوية، ليس باستخدام الختم.

## وضع تحديث البوابة

`--gateway` مصمّم للتحديثات غير المشروفة في توزيعات البوابة المُدارة.

السلوك:

- غير تفاعلي. لا توجد مطالبات.
- يتم تسجيل تقدم التحديث في `~/.estacoda/logs/update.log` عبر طبقة المقاومة.
- stdout وstderr مُحميان ضد broken pipes.
- SIGHUP مُلتقط ويسجّل; التحديث يستمر حيث الممكن.
- عند النجاح، يحاول المحرك إعادة تشغيل خدمة البوابة المُدارة عبر service-manager abstraction.
- إذا لم يُعثر على خدمة مُدارة، يطبع:
  ```
  Gateway restart: no managed gateway service was detected.
  Restart the gateway manually with: estacoda gateway restart
  ```
- إذا فشلت إعادة التشغيل، يطبع سبب الفشل وأمر إعادة التشغيل اليدوي، بما في ذلك `--system` إذا كانت الخدمة بنطاق النظام.

وضع البوابة لا يعيد تشغيل عمليات المستخدم العشوائية أبداً. يلمس فقط الخدمات المُثبّتة عبر `estacoda gateway install-service`.

## مقاومة التحديث والتسجيل

تحديثات managed-source مُغلّفة باستخدام `runManagedSourceUpdateWithResilience()`، التي توفر:

- **معالجة SIGHUP**: التقاط تشعلات الجلسة الطرفية وتسجيلها.
- **حماية broken-pipe**: فشول كتابة stdout/stderr يتم تسجيله بدون إيقاف التحديث.
- **إخفاء الاعتمادات**: الروابط التي تحتوي على رموز المصادقة ورؤوس Bearer وأنماط الأسرار الشائعة تُرادَّق من السجل.
- **مسار السجل**: `~/.estacoda/logs/update.log`.

مدخلات السجل سطور مؤقتة ISO-8601 مسبوقة باسم مرحلة التحديث.

## الجلب المؤقت عند بدء التشغيل

`scheduleStartupUpdatePrefetch()` يتم استدعاؤه من النقطة الرئيسية عندما:

- `argv.length === 0` (لا فرعية فرعية)
- `canRunInteractive()` يعود true

يقوم بجدولة `prefetchStartupUpdateStatus()` في دورة event loop التالية. يقوم الـ prefetch بـ:

1. قراءة ذاكرة التخزين المؤقت. إذا كانت غير عتيقة، يعود فوراً.
2. اكتشاف طريقة التثبيت.
3. لـ managed-source وmanual-source: فحص git بعيد دون تعديل refs المحلية.
4. لـ الطرق الأخرى: الاستعلام عن GitHub releases API.
5. كتابة الذاكرة بـ `versionStatus` ونص التلميح.

جميع الأخطاء مُلتقطة ومستوعبة. لا يجب أن يؤخر prefetch أو يفشل جلسة تفاعلية أبداً.

## التحقق

يحتوي المستودع على السكريبات التالية للتحقق من التثبيت والتحديث:

| السكريبت | النطاق |
|---|---|
| `pnpm run validate:install` | ماتريكس التثبيت بأكمله (أدلّة مؤقتة، لا تعديل في `~/.estacoda` الحقيقي) |
| `pnpm run validate:source-install` | التركيز على مثبّت التثبيت من المصدر |
| `pnpm run validate:uninstall` | التركيز على سلوك إلغاء التثبيت |
| `pnpm run validate:docker` | build وrun لصورة Docker |
| `pnpm run validate:homebrew` | الفحص النحوي للـ formula |
| `pnpm run verify:package-bin` | التحقق من محتويات npm pack |

تستخدم هذه السكريبات أدلّة بيت مؤقتة وبوابات مؤقتة. لا تكتب في `~/.estacoda` الحقيقي لديك.

## ما هو غير مسموح به في v0.1.0

- **التحديثات عبر الفرع.** تحديثات managed-source تبقى على الفرع المختوم في الختم. تبديل الفروع يدوي.
- **الحفظ التلقائي.** شجرات العمل المتسخة مرفوضة، ليست محفوظة تلقائياً.
- **التحديث عبر artifact فقط.** متغير `ESTACODA_UPDATE_ARTIFACT` قابل للوصول في الكود، لكنه ليس الآلية المُوصى بها في v0.1.0.
- **التوافق غير fast-forward.** فقط `git pull --ff-only` مسموح.
- **مزامنة المهارات بعد التحديث.** المحرك يطبع "Bundled skill sync: no-op for v0.1.0." مزامنة المهارات بعد التحديث غير مُطبّقة في v0.1.0.
