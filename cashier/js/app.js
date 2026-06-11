/* =====================================================================
 * app.js  —  المتحكم الرئيسي للتطبيق
 * - التهيئة عند الإقلاع
 * - شاشة تسجيل الدخول
 * - التنقل بين الأقسام (Router)
 * - لوحة التحكم (Dashboard) المبدئية
 * - شاشة الإعدادات
 * - قفل الشاشة التلقائي
 * - أدوات مشتركة (Toast / Modal / تنسيق)
 * ===================================================================== */

/* ---------- أدوات مشتركة ---------- */
const Utils = (() => {
  function el(html) {
    const t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function money(n) {
    const v = Number(n || 0);
    return (
      v.toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
      ' ' +
      (window.__currency || 'ج.م')
    );
  }

  function dateKey(d) {
    const dt = d ? new Date(d) : new Date();
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const day = String(dt.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  }

  function fmtDateTime(ts) {
    if (!ts) return '-';
    const d = new Date(ts);
    return d.toLocaleString('ar-EG', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  let _toastTimer = null;
  function toast(msg, type = 'info') {
    let box = document.getElementById('toast');
    if (!box) {
      box = el('<div id="toast" class="toast"></div>');
      document.body.appendChild(box);
    }
    box.className = 'toast toast-' + type + ' show';
    box.textContent = msg;
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => {
      box.classList.remove('show');
    }, 3000);
  }

  /* نافذة منبثقة بسيطة قابلة للوعد (Promise) */
  function modal({ title, bodyHtml, confirmText = 'موافق', cancelText = 'إلغاء', onRender }) {
    return new Promise((resolve) => {
      const overlay = el(`
        <div class="modal-overlay">
          <div class="modal">
            <div class="modal-header">${escapeHtml(title || '')}</div>
            <div class="modal-body">${bodyHtml || ''}</div>
            <div class="modal-footer">
              ${cancelText ? `<button class="btn btn-ghost" data-act="cancel">${escapeHtml(cancelText)}</button>` : ''}
              <button class="btn btn-primary" data-act="confirm">${escapeHtml(confirmText)}</button>
            </div>
          </div>
        </div>`);
      document.body.appendChild(overlay);
      const close = (val) => {
        overlay.remove();
        resolve(val);
      };
      const cancelBtn = overlay.querySelector('[data-act="cancel"]');
      if (cancelBtn) cancelBtn.onclick = () => close(null);
      overlay.querySelector('[data-act="confirm"]').onclick = () => {
        const form = overlay.querySelector('form');
        if (form) {
          const data = Object.fromEntries(new FormData(form).entries());
          close(data);
        } else {
          close(true);
        }
      };
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close(null);
      });
      if (onRender) onRender(overlay);
    });
  }

  function confirmBox(message, title = 'تأكيد') {
    return modal({
      title,
      bodyHtml: `<p>${escapeHtml(message)}</p>`,
      confirmText: 'نعم',
      cancelText: 'لا',
    }).then((v) => v !== null);
  }

  /* بوابة موافقة المدير على العمليات الحساسة.
   * تُرجع { ok, user }. إذا كان المستخدم الحالي مديرًا فالموافقة تلقائية. */
  function requireManagerApproval(actionLabel) {
    if (window.Auth && Auth.isManager()) {
      return Promise.resolve({ ok: true, user: Auth.currentUser() });
    }
    return new Promise((resolve) => {
      const overlay = el(`
        <div class="modal-overlay"><div class="modal">
          <div class="modal-header">🔐 موافقة المدير مطلوبة</div>
          <form class="modal-body" id="appr-form">
            <p>${escapeHtml(actionLabel || 'هذه عملية حساسة وتتطلب موافقة المدير.')}</p>
            <label class="field">كلمة مرور المدير أو الكود المتغيّر
              <input type="password" name="secret" autocomplete="off" required />
            </label>
            <div class="form-error" id="appr-err"></div>
          </form>
          <div class="modal-footer">
            <button class="btn btn-ghost" data-act="cancel">إلغاء</button>
            <button class="btn btn-primary" data-act="ok">موافقة</button>
          </div>
        </div></div>`);
      document.body.appendChild(overlay);
      const form = overlay.querySelector('#appr-form');
      const close = (val) => {
        overlay.remove();
        resolve(val);
      };
      overlay.querySelector('[data-act="cancel"]').onclick = () => close({ ok: false });
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) close({ ok: false });
      });
      const submit = async () => {
        if (!form.reportValidity()) return;
        const res = await Auth.verifyManager(form.secret.value);
        if (res.ok) close({ ok: true, user: res.user });
        else overlay.querySelector('#appr-err').textContent = res.error;
      };
      overlay.querySelector('[data-act="ok"]').onclick = submit;
      form.onsubmit = (e) => {
        e.preventDefault();
        submit();
      };
      setTimeout(() => form.secret.focus(), 50);
    });
  }

  return {
    el,
    escapeHtml,
    money,
    dateKey,
    fmtDateTime,
    toast,
    modal,
    confirmBox,
    requireManagerApproval,
  };
})();
window.Utils = Utils;

/* ---------- التطبيق ---------- */
const App = (() => {
  let _appSettings = null;
  let _lockTimer = null;

  /* تعريف الأقسام في الشريط الجانبي.
     perm: مفتاح الصلاحية للموظف. managerOnly: للمدير فقط. */
  const SECTIONS = [
    { id: 'dashboard', label: 'لوحة التحكم', icon: '📊', ready: true, perm: null },
    { id: 'pos', label: 'البيع (POS)', icon: '🛒', ready: true, perm: 'pos' },
    { id: 'products', label: 'المنتجات', icon: '📦', ready: true, perm: 'products' },
    { id: 'inventory', label: 'المخزون والجرد', icon: '🏷️', ready: true, perm: 'inventory' },
    { id: 'returns', label: 'المرتجعات', icon: '↩️', ready: true, perm: 'returns' },
    { id: 'shifts', label: 'الورديات', icon: '⏱️', ready: true, perm: 'shifts' },
    { id: 'expenses', label: 'المصروفات', icon: '💸', ready: true, perm: 'expenses' },
    { id: 'reports', label: 'التقارير', icon: '📈', ready: true, perm: 'reports' },
    { id: 'users', label: 'الموظفون', icon: '👥', ready: true, perm: null, managerOnly: true },
    { id: 'audit', label: 'سجل العمليات', icon: '🧾', ready: true, perm: null, managerOnly: true },
    { id: 'backup', label: 'النسخ الاحتياطي', icon: '💾', ready: true, perm: null, managerOnly: true },
    { id: 'health', label: 'فحص النظام', icon: '🩺', ready: true, perm: null, managerOnly: true },
    { id: 'settings', label: 'الإعدادات', icon: '⚙️', ready: true, perm: null, managerOnly: true },
  ];

  /* قائمة مفاتيح الصلاحيات المتاحة للموظفين (تُستخدم في شاشة الموظفين) */
  const PERMISSION_KEYS = SECTIONS.filter((s) => s.perm).map((s) => ({ key: s.perm, label: s.label }));

  function canSee(section) {
    if (section.managerOnly) return Auth.isManager();
    if (!section.perm) return true; // مثل لوحة التحكم
    return Auth.hasPermission(section.perm);
  }

  async function init() {
    try {
      await DB.open();
      await Auth.ensureDefaultAdmin();
      await Settings.ensureDefaults();
      _appSettings = await Settings.getApp();
      window.__currency = _appSettings.currency;
      Settings.applyTheme();

      const session = Auth.restoreSession();
      if (session) {
        renderApp();
      } else {
        renderLogin();
      }
    } catch (err) {
      console.error(err);
      // عرض تفاصيل كاملة للتشخيص (الاسم + الرسالة + المكان)
      const details =
        (err && err.name ? err.name + ': ' : '') +
        (err && err.message ? err.message : String(err)) +
        (err && err.stack ? '\n' + err.stack.split('\n').slice(0, 4).join('\n') : '');
      document.getElementById('app').innerHTML =
        '<div class="fatal">خطأ في تهيئة النظام:<br><pre style="direction:ltr;text-align:left;white-space:pre-wrap;font-size:12px">' +
        Utils.escapeHtml(details) +
        '</pre></div>';
    }
  }

  /* ---------- شاشة تسجيل الدخول ---------- */
  function renderLogin() {
    const root = document.getElementById('app');
    root.innerHTML = `
      <div class="auth-screen">
        <form class="auth-card" id="login-form">
          <div class="auth-logo">🛍️</div>
          <h1>${Utils.escapeHtml(_appSettings.storeName)}</h1>
          <p class="auth-sub">تسجيل الدخول للنظام</p>
          <label>اسم المستخدم</label>
          <input type="text" name="username" autocomplete="username" value="admin" required />
          <label>كلمة المرور</label>
          <input type="password" name="password" autocomplete="current-password" required />
          <div class="auth-error" id="login-error"></div>
          <button type="submit" class="btn btn-primary btn-block">دخول</button>
          <p class="auth-hint">المستخدم الافتراضي: admin / 1234</p>
          <button type="button" class="theme-toggle-mini" id="login-theme">🌓 تبديل المظهر</button>
        </form>
      </div>`;

    document.getElementById('login-theme').onclick = () => Settings.toggleTheme();

    document.getElementById('login-form').onsubmit = async (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(e.target).entries());
      const res = await Auth.login(data.username, data.password);
      if (!res.ok) {
        document.getElementById('login-error').textContent = res.error;
        return;
      }
      renderApp();
    };
  }

  /* ---------- الهيكل الرئيسي بعد الدخول ---------- */
  function renderApp() {
    const user = Auth.currentUser();
    const root = document.getElementById('app');
    const ui = Settings.getUI();
    root.innerHTML = `
      <div class="layout">
        <aside class="sidebar">
          <div class="brand">🛍️ <span>Cashier Pro</span></div>
          <nav class="nav" id="nav"></nav>
          <div class="sidebar-footer">
            <div class="user-chip">
              <span class="avatar">${Utils.escapeHtml((user.name || '?')[0])}</span>
              <div>
                <div class="user-name">${Utils.escapeHtml(user.name)}</div>
                <div class="user-role">${user.role === 'manager' ? 'مدير' : 'موظف'}</div>
              </div>
            </div>
            <button class="btn btn-ghost btn-sm" id="logout-btn">تسجيل الخروج</button>
          </div>
        </aside>
        <main class="main">
          <header class="topbar">
            <button class="icon-btn" id="toggle-sidebar" title="القائمة">☰</button>
            <h2 id="page-title">لوحة التحكم</h2>
            <div class="topbar-actions">
              <button class="icon-btn" id="theme-btn" title="تبديل المظهر">${ui.theme === 'dark' ? '☀️' : '🌙'}</button>
              <button class="icon-btn" id="lock-btn" title="قفل الشاشة">🔒</button>
            </div>
          </header>
          <section class="content" id="content"></section>
        </main>
      </div>`;

    renderNav();

    document.getElementById('logout-btn').onclick = () => {
      Auth.logout();
      renderLogin();
    };
    document.getElementById('theme-btn').onclick = () => {
      const next = Settings.toggleTheme();
      document.getElementById('theme-btn').textContent = next.theme === 'dark' ? '☀️' : '🌙';
    };
    document.getElementById('lock-btn').onclick = lockScreen;
    document.getElementById('toggle-sidebar').onclick = () => {
      document.querySelector('.layout').classList.toggle('sidebar-collapsed');
    };

    setupAutoLock();
    navigate('dashboard');
  }

  function renderNav() {
    const nav = document.getElementById('nav');
    nav.innerHTML = SECTIONS.filter(canSee)
      .map(
        (s) => `
      <button class="nav-item" data-section="${s.id}">
        <span class="nav-icon">${s.icon}</span>
        <span class="nav-label">${Utils.escapeHtml(s.label)}</span>
        ${s.ready ? '' : '<span class="badge-soon">قريبًا</span>'}
      </button>`
      )
      .join('');
    nav.querySelectorAll('.nav-item').forEach((btn) => {
      btn.onclick = () => navigate(btn.dataset.section);
    });
  }

  /* ---------- الموجّه (Router) ---------- */
  function navigate(sectionId) {
    const section = SECTIONS.find((s) => s.id === sectionId) || SECTIONS[0];
    // حماية: منع الوصول لقسم غير مصرّح به
    if (!canSee(section)) {
      document.getElementById('content').innerHTML =
        '<div class="placeholder"><div class="placeholder-icon">🔒</div><p>ليس لديك صلاحية لهذا القسم.</p></div>';
      return;
    }
    document.querySelectorAll('.nav-item').forEach((b) =>
      b.classList.toggle('active', b.dataset.section === section.id)
    );
    document.getElementById('page-title').textContent = section.label;
    const content = document.getElementById('content');

    switch (section.id) {
      case 'dashboard':
        return renderDashboard(content);
      case 'settings':
        return renderSettings(content);
      default: {
        // الأقسام المبنية في وحدات منفصلة (تُربط بأسمائها الصريحة)
        const mod = MODULES[section.id] && window[MODULES[section.id]];
        if (mod && typeof mod.render === 'function') {
          return mod.render(content);
        }
        content.innerHTML = `
          <div class="placeholder">
            <div class="placeholder-icon">${section.icon}</div>
            <h3>${Utils.escapeHtml(section.label)}</h3>
            <p>هذا القسم سيتم تفعيله في مرحلة لاحقة من المشروع.</p>
          </div>`;
      }
    }
  }

  /* خريطة ربط أقسام القائمة بأسماء الوحدات العامة (window) */
  const MODULES = {
    pos: 'POS',
    products: 'Products',
    inventory: 'Inventory',
    returns: 'Returns',
    shifts: 'Shifts',
    expenses: 'Expenses',
    reports: 'Reports',
    users: 'Users',
    audit: 'AuditView',
    backup: 'Backup',
    health: 'Health',
  };

  /* ---------- لوحة التحكم المبدئية ---------- */
  async function renderDashboard(content) {
    content.innerHTML = '<div class="loading">جارٍ التحميل…</div>';
    const [productCount, invoiceCount, userCount] = await Promise.all([
      DB.count('products'),
      DB.count('invoices'),
      DB.count('users'),
    ]);
    const user = Auth.currentUser();
    content.innerHTML = `
      <div class="dash-welcome">
        <h3>أهلًا، ${Utils.escapeHtml(user.name)} 👋</h3>
        <p>${Utils.escapeHtml(_appSettings.storeName)} — ${Utils.fmtDateTime(Date.now())}</p>
      </div>
      <div class="cards">
        <div class="card card-blue">
          <div class="card-icon">📦</div>
          <div class="card-value">${productCount.toLocaleString('ar-EG')}</div>
          <div class="card-label">المنتجات</div>
        </div>
        <div class="card card-green">
          <div class="card-icon">🧾</div>
          <div class="card-value">${invoiceCount.toLocaleString('ar-EG')}</div>
          <div class="card-label">الفواتير</div>
        </div>
        <div class="card card-purple">
          <div class="card-icon">👥</div>
          <div class="card-value">${userCount.toLocaleString('ar-EG')}</div>
          <div class="card-label">المستخدمون</div>
        </div>
        <div class="card card-amber">
          <div class="card-icon">💱</div>
          <div class="card-value">${Utils.escapeHtml(_appSettings.currency)}</div>
          <div class="card-label">العملة</div>
        </div>
      </div>
      <div class="dash-note">
        <strong>الإصدار الحالي:</strong> المرحلة 1 — البنية الأساسية للنظام.
        تم إعداد قاعدة البيانات المحلية، تسجيل الدخول، إدارة المستخدم، الإعدادات،
        والوضع الليلي/النهاري. الأقسام الأخرى قيد البناء.
      </div>`;
  }

  /* ---------- شاشة الإعدادات ---------- */
  async function renderSettings(content) {
    const app = await Settings.getApp();
    const ui = Settings.getUI();
    content.innerHTML = `
      <form id="settings-form" class="form-grid">
        <h3 class="form-section-title">إعدادات المتجر</h3>
        <label>اسم المتجر
          <input name="storeName" value="${Utils.escapeHtml(app.storeName)}" />
        </label>
        <label>العملة
          <input name="currency" value="${Utils.escapeHtml(app.currency)}" />
        </label>
        <label>تذييل الفاتورة
          <input name="receiptFooter" value="${Utils.escapeHtml(app.receiptFooter)}" />
        </label>
        <label>صيغة الطباعة
          <select name="printFormat">
            <option value="58mm" ${app.printFormat === '58mm' ? 'selected' : ''}>58mm</option>
            <option value="80mm" ${app.printFormat === '80mm' ? 'selected' : ''}>80mm</option>
            <option value="A4" ${app.printFormat === 'A4' ? 'selected' : ''}>A4</option>
          </select>
        </label>

        <h3 class="form-section-title">ملصقات الباركود (طابعة الباركود)</h3>
        <label>طريقة الطباعة
          <select name="labelPrinter">
            <option value="browser" ${app.labelPrinter === 'browser' ? 'selected' : ''}>عبر المتصفح (أي طابعة)</option>
            <option value="zebra-zpl" ${app.labelPrinter === 'zebra-zpl' ? 'selected' : ''}>Zebra ZPL مباشر (ZD410)</option>
          </select>
        </label>
        <label>دقة طابعة Zebra (ZPL)
          <select name="labelDpi">
            <option value="203" ${Number(app.labelDpi) === 203 ? 'selected' : ''}>203 dpi</option>
            <option value="300" ${Number(app.labelDpi) === 300 ? 'selected' : ''}>300 dpi</option>
          </select>
        </label>
        <label>عرض الملصق (مم)
          <input type="number" name="labelWidthMm" min="8" max="120" step="1" value="${Number(
            app.labelWidthMm
          )}" />
        </label>
        <label>طول/ارتفاع الملصق (مم)
          <input type="number" name="labelHeightMm" min="8" max="120" step="1" value="${Number(
            app.labelHeightMm
          )}" />
        </label>
        <label>اتجاه الباركود
          <select name="labelRotate">
            <option value="auto" ${app.labelRotate === 'auto' ? 'selected' : ''}>تلقائي (يدوّر للملصق الطويل الرفيع)</option>
            <option value="h" ${app.labelRotate === 'h' ? 'selected' : ''}>أفقي</option>
            <option value="v" ${app.labelRotate === 'v' ? 'selected' : ''}>رأسي (مدوّر 90°)</option>
          </select>
        </label>
        <label class="switch-row">
          <input type="checkbox" name="labelFlip" ${app.labelFlip ? 'checked' : ''} />
          قلب اتجاه الباركود (لو طلع مقلوب)
        </label>
        <label class="switch-row">
          <input type="checkbox" name="labelShowName" ${app.labelShowName ? 'checked' : ''} />
          إظهار اسم المنتج على الملصق
        </label>
        <label class="switch-row">
          <input type="checkbox" name="labelShowPrice" ${app.labelShowPrice ? 'checked' : ''} />
          إظهار السعر على الملصق
        </label>
        <label class="switch-row">
          <input type="checkbox" name="labelShowStore" ${app.labelShowStore ? 'checked' : ''} />
          إظهار اسم المتجر على الملصق
        </label>
        <div class="label-preview-wrap">
          <span class="form-note">معاينة مباشرة (هكذا سيُطبع الملصق تمامًا):</span>
          <div id="label-preview"></div>
        </div>
        <div class="form-actions">
          <button type="button" class="btn btn-ghost" id="test-label-btn">🏷️ طباعة ملصق تجريبي</button>
          <button type="button" class="btn btn-ghost" id="test-receipt-btn">🧾 طباعة إيصال تجريبي</button>
        </div>
        <p class="form-note">تستخدم أزرار الاختبار القيم المعروضة بالأعلى (حتى قبل الحفظ) للتأكد من المقاس والطابعة.</p>

        <div id="desktop-printers" style="display:none">
          <h3 class="form-section-title">طابعات سطح المكتب (نسخة البرنامج المثبّت)</h3>
          <p class="form-note">يكتشف البرنامج الطابعات تلقائيًا. لو الاختيار غلط، صحّحه يدويًا ثم احفظ.</p>
          <label>طابعة الملصقات (Zebra)
            <select name="labelPrinterName"><option value="">— الطابعة الافتراضية —</option></select>
          </label>
          <label>طابعة الإيصال (Fujitsu)
            <select name="receiptPrinterName"><option value="">— الطابعة الافتراضية —</option></select>
          </label>
          <div class="form-actions">
            <button type="button" class="btn btn-ghost" id="autodetect-btn">🔍 اكتشاف الطابعات تلقائيًا</button>
          </div>
        </div>

        <h3 class="form-section-title">إعدادات البيع والمخزون</h3>
        <label class="switch-row">
          <input type="checkbox" name="blockSaleWhenOutOfStock" ${app.blockSaleWhenOutOfStock ? 'checked' : ''} />
          منع البيع عند نفاد المخزون
        </label>
        <label class="switch-row">
          <input type="checkbox" name="lowStockAlert" ${app.lowStockAlert ? 'checked' : ''} />
          تفعيل تنبيهات انخفاض المخزون
        </label>
        <label class="switch-row">
          <input type="checkbox" name="autoBackupOnClose" ${app.autoBackupOnClose ? 'checked' : ''} />
          نسخة احتياطية تلقائية عند إغلاق الوردية
        </label>
        <label>مدة السماح بالمرتجع (أيام)
          <input type="number" name="returnWindowDays" min="0" value="${Number(app.returnWindowDays)}" />
        </label>
        <label>حد الخصم الكبير (يتطلب موافقة المدير، بالجنيه)
          <input type="number" name="largeDiscountThreshold" min="0" step="0.01" value="${Number(
            app.largeDiscountThreshold
          )}" />
        </label>
        <label>قفل الشاشة التلقائي (دقائق، 0 = معطّل)
          <input type="number" name="autoLockMinutes" min="0" value="${Number(app.autoLockMinutes)}" />
        </label>

        <h3 class="form-section-title">المظهر</h3>
        <label>الوضع
          <select name="theme">
            <option value="light" ${ui.theme === 'light' ? 'selected' : ''}>نهاري (Light)</option>
            <option value="dark" ${ui.theme === 'dark' ? 'selected' : ''}>ليلي (Dark)</option>
          </select>
        </label>
        <label>اللون الأساسي
          <input type="color" name="accent" value="${ui.accent}" />
        </label>

        <div class="form-actions">
          <button type="submit" class="btn btn-primary">حفظ الإعدادات</button>
        </div>
      </form>`;

    document.getElementById('settings-form').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target;
      await Settings.setApp({
        storeName: f.storeName.value.trim(),
        currency: f.currency.value.trim(),
        receiptFooter: f.receiptFooter.value.trim(),
        printFormat: f.printFormat.value,
        labelPrinter: f.labelPrinter.value,
        labelPrinterName: f.labelPrinterName ? f.labelPrinterName.value : '',
        receiptPrinterName: f.receiptPrinterName ? f.receiptPrinterName.value : '',
        labelDpi: Number(f.labelDpi.value) || 203,
        labelWidthMm: Number(f.labelWidthMm.value) || 10,
        labelHeightMm: Number(f.labelHeightMm.value) || 40,
        labelRotate: f.labelRotate.value,
        labelFlip: f.labelFlip.checked,
        labelShowName: f.labelShowName.checked,
        labelShowPrice: f.labelShowPrice.checked,
        labelShowStore: f.labelShowStore.checked,
        blockSaleWhenOutOfStock: f.blockSaleWhenOutOfStock.checked,
        lowStockAlert: f.lowStockAlert.checked,
        autoBackupOnClose: f.autoBackupOnClose.checked,
        returnWindowDays: Number(f.returnWindowDays.value) || 0,
        largeDiscountThreshold: Number(f.largeDiscountThreshold.value) || 0,
        autoLockMinutes: Number(f.autoLockMinutes.value) || 0,
      });
      Settings.setUI({ theme: f.theme.value, accent: f.accent.value });
      _appSettings = await Settings.getApp();
      window.__currency = _appSettings.currency;
      const tb = document.getElementById('theme-btn');
      if (tb) tb.textContent = Settings.getUI().theme === 'dark' ? '☀️' : '🌙';
      setupAutoLock();
      Utils.toast('تم حفظ الإعدادات بنجاح', 'success');
    };

    // قيم الملصق/الطباعة الحالية من النموذج (لاختبار ما هو معروض قبل الحفظ)
    const _formLabelSettings = () => {
      const f = document.getElementById('settings-form');
      return {
        storeName: f.storeName.value.trim(),
        currency: f.currency.value.trim(),
        receiptFooter: f.receiptFooter.value.trim(),
        printFormat: f.printFormat.value,
        labelPrinter: f.labelPrinter.value,
        labelPrinterName: f.labelPrinterName ? f.labelPrinterName.value : '',
        receiptPrinterName: f.receiptPrinterName ? f.receiptPrinterName.value : '',
        labelDpi: Number(f.labelDpi.value) || 203,
        labelWidthMm: Number(f.labelWidthMm.value) || 10,
        labelHeightMm: Number(f.labelHeightMm.value) || 40,
        labelRotate: f.labelRotate.value,
        labelFlip: f.labelFlip.checked,
        labelShowName: f.labelShowName.checked,
        labelShowPrice: f.labelShowPrice.checked,
        labelShowStore: f.labelShowStore.checked,
      };
    };

    document.getElementById('test-label-btn').onclick = () => {
      const s = _formLabelSettings();
      Labels.print([{ name: 'منتج تجريبي', price: 123.45, barcode: '200000000013' }], s);
      Utils.toast(
        s.labelPrinter === 'zebra-zpl'
          ? 'تم إرسال ملصق ZPL تجريبي (أو تنزيل ملف labels.zpl)'
          : 'تم فتح نافذة طباعة الملصق التجريبي',
        'success'
      );
    };

    document.getElementById('test-receipt-btn').onclick = () => {
      const s = _formLabelSettings();
      window.__currency = s.currency;
      Receipt.print(
        {
          number: 'TEST-0001',
          createdAt: Date.now(),
          userName: 'اختبار',
          items: [
            { name: 'منتج تجريبي ١', qty: 2, unitPrice: 50, lineTotal: 100 },
            { name: 'منتج تجريبي ٢', qty: 1, unitPrice: 23.45, lineTotal: 23.45 },
          ],
          subtotal: 123.45,
          totalDiscount: 0,
          total: 123.45,
          paymentMethod: 'cash',
          paidAmount: 150,
          change: 26.55,
        },
        s
      );
      Utils.toast('تم فتح نافذة طباعة الإيصال التجريبي', 'success');
    };

    // معاينة مباشرة للملصق — تتحدّث مع كل تغيير، ومطابقة لما سيُطبع
    const updateLabelPreview = () => {
      const f = document.getElementById('settings-form');
      const box = document.getElementById('label-preview');
      if (!f || !box || !window.Labels || !Labels.labelSvg) return;
      const s = {
        currency: f.currency.value.trim(),
        labelWidthMm: Number(f.labelWidthMm.value) || 10,
        labelHeightMm: Number(f.labelHeightMm.value) || 40,
        labelRotate: f.labelRotate.value,
        labelFlip: f.labelFlip.checked,
        labelShowName: f.labelShowName.checked,
        labelShowPrice: f.labelShowPrice.checked,
      };
      try {
        box.innerHTML = Labels.labelSvg(
          { name: 'منتج تجريبي', price: 123.45, barcode: '200000000013' },
          s
        );
      } catch (e) {}
    };
    ['labelWidthMm', 'labelHeightMm', 'labelRotate', 'labelFlip', 'labelShowName', 'labelShowPrice', 'currency'].forEach(
      (n) => {
        const el = document.getElementById('settings-form')[n];
        if (el) {
          el.addEventListener('input', updateLabelPreview);
          el.addEventListener('change', updateLabelPreview);
        }
      }
    );
    updateLabelPreview();

    // نسخة سطح المكتب: أظهر قوائم اختيار الطابعات واملأها + اكتشاف تلقائي
    if (window.desktopPrint && window.desktopPrint.isDesktop) {
      const box = document.getElementById('desktop-printers');
      if (box) box.style.display = '';

      // مطابقة اسم الطابعة بدورها حسب كلمات مميزة
      const matchPrinter = (printers, role) => {
        const re =
          role === 'label'
            ? /zebra|zdesigner|\bzd\d|\bzpl\b|godex|\btsc\b|sato|label|ملصق|barcode/i
            : /fujitsu|\bfp[-\s]?\d|receipt|إيصال|فاتورة|\bpos\b|80mm|58mm|thermal|epson\s*tm|xprinter|x[-\s]?printer|rongta|\btm[-\s]?/i;
        const hit = (printers || []).find((p) => re.test(p.name || '') || re.test(p.displayName || ''));
        return hit ? hit.name : '';
      };

      window.desktopPrint.listPrinters().then((printers) => {
        const f = document.getElementById('settings-form');
        if (!f) return;
        const fill = (sel, current) => {
          if (!sel) return;
          (printers || []).forEach((p) => {
            const opt = document.createElement('option');
            opt.value = p.name;
            opt.textContent = (p.displayName || p.name) + (p.isDefault ? ' (افتراضية)' : '');
            sel.appendChild(opt);
          });
          if (current) sel.value = current;
        };
        // لو لا يوجد اختيار محفوظ، اكتشف تلقائيًا
        const labelGuess = app.labelPrinterName || matchPrinter(printers, 'label');
        const receiptGuess = app.receiptPrinterName || matchPrinter(printers, 'receipt');
        fill(f.labelPrinterName, labelGuess);
        fill(f.receiptPrinterName, receiptGuess);

        // زر الاكتشاف اليدوي
        const btn = document.getElementById('autodetect-btn');
        if (btn)
          btn.onclick = () => {
            const lg = matchPrinter(printers, 'label');
            const rg = matchPrinter(printers, 'receipt');
            if (lg) f.labelPrinterName.value = lg;
            if (rg) f.receiptPrinterName.value = rg;
            Utils.toast(
              'تم الاكتشاف: ملصقات=' + (lg || 'غير معروفة') + ' | إيصال=' + (rg || 'غير معروفة') + ' — اضغط حفظ',
              'info'
            );
          };
      });
    }
  }

  /* ---------- قفل الشاشة ---------- */
  let _lockListenersAttached = false;
  function _resetLockTimer() {
    clearTimeout(_lockTimer);
    const mins = Number(_appSettings && _appSettings.autoLockMinutes) || 0;
    if (!mins) return;
    if (document.getElementById('lock-overlay')) return; // الشاشة مقفلة بالفعل
    _lockTimer = setTimeout(lockScreen, mins * 60 * 1000);
  }
  function setupAutoLock() {
    // تُربط مستمعات النشاط مرة واحدة فقط لتفادي تكرارها.
    if (!_lockListenersAttached) {
      ['click', 'keydown', 'mousemove', 'touchstart'].forEach((ev) =>
        document.addEventListener(ev, _resetLockTimer, { passive: true })
      );
      _lockListenersAttached = true;
    }
    _resetLockTimer();
  }

  function lockScreen() {
    const user = Auth.currentUser();
    if (!user) return;
    if (document.getElementById('lock-overlay')) return;
    const overlay = Utils.el(`
      <div class="lock-overlay" id="lock-overlay">
        <form class="lock-card" id="lock-form">
          <div class="lock-icon">🔒</div>
          <h3>الشاشة مقفلة</h3>
          <p>${Utils.escapeHtml(user.name)}</p>
          <input type="password" name="password" placeholder="كلمة المرور" autocomplete="current-password" required />
          <div class="auth-error" id="lock-error"></div>
          <button type="submit" class="btn btn-primary btn-block">فتح القفل</button>
          <button type="button" class="btn btn-ghost btn-block" id="lock-logout">تسجيل خروج</button>
        </form>
      </div>`);
    document.body.appendChild(overlay);
    overlay.querySelector('#lock-logout').onclick = () => {
      overlay.remove();
      Auth.logout();
      renderLogin();
    };
    overlay.querySelector('#lock-form').onsubmit = async (e) => {
      e.preventDefault();
      const pwd = e.target.password.value;
      const res = await Auth.login(user.username, pwd);
      if (res.ok) {
        overlay.remove();
        setupAutoLock();
      } else {
        overlay.querySelector('#lock-error').textContent = 'كلمة المرور غير صحيحة';
      }
    };
  }

  return { init, navigate, renderNav, PERMISSION_KEYS };
})();
window.App = App;

document.addEventListener('DOMContentLoaded', () => App.init());
