/**
 * Arabic (ar) — the seventh locale.
 *
 * WHY A SEPARATE MODULE
 * =====================
 * The other six live inline in `src/i18n.ts`, which is where the `Strings`
 * interface they are checked against is declared. Arabic is close to a thousand
 * further keys, and appending them to that file would put a 1,400-line block of
 * new work at the end of a document a reader opens to find one of six existing
 * translations — and would make a review of this phase indistinguishable from a
 * review of that file. Keeping it here leaves the six shipped locales
 * byte-identical and makes the new work reviewable on its own.
 *
 * The contract is unchanged: `Strings` is the type, so a missing key, a renamed
 * key or a mistyped value is a compile error, and `npm run check:i18n` then
 * verifies placeholders across every locale against the same reference.
 *
 * WHY ARABIC IS RIGHT-TO-LEFT
 * ==========================
 * Arabic is written right to left, and that is not only a text direction: the
 * reading order starts at the right edge, punctuation hangs off the left, and a
 * number inside a sentence keeps its own left-to-right digits. A layout that
 * merely sets `dir="rtl"` gets the text right and the furniture wrong, so the
 * direction is applied at the document root here and the stylesheets use logical
 * properties throughout.
 */

import { plurals } from "../i18n";
import type { Strings } from "../i18n";

/**
 * The locale tag whose plural rules select between the forms below.
 *
 * Arabic has six CLDR categories: zero, one, two, few (3–10), many (11–99) and
 * other (100+, and anything else). The forms are supplied per key rather than
 * derived, because the choice belongs to the sentence, not to the number alone.
 */
const AR = "ar";

export const ar: Strings = {
  appName: "Daltoon X",
  coffee: {
    nav: "اشترِ لي فنجان قهوة",
    cta: "ادعم الإصدار التالي",
    fewer: "قهوة واحدة أقل",
    more: "قهوة واحدة أكثر",
  },

  // A count of tweaks. Arabic takes the noun's form from the number that
  // precedes it: one, two, a few (3–10), many (11–99), or the plain plural.
  appliedCount: plurals(AR, {
    one: "{applied} تعديل من أصل {total} مُفعَّل",
    two: "{applied} تعديلان من أصل {total} مُفعَّلان",
    few: "{applied} تعديلات من أصل {total} مُفعَّلة",
    many: "{applied} تعديلاً من أصل {total} مُفعَّلاً",
    other: "{applied} تعديل من أصل {total} مُفعَّل",
  }),

  headerNote:
    "راجع كل تغيير قبل تطبيقه. أدوات الاستعادة تغطي الإعدادات المدعومة، بينما لعمليات التنظيف والإصلاح حدود استرداد مختلفة.",
  advisor: {
    eyebrow: "موصى به لجهازك",
    applyButton: "تطبيق",
    confidenceHigh: "ثقة عالية — مبني على عتاد هذا الجهاز",
    confidenceStandard: "موصى به لهذا النوع من الأجهزة",
    reversible: "قابل للتراجع — تُحفظ القيمة الأصلية قبل أي تغيير.",
    empty: "لا شيء نوصي به الآن — إعداداتك توافق توصياتنا بالفعل.",
  },
  drift: {
    titleAfterUpdate: "أعد نظام Windows إعداداتك إلى ما كانت عليه",
    titleNoUpdate: "بعض الإعدادات لم تعد سارية",
    afterUpdateOne: "بعد التحديث إلى {patch}، لم يعد أحد التعديلات التي طبّقتها ساريًا على النظام.",
    afterUpdateMany: plurals(AR, {
      one: "بعد التحديث إلى {patch}، ألغى Windows تفعيل {count} تعديل طبّقته.",
      two: "بعد التحديث إلى {patch}، ألغى Windows تفعيل {count} تعديلين طبّقتهما.",
      few: "بعد التحديث إلى {patch}، لم تعد {count} تعديلات طبّقتها سارية على النظام.",
      many: "بعد التحديث إلى {patch}، لم يعد {count} تعديلاً طبّقته سارياً على النظام.",
      other: "بعد التحديث إلى {patch}، لم يعد {count} تعديل طبّقته سارياً على النظام.",
    }),
    noUpdateOne:
      "لم يعد أحد التعديلات التي طبّقتها ساريًا على النظام. لم يحدث أي تحديث لويندوز في هذه الفترة، لذا فقد غيّره شيء آخر.",
    noUpdateMany: plurals(AR, {
      one: "لم يحدث أي تحديث لويندوز في هذه الفترة، لذا غيّره شيء آخر، فلم يبقَ له أثر في {count} تعديل طبّقته.",
      two: "لم يحدث أي تحديث لويندوز في هذه الفترة، لذا غيّرهما شيء آخر، فلم يبقَ له أثر في {count} تعديلين طبّقتهما.",
      few: "لم تعد {count} تعديلات طبّقتها سارية على النظام. لم يحدث أي تحديث لويندوز في هذه الفترة، لذا فقد غيّرها شيء آخر.",
      many: "لم يعد {count} تعديلاً طبّقته سارياً على النظام. لم يحدث أي تحديث لويندوز في هذه الفترة، لذا فقد غيّره شيء آخر.",
      other:
        "لم يعد {count} تعديل طبّقته سارياً على النظام. لم يحدث أي تحديث لويندوز في هذه الفترة، لذا فقد غيّره شيء آخر.",
    }),
    reapplyOne: "أعد تطبيق التعديل",
    reapplyMany: plurals(AR, {
      one: "أعد تطبيق {count} تعديل",
      two: "أعد تطبيق {count} تعديلين",
      few: "أعد تطبيق {count} تعديلات",
      many: "أعد تطبيق {count} تعديلاً",
      other: "أعد تطبيق {count} تعديل",
    }),
    reapplying: "جارٍ إعادة التطبيق…",
    reappliedOne: "أُعيد تطبيق التعديل.",
    reappliedMany: plurals(AR, {
      one: "أُعيد تطبيق {count} تعديل.",
      two: "أُعيد تطبيق {count} تعديلين.",
      few: "أُعيد تطبيق {count} تعديلات.",
      many: "أُعيد تطبيق {count} تعديلاً.",
      other: "أُعيد تطبيق {count} تعديل.",
    }),
  },
  crashes: {
    title: "إيقاف تشغيل غير متوقّع",
    subtitle:
      "أُغلق التطبيق من تلقاء نفسه. يبقى التقرير على هذا الجهاز: انسخه وأرسله عبر Discord أو GitHub إن أردت إصلاحه.",
    copy: "نسخ التقرير",
    copied: "نُسخ التقرير إلى الحافظة.",
    clear: "مسح",
    cleared: "مُسحت التقارير.",
    processApp: "النافذة الرئيسية",
    processElevated: "عملية تتطلب صلاحيات المشرف",
  },
  ledger: {
    title: "سجل التغييرات",
    subtitle:
      "كل ما غيّره هذا التطبيق على هذا الجهاز، الأحدث أولاً. يُخزَّن محلياً ولا يُرفع أبداً.",
    empty: "لم تُسجَّل أي تغييرات بعد. طبّق أول تعديل وستظهر هنا.",
    clear: "مسح السجل",
    clearing: "جارٍ المسح…",
    cleared: "مُسح السجل.",
    revert: "تراجع",
    elevated: "بصلاحيات المشرف",
    failed: "فشل",
    actions: {
      applied: "تم تطبيق تعديل",
      reverted: "تم التراجع عن تعديل",
      cleanup: "تنظيف",
      filesDeleted: "حُذفت ملفات",
      diskOptimize: "تحسين القرص",
      startupChange: "تغيير بدء التشغيل",
      restorePoint: "نقطة استعادة",
    },
  },
  tabs: {
    groupWorkspace: "مساحة العمل",
    overview: "نظرة عامة",
    groupMonitor: "المراقبة",
    groupOptimize: "التحسين",
    groupManage: "الإدارة",
    scan: "الفحص",
    health: "صحة الجهاز",
    hardware: "العتاد",
    performance: "الأداء",
    privacy: "الخصوصية",
    ui: "المظهر",
    manutenzione: "الصيانة",
    gaming: "الألعاب",
    startup: "بدء التشغيل",
    profiles: "الملفات التعريفية",
    pricing: "الخطط والأسعار",
    ledger: "سجل التغييرات",
    applications: "التطبيقات",
  },
  applications: {
    subtitle: "ثبِّت التطبيقات التي تستخدمها بالفعل وحدِّثها.",
    allCategories: "الكل",
    loading: "جارٍ تحميل الفهرس…",
    empty: "لم يُنشر أي تطبيق بعد.",
    loadFailed: "تعذّر الوصول إلى الفهرس.",
    retry: "إعادة المحاولة",
    install: "تثبيت",
    downloading: "جارٍ التنزيل {percent}",
    verifying: "جارٍ التحقق",
    installing: "جارٍ التثبيت…",
    installed: "مثبَّت",
    noVersion: "لا توجد نسخة منشورة",
    version: "الإصدار {version}",
    luaToolsDescription:
      "أدوات لمستودعات Steam: الـdepots والمنifestات والتنزيلات. لا يثبّتها Daltoon X نيابةً عنك.",
    luaToolsOpen: "فتح LuaTools",
    luaToolsNotInstalled: "LuaTools غير مثبَّت",
    luaToolsRuntimeMissing: "تثبيت .NET 8 Desktop Runtime",
    luaToolsOfficialPage: "الانتقال إلى موقع LuaTools",
    luaToolsStarting: "جارٍ تشغيل LuaTools…",
    luaToolsFailed: "تعذّر تشغيل LuaTools",
  },
  healthPanel: {
    title: "صحة الجهاز",
    subtitle: "نتيجة قابلة للتفسير: كل رقم يعرض الحقائق التي احتُسب منها.",
    why: "لماذا {score}؟",
    refresh: "إعادة الاحتساب",
    compute: "احسب نتيجة الصحة",
    showMore: "عرض المزيد",
    showLess: "عرض أقل",
    stageProfile: "جارٍ قراءة ملف النظام",
    stageTweaks: "جارٍ التحقق من التعديلات المطبَّقة",
    stageSecurity: "جارٍ قراءة حالة الأمان",
    stageScoring: "جارٍ الاحتساب",
    verdictExcellent: "ممتاز",
    verdictGood: "جيد",
    verdictFair: "مقبول",
    verdictNeedsWork: "يحتاج إلى عمل",
    computing: "جارٍ التحليل…",
    idleHint: "لا شيء يعمل في الخلفية: تُحسب النتيجة فقط عند طلبك، وبالكامل على هذا الجهاز.",
    baselineTitle: "خط الأساس",
    baselineHint:
      "قياسات سريعة وقابلة للتكرار — قابلة للمقارنة فقط مع القياسات السابقة على هذا الجهاز.",
    baselineRun: "تشغيل خط الأساس",
    baselineRunning: "جارٍ القياس (‏~5 ث)…",
    baselineEmpty: "لا توجد خطوط أساس بعد. شغّل واحداً قبل تطبيق التغييرات وآخر بعدها.",
    changeSinceLast: "مقارنة بآخر فحص لك",
    changeNone: "لا تغيير منذ آخر فحص لك.",
    changeFirstRun: "سُجّل القياس الأول. شغّله مرة أخرى بعد التغيير لترى ما تحرّك.",
    changeWhyTitle: "لماذا تغيّرت النتيجة",
    changeContributes: "المساهمة في النتيجة الإجمالية:",
    changeStructural:
      "أحد تحديثات التطبيق غيّر الفئات التي تُحتسب — جزء من هذا الفرق لم يكن قادمًا من جهازك.",
    changeTrend: "الاتجاه",
    categories: {
      performance: "الأداء",
      gaming: "الألعاب",
      responsiveness: "سرعة الاستجابة",
      memory: "الذاكرة",
      storage: "التخزين",
      startup: "بدء التشغيل",
      maintenance: "الصيانة",
      privacy: "الخصوصية",
      security: "الأمان",
    },
  },
  transparency: {
    title: "ما الذي يغيّره هذا بالضبط",
    key: "المفتاح",
    value: "القيمة",
    setsTo: "يُضبط على",
    note: "تُحفظ القيمة السابقة قبل الكتابة، لذا يعيد التراجع ضبطها كما كانت تماماً.",
    kindRegistry: "السجل",
    kindCommand: "الأمر",
    kindService: "الخدمة",
    copy: "نسخ",
    copied: "تم النسخ",
  },
  command: {
    statusQuiet: "كل الأنظمة هادئة",
    statusScanning: "جارٍ الفحص…",
    statusFindings: plurals(AR, {
      one: "{count} توصية جاهزة",
      two: "{count} توصيتان جاهزتان",
      few: "{count} توصيات جاهزة",
      many: "{count} توصية جاهزة",
      other: "{count} توصية جاهزة",
    }),
    domainsLine: "بدء التشغيل · التخزين · الذاكرة · الخصوصية · الأداء · التحديثات",
    consent: "لا شيء يتغيّر دون موافقتك.",
    runScan: "تشغيل فحص النظام",
    reviewFindings: plurals(AR, {
      one: "راجع {count} توصية",
      two: "راجع {count} توصيتين",
      few: "راجع {count} توصيات",
      many: "راجع {count} توصية",
      other: "راجع {count} توصية",
    }),
    memTitle: "ضغط الذاكرة",
    pressureLow: "منخفض",
    pressureElevated: "مرتفع قليلاً",
    pressureHigh: "مرتفع",
    memReview: "راجع استخدام الذاكرة",
    memTopTitle: "أعلى العمليات استهلاكاً",
    trimTitle: "تصغير مجموعات العمل",
    trimExplainer:
      "يطلب من ويندوز نقل الصفحات الخاملة خارج مجموعات عمل التطبيقات (EmptyWorkingSet). مفيد عند الضغط العالي؛ قد تعيد التطبيقات تحميل بعض الصفحات عند استخدامها التالي. لا تُفقد أي بيانات.",
    trimButton: "صغّر الآن",
    autoTitle: "تصغير تلقائي",
    profilesTitle: "ملفات تعريف الجلسة",
    profileGame: "جلسة لعب",
    profileGameDesc: "يجهّز الجهاز للعب: الطاقة والأولوية وتسجيل DVR.",
    profileFocus: "تركيز",
    profileFocusDesc: "تشتيت أقل، وتحكّم في النشاط غير الضروري.",
    profileQuiet: "جلسة هادئة",
    profileQuietDesc: "الكفاءة والبطارية ومستوى صوت منخفض أولاً.",
    profileDownload: "جلسة تنزيل",
    profileDownloadDesc: "التحكّم في عرض النطاق والنشاط الخلفي.",
    previewBtn: "معاينة التغييرات",
    gameChange1: "إيقاف تشغيل Game DVR (التسجيل الخلفي)",
    gameChange2: "التبديل إلى مخطط طاقة «الأداء العالي»",
    gameChange3: "تحسين أولوية المعالج للألعاب (Win32PrioritySeparation)",
    previewReq: "يتطلب صلاحيات المشرف · ميزة Pro",
    previewCost: "التكلفة المحتملة: استهلاك طاقة وحرارة أعلى أثناء التشغيل.",
    previewRevert: "قابل للتراجع بنقرة واحدة: تُحفظ كل قيمة أصلية أولاً.",
    applySession: "ابدأ الجلسة",
    restoreSession: "استعادة",
    statusActive: "نشِط",
    statusOff: "غير نشِط",
    soon: "قريباً",
  },
  systemMonitor: {
    cpu: "المعالج",
    ram: "الذاكرة",
    disk: "القرص",
    uptime: "مدة التشغيل",
    uptimeValue: "{hours} س {minutes} د",
    cores: plurals(AR, {
      one: "{count} نواة",
      two: "{count} نواتان",
      few: "{count} أنوية",
      many: "{count} نواة",
      other: "{count} نواة",
    }),
  },
  startupManager: {
    title: "برامج بدء التشغيل",
    description:
      "برامج تُفتح تلقائياً عند إقلاع جهازك. إيقاف بعضها يقصّر زمن الإقلاع: يبقى البرنامج مثبَّتاً ويمكنك فتحه يدوياً في أي وقت.",
    empty: "لا توجد برامج مضبوطة على التشغيل التلقائي.",
    activeCount: "نشِط: {enabled} / {total}",
    machineWide: "جميع المستخدمين",
    impactNote: "إيقاف أحدها لا يزيل أي تثبيت ويمكن التراجع عنه في أي وقت.",
    refresh: "تحديث",
    refreshing: "جارٍ إعادة الفحص…",
    hiddenOrphans: plurals(AR, {
      one: "{count} إدخال مخفي: لم يعد البرنامج مثبَّتاً.",
      two: "{count} إدخالان مخفيان: لم يعد البرنامجان مثبَّتين.",
      few: "{count} إدخالات مخفية: لم تعد البرامج مثبَّتة.",
      many: "{count} إدخالاً مخفياً: لم تعد البرامج مثبَّتة.",
      other: "{count} إدخال مخفي: لم تعد البرامج مثبَّتة.",
    }),
    locationRun: "السجل",
    locationRun32: "السجل (32 بت)",
    locationFolder: "مجلد بدء التشغيل",
  },
  systemRepair: {
    title: "فحص وإصلاح سلامة ويندوز",
    description:
      "يفحص ما إذا كانت ملفات نظام ويندوز ومخزن المكوّنات سليمين، ويصلحها من خوادم مايكروسوفت عند الحاجة. الأداتان DISM وSFC نفسها التي يطلب دعم مايكروسوفت من المستخدمين تشغيلها، دون سطر الأوامر.",
    adminNote:
      "يعمل بصلاحيات المشرف: يطلب ويندوز الموافقة مرة واحدة، وتُؤخذ نقطة استعادة قبل أي تغيير.",
    timeNote:
      "قد يستغرق الإصلاح الكامل 20 دقيقة أو أكثر. يمكنك مواصلة استخدام الجهاز — فقط لا تُطفئه.",
    checkButton: "فحص السلامة",
    checking: "جارٍ الفحص…",
    cleanupButton: "تصغير مخزن المكوّنات",
    cleaningUp: "جارٍ التصغير…",
    cleanupNote:
      "يزيل إصدارات المكوّنات المستبدَلة من مجلد WinSxS. تبقى التحديثات المُحدَّثة حديثاً قابلة لإلغاء التثبيت.",
    runningNote: "لا تُطفئ الجهاز ولا تُعيد تشغيله أثناء تنفيذ هذه العملية.",
    stepQuick: "قراءة سريعة للحالة",
    stepScan: "جارٍ فحص مخزن المكوّنات",
    stepRestore: "جارٍ إصلاح مخزن المكوّنات",
    stepSfc: "جارٍ فحص ملفات النظام",
    stepCleanup: "جارٍ تصغير مخزن المكوّنات",
    stepOf: "الخطوة {index} من {total}",
    statusHealthy: "ويندوز سليم",
    statusRepairable: "وُجد تلف ويمكن إصلاحه",
    statusRepaired: "وُجد التلف وأُصلح",
    statusUnrepairable: "وُجد تلف تعذّر إصلاحه",
    statusCompleted: "انتهى",
    hintUnrepairable:
      "الترقية الموضعية لويندوز هي الخطوة التالية عادةً. رمز الخطأ موجود في الخرج أدناه.",
    hintCompleted:
      "شُغّلت الأدوات. لغة ويندوز لديك تحال دون قراءة النتيجة تلقائياً — التفاصيل موجودة في الخرج أدناه.",
    logTitle: "الخرج",
    askRepair: "هل تريد إصلاحه الآن؟",
    askRepairYes: "نعم، أصلح الآن",
    askRepairNo: "ليس الآن",
    repairAnyway: "شغّل إصلاحاً كاملاً على أي حال",
    elapsed: "مضى {time}",
    holdingAt:
      "ما زال عند {percent}% بعد {time}. تتوقف DISM عند رقم واحد لدقائق متتالية بينما يعيد ويندوز بناء المكوّنات في الخلفية — لم تتجمّد.",
    remaining: "~{minutes} د",
    underMinute: "أقل من دقيقة",
    estimating: "جارٍ التقدير…",
    statElapsed: "المضى",
    statRemaining: "المتبقي",
    statFinish: "الانتهاء المتوقع",
    waiting: "بانتظار",
  },
  cookieCleaner: {
    title: "منظّف ملفات تعريف الارتباط الانتقائي",
    description:
      "يزيل ملفات تعريف ارتباط التتبّع والإعلانات مع الإبقاء على التي تحفظ تسجيلات دخولك. تبقى المواقع المدرجة في قائمة الاحتفاظ مسجَّلة الدخول.",
    scanButton: "فحص ملفات تعريف الارتباط",
    scanning: "جارٍ الفحص…",
    cleanButton: "تنظيف",
    cleaning: "جارٍ التنظيف…",
    noneFound: "لم يُعثر على ملفات تعريف ارتباط لأي متصفح على هذا الجهاز.",
    totals: "{removable} للإزالة، و{protected} ملف تسجيل دخول مُحتفَظ بها",
    runningWarning: "أغلق {browser} لتنظيفه. الأعداد أعلاه دقيقة بالفعل.",
    backupNote: "تُنسخ قاعدة بيانات ملفات تعريف الارتباط أولاً، لذا يمكن التراجع عن التنظيف.",
    restoreButton: "التراجع عن آخر تنظيف",
    restoring: "جارٍ الاستعادة…",
    restoredToast: "{browser}: استُعيدت ملفات تعريف الارتباط من آخر نسخة احتياطية.",
    // Two counted nouns. The first drives the plural; the second sits in a
    // genitive after a preposition, which is grammatically invariant in
    // Arabic — so it needs no form of its own and stays correct whatever it is.
    cleanedToast: plurals(AR, {
      one: "أُزيل {removed} ملف تعريف ارتباط، مع الاحتفاظ بـ {kept} تسجيل دخول.",
      two: "أُزيل {removed} ملفا تعريف ارتباط، مع الاحتفاظ بـ {kept} تسجيل دخول.",
      few: "أُزيلت {removed} ملفات تعريف ارتباط، مع الاحتفاظ بـ {kept} تسجيل دخول.",
      many: "أُزيل {removed} ملف تعريف ارتباط، مع الاحتفاظ بـ {kept} تسجيل دخول.",
      other: "أُزيل {removed} ملف تعريف ارتباط، مع الاحتفاظ بـ {kept} تسجيل دخول.",
    }),
    nothingToClean: "لا شيء لإزالته: كل ملف تعريف ارتباط هنا مدرج في قائمة الاحتفاظ.",
    topDomains: "معظم ملفات تعريف الارتباط تأتي من",
    whitelistTitle: "مواقع تبقى مسجَّلة الدخول",
    whitelistNote:
      "تشمل النطاقات الفرعية أيضاً: إضافة google.com تحتفظ بحسابات accounts.google.com كذلك.",
    whitelistPlaceholder: "mithal.com",
    whitelistAdd: "إضافة",
    whitelistRemove: "إزالة",
    whitelistReset: "استعادة الافتراضي",
  },
  appCache: {
    title: "ذاكرة التخزين المؤقت للتطبيقات الخارجية",
    description:
      "تحتفظ ذاكرات الظلال ومشغّلات الألعاب وتطبيقات الدردشة ومديري الحزم بالغيغابايتات من الملفات التي يعيدون بناءها بأنفسهم. يبحث هذا عنها عبر البرامج التي لديك مثبَّتة فعلياً.",
    scanButton: "فحص الذاكرات المؤقتة",
    scanning: "جارٍ الفحص…",
    cleanButton: "تنظيف المحدد",
    cleaning: "جارٍ التنظيف…",
    noneFound: "لم يُعثر على ذاكرات مؤقتة لأي تطبيق خارجي على هذا الجهاز.",
    permanentNote:
      "تُحذف هذه نهائياً بدل نقلها إلى سلة المحذوفات، لأن نقل الغيغابايتات لا يوفّر أي مساحة حتى تُفرَّغ السلة. كل ما يُدرج هنا يعيد البرنامج الذي أنشأه بناءه تلقائياً.",
    blockedBy: "{process} قيد التشغيل، لذا ستُتخطى ملفاته.",
    selectedTotal: "{size} محدَّد",
    cleanedToast: "تم تحرير {freed}.",
    skippedNote: plurals(AR, {
      one: "كان {count} ملف قيد الاستخدام فتركناه دون مساس.",
      two: "كان {count} ملفان قيد الاستخدام فتركناهما دون مساس.",
      few: "كانت {count} ملفات قيد الاستخدام فتركناها دون مساس.",
      many: "كان {count} ملفاً قيد الاستخدام فتركناه دون مساس.",
      other: "كان {count} ملف قيد الاستخدام فتركناه دون مساس.",
    }),
    catShaders: "ذاكرات الظلال",
    catLaunchers: "مشغّلات الألعاب",
    // The English entry says "Anwendungen" — German. Translated here as the
    // Arabic for "applications" rather than carrying the mistake across.
    catApps: "التطبيقات",
    catDev: "أدوات المطوّرين",
    catWindows: "ويندوز",
    names: {
      shader_dx: "ذاكرة ظلال DirectX",
      shader_nvidia: "ذاكرة ظلال NVIDIA",
      shader_amd: "ذاكرة ظلال AMD",
      shader_intel: "ذاكرة ظلال Intel",
      steam: "ذاكرة Steam على الويب",
      epic: "ذاكرة مشغّل Epic Games",
      battlenet: "ذاكرة Battle.net",
      discord: "ذاكرة Discord",
      vscode: "ذاكرة Visual Studio Code",
      npm: "ذاكرة حِزَم npm",
      pip: "ذاكرة حِزَم pip",
      crash_dumps: "تفريغات انهيار التطبيقات",
      error_reports: "تقارير أخطاء ويندوز",
    },
  },
  scheduledTasks: {
    title: "مهام بدء التشغيل المجدولة",
    description:
      "أدوات التحديث والمساعدات الخلفية التي تعمل عند تسجيل الدخول أو الإقلاع عبر مجدول المهام، حيث لا يعرضها قائمة «بدء التشغيل» في ويندوز أبداً. مهام ويندوز نفسها غير مُدرجة هنا.",
    empty: "لا توجد مهام بدء تشغيل من أطراف ثالثة على هذا الجهاز.",
    activeCount: "مفعَّلة: {enabled} / {total}",
    triggerLogon: "عند تسجيل الدخول",
    triggerBoot: "عند الإقلاع",
    refresh: "تحديث",
    refreshing: "جارٍ إعادة القراءة…",
    note: "إيقاف مهمة لا يزيل أي تثبيت ويمكنك إعادة تشغيلها في أي وقت.",
  },
  search: {
    placeholder: "ابحث عن تعديل…",
    noResults: "لا نتائج لـ «{query}».",
    clear: "مسح",
  },
  toggle: {
    on: "مفعَّل",
    off: "معطَّل",
  },
  pricing: {
    eyebrow: "افتح كل الإمكانات",
    title: "اختر مدى دفعك لحدوده",
    subtitle:
      "كل تغيير يأخذ لقطة لما كان عليه قبله، لذا فأي شيء تجرّبه هنا التراجع عنه بنقرة واحدة. تغطي الخطة المجانية الأساسيات، وPro تفتح ما تبقى.",
    monthly: "شهري",
    annual: "سنوي",
    lifetime: "مدى الحياة",
    saveBadge: "وفّر {percent}%",
    perMonth: "/شهرياً",
    perYear: "/سنوياً",
    once: "دفعة واحدة",
    lifetimeDetail:
      "ادفع مرة واحدة واحصل عليه دائماً. يستردّ تكلفته خلال {months} شهراً مقارنة بالخطة السنوية، ولا يكلّفك شيئاً بعدها",
    annualDetail: "أي {monthly} شهرياً، تُدفع {yearly} مرة واحدة في السنة",
    annualNudge: "في الخطة السنوية سيكون {price} شهرياً",
    mostChosen: "الأكثر اختياراً",
    freeName: "مجانية",
    freeTagline: "كل ما تحتاجه لجهاز أنظف وأسرع.",
    freePriceNote: "مجانية للأبد، بلا انتهاء",
    freeCta: "أنت على الخطة المجانية",
    freeCurrent: "خطتك الحالية",
    proName: "Pro",
    proTagline:
      "كل تعديل، بما في ذلك التعديلات التي تتطلب صلاحيات المشرف وتلك التي تطبّقها يدوياً في السجل.",
    proCta: "اشترك في Pro",
    proCurrent: "خطتك",
    manageBilling: "إدارة الاشتراك",
    lifetimeOwned: "Pro لك دائماً",
    switchToLifetime: "التبديل إلى مدى الحياة",
    proActiveNoBilling: "Pro مُفعَّلة على هذا الحساب",
    everythingInFree: "كل ما في الخطة المجانية، بالإضافة إلى:",
    included: "متضمَّن",
    reassurance:
      "ألغِ في أي وقت. يبقى كل تغيير على بُعد نقرة واحدة من التراجع عنه، حتى بعد الإلغاء.",
    freeFeatures: [
      plurals(AR, {
        one: "تعديل واحد لويندوز للمراجعة والتطبيق",
        two: "تعديلان لويندوز للمراجعة والتطبيق",
        few: "{count} تعديلات لويندوز للمراجعة والتطبيق",
        many: "{count} تعديلاً لويندوز للمراجعة والتطبيق",
        other: "{count} تعديل لويندوز للمراجعة والتطبيق",
      }),
      "مراقب نظام مباشر (المعالج والذاكرة والقرص)",
      "مدير برامج بدء التشغيل",
      "فحص تسريبات كلمات المرور",
      "فحص الجهاز وإصلاحه بنقرة واحدة",
      "تنظيف الملفات المؤقتة",
    ],
    proFeatures: [
      "جلسات الألعاب: يعمل وضع السرعة تلقائياً عند تشغيل أي لعبة",
      "إعداد مُعدَّل للألعاب وأقصى أولوية للألعاب",
      "خصوصية متقدمة: بيانات التشخيص وسجل النشاط",
      "يجد الملفات المكرّرة ويزيلها",
      "يُفرغ ذاكرة التخزين المؤقت لتحديثات ويندوز",
      "يعطّل الفهرسة التي تُبقي قرصك مشغولاً",
      "كل تعديل وكل ميزة مستقبلية، مُضمَّنة",
    ],
    lifetimeName: "مدى الحياة",
    lifetimeTagline:
      "ادفع مرة واحدة. كل ميزات Pro دائماً، وكل ما يأتي بعد ذلك قبل أن يصل إلى غيرك.",
    lifetimeCta: "احصل على مدى الحياة",
    oneTimeBadge: "دفعة واحدة",
    everythingInPro: "كل ما في Pro، بالإضافة إلى:",
    lifetimeExclusive: "مدى الحياة فقط",
    lifetimeFeatures: [
      "وصول مبكر لمعاينات محدَّدة، عند توفرها",
      "كل إصدار مستقبلي مُضمَّن — بلا تجديد، أبداً",
      "دعم ذو أولوية، يردّ عليه المطوّر",
    ],
    notAvailableYet: "تُمنح Pro يدوياً في الإصدار 1.0.0 — لا يوجد زر شراء بعد.",
  },
  driverBooster: {
    title: "مُعزِّز التعريفات",
    subtitle: "اختر التعريفات المتأخرة وافتح كل صفحات تنزيلها دفعة واحدة.",
    scan: "فحص التعريفات",
    scanning: "جارٍ الفحص…",
    selectAll: "تحديد الكل",
    selectNone: "إلغاء التحديد",
    selectedCount: "{selected} من {total} محدَّد",
    pagesForSelection: "{pages} صفحة لفتحها",
    openSelected: plurals(AR, {
      one: "افتح صفحة التنزيل ({count})",
      two: "افتح صفحتَي التنزيل ({count})",
      few: "افتح {count} صفحات تنزيل",
      many: "افتح {count} صفحة تنزيل",
      other: "افتح {count} صفحة تنزيل",
    }),
    opened: plurals(AR, {
      one: "فُتحت {count} صفحة",
      two: "فُتحت {count} صفحتان",
      few: "فُتحت {count} صفحات",
      many: "فُتحت {count} صفحة",
      other: "فُتحت {count} صفحة",
    }),
    openedCapped:
      "فُتحت {opened} من {total} صفحة: يبقى الباقي محدَّداً، شغّل الأمر مرة أخرى لفتحها.",
    allCurrent: "لا يُظهر أي تعريف عمره.",
    nothingActionable: "لا يوجد تعريف متأخر له صفحة من الشركة ل فتحها.",
    note: "لا يُنزّل Daltoon X حِزَم التعريفات من تلقاء نفسه: لا توجد واجهة برمجية من أي شركة تقول أي إصدار هو الصحيح لجهازك تحديداً، وتثبيت تعريف عرض خاطئ هو أحد الأخطاء القليلة التي قد تُبقيك بلا شاشة. هذا التطبيق يؤتمت الجزء الممل — العثور على الصفحات — لا عملية الاختيار. أما التعريفات التي يعرفها Windows Update فعلاً فاستخدم الزر أعلاه.",
  },
  secureDefrag: {
    title: "إعادة تجزئة آمنة",
    willDefrag: "هذا القرص ميكانيكي: ستُجرى عملية إعادة تجزئة حقيقية.",
    willRetrim:
      "لم يُؤكَّد أن هذا القرص ميكانيكي: يُحلَّل المجلد بالكامل، ثم تُجرى إعادة ضبط للـ trim بدلاً من إعادة التجزئة. تستغرق إعادة الضبط ثوانٍ فقط وتتعلّق بالمساحة الحرة فقط — وهذا هو جوهرها: تُخبر وحدة التحكم بالكتل التي لم تعد مستخدمة كي يعيد استخدامها دون إبطاء. إعادة تجزئة قرص SSD لا تجعله أسرع، بل تستهلكه فقط.",
    start: "ابدأ",
    running: "جارٍ التنفيذ…",
    working: "جارٍ العمل…",
    phaseAnalyze: "جارٍ التحليل",
    phaseOptimize: "جارٍ التحسين",
    analysisTitle: "تقرير التحليل",
    doneDefrag: "اكتملت إعادة التجزئة.",
    doneRetrim: "اكتملت إعادة الضبط.",
    note: "تُؤخذ نقطة استعادة أولاً. النسبة قادمة من ويندوز نفسه، لا من مؤقّت.",
  },
  zeroTrace: {
    title: "منظّف صفر الأثر",
    subtitle: "يمسح ما تتركه البرامج المغلقة في الذاكرة، ويتلف الملفات دون إمكانية استرجاع.",
    purgeTitle: "تنقية الذاكرة",
    purgeBody:
      "يُبقي ويندوز صفحات البرامج المغلقة في الذاكرة العشوائية كذاكرة تخزين مؤقت. يُحرِّر هذا منها، فتختفي البقايا التي تركها عملية منتهية فعلاً من الذاكرة الفعلية.",
    purgeButton: "نقِّ الذاكرة",
    purging: "جارٍ التنقية…",
    purgeResult: "تم تحرير {freed} ميغابايت — {after} ميغابايت متاحة الآن",
    purgeLimit:
      "لا يمسّ ملف الصفحات (pagefile) ولا ملف السبات (hibernation): كلاهما على القرص، ولا يوفّر ويندوز أي واجهة برمجية وقت التشغيل لتنظيفهما.",
    shredTitle: "مُمتِّق ملفات آمن",
    shredBody:
      "يكتب فوق محتوى الملف في ثلاث تمريرات قبل حذفه، فيصبح خارج مدى أدوات استرجاع الملفات المعتادة.",
    shredButton: "اختر الملفات…",
    shredding: "جارٍ التمزيق…",
    shredDone: plurals(AR, {
      one: "تم تدمير {count} ملف ({size})",
      two: "تم تدمير {count} ملفين ({size})",
      few: "تم تدمير {count} ملفات ({size})",
      many: "تم تدمير {count} ملفاً ({size})",
      other: "تم تدمير {count} ملف ({size})",
    }),
    shredSummary: "{shredded} تم تدميرها، و{skipped} تم تخطّيها",
    shredWarning: "نهائي: بلا سلة محذوفات، وبلا إمكانية استرجاع.",
    ssdCaveat:
      "على قرص SSD، تكتب موازنة التآكل خلايا مختلفة عن الأصلية في أغلب الأحيان. فالخلايا القديمة تُحرَّر ولا تُعاد كتابتها، ولا يضمن المزيد سوى المسح الآمن الخاص بالقرص نفسه.",
  },
  hud: {
    title: "طبقة الألعاب",
    subtitle:
      "لوحة شفافة فوق لعبتك: حمل المعالج وكرت الشاشة، والحرارات، والذاكرة الرسومية، والعملية النشطة مع أولوية جدولتها، ومؤشّر للاختناق.",
    fpsAbout:
      "يُحتسب معدل الإطارات من أحداث العرض التي يبثّها ويندوز لكل إطار — وهو المصدر نفسه الذي يقرأه PresentMon، دون أي ربط داخل اللعبة. يحتاج إلى صلاحيات المشرف لأن فتح جلسة تتبّع عملية محميّة.",
    fpsLowExplained:
      "بجانب المتوسط يوجد «الأدنى 1%»: معدل أسوأ واحد بالمئة من الإطارات. إنه الرقم الذي يتحرّك عندما تتقطّع اللعبة بينما يبقى المتوسط مرتفعاً ولا يقول شيئاً. وكلما اقترب من المتوسط كانت اللعبة أنعم.",
    fpsStart: "قياس معدل الإطارات",
    fpsStop: "إيقاف القياس",
    fpsNeedsAdmin: "قياس معدل الإطارات يحتاج إلى تشغيل Daltoon X بصلاحيات المشرف.",
    fpsRunning: "جارٍ القياس: سيظهر معدل الإطارات في الطبقة فور أن تبدأ اللعبة بالرسم.",
    show: "إظهار",
    hide: "إخفاء",
    lock: "تثبيت",
    unlock: "فك التثبيت",
    dragHint: "اسحب الطبقة إلى المكان الذي تريده، ثم ثبّتها قبل بدء اللعبة.",
    lockedHint: "مثبَّتة: تمرّ النقرات عبرها إلى اللعبة. فكّ التثبيت لتحريكها مرة أخرى.",
    sizeCompact: "مدمج",
    sizeNormal: "عادي",
  },
  hudLabels: {
    fps: "FPS",
    // The card calls this figure «الأدنى 1%»; the panel needs it shorter, so the
    // label is the same word without the percentage the panel shows beside it.
    drop: "أدنى",
    cpu: "CPU",
    gpu: "GPU",
    temp: "حرارة",
    ram: "RAM",
    vram: "VRAM",
  },
  themeLabels: {
    violet: "بنفسجي",
    teal_depths: "أعماق فيروزية",
    amber_dusk: "غسق كهرماني",
    crimson_steel: "فولاذ قرمزي",
    ocean_blue: "أزرق محيطي",
    forest_emerald: "زمرد الغابة",
    royal_gold: "ذهبي ملكي",
    slate_mono: "رمادي أحادي اللون",
    indigo_night: "ليل نيلي",
    coral_sunset: "غروب مرجاني",
    rose_quartz: "كوارتز وردي",
    cyber_lime: "ليموني سايبربانك",
    copper_forge: "منجَخ النحاس",
    magenta_pulse: "نبض ماجنتا",
  },
  updater: {
    title: "يتوفر تحديث: الإصدار {version}",
    body: "يُنزَّل ويُثبَّت في خطوة واحدة؛ ويعيد التطبيق تشغيل نفسه عند الانتهاء.",
    install: "ثبِّت وأعد التشغيل",
    later: "لاحقاً",
    downloading: "جارٍ التنزيل… {percent}%",
    installing: "جارٍ التثبيت…",
    error: "فشل التحديث: {message}",
    checkFailed: "فشل فحص التحديث: {message}",
  },
  badges: {
    admin: "مشرف",
    pro: "PRO",
    soon: "قريباً",
  },
  emptyCategory: "لا توجد تعديلات متاحة في هذه الفئة بعد — المزيد قريباً.",
  gameSessions: {
    title: "جلسات الألعاب",
    subtitle: "يكتشف ألعابك تلقائياً ويطبّق إعداد «الألعاب الفائق» أو يتراجع عنه من تلقاء نفسه.",
    active: "جلسة نشِطة: {name}",
    activeFreed: "التسريع مُفعَّل لـ {name} — أُعيد {freed} من الذاكرة.",
    gamesCount: plurals(AR, {
      one: "{count} لعبة مسجَّلة",
      two: "{count} لعبتان مسجَّلتان",
      few: "{count} ألعاب مسجَّلة",
      many: "{count} لعبة مسجَّلة",
      other: "{count} لعبة مسجَّلة",
    }),
    addGame: "+ إضافة لعبة (‎.exe)",
  },
  turboBoost: {
    title: "تعزيز السرعة",
    subtitle:
      "يضبط سلوك تسريع المعالج والحد الأدنى لحالة المعالج. قد يزداد استهلاك الطاقة والحرارة؛ والنتائج تعتمد على نوع العمل.",
    startLabel: "تشغيل",
    stopLabel: "إيقاف",
    activating: "جارٍ تفعيل التعزيز…",
    deactivating: "جارٍ الاستعادة…",
    active: "التعزيز مُفعَّل",
    inactive: "التعزيز غير مُفعَّل",
    loadLabel: "حمل المعالج",
    stageReading: "جارٍ قراءة مخطط الطاقة",
    stageRaising: "جارٍ رفع حدّ التسريع",
    stageApplying: "جارٍ التطبيق على النظام",
    modeAggressive: "الوضع المتسّع",
    modeDefault: "الوضع الافتراضي",
    stageMeasuringBefore: "جارٍ القياس قبل",
    stageMeasuringAfter: "جارٍ القياس مرة أخرى",
    gainMeasured: "أسرع بمقدار {factor}×",
    gainSlight: "أسرع بمقدار {factor}× — تحسّن متواضع",
    gainAtCeiling: "وصل بالفعل إلى سرعته القصوى: لم يتبقَّ لهذا المعالج ما يمكن فتحه",
    ceilingLocked: "حدّ التسريع مُثبَّت",
    ceilingUnlocked: "حدّ التسريع غير مُثبَّت",
  },
  profiles: {
    title: "ملفاتك التعريفية",
    subtitle: "احفظ تعديلاتك النشطة كملف تعريفي. أعد استخدام إعداد أو صدّره إلى جهاز آخر.",
    saveHeading: "حفظ التعديلات النشطة",
    namePlaceholder: "الاسم (مثال: الألعاب)",
    saveButton: "حفظ",
    savedHeading: "الملفات المحفوظة",
    empty: "لا توجد ملفات تعريفية محفوظة بعد.",
    tweakCount: plurals(AR, {
      one: "{count} تعديل",
      two: "{count} تعديلان",
      few: "{count} تعديلات",
      many: "{count} تعديلاً",
      other: "{count} تعديل",
    }),
    apply: "تطبيق",
    applying: "جارٍ التطبيق…",
    exportButton: "تصدير",
    importButton: "استيراد من ملف",
    deleteButton: "حذف",
    savedToast: "تم حفظ الإعداد «{name}»",
    appliedToast: plurals(AR, {
      one: "طُبِّق {count} تعديل",
      two: "طُبِّق {count} تعديلان",
      few: "طُبِّقت {count} تعديلات",
      many: "طُبِّق {count} تعديلاً",
      other: "طُبِّق {count} تعديل",
    }),
    exportedToast: "تم تصدير الملف",
    importedToast: plurals(AR, {
      one: "تم الاستيراد: {count} تعديل جاهز للمراجعة",
      two: "تم الاستيراد: {count} تعديلان جاهزان للمراجعة",
      few: "تم الاستيراد: {count} تعديلات جاهزة للمراجعة",
      many: "تم الاستيراد: {count} تعديلاً جاهزاً للمراجعة",
      other: "تم الاستيراد: {count} تعديل جاهز للمراجعة",
    }),
    droppedWarning: plurals(AR, {
      one: "أُسقط {count} إدخال لا يعرفه هذا الإصدار",
      two: "أُسقط {count} إدخالان لا يعرفهما هذا الإصدار",
      few: "أُسقطت {count} إدخالات لا يعرفها هذا الإصدار",
      many: "أُسقط {count} إدخالاً لا يعرفها هذا الإصدار",
      other: "أُسقط {count} إدخالاً لا يعرفه هذا الإصدار",
    }),
    nameRequired: "امنح الإعداد اسماً",
    reviewNotice: "لا يُطبَّق الإعداد المستورد من تلقاء نفسه — بل تراجعه أولاً.",
    signInRequired: "سجّل الدخول أو أنشئ حساباً لحفظ الإعدادات.",
  },
  scan: {
    lastScan: "آخر فحص: {time}",
    neverScanned: "لم يكتمل أي فحص بعد",
    extraChecks: "فحوص إضافية",
    checksHint: "قراءات النظام فقط: لا يُغيَّر شيء تلقائياً. وسّع أي فئة لفحص الدليل.",
    unavailable: "الفحص غير متاح",
    startupSummary: "{enabled} مفعَّلة · {orphaned} أهداف مفقودة",
    tasksSummary: "{enabled} مهام بدء تشغيل مفعَّلة",
    partialScan: "نتائج جزئية: بعض الفحوص غير متاحة.",
    scanFailed: "فشل الفحص. يُرجى المحاولة مرة أخرى.",
    title: "فحص سريع",
    subtitle: "يفحص حالة جهازك ويجد تحسينات لم تُفعَّل بعد، بنقرة واحدة.",
    startLabel: "فحص",
    stepPerformance: "الأداء",
    stepPrivacy: "الخصوصية",
    stepGaming: "الألعاب",
    stepJunk: "الملفات المؤقتة",
    allGood: "كل شيء تمام — لم يُعثر على أي مشاكل.",
    issuesFound: plurals(AR, {
      one: "يتوفر {count} تحسين",
      two: "يتوفر {count} تحسينان",
      few: "{count} تحسينات متاحة",
      many: "{count} تحسيناً متاحاً",
      other: "{count} تحسين متاح",
    }),
    selectAll: "تحديد الكل",
    deselectAll: "إلغاء تحديد الكل",
    fixAll: "إصلاح الكل",
    fixing: "جارٍ الإصلاح {done}/{total}…",
    fixedToast: plurals(AR, {
      one: "أُصلح {count} مشكل.",
      two: "أُصلح {count} مشكلان.",
      few: "أُصلحت {count} مشاكل.",
      many: "أُصلح {count} مشكلاً.",
      other: "أُصلح {count} مشكل.",
    }),
    proIssuesTitle: "متاح أيضاً مع Pro",
    unlockPro: "افتح Pro",
    scanAgain: "أعد الفحص",
    verdictRecommended: "موصى به على هذا الجهاز",
    verdictNotRecommended: "غير موصى به على هذا الجهاز",
    verdictUnsupported: "غير مدعوم",
    reasons: {
      laptop_battery: "هذا الجهاز حاسوب محمول: يكلّفه من البطارية أكثر مما يعيده",
      hdd_index_cost: "قرص النظام ميكانيكي، لذا تُحسّ الفهرسة الخلفية فعلاً",
      fast_disk_no_gain: "قرص النظام من نوع NVMe، سريع بما يكفي لجعل التوفير مهملاً",
      needs_win10_2004: "يتطلب ويندوز 10 الإصدار 2004 أو أحدث",
      weak_gpu: "رسوميات مدمجة: شفافية واجهة تُكلّف أداءً يمكن للاستخدام أن يستفيد منه",
    },
    thisPc: "هذا الجهاز",
    dashDrivesTitle: "التخزين",
    dashFreeOf: "{free} متاحة من {total}",
    dashAlmostFull: "شبه ممتلئ",
    dashStartupTitle: "تطبيقات بدء التشغيل",
    dashStartupCount: "{on} من {total} مفعَّلة",
    dashManage: "إدارة",
    dashUptimeTitle: "مدة التشغيل",
    dashUptimeDh: "{days} ي {hours} س",
    dashUptimeHm: "{hours} س {minutes} د",
    dashUptimeLongHint:
      "لم يُعِد هذا الجهاز تشغيله منذ مدة. إعادة التشغيل تطبّق التحديثات المعلّقة وتحرّر الذاكرة المحتجَزة.",
    dashHistoryTitle: "إجراءات حديثة",
    dashHistoryEmpty: "لا شيء بعد. ستظهر هنا الإجراءات التي تتخذها.",
    dashActTweakApplied: "تم تطبيق تعديل",
    dashActTweakReverted: "تم التراجع عن تعديل",
    dashActCleanup: "تنظيف",
    dashActFilesDeleted: "حُذفت ملفات",
    dashActStartupChange: "تم تغيير بدء التشغيل",
    dashActDiskOptimize: "تم تحسين القرص",
    dashActRestorePoint: "نقطة استعادة",
    profileUnknown: "غير مُكتشَف",
    diskHdd: "قرص صلب ميكانيكي",
    diskSsd: "قرص SSD",
    diskNvme: "قرص NVMe",
    formDesktop: "حاسوب مكتبي",
    formLaptop: "حاسوب محمول",
    groupRecommended: "موصى به لهذا الجهاز",
    groupOptional: "اختياري",
    groupNotRecommended: "غير موصى به هنا",
    tailoredNote: "كل بند يُحكَم مقابل العتاد أعلاه، لا مقابل قائمة ثابتة.",
    fixRecommended: plurals(AR, {
      one: "طبِّع {count} تعديل موصى به",
      two: "طبِّع {count} تعديلين موصى بهما",
      few: "طبِّع {count} تعديلات موصى بها",
      many: "طبِّع {count} تعديلاً موصى به",
      other: "طبِّع {count} تعديل موصى به",
    }),
    fixEverything: plurals(AR, {
      one: "طبِّع {count} تعديل محدَّد",
      two: "طبِّع {count} تعديلين محدَّدين",
      few: "طبِّع {count} تعديلات محددة",
      many: "طبِّع {count} تعديلاً محدداً",
      other: "طبِّع {count} تعديل محدد",
    }),
    nothingSelected: "لم يُحدَّد شيء",
    foundHeadline: plurals(AR, {
      one: "{count} أمر يستحق الإصلاح على هذا الجهاز",
      two: "{count} أمران يستحقان الإصلاح على هذا الجهاز",
      few: "{count} أمور تستحق الإصلاح على هذا الجهاز",
      many: "{count} أمراً يستحق الإصلاح على هذا الجهاز",
      other: "{count} أمر يستحق الإصلاح على هذا الجهاز",
    }),
    foundNone: "لا شيء لإصلاحه",
    doneTitle: "تم!",
    doneBody: plurals(AR, {
      one: "طُبِّق {count} تحسين. جهازك جاهز.",
      two: "طُبِّق {count} تحسينان. جهازك جاهز.",
      few: "طُبِّقت {count} تحسينات. جهازك جاهز.",
      many: "طُبِّق {count} تحسيناً. جهازك جاهز.",
      other: "طُبِّق {count} تحسين. جهازك جاهز.",
    }),
    fixHeading: "جاهز للتطبيق",
  },
  ram: {
    title: "تحرير الذاكرة العشوائية",
    subtitle: "يطلب من ويندوز تحرير ذاكرة تحجزها البرامج دون استخدامها. شغّله متى شئت.",
    button: "حرّر الآن",
    cleaning: "جارٍ التنظيف…",
    freed: "تم تحرير {amount}",
    freedNothing: "الذاكرة مُحسَّنة بالفعل",
    inUse: "{used} من {total} قيد الاستخدام",
    autoLabel: "تنظيف تلقائي",
    autoOff: "معطَّل",
    autoEvery: "كل {interval}",
    autoHint:
      "مع التنظيف التلقائي مُفعَّلاً، يحرّر Daltoon X الذاكرة العشوائية من تلقاء نفسه على فترات منتظمة ما دام التطبيق مفتوحاً.",
    autoNext: "التنظيف التالي عند {time}",
    autoDue: "حان وقت التنظيف…",
    autoLast: "آخر مرة عند {time}: حُرِّر {amount}",
    autoNoneYet: "لم يُجرَ أي تنظيف تلقائي بعد.",
    autoFailed: "فشلت آخر محاولة: {detail}",
  },
  restore: {
    button: "استعادة التعديلات النشطة",
    title: "استعادة التعديلات النشطة؟",
    body: plurals(AR, {
      one: "استعد {count} تعديلاً من قيمه المحفوظة. ولكل أداة قابلة للضبط أدوات الاستعادة الخاصة بها.",
      two: "استعد {count} تعديلين من قيمهما المحفوظة. ولكل أداة قابلة للضبط أدوات الاستعادة الخاصة بها.",
      few: "استعد {count} تعديلات من قيمها المحفوظة. ولكل أداة قابلة للضبط أدوات الاستعادة الخاصة بها.",
      many: "استعد {count} تعديلاً من قيمها المحفوظة. ولكل أداة قابلة للضبط أدوات الاستعادة الخاصة بها.",
      other:
        "استعد {count} تعديلاً من قيمها المحفوظة. ولكل أداة قابلة للضبط أدوات الاستعادة الخاصة بها.",
    }),
    confirm: "استعادة التعديلات",
    cancel: "إلغاء",
    running: "جارٍ الاستعادة…",
    doneToast: plurals(AR, {
      one: "استُعيد {count} تحسين.",
      two: "استُعيد {count} تحسينان.",
      few: "استُعيدت {count} تحسينات.",
      many: "استُعيد {count} تحسيناً.",
      other: "استُعيد {count} تحسين.",
    }),
    nothingToast: "لا يوجد ما يُستعاد.",
  },
  passwordCheck: {
    title: "فحص تسريبات كلمات المرور",
    description:
      "يفحص ما إذا ظهرت كلمة مرور في تسريب بيانات معروف، دون إرسالها كاملة أبداً: يُرسل سوى جزء من تجزئتها (k-anonymity، وهو المعيار نفسه الذي تستخدمه Have I Been Pwned).",
    placeholder: "الصق كلمة مرور لفحصها",
    button: "فحص",
    checking: "جارٍ الفحص…",
    safe: "لم تُعثر عليها في أي تسريب معروف. علامة جيدة.",
    breached: plurals(AR, {
      one: "وُجدت في {count} تسريب معروف. غيّرها الآن في كل مكان تستخدمها فيه.",
      two: "وُجدت في {count} تسريبين معروفين. غيّرها الآن في كل مكان تستخدمها فيه.",
      few: "وُجدت في {count} تسريبات معروفة. غيّرها الآن في كل مكان تستخدمها فيه.",
      many: "وُجدت في {count} تسريباً معروفاً. غيّرها الآن في كل مكان تستخدمها فيه.",
      other: "وُجدت في {count} تسريب معروف. غيّرها الآن في كل مكان تستخدمها فيه.",
    }),
    error: "تعذّر الفحص الآن: تحقّق من اتصالك وأعد المحاولة.",
  },
  paywall: {
    title: "ميزة Pro",
    body: "«{feature}» جزء من Daltoon X Pro، إلى جانب جلسات الألعاب وإعدادات الألعاب وكل ميزة قادمة.",
    unlock: "اطّلع على الخطط والأسعار",
    notNow: "ليس الآن",
    notConnectedToast: "لم تُربط الدفعات الخاصة بـ Pro بعد في نسخة التطوير هذه.",
  },
  cleanupConfirm: {
    previewLoading: "جارٍ تحديد ما سيُنقل إلى سلة المحذوفات…",
    previewEmpty: "لا شيء لتنظيفه — المجلد فارغ بالفعل.",
    previewNotAccessible:
      "لا يمكن قراءة المحتوى دون صلاحيات المشرف؛ ستسرد العملية المصرَّح بها الملفات وتزيلها.",
    previewTruncated: "تُعرض أكبر 500 عنصر؛ الإجماليات تشمل كل شيء.",
    selectedSummary: plurals(AR, {
      one: "{count} عنصر محدَّد · {size}",
      two: "{count} عنصران محدَّدان · {size}",
      few: "{count} عناصر محددة · {size}",
      many: "{count} عنصراً محدَّداً · {size}",
      other: "{count} عنصر محدَّد · {size}",
    }),
    confirmSelected: "تنظيف المحدد",
    title: "تأكيد التنظيف؟",
    body: "سينقل «{name}» الملفات المطابقة إلى سلة محذوفات ويندوز. يمكنك استعادتها منها حتى تُفرَّغ.",
    confirm: "نقل إلى سلة المحذوفات",
    cancel: "إلغاء",
  },
  cleanupButton: "تنظيف",
  cleanupRunning: "…",

  // Two counted nouns; the freed size sits in a genitive after a preposition, so
  // it needs no form of its own.
  cleanupResultToast: plurals(AR, {
    one: "نُقل {deleted} عنصر إلى سلة المحذوفات، وتم تحرير {freed}",
    two: "نُقل {deleted} عنصران إلى سلة المحذوفات، وتم تحرير {freed}",
    few: "نُقلت {deleted} عناصر إلى سلة المحذوفات، وتم تحرير {freed}",
    many: "نُقل {deleted} عنصراً إلى سلة المحذوفات، وتم تحرير {freed}",
    other: "نُقل {deleted} عنصر إلى سلة المحذوفات، وتم تحرير {freed}",
  }),
  cleanupResultToastSkipped: " ({skipped} قيد الاستخدام، تم تخطّيها).",
  diskOptimize: {
    title: "تحسين القرص",
    description:
      "يشغّل مُحسِّن ويندوز المدمج نفسه: إعادة تجزئة على القرص الميكانيكي، أو TRIM على قرص SSD (وليس إعادة تجزئة كاملة أبداً، فهي تستهلكه بلا فائدة).",
    button: "حسّن الآن",
    running: "جارٍ التحسين… قد يستغرق هذا بضع دقائق",
    resultToast: "تم تحسين القرص ({media}) بنجاح.",
  },
  dnsFlush: {
    title: "تفريغ ذاكرة DNS المؤقتة",
    description:
      "يمسح نتائج بحث DNS المخزّنة مؤقتاً. مفيد إذا غيّر موقع خوادمه ويواصل متصفحك عرض النسخة القديمة.",
    button: "فرّغ الآن",
    running: "جارٍ التفريغ…",
    resultToast: "تم تفريغ ذاكرة DNS المؤقتة.",
  },
  browserCleanup: {
    title: "تنظيف المتصفح",
    description:
      "يمسح ذاكرة التخزين المؤقت وملفات تعريف الارتباط لـ Chrome وEdge وFirefox. ويعيد المتصفح بناءها من تلقاء نفسه عند التشغيل التالي، فلا يُفقد شيء نهائياً.",
    noneFound: "لم يُعثر على متصفح مدعوم على هذا الجهاز.",
    cache: "ذاكرة التخزين المؤقت",
    cookies: "ملفات تعريف الارتباط",
    clearButton: "مسح",
    clearing: "جارٍ المسح…",
    runningWarning: "أغلق {browser} لمسحه.",
    clearedToast: "{browser}: حُرِّر {freed}.",
  },
  largeFiles: {
    title: "العثور على الملفات الكبيرة",
    description:
      "يفحص مجلداً البحث عن أكبر ملفاته (فوق 100 ميغابايت)، لتحرّر مساحة بسرعة عبر إزالة ما لم تعد تحتاجه.",
    chooseFolder: "اختر مجلداً",
    scanning: "جارٍ الفحص…",
    noneFound: "لم يُعثر على ملفات أكبر من {size}.",
    foundCount: plurals(AR, {
      one: "وُجد {count} ملف",
      two: "وُجد {count} ملفان",
      few: "وُجدت {count} ملفات",
      many: "وُجد {count} ملفاً",
      other: "وُجد {count} ملف",
    }),
    moveSelected: plurals(AR, {
      one: "انقل {count} ملف محدَّد إلى سلة المحذوفات",
      two: "انقل {count} ملفين محدَّدين إلى سلة المحذوفات",
      few: "انقل {count} ملفات محددة إلى سلة المحذوفات",
      many: "انقل {count} ملفاً محدَّداً إلى سلة المحذوفات",
      other: "انقل {count} ملف محدَّد إلى سلة المحذوفات",
    }),
    deleting: "جارٍ النقل إلى سلة المحذوفات…",
    deletedToast: plurals(AR, {
      one: "نُقل {count} ملف، وتم تحرير {freed}.",
      two: "نُقل {count} ملفان، وتم تحرير {freed}.",
      few: "نُقلت {count} ملفات، وتم تحرير {freed}.",
      many: "نُقل {count} ملفاً، وتم تحرير {freed}.",
      other: "نُقل {count} ملف، وتم تحرير {freed}.",
    }),
  },
  diskHealth: {
    title: "صحة القرص",
    freeSpace: "{size} متاحة",
    selectDrive: "القرص",
    healthy: "سليم",
    warning: "تحذير",
    unhealthy: "غير سليم",
    unknown: "غير معروف",
    loading: "جارٍ الفحص…",
  },
  duplicateFinder: {
    title: "العثور على الملفات المكرّرة",
    description: "اختر مجلداً: اعثر على الملفات المتطابقة واختر أيها يُنقل إلى سلة المحذوفات.",
    chooseFolder: "اختر مجلداً",
    scanning: "جارٍ الفحص…",
    noneFound: "لم يُعثر على ملفات مكرّرة في هذا المجلد.",
    copies: plurals(AR, {
      one: "{count} نسخة · {size} لكل نسخة",
      two: "{count} نسختان · {size} لكل نسخة",
      few: "{count} نسخ · {size} لكل نسخة",
      many: "{count} نسخة · {size} لكل نسخة",
      other: "{count} نسخة · {size} لكل نسخة",
    }),
    moveSelected: plurals(AR, {
      one: "انقل إلى سلة المحذوفات ({count} عنصر محدَّد)",
      two: "انقل إلى سلة المحذوفات ({count} عنصران محدَّدان)",
      few: "انقل إلى سلة المحذوفات ({count} عناصر محددة)",
      many: "انقل إلى سلة المحذوفات ({count} عنصراً محدَّداً)",
      other: "انقل إلى سلة المحذوفات ({count} عنصر محدَّد)",
    }),
    deleting: "…",
    deletedToast: plurals(AR, {
      one: "نُقل {count} ملف إلى سلة المحذوفات (حُرِّر {freed}).",
      two: "نُقل {count} ملفان إلى سلة المحذوفات (حُرِّر {freed}).",
      few: "نُقلت {count} ملفات إلى سلة المحذوفات (حُرِّر {freed}).",
      many: "نُقل {count} ملفاً إلى سلة المحذوفات (حُرِّر {freed}).",
      other: "نُقل {count} ملف إلى سلة المحذوفات (حُرِّر {freed}).",
    }),
  },
  ipMask: {
    title: "إخفاء عنوان IP (VPN)",
    description:
      "يُخفي عنوان IP بتوجيه حركة البيانات عبر خادم VPN. يتطلب خدمة VPN خارجية: غير مدمج في هذا الإصدار بعد.",
    button: "اعرف المزيد",
    explainerToast:
      "إخفاء عنوان IP الحقيقي يحتاج خادم VPN مخصَّصاً (خادم وبروتوكول). لم يُوصَل بعد — هذه مجرد معاينة للميزة.",
  },
  toasts: {
    applied: "طُبِّق «{name}».",
    rolledBack: "أُعيد «{name}» إلى قيمته الأصلية.",
    licenseNeedsRefresh:
      "تعذّر التحقق من اشتراك Pro بعد انقطاع طويل عن الإنترنت. أعد الاتصال ثم أعد المحاولة.",
    accountRefreshFailed:
      "تعذّر التحقق من حالة حسابك. قد يكون ما يُعرض هنا قديماً — تحقّق من اتصالك أو أعد المحاولة لاحقاً.",
  },
  titlebar: {
    applied: "{applied}/{total} نشِط",
    cpu: "المعالج",
    ram: "الذاكرة",
    minimize: "تصغير",
    maximize: "تكبير",
    restore: "استعادة",
    close: "إغلاق",
  },
  x3d: {
    title: "محاذي ذاكرة V-Cache على مستوى الشريحة",
    subtitle:
      "على المعالجات المدعومة التي تختلف ذاكرتها L3 بين الشرائح، تُقيَّد العملية الجاري تشغيلها على الشريحة الأكبر ذاكرة. هذا يتجاوز الجدولة التلقائية لتلك العملية وقد يفيد حمل العمل أو يضرّه.",
    cpuLabel: "المعالج",
    readyHeadline: "وُجدت شريحة V-Cache: {cores} خيطاً",
    readyBody: "ثبّت اللعبة على هذه الشريحة يبقى كل خيط فيها حيث توجد الذاكرة.",
    singleDie:
      "هذا المعالج له شريحة واحدة: كل نواة ترى الذاكرة نفسها أصلاً، فلا شيء يمكن محاذاته. وتظهر الميزة تلقائياً على معالج من شريحتين بذاكرة غير متناظرة.",
    uniformCache:
      "هذا المعالج له عدة شرائح، جميعها بالكم نفسه من الذاكرة. فتغيير اللعبة بينها لن يغيّر شيئاً، ولهذا تبقى الميزة معطَّلة.",
    unavailable: "لم يُرجع ويندوز خريطة ذاكرة لهذا المعالج.",
    dieLabel: "الشريحة {index}",
    dieCache: "{mb} ميغابايت L3",
    dieThreads: plurals(AR, {
      one: "{count} خيط",
      two: "{count} خيطان",
      few: "{count} خيوط",
      many: "{count} خيطاً",
      other: "{count} خيط",
    }),
    vcacheBadge: "V-Cache",
    processesTitle: "العمليات الجاري تشغيلها",
    processesHint: "الأكثر استهلاكاً أولاً. اختر اللعبة وثبّتها على شريحة الذاكرة.",
    refresh: "تحديث",
    refreshing: "جارٍ القراءة…",
    align: "حاذِ",
    reset: "إعادة ضبط",
    alignedBadge: "محاذاة",
    noProcesses: "لا توجد عملية تستحق الإدراج.",
    persistenceNote:
      "التثبيت يخص العملية الجاري تشغيلها: يزول عند إغلاق اللعبة ويجب ضبطه مرة أخرى عند التشغيل التالي. ولا يُغيَّر أي إعداد في النظام.",
    alignedToast: "تم تثبيت {name} على شريحة V-Cache.",
    resetToast: "أُعيد {name} إلى كل النوى.",
  },
  menu: {
    account: "الحساب",
    plan: "الخطة",
    planFree: "مجانية",
    planPro: "Pro",
    viewPlan: "اطّلع على خطتك",
    upgradeButton: "الترقية إلى Pro",
    language: "اللغة",
    theme: "المظاهر",
    about: "حول",
    errorReports: "تقارير أخطاء مجهولة الهوية",
    errorReportsBody:
      "عند فشل أي شيء، أرسل رسالة الخطأ فقط (ولا تُرسل أي بيانات شخصية) للمساعدة في إصلاح الأخطاء. معطَّل افتراضياً.",
    changePhoto: "تغيير صورة الملف الشخصي",
    removePhoto: "إزالة الصورة",
    photoFailed: "تعذّر استخدام تلك الصورة كصورة ملف شخصي.",
    support: "الدعم",
    reportIssue: "الإبلاغ عن مشكلة",
    supportUnavailable: "لا يملك Daltoon X قناة دعم بعد. والرابط السابق لم يكن لنا.",
    aboutBody: "Daltoon X — تعديلات النظام مع نسخ احتياطي وتراجع تلقائيين.",
    close: "إغلاق",
  },
  auth: {
    login: "تسجيل الدخول",
    register: "إنشاء حساب",
    email: "البريد الإلكتروني",
    password: "كلمة المرور",
    confirmPassword: "تأكيد كلمة المرور",
    passwordHint: "ثمانية أحرف على الأقل.",
    loginButton: "تسجيل الدخول",
    registerButton: "إنشاء الحساب",
    checkingSession: "جارٍ التحقق من جلستك…",
    working: "…",
    logout: "تسجيل الخروج",
    loggedInAs: "مسجَّل الدخول باسم {email}",
    backendNotConfigured: "لم يُوصَّل خادم بعد: عيّن API_BASE_URL بعد نشر الخدمة الخلفية.",
    switchToRegister: "ليس لديك حساب؟ أنشئ حساباً",
    switchToLogin: "لديك حساب بالفعل؟ سجّل الدخول",
    emailInvalid: "أدخل عنوان بريد إلكتروني صالحاً.",
    emailRequired: "أدخل عنوان بريدك الإلكتروني.",
    passwordRequired: "أدخل كلمة المرور.",
    passwordMismatch: "كلمتا المرور غير متطابقتين.",
    passwordTooShort: "يجب أن تتكوّن كلمة المرور من ثمانية أحرف على الأقل.",
    firstName: "الاسم الأول",
    lastName: "اسم العائلة",
    registerDetailsRequired: "الاسم الأول واسم العائلة وتاريخ الميلاد مطلوبة.",
    loginRequiredForCheckout: "سجّل الدخول أو أنشئ حساباً قبل فتح Pro.",
    forgotPasswordLink: "هل نسيت كلمة المرور؟",
    forgotPasswordButton: "أرسل رابط إعادة التعيين",
    forgotPasswordSent: "إن كان ذلك البريد مسجَّلاً، فسيصلك رابط لإعادة تعيين كلمة المرور.",
    backToLogin: "العودة إلى تسجيل الدخول",
    emailNotVerified: "البريد غير مُتحقَّق منه",
    emailVerified: "البريد مُتحقَّق منه",
    resendVerification: "إعادة الإرسال",
    verificationSent: "أُرسل بريد التحقق.",
  },
  driftWatch: {
    title: "مراقبة تحديثات ويندوز",
    body: "التحديث التراكمي يعيد ما لا يعرفه: تختفي تغييراتك وتكتشف ذلك بعد أسابيع، إن اكتشفت أصلاً. مع تفعيل هذا، يُجرى الفحص عند تسجيل الدخول ويُعلمك فقط حين يتوقف شيء فعلاً عن السريان.",
    on: "مُفعَّل",
    off: "معطَّل",
  },
  hardware: {
    intro:
      "يُقرأ مباشرة من حسّاسات عتادك نفسها. وحيث لا يوجد حسّاس نقول ذلك، بدل عرض رقم لا يستطيع أحد التحقق منه.",
    gpuLabel: "كرت الرسوميات",
    cpuLabel: "المعالج",
    liveBadge: "مباشر",
    gpuDriver: "التعريف {version}",
    load: "حمل كرت الرسوميات",
    vram: "الذاكرة الرسومية",
    fan: "المروحة",
    power: "استهلاك الطاقة",
    fanIdle: "متوقفة: لا حاجة لها دون 50°",
    powerLimit: "حدّ {limit} واط",
    tempCool: "باردة",
    tempGood: "سليمة",
    tempWarm: "دافئة",
    tempHot: "تعمل بسخونة",
    traceLabel: "هذه الجلسة",
    traceRange: "أدنى {min}° · أعلى {max}°",
    noTempSensor: "لا يعرض هذا الكرت حسّاس حرارة.",
    cpuAcpiSource: "مقروء من منطقة الحرارة ACPI",
    cpuNoSensor:
      "لا تكشف إعدادات هذا الجهاز عن منطقة حرارة ACPI، فلا حارة لويندوز لقرائتها. والأدوات التي تُظهر رقماً دائماً تُثبِّت تعريفاً على مستوى النواة لقراءة سجلات المعالج مباشرة: لا يفعل Daltoon X ذلك، ويفضّل أن يقول لك ذلك على أن يعرض رقماً من عنده.",
    noGpuTool:
      "لم يُكتشف كرت NVIDIA. أما AMD وIntel فلا توفّران أداة استعلام مماثلة، لذا لا يمكن قراءة حرارتهما دون برمجيات الشركة نفسها.",
    thermalsUnavailable: "تعذّرت قراءة الحسّاسات على هذا النظام.",
    driversTitle: "عُمر التعريفات",
    driversSubtitle:
      "مدى قِدم التعريفات التي وفّرتها الشركات. يعرف ويندوز ما هو مُثبَّت لا ما هو متاح: فهذا يعرض العُمر الذي يستطيع إثباته، ولا يُطلق تنبيهات تحديث وهمية أبداً.",
    driversRescan: "إعادة الفحص",
    driversScanning: "جارٍ الفحص…",
    driversCounted: plurals(AR, {
      one: "{count} تعريف من شركة",
      two: "{count} تعريفان من شركتين",
      few: "{count} تعريفات من شركات",
      many: "{count} تعريفاً من شركات",
      other: "{count} تعريف من شركات",
    }),
    driversAging: plurals(AR, {
      one: "{count} أقدم من سنتين",
      two: "{count} أقدم من سنتين",
      few: "{count} أقدم من سنتين",
      many: "{count} أقدم من سنتين",
      other: "{count} أقدم من سنتين",
    }),
    driversStale: plurals(AR, {
      one: "{count} أقدم من أربع سنوات",
      two: "{count} أقدم من أربع سنوات",
      few: "{count} أقدم من أربع سنوات",
      many: "{count} أقدم من أربع سنوات",
      other: "{count} أقدم من أربع سنوات",
    }),
    driversAllCurrent: "الكل حديثة",
    driversNone: "لا توجد تعريفات من أطراف ثالثة في هذه الفئات.",
    driversShowAll: plurals(AR, {
      one: "اعرض {count} إضافياً",
      two: "اعرض {count} إضافيين",
      few: "اعرض {count} إضافية",
      many: "اعرض {count} إضافياً",
      other: "اعرض {count} إضافياً",
    }),
    driversShowLess: "اعرض أقل",
    driversInboxNote:
      "استُبعدت {count} من تعريفات ويندوز المدمجة: يخدمها Windows Update وتاريخها تاريخ ثابت، فلا يصحّ احتسابها كقديمة.",
    ageYears: "{years} سنوات",
    ageYear: "{years} سنة",
    ageMonths: "{months} أشهر",
    ageMonth: "{months} شهر",
    vendorSite: "موقع الشركة",
    watchLabel: "تُراقَب",
    peakLabel: "الأعلى",
    verdictRisky: "خطِر",
    verdictNormal: "طبيعي",
    verdictBetter: "أفضل من المتوقع",
    verdictIdle: "خامل",
    verdictRiskyHint:
      "تجاوز الكرت 84°، وهي النقطة التي يبدأ عندها خفض أدائه لحماية نفسه. تحقّق من تدفّق الهواء، أو انتقل إلى وضع «هادئ».",
    verdictNormalHint: "حرارة ضمن النطاق المعتاد لكرت تحت الحمل: لا شيء مقلِق.",
    verdictBetterHint: "بقي دون 65° أثناء عمل حقيقي: تبريد أفضل من معظم الكروت.",
    verdictIdleHint:
      "لم يعمل بجد بما يكفي للحكم. فالكرت الخامل يبقى بارداً على أي حال، وهذا لا يثبت شيئاً.",
    profilesTitle: "الملفات الحرارية",
    profilesSubtitle:
      "هذه تضبط حدّ طاقة الكرت، وهو العصا فعلياً التي تحكم الحرارة وضجيج المروحة. وكل قيمة تأتي من الحدود التي يبلّغ عنها الكرت نفسه.",
    currentLimit: "الآن: {watts} واط",
    modeSilent: "هادئ",
    modeSilentHint:
      "للعمل والبث والجلسات الطويلة: تبقى المروحة قريبة من الصمت ويعمل الكرت أبرد بكثير، مقابل عدد إطارات أقل قليلاً.",
    modeStandard: "قياسي",
    modeStandardHint:
      "سقف متوازن أقل قليلاً من حدّ الكرت: مروحة أهدأ وحرارة أدنى، مقابل عدد إطارات أقل بأرقام فردية منخفضة.",
    modeGaming: "ألعاب",
    modeGamingHint:
      "للجلسات التنافسية: بأقصى واط مع رفع حدّ التردد، للحفاظ على ثبات أدنى 1% عندما يهمّ الأمر.",
    modeApplying: "جارٍ التطبيق…",
    profileStageReading: "جارٍ قراءة حدود الكرت",
    profileStageApplying: "جارٍ تطبيق الحدّ",
    profileStageSettling: "بانتظار استجابة المراوح",
    profileApplied: "ضُبط الحدّ على {watts} واط.",
    profileNote:
      "يتطلب صلاحيات المشرف ويُعاد ضبطه عند إعادة التشغيل. هذا ليس منحنى سرعة للمروحة: لا يكشف nvidia-smi تحكماً مباشراً بالمروحة، والأدوات التي توفّره تستخدم واجهات خاصة غير موثّقة لا يمسّها هذا التطبيق.",
    profileDefaultIsMax:
      "على هذا الكرت يساوي حدّ الطاقة المصناعي الحدّ الأقصى أصلاً، فـ «هادئ» هو الملف الوحيد الذي يغيّر الواطات: أما «ألعاب» فيختلف برفع حدّ التردد بدلاً من ذلك.",
    driverInstalled: "مُثبَّت الإصدار {version} بتاريخ {date}",
    driversNoUpdateCheck:
      "هذه الشاشة لا تتصل بأي شركة ولا تستطيع معرفة ما إذا كان هناك إصدار أحدث: تعرض الإصدار المُثبَّت وعُمره، وتوصلك بالصفحة الرسمية لتتحقق بنفسك.",
    driversCheckedAt: "قُرئ عند {time}",
    modeClockLocked: "التردد حتى {mhz} ميغاهرتز",
    modeClockAuto: "تردد تلقائي",
    profileApply: "تطبيق الملف",
    profileActive: "الملف مُفعَّل",
    profileWillSet: "سيضبط {watts} واط، {clock}",
    scanStarting: "جارٍ بدء الفحص…",
    scanReading: "جارٍ قراءة الفئة {class}",
    scanCount: "{done}/{total} · {pct}%",
    driversScannedAll: "فُحص {total} تعريفاً عبر {classes} فئات",
    winUpdateLabel: "Windows Update",
    winUpdateButton: "فحص Windows Update",
    winUpdateNote:
      "هذا يفحص فهرس Windows Update نفسه فقط، لا التعريفات المحددة أعلاه: فكثير من الشركات — الصوت الداخلي ومجموعات الشرائح خاصة — لا تنشر تحديثاتها هناك إطلاقاً، بل على مواقعها فقط. ولا يُنزّل Daltoon X حِزَم التعريفات بنفسه: لا توجد واجهة برمجية من شركة تخبرنا بما هو الحالي لجهازك تحديداً، وتثبيت تعريف عرض خاطئ أحد الأخطاء القليلة التي قد تُبقيك بلا شاشة.",
    winUpdateOpened: "فُتح Windows Update.",
    winUpdateSearching: "جارٍ البحث…",
    winUpdateTakesAWhile: "قد يستغرق هذا دقيقة — فهو يستعلم فهرس مايكروسوفت.",
    winUpdateInstall: plurals(AR, {
      one: "نزِّل وثبِّت ({count})",
      two: "نزِّل وثبِّت ({count})",
      few: "نزِّل وثبِّت {count}",
      many: "نزِّل وثبِّت {count}",
      other: "نزِّل وثبِّت {count}",
    }),
    winUpdateInstalling: "جارٍ التنزيل والتثبيت…",
    winUpdateNone:
      "لا لدى Windows Update ما هو أحدث، حتى للتعريفات الظاهرة أعلاه على أنها قديمة: فكثير من الشركات تنشر تحديثاتها بطريقتها الخاصة لا عبر Windows Update.",
    winUpdateFailed: "فشل البحث: {detail}",
    winUpdateDone: "ثُبِّت {installed}، فشل {failed}.",
    rebootTitle: "يطلب ويندوز إعادة التشغيل",
    rebootBody:
      "يفيد ويندوز بأن التثبيت لا يكتمل إلا بعد إعادة تشغيل. يمكنك فعلها الآن أو حين يناسبك.",
    rebootNow: "أعد التشغيل الآن",
    rebootLater: "لاحقاً",
  },
  tweaks: {
    disable_restart_apps: {
      name: "امنع فتح التطبيقات تلقائياً بعد تسجيل الدخول",
      description:
        "يمنع ويندوز من إعادة فتح التطبيقات القابلة لإعادة التشغيل من الجلسة السابقة بعد تسجيل الدخول. سيضيع استعادة الجلسة التلقائية؛ ولا يُغلق هذا التطبيقات الآن ولا يغيّر الدخول التلقائي.",
    },
    enable_long_paths: {
      name: "فعّل المسارات الطويلة في التطبيقات المتوافقة",
      description:
        "يسمح للتطبيقات التي تُعلن دعم المسارات الطويلة بتجاوز الحدّ التقليدي. وقد تبقى التطبيقات القديمة وبعض عمليات مستكشف الملفات محدودة. أعد تشغيل التطبيقات؛ وقد يجعل استعادة هذا الإعداد المسارات الطويلة القائمة غير متاحة.",
    },
    disable_filter_keys_shortcut: {
      name: "امنع تفعيل مفاتيح التصفية بالخطأ",
      description:
        "يعطّل اختصار Shift الأيمن لمفاتيح التصفية فقط. تبقى ميزة إمكانية الوصول وإعدادات توقيتها كما هي؛ ولا يخفّض هذا تأخر لوحة المفاتيح.",
    },
    ecoqos_rules: {
      name: "قواعد كفاءة التطبيقات الخلفية",
      description:
        "يمنح أولوية طاقة أقل للملفات التنفيذية المختارة ما دام Daltoon X مفتوحاً. وتتوقّف القواعد عندما يعود التطبيق تفاعلياً؛ وهذا ليس حدّاً بنسبة مئوية للمعالج.",
    },
    limit_do_background_download: {
      name: "حدّ التنزيل في خلفية ويندوز",
      description:
        "يضبط حدّاً بالكيلوبايت في الثانية لتنزيلات مايكروسوفت التي تديرها خدمة Delivery Optimization. لا يحدّ Steam أو الأجهزة الأخرى ولا يضمن انخفاض زمن الاستجابة.",
    },
    monitor_refresh_profile: {
      name: "معدل تحديث المراقبة أثناء الألعاب",
      description:
        "اختر معدل تحديث مدعوماً لشاشة واحدة أثناء جلسة لعب، مع معاينة مؤقتة واستعادة. لا يزيد إنتاج كرت الرسوميات من الإطارات.",
    },
    cpu_energy_performance: {
      name: "أعطِ الأولوية لأداء المعالج على الطاقة الكهربائية",
      description:
        "يضبط تفضيل أداء الطاقة/الأداء للمعالج على 0 في المخطط الحالي أثناء الاتصال بالطاقة. يتطلب دعم CPPC المستقل؛ ولا تزال حدود العتاد والحرارية سارية. قد يزيد الحرارة واستهلاك الطاقة. إعدادات البطارية تبقى كما هي. اختبر حمل عملك قبل الإبقاء عليه.",
    },
    pcie_link_power: {
      name: "أبقِ روابط PCIe نشِطة على الطاقة الكهربائية",
      description:
        "يعطّل توفير طاقة حالة الرابط في PCIe ضمن المخطط الحالي أثناء الاتصال بالطاقة. خيار استكشافي للأجهزة التي تعاني من انتقالات الطاقة؛ ولا يُحسِّن التحسين في زمن الاستجابة. قد يزيد استهلاك الطاقة أثناء الخمول. إعدادات البطارية تبقى كما هي.",
    },
    usb_suspend_diagnostics: {
      name: "تشخيص إيقاظ USB على الطاقة الكهربائية",
      description:
        "يعطّل الإيقاف الانتقائي لـ USB أثناء الاتصال بالطاقة للتحقيق في مشكلات إيقاظ الأجهزة أو انفصالها. يوصي ويندوز عادةً بإبقائه مُفعَّلاً. أعِده بعد الاختبار؛ قد يزداد استهلاك الطاقة أثناء الخمول. إعدادات البطارية تبقى كما هي.",
    },
    hybrid_short_threads: {
      name: "فضّل النوى عالية الأداء للخيوط القصيرة",
      description:
        "على معالج ذو فئات كفاءة مختلفة، يطلب من ويندوز تفضيل النوى عالية الأداء للخيوط قصيرة العمر أثناء الاتصال بالطاقة. هذا تفضيل لا قناع ارتباط ثابت؛ فقد تعمل الجدولة التلقائية بشكل أفضل. إعدادات البطارية تبقى كما هي.",
    },
    hybrid_long_threads: {
      name: "فضّل النوى عالية الأداء للخيوط الطويلة",
      description:
        "على معالج ذو فئات كفاءة مختلفة، يطلب من ويندوز تفضيل النوى عالية الأداء للخيوط طويلة العمر أثناء الاتصال بالطاقة. تبقى النوى الأخرى متاحة؛ ولا تُعطَّل النوى الموفِّرة للطاقة. قارن الإنتاجية وسرعة الاستجابة. إعدادات البطارية تبقى كما هي.",
    },
    disable_startup_delay: {
      name: "أزل تأخير تطبيقات بدء التشغيل",
      description:
        "ينتظر ويندوز عمداً نحو 10 ثوانٍ بعد تسجيل الدخول قبل تشغيل برامج بدء التشغيل لديك. يزيل هذا الانتظار (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    menu_show_delay: {
      name: "استجابة فورية للقوائم",
      description:
        "يزيل التأخير المدمج قبل فتح القوائم، مما يجعل سطح المكتب كله أسرع ملحوظاً (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    disable_power_throttling: {
      name: "عطّل خفض طاقة المعالج",
      description:
        "يمنع ويندوز من إبطاء العمليات الخلفية لتوفير الطاقة — مفيد على الأجهزة المحمولة حيث يسبب الخفض تقطّعاً أثناء الجلسات الطويلة (HKLM، يتطلب صلاحيات المشرف).",
    },
    games_gpu_priority: {
      name: "اضبط قيمة Games GPU Priority القديمة",
      description:
        "يكتب قيمة Games GPU Priority التي توثّق مايكروسوفت بأنها غير مستخدمة. لا يُتوقع أي تحسّن في أولوية كرت الرسوميات أو معدل الإطارات (HKLM، يتطلب صلاحيات المشرف).",
    },
    disable_tailored_experiences: {
      name: "عطّل التجارب المخصَّصة",
      description:
        "يمنع ويندوز من استخدام بيانات التشخيص لتخصيص الإعلانات والنصائح والتوصيات لك (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    disable_app_launch_tracking: {
      name: "أوقف تتبّع التطبيقات التي تفتحها",
      description:
        "يسجّل ويندوز عدد مرات تشغيل كل برنامج لترتيب نتائج قائمة ابدأ. يوقف هذا التسجيل (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    disable_feedback_requests: {
      name: "أوقف طلبات الملاحظات من ويندوز",
      description:
        "يمنع ويندوز من مقاطعتك باستبيانات مثل «ما احتمال أن توصي بنا؟» (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    disable_cortana: {
      name: "عطّل Cortana",
      description:
        "يُعطّل Cortana عبر سياسة النظام، محرِّراً موارد الخلفية التي يحجزها (HKLM، يتطلب صلاحيات المشرف).",
    },
    show_file_extensions: {
      name: "اعرض امتدادات الملفات دائماً",
      description:
        "يكشف الامتداد الحقيقي لكل ملف. يستحق التفعيل لأسباب أمنية وحدها: فهو يكشف ملفات مثل «invoice.pdf.exe» التي يخفيها ويندوز (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    hide_taskbar_widgets: {
      name: "أخفِ الأدوات من شريط المهام",
      description:
        "يزيل زر الأدوات (الطقس والأخبار) الذي يحمّل المحتوى في الخلفية حتى لو لم تفتحه إطلاقاً (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    network_latency: {
      name: "إقرارات TCP وتخزين الحزم المؤقت",
      description:
        "يضبط TcpAckFrequency وTCPNoDelay على 1 في أول محوّل يبلّغه ويندوز بأنه «مُفعَّل». يستهدف هذا سلوك TCP؛ ولا تتأثر حركة بيانات UDP. ويختلف دعم ويندوز والتطبيقات لهذا، لذا لا يُضمن انخفاض زمن استجابة الألعاب (HKLM، يتطلب صلاحيات المشرف).",
    },
    disable_window_animations: {
      name: "حركات نوافذ فورية",
      description:
        "يزيل حركة الانزلاق/التلاشي التي يعرضها ويندوز كلما فُتحت نافذة أو أُغلقت أو صُغّرت. الحركة هي وقت انتظار خالص — وإزالتها تجعل سطح المكتب يستجيب لحظة نقرتك، وتحرّر عمل كرت الرسوميات خلفها (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    disable_drag_full_windows: {
      name: "سحب أنعم للنوافذ",
      description:
        "يرسم إطاراً أثناء سحب النافذة بدل إعادة طلاء محتواها بالكامل في كل إطار. الفرق يكاد لا يُلاحظ على كرت رسوميات سريع، ويكون واضحاً على الرسوميات المدمجة أو الأجهزة الأقدم (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    mouse_hover_delay: {
      name: "استجابة فورية لتمرير المؤشر",
      description:
        "ينتظر ويندوز 400 مللي ثانية قبل الاستجابة للمؤشر حين يستقر على عنصر — معاينات شريط المهام والتلميحات والقوائم. يخفض هذا الانتظار إلى ما يكاد يكون صفراً، فتتبع الواجهة المؤشر بدل أن تتأخر خلفه (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    disable_background_apps: {
      name: "أوقف التطبيقات العاملة في الخلفية",
      description:
        "يمنع تطبيقات المتجر من التشغيل والتحديث واستطلاع الشبكة أثناء عدم استخدامها. هذا معالج وذاكرة وبطارية تُنفَق فعلاً على تطبيقات لم تفتحها (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    disable_delivery_optimization: {
      name: "أوقف مشاركة تحديثات ويندوز مع مجهولين",
      description:
        "يرفع ويندوز ملفات التحديثات المُنزَّلة إلى أجهزة أخرى عبر اتصالك افتراضياً. يحدّ هذا من Delivery Optimization إلى جهازك وحده، فيتوقف هذا الرفع عن ابتلاع نطاق النطاق أثناء اللعب (HKLM، يتطلب صلاحيات المشرف).",
    },
    disable_copilot: {
      name: "سياسة Copilot القديمة (استعادة فقط)",
      description:
        "هذه السياسة المتقاعدة لا تتحكم في تطبيق Copilot الحالي. يمكنك استعادة قيمة السجل المحفوظة الخاصة بها هنا. أدر تطبيق Copilot المنفصل ضمن Debloat؛ وإزالته لا تمنع إعادة التثبيت لاحقاً.",
    },
    disable_suggested_apps: {
      name: "أوقف ويندوز من تثبيت التطبيقات بنفسه",
      description:
        "يقوم ويندوز بتثبيت تطبيقات وألعاب «مقترحة» بهدوء في قائمة ابدأ دون أن يسألك، بعد التثبيت الجديد وبعد التحديثات الكبيرة. يوقف ذلك، فلا يصل إلى جهازك شيء لم تختره (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    disable_mouse_acceleration: {
      name: "عطّل تسارع المؤشر",
      description:
        "يُعطّل «دقة المؤشر المحسَّنة»، مما يجعل المؤشر يقطع مسافة أطول كلما حرّكت الفأرة أسرع. تلك الاستجابة المتغيّرة هي بالضبط ما لا تريده عند التصويب: فالحركة الفيزيائية نفسها يجب أن تقطع دائماً المسافة نفسها على الشاشة (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    disable_sticky_keys_prompt: {
      name: "أوقف نافذة المفاتيح اللاصقة",
      description:
        "الضغط على Shift خمس مرات يفتح عادةً نافذة المفاتيح اللاصقة — وفي اللعبة يعني ذلك alt-tab بعيداً عن ملء الشاشة في أسوأ لحظة ممكنة، غالباً وسط قتال. يعطّل هذا الاختصار والنافذة؛ وتبقى المفاتيح اللاصقة متاحة في الإعدادات (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    disable_recall: {
      name: "عطّل Recall (لقطات شاشة بالذكاء الاصطناعي)",
      description:
        "يأخذ Recall لقطة شاشة لسطح مكتبك كل بضع ثوانٍ ويبني سجلاً قابلاً للبحث مفهرساً بالذكاء الاصطناعي لكل ما نظرت إليه — بما في ذلك كلمات المرور والرسائل الخاصة، لأنه يلتقط أي شيء على الشاشة. تضبط هذا سياسة النظام التي تمنعه من تحليل أي شيء أو تخزينه (HKLM، يتطلب صلاحيات المشرف).",
    },
    global_timer_resolution: {
      name: "دقة مؤقّت عامة",
      description:
        "يضبط راية GlobalTimerResolutionRequests في السجل على 1. وهذا لا يطلب دقة مؤقّت محددة ولا يتحقق منها بذاته. يعتمد السلوك على إصدار ويندوز؛ ولا يُضمن انخفاض زمن الاستجابة أو ارتفاع معدل الإطارات. يلزم إعادة التشغيل (HKLM، يتطلب صلاحيات المشرف).",
    },
    disable_core_parking: {
      name: "عطّل إيقاف النوى مؤقتاً",
      description:
        "يمنع ويندوز من إيقاف نوى المعالج الخاملة مؤقتاً أثناء الاتصال بالطاقة، فلا تحتاج النواة إلى إيقاظ قبل أن تخدم إدخالاً أو دفعة عمل مفاجئة. يُطبَّق على ملف الطاقة الكهربائية فقط — فعلى البطارية الإيقاف المؤقت موجود لهذا الغرض. تُسجَّل القيمة السابقة للمخطط وتُستعاد تماماً عند التراجع (يتطلب صلاحيات المشرف).",
    },
    disable_memory_integrity: {
      name: "عطّل سلامة الذاكرة (VBS)",
      description:
        "يطلب تعطيل سلامة الذاكرة (HVCI). وعند التطبيق، يزيل هذا طبقة من حماية النواة؛ وقد تبقى ميزات VBS الأخرى مُفعَّلة. يختلف تأثير الأداء بحسب العتاد وحمل العمل. وقد يمنع التغييرُ قفلُ السياسة أو UEFI له. أعد التشغيل وتحقّق من الحالة في أمان ويندوز (HKLM، يتطلب صلاحيات المشرف).",
    },
    disable_typing_personalization: {
      name: "أوقف ويندوز من تعلّم كتابتك",
      description:
        "يبني ويندوز قاموساً شخصياً مما تكتبه وتكتبه بخط اليد — بما في ذلك داخل مديري كلمات المرور ونوافذ الدردشة وصناديق البحث — ويزامنه مع حساب مايكروسوفت الخاص بك لتحسين اقتراحاته. يوقف هذا جمع النص وجمع الخط اليدوي معاً (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    classic_context_menu: {
      name: "أعد قائمة النقر الكامل",
      description:
        "يخفي ويندوز 11 معظم قائمة النقر بزر الفأرة الأيمن خلف «إظهار خيارات أخرى»، فيحوّل نقرة واحدة إلى اثنتين لأشياء تفعلها طوال اليوم. يستعيد هذا قائمة ويندوز 10 الكاملة في كل مكان داخل مستكشف الملفات وعلى سطح المكتب. يُعاد تشغيل المستكشف لتطبيقها، لذا ستومض النوافذ المفتوحة مرة واحدة (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    disable_transparency: {
      name: "عطّل تأثيرات الشفافية",
      description:
        "يوقف تأثيرات الطمس/الأكريليك في شريط المهام والقوائم. توفير صغير لكنه حقيقي على كرت الرسوميات، ويجعل الأجهزة الأقدم أو ذات الرسوميات المدمجة أكثر سلاسة (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    dark_mode: {
      name: "الوضع الداكن",
      description: "يفعّل السمة الداكنة للتطبيقات والنظام (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    show_hidden_files: {
      name: "اعرض الملفات المخفية",
      description:
        "يعرض الملفات والمجلدات المخفية في مستكشف الملفات (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    priority_separation: {
      name: "حسّن أولوية المعالج",
      description:
        "يضبط Win32PrioritySeparation (0x26) لتمنح التطبيق الأمامي شرائح زمنية قصيرة ومتغيرة على المعالج مع تعزيز أولوية ثلاثي الأضعاف — وهي قيمة الاستجابة الكلاسيكية لسطح المكتب والألعاب (HKLM، يتطلب صلاحيات المشرف).",
    },
    disable_game_dvr: {
      name: "عطّل Xbox Game Bar / Game DVR",
      description:
        "يوقف التسجيل الخلفي في Xbox Game Bar، الذي يستهلك المعالج وكرت الرسوميات أثناء اللعب (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    disable_telemetry_tasks: {
      name: "قلّل جمع بيانات التشخيص",
      description:
        "يضبط مستوى بيانات التشخيص في ويندوز على أدنى حد مسموح (HKLM، يتطلب صلاحيات المشرف).",
    },
    reset_advertising_id: {
      name: "عطّل معرّف الإعلانات",
      description:
        "يمنع التطبيقات من استخدام معرّف الإعلانات في إنشاء ملفك الشخصي (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    disable_location_tracking: {
      name: "عطّل تتبّع الموقع",
      description:
        "يحجب الوصول إلى الموقع لكل التطبيقات عبر سياسة النظام (HKLM، يتطلب صلاحيات المشرف).",
    },
    disable_bing_search: {
      name: "عطّل بحث Bing في قائمة ابدأ",
      description: "يمنع إرسال عمليات بحثك من قائمة ابدأ إلى Bing (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    power_plan_performance: {
      name: "أداء عالٍ (مخطط الطاقة)",
      description:
        "يتبدّل إلى مخطط طاقة «الأداء العالي» في ويندوز. مفيد على الأجهزة المكتبية أو أثناء الاتصال بالطاقة؛ ويعيد المخطط السابق عند التراجع.",
    },
    turbo_gaming: {
      name: "الألعاب الفائق",
      description:
        "إعداد مُعدَّل: يعطّل Game DVR، ويبدّل مخطط الطاقة إلى الأداء العالي، ويحسّن أولوية المعالج (يتطلب صلاحيات المشرف).",
    },
    privacy_dns: {
      name: "DNS خاص (Cloudflare)",
      description:
        "يتبدّل إلى خوادم DNS المركَّزة على الخصوصية (1.1.1.1)، فيتوقف مزوّد الإنترنت عن تسجيل عمليات بحث DNS. ولا يُخفي عنوان IP (ذلك يحتاج VPN، انظر أدناه).",
    },
    hardware_gpu_scheduling: {
      name: "جدولة كرت الرسوميات بتسريع العتاد",
      description:
        "يطلب جدولة كرت الرسوميات بتسريع العتاد (HAGS). يتطلب كرتاً وتعريفاً وإصدار ويندوز متوافقاً. قد يتحسّن الأداء وزمن الاستجابة أو يسوء أو يبقى كما هو بحسب اللعبة. أعد التشغيل وتحقّق من التوافر في إعدادات رسومات ويندوز (HKLM، يتطلب صلاحيات المشرف).",
    },
    reduce_input_lag: {
      name: "قلّل تأخر الإدخال (الفأرة)",
      description:
        "يعطّل تسارع المؤشر («دقة المؤشر المحسَّنة») لحركة فأرة بنسبة 1:1، دون أي تأخير يضيفه النظام (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    turbo_boost: {
      name: "تعزيز المعالج الفائق",
      description:
        "يضبط وضع التعزيز على «متسّع» على الطاقة الكهربائية والبطارية، والحدّ الأدنى لحالة المعالج على 100% على الطاقة الكهربائية ضمن مخطط الطاقة الحالي. قد يزداد استهلاك الطاقة والحرارة. ولا تزال حدود المعالج والعتاد والحرارية سارية؛ ولا يُضمن معدل إطارات أعلى (يتطلب صلاحيات المشرف).",
    },
    network_throttling_index: {
      name: "عطّل خفض حركة الشبكة للوسائط",
      description:
        "يزيل الحدّ الذي يضعه ويندوز على حركة الشبكة أثناء نشاط تطبيقات الوسائط/الألعاب، وهو مفيد لتقليل التأخر الدقيق المتصل (HKLM، يتطلب صلاحيات المشرف).",
    },
    system_responsiveness: {
      name: "اضبط حجز المعالج الخلفي في MMCSS",
      description:
        "يكتب SystemResponsiveness=0، وهو ما يعامله ويندوز على أنه 20%. ولا يلغي هذا حصة المعالج للمهام ذات الأولوية الأدنى ولا يعطي الأولوية لكل تطبيق أمامي (HKLM، يتطلب صلاحيات المشرف).",
    },
    games_task_priority: {
      name: "اضبط فئة مهام Games في MMCSS",
      description:
        "يضبط فئة مهام Games على «عالية» للخيوط المسجَّلة في MMCSS؛ و«عالية» تعامل الأولوية على أنها 2. وقيمتا أولوية GPU وأولوية SFIO المكتوبتان هنا غير مستخدمتين. ولا يعطي هذا الأولوية لكل عملية لعبة (HKLM، يتطلب صلاحيات المشرف).",
    },
    reduce_keyboard_delay: {
      name: "قلّل تأخر الإدخال (لوحة المفاتيح)",
      description:
        "يصفّر التأخير قبل أن يبدأ مفتاح مضغوط بالتكرار ويرفع معدل تكراره إلى أقصى حد، لاستجابة أسرع في الألعاب (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    keep_kernel_in_ram: {
      name: "أبقِ النواة والتعريفات في الذاكرة",
      description:
        "قد يبدّل ويندوز أجزاء من كود النواة والتعريفات إلى القرص حتى مع توفر ذاكرة كافية، وإعادتها إلى الذاكرة هي توقّف تشعره كتقطّع. يبقي هذا مقيمها. يستحق ذلك على الأجهزة ذات الذاكرة الفائضة؛ وعلى جهاز منخفض الذاكرة اتركه معطَّلاً (HKLM، يتطلب صلاحيات المشرف).",
    },
    auto_end_frozen_tasks: {
      name: "لا تدع تطبيقاً معلّقاً يعطّل الإيقاف",
      description:
        "عند توقف تطبيق عن الاستجابة أثناء الإيقاف، ينتظر ويندوز ويعرض شاشة «هذا التطبيق يمنع الإيقاف» حتى ينقر عليها أحد. يُغلق هذا التطبيقات غير المستجابة تلقائياً بدلاً من ذلك، فلا يستطيع برنامج معلّق أن يترك الجهاز يعمل بلا جدوى (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    instant_folder_loading: {
      name: "افتح كل مجلد فوراً",
      description:
        "يفحص مستكشف الملفات محتوى مجلد ليتخيّل ما إذا كان صوراً أو موسيقى أو مستندات، وقد يتعلّق مجلد يحوي آلاف ملفات الوسائط ثوانٍ وهو يقرّر. يثبّت هذا كل مجلد على التخطيط العام فيفتح فوراً (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    tcp_congestion_bbr: {
      name: "حافظ على انخفاض زمن الاستجابة عند ازدحام الخط (BBR2)",
      description:
        "يستخدم ويندوز CUBIC، الذي يسرّع حتى يفيض مخزن ما — ولهذا يرتفع زمن استجابتك فور أن يبدأ شخص آخر في المنزل تنزيلاً. يقيس BBR2 عرض نطاق الخط وزمن الذهاب والإياب الحقيقيين ويضبط إيقاع البيانات ليناسبهما، فتمتلئ الأنبوب دون امتلاء الطابور. تشحن مايكروسوفت BBR2 في ويندوز 11؛ وهذا ينقل قالب الإنترنت إليه، ويعيده بالضبط إلى ما كان عليه (يتطلب صلاحيات المشرف).",
    },
    taskbar_align_left: {
      name: "حاذِ شريط المهام إلى اليسار",
      description:
        "يعيد أيقونات شريط المهام إلى اليسار (بنمط ويندوز 10) بدلاً من توسيطها (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    hide_taskbar_chat: {
      name: "أخفِ الدردشة/Teams من شريط المهام",
      description:
        "يزيل أيقونة الدردشة (Microsoft Teams) من شريط المهام (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    disable_start_suggestions: {
      name: "عطّل اقتراحات قائمة ابدأ والتطبيقات الموصى بها",
      description:
        "يمنع ويندوز من إظهار التطبيقات الموصى بها والإعلانات والاقتراحات في قائمة ابدأ (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    disable_activity_history: {
      name: "عطّل سجل النشاط (Windows Timeline)",
      description:
        "يمنع ويندوز من تسجيل تاريخ استخدامك للتطبيقات والمستندات وحفظه وإرساله إلى مايكروسوفت، عبر سياسة النظام (HKLM، يتطلب صلاحيات المشرف).",
    },
    hide_taskbar_search: {
      name: "أخفِ مربع البحث من شريط المهام",
      description:
        "يزيل مربع البحث أو أيقونته من شريط المهام ليصبح الشريط أنظف (البحث ما زال متاحاً من مفتاح ويندوز) (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    disable_fullscreen_optimizations_global: {
      name: "عطّل تحسينات ملء الشاشة عالمياً",
      description:
        "يجبر DXGI على احترام ملء الشاشة الحصري الحقيقي بدلاً من وضع ويندوز المحاكى، مما يقلّل التقطّع الدقيق وتأخر الإدخال في كثير من الألعاب الأقدم (HKCU، لا حاجة لصلاحيات مرتفعة).",
    },
    disable_windows_search_service: {
      name: "عطّل خدمة الفهرسة (Windows Search)",
      description:
        "يوقف خدمة فهرسة ملفات ويندوز ويعطّلها، فيقلّ نشاط القرص في الخلفية — مفيد على أقراص SSD الصغيرة أو أثناء اللعب. يصبح البحث عن الملفات في قائمة ابدأ أبطأ حتى تعيده (يتطلب صلاحيات المشرف).",
    },
  },
  cleanup: {
    temp_cleanup: {
      name: "نظّف الملفات المؤقتة",
      description:
        "ينقل محتويات مجلد ‎%TEMP%‎ إلى سلة المحذوفات: يمكنك استعادتها في أي وقت، فليست حذفاً دائماً.",
    },
    winupdate_cache_cleanup: {
      name: "امسح ذاكرة تحديثات ويندوز المؤقتة",
      description:
        "ينقل حِزَم Windows Update المُثبَّتة مسبقاً إلى سلة المحذوفات (يتطلب صلاحيات المشرف).",
    },
  },
} as Strings;
