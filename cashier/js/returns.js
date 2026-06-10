/* =====================================================================
 * returns.js  —  المرتجعات (المرحلة 5)
 * - مرتجع كامل / جزئي.
 * - لا مرتجع بدون فاتورة أصلية. سبب المرتجع إجباري.
 * - عند المرتجع: إعادة المخزون تلقائيًا + خصم المبيعات والأرباح من الفاتورة.
 * - احترام مدة المرتجع من الإعدادات (returnWindowDays).
 * - حالات الفاتورة: Completed / Partial Return / Full Return / Cancelled.
 * - إلغاء فاتورة = إرجاع كل ما تبقّى وتعليم الحالة Cancelled.
 *
 * توزيع خصم الفاتورة: يُوزَّع خصم الفاتورة على الأصناف بالتناسب مع قيمة كل
 * سطر حتى يكون المبلغ المُسترَد وعكس الربح دقيقين تمامًا.
 * ===================================================================== */

const Returns = (() => {
  let _tab = 'create';
  let _loaded = null; // الفاتورة المحمّلة حاليًا للمرتجع
  let _perUnit = []; // صافي سعر الوحدة بعد توزيع الخصم لكل سطر

  // حالة الاستبدال
  let _exInvoice = null;
  let _exPerUnit = [];
  let _exNewCart = []; // الأصناف البديلة [{productId,name,sku,unitPrice,unitCost,qty,stock}]
  let _exProducts = [];

  /* ---------- حساب صافي سعر الوحدة بعد توزيع خصم الفاتورة ---------- */
  function _computePerUnit(invoice) {
    const items = invoice.items || [];
    const sumLines = items.reduce((s, it) => s + (Number(it.lineTotal) || 0), 0);
    const invDisc = Number(invoice.invoiceDiscount) || 0;
    return items.map((it) => {
      const lt = Number(it.lineTotal) || 0;
      const share = sumLines > 0 ? invDisc * (lt / sumLines) : 0;
      const netLine = lt - share;
      const perUnit = it.qty > 0 ? netLine / it.qty : 0;
      return Math.round(perUnit * 100) / 100;
    });
  }

  function _availableQty(it) {
    return (Number(it.qty) || 0) - (Number(it.returnedQty) || 0);
  }

  /* ---------- تحميل فاتورة بالرقم ---------- */
  async function loadInvoice(number) {
    const inv = await DB.getOneByIndex('invoices', 'number', String(number).trim());
    if (!inv) throw new Error('لا توجد فاتورة بهذا الرقم');
    return inv;
  }

  /* ---------- التحقق من صلاحية المرتجع ---------- */
  async function _checkReturnable(invoice) {
    if (invoice.status === 'Cancelled') return { ok: false, error: 'الفاتورة ملغاة' };
    if (invoice.status === 'Full Return')
      return { ok: false, error: 'تم إرجاع كل أصناف الفاتورة بالفعل' };
    const settings = await Settings.getApp();
    const days = Number(settings.returnWindowDays) || 0;
    if (days > 0) {
      const ageDays = (Date.now() - invoice.createdAt) / (1000 * 60 * 60 * 24);
      if (ageDays > days)
        return {
          ok: false,
          error: 'انتهت مدة السماح بالمرتجع (' + days + ' يوم) لهذه الفاتورة',
        };
    }
    return { ok: true };
  }

  /* ---------- تنفيذ المرتجع ----------
   * lines: [{ index, qty }]  — index داخل invoice.items والكمية المرتجعة.
   * cancel: عند true يُعلَّم الفاتورة Cancelled. */
  async function processReturn(invoice, lines, reason, refundMethod, cancel = false) {
    reason = String(reason || '').trim();
    if (!reason) throw new Error('سبب المرتجع إجباري');

    const check = await _checkReturnable(invoice);
    if (!check.ok) throw new Error(check.error);

    const perUnit = _computePerUnit(invoice);
    const fresh = await DB.get('invoices', invoice.id); // أحدث نسخة
    if (!fresh) throw new Error('الفاتورة غير موجودة');

    const retItems = [];
    let total = 0;
    let totalCost = 0;

    for (const ln of lines) {
      const i = ln.index;
      const q = Math.floor(Number(ln.qty) || 0);
      if (q <= 0) continue;
      const it = fresh.items[i];
      const avail = _availableQty(it);
      if (q > avail)
        throw new Error('الكمية المرتجعة لـ"' + it.name + '" أكبر من المتاح (' + avail + ')');

      const unitRefund = perUnit[i];
      const refund = Math.round(unitRefund * q * 100) / 100;
      const costReturned = Math.round((Number(it.unitCost) || 0) * q * 100) / 100;

      it.returnedQty = (Number(it.returnedQty) || 0) + q;
      total += refund;
      totalCost += costReturned;

      retItems.push({
        productId: it.productId,
        name: it.name,
        sku: it.sku,
        barcode: it.barcode,
        qty: q,
        unitPrice: it.unitPrice,
        unitRefund,
        lineTotal: refund,
        unitCost: it.unitCost,
        costReturned,
        profitReversed: Math.round((refund - costReturned) * 100) / 100,
      });
    }

    if (!retItems.length) throw new Error('لم تحدد أي كمية للإرجاع');

    total = Math.round(total * 100) / 100;
    totalCost = Math.round(totalCost * 100) / 100;
    const profitReversed = Math.round((total - totalCost) * 100) / 100;

    // حالة الفاتورة بعد التحديث
    const soldQty = fresh.items.reduce((s, it) => s + (Number(it.qty) || 0), 0);
    const returnedQty = fresh.items.reduce((s, it) => s + (Number(it.returnedQty) || 0), 0);
    let status;
    if (cancel) status = 'Cancelled';
    else if (returnedQty >= soldQty) status = 'Full Return';
    else status = 'Partial Return';

    fresh.status = status;
    fresh.refundedTotal = Math.round(((Number(fresh.refundedTotal) || 0) + total) * 100) / 100;
    fresh.returnedProfit =
      Math.round(((Number(fresh.returnedProfit) || 0) + profitReversed) * 100) / 100;
    fresh.updatedAt = Date.now();

    const user = Auth.currentUser();
    const shiftId =
      window.Shifts && Shifts.getOpenShiftId ? await Shifts.getOpenShiftId() : null;

    const retRecord = {
      invoiceId: fresh.id,
      invoiceNumber: fresh.number,
      items: retItems,
      reason,
      type: cancel ? 'cancel' : status === 'Full Return' ? 'full' : 'partial',
      total,
      totalCost,
      profitReversed,
      refundMethod: refundMethod || fresh.paymentMethod || 'cash',
      userId: user ? user.id : null,
      userName: user ? user.name : '',
      shiftId,
      createdAt: Date.now(),
    };

    // حفظ سجل المرتجع
    const retId = await DB.add('returns', retRecord);
    retRecord.id = retId;

    // تحديث الفاتورة
    await DB.put('invoices', fresh);

    // إعادة المخزون تلقائيًا
    for (const ri of retItems) {
      await Inventory.applyMovement({
        productId: ri.productId,
        delta: +ri.qty,
        type: 'return',
        reason: 'مرتجع فاتورة ' + fresh.number + ' — ' + reason,
        refType: 'return',
        refId: retId,
      });
    }

    // حركة نقدية عكسية عند الاسترداد كاش
    if (retRecord.refundMethod === 'cash') {
      await DB.add('cash_movements', {
        shiftId,
        type: 'return',
        amount: -total,
        refType: 'return',
        refId: retId,
        note: 'مرتجع ' + fresh.number,
        userId: user ? user.id : null,
        createdAt: Date.now(),
      });
    }

    await Audit.log(
      cancel ? 'invoice.cancel' : 'return.create',
      'invoice',
      fresh.id,
      { status: invoice.status },
      { status, refund: total, reason, returnId: retId }
    );

    return { retRecord, invoice: fresh };
  }

  /* ===================================================================
   * الواجهة
   * =================================================================== */
  function render(content) {
    content.innerHTML = `
      <div class="tabs">
        <button class="tab ${_tab === 'create' ? 'active' : ''}" data-tab="create">إنشاء مرتجع</button>
        <button class="tab ${_tab === 'exchange' ? 'active' : ''}" data-tab="exchange">استبدال</button>
        <button class="tab ${_tab === 'log' ? 'active' : ''}" data-tab="log">سجل المرتجعات</button>
      </div>
      <div id="ret-body"></div>`;
    content.querySelectorAll('.tab').forEach((b) => {
      b.onclick = () => {
        _tab = b.dataset.tab;
        render(content);
      };
    });
    const body = content.querySelector('#ret-body');
    if (_tab === 'create') _renderCreate(body);
    else if (_tab === 'exchange') _renderExchange(body);
    else _renderLog(body);
  }

  /* ---------- تبويب إنشاء مرتجع ---------- */
  function _renderCreate(body) {
    body.innerHTML = `
      <div class="toolbar">
        <input type="search" id="ret-num" class="search-input"
          placeholder="أدخل رقم الفاتورة الأصلية (L-YYYYMMDD-0001) ثم Enter…" autocomplete="off" />
        <button class="btn btn-primary" id="ret-find">بحث</button>
      </div>
      <div id="ret-detail"></div>`;

    const numInput = body.querySelector('#ret-num');
    const find = async () => {
      const num = numInput.value.trim();
      if (!num) return;
      try {
        _loaded = await loadInvoice(num);
        _perUnit = _computePerUnit(_loaded);
        _drawDetail(body);
      } catch (err) {
        body.querySelector('#ret-detail').innerHTML =
          '<div class="placeholder"><p>' + Utils.escapeHtml(err.message) + '</p></div>';
      }
    };
    body.querySelector('#ret-find').onclick = find;
    numInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        find();
      }
    };
    if (_loaded) _drawDetail(body);
    setTimeout(() => numInput.focus(), 50);
  }

  function _statusBadge(status) {
    const map = {
      Completed: ['مكتملة', 'tag-ok'],
      'Partial Return': ['مرتجع جزئي', 'tag-warn'],
      'Full Return': ['مرتجع كامل', 'tag-muted'],
      Cancelled: ['ملغاة', 'tag-muted'],
    };
    const [label, cls] = map[status] || [status, 'tag-muted'];
    return `<span class="tag ${cls}">${label}</span>`;
  }

  function _drawDetail(body) {
    const inv = _loaded;
    const detail = body.querySelector('#ret-detail');
    const canReturn = inv.status !== 'Cancelled' && inv.status !== 'Full Return';

    detail.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <div class="ret-head">
          <div>
            <strong>فاتورة ${Utils.escapeHtml(inv.number)}</strong> ${_statusBadge(inv.status)}<br>
            <span class="form-note">${Utils.fmtDateTime(inv.createdAt)} · الكاشير: ${Utils.escapeHtml(
      inv.userName || '-'
    )} · الدفع: ${inv.paymentMethod}</span>
          </div>
          <div class="ret-total">إجمالي الفاتورة: <strong>${Utils.money(inv.total)}</strong></div>
        </div>
      </div>

      <div class="table-scroll"><table class="data-table">
        <thead><tr>
          <th>الصنف</th><th>مُباع</th><th>مُرتجع سابقًا</th><th>متاح</th>
          <th>سعر الوحدة (صافي)</th><th>كمية الإرجاع</th><th>قيمة الاسترداد</th>
        </tr></thead>
        <tbody>${inv.items
          .map((it, i) => {
            const avail = _availableQty(it);
            return `<tr>
              <td>${Utils.escapeHtml(it.name)}</td>
              <td>${it.qty}</td>
              <td>${it.returnedQty || 0}</td>
              <td>${avail}</td>
              <td>${Utils.money(_perUnit[i])}</td>
              <td><input type="number" min="0" max="${avail}" value="0" step="1"
                   data-ret="${i}" ${avail <= 0 ? 'disabled' : ''} style="width:80px" /></td>
              <td class="ret-line-val" data-val="${i}">${Utils.money(0)}</td>
            </tr>`;
          })
          .join('')}</tbody>
      </table></div>

      ${
        canReturn
          ? `
      <div class="ret-form">
        <label class="field">سبب المرتجع *
          <input type="text" id="ret-reason" required placeholder="عيب بالمنتج / طلب العميل / مقاس غير مناسب…" />
        </label>
        <label class="field">طريقة الاسترداد
          <select id="ret-method">
            <option value="cash" ${inv.paymentMethod === 'cash' ? 'selected' : ''}>كاش</option>
            <option value="instapay" ${inv.paymentMethod === 'instapay' ? 'selected' : ''}>Instapay</option>
            <option value="wallet" ${inv.paymentMethod === 'wallet' ? 'selected' : ''}>Wallet</option>
          </select>
        </label>
        <div class="ret-summary">إجمالي الاسترداد: <strong id="ret-grand">${Utils.money(0)}</strong></div>
        <div class="form-error" id="ret-err"></div>
        <div class="ret-actions">
          <button class="btn btn-ghost" id="ret-full">تحديد مرتجع كامل</button>
          <button class="btn btn-primary" id="ret-apply">تنفيذ المرتجع</button>
          <button class="btn btn-danger" id="ret-cancel-inv">إلغاء الفاتورة بالكامل</button>
        </div>
      </div>`
          : '<p class="form-note">لا يمكن إجراء مرتجع على هذه الفاتورة.</p>'
      }`;

    if (!canReturn) return;

    const inputs = detail.querySelectorAll('[data-ret]');
    const recompute = () => {
      let grand = 0;
      inputs.forEach((inp) => {
        const i = +inp.dataset.ret;
        const q = Math.min(Number(inp.value) || 0, _availableQty(inv.items[i]));
        const val = Math.round(_perUnit[i] * q * 100) / 100;
        detail.querySelector('[data-val="' + i + '"]').textContent = Utils.money(val);
        grand += val;
      });
      detail.querySelector('#ret-grand').textContent = Utils.money(Math.round(grand * 100) / 100);
    };
    inputs.forEach((inp) => (inp.oninput = recompute));

    detail.querySelector('#ret-full').onclick = () => {
      inputs.forEach((inp) => {
        const i = +inp.dataset.ret;
        inp.value = _availableQty(inv.items[i]);
      });
      recompute();
    };

    const collectLines = () =>
      Array.from(inputs)
        .map((inp) => ({ index: +inp.dataset.ret, qty: Number(inp.value) || 0 }))
        .filter((l) => l.qty > 0);

    detail.querySelector('#ret-apply').onclick = async () => {
      const reason = detail.querySelector('#ret-reason').value.trim();
      const method = detail.querySelector('#ret-method').value;
      const errBox = detail.querySelector('#ret-err');
      errBox.textContent = '';
      const lines = collectLines();
      if (!lines.length) {
        errBox.textContent = 'حدد كمية صنف واحد على الأقل';
        return;
      }
      if (!reason) {
        errBox.textContent = 'سبب المرتجع إجباري';
        return;
      }
      const appr = await Utils.requireManagerApproval('تنفيذ مرتجع على الفاتورة ' + inv.number);
      if (!appr.ok) {
        errBox.textContent = 'تتطلب هذه العملية موافقة المدير';
        return;
      }
      try {
        const { retRecord, invoice } = await processReturn(inv, lines, reason, method, false);
        Utils.toast('تم المرتجع — استرداد ' + Utils.money(retRecord.total), 'success');
        _loaded = invoice;
        _perUnit = _computePerUnit(invoice);
        _offerPrint(retRecord, invoice);
        _drawDetail(body);
      } catch (err) {
        errBox.textContent = err.message;
      }
    };

    detail.querySelector('#ret-cancel-inv').onclick = async () => {
      const reason = detail.querySelector('#ret-reason').value.trim();
      const method = detail.querySelector('#ret-method').value;
      const errBox = detail.querySelector('#ret-err');
      errBox.textContent = '';
      if (!reason) {
        errBox.textContent = 'سبب الإلغاء إجباري (اكتبه في خانة السبب)';
        return;
      }
      const appr = await Utils.requireManagerApproval('إلغاء الفاتورة ' + inv.number + ' بالكامل');
      if (!appr.ok) {
        errBox.textContent = 'تتطلب هذه العملية موافقة المدير';
        return;
      }
      const ok = await Utils.confirmBox(
        'إلغاء الفاتورة بالكامل يرجّع كل الأصناف المتبقية ويعلّمها "ملغاة". متابعة؟'
      );
      if (!ok) return;
      // كل الكميات المتبقية
      const lines = inv.items
        .map((it, i) => ({ index: i, qty: _availableQty(it) }))
        .filter((l) => l.qty > 0);
      if (!lines.length) {
        errBox.textContent = 'لا توجد أصناف متبقية للإرجاع';
        return;
      }
      try {
        const { retRecord, invoice } = await processReturn(inv, lines, reason, method, true);
        Utils.toast('تم إلغاء الفاتورة — استرداد ' + Utils.money(retRecord.total), 'success');
        _loaded = invoice;
        _perUnit = _computePerUnit(invoice);
        _offerPrint(retRecord, invoice);
        _drawDetail(body);
      } catch (err) {
        errBox.textContent = err.message;
      }
    };
  }

  function _offerPrint(retRecord, invoice) {
    Utils.modal({
      title: 'تم تسجيل المرتجع',
      bodyHtml: `<p>إجمالي الاسترداد: <strong>${Utils.money(retRecord.total)}</strong></p>
        <p>حالة الفاتورة الآن: ${_statusBadge(invoice.status)}</p>
        <p>طباعة إيصال المرتجع؟</p>`,
      confirmText: 'طباعة',
      cancelText: 'إغلاق',
    }).then(async (v) => {
      if (v === null) return;
      const settings = await Settings.getApp();
      // بناء كائن متوافق مع طابعة الإيصالات
      Receipt.print(
        {
          number: 'RET-' + retRecord.id,
          createdAt: retRecord.createdAt,
          userName: retRecord.userName,
          items: retRecord.items,
          subtotal: retRecord.total,
          totalDiscount: 0,
          total: retRecord.total,
          paymentMethod: retRecord.refundMethod,
          note: retRecord.reason,
        },
        settings,
        { isReturn: true, originalNumber: retRecord.invoiceNumber }
      );
    });
  }

  /* ---------- تبويب الاستبدال ---------- */
  async function _renderExchange(body) {
    _exProducts = (await DB.getAll('products')).filter((p) => !p.archived);
    body.innerHTML = `
      <div class="toolbar">
        <input type="search" id="ex-num" class="search-input"
          placeholder="رقم الفاتورة الأصلية (L-YYYYMMDD-0001) ثم Enter…" autocomplete="off" />
        <button class="btn btn-primary" id="ex-find">بحث</button>
      </div>
      <div id="ex-detail"></div>`;
    const numInput = body.querySelector('#ex-num');
    const find = async () => {
      const num = numInput.value.trim();
      if (!num) return;
      try {
        _exInvoice = await loadInvoice(num);
        _exPerUnit = _computePerUnit(_exInvoice);
        _exNewCart = [];
        _drawExchange(body);
      } catch (err) {
        body.querySelector('#ex-detail').innerHTML =
          '<div class="placeholder"><p>' + Utils.escapeHtml(err.message) + '</p></div>';
      }
    };
    body.querySelector('#ex-find').onclick = find;
    numInput.onkeydown = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        find();
      }
    };
    if (_exInvoice) _drawExchange(body);
    setTimeout(() => numInput.focus(), 50);
  }

  function _exAddNew(term) {
    term = String(term || '').trim();
    if (!term) return;
    const lc = term.toLowerCase();
    const p =
      _exProducts.find((x) => x.barcode === term) ||
      _exProducts.find((x) => x.sku === term) ||
      _exProducts.find((x) => x.name.toLowerCase().includes(lc));
    if (!p) {
      Utils.toast('لا يوجد منتج مطابق', 'error');
      return;
    }
    const ex = _exNewCart.find((c) => c.productId === p.id);
    if (ex) ex.qty += 1;
    else
      _exNewCart.push({
        productId: p.id,
        name: p.name,
        sku: p.sku,
        unitPrice: Number(p.salePrice) || 0,
        unitCost: Number(p.costPrice) || 0,
        qty: 1,
      });
  }

  function _drawExchange(body) {
    const inv = _exInvoice;
    const detail = body.querySelector('#ex-detail');
    const canReturn = inv.status !== 'Cancelled' && inv.status !== 'Full Return';
    if (!canReturn) {
      detail.innerHTML = `<div class="card">${_statusBadge(
        inv.status
      )} لا يمكن الاستبدال على هذه الفاتورة (مرتجعة بالكامل أو ملغاة).</div>`;
      return;
    }

    detail.innerHTML = `
      <div class="card" style="margin-bottom:14px">
        <strong>فاتورة ${Utils.escapeHtml(inv.number)}</strong> ${_statusBadge(inv.status)}
        <span class="form-note"> · ${Utils.fmtDateTime(inv.createdAt)}</span>
      </div>

      <h3 class="form-section-title">1) الأصناف المُرتجعة (من الفاتورة)</h3>
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>الصنف</th><th>متاح</th><th>سعر الوحدة (صافي)</th><th>كمية الإرجاع</th></tr></thead>
        <tbody>${inv.items
          .map((it, i) => {
            const avail = _availableQty(it);
            return `<tr>
              <td>${Utils.escapeHtml(it.name)}</td>
              <td>${avail}</td>
              <td>${Utils.money(_exPerUnit[i])}</td>
              <td><input type="number" min="0" max="${avail}" value="0" step="1"
                   data-exret="${i}" ${avail <= 0 ? 'disabled' : ''} style="width:80px" /></td>
            </tr>`;
          })
          .join('')}</tbody>
      </table></div>

      <h3 class="form-section-title">2) الأصناف البديلة (الجديدة)</h3>
      <div class="toolbar">
        <input type="search" id="ex-add" class="search-input"
          placeholder="امسح الباركود أو اكتب اسم/SKU الصنف البديل ثم Enter…" autocomplete="off" />
      </div>
      <div id="ex-newcart"></div>

      <div class="ret-form">
        <div class="sum-row"><span>قيمة المُرتجع</span><span id="ex-rv">${Utils.money(0)}</span></div>
        <div class="sum-row"><span>قيمة البديل</span><span id="ex-nv">${Utils.money(0)}</span></div>
        <div class="sum-row sum-total"><span id="ex-diff-label">الفرق</span><span id="ex-diff">${Utils.money(
          0
        )}</span></div>
        <label class="field">سبب الاستبدال *
          <input type="text" id="ex-reason" placeholder="مقاس/لون غير مناسب…" />
        </label>
        <label class="field">طريقة تسوية الفرق
          <select id="ex-method">
            <option value="cash">كاش</option>
            <option value="instapay">Instapay</option>
            <option value="wallet">Wallet</option>
          </select>
        </label>
        <div class="form-error" id="ex-err"></div>
        <button class="btn btn-primary" id="ex-apply">تنفيذ الاستبدال</button>
      </div>`;

    const addInput = detail.querySelector('#ex-add');
    addInput.onkeydown = (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      _exAddNew(addInput.value);
      addInput.value = '';
      _drawNewCart(detail);
      _recomputeExchange(detail);
    };

    detail.querySelectorAll('[data-exret]').forEach((inp) => {
      inp.oninput = () => _recomputeExchange(detail);
    });

    _drawNewCart(detail);
    _recomputeExchange(detail);

    detail.querySelector('#ex-apply').onclick = () => _applyExchange(body, detail);
    setTimeout(() => addInput.focus(), 50);
  }

  function _drawNewCart(detail) {
    const wrap = detail.querySelector('#ex-newcart');
    if (!_exNewCart.length) {
      wrap.innerHTML = '<p class="form-note">لم تُضِف أصنافًا بديلة بعد.</p>';
      return;
    }
    wrap.innerHTML = `
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>الصنف</th><th>السعر</th><th>الكمية</th><th>الإجمالي</th><th></th></tr></thead>
        <tbody>${_exNewCart
          .map(
            (c, i) => `<tr>
            <td>${Utils.escapeHtml(c.name)}</td>
            <td>${Utils.money(c.unitPrice)}</td>
            <td><input type="number" min="1" step="1" value="${c.qty}" data-exqty="${i}" style="width:70px" /></td>
            <td>${Utils.money(c.unitPrice * c.qty)}</td>
            <td><button class="cl-remove" data-exdel="${i}">✕</button></td>
          </tr>`
          )
          .join('')}</tbody>
      </table></div>`;
    wrap.querySelectorAll('[data-exqty]').forEach((inp) => {
      inp.onchange = () => {
        _exNewCart[+inp.dataset.exqty].qty = Math.max(1, Math.floor(Number(inp.value) || 1));
        _drawNewCart(detail);
        _recomputeExchange(detail);
      };
    });
    wrap.querySelectorAll('[data-exdel]').forEach((b) => {
      b.onclick = () => {
        _exNewCart.splice(+b.dataset.exdel, 1);
        _drawNewCart(detail);
        _recomputeExchange(detail);
      };
    });
  }

  function _exReturnLines(detail) {
    return Array.from(detail.querySelectorAll('[data-exret]'))
      .map((inp) => ({ index: +inp.dataset.exret, qty: Number(inp.value) || 0 }))
      .filter((l) => l.qty > 0);
  }

  function _recomputeExchange(detail) {
    const lines = _exReturnLines(detail);
    let rv = 0;
    lines.forEach((l) => (rv += _exPerUnit[l.index] * l.qty));
    rv = Math.round(rv * 100) / 100;
    let nv = 0;
    _exNewCart.forEach((c) => (nv += c.unitPrice * c.qty));
    nv = Math.round(nv * 100) / 100;
    const diff = Math.round((nv - rv) * 100) / 100;
    detail.querySelector('#ex-rv').textContent = Utils.money(rv);
    detail.querySelector('#ex-nv').textContent = Utils.money(nv);
    const label = detail.querySelector('#ex-diff-label');
    const diffEl = detail.querySelector('#ex-diff');
    diffEl.textContent = Utils.money(Math.abs(diff));
    if (diff > 0) label.textContent = 'يدفع العميل';
    else if (diff < 0) label.textContent = 'يُسترد للعميل';
    else label.textContent = 'الفرق (متعادل)';
    return { rv, nv, diff, lines };
  }

  async function _applyExchange(body, detail) {
    const errBox = detail.querySelector('#ex-err');
    errBox.textContent = '';
    const reason = detail.querySelector('#ex-reason').value.trim();
    const method = detail.querySelector('#ex-method').value;
    const { rv, nv, diff, lines } = _recomputeExchange(detail);

    if (!lines.length) {
      errBox.textContent = 'حدد صنفًا واحدًا على الأقل للإرجاع';
      return;
    }
    if (!_exNewCart.length) {
      errBox.textContent = 'أضف صنفًا بديلًا واحدًا على الأقل';
      return;
    }
    if (!reason) {
      errBox.textContent = 'سبب الاستبدال إجباري';
      return;
    }
    // منع بيع صنف بديل غير متوفر عند تفعيل المنع
    const settings = await Settings.getApp();
    if (settings.blockSaleWhenOutOfStock) {
      for (const c of _exNewCart) {
        const p = _exProducts.find((x) => x.id === c.productId);
        if (p && c.qty > Number(p.stock)) {
          errBox.textContent = 'المخزون غير كافٍ للصنف البديل: ' + c.name;
          return;
        }
      }
    }

    const appr = await Utils.requireManagerApproval('تنفيذ استبدال على الفاتورة ' + _exInvoice.number);
    if (!appr.ok) {
      errBox.textContent = 'تتطلب هذه العملية موافقة المدير';
      return;
    }

    try {
      // 1) مرتجع الأصناف القديمة
      const { retRecord, invoice } = await processReturn(
        _exInvoice,
        lines,
        'استبدال: ' + reason,
        method,
        false
      );

      // 2) بيع الأصناف البديلة كفاتورة جديدة
      const items = _exNewCart.map((c) => ({
        productId: c.productId,
        name: c.name,
        sku: c.sku,
        qty: c.qty,
        unitPrice: c.unitPrice,
        unitCost: c.unitCost,
        lineDiscount: 0,
        lineTotal: Math.round(c.unitPrice * c.qty * 100) / 100,
        returnedQty: 0,
      }));
      const totalCost = items.reduce((s, it) => s + it.unitCost * it.qty, 0);
      const saleInvoice = await POS.persistSale({
        items,
        subtotal: nv,
        totalDiscount: 0,
        total: nv,
        totalCost: Math.round(totalCost * 100) / 100,
        profit: Math.round((nv - totalCost) * 100) / 100,
        paymentMethod: method,
        paidAmount: nv,
        change: 0,
        note: 'استبدال مقابل فاتورة ' + _exInvoice.number,
      });

      await Audit.log('exchange.create', 'invoice', invoice.id, null, {
        original: _exInvoice.number,
        returnId: retRecord.id,
        newInvoice: saleInvoice.number,
        returnValue: rv,
        newValue: nv,
        difference: diff,
      });

      Utils.toast('تم الاستبدال بنجاح', 'success');
      _offerExchangePrint({ retRecord, saleInvoice, rv, nv, diff, settings });

      // إعادة الضبط
      _exInvoice = null;
      _exNewCart = [];
      _renderExchange(body);
    } catch (err) {
      errBox.textContent = err.message;
    }
  }

  function _offerExchangePrint({ retRecord, saleInvoice, rv, nv, diff, settings }) {
    const diffText =
      diff > 0
        ? 'المطلوب تحصيله من العميل: ' + Utils.money(diff)
        : diff < 0
        ? 'المُسترد للعميل: ' + Utils.money(-diff)
        : 'متعادل (لا فرق)';
    Utils.modal({
      title: 'تم الاستبدال',
      bodyHtml: `
        <p>قيمة المُرتجع: ${Utils.money(rv)}</p>
        <p>قيمة البديل: ${Utils.money(nv)}</p>
        <p><strong>${diffText}</strong></p>
        <p>فاتورة البديل الجديدة: <span class="mono">${Utils.escapeHtml(saleInvoice.number)}</span></p>
        <p>طباعة فاتورة البديل؟</p>`,
      confirmText: 'طباعة الفاتورة الجديدة',
      cancelText: 'إغلاق',
    }).then((v) => {
      if (v !== null) Receipt.print(saleInvoice, settings);
    });
  }

  /* ---------- تبويب سجل المرتجعات ---------- */
  async function _renderLog(body) {
    body.innerHTML = '<div class="loading">جارٍ التحميل…</div>';
    const all = (await DB.getAll('returns')).sort((a, b) => b.createdAt - a.createdAt).slice(0, 500);
    if (!all.length) {
      body.innerHTML = '<div class="placeholder"><div class="placeholder-icon">↩️</div><p>لا توجد مرتجعات بعد.</p></div>';
      return;
    }
    body.innerHTML = `
      <div class="table-meta">عدد المرتجعات: ${all.length.toLocaleString('ar-EG')}</div>
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>التاريخ</th><th>الفاتورة</th><th>النوع</th><th>الأصناف</th><th>الاسترداد</th><th>الطريقة</th><th>السبب</th><th>المستخدم</th></tr></thead>
        <tbody>${all
          .map((r) => {
            const typeLabel =
              r.type === 'cancel' ? 'إلغاء' : r.type === 'full' ? 'كامل' : 'جزئي';
            const itemsCount = r.items.reduce((s, it) => s + it.qty, 0);
            return `<tr>
              <td>${Utils.fmtDateTime(r.createdAt)}</td>
              <td class="mono">${Utils.escapeHtml(r.invoiceNumber)}</td>
              <td>${typeLabel}</td>
              <td>${itemsCount}</td>
              <td>${Utils.money(r.total)}</td>
              <td>${r.refundMethod}</td>
              <td>${Utils.escapeHtml(r.reason)}</td>
              <td>${Utils.escapeHtml(r.userName || '-')}</td></tr>`;
          })
          .join('')}</tbody>
      </table></div>`;
  }

  return {
    render,
    loadInvoice,
    processReturn,
  };
})();

window.Returns = Returns;
