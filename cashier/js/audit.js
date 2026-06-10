/* =====================================================================
 * audit.js  —  سجل العمليات (Audit Log)
 * يُسجّل العمليات الحساسة: المستخدم، العملية، الكيان، البيانات القديمة/الجديدة،
 * والتاريخ والوقت. لا يُحذف السجل نهائيًا (إضافة فقط).
 * عارض السجل الكامل يُبنى في المرحلة 10.
 * ===================================================================== */

const Audit = (() => {
  /* تسجيل عملية في السجل */
  async function log(action, entity, entityId, oldData, newData) {
    const user = (window.Auth && Auth.currentUser && Auth.currentUser()) || null;
    const entry = {
      userId: user ? user.id : null,
      userName: user ? user.name : 'النظام',
      action: action, // مثال: product.add / product.edit / sale.create
      entity: entity, // product / invoice / ...
      entityId: entityId != null ? entityId : null,
      oldData: oldData != null ? oldData : null,
      newData: newData != null ? newData : null,
      createdAt: Date.now(),
    };
    try {
      await DB.add('audit_log', entry);
    } catch (e) {
      // لا نوقف العملية الأساسية بسبب فشل التسجيل، لكن ننبّه في الكونسول.
      console.error('Audit log failed:', e, entry);
    }
    return entry;
  }

  return { log };
})();

window.Audit = Audit;

/* =====================================================================
 * AuditView  —  عارض سجل العمليات (المرحلة 10)
 * عرض للقراءة فقط مع فلاتر. لا يمكن حذف أو تعديل أي سجل.
 * ===================================================================== */
const AuditView = (() => {
  /* تسميات عربية للعمليات */
  const ACTION_LABELS = {
    'product.add': 'إضافة منتج',
    'product.edit': 'تعديل منتج',
    'product.archive': 'أرشفة منتج',
    'product.restore': 'استرجاع منتج',
    'inventory.purchase': 'إضافة مخزون',
    'inventory.adjust': 'تعديل/جرد مخزون',
    'inventory.return': 'إرجاع مخزون',
    'sale.create': 'بيع',
    'return.create': 'مرتجع',
    'invoice.cancel': 'إلغاء فاتورة',
    'user.create': 'إضافة موظف',
    'user.update': 'تعديل موظف',
    'user.activate': 'تفعيل موظف',
    'user.deactivate': 'إيقاف موظف',
    'expense.add': 'إضافة مصروف',
    'expense.update': 'تعديل مصروف',
    'expense.void': 'إلغاء مصروف',
    'shift.open': 'فتح وردية',
    'shift.close': 'إغلاق وردية',
  };
  const ENTITY_LABELS = {
    product: 'منتج',
    invoice: 'فاتورة',
    user: 'موظف',
    expense: 'مصروف',
    shift: 'وردية',
  };
  function actionLabel(a) {
    return ACTION_LABELS[a] || a;
  }
  function entityLabel(e) {
    return ENTITY_LABELS[e] || e || '-';
  }

  let _filters = { action: '', entity: '', userId: '', from: '', to: '' };

  async function render(content) {
    if (!Auth.isManager()) {
      content.innerHTML =
        '<div class="placeholder"><div class="placeholder-icon">🔒</div><p>سجل العمليات للمدير فقط.</p></div>';
      return;
    }
    const users = await DB.getAll('users');

    content.innerHTML = `
      <div class="toolbar">
        <select id="aud-action" class="filter-select">
          <option value="">كل العمليات</option>
          ${Object.keys(ACTION_LABELS)
            .map(
              (k) =>
                `<option value="${k}" ${_filters.action === k ? 'selected' : ''}>${ACTION_LABELS[k]}</option>`
            )
            .join('')}
        </select>
        <select id="aud-entity" class="filter-select">
          <option value="">كل الكيانات</option>
          ${Object.keys(ENTITY_LABELS)
            .map(
              (k) =>
                `<option value="${k}" ${_filters.entity === k ? 'selected' : ''}>${ENTITY_LABELS[k]}</option>`
            )
            .join('')}
        </select>
        <select id="aud-user" class="filter-select">
          <option value="">كل المستخدمين</option>
          ${users
            .map(
              (u) =>
                `<option value="${u.id}" ${String(_filters.userId) === String(u.id) ? 'selected' : ''}>${Utils.escapeHtml(
                  u.name
                )}</option>`
            )
            .join('')}
        </select>
        <input type="date" id="aud-from" class="filter-select" value="${_filters.from}" />
        <input type="date" id="aud-to" class="filter-select" value="${_filters.to}" />
        <button class="btn btn-primary" id="aud-apply">عرض</button>
      </div>
      <p class="form-note">🔒 سجل للقراءة فقط — لا يمكن حذف أو تعديل أي عملية.</p>
      <div id="aud-table"></div>`;

    const apply = () => {
      _filters.action = content.querySelector('#aud-action').value;
      _filters.entity = content.querySelector('#aud-entity').value;
      _filters.userId = content.querySelector('#aud-user').value;
      _filters.from = content.querySelector('#aud-from').value;
      _filters.to = content.querySelector('#aud-to').value;
      _draw(content);
    };
    content.querySelector('#aud-apply').onclick = apply;
    _draw(content);
  }

  async function _draw(content) {
    const wrap = content.querySelector('#aud-table');
    wrap.innerHTML = '<div class="loading">جارٍ التحميل…</div>';

    const from = _filters.from ? new Date(_filters.from + 'T00:00:00').getTime() : null;
    const to = _filters.to ? new Date(_filters.to + 'T23:59:59.999').getTime() : null;
    const LIMIT = 1000;
    const out = [];
    await DB.iterate(
      'audit_log',
      (e) => {
        if (_filters.action && e.action !== _filters.action) return;
        if (_filters.entity && e.entity !== _filters.entity) return;
        if (_filters.userId && String(e.userId) !== String(_filters.userId)) return;
        if (from && e.createdAt < from) return;
        if (to && e.createdAt > to) return;
        out.push(e);
        if (out.length >= LIMIT) return false;
      },
      { index: 'createdAt', direction: 'prev' }
    );

    if (!out.length) {
      wrap.innerHTML = '<div class="placeholder"><div class="placeholder-icon">🧾</div><p>لا توجد عمليات مطابقة.</p></div>';
      return;
    }

    // نخزّن السجلات للوصول إليها عند عرض التفاصيل
    _cache = out;
    wrap.innerHTML = `
      <div class="table-meta">عدد العمليات: ${out.length.toLocaleString('ar-EG')}${
      out.length >= LIMIT ? ' (أحدث 1000)' : ''
    }</div>
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>التاريخ والوقت</th><th>المستخدم</th><th>العملية</th><th>الكيان</th><th>المعرّف</th><th>التفاصيل</th></tr></thead>
        <tbody>${out
          .map(
            (e, i) => `<tr>
            <td>${Utils.fmtDateTime(e.createdAt)}</td>
            <td>${Utils.escapeHtml(e.userName || '-')}</td>
            <td>${Utils.escapeHtml(actionLabel(e.action))}</td>
            <td>${Utils.escapeHtml(entityLabel(e.entity))}</td>
            <td>${e.entityId != null ? '#' + e.entityId : '-'}</td>
            <td><button class="btn btn-sm btn-ghost" data-detail="${i}">عرض</button></td>
          </tr>`
          )
          .join('')}</tbody>
      </table></div>`;

    wrap.querySelectorAll('[data-detail]').forEach((b) => {
      b.onclick = () => _showDetail(_cache[+b.dataset.detail]);
    });
  }

  let _cache = [];

  function _fmtJson(obj) {
    if (obj == null) return '<em class="form-note">— لا يوجد —</em>';
    return '<pre class="json-view">' + Utils.escapeHtml(JSON.stringify(obj, null, 2)) + '</pre>';
  }

  function _showDetail(e) {
    Utils.modal({
      title: actionLabel(e.action) + ' — ' + Utils.fmtDateTime(e.createdAt),
      bodyHtml: `
        <div class="aud-detail">
          <div><strong>المستخدم:</strong> ${Utils.escapeHtml(e.userName || '-')}</div>
          <div><strong>الكيان:</strong> ${Utils.escapeHtml(entityLabel(e.entity))} ${
        e.entityId != null ? '#' + e.entityId : ''
      }</div>
          <h4>البيانات القديمة</h4>
          ${_fmtJson(e.oldData)}
          <h4>البيانات الجديدة</h4>
          ${_fmtJson(e.newData)}
        </div>`,
      confirmText: 'إغلاق',
      cancelText: '',
    });
  }

  return { render, actionLabel, entityLabel };
})();

window.AuditView = AuditView;
