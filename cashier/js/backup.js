/* =====================================================================
 * backup.js  —  النسخ الاحتياطي (المرحلة 11)
 * - Export: JSON كامل (كل الجداول) + Excel (SpreadsheetML متعدّد الأوراق).
 * - Import: JSON (استبدال كامل، مع نسخة أمان تلقائية قبل الاستيراد).
 * - نسخة احتياطية تلقائية عند إغلاق الوردية (hook من المرحلة 8).
 * يعمل بالكامل Offline عبر Blob + رابط تنزيل.
 * ===================================================================== */

const Backup = (() => {
  const EXPORT_VERSION = 1;

  /* ---------- بناء كائن النسخة الكاملة ---------- */
  async function buildBackup() {
    const stores = Object.keys(DB.STORES);
    const data = {};
    for (const s of stores) {
      data[s] = await DB.getAll(s);
    }
    return {
      meta: {
        app: 'Cashier Pro Offline',
        version: EXPORT_VERSION,
        dbVersion: DB.DB_VERSION,
        exportedAt: Date.now(),
        exportedAtText: new Date().toLocaleString('ar-EG'),
      },
      data,
    };
  }

  function _stamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
      d.getMinutes()
    )}${p(d.getSeconds())}`;
  }

  function _download(filename, content, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 1000);
  }

  /* ---------- تصدير JSON ---------- */
  async function exportJSON(prefix = 'backup') {
    const backup = await buildBackup();
    _download(
      `cashier-${prefix}-${_stamp()}.json`,
      JSON.stringify(backup),
      'application/json;charset=utf-8'
    );
    return backup;
  }

  /* ---------- تصدير Excel (SpreadsheetML 2003 متعدّد الأوراق) ---------- */
  function _xmlEsc(v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function _cell(v) {
    const isNum = typeof v === 'number' && isFinite(v);
    if (v == null) v = '';
    if (typeof v === 'object') v = JSON.stringify(v);
    return isNum
      ? `<Cell><Data ss:Type="Number">${v}</Data></Cell>`
      : `<Cell><Data ss:Type="String">${_xmlEsc(v)}</Data></Cell>`;
  }

  function _sheet(name, columns, rows) {
    const header = '<Row>' + columns.map((c) => _cell(c.label)).join('') + '</Row>';
    const body = rows
      .map((r) => '<Row>' + columns.map((c) => _cell(c.get(r))).join('') + '</Row>')
      .join('');
    // اسم الورقة في Excel ≤ 31 حرفًا وبدون رموز معيّنة
    const safeName = _xmlEsc(name).slice(0, 31);
    return `<Worksheet ss:Name="${safeName}"><Table>${header}${body}</Table></Worksheet>`;
  }

  async function exportExcel() {
    const products = await DB.getAll('products');
    const invoices = await DB.getAll('invoices');
    const returns = await DB.getAll('returns');
    const expenses = await DB.getAll('expenses');
    const shifts = await DB.getAll('shifts');

    const sheets = [
      _sheet(
        'المنتجات',
        [
          { label: 'SKU', get: (p) => p.sku },
          { label: 'الباركود', get: (p) => p.barcode },
          { label: 'الاسم', get: (p) => p.name },
          { label: 'التصنيف', get: (p) => p.category },
          { label: 'المورد', get: (p) => p.supplier },
          { label: 'سعر الشراء', get: (p) => Number(p.costPrice) || 0 },
          { label: 'سعر البيع', get: (p) => Number(p.salePrice) || 0 },
          { label: 'الربح', get: (p) => Number(p.profit) || 0 },
          { label: 'المخزون', get: (p) => Number(p.stock) || 0 },
          { label: 'حد التنبيه', get: (p) => Number(p.alertLevel) || 0 },
          { label: 'مؤرشف', get: (p) => (p.archived ? 'نعم' : 'لا') },
        ],
        products
      ),
      _sheet(
        'الفواتير',
        [
          { label: 'رقم الفاتورة', get: (i) => i.number },
          { label: 'التاريخ', get: (i) => new Date(i.createdAt).toLocaleString('ar-EG') },
          { label: 'الإجمالي', get: (i) => Number(i.total) || 0 },
          { label: 'الخصم', get: (i) => Number(i.totalDiscount) || 0 },
          { label: 'الربح', get: (i) => Number(i.profit) || 0 },
          { label: 'طريقة الدفع', get: (i) => i.paymentMethod },
          { label: 'الحالة', get: (i) => i.status },
          { label: 'الكاشير', get: (i) => i.userName },
          { label: 'عدد الأصناف', get: (i) => (i.items ? i.items.length : 0) },
        ],
        invoices
      ),
      _sheet(
        'المرتجعات',
        [
          { label: 'الفاتورة', get: (r) => r.invoiceNumber },
          { label: 'التاريخ', get: (r) => new Date(r.createdAt).toLocaleString('ar-EG') },
          { label: 'النوع', get: (r) => r.type },
          { label: 'الاسترداد', get: (r) => Number(r.total) || 0 },
          { label: 'السبب', get: (r) => r.reason },
          { label: 'المستخدم', get: (r) => r.userName },
        ],
        returns
      ),
      _sheet(
        'المصروفات',
        [
          { label: 'التاريخ', get: (e) => new Date(e.createdAt).toLocaleString('ar-EG') },
          { label: 'النوع', get: (e) => e.type },
          { label: 'المبلغ', get: (e) => Number(e.amount) || 0 },
          { label: 'ملاحظة', get: (e) => e.note },
          { label: 'ملغى', get: (e) => (e.voided ? 'نعم' : 'لا') },
          { label: 'المستخدم', get: (e) => e.userName },
        ],
        expenses
      ),
      _sheet(
        'الورديات',
        [
          { label: 'الفتح', get: (s) => new Date(s.openedAt).toLocaleString('ar-EG') },
          { label: 'الإغلاق', get: (s) => (s.closedAt ? new Date(s.closedAt).toLocaleString('ar-EG') : '') },
          { label: 'المستخدم', get: (s) => s.userName },
          { label: 'رصيد البداية', get: (s) => Number(s.openingBalance) || 0 },
          { label: 'مبيعات النظام', get: (s) => Number(s.systemSales) || 0 },
          { label: 'المتوقع', get: (s) => Number(s.expectedCash) || 0 },
          { label: 'الفعلي', get: (s) => Number(s.countedCash) || 0 },
          { label: 'الفرق', get: (s) => Number(s.difference) || 0 },
        ],
        shifts
      ),
    ].join('');

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
${sheets}
</Workbook>`;
    _download(`cashier-export-${_stamp()}.xls`, xml, 'application/vnd.ms-excel;charset=utf-8');
  }

  /* ---------- استيراد JSON ---------- */
  function _readFile(file) {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsText(file);
    });
  }

  async function importJSON(file) {
    const text = await _readFile(file);
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new Error('الملف ليس JSON صالحًا');
    }
    if (!parsed || !parsed.data || typeof parsed.data !== 'object') {
      throw new Error('الملف ليس نسخة احتياطية صحيحة لنظام الكاشير');
    }
    const knownStores = Object.keys(DB.STORES);
    const incoming = Object.keys(parsed.data).filter((k) => knownStores.includes(k));
    if (!incoming.length) throw new Error('لا توجد بيانات معروفة في الملف');

    // نسخة أمان تلقائية قبل الاستبدال
    await exportJSON('pre-import');

    // استبدال كل جدول وارد
    for (const s of incoming) {
      await DB.replaceStore(s, Array.isArray(parsed.data[s]) ? parsed.data[s] : []);
    }
    return { stores: incoming, count: incoming.length };
  }

  /* ---------- نسخة تلقائية عند إغلاق الوردية ---------- */
  async function autoBackupOnShiftClose(shift) {
    const settings = await Settings.getApp();
    if (!settings.autoBackupOnClose) return;
    await exportJSON('shiftclose');
  }

  /* ===================================================================
   * الواجهة
   * =================================================================== */
  function render(content) {
    if (!Auth.isManager()) {
      content.innerHTML =
        '<div class="placeholder"><div class="placeholder-icon">🔒</div><p>النسخ الاحتياطي للمدير فقط.</p></div>';
      return;
    }
    content.innerHTML = `
      <div class="backup-grid">
        <div class="card">
          <h3>📤 تصدير نسخة كاملة (JSON)</h3>
          <p class="form-note">نسخة كاملة من كل البيانات. احتفظ بها في مكان آمن. هذه هي النسخة المعتمدة للاستعادة.</p>
          <button class="btn btn-primary" id="bk-json">تنزيل JSON</button>
        </div>
        <div class="card">
          <h3>📊 تصدير Excel</h3>
          <p class="form-note">ملف Excel متعدّد الأوراق (منتجات، فواتير، مرتجعات، مصروفات، ورديات) للمراجعة والطباعة.</p>
          <button class="btn btn-primary" id="bk-xls">تنزيل Excel</button>
        </div>
        <div class="card">
          <h3>📥 استيراد نسخة (JSON)</h3>
          <p class="form-note danger-note">⚠️ سيستبدل البيانات الحالية بالكامل. تُؤخذ نسخة أمان تلقائية قبل الاستيراد.</p>
          <input type="file" id="bk-file" accept="application/json,.json" />
          <button class="btn btn-danger" id="bk-import" style="margin-top:10px">استيراد واستبدال</button>
        </div>
        <div class="card">
          <h3>ℹ️ النسخة التلقائية</h3>
          <p class="form-note">يتم تنزيل نسخة JSON تلقائيًا عند إغلاق كل وردية (يمكن تعطيلها من الإعدادات).</p>
        </div>
      </div>`;

    content.querySelector('#bk-json').onclick = async () => {
      await exportJSON();
      Utils.toast('تم تنزيل النسخة الكاملة', 'success');
    };
    content.querySelector('#bk-xls').onclick = async () => {
      await exportExcel();
      Utils.toast('تم تنزيل ملف Excel', 'success');
    };
    content.querySelector('#bk-import').onclick = async () => {
      const fileInput = content.querySelector('#bk-file');
      const file = fileInput.files && fileInput.files[0];
      if (!file) {
        Utils.toast('اختر ملف JSON أولًا', 'error');
        return;
      }
      const appr = await Utils.requireManagerApproval('استيراد واستبدال كل بيانات النظام');
      if (!appr.ok) {
        Utils.toast('تتطلب هذه العملية موافقة المدير', 'error');
        return;
      }
      const ok = await Utils.confirmBox(
        'سيتم استبدال كل البيانات الحالية بمحتوى الملف. (سيتم تنزيل نسخة أمان أولًا). متابعة؟'
      );
      if (!ok) return;
      try {
        const res = await importJSON(file);
        await Audit.log('backup.import', 'system', null, null, { stores: res.stores });
        Utils.toast('تم الاستيراد بنجاح — سيُعاد تحميل النظام', 'success');
        // تسجيل خروج لأن بيانات المستخدمين قد تكون استُبدلت
        Auth.logout();
        setTimeout(() => location.reload(), 1200);
      } catch (err) {
        Utils.toast('فشل الاستيراد: ' + err.message, 'error');
      }
    };
  }

  return {
    render,
    buildBackup,
    exportJSON,
    exportExcel,
    importJSON,
    autoBackupOnShiftClose,
  };
})();

window.Backup = Backup;
