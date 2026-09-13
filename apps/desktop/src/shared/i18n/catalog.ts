import {libraryArabic} from './library.js';
import {onboardingArabic} from './onboarding.js';
import {settingsArabic} from './settings.js';
import {evidenceArabic} from './evidence.js';
import {setupArabic} from './setup.js';
import {workArabic} from './work.js';
/** Product-owned message keys. Never pass provider output or backend error text here. */
export const arabic = {
 ...libraryArabic,
 ...onboardingArabic,
 ...settingsArabic,
 ...evidenceArabic,...workArabic,
 ...setupArabic,
 'Message unavailable.':'الرسالة غير متاحة.',
 'Runtime':'بيئة التشغيل',
 'Reconnect':'إعادة الاتصال',
 'Connecting to your runtime':'جارٍ الاتصال ببيئة التشغيل',
 'Loading this profile’s canonical Work and attention items.':'جارٍ تحميل العمل والعناصر التي تتطلب انتباهك لهذا الملف الشخصي.',
 'Connection interrupted':'انقطع الاتصال',
 'Reconnecting to the runtime. Work continues under its existing execution owner.':'جارٍ إعادة الاتصال ببيئة التشغيل. يستمر العمل تحت إدارة جهة التنفيذ الحالية.',
 'Profile inspection unavailable':'فحص الملف الشخصي غير متاح',
 'The runtime could not inspect this profile. Retry, or use the CLI to check profile compatibility and repair the installation.':'تعذّر على بيئة التشغيل فحص هذا الملف الشخصي. أعد المحاولة أو استخدم واجهة سطر الأوامر للتحقق من التوافق وإصلاح التثبيت.',
 'Runtime update required':'يلزم تحديث بيئة التشغيل',
 'This app and the control service use incompatible protocol versions. Update the installation before reconnecting.':'يستخدم التطبيق وخدمة التحكم إصدارين غير متوافقين من البروتوكول. حدّث التثبيت قبل إعادة الاتصال.',
 'Ready':'جاهز',
 'Your profile is connected.':'ملفك الشخصي متصل.',
 'English':'الإنجليزية',
 'Arabic':'العربية',
 'Display language':'لغة العرض',
 'Changes this app only. Agent response language is configured separately.':'يغيّر لغة هذا التطبيق فقط. تُضبط لغة ردود الوكيل بشكل منفصل.',
 'Appearance preferences are unavailable.':'تفضيلات المظهر غير متاحة.',
 'Appearance changed for this window, but could not be saved.':'تغيّر مظهر هذه النافذة، لكن تعذّر حفظه.',
 'EstaCoda desktop':'تطبيق EstaCoda لسطح المكتب',
} as const;
export type MessageKey=keyof typeof arabic;
export const english:Readonly<Record<MessageKey,string>>=Object.freeze(Object.fromEntries(Object.keys(arabic).map(key=>[key,key])) as Record<MessageKey,string>);
