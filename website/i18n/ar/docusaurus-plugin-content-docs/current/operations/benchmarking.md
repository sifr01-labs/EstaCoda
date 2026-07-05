---
title: Benchmarking
description: إرشادات تشغيل Terminal-Bench وSWE-bench بصورة قابلة للإعادة في EstaCoda.
sidebar_position: 2
---

# Benchmarking

Benchmarking هو مسار مشغّل. يستخدم `estacoda bench run` ومحولات Harbor وملفات artifacts؛ ولا يغيّر تجربة EstaCoda CLI العادية.

## الأولوية

استخدم هذا الترتيب:

1. Terminal-Bench local smoke
2. Terminal-Bench Harbor smoke
3. Terminal-Bench full baseline
4. مقارنة Terminal-Bench مع وكيل آخر باستخدام النموذج نفسه
5. SWE-bench Lite smoke
6. SWE-bench Verified baseline
7. GAIA لاحقًا

يأتي Terminal-Bench أولًا لأنه يختبر حلقة الوكيل الطرفية كاملة: استخدام shell، والإعداد، والتصحيح، والتكرار، والتعافي، وتغييرات workspace.

## الفحوصات المحلية

شغّل smoke المحلي الآمن لـ CI:

```bash
pnpm run benchmark:smoke
```

شغّل اختبارات محول Harbor:

```bash
pnpm run benchmark:terminal-bench:adapter-test
```

هذه الفحوصات لا تستدعي نماذج حية ولا تنتج درجات عامة.

للتحقق من artifacts فقط من دون provider credentials، شغّل:

```bash
rm -rf /tmp/estacoda-bench-app /tmp/estacoda-summary.json /tmp/estacoda-events.jsonl
mkdir -p /tmp/estacoda-bench-app

estacoda bench run \
  --instruction-file benchmarks/local-smoke/simple-file-task/instruction.txt \
  --workspace /tmp/estacoda-bench-app \
  --isolated-home \
  --json-output /tmp/estacoda-summary.json \
  --event-log /tmp/estacoda-events.jsonl
```

مع isolated home غير مهيأ، تكون حالة `config_error` صالحة. هذا smoke يتحقق من كتابة artifacts، وشكل schema، وredaction، و`benchmark: null`، ووجود الحقل `estimatedCostUsd` دائمًا. الجواب النهائي متوقع فقط في live smoke مع إعداد provider/model صريح.

إذا لم يكن Harbor متاحًا محليًا، يبقى adapter مغطى باختبارات وحدة وcompile-check. شغّل Harbor one-task وfive-task validation في بيئة تحتوي Harbor قبل نشر نتائج benchmark.

## Terminal-Bench Smoke

قبل التشغيل الكامل، استخدم Harbor smoke صغيرًا: خمس مهام، نموذج واحد، temperature واحدة، ومحاولة واحدة لكل مهمة.

```bash
export ESTACODA_BENCH_MODEL="anthropic/claude-sonnet"
export ESTACODA_BENCH_HOME="/tmp/estacoda-home"

harbor run \
  -d terminal-bench/terminal-bench-2 \
  -a benchmarks.terminal_bench.estacoda_harbor_agent:EstaCodaAgent \
  -n 5
```

الهدف هو إثبات سلامة harness، لا الحصول على score.

## Full Baseline

بعد نجاح smoke، شغّل baseline الكامل لـ Terminal-Bench 2.0 بالإعدادات نفسها:

```bash
export ESTACODA_BENCH_MODEL="anthropic/claude-sonnet"
export ESTACODA_BENCH_HOME="/tmp/estacoda-home"
export ESTACODA_BENCH_TEMPERATURE="0"

harbor run \
  -d terminal-bench/terminal-bench-2 \
  -a benchmarks.terminal_bench.estacoda_harbor_agent:EstaCodaAgent
```

أبلِغ عن:

- إصدار EstaCoda وgit commit
- model provider وmodel id
- اسم benchmark وإصداره
- عدد المهام وعدد المحاولات
- temperature وإعداد max tokens
- pass rate
- median wall-clock time
- median estimated cost per task
- median provider calls وtool calls لكل مهمة
- الأمر الدقيق ومتغيرات البيئة

استخدم صياغة محافظة: baseline مبكر، وليس ادعاء leaderboard.

## قاعدة المقارنة

قارِن:

```text
same model in EstaCoda
vs
same model in another baseline agent
```

لا تصغ النتيجة باعتبارها EstaCoda ضد نموذج. الهدف هو عزل قيمة runtime.

## لا تضبط السلوك لأجل benchmark

بعد smoke ذي الخمس مهام، أصلح فقط أخطاء harness أو runtime. لا تضف prompts خاصة بالمهام، أو فروعًا على أسماء المهام، أو أدوات benchmark-only، أو حالات خاصة لـ Terminal-Bench.

## Artifacts

استخدم `--out <dir>` كالنمط المختصر canonical لـ artifacts. يمكن لـ harnesses التي تحتاج مسارات دقيقة تمرير `--json-output <path>` و`--event-log <path>` بدلًا من ذلك؛ ويبقى `stdout` و`stderr` عبر `--out` أو artifact directory الافتراضي المشتق.

يكتب كل `estacoda bench run`:

| Artifact | المعنى |
|---|---|
| `summary.json` | run manifest يحتوي benchmark identity وEstaCoda identity وحالة التنفيذ وإعدادات النموذج والمقاييس ومسارات artifacts والجواب النهائي وتفاصيل الفشل |
| `events.ndjson` أو مسار `--event-log` الصريح | stream أحداث runtime بعد redaction |
| `stdout.txt` | ملخص تشغيل وجواب نهائي بعد redaction |
| `stderr.txt` | رسالة فشل بعد redaction عند وجودها |

الحقل `estimatedCostUsd` موجود دائمًا وقد يكون `null`.

## العزل

يستخدم benchmark mode سياسة `container-benchmark`:

- workspace صريح
- workspace trust محصور بهذا التشغيل
- لا توجد interactive approval prompts
- hard-deny command floor يبقى فعالًا
- لا وصول إلى real user home إلا إذا مُرّر صراحة
- لا memory أو session carryover افتراضيًا
- artifacts بعد redaction افتراضيًا

استخدم `/tmp/estacoda-home` أو isolated-home الافتراضي في المحول للتشغيلات العامة. لا تستخدم real `~/.estacoda` home لـ benchmarks قابلة للإعادة.

## SWE-bench لاحقًا

شغّل SWE-bench بعد Terminal-Bench. ابدأ بـ SWE-bench Lite، ثم SWE-bench Verified عندما تصبح EstaCoda موثوقة في فحص issues وrepos، وتعديل الملفات، وتشغيل الاختبارات، وإنتاج diffs نهائية، وتجنب التغييرات غير المتعلقة.
