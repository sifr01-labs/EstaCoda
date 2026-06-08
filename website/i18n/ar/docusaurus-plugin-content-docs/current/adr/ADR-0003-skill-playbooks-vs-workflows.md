---
title: ADR-0003 المهارات الاستشارية مقابل Workflow
description: المهارات الاستشارية المبنية على Markdown أولًا والتنظيم المُنفذ الدائم عبر Workflow.
sidebar_position: 3
---

# ADR-0003: Skill Playbooks vs Durable Workflows Boundary

**الحالة:** مقبول
**التاريخ:** 2026-05-03
**النطاق:** المهارات، سير العمل، Runtime

---

## السياق

تُعلّم المهارات سير العمل من خلال تعليمات Markdown. بعض سير العمل تحتاج ضمانات (الشحن، النشر، المدفوعات). أخرى تحتاج مرونة (البحث، الهندسة المعمارية، التصحيح). نموذج واحد لا يخدم كلا الاحتياجين بشكل جيد.

## القرار

تبقى المهارات **Markdown-first واستشارية**. يعلّم skill playbook الوكيل تسلسلاً جيداً؛ اختيار المهارة العادي داخل AgentLoop لا ينشئ تشغيل Workflow دائماً.

Workflow هو نظام التشغيل الدائم. يدخل إليه المشغل صراحة:

```bash
/workflow begin <objective>
/workflow begin --skill <skillName> <objective>
estacoda workflow begin --session <sessionId> <objective>
estacoda workflow begin --skill <skillName> --session <sessionId> <objective>
```

تتطلب تشغيلات Workflow الدائمة:

- Step state
- Dependency resolution
- Failure handling
- Resume behavior
- Cancellation
- Approval gates
- Artifact recording
- Validation hooks

الانقسام:

- Skill playbook = advisory authoring surface
- `convertSkillPlaybookToWorkflowPlan()` = explicit bridge من skill playbook مسمى إلى `WorkflowPlan`
- Tool planner = dependency-aware execution
- Workflow = durable orchestration with persisted state and operator controls

## البدائل المرفوضة

1. **All skills as rigid mini-programs** — مرفوض. يقتل المرونة للمهام الثقيلة على التقدير.
2. **No enforcement at all** — مرفوض. غير آمن لسير العمل التشغيلية.
3. **Skill-level enforcement only** — مرفوض. التنفيذ ينتمي إلى Runtime، لا إلى التأليف.

## العواقب

- v0.7 يدعم سير عمل المهارات الاستشارية.
- v0.8 يُدخل Workflow begin الصريح للتنظيم الدائم.
- المهارات لا تصبح لغة برمجة.
- لا يوجد automatic workflow promotion، ولا complex-request auto-detection، ولا اختصار `--use-selected-playbook`.

## الأثر التشغيلي

**الحدود التي يُنشئها:**
- توفر المهارات الاستشارية توجيهًا دون ضمان ترتيب التنفيذ. قد يتخطى الوكيل أو يعيد ترتيب أو يعيد تفسير الخطوات.
- تُنفذ تشغيلات Workflow الصريحة عبر Workflow، الذي يسجل كل خطوة، ويُنفذ الانتقالات، ويحظر التغييرات غير القانونية.

**الملفات والأوامر والأنظمة الفرعية المتأثرة:**
- `estacoda skills list` — استعراض المهارات المتاحة
- `estacoda skills view <name>` — قراءة محتوى SKILL.md كامل
- `estacoda workflow` — أوامر مشغل Workflow
- `src/skills/skill-loader.ts` — تحليل وتحقق المهارات
- `src/workflow/` — محرك التنظيم الدائم
- `src/tools/tool-call-planner.ts` — التخطيط للتنفيذ مع مراعاة التبعيات

**ما يجب على المشرفين الحفاظ عليه:**
- يجب أن يبقى حد playbook/Workflow صريحاً. لا يجب ترقية skill playbook صامتاً إلى سلوك Workflow دائم.
- يجب أن تبقى انتقالات حالة Workflow صارمة. الانتقالات غير القانونية تُطلق `IllegalTransitionError`؛ تخفيف هذا يُفسد ضمانات التنفيذ.
- يجب أن تبقى قوالب المهارات Markdown-first. تحويل المهارات إلى DSL سينتهك القرار.

**ما يمنعه من الفشل أو الانحراف:**
- فرض ترتيب خطوات صارم على المهام الثقيلة على التقدير.
- السماح للوكيل بتخطي خطوات الأمان في سير العمل التشغيلية.
- انتفاخ المهارات حيث يحاول كل سير عمل أن يكون استشاريًا ومُنفذًا في آن واحد.

**ما هو خارج القرار عن قصد:**
- اختيار وضع Workflow تلقائياً أو automatic workflow promotion.
- منشئ سير عمل بصري. التأليف يبقى قائمًا على النص.
- تكوين سير العمل عبر المهارات. Workflow ينتمي إلى مهارة واحدة أو طبقة تكوين صريحة.

## صفحات ذات صلة

- [المهارات](../user-guide/skills.md)
- [Workflow CLI](../reference/cli-commands.md)
- [ADR-0006: آلة حالة Workflow](./ADR-0006-workflow-state-machine.md)
