/* =====================================================================
 * products.js  —  نظام المنتجات (المرحلة 2)
 * - إضافة / تعديل / أرشفة منتج (لا حذف فعلي).
 * - توليد SKU تلقائي و Barcode تلقائي (EAN-13).
 * - البحث بالاسم / SKU / Barcode + الفلاتر (التصنيف، المورد، الحالة، الناقص).
 * - إدارة التصنيفات والموردين للاستخدام في الفلاتر والاقتراحات.
 * - دوال مساعدة للبيع (findByBarcode / findBySku) للمراحل القادمة.
 * ===================================================================== */

const Products = (() => {
  let _cache = []; // نسخة في الذاكرة لسرعة البحث/الفلترة مع آلاف المنتجات
  let _filters = { q: '', category: '', supplier: '', status: 'active', lowStock: false };

  /* ---------- توليد المعرّفات ---------- */

  async function _genSku() {
    const n = await DB.nextCounter('sku');
    return 'SKU-' + String(n).padStart(6, '0');
  }

  function _ean13CheckDigit(d12) {
    let sum = 0;
    for (let i = 0; i < 12; i++) {
      const n = Number(d12[i]);
      sum += i % 2 === 0 ? n : n * 3;
    }
    return (10 - (sum % 10)) % 10;
  }

  async function _genBarcode() {
    // EAN-13 بادئة 200 (استخدام داخلي) + 9 أرقام تسلسلية + رقم تحقق.
    const n = await DB.nextCounter('barcode');
    const base = '200' + String(n).padStart(9, '0'); // 12 رقمًا
    return base + String(_ean13CheckDigit(base));
  }

  /* ---------- التصنيفات والموردين ---------- */

  async function _ensureLookup(store, name) {
    const v = String(name || '').trim();
    if (!v) return;
    const existing = await DB.getOneByIndex(store, 'name', v);
    if (!existing) {
      try {
        await DB.add(store, { name: v, createdAt: Date.now() });
      } catch (e) {
        /* تجاهل التكرار في حال السباق */
      }
    }
  }

  async function getCategories() {
    const rows = await DB.getAll('categories');
    return rows.map((r) => r.name).sort((a, b) => a.localeCompare(b, 'ar'));
  }
  async function getSuppliers() {
    const rows = await DB.getAll('suppliers');
    return rows.map((r) => r.name).sort((a, b) => a.localeCompare(b, 'ar'));
  }

  /* ---------- العمليات على المنتجات ---------- */

  async function reload() {
    _cache = await DB.getAll('products');
    return _cache;
  }

  function computeProfit(sale, cost) {
    return Math.round(((Number(sale) || 0) - (Number(cost) || 0)) * 100) / 100;
  }

  async function addProduct(data) {
    const name = String(data.name || '').trim();
    if (!name) throw new Error('اسم المنتج مطلوب');

    const sku = await _genSku();
    let barcode = String(data.barcode || '').trim();
    if (!barcode) barcode = await _genBarcode();

    const cost = Number(data.costPrice) || 0;
    const sale = Number(data.salePrice) || 0;

    const product = {
      name,
      sku,
      barcode,
      category: String(data.category || '').trim(),
      supplier: String(data.supplier || '').trim(),
      costPrice: cost,
      salePrice: sale,
      profit: computeProfit(sale, cost),
      stock: Number(data.stock) || 0,
      alertLevel: Number(data.alertLevel) || 0,
      lastPurchaseDate: data.lastPurchaseDate || null,
      notes: String(data.notes || '').trim(),
      archived: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    await _ensureLookup('categories', product.category);
    await _ensureLookup('suppliers', product.supplier);

    let id;
    try {
      id = await DB.add('products', product);
    } catch (e) {
      if (e && e.name === 'ConstraintError') {
        throw new Error('الباركود مستخدم بالفعل لمنتج آخر');
      }
      throw e;
    }
    product.id = id;
    await Audit.log('product.add', 'product', id, null, product);
    await reload();
    return product;
  }

  async function updateProduct(id, data) {
    const old = await DB.get('products', id);
    if (!old) throw new Error('المنتج غير موجود');

    const cost = Number(data.costPrice) || 0;
    const sale = Number(data.salePrice) || 0;
    const barcode = String(data.barcode || '').trim() || old.barcode;

    const updated = Object.assign({}, old, {
      name: String(data.name || '').trim() || old.name,
      barcode,
      category: String(data.category || '').trim(),
      supplier: String(data.supplier || '').trim(),
      costPrice: cost,
      salePrice: sale,
      profit: computeProfit(sale, cost),
      stock: Number(data.stock) || 0,
      alertLevel: Number(data.alertLevel) || 0,
      lastPurchaseDate: data.lastPurchaseDate || old.lastPurchaseDate || null,
      notes: String(data.notes || '').trim(),
      updatedAt: Date.now(),
    });

    await _ensureLookup('categories', updated.category);
    await _ensureLookup('suppliers', updated.supplier);

    try {
      await DB.put('products', updated);
    } catch (e) {
      if (e && e.name === 'ConstraintError') {
        throw new Error('الباركود مستخدم بالفعل لمنتج آخر');
      }
      throw e;
    }
    await Audit.log('product.edit', 'product', id, old, updated);
    await reload();
    return updated;
  }

  async function setArchived(id, archived) {
    const old = await DB.get('products', id);
    if (!old) throw new Error('المنتج غير موجود');
    const updated = Object.assign({}, old, {
      archived: archived ? 1 : 0,
      updatedAt: Date.now(),
    });
    await DB.put('products', updated);
    await Audit.log(archived ? 'product.archive' : 'product.restore', 'product', id, old, updated);
    await reload();
    return updated;
  }

  /* ---------- دوال مساعدة للبيع (مراحل لاحقة) ---------- */
  function findByBarcode(barcode) {
    return DB.getOneByIndex('products', 'barcode', String(barcode).trim());
  }
  function findBySku(sku) {
    return DB.getOneByIndex('products', 'sku', String(sku).trim());
  }

  /* ---------- الفلترة والبحث ---------- */
  function _applyFilters() {
    const f = _filters;
    const q = f.q.trim().toLowerCase();
    return _cache.filter((p) => {
      if (f.status === 'active' && p.archived) return false;
      if (f.status === 'archived' && !p.archived) return false;
      if (f.category && p.category !== f.category) return false;
      if (f.supplier && p.supplier !== f.supplier) return false;
      if (f.lowStock && !(p.stock <= p.alertLevel)) return false;
      if (q) {
        const hay = (p.name + ' ' + p.sku + ' ' + p.barcode).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }

  /* ===================================================================
   * الواجهة
   * =================================================================== */

  async function render(content) {
    content.innerHTML = '<div class="loading">جارٍ تحميل المنتجات…</div>';
    await reload();
    const categories = await getCategories();
    const suppliers = await getSuppliers();

    content.innerHTML = `
      <div class="toolbar">
        <input type="search" id="prod-search" class="search-input"
               placeholder="بحث بالاسم أو SKU أو الباركود…" value="${Utils.escapeHtml(_filters.q)}" />
        <select id="prod-cat" class="filter-select">
          <option value="">كل التصنيفات</option>
          ${categories
            .map(
              (c) =>
                `<option value="${Utils.escapeHtml(c)}" ${
                  _filters.category === c ? 'selected' : ''
                }>${Utils.escapeHtml(c)}</option>`
            )
            .join('')}
        </select>
        <select id="prod-sup" class="filter-select">
          <option value="">كل الموردين</option>
          ${suppliers
            .map(
              (s) =>
                `<option value="${Utils.escapeHtml(s)}" ${
                  _filters.supplier === s ? 'selected' : ''
                }>${Utils.escapeHtml(s)}</option>`
            )
            .join('')}
        </select>
        <select id="prod-status" class="filter-select">
          <option value="active" ${_filters.status === 'active' ? 'selected' : ''}>النشطة</option>
          <option value="archived" ${_filters.status === 'archived' ? 'selected' : ''}>المؤرشفة</option>
          <option value="all" ${_filters.status === 'all' ? 'selected' : ''}>الكل</option>
        </select>
        <label class="chk-inline">
          <input type="checkbox" id="prod-low" ${_filters.lowStock ? 'checked' : ''} /> الناقص فقط
        </label>
        <button class="btn btn-primary" id="prod-add">+ إضافة منتج</button>
      </div>
      <div id="prod-table-wrap"></div>`;

    const search = content.querySelector('#prod-search');
    const reRender = () => _renderTable(content.querySelector('#prod-table-wrap'));

    search.oninput = () => {
      _filters.q = search.value;
      reRender();
    };
    content.querySelector('#prod-cat').onchange = (e) => {
      _filters.category = e.target.value;
      reRender();
    };
    content.querySelector('#prod-sup').onchange = (e) => {
      _filters.supplier = e.target.value;
      reRender();
    };
    content.querySelector('#prod-status').onchange = (e) => {
      _filters.status = e.target.value;
      reRender();
    };
    content.querySelector('#prod-low').onchange = (e) => {
      _filters.lowStock = e.target.checked;
      reRender();
    };
    content.querySelector('#prod-add').onclick = () => openForm(null, content);

    reRender();
    setTimeout(() => search.focus(), 50);
  }

  function _renderTable(wrap) {
    const rows = _applyFilters();
    if (!rows.length) {
      wrap.innerHTML = `<div class="placeholder"><div class="placeholder-icon">📦</div>
        <p>لا توجد منتجات مطابقة. اضغط "إضافة منتج" للبدء.</p></div>`;
      return;
    }
    rows.sort((a, b) => b.updatedAt - a.updatedAt);

    wrap.innerHTML = `
      <div class="table-meta">عدد النتائج: ${rows.length.toLocaleString('ar-EG')}</div>
      <div class="table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            <th>SKU</th><th>الباركود</th><th>الاسم</th><th>التصنيف</th><th>المورد</th>
            <th>شراء</th><th>بيع</th><th>الربح</th><th>المخزون</th><th>الحالة</th><th>إجراءات</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map(_rowHtml).join('')}
        </tbody>
      </table>
      </div>`;

    wrap.querySelectorAll('[data-edit]').forEach((b) => {
      b.onclick = () => {
        const p = _cache.find((x) => x.id === Number(b.dataset.edit));
        openForm(p, document.getElementById('content'));
      };
    });
    wrap.querySelectorAll('[data-barcode]').forEach((b) => {
      b.onclick = () => {
        const p = _cache.find((x) => x.id === Number(b.dataset.barcode));
        if (p) _openBarcodeDialog(p);
      };
    });
    wrap.querySelectorAll('[data-archive]').forEach((b) => {
      b.onclick = async () => {
        const id = Number(b.dataset.archive);
        const p = _cache.find((x) => x.id === id);
        const toArchive = !p.archived;
        const ok = await Utils.confirmBox(
          toArchive ? `أرشفة المنتج "${p.name}"؟` : `استرجاع المنتج "${p.name}"؟`
        );
        if (!ok) return;
        await setArchived(id, toArchive);
        Utils.toast(toArchive ? 'تمت الأرشفة' : 'تم الاسترجاع', 'success');
        _renderTable(wrap);
      };
    });
  }

  /* ---------- طباعة ملصق باركود لمنتج ---------- */
  async function _openBarcodeDialog(p) {
    const settings = await Settings.getApp();
    const overlay = Utils.el(`
      <div class="modal-overlay"><div class="modal">
        <div class="modal-header">طباعة باركود — ${Utils.escapeHtml(p.name)}</div>
        <div class="modal-body">
          <div class="bc-preview">${Barcode.svg(p.barcode, { height: 50 })}
            <div class="mono" style="text-align:center;letter-spacing:2px">${Utils.escapeHtml(
              p.barcode
            )}</div>
            <div style="text-align:center;font-weight:bold">${Utils.money(p.salePrice)}</div>
          </div>
          <label class="field">عدد الملصقات
            <input type="number" id="bc-qty" min="1" max="500" value="1" />
          </label>
          <p class="form-note">المقاس الحالي ${Number(settings.labelWidthMm)}×${Number(
      settings.labelHeightMm
    )}مم — يمكن تغييره من الإعدادات.</p>
        </div>
        <div class="modal-footer">
          <button class="btn btn-ghost" data-act="cancel">إلغاء</button>
          <button class="btn btn-primary" data-act="print">طباعة</button>
        </div>
      </div></div>`);
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelector('[data-act="cancel"]').onclick = close;
    overlay.addEventListener('click', (e) => e.target === overlay && close());
    overlay.querySelector('[data-act="print"]').onclick = () => {
      const qty = Math.max(1, Math.min(500, Math.floor(Number(overlay.querySelector('#bc-qty').value) || 1)));
      const labels = [];
      for (let i = 0; i < qty; i++)
        labels.push({ name: p.name, price: p.salePrice, barcode: p.barcode });
      Labels.print(labels, settings);
      close();
    };
  }

  function _rowHtml(p) {
    const low = p.stock <= p.alertLevel;
    return `
      <tr class="${p.archived ? 'row-archived' : ''}">
        <td class="mono">${Utils.escapeHtml(p.sku)}</td>
        <td class="mono">${Utils.escapeHtml(p.barcode)}</td>
        <td>${Utils.escapeHtml(p.name)}</td>
        <td>${Utils.escapeHtml(p.category || '-')}</td>
        <td>${Utils.escapeHtml(p.supplier || '-')}</td>
        <td>${Utils.money(p.costPrice)}</td>
        <td>${Utils.money(p.salePrice)}</td>
        <td>${Utils.money(p.profit)}</td>
        <td><span class="${low ? 'stock-low' : ''}">${Number(p.stock).toLocaleString('ar-EG')}</span>
          ${low ? '<span class="tag tag-warn">ناقص</span>' : ''}</td>
        <td>${p.archived ? '<span class="tag tag-muted">مؤرشف</span>' : '<span class="tag tag-ok">نشط</span>'}</td>
        <td class="actions-cell">
          <button class="btn btn-sm btn-ghost" data-edit="${p.id}">تعديل</button>
          <button class="btn btn-sm btn-ghost" data-barcode="${p.id}">باركود</button>
          <button class="btn btn-sm btn-ghost" data-archive="${p.id}">${
      p.archived ? 'استرجاع' : 'أرشفة'
    }</button>
        </td>
      </tr>`;
  }

  /* ---------- نموذج إضافة/تعديل ---------- */
  async function openForm(product, content) {
    const isEdit = !!product;
    const categories = await getCategories();
    const suppliers = await getSuppliers();
    const p = product || {};

    const overlay = Utils.el(`
      <div class="modal-overlay">
        <div class="modal modal-lg">
          <div class="modal-header">${isEdit ? 'تعديل منتج' : 'إضافة منتج'}</div>
          <form class="modal-body form-grid" id="prod-form">
            <label>اسم المنتج *
              <input name="name" required value="${Utils.escapeHtml(p.name || '')}" />
            </label>
            <label>الباركود ${isEdit ? '' : '(يُولّد تلقائيًا إن تُرك فارغًا)'}
              <input name="barcode" class="mono" value="${Utils.escapeHtml(p.barcode || '')}" />
            </label>
            <label>التصنيف
              <input name="category" list="cat-list" value="${Utils.escapeHtml(p.category || '')}" />
              <datalist id="cat-list">${categories
                .map((c) => `<option value="${Utils.escapeHtml(c)}">`)
                .join('')}</datalist>
            </label>
            <label>المورد
              <input name="supplier" list="sup-list" value="${Utils.escapeHtml(p.supplier || '')}" />
              <datalist id="sup-list">${suppliers
                .map((s) => `<option value="${Utils.escapeHtml(s)}">`)
                .join('')}</datalist>
            </label>
            <label>سعر الشراء
              <input name="costPrice" type="number" step="0.01" min="0" value="${Number(p.costPrice) || 0}" />
            </label>
            <label>سعر البيع
              <input name="salePrice" type="number" step="0.01" min="0" value="${Number(p.salePrice) || 0}" />
            </label>
            <label>الربح المتوقع
              <input id="prod-profit" type="text" readonly value="" />
            </label>
            <label>المخزون
              <input name="stock" type="number" step="1" min="0" value="${Number(p.stock) || 0}" />
            </label>
            <label>حد التنبيه
              <input name="alertLevel" type="number" step="1" min="0" value="${Number(p.alertLevel) || 0}" />
            </label>
            <label>تاريخ آخر شراء
              <input name="lastPurchaseDate" type="date" value="${p.lastPurchaseDate || ''}" />
            </label>
            <label class="span-2">ملاحظات
              <textarea name="notes" rows="2">${Utils.escapeHtml(p.notes || '')}</textarea>
            </label>
            ${
              isEdit
                ? `<div class="form-note span-2">SKU: <span class="mono">${Utils.escapeHtml(
                    p.sku
                  )}</span> (ثابت ولا يتغيّر)</div>`
                : ''
            }
            <div class="form-error span-2" id="prod-form-error"></div>
          </form>
          <div class="modal-footer">
            <button class="btn btn-ghost" data-act="cancel">إلغاء</button>
            <button class="btn btn-primary" data-act="save">${
              isEdit ? 'حفظ التعديلات' : 'إضافة'
            }</button>
          </div>
        </div>
      </div>`);

    document.body.appendChild(overlay);
    const form = overlay.querySelector('#prod-form');
    const profitField = overlay.querySelector('#prod-profit');
    const updateProfit = () => {
      const v = computeProfit(form.salePrice.value, form.costPrice.value);
      profitField.value = Utils.money(v);
    };
    form.costPrice.oninput = updateProfit;
    form.salePrice.oninput = updateProfit;
    updateProfit();

    const close = () => overlay.remove();
    overlay.querySelector('[data-act="cancel"]').onclick = close;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) close();
    });

    overlay.querySelector('[data-act="save"]').onclick = async () => {
      if (!form.reportValidity()) return;
      const data = Object.fromEntries(new FormData(form).entries());
      try {
        if (isEdit) {
          // تعديل الأسعار عملية حساسة تتطلب موافقة المدير
          const priceChanged =
            Number(data.salePrice) !== Number(p.salePrice) ||
            Number(data.costPrice) !== Number(p.costPrice);
          if (priceChanged) {
            const appr = await Utils.requireManagerApproval('تعديل أسعار المنتج: ' + p.name);
            if (!appr.ok) {
              overlay.querySelector('#prod-form-error').textContent =
                'تعديل الأسعار يتطلب موافقة المدير';
              return;
            }
          }
          await updateProduct(p.id, data);
          Utils.toast('تم حفظ التعديلات', 'success');
        } else {
          const created = await addProduct(data);
          Utils.toast('تمت إضافة المنتج: ' + created.sku, 'success');
        }
        close();
        render(content);
      } catch (err) {
        overlay.querySelector('#prod-form-error').textContent = err.message;
      }
    };

    setTimeout(() => form.name.focus(), 50);
  }

  return {
    render,
    reload,
    addProduct,
    updateProduct,
    setArchived,
    findByBarcode,
    findBySku,
    getCategories,
    getSuppliers,
    computeProfit,
  };
})();

window.Products = Products;
