/* =====================================================================
 * health.js  —  فحص سلامة النظام (المرحلة 12)
 * زر فحص يتحقق من:
 *   - تكرار SKU.
 *   - تكرار Barcode.
 *   - سلامة الفواتير (تكرار الأرقام، تطابق الإجماليات، مراجع الأصناف،
 *     الكميات المرتجعة، المرتجعات بلا فاتورة).
 *   - سلامة قاعدة البيانات (الجداول، الإعدادات، المخزون السالب، عدّاد الترقيم).
 * تشخيص للقراءة فقط — لا يعدّل البيانات.
 * ===================================================================== */

const Health = (() => {
  const r2 = (n) => Math.round(n * 100) / 100;

  function _result(name, status, message, details) {
    return { name, status, message, details: details || [] };
  }

  async function runChecks() {
    const results = [];

    /* ---------- المنتجات: SKU / Barcode / مخزون سالب ---------- */
    const products = await DB.getAll('products');
    const prodIds = new Set();
    const skuMap = {};
    const barMap = {};
    products.forEach((p) => {
      prodIds.add(p.id);
      if (p.sku) (skuMap[p.sku] = skuMap[p.sku] || []).push(p.id);
      if (p.barcode) (barMap[p.barcode] = barMap[p.barcode] || []).push(p.id);
    });

    const dupSku = Object.entries(skuMap).filter(([, v]) => v.length > 1);
    results.push(
      _result(
        'تكرار SKU',
        dupSku.length ? 'error' : 'ok',
        dupSku.length ? `يوجد ${dupSku.length} رمز SKU مكرر` : 'لا يوجد تكرار في SKU',
        dupSku.map(([k, v]) => `${k} → منتجات: ${v.join(', ')}`)
      )
    );

    const dupBar = Object.entries(barMap).filter(([, v]) => v.length > 1);
    results.push(
      _result(
        'تكرار Barcode',
        dupBar.length ? 'error' : 'ok',
        dupBar.length ? `يوجد ${dupBar.length} باركود مكرر` : 'لا يوجد تكرار في الباركود',
        dupBar.map(([k, v]) => `${k} → منتجات: ${v.join(', ')}`)
      )
    );

    const negStock = products.filter((p) => Number(p.stock) < 0);
    results.push(
      _result(
        'المخزون السالب',
        negStock.length ? 'warning' : 'ok',
        negStock.length ? `${negStock.length} منتج برصيد سالب` : 'لا يوجد مخزون سالب',
        negStock.map((p) => `${p.name} (${p.sku}) = ${p.stock}`)
      )
    );

    /* ---------- الفواتير (بالمرور عبر cursor) ---------- */
    const numCount = {};
    let invCount = 0;
    const totalsIssues = [];
    const orphanItems = [];
    const retQtyIssues = [];
    await DB.iterate('invoices', (inv) => {
      invCount++;
      numCount[inv.number] = (numCount[inv.number] || 0) + 1;
      const recomputed = r2((Number(inv.subtotal) || 0) - (Number(inv.totalDiscount) || 0));
      if (Math.abs(recomputed - (Number(inv.total) || 0)) > 0.01)
        totalsIssues.push(`${inv.number}: مخزّن ${inv.total} ≠ محسوب ${recomputed}`);
      (inv.items || []).forEach((it) => {
        if (!prodIds.has(it.productId))
          orphanItems.push(`${inv.number}: ${it.name} (منتج #${it.productId})`);
        if ((Number(it.returnedQty) || 0) > (Number(it.qty) || 0))
          retQtyIssues.push(`${inv.number}: ${it.name} مرتجع ${it.returnedQty} > مباع ${it.qty}`);
      });
    });

    const dupNums = Object.entries(numCount).filter(([, v]) => v > 1);
    results.push(
      _result(
        'تكرار رقم الفاتورة',
        dupNums.length ? 'error' : 'ok',
        dupNums.length ? `${dupNums.length} رقم فاتورة مكرر` : `كل أرقام الفواتير فريدة (${invCount})`,
        dupNums.map(([k, v]) => `${k} مكرر ${v} مرات`)
      )
    );
    results.push(
      _result(
        'تطابق إجماليات الفواتير',
        totalsIssues.length ? 'warning' : 'ok',
        totalsIssues.length ? `${totalsIssues.length} فاتورة بإجمالي غير متطابق` : 'كل الإجماليات متطابقة',
        totalsIssues
      )
    );
    results.push(
      _result(
        'أصناف تشير لمنتجات غير موجودة',
        orphanItems.length ? 'warning' : 'ok',
        orphanItems.length ? `${orphanItems.length} سطر يشير لمنتج محذوف` : 'كل أصناف الفواتير سليمة',
        orphanItems
      )
    );
    results.push(
      _result(
        'الكميات المرتجعة',
        retQtyIssues.length ? 'error' : 'ok',
        retQtyIssues.length ? `${retQtyIssues.length} سطر كميته المرتجعة أكبر من المباعة` : 'كل الكميات المرتجعة سليمة',
        retQtyIssues
      )
    );

    /* ---------- المرتجعات بلا فاتورة ---------- */
    const returns = await DB.getAll('returns');
    const invNums = new Set(Object.keys(numCount));
    const orphanReturns = returns.filter((rr) => !invNums.has(rr.invoiceNumber));
    results.push(
      _result(
        'مرتجعات بلا فاتورة أصلية',
        orphanReturns.length ? 'error' : 'ok',
        orphanReturns.length ? `${orphanReturns.length} مرتجع بلا فاتورة` : 'كل المرتجعات مرتبطة بفواتير',
        orphanReturns.map((rr) => `مرتجع #${rr.id} → فاتورة ${rr.invoiceNumber}`)
      )
    );

    /* ---------- سلامة قاعدة البيانات ---------- */
    const counts = {};
    for (const store of Object.keys(DB.STORES)) counts[store] = await DB.count(store);
    results.push(
      _result(
        'جداول قاعدة البيانات',
        'ok',
        `كل الجداول متاحة (${Object.keys(DB.STORES).length} جدول)`,
        Object.entries(counts).map(([k, v]) => `${k}: ${v.toLocaleString('ar-EG')} سجل`)
      )
    );

    const settings = await DB.get('settings', 'app');
    results.push(
      _result(
        'الإعدادات',
        settings ? 'ok' : 'warning',
        settings ? 'الإعدادات موجودة' : 'إعدادات النظام غير موجودة (ستُنشأ افتراضيًا)',
        []
      )
    );

    const managers = (await DB.getAll('users')).filter((u) => u.role === 'manager' && u.active);
    results.push(
      _result(
        'حساب المدير',
        managers.length ? 'ok' : 'error',
        managers.length ? `${managers.length} مدير نشط` : 'لا يوجد مدير نشط! النظام معرّض للقفل',
        []
      )
    );

    return results;
  }

  /* ===================================================================
   * الواجهة
   * =================================================================== */
  function render(content) {
    if (!Auth.isManager()) {
      content.innerHTML =
        '<div class="placeholder"><div class="placeholder-icon">🔒</div><p>فحص النظام للمدير فقط.</p></div>';
      return;
    }
    content.innerHTML = `
      <div class="toolbar">
        <h3 style="flex:1;margin:0">فحص سلامة النظام</h3>
        <button class="btn btn-primary" id="hc-run">🩺 بدء الفحص</button>
      </div>
      <p class="form-note">فحص تشخيصي للقراءة فقط — لا يعدّل أي بيانات.</p>
      <div id="hc-result"></div>`;

    content.querySelector('#hc-run').onclick = async () => {
      const out = content.querySelector('#hc-result');
      out.innerHTML = '<div class="loading">جارٍ الفحص…</div>';
      try {
        const results = await runChecks();
        _renderResults(out, results);
      } catch (err) {
        out.innerHTML = '<div class="fatal">تعذّر إكمال الفحص: ' + Utils.escapeHtml(err.message) + '</div>';
      }
    };
  }

  function _renderResults(out, results) {
    const errors = results.filter((r) => r.status === 'error').length;
    const warns = results.filter((r) => r.status === 'warning').length;
    const oks = results.filter((r) => r.status === 'ok').length;

    const overall =
      errors > 0
        ? `<div class="alert alert-danger">⚠️ يوجد ${errors} مشكلة حرجة تحتاج مراجعة.</div>`
        : warns > 0
        ? `<div class="alert alert-warn">يوجد ${warns} تنبيه — النظام سليم بشكل عام.</div>`
        : `<div class="alert alert-ok">✅ النظام سليم تمامًا — لا توجد مشاكل.</div>`;

    out.innerHTML =
      overall +
      `<div class="hc-meta">نجح: ${oks} · تنبيهات: ${warns} · أخطاء: ${errors}</div>` +
      results
        .map((r) => {
          const icon = r.status === 'ok' ? '✅' : r.status === 'warning' ? '⚠️' : '❌';
          const details =
            r.details && r.details.length
              ? `<ul class="hc-details">${r.details
                  .slice(0, 50)
                  .map((d) => `<li>${Utils.escapeHtml(d)}</li>`)
                  .join('')}${
                  r.details.length > 50 ? `<li>… و${r.details.length - 50} أخرى</li>` : ''
                }</ul>`
              : '';
          return `<div class="hc-item hc-${r.status}">
            <div class="hc-head"><span class="hc-icon">${icon}</span>
              <strong>${Utils.escapeHtml(r.name)}</strong>
              <span class="hc-msg">${Utils.escapeHtml(r.message)}</span></div>
            ${details}
          </div>`;
        })
        .join('');
  }

  return { render, runChecks };
})();

window.Health = Health;
