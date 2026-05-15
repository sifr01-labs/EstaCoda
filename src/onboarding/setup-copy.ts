import { isolateLtr } from "../ui/bidi.js";

export type SetupCopyLocale = "en" | "ar";

export type SetupCopyRiskSurface =
  | "none"
  | "interface-preference"
  | "workspace-path"
  | "workspace-trust"
  | "provider-selection"
  | "credential-reference"
  | "security-policy"
  | "workflow-learning"
  | "optional-capability"
  | "setup-review"
  | "config-write"
  | "setup-verification"
  | "agent-launch"
  | "config-summary"
  | "config-repair"
  | "varies";

export type SetupCopyEntry = {
  readonly key: string;
  readonly en: string;
  readonly ar: string;
  readonly placeholders: readonly string[];
  readonly ltrPlaceholders: readonly string[];
  readonly riskSurface: SetupCopyRiskSurface;
  readonly mvp: boolean;
  readonly notes?: string;
};

export type SetupCopyResolutionOptions = {
  readonly isolateArabicTechnicalTokens?: boolean;
};

const TECHNICAL_TOKENS = [
  "estacoda setup --advanced --provider <provider> --model <model> --api-key-env <ENV_NAME>",
  "estacoda telegram setup",
  "estacoda browser setup",
  "estacoda setup --advanced",
  "chmod 600 ~/.estacoda/.env",
  "/workspace.trust.grant",
  "estacoda verify",
  "estacoda setup",
  "EstaCoda",
  "Telegram",
  "package.json",
  "~/.estacoda/.env",
  "~/.estacoda",
  "estacoda",
  "0600",
  "API",
] as const;

export const SETUP_COPY_ENTRIES = [
  copy("onboarding.welcome", "Welcome to EstaCoda setup. We'll create a reviewable setup plan before anything is saved.", "أهلاً بك في إعداد EstaCoda. سنضع القواعد قبل أن تبدأ EstaCoda العمل داخل مساحة العمل هذه. لن يُحفظ أي شيء قبل أن تراجعه وتوافق عليه.", [], "none"),
  copy("onboarding.welcome.title", "EstaCoda setup", "إعداد EstaCoda", [], "none"),
  copy("onboarding.common.begin", "Begin", "ابدأ", [], "none"),
  copy("onboarding.welcome.validation.acknowledged", "Confirm to continue setup.", "أكّد للمتابعة في الإعداد.", [], "none"),
  copy("onboarding.interfaceLanguage", "Choose the setup language and how EstaCoda speaks while working. Same engine, different style.", "اختر لغة الإعداد وكيف تتحدث EstaCoda أثناء العمل. نفس المحرك، أسلوب مختلف.", [], "interface-preference"),
  copy("onboarding.interfaceLanguage.title", "Setup language", "لغة الإعداد", [], "interface-preference"),
  copy("onboarding.interfaceLanguage.options.en.label", "English", "English", [], "interface-preference"),
  copy("onboarding.interfaceLanguage.options.en.description", "Use English setup copy.", "استخدم نصوص الإعداد الإنجليزية.", [], "interface-preference"),
  copy("onboarding.interfaceLanguage.options.ar.label", "العربية", "العربية", [], "interface-preference"),
  copy("onboarding.interfaceLanguage.options.ar.description", "Use Arabic setup copy with isolated technical tokens.", "استخدم نصوص الإعداد العربية مع عزل الرموز التقنية.", [], "interface-preference"),
  copy("onboarding.interfaceLanguage.validation.languageSelected", "Choose a setup language.", "اختر لغة الإعداد.", [], "interface-preference"),
  copy("onboarding.interfaceStyle.title", "Interface style", "أسلوب الواجهة", [], "interface-preference"),
  copy("onboarding.interfaceStyle.prompt", "Choose the default interface style.", "اختر أسلوب الواجهة الافتراضي.", [], "interface-preference"),
  copy("onboarding.interfaceStyle.standard.label", "Standard", "قياسي", [], "interface-preference"),
  copy("onboarding.interfaceStyle.standard.description", "Plain English runtime labels.", "تسميات تشغيل إنجليزية واضحة.", [], "interface-preference"),
  copy("onboarding.interfaceStyle.arabicLight.label", "Arabic-light", "عربي خفيف", [], "interface-preference"),
  copy("onboarding.interfaceStyle.arabicLight.description", "Arabic labels with stable technical tokens.", "تسميات عربية مع رموز تقنية مستقرة.", [], "interface-preference"),
  copy("onboarding.interfaceStyle.arabicStandard.description", "Standard interface style with Arabic setup copy.", "أسلوب واجهة قياسي مع نصوص إعداد عربية.", [], "interface-preference"),
  copy("onboarding.interfaceStyle.englishArabicLight.description", "English setup copy with Arabic-light visual flavor.", "نصوص إعداد إنجليزية مع لمسة بصرية عربية خفيفة.", [], "interface-preference"),
  copy("onboarding.workspace.root", "Select the workspace EstaCoda should use.", "اختر مساحة العمل التي ستعمل فيها EstaCoda.", [], "workspace-path"),
  copy("onboarding.workspace.title", "Workspace", "مساحة العمل", [], "workspace-path"),
  copy("onboarding.workspace.root.validation.selected", "Choose a workspace path.", "اختر مسار مساحة العمل.", [], "workspace-path"),
  copy("onboarding.workspace.trust", "Trust this workspace before enabling local tools or saved setup. This allows EstaCoda to read and edit files and run approved terminal commands here.", "ثق بمساحة العمل هذه قبل تفعيل الأدوات المحلية أو حفظ الإعداد. يسمح ذلك لـ EstaCoda بقراءة الملفات وتعديلها وتشغيل أوامر الطرفية الموافق عليها هنا.", [], "workspace-trust"),
  copy("onboarding.workspace.trust.title", "Workspace trust", "ثقة مساحة العمل", [], "workspace-trust"),
  copy("onboarding.workspace.trustAction.label", "Trust workspace", "الثقة بمساحة العمل", [], "workspace-trust"),
  copy("onboarding.workspace.trustAction.description", "Plan an explicit workspace trust grant.", "خطّط لمنح ثقة صريح لمساحة العمل.", [], "workspace-trust"),
  copy("onboarding.workspace.deferTrustAction.label", "Not now", "ليس الآن", [], "workspace-trust"),
  copy("onboarding.workspace.deferTrustAction.description", "Continue planning without granting workspace trust.", "تابع التخطيط دون منح ثقة لمساحة العمل.", [], "workspace-trust"),
  copy("onboarding.workspace.trust.validation.explicit", "Choose clearly whether to trust this workspace. Trust is never silent.", "اختر بوضوح هل تريد الوثوق بمساحة العمل هذه. لا توجد ثقة صامتة.", [], "workspace-trust"),
  copy("onboarding.providers.primary", "Choose the provider EstaCoda should use first when it needs to think.", "اختر المزوّد الذي ستستدعيه EstaCoda أولاً عندما تحتاج إلى التفكير.", [], "provider-selection"),
  copy("onboarding.providers.primary.title", "Primary provider", "المزوّد الأساسي", [], "provider-selection"),
  copy("onboarding.providers.primary.validation.selected", "Choose a primary provider.", "اختر مزوّدًا أساسيًا.", [], "provider-selection"),
  copy("onboarding.providers.primaryModel", "Choose the primary model for {providerId}.", "اختر النموذج الأساسي للمزوّد {providerId}.", ["{providerId}"], "provider-selection"),
  copy("onboarding.providers.primaryModel.title", "Primary model", "النموذج الأساسي", [], "provider-selection"),
  copy("onboarding.providers.primaryModel.validation.selected", "Choose a primary model.", "اختر نموذجًا أساسيًا.", [], "provider-selection"),
  copy("onboarding.providers.primaryCredential", "Store a credential reference, not the secret value. EstaCoda keeps secret values out of review screens.", "احفظ مرجع بيانات الاعتماد، وليس قيمة السر نفسها. تبقي EstaCoda قيم الأسرار خارج شاشات المراجعة.", [], "credential-reference"),
  copy("onboarding.providers.primaryCredential.validation.reference", "Hosted providers need an environment variable reference such as {envVar}.", "المزوّدات المستضافة تحتاج إلى مرجع متغيّر بيئة مثل {envVar}.", ["{envVar}"], "credential-reference"),
  copy("onboarding.providers.primaryCredential.localProviderSkip", "Local provider selected, no hosted API key, no cloud ceremony.", "تم اختيار مزوّد محلي. بلا مفتاح API مستضاف، وبلا طقوس سحابية.", [], "credential-reference"),
  copy("onboarding.catalog.provider.catalogOnly", "Available in the offline catalog; runtime support may require configuration.", "متاح في الفهرس المحلي؛ قد يحتاج دعم التشغيل إلى إعداد إضافي.", [], "provider-selection"),
  copy("onboarding.catalog.provider.configured", "Configured provider.", "مزوّد مهيأ.", [], "provider-selection"),
  copy("onboarding.catalog.provider.available", "Available provider.", "مزوّد متاح.", [], "provider-selection"),
  copy("onboarding.catalog.model.features.tools", "tools", "أدوات", [], "provider-selection"),
  copy("onboarding.catalog.model.features.vision", "vision", "رؤية", [], "provider-selection"),
  copy("onboarding.catalog.model.features.reasoning", "reasoning", "استدلال", [], "provider-selection"),
  copy("onboarding.security", "Choose how command and tool approvals work. This is the line between usefulness and recklessness.", "اختر طريقة عمل موافقات الأوامر والأدوات. هذا هو الخط الفاصل بين الفائدة والتهور.", [], "security-policy"),
  copy("onboarding.security.title", "Security mode", "وضع الأمان", [], "security-policy"),
  copy("onboarding.security.options.adaptive.label", "Adaptive", "تكيّفي", [], "security-policy"),
  copy("onboarding.security.options.adaptive.description", "Keep human approval at sensitive boundaries.", "أبقِ موافقة الإنسان عند الحدود الحساسة.", [], "security-policy"),
  copy("onboarding.security.options.strict.label", "Strict", "صارم", [], "security-policy"),
  copy("onboarding.security.options.strict.description", "Ask more often before tools and commands.", "اطلب الموافقة أكثر قبل الأدوات والأوامر.", [], "security-policy"),
  copy("onboarding.security.options.open.label", "Open", "مفتوح", [], "security-policy"),
  copy("onboarding.security.options.open.description", "Allow more work without prompts. Review carefully.", "اسمح بمزيد من العمل دون مطالبات. راجع بعناية.", [], "security-policy"),
  copy("onboarding.security.validation.selected", "Choose a security mode.", "اختر وضع الأمان.", [], "security-policy"),
  copy("onboarding.workflowLearning", "Choose how EstaCoda suggests reusable workflow improvements or learns them.", "اختر كيف تقترح EstaCoda تحسينات قابلة لإعادة الاستخدام في سير العمل أو تتعلمها.", [], "workflow-learning"),
  copy("onboarding.workflowLearning.title", "Workflow learning", "تعلّم سير العمل", [], "workflow-learning"),
  copy("onboarding.workflowLearning.options.suggest.label", "Suggest", "اقتراح", [], "workflow-learning"),
  copy("onboarding.workflowLearning.options.suggest.description", "Propose reusable workflow improvements for review.", "اقترح تحسينات قابلة لإعادة الاستخدام لمراجعتها.", [], "workflow-learning"),
  copy("onboarding.workflowLearning.options.none.label", "Off", "إيقاف", [], "workflow-learning"),
  copy("onboarding.workflowLearning.options.none.description", "Do not suggest learned workflow changes.", "لا تقترح تغييرات سير عمل متعلّمة.", [], "workflow-learning"),
  copy("onboarding.workflowLearning.options.proactive.label", "Proactive", "استباقي", [], "workflow-learning"),
  copy("onboarding.workflowLearning.options.proactive.description", "Surface more learning opportunities.", "أظهر فرص تعلّم أكثر.", [], "workflow-learning"),
  copy("onboarding.workflowLearning.options.autonomous.label", "Autonomous", "ذاتي", [], "workflow-learning"),
  copy("onboarding.workflowLearning.options.autonomous.description", "Create stronger workflow suggestions where supported; promotion stays reviewable.", "أنشئ اقتراحات أقوى لسير العمل حيث يكون ذلك مدعومًا؛ تبقى الترقية قابلة للمراجعة.", [], "workflow-learning"),
  copy("onboarding.workflowLearning.validation.selected", "Choose a workflow learning mode.", "اختر وضع تعلّم سير العمل.", [], "workflow-learning"),
  copy("onboarding.optionalCapabilities", "Add extra capabilities now, or start light. Skipping them does not weaken core setup.", "أضف القدرات الإضافية الآن، أو ابدأ بتشغيل خفيف. تخطيها لا يضعف الإعداد الأساسي.", [], "optional-capability"),
  copy("onboarding.optionalCapabilities.skipped", "Optional capabilities skipped. Core setup remains valid.", "تم تخطي القدرات الاختيارية. يظل الإعداد الأساسي صالحًا.", [], "optional-capability"),
  copy("onboarding.optionalCapabilities.promptCapability", "Enable {capabilityId}?", "هل تريد تفعيل {capabilityId}؟", ["{capabilityId}"], "optional-capability"),
  copy("onboarding.optionalCapabilities.enable", "Enable", "تفعيل", [], "optional-capability"),
  copy("onboarding.optionalCapabilities.enableDescription", "Plan {capabilityId} as a reviewed optional capability.", "خطّط {capabilityId} كقدرة اختيارية تخضع للمراجعة.", ["{capabilityId}"], "optional-capability"),
  copy("onboarding.optionalCapabilities.skip", "Skip", "تخطي", [], "optional-capability"),
  copy("onboarding.optionalCapabilities.validation.skippable", "Choose capabilities or skip them safely.", "اختر القدرات أو تخطّها بأمان.", [], "optional-capability"),
  copy("onboarding.review", "Review exactly what setup would save before approval. Precision beats surprises.", "راجع بالضبط ما سيحفظه الإعداد قبل الموافقة. الدقة أفضل من المفاجآت.", [], "setup-review"),
  copy("onboarding.review.approveAction", "Approve plan", "الموافقة على الخطة", [], "setup-review"),
  copy("onboarding.review.cancelAction", "Cancel", "إلغاء", [], "setup-review"),
  copy("onboarding.review.validation.accepted", "Approve the review or cancel without saving.", "وافق على المراجعة أو ألغِ دون حفظ.", [], "setup-review"),
  copy("onboarding.save", "Prepare the approved setup for saving. This planning layer does not write files directly.", "جهّز الإعداد الموافق عليه للحفظ. طبقة التخطيط هذه لا تكتب الملفات مباشرة.", [], "config-write"),
  copy("onboarding.save.validation.confirmed", "Confirm save/apply planning.", "أكّد تخطيط الحفظ والتطبيق.", [], "config-write"),
  copy("onboarding.verification", "Run read-only verification after saving. It checks setup without unnecessary device changes.", "يشغّل تحققًا للقراءة فقط بعد الحفظ. يفحص الإعداد دون تدخّل غير ضروري في الجهاز.", [], "setup-verification"),
  copy("onboarding.verification.validation.selected", "Choose whether to verify setup.", "اختر هل تريد التحقق من الإعداد.", [], "setup-verification"),
  copy("setupVerification.title", "EstaCoda verify", "فحص EstaCoda", [], "setup-verification"),
  copy("setupVerification.body", "Checks your local setup, provider route, credential store, workspace trust, and basic tool readiness.", "يتحقق من الإعداد المحلي، ومسار المزوّد، ومخزن المفاتيح، وثقة مجلد العمل، وجاهزية الأدوات الأساسية.", [], "setup-verification"),
  copy("setupVerification.stateDirectory", "State directory", "مجلد الحالة", [], "setup-verification"),
  copy("setupVerification.secretStore", "Secret store", "مخزن المفاتيح", [], "setup-verification"),
  copy("setupVerification.workspaceTrust", "Workspace trust", "ثقة مجلد العمل", [], "workspace-trust"),
  copy("setupVerification.securityMode", "Security mode", "وضع الأمان", [], "security-policy"),
  copy("setupVerification.workflowLearning", "Workflow learning", "تعلّم سير العمل", [], "workflow-learning"),
  copy("setupVerification.readOnlyToolCheck", "Read-only tool check", "فحص أداة القراءة فقط", [], "setup-verification"),
  copy("setupVerification.configSources", "Config sources", "مصادر الإعداد", [], "config-summary"),
  copy("setupVerification.status.writable", "writable", "قابل للكتابة", [], "setup-verification"),
  copy("setupVerification.status.blocked", "blocked", "محظور", [], "setup-verification"),
  copy("setupVerification.status.notPresent", "not present", "غير موجود", [], "setup-verification"),
  copy("setupVerification.status.presentMode", "present ({mode})", "موجود ({mode})", ["{mode}"], "setup-verification"),
  copy("setupVerification.status.skipped", "skipped", "تم التخطي", [], "setup-verification"),
  copy("setupVerification.status.ready", "ready", "جاهز", [], "setup-verification"),
  copy("setupVerification.status.trusted", "trusted", "موثوق", [], "workspace-trust"),
  copy("setupVerification.status.notTrusted", "not trusted", "غير موثوق", [], "workspace-trust"),
  copy("setupVerification.warning.workspaceNotTrusted", "Workspace is not trusted yet; local write/terminal actions will ask first.", "مجلد العمل غير موثوق بعد؛ إجراءات الكتابة والطرفية المحلية ستطلب الموافقة أولاً.", [], "workspace-trust"),
  copy("setupVerification.warning.stateNotWritable", "State directory is not writable.", "مجلد الحالة غير قابل للكتابة.", [], "config-repair"),
  copy("setupVerification.warning.secretMode", "Secret store permissions should be 0600.", "يجب أن تكون صلاحيات مخزن المفاتيح 0600.", [], "credential-reference"),
  copy("setupVerification.warning.readOnlyTool", "Read-only file tool check did not complete.", "لم يكتمل فحص أداة قراءة الملفات.", [], "setup-verification"),
  copy("setupVerification.warning.skippedNoPackageJson", "skipped (no package.json)", "تم التخطي (لا يوجد package.json)", [], "setup-verification"),
  copy("setupVerification.warningsTitle", "Warnings:", "تحذيرات:", [], "setup-verification"),
  copy("setupVerification.nextActionsTitle", "Next actions:", "الخطوات التالية:", [], "setup-verification"),
  copy("setupVerification.statusReady", "Status: ready", "الحالة: جاهز", [], "setup-verification"),
  copy("setupVerification.nextReady", "Next: run estacoda, or configure optional channels with estacoda telegram setup / estacoda browser setup.", "التالي: شغّل estacoda، أو اضبط القنوات الاختيارية عبر estacoda telegram setup / estacoda browser setup.", [], "agent-launch"),
  copy("setupVerification.fallbackNextAction", "Fix the warnings above, then rerun estacoda verify.", "أصلح التحذيرات أعلاه، ثم أعد تشغيل estacoda verify.", [], "setup-verification"),
  copy("setupVerification.actions.providerIncomplete", "Run estacoda setup to choose a provider/model.", "شغّل estacoda setup لاختيار مزوّد ونموذج.", [], "provider-selection"),
  copy("setupVerification.actions.missingApiKey.generic", "Export the missing provider API key, or rerun estacoda setup to store it locally.", "صدّر مفتاح API الناقص، أو أعد تشغيل estacoda setup لحفظه محلياً.", [], "credential-reference"),
  copy("setupVerification.actions.missingApiKey.env", "Export {envVar}, or rerun estacoda setup and choose local secret storage.", "صدّر {envVar}، أو أعد تشغيل estacoda setup واختر تخزين المفتاح محلياً.", ["{envVar}"], "credential-reference"),
  copy("setupVerification.actions.noCredentialPool", "Run estacoda setup --advanced --provider <provider> --model <model> --api-key-env <ENV_NAME>.", "شغّل estacoda setup --advanced --provider <provider> --model <model> --api-key-env <ENV_NAME>.", [], "credential-reference"),
  copy("setupVerification.actions.networkDisabled", "Enable network inference for the selected hosted provider with estacoda setup --advanced.", "فعّل الاستدلال عبر الشبكة للمزوّد المستضاف المختار باستخدام estacoda setup --advanced.", [], "provider-selection"),
  copy("setupVerification.actions.workspaceNotTrusted", "Run /workspace.trust.grant in an interactive session, or rerun estacoda setup and trust this workspace.", "شغّل /workspace.trust.grant داخل جلسة تفاعلية، أو أعد تشغيل estacoda setup ومنح الثقة لهذا المجلد.", [], "workspace-trust"),
  copy("setupVerification.actions.secretPermissions", "Run chmod 600 ~/.estacoda/.env to restrict local secret-store permissions.", "شغّل chmod 600 ~/.estacoda/.env لتقييد صلاحيات مخزن المفاتيح المحلي.", [], "credential-reference"),
  copy("setupVerification.actions.stateNotWritable", "Check write permissions for ~/.estacoda.", "تحقق من صلاحيات الكتابة في ~/.estacoda.", [], "config-repair"),
  copy("setupVerification.actions.readOnlyTool", "Start an interactive session after fixing provider/trust warnings, then retry estacoda verify.", "ابدأ جلسة تفاعلية بعد إصلاح تحذيرات المزوّد/الثقة، ثم أعد تشغيل estacoda verify.", [], "setup-verification"),
  copy("onboarding.launch", "Launch only after verified-ready, or after explicitly accepting limited mode.", "ابدأ التشغيل فقط بعد جاهزية مؤكدة، أو بعد قبول الوضع المحدود صراحةً.", [], "agent-launch"),
  copy("onboarding.launch.preferenceTitle", "Launch preference", "تفضيل التشغيل", [], "agent-launch"),
  copy("onboarding.launch.skipAction.label", "Do not launch", "لا تبدأ التشغيل", [], "agent-launch"),
  copy("onboarding.launch.skipAction.description", "Finish setup planning without a launch handoff.", "أنهِ تخطيط الإعداد دون تسليم تشغيل.", [], "agent-launch"),
  copy("onboarding.launch.offerAction.label", "Offer after verify", "اعرض بعد التحقق", [], "agent-launch"),
  copy("onboarding.launch.offerAction.description", "Plan a launch handoff after verification.", "خطّط لتسليم التشغيل بعد التحقق.", [], "agent-launch"),
  copy("onboarding.launch.validation.explicit", "Choose whether to launch after setup.", "اختر هل تريد التشغيل بعد الإعداد.", [], "agent-launch"),
  copy("setupEditor.summary.configuredReady", "Setup is configured and ready. Review or change the parts worth checking.", "الإعداد مهيأ وجاهز. راجع أو عدّل الأجزاء التي تستحق التدقيق.", [], "config-summary"),
  copy("setupEditor.summary.configuredDegraded", "Setup works with warnings. Review warnings before launch.", "الإعداد يعمل مع تحذيرات. راجع التحذيرات قبل التشغيل.", [], "config-summary"),
  copy("setupEditor.summary.repairFirst", "Repair required setup items before normal editing. No polishing helps a setup that does not work.", "يجب إصلاح عناصر الإعداد المطلوبة قبل التحرير العادي. لا جدوى من تلميع إعداد لا يعمل.", [], "config-repair"),
  copy("setupEditor.sections.configSummary", "Current setup sources and readiness.", "مصادر الإعداد الحالية وحالة الجاهزية.", [], "config-summary"),
  copy("setupEditor.sections.configSafety", "Config cannot be edited normally until it can be parsed safely.", "لا يمكن تحرير الإعدادات بشكل عادي حتى يمكن قراءتها بأمان.", [], "config-repair"),
  copy("setupEditor.sections.stateSafety", "State/config path is not writable. Normal writes are blocked until state write permissions are restored.", "مسار الحالة/الإعداد غير قابل للكتابة. الكتابة العادية محظورة حتى تُستعاد أذونات كتابة الحالة.", [], "config-repair"),
  copy("setupEditor.sections.modelRoute", "Primary provider and model route.", "مسار المزوّد والنموذج الأساسي.", [], "provider-selection"),
  copy("setupEditor.sections.credentials", "Credential references and secret-store status. Secret values stay hidden.", "مراجع بيانات الاعتماد وحالة مخزن الأسرار. تبقى قيم الأسرار مخفية.", [], "credential-reference"),
  copy("setupEditor.sections.securityMode", "Command and tool approval mode.", "وضع موافقات الأوامر والأدوات.", [], "security-policy"),
  copy("setupEditor.sections.workflowLearning", "Workflow learning mode.", "وضع تعلّم سير العمل.", [], "workflow-learning"),
  copy("setupEditor.sections.workspaceTrust", "Workspace trust status. Trust is separate from model readiness.", "حالة ثقة مساحة العمل. الثقة منفصلة عن جاهزية النموذج.", [], "workspace-trust"),
  copy("setupEditor.sections.optionalCapabilities", "Optional capabilities are reviewed independently. Add-ons do not enter core setup through the back door.", "تتم مراجعة القدرات الاختيارية بشكل مستقل. الإضافات لا تدخل الإعداد الأساسي من الباب الخلفي.", [], "optional-capability"),
  copy("setupEditor.sections.verification", "Run read-only verification.", "شغّل تحققًا للقراءة فقط.", [], "setup-verification"),
  copy("setupEditor.sections.exit", "Exit setup without applying changes.", "اخرج من الإعداد دون تطبيق تغييرات.", [], "none"),
  copy("setupEditor.actions.editPrimaryModelRoute", "Edit primary provider/model route.", "عدّل مسار المزوّد/النموذج الأساسي.", [], "provider-selection"),
  copy("setupEditor.actions.repairPrimaryProvider", "Repair primary provider/model setup.", "أصلح إعداد المزوّد/النموذج الأساسي.", [], "provider-selection"),
  copy("setupEditor.actions.editPrimaryCredentialReference", "Edit credential environment variable reference.", "عدّل مرجع متغير البيئة لبيانات الاعتماد.", [], "credential-reference"),
  copy("setupEditor.actions.repairMissingCredential", "Repair missing credential reference {envVar}.", "أصلح مرجع بيانات الاعتماد المفقود {envVar}.", ["{envVar}"], "credential-reference"),
  copy("setupEditor.actions.editSecurityMode", "Edit security mode.", "عدّل وضع الأمان.", [], "security-policy"),
  copy("setupEditor.actions.editWorkflowLearning", "Edit workflow learning mode.", "عدّل وضع تعلّم سير العمل.", [], "workflow-learning"),
  copy("setupEditor.actions.repairWorkspaceTrust", "Review workspace trust grant for {workspacePath}.", "راجع منح الثقة لمساحة العمل {workspacePath}.", ["{workspacePath}"], "workspace-trust"),
  copy("setupEditor.actions.reviewOptionalCapabilities", "Review optional capabilities.", "راجع القدرات الاختيارية.", [], "optional-capability"),
  copy("setupEditor.actions.runReadonlyVerification", "Run read-only verification.", "شغّل التحقق للقراءة فقط.", [], "setup-verification"),
  copy("setupEditor.actions.repairBrokenConfig", "Inspect broken config before normal editing.", "افحص ملف الإعداد المعطّل قبل التحرير العادي.", [], "config-repair"),
  copy("setupEditor.actions.repairStateDirectory", "Repair state directory permissions.", "أصلح أذونات مجلد الحالة.", [], "config-repair"),
  copy("setupEditor.actions.cancelSetupEditor", "Cancel setup editor. No changes are applied.", "ألغِ محرر الإعداد. لن يتم تطبيق أي تغييرات.", [], "none"),
  copy("setupModules.provider.title", "Provider", "المزوّد", [], "provider-selection"),
  copy("setupModules.provider.review", "Provider {providerId} with model {modelId}.", "المزوّد {providerId} مع النموذج {modelId}.", ["{providerId}", "{modelId}"], "provider-selection"),
  copy("setupModules.provider.draft", "Draft provider/model route update.", "مسودة تحديث مسار المزوّد/النموذج.", [], "provider-selection"),
  copy("setupModules.credentials.title", "Credentials", "بيانات الاعتماد", [], "credential-reference"),
  copy("setupModules.credentials.review", "Credential values are not displayed. References: {envVars}.", "لا تُعرض قيم بيانات الاعتماد. المراجع: {envVars}.", ["{envVars}"], "credential-reference"),
  copy("setupModules.credentials.draft", "Draft credential reference update for {envVars}.", "مسودة تحديث مراجع بيانات الاعتماد لـ {envVars}.", ["{envVars}"], "credential-reference"),
  copy("setupModules.workspaceTrust.title", "Workspace Trust", "ثقة مساحة العمل", [], "workspace-trust"),
  copy("setupModules.workspaceTrust.review", "Workspace {workspacePath} requires explicit trust.", "مساحة العمل {workspacePath} تحتاج إلى منح ثقة صريح.", ["{workspacePath}"], "workspace-trust"),
  copy("setupModules.workspaceTrust.draft", "Draft trust grant for {workspacePath} in {trustStorePath}.", "مسودة منح الثقة لـ {workspacePath} داخل {trustStorePath}.", ["{workspacePath}", "{trustStorePath}"], "workspace-trust"),
  copy("setupModules.securityMode.title", "Security Mode", "وضع الأمان", [], "security-policy"),
  copy("setupModules.security-mode.review", "Security mode {securityMode}.", "وضع الأمان {securityMode}.", ["{securityMode}"], "security-policy"),
  copy("setupModules.security-mode.draft", "Security mode {securityMode}.", "وضع الأمان {securityMode}.", ["{securityMode}"], "security-policy"),
  copy("setupModules.workflowLearning.title", "Workflow Learning", "تعلّم سير العمل", [], "workflow-learning"),
  copy("setupModules.workflow-learning.review", "Workflow learning {workflowMode}.", "تعلّم سير العمل {workflowMode}.", ["{workflowMode}"], "workflow-learning"),
  copy("setupModules.workflow-learning.draft", "Workflow learning {workflowMode}.", "تعلّم سير العمل {workflowMode}.", ["{workflowMode}"], "workflow-learning"),
  copy("setupModules.telegram.title", "Telegram", "Telegram", [], "optional-capability"),
  copy("setupModules.telegram.review", "Telegram enabled with token ref {envVar} and allowed identities {identityRefs}. Remote control responds only to the allowlist.", "تم تفعيل Telegram بمرجع الرمز {envVar} والهويات المسموح بها {identityRefs}. التحكم عن بعد لا يستجيب إلا للقائمة المسموح بها.", ["{envVar}", "{identityRefs}"], "optional-capability"),
  copy("setupModules.telegram.draft", "Telegram enabled with token ref {envVar} and allowed identities {identityRefs}. Remote control responds only to the allowlist.", "تم تفعيل Telegram بمرجع الرمز {envVar} والهويات المسموح بها {identityRefs}. التحكم عن بعد لا يستجيب إلا للقائمة المسموح بها.", ["{envVar}", "{identityRefs}"], "optional-capability"),
  copy("setupModules.voice.title", "Voice", "الصوت", [], "optional-capability"),
  copy("setupModules.voice.review", "Review voice provider/model without secret values.", "مراجع مزوّد/نموذج الصوت دون قيم أسرار.", [], "optional-capability"),
  copy("setupModules.voice.draft", "Review voice provider/model without secret values.", "مراجع مزوّد/نموذج الصوت دون قيم أسرار.", [], "optional-capability"),
  copy("setupModules.vision.title", "Vision and Image Generation", "الرؤية وتوليد الصور", [], "optional-capability"),
  copy("setupModules.vision.review", "Vision/image provider {providerId} with model {modelId}.", "مزوّد الرؤية/الصور {providerId} مع النموذج {modelId}.", ["{providerId}", "{modelId}"], "optional-capability"),
  copy("setupModules.vision.draft", "Vision/image provider {providerId} with model {modelId}.", "مزوّد الرؤية/الصور {providerId} مع النموذج {modelId}.", ["{providerId}", "{modelId}"], "optional-capability"),
  copy("setupModules.browser.title", "Browser", "المتصفح", [], "optional-capability"),
  copy("setupModules.browser.review", "Browser backend {browserBackend} is planned. It will not auto-launch during setup planning. Browser remains under control until approved.", "تم تخطيط واجهة المتصفح {browserBackend}. لن يتم تشغيلها تلقائيًا أثناء تخطيط الإعداد. يبقى المتصفح تحت السيطرة حتى تتم الموافقة.", ["{browserBackend}"], "optional-capability"),
  copy("setupModules.browser.draft", "Browser backend {browserBackend} is planned. It will not auto-launch during setup planning. Browser remains under control until approved.", "تم تخطيط واجهة المتصفح {browserBackend}. لن يتم تشغيلها تلقائيًا أثناء تخطيط الإعداد. يبقى المتصفح تحت السيطرة حتى تتم الموافقة.", ["{browserBackend}"], "optional-capability"),
  copy("setupModules.{moduleId}.blocked", "{moduleId} cannot produce normal drafts until config is repaired.", "لا يمكن لـ {moduleId} إنشاء مسودات عادية حتى يتم إصلاح الإعدادات.", ["{moduleId}"], "config-repair"),

  copy("setupReview.diagnostic", "Diagnostic item.", "عنصر تشخيص.", [], "config-repair"),
  copy("setupReview.title", "Review manifest.", "بيان المراجعة.", [], "setup-review"),
  copy("setupReview.empty", "No setup changes were drafted.", "لم تُنشأ مسودات تغييرات للإعداد.", [], "setup-review"),
  copy("setupReview.itemFallback", "Review item.", "عنصر مراجعة.", [], "setup-review"),
  copy("setupReview.bundleBlocker.summary", "Blocker: {blocker}", "مانع: {blocker}", ["{blocker}"], "config-repair"),
  copy("setupReview.bundleWarning.summary", "Warning: {warning}", "تحذير: {warning}", ["{warning}"], "config-repair"),
  copy("setupReview.sections.filesToWriteUpdate", "Files to write or update.", "ملفات ستكتب أو تُحدّث.", [], "config-write"),
  copy("setupReview.sections.secretRefsToStore", "Secret references to store. Values are not shown.", "مراجع الأسرار التي ستُحفظ. لا تُعرض القيم.", [], "credential-reference"),
  copy("setupReview.sections.workspaceTrustGrants", "Workspace trust grants or repairs.", "منح أو إصلاح ثقة مساحة العمل.", [], "workspace-trust"),
  copy("setupReview.sections.providerModelNetwork", "Provider, model, and network changes.", "تغييرات المزوّد والنموذج والشبكة.", [], "provider-selection"),
  copy("setupReview.sections.enabledOptionalCapabilities", "Enabled optional capabilities.", "القدرات الاختيارية المفعّلة.", [], "optional-capability"),
  copy("setupReview.sections.remoteControlSurfaces", "Remote-control surfaces and allowed identities.", "واجهات التحكم عن بعد والهويات المسموح بها.", [], "optional-capability"),
  copy("setupReview.sections.securityMode", "Security mode.", "وضع الأمان.", [], "security-policy"),
  copy("setupReview.sections.workflowLearning", "Workflow learning mode.", "وضع تعلّم سير العمل.", [], "workflow-learning"),
  copy("setupReview.sections.verificationChecks", "Read-only verification checks.", "فحوصات تحقق للقراءة فقط.", [], "setup-verification"),
  copy("setupReview.sections.launchHandoff", "Launch handoff preference.", "تفضيل تسليم التشغيل.", [], "agent-launch"),
  copy("setupReview.sections.blockers", "Blockers that must be resolved before apply.", "موانع يجب حلّها قبل التطبيق.", [], "config-repair"),
  copy("setupReview.sections.warnings", "Warnings to review before apply.", "تحذيرات يجب مراجعتها قبل التطبيق.", [], "varies"),
  copy("setupDrafts.review", "Review setup draft.", "راجع مسودة الإعداد.", [], "varies"),
  copy("setupDrafts.providerModelRoute.summary", "Update provider/model route to {providerId} / {modelId}.", "حدّث مسار المزوّد/النموذج إلى {providerId} / {modelId}.", ["{providerId}", "{modelId}"], "provider-selection"),
  copy("setupDrafts.credentialReference.summary", "Store credential env-var reference {envVar} only.", "احفظ مرجع متغير البيئة {envVar} فقط.", ["{envVar}"], "credential-reference"),
  copy("setupDrafts.workspaceTrust.summary", "Grant trust for {workspacePath} in {trustStorePath}.", "امنح الثقة لـ {workspacePath} داخل {trustStorePath}.", ["{workspacePath}", "{trustStorePath}"], "workspace-trust"),
  copy("setupDrafts.securityMode.summary", "Set security mode to {securityMode}.", "اضبط وضع الأمان على {securityMode}.", ["{securityMode}"], "security-policy"),
  copy("setupDrafts.workflowLearning.summary", "Set workflow learning to {workflowMode}.", "اضبط تعلّم سير العمل على {workflowMode}.", ["{workflowMode}"], "workflow-learning"),
  copy("setupDrafts.optionalCapabilities.summary", "Configure optional capabilities {capabilities}.", "اضبط القدرات الاختيارية {capabilities}.", ["{capabilities}"], "optional-capability"),
  copy("setupDrafts.verification.summary", "Request read-only verification.", "اطلب تحققًا للقراءة فقط.", [], "setup-verification"),
  copy("setupDrafts.launch.summary", "Launch preference: {launchPreference}.", "تفضيل التشغيل: {launchPreference}.", ["{launchPreference}"], "agent-launch"),
  copy("setupDrafts.exit.summary", "Exit without applying setup changes.", "اخرج دون تطبيق تغييرات الإعداد.", [], "none"),
  copy("setupDrafts.brokenConfig.summary", "Normal editing is blocked until config is repaired.", "التحرير العادي محظور حتى يتم إصلاح الإعدادات.", [], "config-repair"),
  copy("setupDrafts.stateDirectory.summary", "Normal editing is blocked until the state directory is writable.", "التحرير العادي محظور حتى يصبح مجلد الحالة قابلًا للكتابة.", [], "config-repair"),

  copy("setupApply.review.approved", "Review approved. An apply plan can be prepared without executing it.", "تمت الموافقة على المراجعة. يمكن تجهيز خطة تطبيق دون تنفيذ.", [], "setup-review"),
  copy("setupApply.review.cancelled", "Review cancelled. No apply plan, config write, or trust grant will be created.", "أُلغيت المراجعة. لن تُنشأ خطة تطبيق أو كتابة إعدادات أو منح ثقة.", [], "none"),
  copy("setupApply.review.blocked", "Review is blocked by {blockerCount} item(s).", "المراجعة محظورة بسبب {blockerCount} عنصر/عناصر.", ["{blockerCount}"], "config-repair"),
  copy("setupApply.plan.ready", "Dry-run apply plan prepared from structured review data.", "تم تجهيز خطة تطبيق دون تنفيذ من بيانات مراجعة منظمة.", [], "config-write"),
  copy("setupApply.operations.configPatch", "Scoped config patch for {scope} in {configPath}.", "تعديل إعدادات محدود لـ {scope} داخل {configPath}.", ["{scope}", "{configPath}"], "config-write"),
  copy("setupApply.operations.credentialReference", "Credential reference operation for {envVar}.", "عملية مرجع بيانات اعتماد لـ {envVar}.", ["{envVar}"], "credential-reference"),
  copy("setupApply.operations.workspaceTrustGrant", "Explicit workspace trust grant for {workspacePath}.", "منح ثقة صريح لمساحة العمل {workspacePath}.", ["{workspacePath}"], "workspace-trust"),
  copy("setupApply.operations.verificationRequest", "Post-save verification request is read-only.", "طلب التحقق بعد الحفظ للقراءة فقط.", [], "setup-verification"),
  copy("setupApply.operations.launchHandoff", "Launch handoff requires verified readiness or explicit limited-mode acceptance.", "تسليم التشغيل يتطلب جاهزية مؤكدة أو قبولًا صريحًا للوضع المحدود.", [], "agent-launch"),
  copy("setupApply.endState.saveFailed", "Save failed: {error}. Verification or launch will not continue.", "فشل الحفظ: {error}. لن يستمر التحقق أو التشغيل.", ["{error}"], "config-write"),
  copy("setupApply.endState.verifiedReady", "Verification passed. Setup is ready.", "نجح التحقق. الإعداد جاهز.", [], "setup-verification"),
  copy("setupApply.endState.verifiedDegraded", "Verification completed with warnings. Continue only with an explicit limited-mode decision.", "اكتمل التحقق مع تحذيرات. تابع فقط بقرار صريح للوضع المحدود.", [], "setup-verification"),
  copy("setupApply.endState.verificationBlocked", "Verification blocked setup because of {blocker}. Launch will not continue.", "أوقف التحقق الإعداد بسبب: {blocker}. لن يستمر التشغيل.", ["{blocker}"], "setup-verification"),
  copy("setupApply.endState.savedNotLaunched", "Setup prepared without launch handoff.", "تم تجهيز الإعداد دون تسليم للتشغيل.", [], "agent-launch"),
  copy("setupApply.endState.launched", "Launch handoff accepted.", "تم قبول تسليم التشغيل.", [], "agent-launch"),
  copy("setupApply.endState.acceptedDegraded", "Limited mode accepted for launch.", "تم قبول الوضع المحدود للتشغيل.", [], "agent-launch"),
  copy("setupApply.repairRequired", "Repair required before normal apply.", "الإصلاح مطلوب قبل التطبيق العادي.", [], "config-repair"),

  copy("setupValidation.provider.invalid", "Provider {providerId} is not available.", "المزوّد {providerId} غير متاح.", ["{providerId}"], "provider-selection"),
  copy("setupValidation.model.invalid", "Model {modelId} is not available for provider {providerId}.", "النموذج {modelId} غير متاح للمزوّد {providerId}.", ["{modelId}", "{providerId}"], "provider-selection"),
  copy("setupValidation.credential.missing", "Missing credential environment variable {envVar}.", "متغير بيئة بيانات الاعتماد {envVar} مفقود.", ["{envVar}"], "credential-reference"),
  copy("setupValidation.secret.permissionsUnsafe", "Secret store {envPath} should use mode {expectedMode}.", "يجب أن يستخدم مخزن الأسرار {envPath} الوضع {expectedMode}.", ["{envPath}", "{expectedMode}"], "credential-reference"),
  copy("setupValidation.workspace.untrusted", "Workspace {workspacePath} is not trusted.", "مساحة العمل {workspacePath} غير موثوقة.", ["{workspacePath}"], "workspace-trust"),
  copy("setupValidation.state.notWritable", "State path {statePath} is not writable.", "مسار الحالة {statePath} غير قابل للكتابة.", ["{statePath}"], "config-repair"),
  copy("setupValidation.config.broken", "Config {configPath} could not be parsed safely.", "تعذّرت قراءة ملف الإعداد {configPath} بأمان.", ["{configPath}"], "config-repair"),
  copy("setupValidation.provider.degraded", "Provider {providerId} is configured with warnings.", "المزوّد {providerId} مهيّأ مع تحذيرات.", ["{providerId}"], "provider-selection"),
  copy("setupValidation.terminal.bidiWarning", "Some Arabic terminal output may mix with technical tokens. Tokens stay isolated so lines do not become visual archaeology.", "قد يمزج بعض خرج الطرفية العربية مع رموز تقنية. ستبقى الرموز معزولة حتى لا يتحول السطر إلى تنقيب أثري.", [], "interface-preference"),
  copy("setupValidation.capability.unavailable", "Capability {capabilityId} is unavailable or incomplete.", "القدرة {capabilityId} غير متاحة أو غير مكتملة.", ["{capabilityId}"], "optional-capability"),
  copy("setupValidation.capability.skipped", "Optional capability {capabilityId} skipped. Core setup is not limited.", "تم تخطي القدرة الاختيارية {capabilityId}. الإعداد الأساسي ليس محدودًا.", ["{capabilityId}"], "optional-capability"),
  copy("setupValidation.cancel.noMutation", "Cancelled. No config, secret, trust-store, or state mutation was planned.", "تم الإلغاء. لم يتم تخطيط أي تغيير في الإعدادات أو الأسرار أو مخزن الثقة أو الحالة.", [], "none"),
  copy("setupValidation.secret.rawValueBlocked", "Raw secret values are not shown or stored in review metadata.", "لا تُعرض قيم الأسرار الخام ولا تُحفظ في بيانات المراجعة.", [], "credential-reference"),
  copy("setupValidation.remote.identityMissing", "Remote-control capability {capabilityId} requires allowed identities.", "قدرة التحكم عن بُعد {capabilityId} تتطلب هويات مسموحًا بها.", ["{capabilityId}"], "optional-capability"),
  copy("setupValidation.browser.noAutoLaunch", "Browser setup will not auto-launch {launchCommand} during planning.", "لن يشغّل إعداد المتصفح {launchCommand} تلقائيًا أثناء التخطيط.", ["{launchCommand}"], "optional-capability"),
] as const satisfies readonly SetupCopyEntry[];

export type SetupCopyKey = (typeof SETUP_COPY_ENTRIES)[number]["key"];

const COPY_BY_KEY = new Map<SetupCopyKey, SetupCopyEntry>(
  SETUP_COPY_ENTRIES.map((entry) => [entry.key, entry])
);

export function listSetupCopyEntries(): readonly SetupCopyEntry[] {
  return SETUP_COPY_ENTRIES;
}

export function getSetupCopyEntry(key: SetupCopyKey): SetupCopyEntry {
  const entry = COPY_BY_KEY.get(key);
  if (entry === undefined) {
    throw new Error(`Unknown setup copy key: ${key}`);
  }
  return entry;
}

export function hasSetupCopyKey(key: string): key is SetupCopyKey {
  return COPY_BY_KEY.has(key as SetupCopyKey);
}

export function resolveSetupCopy(
  locale: SetupCopyLocale | string,
  key: SetupCopyKey,
  options: SetupCopyResolutionOptions = {}
): string {
  const entry = getSetupCopyEntry(key);
  if (locale !== "ar") return entry.en;
  if (options.isolateArabicTechnicalTokens === false) return entry.ar;
  return isolateArabicCopy(entry.ar);
}

export function setupCopy(locale: SetupCopyLocale | string): Record<SetupCopyKey, string> {
  return Object.fromEntries(
    SETUP_COPY_ENTRIES.map((entry) => [entry.key, resolveSetupCopy(locale, entry.key)])
  ) as Record<SetupCopyKey, string>;
}

export function rawSetupCopy(locale: SetupCopyLocale, key: SetupCopyKey): string {
  const entry = getSetupCopyEntry(key);
  return locale === "ar" ? entry.ar : entry.en;
}

function copy(
  key: string,
  en: string,
  ar: string,
  placeholders: readonly string[],
  riskSurface: SetupCopyRiskSurface,
  mvp = true,
  notes?: string
): SetupCopyEntry {
  return {
    key,
    en,
    ar,
    placeholders,
    ltrPlaceholders: placeholders,
    riskSurface,
    mvp,
    ...(notes === undefined ? {} : { notes }),
  };
}

function isolateArabicCopy(value: string): string {
  let isolated = value.replace(/\{[A-Za-z][A-Za-z0-9]*\}/gu, (placeholder) => isolateLtr(placeholder));
  const tokenPattern = new RegExp(TECHNICAL_TOKENS.map(escapeRegExp).join("|"), "gu");
  return isolated.replace(tokenPattern, (token) => isolateLtr(token));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
