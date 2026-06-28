export type OperatorConsoleLocale = "en" | "ar";

export type ActiveWorkCopy = {
  readonly activeWork: string;
  readonly working: string;
  readonly workedFor: string;
  readonly running: string;
  readonly completed: string;
  readonly queued: string;
  readonly awaitingApproval: string;
  readonly moreCompletedThisTurn: (count: number) => string;
  readonly scroll: string;
  readonly inspect: string;
  readonly collapse: string;
  readonly completedToolWork: string;
  readonly runningStepsResolved: (count: number) => string;
  readonly totalToolEvents: string;
  readonly fileChangeInspected: string;
};

const ENGLISH_ACTIVE_WORK_COPY: ActiveWorkCopy = {
  activeWork: "Active work",
  working: "Working",
  workedFor: "Worked for",
  running: "running",
  completed: "completed",
  queued: "queued",
  awaitingApproval: "awaiting approval",
  moreCompletedThisTurn: (count) => `${formatNumber(count)} more completed this turn`,
  scroll: "scroll",
  inspect: "inspect",
  collapse: "collapse",
  completedToolWork: "Completed tool work",
  runningStepsResolved: (count) => `${formatNumber(count)} running steps resolved`,
  totalToolEvents: "total tool events",
  fileChangeInspected: "file change inspected",
};

const ARABIC_ACTIVE_WORK_COPY: ActiveWorkCopy = {
  activeWork: "العمل النشط",
  working: "يعمل",
  workedFor: "عمل لمدة",
  running: "قيد التشغيل",
  completed: "مكتملة",
  queued: "في الانتظار",
  awaitingApproval: "بانتظار الموافقة",
  moreCompletedThisTurn: (count) => `${formatNumber(count)} أخرى مكتملة في هذه الجولة`,
  scroll: "تمرير",
  inspect: "فحص",
  collapse: "طي",
  completedToolWork: "عمل الأدوات المكتمل",
  runningStepsResolved: (count) => `${formatNumber(count)} خطوات نشطة حُلّت`,
  totalToolEvents: "إجمالي أحداث الأدوات",
  fileChangeInspected: "تغيير ملف مفحوص",
};

export function resolveActiveWorkCopy(locale: OperatorConsoleLocale = "en"): ActiveWorkCopy {
  return locale === "ar" ? ARABIC_ACTIVE_WORK_COPY : ENGLISH_ACTIVE_WORK_COPY;
}

function formatNumber(value: number): string {
  return Math.max(0, Math.floor(value)).toLocaleString("en-US");
}
