import type { SecurityApprovalMode } from "../contracts/security.js";
import type { SkillAutonomy } from "../skills/skill-learning.js";

export type Locale = "en" | "ar";

export const SECURITY_MODE_LABELS = {
  strict: {
    en: {
      label: "Strict",
      description: "Asks before risky actions."
    },
    ar: {
      label: "صارم",
      description: "يطلب الموافقة قبل الإجراءات الحسّاسة أو الخطرة."
    }
  },
  adaptive: {
    en: {
      label: "Adaptive",
      description: "Allows clearly safe actions, blocks clearly unsafe actions, and asks when risk is ambiguous."
    },
    ar: {
      label: "متوازن",
      description: "يسمح بالإجراءات الآمنة الواضحة، يمنع الإجراءات الخطرة الواضحة، ويطلب الموافقة عند وجود غموض."
    }
  },
  open: {
    en: {
      label: "Open",
      description: "Minimizes approval prompts, but hard safety blocks still apply."
    },
    ar: {
      label: "مفتوح",
      description: "يقلّل طلبات الموافقة، لكن حدود الأمان الأساسية تبقى مفعّلة دائماً."
    }
  }
} as const;

export const SKILL_AUTONOMY_LABELS = {
  none: {
    en: {
      label: "None",
      description: "Agent Evolution is off. No evidence or improvement proposals are recorded."
    },
    ar: {
      label: "متوقف",
      description: "Agent Evolution متوقف. لا تُسجّل أدلة أو مقترحات تحسين."
    }
  },
  suggest: {
    en: {
      label: "Suggest",
      description: "Records evidence and reviewable improvement proposals. Does not promote or write skills automatically."
    },
    ar: {
      label: "اقتراح",
      description: "يسجّل الأدلة ومقترحات تحسين قابلة للمراجعة. لا يرقي ولا يكتب مهارات تلقائياً."
    }
  },
  proactive: {
    en: {
      label: "Proactive",
      description: "Updates eligible local skill instructions automatically unless skill write approval is enabled. Changes can be reviewed and undone."
    },
    ar: {
      label: "استباقي",
      description: "يحدّث تعليمات المهارات المحلية المؤهلة تلقائيًا ما لم تكن الموافقة على كتابة المهارات مفعّلة. يمكن مراجعة التغييرات والتراجع عنها."
    }
  },
  autonomous: {
    en: {
      label: "Autonomous",
      description: "Updates eligible local skill instructions automatically unless skill write approval is enabled. Changes can be reviewed and undone."
    },
    ar: {
      label: "ذاتي",
      description: "يحدّث تعليمات المهارات المحلية المؤهلة تلقائيًا ما لم تكن الموافقة على كتابة المهارات مفعّلة. يمكن مراجعة التغييرات والتراجع عنها."
    }
  }
} as const;

export function formatSecurityMode(mode: SecurityApprovalMode, locale: Locale): {
  value: SecurityApprovalMode;
  label: string;
  description: string;
} {
  const entry = SECURITY_MODE_LABELS[mode][locale];
  return {
    value: mode,
    label: entry.label,
    description: entry.description
  };
}

export function formatSkillAutonomy(mode: SkillAutonomy, locale: Locale): {
  value: SkillAutonomy;
  label: string;
  description: string;
} {
  const entry = SKILL_AUTONOMY_LABELS[mode][locale];
  return {
    value: mode,
    label: entry.label,
    description: entry.description
  };
}

export function renderSecurityModeOption(index: number, mode: SecurityApprovalMode, locale: Locale): string {
  const entry = formatSecurityMode(mode, locale);
  return locale === "ar"
    ? `[${index}] ${entry.label}\n    ${entry.description}`
    : `[${index}] ${entry.label}\n    ${entry.description}`;
}

export function renderSkillAutonomyOption(index: number, mode: SkillAutonomy, locale: Locale): string {
  const entry = formatSkillAutonomy(mode, locale);
  return locale === "ar"
    ? `[${index}] ${entry.label}\n    ${entry.description}`
    : `[${index}] ${entry.label}\n    ${entry.description}`;
}
