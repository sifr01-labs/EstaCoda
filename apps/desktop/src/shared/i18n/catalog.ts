import {schedulesArabic} from './schedules.js';
import {libraryArabic} from './library.js';
import {onboardingArabic} from './onboarding.js';
import {settingsArabic} from './settings.js';
import {evidenceArabic} from './evidence.js';
import {setupArabic} from './setup.js';
import {workArabic} from './work.js';
/** Product-owned message keys. Never pass provider output or backend error text here. */
export const arabic = {
 'Some archived chats could not be loaded. Try opening Archived again.':'تعذّر تحميل بعض المحادثات المؤرشفة. أعد فتح المؤرشفة للمحاولة مجددًا.',
 'Pin':'تثبيت',
 'Rename chat':'إعادة تسمية المحادثة',
 'Chat name':'اسم المحادثة',
 'Save name':'حفظ الاسم',
 'Mark as unread':'وضع علامة غير مقروءة',
 'Archive chat':'أرشفة المحادثة',
 'Restore chat':'استعادة المحادثة',
 'Open workspace folder':'فتح مجلد مساحة العمل',
 'Copy conversation':'نسخ المحادثة',
 'Copy chat ID':'نسخ معرّف المحادثة',
 'Chat actions':'إجراءات المحادثة',
 'Unassigned':'غير مرتبطة',
 'Opening chat…':'جارٍ فتح المحادثة…',
 'Chat could not be opened':'تعذّر فتح المحادثة',
 'Your conversation is loading.':'جارٍ تحميل محادثتك.',
 'Try again to load this conversation. Your saved messages have not been changed.':'أعد المحاولة لتحميل هذه المحادثة. لم تتغير رسائلك المحفوظة.',
 'Try again':'أعد المحاولة',
 'Chat preferences could not be saved. Keep this window open and try again.':'تعذّر حفظ تفضيلات المحادثة. أبقِ هذه النافذة مفتوحة وأعد المحاولة.',
 'Chat action could not complete.':'تعذّر إتمام إجراء المحادثة.',
 'Conversation is too long to copy at once.':'المحادثة أطول من أن تُنسخ دفعة واحدة.',

 ...schedulesArabic,
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
 'Database upgrade required':'يلزم ترقية قاعدة البيانات',
 'Your saved Work uses an older database format. Stop older CLI and gateway processes, back up the shared database, and migrate it using this version of EstaCoda core. Then reconnect. Desktop does not change the database during inspection.':'تستخدم أعمالك المحفوظة تنسيقًا أقدم لقاعدة البيانات. أوقف عمليات واجهة الأوامر والبوابة القديمة، وأنشئ نسخة احتياطية من قاعدة البيانات المشتركة، ثم رقّها باستخدام هذا الإصدار من نواة EstaCoda. بعد ذلك أعد الاتصال. لا يغيّر تطبيق سطح المكتب قاعدة البيانات أثناء الفحص.',
 'Newer app required':'يلزم إصدار أحدث من التطبيق',
 'Your saved Work was created by a newer version of EstaCoda. Update this app and its core runtime before reconnecting. Do not downgrade the database.':'أُنشئت أعمالك المحفوظة بإصدار أحدث من EstaCoda. حدّث التطبيق ونواة التشغيل قبل إعادة الاتصال. لا تُرجع قاعدة البيانات إلى إصدار أقدم.',
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
