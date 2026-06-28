export type OperatorConsoleLocale = "en" | "ar";

export type ActiveWorkCopy = {
  readonly runningTools: string;
  readonly toolsCompleted: string;
  readonly workedFor: string;
  readonly duration: string;
  readonly running: string;
  readonly completed: string;
  readonly active: string;
  readonly failed: string;
  readonly queued: string;
  readonly awaitingApproval: string;
};

const ENGLISH_ACTIVE_WORK_COPY: ActiveWorkCopy = {
  runningTools: "Running tools",
  toolsCompleted: "Tools completed",
  workedFor: "Worked for",
  duration: "duration",
  running: "running",
  completed: "completed",
  active: "active",
  failed: "failed",
  queued: "queued",
  awaitingApproval: "awaiting approval",
};

const ARABIC_ACTIVE_WORK_COPY: ActiveWorkCopy = {
  runningTools: "تنفيذ الأدوات",
  toolsCompleted: "اكتمل تنفيذ الأدوات",
  workedFor: "عمل لمدة",
  duration: "المدة",
  running: "قيد التشغيل",
  completed: "اكتملت",
  active: "نشطة",
  failed: "فشلت",
  queued: "في الانتظار",
  awaitingApproval: "بانتظار الموافقة",
};

export function resolveActiveWorkCopy(locale: OperatorConsoleLocale = "en"): ActiveWorkCopy {
  return locale === "ar" ? ARABIC_ACTIVE_WORK_COPY : ENGLISH_ACTIVE_WORK_COPY;
}
