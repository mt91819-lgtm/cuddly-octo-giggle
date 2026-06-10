/* =====================================================================
 * shifts.js  —  الورديات (المرحلة 8)
 * - فتح وردية برصيد بداية.
 * - إغلاق وردية: مبيعات النظام / النقد المتوقع / النقد الفعلي / الفرق.
 * - تنبيه عند وجود فرق.
 * - تربط cash_movements و shiftId المسجّلين في البيع/المرتجعات/المصروفات.
 *
 * النقد المتوقع في الدرج = رصيد البداية + مجموع الحركات النقدية للوردية
 *   (بيع كاش موجب، مرتجع كاش سالب، مصروف من الدرج سالب).
 * ===================================================================== */

const Shifts = (() => {
  let _tab = 'current';

  /* معرّف الوردية المفتوحة للمستخدم الحالي (يستخدمه البيع/المرتجع/المصروف) */
  async function getOpenShiftId() {
    const user = Auth.currentUser();
    if (!user) return null;
    const open = await DB.getByIndex('shifts', 'status', 'open');
    const mine = open.find((s) => s.userId === user.id);
    return mine ? mine.id : null;
  }

  async function getOpenShift() {
    const id = await getOpenShiftId();
    return id ? DB.get('shifts', id) : null;
  }

  /* ---------- ملخص حسابات وردية ---------- */
  async function summary(shift) {
    const invoices = await DB.getByIndex('invoices', 'shiftId', shift.id);
    const byMethod = { cash: 0, instapay: 0, wallet: 0 };
    let salesTotal = 0;
    invoices.forEach((inv) => {
      salesTotal += Number(inv.total) || 0;
      byMethod[inv.paymentMethod] = (byMethod[inv.paymentMethod] || 0) + (Number(inv.total) || 0);
    });

    const allReturns = await DB.getAll('returns');
    const shiftReturns = allReturns.filter((r) => r.shiftId === shift.id);
    const refundTotal = shiftReturns.reduce((s, r) => s + (Number(r.total) || 0), 0);

    const allExpenses = await DB.getAll('expenses');
    const shiftExpenses = allExpenses.filter((e) => !e.voided && e.shiftId === shift.id);
    const expensesTotal = shiftExpenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);

    const cashMoves = await DB.getByIndex('cash_movements', 'shiftId', shift.id);
    const cashNet = cashMoves.reduce((s, m) => s + (Number(m.amount) || 0), 0);
    const expectedCash = Math.round(((Number(shift.openingBalance) || 0) + cashNet) * 100) / 100;

    return {
      salesCount: invoices.length,
      salesTotal: Math.round(salesTotal * 100) / 100,
      byMethod,
      refundTotal: Math.round(refundTotal * 100) / 100,
      expensesTotal: Math.round(expensesTotal * 100) / 100,
      cashNet: Math.round(cashNet * 100) / 100,
      expectedCash,
    };
  }

  /* ---------- فتح / إغلاق ---------- */
  async function openShift(openingBalance) {
    if (await getOpenShiftId()) throw new Error('لديك وردية مفتوحة بالفعل');
    const user = Auth.currentUser();
    const shift = {
      userId: user ? user.id : null,
      userName: user ? user.name : '',
      openingBalance: Math.round((Number(openingBalance) || 0) * 100) / 100,
      status: 'open',
      openedAt: Date.now(),
      closedAt: null,
    };
    const id = await DB.add('shifts', shift);
    shift.id = id;
    await Audit.log('shift.open', 'shift', id, null, shift);
    return shift;
  }

  async function closeShift(shiftId, countedCash, note) {
    const shift = await DB.get('shifts', shiftId);
    if (!shift || shift.status !== 'open') throw new Error('الوردية غير مفتوحة');
    const sum = await summary(shift);
    const counted = Math.round((Number(countedCash) || 0) * 100) / 100;

    Object.assign(shift, {
      status: 'closed',
      closedAt: Date.now(),
      systemSales: sum.salesTotal,
      salesByMethod: sum.byMethod,
      refunds: sum.refundTotal,
      expenses: sum.expensesTotal,
      expectedCash: sum.expectedCash,
      countedCash: counted,
      difference: Math.round((counted - sum.expectedCash) * 100) / 100,
      note: String(note || '').trim(),
    });
    await DB.put('shifts', shift);
    await Audit.log(
      'shift.close',
      'shift',
      shiftId,
      { status: 'open' },
      {
        expectedCash: shift.expectedCash,
        countedCash: shift.countedCash,
        difference: shift.difference,
      }
    );

    // نسخة احتياطية عند إغلاق الوردية (تُفعَّل في المرحلة 11)
    if (window.Backup && typeof Backup.autoBackupOnShiftClose === 'function') {
      try {
        await Backup.autoBackupOnShiftClose(shift);
      } catch (e) {
        console.error('Auto backup failed', e);
      }
    }
    return shift;
  }

  /* ===================================================================
   * الواجهة
   * =================================================================== */
  function render(content) {
    content.innerHTML = `
      <div class="tabs">
        <button class="tab ${_tab === 'current' ? 'active' : ''}" data-tab="current">الوردية الحالية</button>
        <button class="tab ${_tab === 'history' ? 'active' : ''}" data-tab="history">سجل الورديات</button>
      </div>
      <div id="shift-body"></div>`;
    content.querySelectorAll('.tab').forEach((b) => {
      b.onclick = () => {
        _tab = b.dataset.tab;
        render(content);
      };
    });
    const body = content.querySelector('#shift-body');
    if (_tab === 'current') _renderCurrent(body);
    else _renderHistory(body);
  }

  async function _renderCurrent(body) {
    body.innerHTML = '<div class="loading">جارٍ التحميل…</div>';
    const shift = await getOpenShift();

    if (!shift) {
      body.innerHTML = `
        <div class="card" style="max-width:420px">
          <h3>فتح وردية جديدة</h3>
          <p class="form-note">أدخل رصيد بداية الدرج النقدي.</p>
          <label class="field">رصيد البداية (${window.__currency || 'ج.م'})
            <input type="number" id="open-bal" min="0" step="0.01" value="0" />
          </label>
          <button class="btn btn-primary" id="open-btn">فتح الوردية</button>
        </div>`;
      body.querySelector('#open-btn').onclick = async () => {
        try {
          await openShift(body.querySelector('#open-bal').value);
          Utils.toast('تم فتح الوردية', 'success');
          _renderCurrent(body);
        } catch (err) {
          Utils.toast(err.message, 'error');
        }
      };
      return;
    }

    const s = await summary(shift);
    body.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="ret-head">
          <div><strong>وردية مفتوحة</strong> <span class="tag tag-ok">نشطة</span><br>
            <span class="form-note">فتحت: ${Utils.fmtDateTime(shift.openedAt)} · ${Utils.escapeHtml(
      shift.userName
    )} · رصيد البداية: ${Utils.money(shift.openingBalance)}</span></div>
          <button class="btn btn-danger" id="close-btn">إغلاق الوردية</button>
        </div>
      </div>
      <div class="cards">
        <div class="card card-green"><div class="card-icon">🧾</div>
          <div class="card-value">${Utils.money(s.salesTotal)}</div>
          <div class="card-label">مبيعات النظام (${s.salesCount.toLocaleString('ar-EG')} فاتورة)</div></div>
        <div class="card card-blue"><div class="card-icon">💵</div>
          <div class="card-value">${Utils.money(s.byMethod.cash)}</div><div class="card-label">مبيعات كاش</div></div>
        <div class="card"><div class="card-label">Instapay</div>
          <div class="card-value" style="font-size:1.3rem">${Utils.money(s.byMethod.instapay)}</div></div>
        <div class="card"><div class="card-label">Wallet</div>
          <div class="card-value" style="font-size:1.3rem">${Utils.money(s.byMethod.wallet)}</div></div>
        <div class="card card-amber"><div class="card-icon">↩️</div>
          <div class="card-value">${Utils.money(s.refundTotal)}</div><div class="card-label">مرتجعات</div></div>
        <div class="card card-amber"><div class="card-icon">💸</div>
          <div class="card-value">${Utils.money(s.expensesTotal)}</div><div class="card-label">مصروفات من الدرج</div></div>
        <div class="card card-purple"><div class="card-icon">🧮</div>
          <div class="card-value">${Utils.money(s.expectedCash)}</div><div class="card-label">النقد المتوقع بالدرج</div></div>
      </div>`;

    body.querySelector('#close-btn').onclick = () => _openCloseForm(shift, s, body);
  }

  function _openCloseForm(shift, s, body) {
    const overlay = Utils.el(`
      <div class="modal-overlay"><div class="modal">
        <div class="modal-header">إغلاق الوردية</div>
        <form class="modal-body" id="close-form">
          <div class="sum-row"><span>رصيد البداية</span><span>${Utils.money(shift.openingBalance)}</span></div>
          <div class="sum-row"><span>صافي الحركة النقدية</span><span>${Utils.money(s.cashNet)}</span></div>
          <div class="sum-row sum-total"><span>النقد المتوقع</span><span>${Utils.money(
            s.expectedCash
          )}</span></div>
          <label class="field">النقد الفعلي في الدرج (${window.__currency || 'ج.م'}) *
            <input type="number" name="counted" min="0" step="0.01" required value="${s.expectedCash}" />
          </label>
          <div class="sum-row sum-total" id="diff-row"><span>الفرق</span><span id="diff-val">${Utils.money(
            0
          )}</span></div>
          <div id="diff-alert"></div>
          <label class="field">ملاحظة (اختياري)
            <input type="text" name="note" placeholder="سبب الفرق إن وجد…" />
          </label>
          <div class="form-error" id="close-err"></div>
        </form>
        <div class="modal-footer">
          <button class="btn btn-ghost" data-act="cancel">إلغاء</button>
          <button class="btn btn-primary" data-act="ok">تأكيد الإغلاق</button>
        </div>
      </div></div>`);
    document.body.appendChild(overlay);
    const form = overlay.querySelector('#close-form');
    const diffVal = overlay.querySelector('#diff-val');
    const diffAlert = overlay.querySelector('#diff-alert');
    const recompute = () => {
      const counted = Number(form.counted.value) || 0;
      const diff = Math.round((counted - s.expectedCash) * 100) / 100;
      diffVal.textContent = Utils.money(diff);
      if (diff === 0) {
        diffAlert.innerHTML = '<div class="alert alert-ok">مطابق ✅</div>';
      } else if (diff < 0) {
        diffAlert.innerHTML =
          '<div class="alert alert-danger">⚠️ عجز في الدرج بمقدار ' + Utils.money(-diff) + '</div>';
      } else {
        diffAlert.innerHTML =
          '<div class="alert alert-warn">⚠️ زيادة في الدرج بمقدار ' + Utils.money(diff) + '</div>';
      }
    };
    form.counted.oninput = recompute;
    recompute();

    const close = () => overlay.remove();
    overlay.querySelector('[data-act="cancel"]').onclick = close;
    overlay.addEventListener('click', (e) => e.target === overlay && close());
    overlay.querySelector('[data-act="ok"]').onclick = async () => {
      if (!form.reportValidity()) return;
      try {
        const closed = await closeShift(shift.id, form.counted.value, form.note.value);
        close();
        if (closed.difference !== 0) {
          Utils.toast(
            (closed.difference < 0 ? 'عجز' : 'زيادة') + ' بمقدار ' + Utils.money(Math.abs(closed.difference)),
            closed.difference < 0 ? 'error' : 'warning'
          );
        } else {
          Utils.toast('تم إغلاق الوردية — الدرج مطابق', 'success');
        }
        _renderCurrent(body);
      } catch (err) {
        overlay.querySelector('#close-err').textContent = err.message;
      }
    };
    setTimeout(() => form.counted.select(), 50);
  }

  async function _renderHistory(body) {
    body.innerHTML = '<div class="loading">جارٍ التحميل…</div>';
    const all = (await DB.getAll('shifts'))
      .filter((s) => s.status === 'closed')
      .sort((a, b) => b.closedAt - a.closedAt)
      .slice(0, 500);
    if (!all.length) {
      body.innerHTML = '<div class="placeholder"><div class="placeholder-icon">⏱️</div><p>لا توجد ورديات مغلقة بعد.</p></div>';
      return;
    }
    body.innerHTML = `
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>الفتح</th><th>الإغلاق</th><th>المستخدم</th><th>رصيد البداية</th>
        <th>مبيعات النظام</th><th>المتوقع</th><th>الفعلي</th><th>الفرق</th></tr></thead>
        <tbody>${all
          .map((s) => {
            const dCls = s.difference < 0 ? 'stock-low' : s.difference > 0 ? 'stock-up' : '';
            return `<tr>
              <td>${Utils.fmtDateTime(s.openedAt)}</td>
              <td>${Utils.fmtDateTime(s.closedAt)}</td>
              <td>${Utils.escapeHtml(s.userName || '-')}</td>
              <td>${Utils.money(s.openingBalance)}</td>
              <td>${Utils.money(s.systemSales || 0)}</td>
              <td>${Utils.money(s.expectedCash || 0)}</td>
              <td>${Utils.money(s.countedCash || 0)}</td>
              <td class="${dCls}">${Utils.money(s.difference || 0)}</td></tr>`;
          })
          .join('')}</tbody>
      </table></div>`;
  }

  return {
    render,
    getOpenShiftId,
    getOpenShift,
    summary,
    openShift,
    closeShift,
  };
})();

window.Shifts = Shifts;
