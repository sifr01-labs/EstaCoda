export type RoutingFallbackReason = 'authentication' | 'rate-limited' | 'engine-unavailable' | 'credentials-unavailable' | 'timeout' | 'service-error' | 'invalid-response' | 'uncertain';
/** Bounded presentation fact; never carries user text, credentials or authorization. */
export type RoutingStatus = {
  stage: 'intent-skills' | 'capabilities' | 'discovery';
  configuredMode: 'standard' | 'jev-assisted';
  actualEngine: 'standard' | 'jev';
  model?: string;
  fallbackReason?: RoutingFallbackReason;
};
export type RoutingCheckResult = {
  state: 'ready' | 'failed' | 'disabled';
  reason?: 'credentials-unavailable' | 'authentication' | 'timeout' | 'cancelled' | 'stale' | 'rate-limited' | 'invalid-response' | 'service-error' | 'configuration-unavailable';
  model?: string;
};

export function formatRoutingStatus(status: RoutingStatus, locale: 'en' | 'ar' = 'en'): string {
  const ar = locale === 'ar';
  const stage = { 'intent-skills': ar ? 'النوايا والمهارات' : 'intents and skills', capabilities: ar ? 'القدرات' : 'capabilities', discovery: ar ? 'اكتشاف القدرات' : 'capability discovery' }[status.stage];
  const engine = status.actualEngine === 'jev' ? `Jev${status.model ? ` (${ar ? '\u2068' : ''}${status.model}${ar ? '\u2069' : ''})` : ''}` : ar ? 'قياسي' : 'Standard';
  const reasons: Record<NonNullable<RoutingStatus['fallbackReason']>, string> = {
    'engine-unavailable': ar ? 'تغيرت الإعدادات أو لم يعد التوجيه متاحاً.' : 'Routing settings changed or became unavailable.',
    'credentials-unavailable': ar ? 'أضف مفتاح TypeSafe في الإعدادات.' : 'Add a TypeSafe key in settings.',
    authentication: ar ? 'رفض TypeSafe بيانات الاتصال. حدّث المفتاح في الإعدادات.' : 'TypeSafe rejected the credentials. Update the key in settings.',
    'rate-limited': ar ? 'بلغ TypeSafe حد الطلبات.' : 'TypeSafe limited the request rate.',
    timeout: ar ? 'انتهت مهلة TypeSafe.' : 'TypeSafe timed out.',
    'service-error': ar ? 'تعذر الوصول إلى TypeSafe.' : 'TypeSafe could not complete the request.',
    'invalid-response': ar ? 'لم يُرجع TypeSafe قراراً صالحاً.' : 'TypeSafe returned an unusable decision.',
    uncertain: ar ? 'كان قرار Jev غير مؤكد أو غير مكتمل.' : 'Jev’s decision was uncertain or incomplete.'
  };
  const fallback = status.configuredMode === 'jev-assisted' && status.actualEngine === 'standard';
  return `${ar ? 'التوجيه' : 'Routing'} · ${stage}: ${engine}${fallback ? ` — ${ar ? 'تم استخدام التوجيه القياسي لهذه الخطوة.' : 'Standard fallback for this step.'} ${reasons[status.fallbackReason ?? 'engine-unavailable']}` : ''}`;
}

/** Fixed diagnostic copy: provider error bodies never reach a user surface. */
export function formatRoutingCheck(result: RoutingCheckResult, locale: 'en'|'ar'='en'): string {
  if(result.state==='ready')return locale==='ar'?'اتصال Jev جاهز.':'Jev connection is ready.';
  if(result.state==='disabled')return locale==='ar'?'التوجيه القياسي مفعّل؛ لم يُرسل أي طلب.':'Standard is enabled; no request was sent.';
  const copy:Record<NonNullable<typeof result.reason>,[string,string]>={
    'credentials-unavailable':['Add a TypeSafe key, save changes, then check again.','أضف مفتاح TypeSafe واحفظ التغييرات ثم أعد الفحص.'],
    authentication:['TypeSafe rejected the key. Update it, save changes, then check again.','رفض TypeSafe المفتاح. حدّثه واحفظ التغييرات ثم أعد الفحص.'],
    timeout:['TypeSafe timed out. Try again.','انتهت مهلة TypeSafe. حاول مجددًا.'],
    cancelled:['Connection check cancelled.','أُلغي فحص الاتصال.'],
    stale:['Settings changed during the check. Check the saved settings again.','تغيرت الإعدادات أثناء الفحص. أعد فحص الإعدادات المحفوظة.'],
    'rate-limited':['TypeSafe limited the request rate. Try again later.','بلغ TypeSafe حد الطلبات. حاول لاحقًا.'],
    'invalid-response':['TypeSafe returned an unusable response. Try again.','أعاد TypeSafe استجابة غير صالحة. حاول مجددًا.'],
    'service-error':['TypeSafe could not complete the check. Try again.','تعذر على TypeSafe إكمال الفحص. حاول مجددًا.'],
    'configuration-unavailable':['Saved routing settings could not be read. Review settings.','تعذرت قراءة إعدادات التوجيه المحفوظة. راجع الإعدادات.'],
  };
  return copy[result.reason??'service-error'][locale==='ar'?1:0];
}
