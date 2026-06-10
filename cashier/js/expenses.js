/* =====================================================================
 * expenses.js  —  المصروفات (المرحلة 7)
 * أنواع: إيجار / رواتب / شحن / شراء / أخرى.
 * تُخصم من صافي الربح (تستخدمها التقارير في المرحلة 9).
 * تكامل مع الدرج النقدي: المصروف المدفوع من الدرج يسجّل حركة نقدية سالبة
 * حتى تكون تسوية الوردية (المرحلة 8) دقيقة.
 * لا حذف فعلي — إلغاء (void) فقط مع تسجيل في Audit Log.
 * ===================================================================== */

const Expenses = (() => {
  const TYPES = [
    { key: 'rent', label: 'إيجار' },
    { key: 'salaries', label: 'رواتب' },
    { key: 'shipping', label: 'شحن' },
    { key: 'purchase', label: 'شراء' },
    { key: 'other', label: 'أخرى' },
  ];
  let _filters = { type: '', from: '', to: '' };

  function typeLabel(k) {
    const t = TYPES.find((x) => x.key === k);
    return t ? t.label : k;
  }

  async function _shiftId() {
    return window.Shifts && Shifts.getOpenShiftId ? await Shifts.getOpenShiftId() : null;
  }

  async function _postCash(amount, note, shiftId, userId) {
    if (!amount) return;
    await DB.add('cash_movements', {
      shiftId,
      type: 'expense',
      amount, // سالب = خروج من الدرج، موجب = تصحيح/عكس
      refType: 'expense',
      refId: null,
      note: note || 'مصروف',
      userId: userId || null,
      createdAt: Date.now(),
    });
  }

  /* ---------- العمليات ---------- */
  async function addExpense(data) {
    const amount = Math.round((Number(data.amount) || 0) * 100) / 100;
    if (amount <= 0) throw new Error('أدخل مبلغًا صحيحًا');
    const type = TYPES.some((t) => t.key === data.type) ? data.type : 'other';
    const user = Auth.currentUser();
    const shiftId = await _shiftId();
    const paidFromDrawer = !!data.paidFromDrawer;

    const exp = {
      type,
      amount,
      note: String(data.note || '').trim(),
      paidFromDrawer,
      date: data.date || new Date().toISOString().slice(0, 10),
      shiftId,
      userId: user ? user.id : null,
      userName: user ? user.name : '',
      voided: 0,
      createdAt: Date.now(),
    };
    const id = await DB.add('expenses', exp);
    exp.id = id;
    if (paidFromDrawer) await _postCash(-amount, 'مصروف: ' + typeLabel(type), shiftId, exp.userId);
    await Audit.log('expense.add', 'expense', id, null, exp);
    return exp;
  }

  async function updateExpense(id, data) {
    const old = await DB.get('expenses', id);
    if (!old) throw new Error('المصروف غير موجود');
    if (old.voided) throw new Error('لا يمكن تعديل مصروف ملغى');

    const amount = Math.round((Number(data.amount) || 0) * 100) / 100;
    if (amount <= 0) throw new Error('أدخل مبلغًا صحيحًا');
    const type = TYPES.some((t) => t.key === data.type) ? data.type : 'other';
    const paidFromDrawer = !!data.paidFromDrawer;

    const next = Object.assign({}, old, {
      type,
      amount,
      note: String(data.note || '').trim(),
      paidFromDrawer,
      date: data.date || old.date,
      updatedAt: Date.now(),
    });

    // تعديل الأثر النقدي على الدرج بقيد تصحيحي واحد
    const oldEffect = old.paidFromDrawer ? -old.amount : 0;
    const newEffect = paidFromDrawer ? -amount : 0;
    const delta = Math.round((newEffect - oldEffect) * 100) / 100;

    await DB.put('expenses', next);
    if (delta) await _postCash(delta, 'تعديل مصروف: ' + typeLabel(type), next.shiftId, next.userId);
    await Audit.log('expense.update', 'expense', id, old, next);
    return next;
  }

  async function voidExpense(id) {
    const old = await DB.get('expenses', id);
    if (!old) throw new Error('المصروف غير موجود');
    if (old.voided) return old;
    old.voided = 1;
    old.updatedAt = Date.now();
    await DB.put('expenses', old);
    // عكس الأثر النقدي إن كان مدفوعًا من الدرج
    if (old.paidFromDrawer)
      await _postCash(old.amount, 'إلغاء مصروف: ' + typeLabel(old.type), old.shiftId, old.userId);
    await Audit.log('expense.void', 'expense', id, old, { voided: 1 });
    return old;
  }

  /* ---------- استعلامات للتقارير ---------- */
  async function listBetween(from, to) {
    const all = await DB.getAll('expenses');
    return all.filter((e) => {
      if (e.voided) return false;
      if (from && e.createdAt < from) return false;
      if (to && e.createdAt > to) return false;
      return true;
    });
  }

  async function totalBetween(from, to) {
    const list = await listBetween(from, to);
    return Math.round(list.reduce((s, e) => s + e.amount, 0) * 100) / 100;
  }

  async function byTypeBetween(from, to) {
    const list = await listBetween(from, to);
    const out = {};
    TYPES.forEach((t) => (out[t.key] = 0));
    list.forEach((e) => (out[e.type] = (out[e.type] || 0) + e.amount));
    return out;
  }

  /* ===================================================================
   * الواجهة
   * =================================================================== */
  async function render(content) {
    content.innerHTML = `
      <div class="toolbar">
        <select id="exp-type" class="filter-select">
          <option value="">كل الأنواع</option>
          ${TYPES.map(
            (t) => `<option value="${t.key}" ${_filters.type === t.key ? 'selected' : ''}>${t.label}</option>`
          ).join('')}
        </select>
        <input type="date" id="exp-from" class="filter-select" value="${_filters.from}" title="من" />
        <input type="date" id="exp-to" class="filter-select" value="${_filters.to}" title="إلى" />
        <button class="btn btn-ghost" id="exp-apply">عرض</button>
        <button class="btn btn-primary" id="exp-add" style="margin-inline-start:auto">+ إضافة مصروف</button>
      </div>
      <div id="exp-summary"></div>
      <div id="exp-table"></div>`;

    content.querySelector('#exp-add').onclick = () => _openForm(null, content);
    content.querySelector('#exp-apply').onclick = () => {
      _filters.type = content.querySelector('#exp-type').value;
      _filters.from = content.querySelector('#exp-from').value;
      _filters.to = content.querySelector('#exp-to').value;
      _draw(content);
    };
    _draw(content);
  }

  async function _draw(content) {
    const tableWrap = content.querySelector('#exp-table');
    const sumWrap = content.querySelector('#exp-summary');
    tableWrap.innerHTML = '<div class="loading">جارٍ التحميل…</div>';

    const from = _filters.from ? new Date(_filters.from + 'T00:00:00').getTime() : null;
    const to = _filters.to ? new Date(_filters.to + 'T23:59:59').getTime() : null;
    let list = await listBetween(from, to);
    if (_filters.type) list = list.filter((e) => e.type === _filters.type);
    list.sort((a, b) => b.createdAt - a.createdAt);

    // ملخص
    const byType = {};
    TYPES.forEach((t) => (byType[t.key] = 0));
    let total = 0;
    list.forEach((e) => {
      byType[e.type] = (byType[e.type] || 0) + e.amount;
      total += e.amount;
    });
    sumWrap.innerHTML = `
      <div class="cards">
        <div class="card card-amber"><div class="card-icon">💸</div>
          <div class="card-value">${Utils.money(total)}</div><div class="card-label">إجمالي المصروفات</div></div>
        ${TYPES.map(
          (t) => `<div class="card"><div class="card-label">${t.label}</div>
            <div class="card-value" style="font-size:1.3rem">${Utils.money(byType[t.key] || 0)}</div></div>`
        ).join('')}
      </div>`;

    if (!list.length) {
      tableWrap.innerHTML = '<div class="placeholder"><div class="placeholder-icon">💸</div><p>لا توجد مصروفات في هذه الفترة.</p></div>';
      return;
    }
    tableWrap.innerHTML = `
      <div class="table-meta">عدد المصروفات: ${list.length.toLocaleString('ar-EG')}</div>
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>التاريخ</th><th>النوع</th><th>المبلغ</th><th>من الدرج؟</th><th>ملاحظة</th><th>المستخدم</th><th>إجراءات</th></tr></thead>
        <tbody>${list
          .map(
            (e) => `<tr>
            <td>${Utils.fmtDateTime(e.createdAt)}</td>
            <td>${typeLabel(e.type)}</td>
            <td>${Utils.money(e.amount)}</td>
            <td>${e.paidFromDrawer ? 'نعم' : 'لا'}</td>
            <td>${Utils.escapeHtml(e.note || '-')}</td>
            <td>${Utils.escapeHtml(e.userName || '-')}</td>
            <td class="actions-cell">
              <button class="btn btn-sm btn-ghost" data-edit="${e.id}">تعديل</button>
              <button class="btn btn-sm btn-ghost" data-void="${e.id}">إلغاء</button>
            </td></tr>`
          )
          .join('')}</tbody>
      </table></div>`;

    tableWrap.querySelectorAll('[data-edit]').forEach((b) => {
      b.onclick = async () => {
        const e = await DB.get('expenses', +b.dataset.edit);
        _openForm(e, content);
      };
    });
    tableWrap.querySelectorAll('[data-void]').forEach((b) => {
      b.onclick = async () => {
        if (!(await Utils.confirmBox('إلغاء هذا المصروف؟ (يُعكَس أثره النقدي)'))) return;
        try {
          await voidExpense(+b.dataset.void);
          Utils.toast('تم الإلغاء', 'success');
          _draw(content);
        } catch (err) {
          Utils.toast(err.message, 'error');
        }
      };
    });
  }

  function _openForm(exp, content) {
    const isEdit = !!exp;
    const e = exp || {};
    const overlay = Utils.el(`
      <div class="modal-overlay"><div class="modal">
        <div class="modal-header">${isEdit ? 'تعديل مصروف' : 'إضافة مصروف'}</div>
        <form class="modal-body" id="exp-form">
          <label class="field">النوع
            <select name="type">${TYPES.map(
              (t) => `<option value="${t.key}" ${e.type === t.key ? 'selected' : ''}>${t.label}</option>`
            ).join('')}</select>
          </label>
          <label class="field">المبلغ (${window.__currency || 'ج.م'}) *
            <input type="number" name="amount" min="0" step="0.01" required value="${
              e.amount != null ? e.amount : ''
            }" />
          </label>
          <label class="field">التاريخ
            <input type="date" name="date" value="${e.date || new Date().toISOString().slice(0, 10)}" />
          </label>
          <label class="chk-inline">
            <input type="checkbox" name="paidFromDrawer" ${
              e.paidFromDrawer || !isEdit ? 'checked' : ''
            } /> مدفوع من درج الكاش (يؤثر على تسوية الوردية)
          </label>
          <label class="field">ملاحظة
            <input type="text" name="note" value="${Utils.escapeHtml(e.note || '')}" />
          </label>
          <div class="form-error" id="exp-err"></div>
        </form>
        <div class="modal-footer">
          <button class="btn btn-ghost" data-act="cancel">إلغاء</button>
          <button class="btn btn-primary" data-act="save">${isEdit ? 'حفظ' : 'إضافة'}</button>
        </div>
      </div></div>`);
    document.body.appendChild(overlay);
    const form = overlay.querySelector('#exp-form');
    const close = () => overlay.remove();
    overlay.querySelector('[data-act="cancel"]').onclick = close;
    overlay.addEventListener('click', (ev) => ev.target === overlay && close());
    overlay.querySelector('[data-act="save"]').onclick = async () => {
      if (!form.reportValidity()) return;
      const data = {
        type: form.type.value,
        amount: form.amount.value,
        date: form.date.value,
        paidFromDrawer: form.paidFromDrawer.checked,
        note: form.note.value,
      };
      try {
        if (isEdit) await updateExpense(exp.id, data);
        else await addExpense(data);
        Utils.toast('تم الحفظ', 'success');
        close();
        _draw(content);
      } catch (err) {
        overlay.querySelector('#exp-err').textContent = err.message;
      }
    };
    setTimeout(() => form.amount.focus(), 50);
  }

  return {
    render,
    addExpense,
    updateExpense,
    voidExpense,
    listBetween,
    totalBetween,
    byTypeBetween,
    typeLabel,
    TYPES,
  };
})();

window.Expenses = Expenses;
