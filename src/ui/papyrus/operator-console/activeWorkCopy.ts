export type OperatorConsoleLocale = "en" | "ar";

export type ActiveWorkCopy = {
  readonly runningTools: string;
  readonly delegatedWork: string;
  readonly toolsCompleted: string;
  readonly workedFor: string;
  readonly duration: string;
  readonly running: string;
  readonly completed: string;
  readonly active: string;
  readonly done: string;
  readonly failed: string;
  readonly queued: string;
  readonly awaitingApproval: string;
  readonly activity: string;
  readonly activities: string;
  readonly cancelled: string;
  readonly blocked: string;
  readonly timedOut: string;
};

const ENGLISH_ACTIVE_WORK_COPY: ActiveWorkCopy = {
  runningTools: "Running tools",
  delegatedWork: "Delegated work",
  toolsCompleted: "Tools completed",
  workedFor: "Worked for",
  duration: "duration",
  running: "running",
  completed: "completed",
  active: "active",
  done: "done",
  failed: "failed",
  queued: "queued",
  awaitingApproval: "awaiting approval",
  activity: "activity",
  activities: "activities",
  cancelled: "cancelled",
  blocked: "blocked",
  timedOut: "timed out",
};

const ARABIC_ACTIVE_WORK_COPY: ActiveWorkCopy = {
  runningTools: "تنفيذ الأدوات",
  delegatedWork: "عمل الوكلاء الفرعيين",
  toolsCompleted: "اكتمل تنفيذ الأدوات",
  workedFor: "عمل لمدة",
  duration: "المدة",
  running: "قيد التشغيل",
  completed: "اكتملت",
  active: "نشطة",
  done: "مكتملة",
  failed: "فشلت",
  queued: "في الانتظار",
  awaitingApproval: "بانتظار الموافقة",
  activity: "نشاط",
  activities: "أنشطة",
  cancelled: "ملغاة",
  blocked: "محظور",
  timedOut: "انتهت المهلة",
};

export function resolveActiveWorkCopy(locale: OperatorConsoleLocale = "en"): ActiveWorkCopy {
  return locale === "ar" ? ARABIC_ACTIVE_WORK_COPY : ENGLISH_ACTIVE_WORK_COPY;
}
