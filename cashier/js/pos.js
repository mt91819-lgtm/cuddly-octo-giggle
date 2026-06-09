/* =====================================================================
 * pos.js  —  نقطة البيع (المرحلة 3)
 * - شاشة بيع احترافية، بحث سريع (اسم / SKU / باركود).
 * - دعم ماسح الباركود USB (يكتب الرقم + Enter) مع زيادة الكمية تلقائيًا
 *   عند تكرار مسح نفس المنتج.
 * - سلة: تعديل كمية، حذف عنصر، خصم لكل سطر، خصم على الفاتورة، ملاحظات.
 * - طرق الدفع: كاش / Instapay / Wallet.
 * - رقم فاتورة فريد بصيغة L-YYYYMMDD-0001 (لا يتكرر).
 * - طباعة 58mm / 80mm / A4.
 * ===================================================================== */

const POS = (() => {
  let _products = []; // المنتجات النشطة (للبحث السريع)
  let _cart = []; // عناصر السلة
  let _invoiceDiscount = 0;
  let _note = '';
  let _payment = 'cash';
  let _paid = 0;
  let _appSettings = null;

  /* ---------- رقم الفاتورة ---------- */
  async function genInvoiceNumber() {
    const dk = Utils.dateKey();
    const seq = await DB.nextDailyInvoiceSeq(dk);
    return 'L-' + dk + '-' + String(seq).padStart(4, '0');
  }

  /* ---------- السلة ---------- */
  function _findLine(productId) {
    return _cart.find((c) => c.productId === productId);
  }

  function _qtyInCart(productId) {
    const line = _findLine(productId);
    return line ? line.qty : 0;
  }

  function addToCart(product, qty = 1) {
    if (!product) return;
    if (_appSettings.blockSaleWhenOutOfStock) {
      const wanted = _qtyInCart(product.id) + qty;
      if (wanted > Number(product.stock)) {
        Utils.toast('المخزون غير كافٍ: ' + product.name + ' (متاح ' + product.stock + ')', 'error');
        return;
      }
    }
    const line = _findLine(product.id);
    if (line) {
      line.qty += qty; // زيادة الكمية تلقائيًا عند تكرار المسح
    } else {
      _cart.push({
        productId: product.id,
        name: product.name,
        sku: product.sku,
        barcode: product.barcode,
        unitPrice: Number(product.salePrice) || 0,
        unitCost: Number(product.costPrice) || 0,
        qty: qty,
        lineDiscount: 0,
        stock: Number(product.stock) || 0,
      });
    }
    _renderCart();
  }

  function changeQty(productId, qty) {
    const line = _findLine(productId);
    if (!line) return;
    qty = Math.max(0, Math.floor(qty));
    if (_appSettings.blockSaleWhenOutOfStock && qty > line.stock) {
      Utils.toast('المخزون المتاح: ' + line.stock, 'error');
      qty = line.stock;
    }
    if (qty === 0) {
      removeLine(productId);
      return;
    }
    line.qty = qty;
    _renderCart();
  }

  function setLineDiscount(productId, disc) {
    const line = _findLine(productId);
    if (!line) return;
    const max = line.unitPrice * line.qty;
    line.lineDiscount = Math.min(Math.max(0, Number(disc) || 0), max);
    _renderCart();
  }

  function removeLine(productId) {
    _cart = _cart.filter((c) => c.productId !== productId);
    _renderCart();
  }

  function clearCart() {
    _cart = [];
    _invoiceDiscount = 0;
    _note = '';
    _paid = 0;
    _renderCart();
  }

  /* ---------- الحسابات ---------- */
  function totals() {
    let subtotal = 0;
    let lineDiscounts = 0;
    let totalCost = 0;
    _cart.forEach((c) => {
      subtotal += c.unitPrice * c.qty;
      lineDiscounts += c.lineDiscount;
      totalCost += c.unitCost * c.qty;
    });
    const invDisc = Math.min(Math.max(0, _invoiceDiscount), Math.max(0, subtotal - lineDiscounts));
    const totalDiscount = lineDiscounts + invDisc;
    const total = Math.max(0, subtotal - totalDiscount);
    const profit = Math.round((total - totalCost) * 100) / 100;
    return { subtotal, lineDiscounts, invDisc, totalDiscount, total, totalCost, profit };
  }

  /* ---------- إتمام البيع ---------- */
  async function checkout() {
    if (!_cart.length) {
      Utils.toast('السلة فارغة', 'error');
      return null;
    }
    const t = totals();
    if (_payment === 'cash' && _paid && _paid < t.total) {
      const ok = await Utils.confirmBox('المبلغ المدفوع أقل من الإجمالي. إتمام البيع كدفع جزئي/آجل؟');
      if (!ok) return null;
    }

    const number = await genInvoiceNumber();
    const user = Auth.currentUser();
    const shiftId =
      window.Shifts && Shifts.getOpenShiftId ? await Shifts.getOpenShiftId() : null;

    const items = _cart.map((c) => ({
      productId: c.productId,
      name: c.name,
      sku: c.sku,
      barcode: c.barcode,
      qty: c.qty,
      unitPrice: c.unitPrice,
      unitCost: c.unitCost,
      lineDiscount: c.lineDiscount,
      lineTotal: Math.max(0, c.unitPrice * c.qty - c.lineDiscount),
      returnedQty: 0,
    }));

    const paid = _payment === 'cash' && _paid ? _paid : t.total;
    const change = Math.max(0, paid - t.total);

    const invoice = {
      number,
      items,
      subtotal: t.subtotal,
      lineDiscounts: t.lineDiscounts,
      invoiceDiscount: t.invDisc,
      totalDiscount: t.totalDiscount,
      total: t.total,
      totalCost: t.totalCost,
      profit: t.profit,
      paymentMethod: _payment,
      paidAmount: paid,
      change,
      note: _note,
      status: 'Completed',
      userId: user ? user.id : null,
      userName: user ? user.name : '',
      shiftId,
      createdAt: Date.now(),
    };

    let id;
    try {
      id = await DB.add('invoices', invoice);
    } catch (e) {
      if (e && e.name === 'ConstraintError') {
        // تعارض نادر في رقم الفاتورة — إعادة التوليد مرة واحدة
        invoice.number = await genInvoiceNumber();
        id = await DB.add('invoices', invoice);
      } else {
        throw e;
      }
    }
    invoice.id = id;

    // خصم المخزون وتسجيل الحركات
    for (const it of items) {
      await Inventory.applyMovement({
        productId: it.productId,
        delta: -it.qty,
        type: 'sale',
        reason: 'بيع فاتورة ' + invoice.number,
        refType: 'invoice',
        refId: id,
      });
    }

    // حركة نقدية للكاش (تُستخدم في تقارير الورديات بالمرحلة 8)
    if (_payment === 'cash') {
      await DB.add('cash_movements', {
        shiftId,
        type: 'sale',
        amount: t.total,
        refType: 'invoice',
        refId: id,
        note: 'بيع ' + invoice.number,
        userId: user ? user.id : null,
        createdAt: Date.now(),
      });
    }

    await Audit.log('sale.create', 'invoice', id, null, invoice);
    return invoice;
  }

  /* ===================================================================
   * الواجهة
   * =================================================================== */
  async function render(content) {
    content.innerHTML = '<div class="loading">جارٍ تجهيز شاشة البيع…</div>';
    _appSettings = await Settings.getApp();
    _products = (await DB.getAll('products')).filter((p) => !p.archived);

    content.innerHTML = `
      <div class="pos">
        <div class="pos-left">
          <div class="pos-search-row">
            <input type="search" id="pos-search" class="search-input"
              placeholder="امسح الباركود أو ابحث بالاسم / SKU ثم Enter…" autocomplete="off" />
            <button class="btn btn-ghost" id="pos-clear">إفراغ السلة</button>
          </div>
          <div id="pos-results" class="pos-results"></div>
        </div>
        <div class="pos-right">
          <div class="cart-head">🛒 السلة</div>
          <div id="cart-items" class="cart-items"></div>
          <div class="cart-summary" id="cart-summary"></div>
        </div>
      </div>`;

    const search = content.querySelector('#pos-search');
    const results = content.querySelector('#pos-results');

    const showResults = (q) => {
      q = q.trim().toLowerCase();
      if (!q) {
        results.innerHTML =
          '<div class="pos-hint">ابدأ بالبحث أو امسح الباركود. (Enter يضيف المطابقة المباشرة)</div>';
        return;
      }
      const matches = _products
        .filter((p) => (p.name + ' ' + p.sku + ' ' + p.barcode).toLowerCase().includes(q))
        .slice(0, 50);
      if (!matches.length) {
        results.innerHTML = '<div class="pos-hint">لا توجد نتائج.</div>';
        return;
      }
      results.innerHTML = matches
        .map(
          (p) => `
        <button class="pos-result" data-id="${p.id}">
          <div class="pr-name">${Utils.escapeHtml(p.name)}</div>
          <div class="pr-meta"><span class="mono">${Utils.escapeHtml(p.sku)}</span> · ${Utils.money(
            p.salePrice
          )} · مخزون ${p.stock}</div>
        </button>`
        )
        .join('');
      results.querySelectorAll('.pos-result').forEach((b) => {
        b.onclick = () => {
          const p = _products.find((x) => x.id === Number(b.dataset.id));
          addToCart(p);
        };
      });
    };

    search.oninput = () => showResults(search.value);
    search.onkeydown = async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const q = search.value.trim();
      if (!q) return;
      let prod = _products.find((p) => p.barcode === q) || _products.find((p) => p.sku === q);
      if (!prod) {
        const lc = q.toLowerCase();
        const m = _products.filter((p) =>
          (p.name + ' ' + p.sku + ' ' + p.barcode).toLowerCase().includes(lc)
        );
        if (m.length === 1) prod = m[0];
        else if (m.length > 1) {
          showResults(q);
          return;
        }
      }
      if (prod) {
        addToCart(prod);
        search.value = '';
        showResults('');
      } else {
        Utils.toast('لا يوجد منتج مطابق', 'error');
      }
    };

    content.querySelector('#pos-clear').onclick = async () => {
      if (!_cart.length) return;
      if (await Utils.confirmBox('إفراغ السلة؟')) clearCart();
    };

    showResults('');
    _renderCart();
    setTimeout(() => search.focus(), 60);
  }

  function _renderCart() {
    const itemsWrap = document.getElementById('cart-items');
    const summaryWrap = document.getElementById('cart-summary');
    if (!itemsWrap || !summaryWrap) return;

    if (!_cart.length) {
      itemsWrap.innerHTML = '<div class="cart-empty">السلة فارغة</div>';
    } else {
      itemsWrap.innerHTML = _cart
        .map(
          (c) => `
        <div class="cart-line" data-id="${c.productId}">
          <div class="cl-top">
            <span class="cl-name">${Utils.escapeHtml(c.name)}</span>
            <button class="cl-remove" data-remove="${c.productId}" title="حذف">✕</button>
          </div>
          <div class="cl-controls">
            <div class="qty-box">
              <button data-dec="${c.productId}">−</button>
              <input type="number" min="0" value="${c.qty}" data-qty="${c.productId}" />
              <button data-inc="${c.productId}">+</button>
            </div>
            <span class="cl-price">${Utils.money(c.unitPrice)}</span>
            <input type="number" min="0" step="0.01" class="cl-disc" placeholder="خصم"
              value="${c.lineDiscount || ''}" data-disc="${c.productId}" title="خصم السطر" />
            <span class="cl-total">${Utils.money(Math.max(0, c.unitPrice * c.qty - c.lineDiscount))}</span>
          </div>
        </div>`
        )
        .join('');

      itemsWrap.querySelectorAll('[data-inc]').forEach((b) => {
        b.onclick = () => changeQty(Number(b.dataset.inc), _findLine(Number(b.dataset.inc)).qty + 1);
      });
      itemsWrap.querySelectorAll('[data-dec]').forEach((b) => {
        b.onclick = () => changeQty(Number(b.dataset.dec), _findLine(Number(b.dataset.dec)).qty - 1);
      });
      itemsWrap.querySelectorAll('[data-qty]').forEach((inp) => {
        inp.onchange = () => changeQty(Number(inp.dataset.qty), Number(inp.value));
      });
      itemsWrap.querySelectorAll('[data-disc]').forEach((inp) => {
        inp.onchange = () => setLineDiscount(Number(inp.dataset.disc), inp.value);
      });
      itemsWrap.querySelectorAll('[data-remove]').forEach((b) => {
        b.onclick = () => removeLine(Number(b.dataset.remove));
      });
    }

    const t = totals();
    const change = _payment === 'cash' && _paid ? Math.max(0, _paid - t.total) : 0;
    summaryWrap.innerHTML = `
      <div class="sum-row"><span>الإجمالي الفرعي</span><span>${Utils.money(t.subtotal)}</span></div>
      <div class="sum-row"><span>خصومات الأصناف</span><span>${Utils.money(t.lineDiscounts)}</span></div>
      <div class="sum-row sum-disc">
        <span>خصم على الفاتورة</span>
        <input type="number" min="0" step="0.01" id="inv-disc" value="${_invoiceDiscount || ''}" placeholder="0" />
      </div>
      <div class="sum-row sum-total"><span>الإجمالي</span><span>${Utils.money(t.total)}</span></div>

      <div class="pay-methods">
        ${['cash', 'instapay', 'wallet']
          .map(
            (m) =>
              `<button class="pay-btn ${_payment === m ? 'active' : ''}" data-pay="${m}">${payLabel(
                m
              )}</button>`
          )
          .join('')}
      </div>
      <div class="pay-cash ${_payment === 'cash' ? '' : 'hidden'}">
        <label>المبلغ المدفوع
          <input type="number" min="0" step="0.01" id="paid-amount" value="${_paid || ''}" placeholder="${t.total.toFixed(
      2
    )}" />
        </label>
        <div class="sum-row"><span>الباقي</span><span id="change-val">${Utils.money(change)}</span></div>
      </div>
      <label class="inv-note">ملاحظة على الفاتورة
        <input type="text" id="inv-note" value="${Utils.escapeHtml(_note)}" placeholder="اختياري" />
      </label>
      <button class="btn btn-primary btn-block btn-checkout" id="checkout-btn">
        إتمام البيع · ${Utils.money(t.total)}
      </button>`;

    const invDisc = summaryWrap.querySelector('#inv-disc');
    invDisc.onchange = () => {
      _invoiceDiscount = Number(invDisc.value) || 0;
      _renderCart();
    };
    summaryWrap.querySelectorAll('[data-pay]').forEach((b) => {
      b.onclick = () => {
        _payment = b.dataset.pay;
        _renderCart();
      };
    });
    const paidInput = summaryWrap.querySelector('#paid-amount');
    if (paidInput) {
      paidInput.oninput = () => {
        _paid = Number(paidInput.value) || 0;
        const cv = summaryWrap.querySelector('#change-val');
        if (cv) cv.textContent = Utils.money(Math.max(0, _paid - totals().total));
      };
    }
    const noteInput = summaryWrap.querySelector('#inv-note');
    noteInput.oninput = () => {
      _note = noteInput.value;
    };
    summaryWrap.querySelector('#checkout-btn').onclick = _onCheckout;
  }

  function payLabel(m) {
    return m === 'cash' ? 'كاش 💵' : m === 'instapay' ? 'Instapay' : 'Wallet';
  }

  async function _onCheckout() {
    const btn = document.getElementById('checkout-btn');
    if (btn) btn.disabled = true;
    try {
      const invoice = await checkout();
      if (invoice) {
        Utils.toast('تم إتمام البيع: ' + invoice.number, 'success');
        clearCart();
        _afterSale(invoice);
        // إعادة تحميل المخزون المحلي بعد الخصم
        _products = (await DB.getAll('products')).filter((p) => !p.archived);
        const s = document.getElementById('pos-search');
        if (s) s.focus();
      }
    } catch (err) {
      console.error(err);
      Utils.toast('خطأ أثناء البيع: ' + err.message, 'error');
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  function _afterSale(invoice) {
    Utils.modal({
      title: 'تمت الفاتورة ' + invoice.number,
      bodyHtml: `
        <p>الإجمالي: <strong>${Utils.money(invoice.total)}</strong></p>
        <p>طريقة الدفع: ${payLabel(invoice.paymentMethod)}</p>
        ${invoice.change ? `<p>الباقي: ${Utils.money(invoice.change)}</p>` : ''}
        <p>هل تريد طباعة الإيصال؟</p>`,
      confirmText: 'طباعة',
      cancelText: 'إغلاق',
    }).then((v) => {
      if (v !== null) Receipt.print(invoice, _appSettings);
    });
  }

  return {
    render,
    addToCart,
    checkout,
    clearCart,
    totals,
    genInvoiceNumber,
  };
})();

window.POS = POS;
