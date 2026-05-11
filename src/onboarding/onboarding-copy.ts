import type { ImageGenerationProvider } from "../config/runtime-config.js";

export type OnboardingLocale = "en" | "ar";

const LRI = "\u2066";
const PDI = "\u2069";

export function ltr(value: string): string {
  return `${LRI}${value}${PDI}`;
}

export type OnboardingCopy = {
  common: {
    selectInstruction: string;
    selectedLabel: string;
    pressEnterToBegin: string;
    pressEnterToContinue: string;
    pressEnterToSave: string;
    skipForNow: string;
    done: string;
    localProviderNoKey: string;
    firstOption: string;
    choicePrompt: (defaultIndex: number, defaultLabel: string) => string;
  };
  welcome: {
    titleSuffix: string;
    intro: string;
    steps: string[];
    outro: string;
  };
  interfaceLanguage: {
    title: string;
    body: string;
    options: Record<OnboardingLocale, { label: string; description: string }>;
  };
  interfaceStyle: {
    title: string;
    body: string;
    standard: { label: string; description: string };
    arabicTouch: { label: string; description: string };
    arabicStandard: { label: string; description: string };
  };
  workspace: {
    rootPrompt: (root: string) => string;
    trustPrompt: string;
    createFailed: (root: string, reason: string) => string;
  };
  providers: {
    title: string;
    body: string;
    modelTitle: (providerLabel: string) => string;
    modelBody: string;
    apiKeyPrompt: (modelLabel: string, envName: string) => string;
    requiredSecretError: (label: string) => string;
    catalog: Record<string, {
      label: string;
      description: string;
      models: Record<string, { label: string; description: string }>;
    }>;
  };
  security: {
    title: string;
    body: string;
    fallbackTitle: string;
    fallbackPrompt: string;
  };
  workflowLearning: {
    title: string;
    body: string;
    fallbackTitle: string;
    fallbackPrompt: string;
  };
  optional: {
    title: string;
    body: string;
    bodyAfterSelection: string;
    skipDescription: string;
    doneDescription: string;
    channels: { label: string; description: string };
    voice: { label: string; description: string };
    vision: { label: string; description: string };
    browser: { label: string; description: string };
  };
  channels: {
    title: string;
    body: string;
    skipDescription: string;
    telegramLabel: string;
    telegramDescription: string;
  };
  telegram: {
    intro: string[];
    tokenPrompt: string[];
    tokenSaved: string[];
    tokenInvalid: string;
    userIdPrompt: string[];
    userIdInvalid: string;
    verifyTitle: string;
    verifyBody: string;
    verifyLabel: string;
    verifyDescription: string;
    verifySkipDescription: string;
    verifyAfterSaveNotice: string;
  };
  voice: {
    title: string;
    body: string;
    skipDescription: string;
    setupLabel: string;
    setupDescription: string;
    sttTitle: string;
    sttBody: string;
    sttSkipDescription: string;
    sttLocalLabel: string;
    sttLocalDescription: string;
    sttHostedLabel: string;
    sttHostedDescription: string;
    ttsTitle: string;
    ttsBody: string;
    ttsSkipDescription: string;
    ttsLocalLabel: string;
    ttsLocalDescription: string;
    ttsHostedLabel: string;
    ttsHostedDescription: string;
    sttKeyPrompt: string;
    ttsKeyPrompt: string;
  };
  vision: {
    title: string;
    body: string;
    skipDescription: string;
    setupLabel: string;
    setupDescription: string;
    inputTitle: string;
    inputBody: string;
    inputVerifyLabel: string;
    inputVerifyDescription: string;
    inputSkipDescription: string;
    imageTitle: string;
    imageBody: string;
    imageSkipDescription: string;
    providerLabels: Record<ImageGenerationProvider, { label: string; description: string }>;
    imageKeyPrompt: (envName: string) => string;
    imageVerifyTitle: string;
    imageVerifyBody: string;
    imageVerifyLabel: string;
    imageVerifyDescription: string;
    imageVerifySkipDescription: string;
  };
  browser: {
    title: string;
    body: string;
    skipDescription: string;
    setupLabel: string;
    setupDescription: string;
  };
  verifyChoice: {
    skipLabel: string;
  };
  review: {
    title: string;
    labels: {
      interface: string;
      provider: string;
      model: string;
      credential: string;
      workspace: string;
      security: string;
      workflow: string;
      optional: string;
    };
    noHostedKey: string;
    notTrusted: string;
    optionalSkipped: string;
    credentialLine: (envName: string) => string;
    note: string;
  };
  setupCheck: {
    title: string;
    ready: string;
    provider: string;
    workspace: string;
    trusted: string;
    notTrusted: string;
    security: string;
    workflow: string;
  };
  verification: {
    title: string;
    body: string;
    stateDirectory: string;
    secretStore: string;
    workspaceTrust: string;
    securityMode: string;
    workflowLearning: string;
    readOnlyToolCheck: string;
    configSources: string;
    writable: string;
    blocked: string;
    notPresent: string;
    presentMode: (mode: string) => string;
    ready: string;
    notTrustedWarning: string;
    stateNotWritableWarning: string;
    secretModeWarning: string;
    readOnlyToolWarning: string;
    skippedNoPackageJson: string;
    warningsTitle: string;
    nextActionsTitle: string;
    statusReady: string;
    nextReady: string;
    fallbackNextAction: string;
    actions: {
      providerIncomplete: string;
      missingApiKey: (envName?: string) => string;
      noCredentialPool: string;
      networkDisabled: string;
      workspaceNotTrusted: string;
      secretPermissions: string;
      stateNotWritable: string;
      readOnlyTool: string;
    };
  };
  final: {
    complete: string;
    ready: string;
    configured: string;
    config: string;
    secretStore: string;
    usingCredential: string;
    interface: string;
    workspaceTrust: string;
    securityMode: string;
    workflowLearning: string;
    optionalCapabilities: string;
    startSession: string;
    nextNoSession: string;
    configuredModelFallback: string;
    alreadyConfigured: (model: string) => string;
    providerStepUnavailable: string;
  };
};

export function onboardingCopy(locale: OnboardingLocale): OnboardingCopy {
  return locale === "ar" ? onboardingCopyAr : onboardingCopyEn;
}

export const onboardingCopyEn: OnboardingCopy = {
  common: {
    selectInstruction: "Use ↑/↓ to move, Enter to select.",
    selectedLabel: "Selected",
    pressEnterToBegin: "Press Enter to begin.",
    pressEnterToContinue: "Press Enter to continue.",
    pressEnterToSave: "Press Enter to save this setup.",
    skipForNow: "Skip for now",
    done: "Done",
    localProviderNoKey: "local provider, no hosted API key",
    firstOption: "first option",
    choicePrompt: (defaultIndex, defaultLabel) => `Enter choice number [default: ${defaultIndex} ${defaultLabel}]: `
  },
  welcome: {
    titleSuffix: "first-run setup",
    intro: "Welcome. This setup prepares EstaCoda for this workspace:",
    steps: [
      "Choose interface language and style.",
      "Trust this workspace for local file and terminal work.",
      "Choose a primary model provider.",
      "Set security and workflow-learning defaults.",
      "Add optional capabilities: Telegram, voice, vision, browser, or skip for now.",
      "Verify setup before entering the agent session."
    ],
    outro: "We'll connect one model provider, save a credential reference, and then start the first agent session."
  },
  interfaceLanguage: {
    title: "Choose interface language",
    body: "This controls setup text, status messages, and CLI labels.",
    options: {
      en: { label: "English", description: "Use English for supported setup and interactive chrome." },
      ar: { label: "Arabic", description: "Use Arabic for supported setup and interactive chrome." }
    }
  },
  interfaceStyle: {
    title: "Choose expression style",
    body: "This controls how much regional language appears in status messages.",
    standard: { label: "Standard", description: "Clear, neutral CLI language." },
    arabicTouch: { label: "Arabic touch", description: "Adds light Arabic identity to status and activity messages." },
    arabicStandard: { label: "Standard", description: "Clear Arabic labels with neutral status text." }
  },
  workspace: {
    rootPrompt: (root) => `Workspace root [${root}]: `,
    trustPrompt: "Trust this workspace so EstaCoda can read files, edit files, and run approved terminal commands here? [Y/n]: ",
    createFailed: (root, reason) => `Could not create or use workspace ${root}: ${reason}`
  },
  providers: {
    title: "Choose primary provider",
    body: "Pick the model provider EstaCoda should use first.",
    modelTitle: (providerLabel) => `Choose ${providerLabel} model`,
    modelBody: "Pick the model EstaCoda should use for this workspace.",
    apiKeyPrompt: (modelLabel, envName) => `Paste ${modelLabel} API key to store as ${envName}: `,
    requiredSecretError: (label) => `${label} cannot be empty. Paste a key, or press Ctrl+C to cancel setup.`,
    catalog: {
      openai: {
        label: "OpenAI",
        description: "Broad tool-use and multimodal support.",
        models: {
          "gpt-4.1-mini": { label: "GPT-4.1 Mini", description: "Fast, capable default route." }
        }
      },
      kimi: {
        label: "Kimi",
        description: "Strong general and coding route.",
        models: {
          "kimi-k2.5": { label: "Kimi K2.5", description: "Recommended balanced model." },
          "kimi-k2-turbo-preview": { label: "Kimi K2 Turbo Preview", description: "Faster preview route." }
        }
      },
      deepseek: {
        label: "DeepSeek",
        description: "Hosted coding-capable route.",
        models: {
          "deepseek-chat": { label: "DeepSeek Chat", description: "General chat and coding route." }
        }
      },
      openrouter: {
        label: "OpenRouter",
        description: "Use models through an OpenRouter account.",
        models: {
          "qwen/qwen3.6-plus": { label: "Qwen 3.6 Plus", description: "General high-context route via OpenRouter." }
        }
      },
      local: {
        label: "Local",
        description: "Use an OpenAI-compatible local runtime.",
        models: {
          "ollama/auto": { label: "Ollama-compatible auto", description: "No hosted API key required." }
        }
      }
    }
  },
  security: {
    title: "Choose security mode",
    body: "You can change this later from settings.",
    fallbackTitle: "Choose security mode:",
    fallbackPrompt: "Choose security mode [default: 2 Adaptive]: "
  },
  workflowLearning: {
    title: "Choose workflow-learning mode",
    body: "This controls how proactive EstaCoda is about reusable workflows.",
    fallbackTitle: "Choose workflow-learning mode:",
    fallbackPrompt: "Choose workflow-learning mode [default: 2 Suggest]: "
  },
  optional: {
    title: "Optional capabilities",
    body: "Set up extra capabilities now or skip them for later.",
    bodyAfterSelection: "Set up another pack, or choose Done to continue.",
    skipDescription: "Start with the core terminal agent.",
    doneDescription: "Continue with the selected capabilities.",
    channels: { label: "Channels", description: "Connect Telegram for remote messages and updates." },
    voice: { label: "Voice", description: "Configure speech input and spoken replies." },
    vision: { label: "Vision", description: "Check image understanding and image generation support." },
    browser: { label: "Browser", description: "Configure browser automation." }
  },
  channels: {
    title: "Set up channels",
    body: "Channels let EstaCoda receive messages and send updates outside this terminal.\nCurrent channel: Telegram",
    skipDescription: "Do not connect a messaging channel.",
    telegramLabel: "Telegram",
    telegramDescription: "Connect a Telegram bot."
  },
  telegram: {
    intro: [
      "Telegram setup",
      "",
      "  Connect a Telegram bot so EstaCoda can receive remote messages and send updates.",
      "",
      "  You need:",
      "    1. A bot token from BotFather.",
      "    2. Your numeric Telegram user ID.",
      "",
      "  Only the allowed user ID can control this agent.",
      "",
      "Press Enter to continue."
    ],
    tokenPrompt: [
      "Get a bot token",
      "",
      "  1. Open Telegram.",
      "  2. Search for BotFather.",
      "  3. Open the verified BotFather chat.",
      "  4. Send /newbot.",
      "  5. Choose a display name for the bot.",
      "  6. Choose a username ending in bot.",
      "  7. Copy the API token BotFather gives you.",
      "",
      "  Keep this token private. Anyone with the token can control the bot.",
      "",
      "Paste Telegram bot token",
      "Stored locally as ESTACODA_TELEGRAM_BOT_TOKEN in ~/.estacoda/.env: "
    ],
    tokenSaved: [
      "Bot token captured.",
      "It will be stored locally as ESTACODA_TELEGRAM_BOT_TOKEN in ~/.estacoda/.env."
    ],
    tokenInvalid: "Invalid Telegram bot token. Expected format: 123456789:ABC...",
    userIdPrompt: [
      "Get your Telegram user ID",
      "",
      "  1. Open Telegram.",
      "  2. Search for userinfobot.",
      "  3. Start the chat.",
      "  4. Copy the numeric ID it sends back.",
      "",
      "  Use the numeric ID only, not your @username.",
      "",
      "Paste allowed Telegram user ID",
      "Only this Telegram user can send commands to EstaCoda: "
    ],
    userIdInvalid: "Invalid Telegram user ID. Use the numeric ID only.",
    verifyTitle: "Verify Telegram after save",
    verifyBody: "EstaCoda can verify the bot token and allowed user configuration after saving this setup.",
    verifyLabel: "Verify after save",
    verifyDescription: "Run the Telegram verification after settings are saved.",
    verifySkipDescription: "Save settings without verification.",
    verifyAfterSaveNotice: "Telegram settings will be verified after they are saved. Press Enter to continue."
  },
  voice: {
    title: "Voice setup",
    body: "Configure speech input and spoken replies.",
    skipDescription: "Keep text-only interaction.",
    setupLabel: "Set up voice",
    setupDescription: "Configure speech-to-text and text-to-speech.",
    sttTitle: "Speech-to-text",
    sttBody: "Choose how spoken input becomes text.",
    sttSkipDescription: "Do not enable speech input.",
    sttLocalLabel: "Local",
    sttLocalDescription: "Use a local transcription backend.",
    sttHostedLabel: "Hosted",
    sttHostedDescription: "Use a hosted transcription provider.",
    ttsTitle: "Text-to-speech",
    ttsBody: "Choose how EstaCoda speaks responses.",
    ttsSkipDescription: "Do not enable spoken replies.",
    ttsLocalLabel: "Local",
    ttsLocalDescription: "Use a local speech backend.",
    ttsHostedLabel: "Hosted",
    ttsHostedDescription: "Use a hosted speech provider.",
    sttKeyPrompt: "Paste hosted speech-to-text API key to store as OPENAI_API_KEY: ",
    ttsKeyPrompt: "Paste hosted text-to-speech API key to store as OPENAI_API_KEY: "
  },
  vision: {
    title: "Vision setup",
    body: "Check image understanding and image generation support.",
    skipDescription: "Keep text and code workflows only.",
    setupLabel: "Set up vision",
    setupDescription: "Check image input and image generation.",
    inputTitle: "Verify vision after save",
    inputBody: "EstaCoda can verify whether the selected model can read images after saving this setup.",
    inputVerifyLabel: "Verify after save",
    inputVerifyDescription: "Run the vision readiness check after settings are saved.",
    inputSkipDescription: "Save settings without verification.",
    imageTitle: "Image generation",
    imageBody: "Choose whether EstaCoda can create images.",
    imageSkipDescription: "Do not enable image generation.",
    providerLabels: {
      byteplus: { label: "BytePlus Seedream", description: "Use BytePlus ModelArk image generation." },
      fal: { label: "FAL", description: "Use a hosted FAL image generation route." }
    },
    imageKeyPrompt: (envName) => `Paste image generation API key to store as ${envName}: `,
    imageVerifyTitle: "Verify image generation after save",
    imageVerifyBody: "EstaCoda can verify the image provider configuration after saving this setup.",
    imageVerifyLabel: "Verify after save",
    imageVerifyDescription: "Run image generation verification after settings are saved.",
    imageVerifySkipDescription: "Save settings without verification."
  },
  browser: {
    title: "Browser setup",
    body: "Configure browser automation for web pages.",
    skipDescription: "Do not configure browser automation.",
    setupLabel: "Set up browser",
    setupDescription: "Use a local Chrome DevTools-compatible browser."
  },
  verifyChoice: {
    skipLabel: "Skip verification"
  },
  review: {
    title: "Review setup",
    labels: {
      interface: "Interface",
      provider: "Provider",
      model: "Model",
      credential: "Credential",
      workspace: "Workspace",
      security: "Security",
      workflow: "Workflow",
      optional: "Optional"
    },
    noHostedKey: "local provider, no hosted API key",
    notTrusted: "not trusted",
    optionalSkipped: "skipped",
    credentialLine: (envName) => `save to ~/.estacoda/.env as ${envName}`,
    note: "EstaCoda stores configuration and credential references. Raw hosted keys go only into ~/.estacoda/.env."
  },
  setupCheck: {
    title: "Setup check",
    ready: "Setup check: ready",
    provider: "Provider",
    workspace: "Workspace",
    trusted: "trusted",
    notTrusted: "not trusted",
    security: "Security",
    workflow: "Workflow learning"
  },
  verification: {
    title: "EstaCoda verify",
    body: "Checks your local setup, provider route, credential store, workspace trust, and basic tool readiness.",
    stateDirectory: "State directory",
    secretStore: "Secret store",
    workspaceTrust: "Workspace trust",
    securityMode: "Security mode",
    workflowLearning: "Workflow learning",
    readOnlyToolCheck: "Read-only tool check",
    configSources: "Config sources",
    writable: "writable",
    blocked: "blocked",
    notPresent: "not present",
    presentMode: (mode) => `present (${mode})`,
    ready: "ready",
    notTrustedWarning: "Workspace is not trusted yet; local write/terminal actions will ask first.",
    stateNotWritableWarning: "State directory is not writable.",
    secretModeWarning: "Secret store permissions should be 0600.",
    readOnlyToolWarning: "Read-only file tool check did not complete.",
    skippedNoPackageJson: "skipped (no package.json)",
    warningsTitle: "Warnings:",
    nextActionsTitle: "Next actions:",
    statusReady: "Status: ready",
    nextReady: "Next: run estacoda, or configure optional channels with estacoda telegram setup / estacoda browser setup.",
    fallbackNextAction: "Fix the warnings above, then rerun estacoda verify.",
    actions: {
      providerIncomplete: "Run estacoda setup to choose a provider/model.",
      missingApiKey: (envName) => envName === undefined
        ? "Export the missing provider API key, or rerun estacoda setup to store it locally."
        : `Export ${envName}, or rerun estacoda setup and choose local secret storage.`,
      noCredentialPool: "Run estacoda setup --advanced --provider <provider> --model <model> --api-key-env <ENV_NAME>.",
      networkDisabled: "Enable network inference for the selected hosted provider with estacoda setup --advanced.",
      workspaceNotTrusted: "Run /workspace.trust.grant in an interactive session, or rerun estacoda setup and trust this workspace.",
      secretPermissions: "Run chmod 600 ~/.estacoda/.env to restrict local secret-store permissions.",
      stateNotWritable: "Check write permissions for ~/.estacoda.",
      readOnlyTool: "Start an interactive session after fixing provider/trust warnings, then retry estacoda verify."
    }
  },
  final: {
    complete: "Setup complete.",
    ready: "EstaCoda is ready to use this workspace configuration.",
    configured: "Configured",
    config: "Config",
    secretStore: "Secret store",
    usingCredential: "Using credential from",
    interface: "Interface",
    workspaceTrust: "Workspace trust",
    securityMode: "Security mode",
    workflowLearning: "Workflow learning",
    optionalCapabilities: "Optional capabilities",
    startSession: "Starting your first EstaCoda agent session now.",
    nextNoSession: "Next: run estacoda, or run estacoda verify any time to re-check setup.",
    configuredModelFallback: "the configured model",
    alreadyConfigured: (model) => `EstaCoda is already configured for ${model}.`,
    providerStepUnavailable: "Onboarding provider step is unavailable."
  }
};

export const onboardingCopyAr: OnboardingCopy = {
  ...onboardingCopyEn,
  common: {
    ...onboardingCopyEn.common,
    selectInstruction: `استخدم ↑/↓ للتنقّل، ثم ${ltr("Enter")} للاختيار.`,
    selectedLabel: "تم الاختيار",
    pressEnterToBegin: `اضغط ${ltr("Enter")} للبدء.`,
    pressEnterToContinue: `اضغط ${ltr("Enter")} للمتابعة.`,
    pressEnterToSave: `اضغط ${ltr("Enter")} لحفظ هذا الإعداد.`,
    skipForNow: "تخطي الآن",
    done: "تم",
    localProviderNoKey: `مزوّد محلي، لا يحتاج مفتاح ${ltr("API")} مستضافاً`,
    firstOption: "الخيار الأول",
    choicePrompt: (defaultIndex, defaultLabel) => `أدخل رقم الاختيار [الافتراضي: ${defaultIndex} ${defaultLabel}]: `
  },
  welcome: {
    titleSuffix: "إعداد أولي",
    intro: `مرحباً. هذا الإعداد يجهّز ${ltr("EstaCoda")} لهذا المشروع:`,
    steps: [
      "اختيار لغة الواجهة وأسلوب التعبير.",
      "منح الثقة لهذا المجلد لأعمال الملفات والطرفية المحلية.",
      "اختيار مزوّد النموذج الأساسي.",
      "تحديد إعدادات الأمان وتعلّم سير العمل.",
      `إضافة إمكانات اختيارية: ${ltr("Telegram")} أو الصوت أو الرؤية أو المتصفح، أو تخطيها الآن.`,
      "التحقق من الإعداد قبل بدء جلسة الوكيل."
    ],
    outro: "سنربط مزوّد نموذج واحداً، ونحفظ مرجع المفتاح، ثم نبدأ أول جلسة للوكيل."
  },
  interfaceLanguage: {
    title: "اختر لغة الواجهة",
    body: `يتحكم هذا في لغة الإعداد ورسائل الحالة وتسميات ${ltr("CLI")} المدعومة.`,
    options: {
      en: { label: ltr("English"), description: `استخدم الإنجليزية في ${ltr("CLI")}.` },
      ar: { label: "العربية", description: `استخدم العربية في الإعداد ورسائل ${ltr("CLI")} المدعومة.` }
    }
  },
  interfaceStyle: {
    title: "اختر أسلوب التعبير",
    body: "يتحكم هذا في مقدار الحضور اللغوي المحلي في رسائل الحالة.",
    standard: { label: "قياسي", description: `لغة ${ltr("CLI")} واضحة ومحايدة.` },
    arabicTouch: { label: "لمسة عربية", description: "تضيف هوية عربية خفيفة إلى رسائل الحالة والنشاط." },
    arabicStandard: { label: "قياسي", description: "تسميات عربية واضحة مع نص حالة محايد." }
  },
  workspace: {
    rootPrompt: (root) => `مجلد العمل [${ltr(root)}]: `,
    trustPrompt: `هل تثق بهذا المجلد حتى تتمكن ${ltr("EstaCoda")} من قراءة الملفات وتعديلها وتشغيل أوامر الطرفية الموافق عليها هنا؟ [${ltr("Y/n")}]: `,
    createFailed: (root, reason) => `تعذر إنشاء أو استخدام مجلد العمل ${ltr(root)}: ${reason}`
  },
  providers: {
    ...onboardingCopyEn.providers,
    title: "اختر مزوّد النموذج الأساسي",
    body: `اختر مزوّد النموذج الذي يجب أن تستخدمه ${ltr("EstaCoda")} أولاً.`,
    modelTitle: (providerLabel) => `اختر نموذج ${ltr(providerLabel)}`,
    modelBody: `اختر النموذج الذي ستستخدمه ${ltr("EstaCoda")} لهذا المشروع.`,
    apiKeyPrompt: (modelLabel, envName) => `الصق مفتاح ${ltr("API")} الخاص بـ ${ltr(modelLabel)} ليُحفظ باسم ${ltr(envName)}: `,
    requiredSecretError: (label) => `لا يمكن ترك ${ltr(label)} فارغاً. الصق المفتاح، أو اضغط ${ltr("Ctrl+C")} لإلغاء الإعداد.`,
    catalog: {
      openai: {
        ...onboardingCopyEn.providers.catalog.openai,
        label: ltr("OpenAI"),
        description: "دعم واسع لاستخدام الأدوات والوسائط المتعددة.",
        models: {
          "gpt-4.1-mini": {
            label: ltr("GPT-4.1 Mini"),
            description: "مسار متوازن للأدوات والوسائط."
          }
        }
      },
      kimi: {
        ...onboardingCopyEn.providers.catalog.kimi,
        label: ltr("Kimi"),
        description: "مسار قوي للاستخدام العام والبرمجة.",
        models: {
          "kimi-k2.5": {
            label: ltr("Kimi K2.5"),
            description: "النموذج المتوازن الموصى به."
          },
          "kimi-k2-turbo-preview": {
            label: ltr("Kimi K2 Turbo Preview"),
            description: "مسار معاينة أسرع."
          }
        }
      },
      deepseek: {
        ...onboardingCopyEn.providers.catalog.deepseek,
        label: ltr("DeepSeek"),
        description: "مسار مستضاف مناسب للبرمجة.",
        models: {
          "deepseek-chat": {
            label: ltr("DeepSeek Chat"),
            description: "نموذج محادثة وبرمجة مستضاف."
          }
        }
      },
      openrouter: {
        ...onboardingCopyEn.providers.catalog.openrouter,
        label: ltr("OpenRouter"),
        description: `استخدم النماذج عبر حساب ${ltr("OpenRouter")}.`,
        models: {
          "qwen/qwen3.6-plus": {
            label: ltr("Qwen 3.6 Plus"),
            description: `نموذج مستضاف عبر ${ltr("OpenRouter")}.`
          }
        }
      },
      local: {
        ...onboardingCopyEn.providers.catalog.local,
        label: "محلي",
        description: `استخدم مشغلاً محلياً متوافقاً مع ${ltr("OpenAI")}.`,
        models: {
          "ollama/auto": {
            label: ltr("Ollama Auto"),
            description: "اكتشاف تلقائي لمشغل محلي."
          }
        }
      }
    }
  },
  security: {
    title: "اختر وضع الأمان",
    body: "يمكنك تغييره لاحقاً من الإعدادات.",
    fallbackTitle: "اختر وضع الأمان:",
    fallbackPrompt: "اختر وضع الأمان [الافتراضي: 2 متوازن]: "
  },
  workflowLearning: {
    title: "اختر وضع تعلّم سير العمل",
    body: "هذا يحدد مدى استباقية EstaCoda في إنشاء سير عمل قابل لإعادة الاستخدام.",
    fallbackTitle: "اختر وضع تعلّم سير العمل:",
    fallbackPrompt: "اختر وضع تعلّم سير العمل [الافتراضي: 2 اقتراح]: "
  },
  optional: {
    title: "إمكانات اختيارية",
    body: "أضف إمكانات إضافية الآن أو تخطها لوقت لاحق.",
    bodyAfterSelection: "أضف إمكانية أخرى، أو اختر تم للمتابعة.",
    skipDescription: "ابدأ بالوكيل الأساسي في الطرفية.",
    doneDescription: "تابع بالإمكانات التي اخترتها.",
    channels: { label: "القنوات", description: `اربط ${ltr("Telegram")} للرسائل والتحديثات عن بُعد.` },
    voice: { label: "الصوت", description: "اضبط الإدخال الصوتي والردود المنطوقة." },
    vision: { label: "الرؤية", description: "تحقق من فهم الصور وتوليدها." },
    browser: { label: "المتصفح", description: "اضبط أتمتة المتصفح." }
  },
  channels: {
    title: "إعداد القنوات",
    body: `تسمح القنوات لـ ${ltr("EstaCoda")} باستقبال الرسائل وإرسال التحديثات خارج هذه الطرفية.\nالقناة المتاحة حالياً: ${ltr("Telegram")}`,
    skipDescription: "لا تربط قناة رسائل.",
    telegramLabel: ltr("Telegram"),
    telegramDescription: `اربط بوت ${ltr("Telegram")}.`
  },
  telegram: {
    intro: [
      `إعداد ${ltr("Telegram")}`,
      "",
      `  اربط بوت ${ltr("Telegram")} حتى تتمكن ${ltr("EstaCoda")} من استقبال الرسائل عن بُعد وإرسال التحديثات.`,
      "",
      "  تحتاج إلى:",
      `    1. ${ltr("bot token")} من ${ltr("BotFather")}.`,
      `    2. رقم ${ltr("Telegram user ID")} الخاص بك.`,
      "",
      "  هذا المستخدم المسموح له فقط يمكنه التحكم بهذا الوكيل.",
      "",
      `اضغط ${ltr("Enter")} للمتابعة.`
    ],
    tokenPrompt: [
      `احصل على ${ltr("bot token")}`,
      "",
      `  1. افتح ${ltr("Telegram")}.`,
      `  2. ابحث عن ${ltr("BotFather")}.`,
      `  3. افتح محادثة ${ltr("BotFather")} الموثقة.`,
      `  4. أرسل ${ltr("/newbot")}.`,
      "  5. اختر اسم العرض للبوت.",
      `  6. اختر اسم مستخدم ينتهي بـ ${ltr("bot")}.`,
      `  7. انسخ ${ltr("API token")} الذي يعطيك إياه ${ltr("BotFather")}.`,
      "",
      "  احتفظ بهذا المفتاح سرياً. أي شخص يملكه يمكنه التحكم بالبوت.",
      "",
      `الصق ${ltr("Telegram bot token")}`,
      `سيُحفظ محلياً باسم ${ltr("ESTACODA_TELEGRAM_BOT_TOKEN")} في ${ltr("~/.estacoda/.env")}: `
    ],
    tokenSaved: [
      `تم التقاط ${ltr("bot token")}.`,
      `سيُحفظ محلياً باسم ${ltr("ESTACODA_TELEGRAM_BOT_TOKEN")} في ${ltr("~/.estacoda/.env")}.`
    ],
    tokenInvalid: `${ltr("Telegram bot token")} غير صالح. الصيغة المتوقعة: ${ltr("123456789:ABC...")}`,
    userIdPrompt: [
      `احصل على ${ltr("Telegram user ID")}`,
      "",
      `  1. افتح ${ltr("Telegram")}.`,
      `  2. ابحث عن ${ltr("userinfobot")}.`,
      "  3. ابدأ المحادثة.",
      "  4. انسخ الرقم الذي يرسله لك.",
      "",
      `  استخدم الرقم فقط، وليس ${ltr("@username")}.`,
      "",
      `الصق ${ltr("Telegram user ID")} المسموح له`,
      `هذا المستخدم فقط يمكنه إرسال أوامر إلى ${ltr("EstaCoda")}: `
    ],
    userIdInvalid: `${ltr("Telegram user ID")} غير صالح. استخدم الرقم فقط.`,
    verifyTitle: `التحقق من ${ltr("Telegram")} بعد الحفظ`,
    verifyBody: `يمكن لـ ${ltr("EstaCoda")} التحقق من ${ltr("bot token")} والمستخدم المسموح له بعد حفظ هذا الإعداد.`,
    verifyLabel: "تحقق بعد الحفظ",
    verifyDescription: `شغّل تحقق ${ltr("Telegram")} بعد حفظ الإعدادات.`,
    verifySkipDescription: "احفظ الإعدادات بدون تحقق.",
    verifyAfterSaveNotice: `سيتم التحقق من إعدادات ${ltr("Telegram")} بعد حفظها. اضغط ${ltr("Enter")} للمتابعة.`
  },
  voice: {
    ...onboardingCopyEn.voice,
    title: "إعداد الصوت",
    body: "اضبط الإدخال الصوتي والردود المنطوقة.",
    skipDescription: "ابقَ على التفاعل النصي فقط.",
    setupLabel: "إعداد الصوت",
    setupDescription: `اضبط ${ltr("speech-to-text")} و ${ltr("text-to-speech")}.`,
    sttTitle: ltr("Speech-to-text"),
    sttBody: "اختر كيف يتحول الكلام إلى نص.",
    sttSkipDescription: "لا تفعّل الإدخال الصوتي.",
    sttLocalLabel: "محلي",
    sttLocalDescription: `استخدم ${ltr("backend")} محلياً للتفريغ الصوتي.`,
    sttHostedLabel: "مستضاف",
    sttHostedDescription: "استخدم مزوّداً مستضافاً للتفريغ الصوتي.",
    ttsTitle: ltr("Text-to-speech"),
    ttsBody: `اختر كيف تنطق ${ltr("EstaCoda")} الردود.`,
    ttsSkipDescription: "لا تفعّل الردود المنطوقة.",
    ttsLocalLabel: "محلي",
    ttsLocalDescription: `استخدم ${ltr("backend")} صوتياً محلياً.`,
    ttsHostedLabel: "مستضاف",
    ttsHostedDescription: "استخدم مزوّداً صوتياً مستضافاً.",
    sttKeyPrompt: `الصق مفتاح ${ltr("API")} الخاص بـ ${ltr("speech-to-text")} ليُحفظ باسم ${ltr("OPENAI_API_KEY")}: `,
    ttsKeyPrompt: `الصق مفتاح ${ltr("API")} الخاص بـ ${ltr("text-to-speech")} ليُحفظ باسم ${ltr("OPENAI_API_KEY")}: `
  },
  vision: {
    ...onboardingCopyEn.vision,
    title: "إعداد الرؤية",
    body: "تحقق من دعم فهم الصور وتوليدها.",
    skipDescription: "ابقَ على النص والبرمجة فقط.",
    setupLabel: "إعداد الرؤية",
    setupDescription: "تحقق من إدخال الصور وتوليدها.",
    inputTitle: "التحقق من الرؤية بعد الحفظ",
    inputBody: `يمكن لـ ${ltr("EstaCoda")} التحقق مما إذا كان النموذج المختار يقرأ الصور بعد حفظ هذا الإعداد.`,
    inputVerifyLabel: "تحقق بعد الحفظ",
    inputVerifyDescription: "شغّل تحقق الرؤية بعد حفظ الإعدادات.",
    inputSkipDescription: "احفظ الإعدادات بدون تحقق.",
    imageTitle: "توليد الصور",
    imageBody: `اختر ما إذا كانت ${ltr("EstaCoda")} تستطيع إنشاء الصور.`,
    imageSkipDescription: "لا تفعّل توليد الصور.",
    imageKeyPrompt: (envName) => `الصق مفتاح ${ltr("API")} الخاص بتوليد الصور ليُحفظ باسم ${ltr(envName)}: `,
    imageVerifyTitle: "تحقق من توليد الصور بعد الحفظ",
    imageVerifyBody: "يمكن لـ EstaCoda التحقق من إعداد مزوّد الصور بعد حفظ هذا الإعداد.",
    imageVerifyLabel: "تحقق بعد الحفظ",
    imageVerifyDescription: "شغّل تحقق توليد الصور بعد حفظ الإعدادات.",
    imageVerifySkipDescription: "احفظ الإعدادات بدون تحقق."
  },
  browser: {
    title: "إعداد المتصفح",
    body: "اضبط أتمتة المتصفح لصفحات الويب.",
    skipDescription: "لا تضبط أتمتة المتصفح.",
    setupLabel: "إعداد المتصفح",
    setupDescription: `استخدم متصفحاً محلياً متوافقاً مع ${ltr("Chrome DevTools")}.`
  },
  verifyChoice: {
    skipLabel: "تخطي التحقق"
  },
  review: {
    ...onboardingCopyEn.review,
    title: "مراجعة الإعداد",
    labels: {
      interface: "الواجهة",
      provider: "المزوّد",
      model: "النموذج",
      credential: "المفتاح",
      workspace: "مجلد العمل",
      security: "الأمان",
      workflow: "تعلّم سير العمل",
      optional: "الإمكانات الاختيارية"
    },
    noHostedKey: `مزوّد محلي، لا يحتاج مفتاح ${ltr("API")} مستضافاً`,
    notTrusted: "غير موثوق",
    optionalSkipped: "تم التخطي",
    credentialLine: (envName) => `حفظ في ${ltr("~/.estacoda/.env")} باسم ${ltr(envName)}`,
    note: `تحفظ ${ltr("EstaCoda")} الإعدادات ومراجع المفاتيح. المفاتيح الخام للمزوّدين المستضافين تُحفظ فقط في ${ltr("~/.estacoda/.env")}.`
  },
  setupCheck: {
    title: "فحص الإعداد",
    ready: "فحص الإعداد: جاهز",
    provider: "المزوّد",
    workspace: "مجلد العمل",
    trusted: "موثوق",
    notTrusted: "غير موثوق",
    security: "الأمان",
    workflow: "تعلّم سير العمل"
  },
  verification: {
    title: "فحص EstaCoda",
    body: "يتحقق من الإعداد المحلي، ومسار المزوّد، ومخزن المفاتيح، وثقة مجلد العمل، وجاهزية الأدوات الأساسية.",
    stateDirectory: "مجلد الحالة",
    secretStore: "مخزن المفاتيح",
    workspaceTrust: "ثقة مجلد العمل",
    securityMode: "وضع الأمان",
    workflowLearning: "تعلّم سير العمل",
    readOnlyToolCheck: "فحص أداة القراءة فقط",
    configSources: "مصادر الإعداد",
    writable: "قابل للكتابة",
    blocked: "محظور",
    notPresent: "غير موجود",
    presentMode: (mode) => `موجود (${mode})`,
    ready: "جاهز",
    notTrustedWarning: "مجلد العمل غير موثوق بعد؛ إجراءات الكتابة والطرفية المحلية ستطلب الموافقة أولاً.",
    stateNotWritableWarning: "مجلد الحالة غير قابل للكتابة.",
    secretModeWarning: `يجب أن تكون صلاحيات مخزن المفاتيح ${ltr("0600")}.`,
    readOnlyToolWarning: "لم يكتمل فحص أداة قراءة الملفات.",
    skippedNoPackageJson: `تم التخطي (لا يوجد ${ltr("package.json")})`,
    warningsTitle: "تحذيرات:",
    nextActionsTitle: "الخطوات التالية:",
    statusReady: "الحالة: جاهز",
    nextReady: `التالي: شغّل ${ltr("estacoda")}، أو اضبط القنوات الاختيارية عبر ${ltr("estacoda telegram setup")} / ${ltr("estacoda browser setup")}.`,
    fallbackNextAction: `أصلح التحذيرات أعلاه، ثم أعد تشغيل ${ltr("estacoda verify")}.`,
    actions: {
      providerIncomplete: `شغّل ${ltr("estacoda setup")} لاختيار مزوّد ونموذج.`,
      missingApiKey: (envName) => envName === undefined
        ? `صدّر مفتاح ${ltr("API")} الناقص، أو أعد تشغيل ${ltr("estacoda setup")} لحفظه محلياً.`
        : `صدّر ${ltr(envName)}، أو أعد تشغيل ${ltr("estacoda setup")} واختر تخزين المفتاح محلياً.`,
      noCredentialPool: `شغّل ${ltr("estacoda setup --advanced --provider <provider> --model <model> --api-key-env <ENV_NAME>")}.`,
      networkDisabled: `فعّل الاستدلال عبر الشبكة للمزوّد المستضاف المختار باستخدام ${ltr("estacoda setup --advanced")}.`,
      workspaceNotTrusted: `شغّل ${ltr("/workspace.trust.grant")} داخل جلسة تفاعلية، أو أعد تشغيل ${ltr("estacoda setup")} ومنح الثقة لهذا المجلد.`,
      secretPermissions: `شغّل ${ltr("chmod 600 ~/.estacoda/.env")} لتقييد صلاحيات مخزن المفاتيح المحلي.`,
      stateNotWritable: `تحقق من صلاحيات الكتابة في ${ltr("~/.estacoda")}.`,
      readOnlyTool: `ابدأ جلسة تفاعلية بعد إصلاح تحذيرات المزوّد/الثقة، ثم أعد تشغيل ${ltr("estacoda verify")}.`
    }
  },
  final: {
    complete: "اكتمل الإعداد.",
    ready: `${ltr("EstaCoda")} جاهزة لاستخدام إعدادات هذا المشروع.`,
    configured: "تم الإعداد",
    config: "ملف الإعداد",
    secretStore: "مخزن المفاتيح",
    usingCredential: "استخدام المفتاح من",
    interface: "الواجهة",
    workspaceTrust: "ثقة مجلد العمل",
    securityMode: "وضع الأمان",
    workflowLearning: "تعلّم سير العمل",
    optionalCapabilities: "الإمكانات الاختيارية",
    startSession: `بدء أول جلسة ${ltr("EstaCoda")} الآن.`,
    nextNoSession: `التالي: شغّل ${ltr("estacoda")}، أو شغّل ${ltr("estacoda verify")} في أي وقت لإعادة فحص الإعداد.`,
    configuredModelFallback: "النموذج المُعد",
    alreadyConfigured: (model) => `${ltr("EstaCoda")} معدّة بالفعل لاستخدام ${ltr(model)}.`,
    providerStepUnavailable: "خطوة اختيار المزوّد في الإعداد غير متاحة."
  }
};
