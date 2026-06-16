# Pull Request

Arabic is welcome in free-text sections. Keep commands, flags, URLs, environment variables, and file paths in English.

يمكنك كتابة الأقسام النصية بالعربية أو الإنجليزية. أبقِ الأوامر والخيارات والروابط ومتغيرات البيئة ومسارات الملفات باللغة الإنجليزية.

## Problem / motivation — المشكلة أو الدافع

What problem, limitation, risk, or user need does this PR address?

ما المشكلة أو القيد أو الخطر أو حاجة المستخدم التي يعالجها هذا الطلب؟

```text

```

Related issue, discussion, or plan, if applicable:

رابط المشكلة أو النقاش أو الخطة المرتبطة، إن وجد:

```text

```

## Summary — الملخص

Describe what this PR changes and why the chosen approach is appropriate.

اشرح ما الذي يغيّره هذا الطلب ولماذا هذا النهج مناسب.

```text

```

## Type of change — نوع التغيير

Select all that apply.

اختر كل ما ينطبق.

- [ ] Bug fix — إصلاح خطأ
- [ ] New feature — ميزة جديدة
- [ ] Refactor — إعادة تنظيم داخلية
- [ ] Documentation — توثيق
- [ ] Tests or evaluation — اختبارات أو تقييم
- [ ] Security hardening — تحسينات أمنية
- [ ] CI, build, or tooling — CI أو بناء أو أدوات
- [ ] Skill, tool, provider, or gateway change — تغيير في مهارة أو أداة أو مزود أو بوابة رسائل
- [ ] Other — آخر

## Area touched — المنطقة المتأثرة

Select all that apply.

اختر كل ما ينطبق.

- [ ] Agent loop or runtime — حلقة الوكيل أو وقت التشغيل
- [ ] Intent routing — توجيه النوايا
- [ ] Tools or tool execution — الأدوات أو تنفيذ الأدوات
- [ ] Skills or skill evolution — المهارات أو تطور المهارات
- [ ] Providers or model routing — المزودون أو توجيه النماذج
- [ ] Security, approvals, sandboxing, or trust model — الأمن أو الموافقات أو العزل أو نموذج الثقة
- [ ] Memory or persistence — الذاكرة أو التخزين الدائم
- [ ] CLI or setup — CLI أو الإعداد
- [ ] Gateway or messaging integration — البوابة أو تكامل الرسائل
- [ ] Documentation — التوثيق
- [ ] Tests, smoke checks, or evaluation harness — الاختبارات أو فحوصات smoke أو منظومة التقييم
- [ ] Build, packaging, or CI — البناء أو التغليف أو CI
- [ ] Website or docs site — الموقع أو موقع التوثيق
- [ ] Arabic, bidi, or localization — العربية أو اتجاه النص أو التوطين
- [ ] Other — آخر

## Agent involvement — مساهمة الوكيل

Disclose whether an AI coding agent contributed to this PR.

وضّح ما إذا كان وكيل ذكاء اصطناعي قد ساهم في هذا الطلب.

- [ ] No AI coding agent was used — لم يُستخدم وكيل ذكاء اصطناعي
- [ ] AI coding agent assisted with planning only — ساعد الوكيل في التخطيط فقط
- [ ] AI coding agent wrote or modified code — كتب الوكيل أو عدّل كودًا
- [ ] AI coding agent wrote or modified documentation — كتب الوكيل أو عدّل توثيقًا
- [ ] AI coding agent generated tests or evaluation cases — أنشأ الوكيل اختبارات أو حالات تقييم

Agent, model, or tooling used, if applicable:

اسم الوكيل أو النموذج أو الأداة المستخدمة، إن وجد:

```text
Example: EstaCoda with OpenRouter/Kimi; Claude Code; Codex CLI
```

Human review performed:

المراجعة البشرية المنجزة:

- [ ] I reviewed every changed file — راجعت كل ملف تغيّر
- [ ] I reviewed security-sensitive changes manually — راجعت التغييرات الحساسة أمنيًا يدويًا
- [ ] I removed or rejected speculative agent changes — أزلت أو رفضت تغييرات الوكيل التخـمينية
- [ ] I verified the implementation matches the requested scope — تحققت أن التنفيذ يطابق النطاق المطلوب

## Security review — المراجعة الأمنية

Does this PR affect any security-sensitive surface?

هل يؤثر هذا الطلب في أي سطح حساس أمنيًا؟

- [ ] No — لا
- [ ] Command execution — تنفيذ الأوامر
- [ ] File read/write/delete behavior — قراءة أو كتابة أو حذف الملفات
- [ ] Path handling or symlink behavior — التعامل مع المسارات أو الروابط الرمزية
- [ ] Secrets, credentials, environment variables, or redaction — الأسرار أو بيانات الاعتماد أو متغيرات البيئة أو الإخفاء
- [ ] Approval flow or workspace trust — مسار الموافقات أو ثقة مساحة العمل
- [ ] Skill loading, skill patches, or skill promotion — تحميل المهارات أو ترقيعاتها أو اعتمادها
- [ ] Provider input/output handling — التعامل مع مدخلات أو مخرجات المزود
- [ ] Gateway, Telegram, remote control, or external access — البوابة أو Telegram أو التحكم عن بعد أو الوصول الخارجي
- [ ] Memory, persistence, or learned behavior — الذاكرة أو التخزين الدائم أو السلوك المتعلّم
- [ ] Dependency, package, or supply-chain behavior — الاعتماديات أو الحزم أو سلسلة التوريد

Security notes, if applicable:

ملاحظات أمنية، إن وجدت:

```text
Risk:
Trust boundary affected:
Why this is safe:
Rollback or recovery path:
```

## Testing and validation — الاختبار والتحقق

Paste the exact commands or manual checks that were run.

الصق الأوامر الفعلية أو الفحوصات اليدوية التي تم تشغيلها.

Commands run:

الأوامر التي تم تشغيلها:

```bash

```

Manual validation, if any:

التحقق اليدوي، إن وجد:

```text

```

Skipped checks and reason:

الفحوصات التي تم تجاوزها والسبب:

```text
Example: Docs-only change; runtime checks not applicable.
```

Expected standard validation for runtime changes:

التحقق القياسي المتوقع لتغييرات وقت التشغيل:

```bash
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run test
pnpm run smoke
pnpm run build
pnpm run audit:runtime-imports
pnpm run audit:esm
pnpm run smoke:dist
git diff --check
```

Results:

النتائج:

- [ ] Node and pnpm versions match the supported runtime contract — إصدارات Node و pnpm تطابق عقد وقت التشغيل المدعوم
- [ ] Frozen pnpm install passed — نجح تثبيت pnpm المجمّد
- [ ] Typecheck passed — نجح فحص الأنواع
- [ ] Unit tests passed — نجحت اختبارات الوحدة
- [ ] Source smoke checks passed — نجحت فحوصات smoke للمصدر
- [ ] Build and dist smoke checks passed — نجح البناء وفحوصات smoke للتوزيعة
- [ ] Runtime import and emitted ESM audits passed — نجحت فحوصات استيراد وقت التشغيل و ESM الناتج
- [ ] Whitespace/diff check passed — نجح فحص المسافات والفروقات
- [ ] Tests were added or updated where needed — أُضيفت أو حُدّثت الاختبارات عند الحاجة
- [ ] No real provider API calls are required for tests — لا تتطلب الاختبارات استدعاءات API حقيقية للمزودين
- [ ] No secrets or local environment files are committed — لا توجد أسرار أو ملفات بيئة محلية مضافة
- [ ] Not applicable; explained above — غير منطبق، وتم توضيح السبب أعلاه

Conditional validation, if applicable:

تحقق إضافي مشروط، إن انطبق:

- [ ] Install/update/uninstall validation run — تم تشغيل تحقق التثبيت أو التحديث أو الإزالة
- [ ] Packaging validation run — تم تشغيل تحقق التغليف
- [ ] Docker validation run — تم تشغيل تحقق Docker
- [ ] Provider tool-calling check run — تم تشغيل فحص استدعاء أدوات المزود
- [ ] Fresh-shell/manual CLI test performed — تم اختبار CLI يدويًا من shell جديدة
- [ ] Gateway or messaging behavior tested — تم اختبار سلوك البوابة أو الرسائل
- [ ] Security-sensitive behavior tested with safe fixtures — تم اختبار السلوك الحساس أمنيًا ببيانات آمنة
- [ ] Not applicable — غير منطبق

## Documentation — التوثيق

- [ ] Documentation is not needed for this change — لا يحتاج هذا التغيير إلى توثيق
- [ ] README updated — تم تحديث README
- [ ] CONTRIBUTING updated — تم تحديث CONTRIBUTING
- [ ] SECURITY updated — تم تحديث SECURITY
- [ ] AGENTS updated — تم تحديث AGENTS
- [ ] docs/ updated — تم تحديث docs/
- [ ] website/docs/ updated — تم تحديث website/docs/
- [ ] Arabic/i18n docs updated or not applicable — تم تحديث توثيق العربية/i18n أو لا ينطبق
- [ ] Comments or inline explanations added where useful — أُضيفت تعليقات أو شروحات داخلية عند الحاجة

## Breaking changes — تغييرات كاسرة

Does this PR introduce a breaking change?

هل يقدّم هذا الطلب تغييرًا كاسرًا؟

- [ ] No — لا
- [ ] Yes — نعم

If yes, describe the impact and migration path:

إذا كانت الإجابة نعم، اشرح التأثير ومسار الانتقال:

```text

```

## Screenshots, logs, or artifacts — لقطات شاشة أو سجلات أو مخرجات

Add screenshots, terminal output, logs, traces, or artifact paths if they help reviewers verify the change.

أضف لقطات شاشة أو مخرجات الطرفية أو سجلات أو آثار تشغيل أو مسارات مخرجات إذا كانت تساعد المراجعين على التحقق من التغيير.

```text

```

## Checklist — قائمة المراجعة

- [ ] PR is narrowly scoped — نطاق الطلب محدود وواضح
- [ ] No unrelated formatting churn — لا توجد تغييرات تنسيق غير مرتبطة
- [ ] No generated files committed unless intentional — لا توجد ملفات مولّدة مضافة إلا إذا كان ذلك مقصودًا
- [ ] No `node_modules/`, `.env`, logs, build output, or local machine files committed — لا توجد `node_modules/` أو `.env` أو سجلات أو مخرجات بناء أو ملفات محلية مضافة
- [ ] New behavior has tests, smoke coverage, or clear manual validation — السلوك الجديد لديه اختبارات أو فحوصات smoke أو تحقق يدوي واضح
- [ ] Error handling is explicit — التعامل مع الأخطاء واضح
- [ ] User-facing behavior is documented where relevant — السلوك الظاهر للمستخدم موثق عند الحاجة
- [ ] Security-sensitive behavior is conservative by default — السلوك الحساس أمنيًا محافظ افتراضيًا
- [ ] This PR is ready for maintainer review — هذا الطلب جاهز لمراجعة المشرفين
