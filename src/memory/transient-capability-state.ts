import type { ExtractedFact } from "./extracted-fact.js";

/** Narrow runtime-state vocabulary, shared by extraction, review and cleanup.
 * User policy/preferences are not capability observations. */
export function isTransientCapabilityState(text: string): boolean {
  const value = text.normalize("NFKC").slice(0, 8_000);
  if (containsDurableChoice(value) && !/\b(?:unavailable|unconfigured|missing|failed|denied|blocked|disconnected|not\s+(?:available|configured|enabled|accessible)|timed?\s*out)\b|(?:غير متاح|غير متوفر|تعذر|فشل)/iu.test(value)) return false;
  const capability = /\b(?:browser(?:\s+tools?)?|browsing|web\.(?:search|extract)|web\s+(?:search|access)|internet\s+access|tools?|capabilit(?:y|ies)|connectors?|mcp|provider|file\.(?:write|read)|delegation)\b|(?:المتصفح|التصفح|أدوات|الأدوات|البحث على الويب|الاتصال بالإنترنت)/iu;
  const state = /\b(?:unavailable|not\s+(?:available|configured|enabled|accessible|supported)|unconfigured|missing|denied|blocked|timed?\s*out|failed|disconnected|offline|(?:temporarily|currently)\s+disabled)\b|(?:غير متاح|غير متوفر|غير مهيأ|غير متصل|تعذر|فشل|انتهت مهلة)/iu;
  return capability.test(value) && state.test(value) ||
    /\b(?:I|the\s+agent|assistant|runtime|Estacoda)\s+(?:cannot|can't|can’t|could\s+not|does\s+not\s+have)\s+(?:currently\s+)?(?:browse|search\s+the\s+web|access\s+(?:the\s+)?(?:internet|browser|tools))\b/iu.test(value) ||
    /(?:لا أستطيع|لا يستطيع الوكيل)\s+(?:التصفح|البحث على الويب|الوصول إلى المتصفح)/u.test(value);
}

export function factContainsTransientCapabilityState(fact: Pick<ExtractedFact, "statement" | "evidence">): boolean {
  return isTransientCapabilityState(fact.statement) || fact.evidence.some((evidence) => isTransientCapabilityState(evidence.exactSpan));
}

/** Mixed preference/state lines require editing by a person, not a removal proposal. */
export function containsDurableChoice(text: string): boolean {
  return /\b(?:prefer|prefers|preference|do\s+not\s+browse|don['’]t\s+browse|never\s+browse|default|policy)\b|(?:أفضل|يفضل|تفضيل|لا تتصفح|عطلت|اخترت|إعداد|سياسة)/iu.test(text) || /\b(?:I|we|user)\s+(?:have\s+)?(?:configured|disabled|chose|chosen|choose|opted)\b/iu.test(text);
}
