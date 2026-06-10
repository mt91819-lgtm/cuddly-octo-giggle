/* =====================================================================
 * reports.js  —  التقارير (المرحلة 9)
 * تبويبات:
 *   1) مالي (يومي/فترة): مبيعات، أرباح، مرتجعات، مصروفات، صافي الربح.
 *   2) المنتجات: الأكثر والأقل مبيعًا.
 *   3) المخزون: المنتجات الناقصة + جرد (تقييم المخزون الحالي).
 *
 * منهجية الفترة:
 *   - المبيعات/الأرباح من فواتير الفترة (createdAt ضمن المدى).
 *   - المرتجعات بتاريخ المرتجع نفسه (الصحيح للتقرير اليومي).
 *   - صافي الربح = ربح المبيعات − الربح المعكوس بالمرتجعات − المصروفات.
 *   - الأداء: المرور بالـ cursor على فهرس createdAt ضمن نطاق التاريخ.
 * ===================================================================== */

const Reports = (() => {
  let _tab = 'finance';
  let _range = _todayRange();

  function _todayRange() {
    const d = new Date();
    const from = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0).getTime();
    const to = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
    return { from, to };
  }

  /* جمع سجلات مخزّنة ضمن نطاق createdAt عبر cursor (أداء أفضل) */
  async function _collectByDate(store, from, to) {
    const out = [];
    const range = IDBKeyRange.bound(from, to);
    await DB.iterate(store, (v) => out.push(v), { index: 'createdAt', range });
    return out;
  }

  /* ---------- حساب ملخص الفترة المالي ---------- */
  async function financeSummary(from, to) {
    const invoices = await _collectByDate('invoices', from, to);
    const returns = await _collectByDate('returns', from, to);
    const expensesAll = await _collectByDate('expenses', from, to);
    const expenses = expensesAll.filter((e) => !e.voided);

    const byMethod = { cash: 0, instapay: 0, wallet: 0 };
    let grossSales = 0;
    let grossProfit = 0;
    invoices.forEach((inv) => {
      grossSales += Number(inv.total) || 0;
      grossProfit += Number(inv.profit) || 0;
      byMethod[inv.paymentMethod] = (byMethod[inv.paymentMethod] || 0) + (Number(inv.total) || 0);
    });

    const refundTotal = returns.reduce((s, r) => s + (Number(r.total) || 0), 0);
    const returnedProfit = returns.reduce((s, r) => s + (Number(r.profitReversed) || 0), 0);
    const expensesTotal = expenses.reduce((s, e) => s + (Number(e.amount) || 0), 0);

    const r2 = (n) => Math.round(n * 100) / 100;
    const netSales = r2(grossSales - refundTotal);
    const netProfit = r2(grossProfit - returnedProfit - expensesTotal);

    return {
      invoiceCount: invoices.length,
      returnCount: returns.length,
      grossSales: r2(grossSales),
      netSales,
      grossProfit: r2(grossProfit),
      refundTotal: r2(refundTotal),
      returnedProfit: r2(returnedProfit),
      expensesTotal: r2(expensesTotal),
      netProfit,
      byMethod,
    };
  }

  /* ---------- مبيعات المنتجات في الفترة ---------- */
  async function productSales(from, to) {
    const invoices = await _collectByDate('invoices', from, to);
    const products = (await DB.getAll('products')).filter((p) => !p.archived);
    const map = {};
    products.forEach((p) => (map[p.id] = { id: p.id, name: p.name, sku: p.sku, qty: 0, revenue: 0 }));
    invoices.forEach((inv) =>
      (inv.items || []).forEach((it) => {
        if (!map[it.productId])
          map[it.productId] = { id: it.productId, name: it.name, sku: it.sku, qty: 0, revenue: 0 };
        map[it.productId].qty += Number(it.qty) || 0;
        map[it.productId].revenue += Number(it.lineTotal) || 0;
      })
    );
    return Object.values(map);
  }

  /* ===================================================================
   * الواجهة
   * =================================================================== */
  function render(content) {
    content.innerHTML = `
      <div class="tabs">
        <button class="tab ${_tab === 'finance' ? 'active' : ''}" data-tab="finance">مالي</button>
        <button class="tab ${_tab === 'products' ? 'active' : ''}" data-tab="products">المنتجات</button>
        <button class="tab ${_tab === 'stock' ? 'active' : ''}" data-tab="stock">المخزون</button>
      </div>
      <div id="rep-body"></div>`;
    content.querySelectorAll('.tab').forEach((b) => {
      b.onclick = () => {
        _tab = b.dataset.tab;
        render(content);
      };
    });
    const body = content.querySelector('#rep-body');
    if (_tab === 'finance') _renderFinance(body);
    else if (_tab === 'products') _renderProducts(body);
    else _renderStock(body);
  }

  /* شريط اختيار الفترة (يُستخدم في المالي والمنتجات) */
  function _rangeBar(onChange) {
    const fromStr = new Date(_range.from).toISOString().slice(0, 10);
    const toStr = new Date(_range.to).toISOString().slice(0, 10);
    const bar = Utils.el(`
      <div class="toolbar">
        <div class="quick-range">
          <button class="btn btn-sm btn-ghost" data-q="today">اليوم</button>
          <button class="btn btn-sm btn-ghost" data-q="yesterday">أمس</button>
          <button class="btn btn-sm btn-ghost" data-q="7">7 أيام</button>
          <button class="btn btn-sm btn-ghost" data-q="month">هذا الشهر</button>
        </div>
        <input type="date" id="rep-from" class="filter-select" value="${fromStr}" />
        <input type="date" id="rep-to" class="filter-select" value="${toStr}" />
        <button class="btn btn-primary" id="rep-apply">عرض</button>
      </div>`);

    bar.querySelectorAll('[data-q]').forEach((b) => {
      b.onclick = () => {
        const now = new Date();
        if (b.dataset.q === 'today') _range = _todayRange();
        else if (b.dataset.q === 'yesterday') {
          const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
          _range = {
            from: new Date(y.getFullYear(), y.getMonth(), y.getDate(), 0, 0, 0).getTime(),
            to: new Date(y.getFullYear(), y.getMonth(), y.getDate(), 23, 59, 59, 999).getTime(),
          };
        } else if (b.dataset.q === '7') {
          const s = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 0, 0, 0);
          _range = { from: s.getTime(), to: _todayRange().to };
        } else if (b.dataset.q === 'month') {
          const s = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
          _range = { from: s.getTime(), to: _todayRange().to };
        }
        onChange();
      };
    });
    bar.querySelector('#rep-apply').onclick = () => {
      const f = bar.querySelector('#rep-from').value;
      const t = bar.querySelector('#rep-to').value;
      if (f) _range.from = new Date(f + 'T00:00:00').getTime();
      if (t) _range.to = new Date(t + 'T23:59:59.999').getTime();
      onChange();
    };
    return bar;
  }

  function _rangeLabel() {
    const f = new Date(_range.from).toLocaleDateString('ar-EG');
    const t = new Date(_range.to).toLocaleDateString('ar-EG');
    return f === t ? f : f + ' — ' + t;
  }

  /* ---------- تبويب مالي ---------- */
  async function _renderFinance(body) {
    body.innerHTML = '';
    body.appendChild(_rangeBar(() => _renderFinance(body)));
    const result = Utils.el('<div id="fin-result"><div class="loading">جارٍ الحساب…</div></div>');
    body.appendChild(result);

    const s = await financeSummary(_range.from, _range.to);
    result.innerHTML = `
      <div class="rep-period">الفترة: ${_rangeLabel()} · ${s.invoiceCount.toLocaleString(
      'ar-EG'
    )} فاتورة · ${s.returnCount.toLocaleString('ar-EG')} مرتجع</div>
      <div class="cards">
        <div class="card card-blue"><div class="card-icon">🧾</div>
          <div class="card-value">${Utils.money(s.grossSales)}</div><div class="card-label">إجمالي المبيعات</div></div>
        <div class="card card-green"><div class="card-icon">💰</div>
          <div class="card-value">${Utils.money(s.netSales)}</div><div class="card-label">صافي المبيعات</div></div>
        <div class="card card-amber"><div class="card-icon">↩️</div>
          <div class="card-value">${Utils.money(s.refundTotal)}</div><div class="card-label">المرتجعات</div></div>
        <div class="card card-amber"><div class="card-icon">💸</div>
          <div class="card-value">${Utils.money(s.expensesTotal)}</div><div class="card-label">المصروفات</div></div>
        <div class="card card-purple"><div class="card-icon">📈</div>
          <div class="card-value">${Utils.money(s.grossProfit)}</div><div class="card-label">ربح المبيعات</div></div>
        <div class="card ${s.netProfit < 0 ? 'card-red' : 'card-green'}"><div class="card-icon">🏆</div>
          <div class="card-value">${Utils.money(s.netProfit)}</div><div class="card-label">صافي الربح</div></div>
      </div>

      <h3 class="form-section-title">المبيعات حسب طريقة الدفع</h3>
      <div class="cards">
        <div class="card"><div class="card-label">كاش 💵</div><div class="card-value" style="font-size:1.3rem">${Utils.money(
          s.byMethod.cash
        )}</div></div>
        <div class="card"><div class="card-label">Instapay</div><div class="card-value" style="font-size:1.3rem">${Utils.money(
          s.byMethod.instapay
        )}</div></div>
        <div class="card"><div class="card-label">Wallet</div><div class="card-value" style="font-size:1.3rem">${Utils.money(
          s.byMethod.wallet
        )}</div></div>
      </div>

      <h3 class="form-section-title">معادلة صافي الربح</h3>
      <div class="formula">
        ربح المبيعات (${Utils.money(s.grossProfit)}) − الربح المعكوس بالمرتجعات (${Utils.money(
      s.returnedProfit
    )}) − المصروفات (${Utils.money(s.expensesTotal)}) =
        <strong>${Utils.money(s.netProfit)}</strong>
      </div>`;
  }

  /* ---------- تبويب المنتجات ---------- */
  async function _renderProducts(body) {
    body.innerHTML = '';
    body.appendChild(_rangeBar(() => _renderProducts(body)));
    const result = Utils.el('<div id="prod-result"><div class="loading">جارٍ الحساب…</div></div>');
    body.appendChild(result);

    const rows = await productSales(_range.from, _range.to);
    const sold = rows.filter((r) => r.qty > 0).sort((a, b) => b.qty - a.qty);
    const top = sold.slice(0, 10);
    const least = sold.slice(-10).reverse(); // الأقل بين ما بيع فعلًا
    const noSales = rows.filter((r) => r.qty === 0).length;

    const tbl = (list, emptyMsg) =>
      list.length
        ? `<div class="table-scroll"><table class="data-table">
            <thead><tr><th>#</th><th>المنتج</th><th>SKU</th><th>الكمية المباعة</th><th>الإيراد</th></tr></thead>
            <tbody>${list
              .map(
                (r, i) =>
                  `<tr><td>${i + 1}</td><td>${Utils.escapeHtml(r.name)}</td>
                   <td class="mono">${Utils.escapeHtml(r.sku)}</td>
                   <td>${r.qty.toLocaleString('ar-EG')}</td>
                   <td>${Utils.money(r.revenue)}</td></tr>`
              )
              .join('')}</tbody></table></div>`
        : `<div class="placeholder"><p>${emptyMsg}</p></div>`;

    result.innerHTML = `
      <div class="rep-period">الفترة: ${_rangeLabel()} · منتجات لم تُبَع: ${noSales.toLocaleString(
      'ar-EG'
    )}</div>
      <h3 class="form-section-title">🔝 الأكثر مبيعًا</h3>
      ${tbl(top, 'لا توجد مبيعات في هذه الفترة.')}
      <h3 class="form-section-title">🔻 الأقل مبيعًا (مما بيع)</h3>
      ${tbl(least, 'لا توجد مبيعات في هذه الفترة.')}`;
  }

  /* ---------- تبويب المخزون ---------- */
  async function _renderStock(body) {
    body.innerHTML = '<div class="loading">جارٍ التحميل…</div>';
    const products = (await DB.getAll('products')).filter((p) => !p.archived);
    const low = products
      .filter((p) => Number(p.stock) <= Number(p.alertLevel))
      .sort((a, b) => a.stock - b.stock);

    let totalUnits = 0;
    let costValue = 0;
    let saleValue = 0;
    products.forEach((p) => {
      totalUnits += Number(p.stock) || 0;
      costValue += (Number(p.stock) || 0) * (Number(p.costPrice) || 0);
      saleValue += (Number(p.stock) || 0) * (Number(p.salePrice) || 0);
    });
    const r2 = (n) => Math.round(n * 100) / 100;

    const valuation = products
      .map((p) => ({
        name: p.name,
        sku: p.sku,
        stock: Number(p.stock) || 0,
        cost: Number(p.costPrice) || 0,
        value: r2((Number(p.stock) || 0) * (Number(p.costPrice) || 0)),
      }))
      .sort((a, b) => b.value - a.value);

    body.innerHTML = `
      <div class="cards">
        <div class="card card-blue"><div class="card-icon">📦</div>
          <div class="card-value">${products.length.toLocaleString('ar-EG')}</div><div class="card-label">أصناف نشطة</div></div>
        <div class="card"><div class="card-icon">🔢</div>
          <div class="card-value">${totalUnits.toLocaleString('ar-EG')}</div><div class="card-label">إجمالي الوحدات</div></div>
        <div class="card card-purple"><div class="card-icon">🏷️</div>
          <div class="card-value">${Utils.money(r2(costValue))}</div><div class="card-label">قيمة المخزون (بالتكلفة)</div></div>
        <div class="card card-green"><div class="card-icon">💹</div>
          <div class="card-value">${Utils.money(r2(saleValue))}</div><div class="card-label">قيمة المخزون (بالبيع)</div></div>
      </div>

      <h3 class="form-section-title">🛒 قائمة إعادة الشراء (المنتجات الناقصة) — ${low.length.toLocaleString(
        'ar-EG'
      )}</h3>
      ${
        low.length
          ? `<div class="table-scroll"><table class="data-table">
              <thead><tr><th>المنتج</th><th>SKU</th><th>المخزون</th><th>حد التنبيه</th><th>النقص</th></tr></thead>
              <tbody>${low
                .map(
                  (p) =>
                    `<tr><td>${Utils.escapeHtml(p.name)}</td><td class="mono">${Utils.escapeHtml(
                      p.sku
                    )}</td><td class="stock-low">${p.stock}</td><td>${p.alertLevel}</td>
                     <td>${Math.max(0, (Number(p.alertLevel) || 0) - (Number(p.stock) || 0))}</td></tr>`
                )
                .join('')}</tbody></table></div>`
          : '<div class="placeholder"><p>لا توجد منتجات ناقصة. 👍</p></div>'
      }

      <h3 class="form-section-title">📋 جرد المخزون الحالي (بالتكلفة)</h3>
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>المنتج</th><th>SKU</th><th>المخزون</th><th>التكلفة</th><th>القيمة</th></tr></thead>
        <tbody>${valuation
          .map(
            (v) =>
              `<tr><td>${Utils.escapeHtml(v.name)}</td><td class="mono">${Utils.escapeHtml(
                v.sku
              )}</td><td>${v.stock.toLocaleString('ar-EG')}</td><td>${Utils.money(
                v.cost
              )}</td><td>${Utils.money(v.value)}</td></tr>`
          )
          .join('')}</tbody>
      </table></div>`;
  }

  return { render, financeSummary, productSales };
})();

window.Reports = Reports;
