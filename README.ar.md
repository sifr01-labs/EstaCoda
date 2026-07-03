![لافتة EstaCoda](assets/estacoda-readme-banner.png)

# EstaCoda

[English](./README.md)

منصة تشغيل مفتوحة المصدر لـ Agent Evolution — الأولى من نوعها التي بُنيت في العالم العربي.

EstaCoda وكيل ذكاء اصطناعي يعمل من الطرفية ويتحسن مع العمل الحقيقي. يستخدم الأدوات، ويحفظ السياق بين الجلسات، ويعمل عبر قنوات المراسلة، ويشغّل المهام المتكررة، ويحوّل أنماط التنفيذ المتكررة إلى مهارات وسير عمل قابلة لإعادة الاستخدام.

استخدم النموذج الذي تفضله. شغّله محليًا، على خادم، عبر Docker، أو من WSL2. استخدمه من الطرفية وTelegram وWhatsApp المحصور ببوابة تجريبية. توجد موائمات Discord وEmail للمشغّلين الذين يتحققون منها في بيئتهم.

بُنيت EstaCoda لتعامل العربية كلغة تشغيل أساسية، مع دعم تشكيل النص العربي واتجاهه ثنائي الاتجاه داخل الطرفية لسير العمل الحقيقي.

وعندما تقترح EstaCoda تغييرات على بنيتها التشغيلية، تبقى هذه التغييرات قابلة للمراجعة: دليل، فرضية، موافقة، ومسار رجوع — لا تعديل صامت.

بُنيت بواسطة Kemet Research.

---

## لماذا EstaCoda؟

| إذا كنت تريد... | EstaCoda تمنحك... |
|---|---|
| وكيلًا يتحسن مع الوقت | مهارات، ذاكرة، سير عمل، ومقترحات تحسين قابلة للمراجعة مبنية على أنماط تنفيذ حقيقية. |
| طرفية تشغيل حقيقية | جلسات CLI مع تنفيذ أدوات، موافقات، حالة مرتبطة بالملف الشخصي، سجل دائم، وعرض عربي مشكّل ثنائي الاتجاه. |
| وكيلًا يرافقك أينما تعمل | CLI وTelegram كأقوى قناتين، وWhatsApp عبر bridge معزول ومحكوم ببوابة، وموائمات Discord/Email للبيئات التي يتحقق منها المشغّل. |
| عملًا يتم دون متابعة مستمرة | مهام cron وسير عمل دائم يمكن أن تعمل دون حضورك وتعيد النتائج إليك. |
| حرية اختيار النموذج | OpenRouter وKimi وDeepSeek وOpenAI وGoogle ونقاط نهاية محلية أو ذاتية الاستضافة ومزوّدون آخرون عبر الإعدادات. |
| أكثر من مجرد محادثة | بحث على الويب، أتمتة متصفح، مزوّدو صوت مستضافون، توليد صور، ملفات، أوامر shell، وسير عمل بالأدوات. |
| قدرات قوية دون تعديل غامض | مقترحات واضحة، دليل، موافقة، مسار رجوع، وحدود أمان صلبة. |

---

## حلقة Agent Evolution

1. أعطِ EstaCoda عملًا حقيقيًا.
2. تستخدم الأدوات، الذاكرة، المهارات، أتمتة المتصفح، أوامر shell، المهام المجدولة، والتسليم عبر القنوات حسب الحاجة.
3. عندما يتكرر نمط مفيد، يمكنها اقتراح مهارة أو سير عمل أو تحسين للبنية التشغيلية.
4. تراجع الدليل، ثم توافق على التغيير، أو تعدّله، أو ترفضه.
5. تبدأ الجلسات التالية بسياق أفضل وقدرات قابلة لإعادة الاستخدام أكثر من الجلسة السابقة.

---

## أمثلة على الاستخدام

```text
"كل صباح، راجع طلباتي، ورسائل الموردين، ومشاكل التوصيل. أرسل لي ملخصًا على Telegram بالعربية يتضمن ما يحتاج إلى إجراء."

"راقب رسائل العملاء من Telegram والبريد الإلكتروني، صنّفها حسب المشكلة، واكتب مسودات ردود بالعربية والإنجليزية."

"قارن بوابات الدفع لمتجر إلكتروني يبيع في مصر والسعودية والإمارات. افحص الأسعار، مواعيد التسوية، الدعم المحلي، وجهد التكامل."

"راقب مواقع وصفحات المنافسين في الخليج ومصر والأردن. لخّص المنتجات الجديدة، تغييرات الأسعار، والحملات كل يوم أحد."

"تابع هذا GitHub repo وأخبرني بما تغيّر قبل اجتماع الإصدار الأسبوعي. حوّل قائمة الإصدار إلى workflow قابل لإعادة الاستخدام."

"ابحث عن موردي تغليف في القاهرة والرياض والدار البيضاء ودبي. قارن الحد الأدنى للطلب، مواعيد التسليم، والتكلفة المتوقعة."

"حضّر قائمة متابعة مبيعات أسبوعية من email threads. افصل العملاء المهتمين، الصفقات المتوقفة، والأشخاص الذين يحتاجون إلى تذكير."

"راقب إعلانات العقارات في الرياض والقاهرة وعمّان ودبي. نبّهني عند تغيّر الأسعار أو ظهور وحدة مشابهة."

"تابع المناقصات وإعلانات المشتريات في قطاعي. لخّص الفرص المناسبة والمواعيد النهائية كل أسبوع."

"ابحث عن مقاهي أو عيادات أو متاجر بوتيك تفتح فروعًا جديدة في مدينتي. ابنِ قائمة قصيرة لفرص الشراكة أو المبيعات."
```

---

## التثبيت السريع

macOS وLinux وWSL2 وTermux:

```bash
curl -fsSL https://www.estacoda.com/install.sh | bash
```

ينشئ المثبّت تثبيتًا من نوع managed-source، ويربط أمر التشغيل إلى `~/.local/bin/estacoda`، ويضيف PATH إلى ملف إعدادات shell عند الحاجة. بعد التثبيت، أعد تحميل shell أو افتح طرفية جديدة.

لخطوات الإعداد الكاملة، راجع [Quickstart](https://www.estacoda.com/docs/getting-started/quickstart).

---

## التشغيل الأول

```bash
estacoda init    # create the default profile and state directories
estacoda setup   # configure provider, model, security mode, and optional channels
estacoda         # start an interactive session
```

يقودك `estacoda setup` خلال اختيار المزوّد، تخزين API key، وضع الأمان، والقدرات الاختيارية. يعرض الإعداد المقترح قبل كتابة أي شيء.

---

## أوامر شائعة

```bash
estacoda                       # start a terminal session
estacoda init                  # initialize profile and state directories
estacoda setup                 # run the interactive setup wizard
estacoda update                # update using the current install method
estacoda update --check        # check for updates without modifying files
estacoda uninstall             # remove install code and wrappers; keep user data
estacoda uninstall --purge     # remove install code and user data
estacoda whatsapp              # start the WhatsApp setup wizard
```

لواجهة الأوامر الكاملة، راجع [CLI Commands](https://www.estacoda.com/docs/reference/cli-commands).

---

## القدرات ومستوى النضج

تميّز EstaCoda بين القدرات المثبتة عمليًا، والقابلة للإعداد، والتجريبية، والناشئة. هذا README يعطي النسخة المختصرة؛ أما التفاصيل الكاملة للإعداد واستكشاف الأعطال فهي في الوثائق.

### مزوّدو نماذج اللغة

| المزوّد | مستوى النضج |
|---|---|
| OpenAI | مثبت عمليًا |
| Kimi | مثبت عمليًا |
| DeepSeek | مثبت عمليًا |
| OpenRouter | مثبت عمليًا |
| Google | قابل للإعداد |
| Local / self-hosted | مدعوم عبر نقاط نهاية OpenAI-compatible محلية |

تعمل المزوّدات المتوافقة مع OpenAI عند تحديد `baseUrl` صراحة. المزوّد المعروف في الكتالوج لا يصبح قابلًا للتشغيل تلقائيًا؛ راجع مرجع المزوّدين قبل استخدامه كمسار رئيسي.

### القنوات

| القناة | مستوى النضج |
|---|---|
| CLI | أساسي |
| Telegram | مثبت عمليًا |
| WhatsApp | تشغيلي مع خطر API خارجي؛ محصور بـ `channels.whatsapp.experimental: true` |
| Discord | مطبق ومدعوم باختبارات؛ يحتاج تحقق المشغّل |
| Email | مطبق ومدعوم باختبارات؛ يحتاج تحقق المشغّل |

يستخدم WhatsApp جسر Baileys معزولًا تحت `scripts/whatsapp-bridge/`. تُدار تبعيات الجسر بشكل منفصل ولا تكون جزءًا من root pnpm workspace. راجع وثائق القنوات لمعرفة الإعداد، التفويض، الاقتران، وسلوك التسليم.

### قدرات أخرى

| القدرة | الحالة |
|---|---|
| دعم العربية في الطرفية | مدعوم مع تشكيل النص العربي واتجاهه ثنائي الاتجاه داخل سير عمل الطرفية. |
| أتمتة المتصفح | يدعم Local CDP، بما في ذلك تشغيل Chrome/Chromium تحت إشراف. Browserbase مطبق خلف موافقة صريحة على تكلفة السحابة. |
| البحث على الويب | يدعم fetch/extraction داخليًا بحواجز تشغيلية. بعض مزوّدي البحث الإضافيين مسجلون لكن ليسوا جميعًا مدعومين عمليًا. |
| الصوت | يدعم hosted TTS وhosted STT. يستخدم Local STT افتراضيًا faster-whisper المُدار تحت `~/.estacoda/python-env`. |
| توليد الصور | يدعم FAL وBytePlus/Seedream. |
| جدولة cron | مدعومة. |
| Workflow durable execution | مدعوم. |
| Skills | مدعومة. |
| Memory | مدعومة. |

---

## المنصات المدعومة

| المنصة | الحالة |
|---|---|
| macOS 11+ | مدعوم |
| Linux | مدعوم؛ تم التحقق على Ubuntu 22.04+ وDebian 12+ |
| Docker | مدعوم في البيئات التي تدعم Docker |
| WSL2 | أفضل جهد؛ الصوت والميكروفون وخدمات systemd user قد تحتوي على حالات طرفية |
| Termux | أفضل جهد؛ يتعامل مع بنية `$PREFIX/bin`، لكنه ليس هدف التحقق الأساسي |
| Native Windows | غير مدعوم |

---

## المتطلبات

### المتطلبات الأساسية

- Node.js >= 22.18.0
- pnpm عبر Corepack أو ما يعادله
- Git
- POSIX shell

### متطلبات اختيارية حسب طريقة التثبيت أو الميزة

- Docker لاستخدام الحاويات
- Homebrew لمسار التثبيت عبر Homebrew
- ffmpeg لبعض مسارات الصوت والوسائط

---

## الحالة والملفات الشخصية

تخزّن EstaCoda حالة المستخدم تحت `~/.estacoda/`.

| نوع الحالة | المحتويات |
|---|---|
| الحالة العامة | الملف الشخصي النشط، سجلات الثقة، قاعدة بيانات الجلسات، update cache |
| حالة الملف الشخصي | الإعدادات، بيانات الاعتماد، ملفات الذاكرة، المهارات، cron jobs، إعدادات gateway، السجلات |

يتم اختيار الملف الشخصي النشط في:

```bash
~/.estacoda/active-profile.json
```

كل ملف شخصي يملك إعداداته، بيانات اعتماده، ذاكرته، حالة gateway، وسجلاته.

راجع [State and Files](https://www.estacoda.com/docs/reference/state-and-files) للنموذج الكامل للحالة.

---

## حدود الأمان

صُممت EstaCoda لسير عمل قوي بالوكلاء، لكنها تجعل التغييرات عالية الأثر صريحة.

- يعرض setup الإعداد المقترح قبل كتابته.
- تبقى hard safety blocks فعالة في كل أوضاع الأمان.
- وضع `open` لا يعني أن الأمان متوقف.
- التحديثات تعدّل فقط مواقع التثبيت التي تملكها طريقة التثبيت المحددة.
- تتطلب managed installs وجود installer ownership stamps قبل إزالة كود التثبيت.
- تُحفظ بيانات المستخدم افتراضيًا أثناء uninstall.
- تحسينات البنية التشغيلية تتطلب مقترحات قابلة للمراجعة بدل التعديل الصامت.

راجع [Security and Approvals](https://www.estacoda.com/docs/user-guide/security-and-approvals) للنموذج الكامل.

---

## الوثائق

كل الوثائق موجودة على [www.estacoda.com/docs](https://www.estacoda.com/docs/).

| القسم | ماذا يغطي |
|---|---|
| [Quickstart](https://www.estacoda.com/docs/getting-started/quickstart) | التثبيت، الإعداد، وأول جلسة |
| [Installation](https://www.estacoda.com/docs/getting-started/installation) | مسارات التثبيت ودعم أنظمة التشغيل |
| [Updating](https://www.estacoda.com/docs/getting-started/updating) | أوامر التحديث، التوجيه، وحدود الأمان |
| [Uninstall](https://www.estacoda.com/docs/getting-started/uninstall) | سلوك الإزالة وحدود البيانات |
| [CLI Usage](https://www.estacoda.com/docs/user-guide/cli) | الأوامر، الجلسات، والملفات الشخصية |
| [Providers](https://www.estacoda.com/docs/user-guide/providers) | إعداد المزوّدين، مستوى النضج، والتوجيه |
| [Channels](https://www.estacoda.com/docs/user-guide/channels) | Telegram وWhatsApp وإعداد القنوات |
| [Gateway](https://www.estacoda.com/docs/user-guide/gateway) | وضع الخدمة، التشخيص، والموافقات |
| [Skills](https://www.estacoda.com/docs/user-guide/skills) | التحميل، التطور، والمقترحات |
| [Memory](https://www.estacoda.com/docs/user-guide/memory) | ذاكرة الملف الشخصي، الترقية، والحدود |
| [Security and Approvals](https://www.estacoda.com/docs/user-guide/security-and-approvals) | الأوضاع، حدود الثقة، والحواجز الصلبة |
| [Configuration](https://www.estacoda.com/docs/reference/configuration) | مرجع ملف الإعدادات |
| [CLI Commands](https://www.estacoda.com/docs/reference/cli-commands) | مرجع كامل للأوامر والخيارات |
| [Troubleshooting](https://www.estacoda.com/docs/reference/troubleshooting) | الأعطال الشائعة وطرق التعافي |

---

## تثبيت المساهمين

```bash
git clone https://github.com/sifr01-labs/EstaCoda.git
cd EstaCoda
./scripts/setup-estacoda.sh
```

يثبّت السكربت التبعيات، يبني المشروع، ويعرض إنشاء wrapper محلي. هذا ينشئ تثبيتًا من نوع manual-source.

بعد الإعداد:

```bash
estacoda init
estacoda setup
estacoda
```

قبل فتح pull request، شغّل أوامر التحقق الموثقة في [CONTRIBUTING.md](./CONTRIBUTING.md).

---

## التحديث

```bash
estacoda update
```

يعتمد سلوك التحديث على طريقة التثبيت:

| طريقة التثبيت | السلوك |
|---|---|
| managed-source | guarded git pull، إعادة تثبيت التبعيات، build، validation، ورجوع تلقائي عند فشل البناء |
| manual-source | فحص وإرشاد فقط؛ لا self-mutation |
| Homebrew | يوجّه إلى `brew upgrade` |
| Docker | يوجّه إلى `docker pull` |
| npm | يوجّه إلى `npm install -g estacoda@latest` عند النشر |

خيارات مفيدة:

```bash
estacoda update --check    # report availability without modifying files
estacoda update --yes      # apply without interactive confirmation where safe
estacoda update --gateway  # run in non-interactive service mode
```

فحوصات التحديث عند بدء التشغيل مفعّلة افتراضيًا. تعمل كجلب خلفي غير حاجب داخل جلسات CLI التفاعلية، تستخدم cache مدتها ست ساعات، وتفشل بصمت عند أخطاء الشبكة.

راجع [Updating](https://www.estacoda.com/docs/getting-started/updating) لواجهة التحديث الكاملة.

---

## إزالة التثبيت

```bash
estacoda uninstall               # remove install code and wrappers; keep user data
estacoda uninstall --purge --yes  # also remove user data
```

الإزالة الافتراضية تحفظ `~/.estacoda`.

تُزال مجلدات managed-source فقط عندما يثبت installer stamp صالح الملكية. تُحفظ manual-source checkouts. أما تثبيتات package-manager والحاويات فتُوجّه إلى أدواتها بدل أن تُعدّل ذاتيًا.

راجع [Uninstall](https://www.estacoda.com/docs/getting-started/uninstall) للسلوك الخاص بكل طريقة تثبيت وقواعد الملكية.

---

## المساهمة

راجع [CONTRIBUTING.md](./CONTRIBUTING.md) لإعداد التطوير، سير العمل على الفروع، أوامر التحقق، وقواعد المساهمة.

راجع [AGENTS.md](./AGENTS.md) لإرشادات استخدام مساعدين برمجيين بالذكاء الاصطناعي مع هذا المستودع.

راجع [SECURITY.md](./SECURITY.md) لنموذج الأمان، آلية الإبلاغ عن الثغرات، والإصدارات المدعومة.

---

## الترخيص

Apache License 2.0 — راجع [LICENSE](./LICENSE).
