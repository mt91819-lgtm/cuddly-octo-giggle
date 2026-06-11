/* =====================================================================
 * settings.js  —  الإعدادات العامة
 * - إعدادات بسيطة محفوظة في localStorage (المظهر، اللغة، الخط).
 * - إعدادات تشغيلية محفوظة في IndexedDB (جدول settings).
 * - تطبيق الوضع الليلي / النهاري و RTL.
 * ===================================================================== */

const Settings = (() => {
  const LS_KEY = 'cashier_ui_settings';

  /* الإعدادات الافتراضية للواجهة (localStorage) */
  const DEFAULT_UI = {
    theme: 'light', // light | dark
    accent: '#2563eb',
  };

  /* الإعدادات التشغيلية الافتراضية (IndexedDB) */
  const DEFAULT_APP = {
    storeName: 'متجر الهدايا والإكسسوارات',
    currency: 'ج.م', // الجنيه المصري
    blockSaleWhenOutOfStock: false, // منع البيع عند نفاد المخزون
    lowStockAlert: true,
    largeDiscountThreshold: 100, // الخصم الذي يتطلب موافقة المدير (بالجنيه)
    returnWindowDays: 14, // مدة السماح بالمرتجع
    autoLockMinutes: 5, // قفل الشاشة التلقائي (0 = معطّل)
    autoBackupOnClose: true, // تنزيل نسخة احتياطية تلقائيًا عند إغلاق الوردية
    printFormat: '80mm', // 58mm | 80mm | A4
    receiptFooter: 'شكرًا لزيارتكم',
    // ملصقات الباركود (طابعة الباركود)
    labelPrinter: 'browser', // browser (طباعة عبر المتصفح) | zebra-zpl (أمر ZPL مباشر لطابعات Zebra)
    labelDpi: 203, // دقة طابعة Zebra: 203 أو 300 (تُستخدم مع ZPL فقط)
    labelWidthMm: 10, // عرض الملصق في اتجاه رأس الطابعة (مم)
    labelHeightMm: 40, // طول الملصق في اتجاه التغذية/الخروج (مم) — الباركود يجري على طوله
    labelRotate: 'auto', // اتجاه الباركود: auto | h (أفقي) | v (رأسي/مدوّر)
    labelShowName: true, // إظهار اسم المنتج
    labelShowPrice: true, // إظهار السعر
    labelShowStore: false, // إظهار اسم المتجر
  };

  /* ---------- إعدادات الواجهة (localStorage) ---------- */

  function getUI() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      return Object.assign({}, DEFAULT_UI, raw ? JSON.parse(raw) : {});
    } catch (e) {
      return Object.assign({}, DEFAULT_UI);
    }
  }

  function setUI(patch) {
    const next = Object.assign(getUI(), patch);
    localStorage.setItem(LS_KEY, JSON.stringify(next));
    applyTheme();
    return next;
  }

  function applyTheme() {
    const ui = getUI();
    document.documentElement.setAttribute('data-theme', ui.theme);
    if (ui.accent) {
      document.documentElement.style.setProperty('--accent', ui.accent);
    }
  }

  function toggleTheme() {
    const ui = getUI();
    return setUI({ theme: ui.theme === 'dark' ? 'light' : 'dark' });
  }

  /* ---------- الإعدادات التشغيلية (IndexedDB) ---------- */

  async function getApp() {
    const rec = await DB.get('settings', 'app');
    return Object.assign({}, DEFAULT_APP, rec ? rec.value : {});
  }

  async function setApp(patch) {
    const current = await getApp();
    const next = Object.assign(current, patch);
    await DB.put('settings', { key: 'app', value: next });
    return next;
  }

  async function ensureDefaults() {
    const rec = await DB.get('settings', 'app');
    if (!rec) {
      await DB.put('settings', { key: 'app', value: DEFAULT_APP });
    }
  }

  return {
    getUI,
    setUI,
    applyTheme,
    toggleTheme,
    getApp,
    setApp,
    ensureDefaults,
    DEFAULT_APP,
    DEFAULT_UI,
  };
})();

window.Settings = Settings;
