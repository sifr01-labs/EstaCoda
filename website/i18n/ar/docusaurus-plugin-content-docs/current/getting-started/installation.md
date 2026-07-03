---
title: التثبيت
description: ثبت EstaCoda عبر curl أو git clone أو npm أو Homebrew أو Docker.
sidebar_position: 3
---

# التثبيت

EstaCoda هو نظام وكيل أمر سطري يملك تصليحاً صريحاً للتثبيت. يكتشف المثبت النظام الخاص بك، يتحقق من التبعيات، يبني من المصدر، ويطبع طريقة التثبيت في `.install-method.json` حتى تعرف التحديثات والإزالات المستقبلة ماذا تتعامل معه.

## بنية المثبت

تتكون طبقة التثبيت من ثلاث مستويات:

| الطبقة | الدور | الرابط |
|---|---|---|
| نقطة الدخول العامة | العنوان المستقر الذي يُعلن في المستندات | `https://www.estacoda.com/install.sh` |
| مثبت المستودعات | منطق التثبيت الفعلي | `scripts/install.sh` في مستودعات EstaCoda |
| التراجع المباشر من المصدر | رابط GitHub المباشر للتصحيح والاختبار قبل الإصدار | `https://raw.githubusercontent.com/sifr01-labs/EstaCoda/main/scripts/install.sh` |

نقطة الدخول العامة هي مشغّل رقيق يقوم بتنزيل `scripts/install.sh` من المستودعات وتشغيله. لا يعتمد تنفيذ التثبيت على `www.estacoda.com` في تنفيذه. هذا يخلق دائرة تبعية مغلقة.

## المنصات المدعومة

| نظام التشغيل | الحالة | الملاحظات |
|---|---|---|
| macOS 11+ | مدعوم | الحد الأدنى مطابق لعقد Node.js 22.18.0 |
| Linux (systemd, glibc) | مدعوم | مؤكَّل على Ubuntu 22.04+ و Debian 12+; تنسيق FHS مدعوم للتثبيت بصلاحيات root |
| Docker | مدعوم | أي بيئة تدعم Docker |
| WSL2 | جهد الدعم | مكدّس Node/pnpm يعمل; الصوت/الميكروفون وخدمات systemd المستخدم تحتوي على حالات خاصة |
| Termux | جهد الدعم | المثبت يحلّل تنسيق `$PREFIX/bin`; ليس هدفًا رئيسيًا للتحقق |
| Windows الأصلي | غير مدعوم | ليس ضمن نطاق الدعم في v0.1.0 |

## متطلبات زمن التشغيل

- Node.js >= 22.18.0
- pnpm (عبر Corepack أو تثبيت يدوي)
- Git (للتثبيت من المصدر وتدفقات التحديث)
- POSIX shell (لمثبت curl وسيوم التهيئة)
- Docker (للتشغيل في حاوية)
- Homebrew (للتثبيت عبر Homebrew)

## طرق التثبيت

### curl | bash (الافتراضي)

الأمر العام المستخدم في المستندات:

```bash
curl -fsSL https://www.estacoda.com/install.sh | bash
```

مع الخيارات:

```bash
curl -fsSL https://www.estacoda.com/install.sh | bash -s -- --dir <path> --skip-init
```

ينشئ هذا تثبيتًا من نوع **managed-source**. المثبت:

1. يكتشف النظام ويتحقق من Node.js >= 22.18.0
2. يتأكد من وجود pnpm
3. ينسخ المستودعات إلى `~/.estacoda/estacoda` (أو إلى `--dir` مخصّص)
4. يبني `dist/` عبر `pnpm install --frozen-lockfile && pnpm run build`
5. يكتب مشغّل bash إلى `~/.local/bin/estacoda`
6. يطبع `.install-method.json` بقيمة `method: managed-source`
7. يشغّل `estacoda init` إلا إذا تم توفير `--skip-init`

إذا كان المجلد يحتوي على تثبيت managed-source مع ختم مطابق، يقوم المثبت بتحديثه عبر `git fetch`، `git checkout`، و `git pull --ff-only` بدلاً من إعادة الاستنساخ.

**التراجع المباشر من المصدر** (للتصحيح والاختبار قبل الإصدار):

```bash
curl -fsSL https://raw.githubusercontent.com/sifr01-labs/EstaCoda/main/scripts/install.sh | bash
```

### git clone + سيوم التهيئة (مسار المساهمين)

للمطورين الذين يريدون العمل على المصدر:

```bash
git clone https://github.com/sifr01-labs/EstaCoda.git
cd EstaCoda
./scripts/setup-estacoda.sh
```

ينشئ هذا تثبيتًا من نوع **manual-source**. سيوم التهيئة:

1. يتحقق من Node.js و pnpm
2. يبني `dist/`
3. يكتب مشغّل إلى `~/.local/bin/estacoda`
4. يطبع `.install-method.json` بقيمة `method: manual-source`
5. يشغّل `estacoda init` إلا إذا تم توفير `--skip-init`

تثبيتات manual-source تعد مساهمات. امر `estacoda update` يقوم بالفحص والإرشاد فقط، ولا يقوم بالتعديل الذاتي.

### npm global (هدف الإصدار)

```bash
npm install -g estacoda
```

التثبيت عبر npm هو من متطلبات إصدار v0.1.0. بيانات الحزمة جاهزة للنشر (`private: false`، حقل `repository` محدد، و `bin.estacoda` مُعد). النشر الفعلي يحدث في وقت الإصدار. حتى ذلك، يمكن عرض هذا المسار في المستندات كمسار الإصدار.

تثبيتات npm global مدارة من قبل npm. امر `estacoda update` يوجّهها إلى `npm install -g estacoda@latest` ولا يحاول تعديل المصدر.

### Homebrew

```bash
brew install kemetresearch/tap/estacoda
```

Homebrew يبني من شجرة المصدر على GitHub باستخدام Node و Corepack/pnpm. تقع الوصفة في مستودعات `KemetResearch/homebrew-tap` الخارجية. امر `estacoda update` يوجّه تثبيتات Homebrew إلى `brew upgrade kemetresearch/tap/estacoda`.

### Docker

```bash
docker run ghcr.io/sifr01-labs/estacoda:v0.1.0
```

الصور منشورة على GHCR. امر `estacoda update` يوجّه تثبيتات Docker إلى `docker pull ghcr.io/sifr01-labs/estacoda:latest`. الواجهة الترمية لا تقوم بتعديل نظام ملفات الحاوية.

## أنماط التثبيت

EstaCoda يميّز بين ستة أنماط للتثبيت. تمرير التحديث والإزالة يرتبطان بالسلوك بناءً على النمط المكتشف.

| النمط | كيفية الإنشاء | التحديث الذاتي؟ | سلوك الإزالة |
|---|---|---|---|
| `managed-source` | curl \| bash installer | نعم (git pull محكّم) | يحذف المجلد المدار، المشغّلات، ومداخل PATH; يحتفظ ببيانات المستخدم |
| `manual-source` | git clone + setup script | لا (فحص وإرشاد فقط) | يحذف المشغّلات ومداخل PATH; يحتفظ بالمستودعات وبيانات المستخدم |
| `npm-global` | `npm install -g estacoda` | لا (يوجّه إلى npm) | يطبع `npm uninstall -g estacoda` |
| `pnpm-global` | `pnpm add -g estacoda` | لا (يوجّه إلى pnpm) | يطبع `pnpm remove -g estacoda` |
| `homebrew` | `brew install` | لا (يوجّه إلى brew) | يطبع `brew uninstall estacoda` |
| `docker` | `docker run` | لا (يوجّه إلى docker pull) | يطبع إرشادات الحاوية |
| `unknown` | تعذر الاكتشاف | لا | يحذف المشغّلات ومداخل PATH بقدر الإمكان |

## خيارات المثبت

خيارات `scripts/install.sh` (تمرّر عبر `bash -s --` عند استخدام curl):

| الخيار | السلوك |
|---|---|
| `--branch <branch>` | الاستنساخ أو التحديث من هذا الفرع (الافتراضي: `main`) |
| `--dir <path>` | مجلد مصدر مدار مخصّص |
| `--skip-init` | لا تشغل `estacoda init` بعد البناء |
| `--fhs` | استخدم مسارات FHS: `/usr/local/lib/estacoda` و `/usr/local/bin/estacoda` |
| `-h, --help` | أظهر المساعدة دون تغيير الملفات |

سيوم التهيئة (`scripts/setup-estacoda.sh`) يدعم `--skip-init` و `--help` فقط.

## التحقق

تختبر سيوم التحقق في المستودعات سلوك التثبيت باستخدام بيوت المستخدم والبوائق المؤقتة. لا تكتب على `~/.estacoda` الحقيقي.

```bash
pnpm run validate:install        # الماتريس الكامل
pnpm run validate:source-install # التركيز على مثبت المصدر
pnpm run validate:uninstall      # التركيز على سلوك الإزالة
pnpm run validate:docker         # بناء/تشغيل صورة Docker
pnpm run validate:homebrew       # فحص بناء وصفة Homebrew
pnpm run verify:package-bin      # التحقق من محتويات npm pack
```

تم تجاوز فحوص Docker و Homebrew عندما لا تكون التبعيات متوفرة، إلا إذا تم تعيين `ESTACODA_REQUIRE_DOCKER=1` أو `ESTACODA_REQUIRE_HOMEBREW=1`.

## إصلاح الأعطال

**"Node.js >= 22.18.0 is required"**
ثبّت Node.js 22.18.0 أو أحدث. المثبت لا يقوم بتثبيت Node نيابة عنك.

**"pnpm is required"**فعّل Corepack (`corepack enable`) أو ثبّت pnpm يدويًا.

**"Refusing to overwrite non-empty unmanaged directory"**
المجلد الهدف موجود وليس مختومًا بختم managed-source. اختر مجلدًا آخر عبر `--dir` أو أزل المجلد أولًا.

**"Refusing to update because it is not stamped as this managed-source install"**
المجلد يحتوي على مستودعات git لكن ختم `.install-method.json` لا يطابق URL المصدر والفرع الحالي. هذا يحمي المساهمات من الكتابة فوق الكتابة.

**المشغّل غير موجود على PATH**
المثبت يكتب المشغّل إلى `~/.local/bin/estacoda` (أو `$PREFIX/bin/estacoda` على Termux). أضف مجلد bin إلى PATH إذا لم يكن موجودًا مسبقًا.

## مستندات مرتبطة

- [Quickstart](./quickstart.md) — الوصول إلى أول أمر عمل
- [Uninstall](./uninstall.md) — إزالة EstaCoda بأمان
- [Updating](./updating.md) — سلوك التحديث والتوجيه
- [State and Files](../reference/state-and-files.md) — أماكن تخزين الختم والحالة
