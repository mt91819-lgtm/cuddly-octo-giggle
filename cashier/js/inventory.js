/* =====================================================================
 * inventory.js  —  المخزون والجرد (المرحلة 4)
 * النواة المشتركة (applyMovement) تُستخدم من البيع والمرتجعات والجرد.
 *
 * أنواع الحركة (type):
 *   sale       خصم بسبب بيع
 *   return     إضافة بسبب مرتجع
 *   purchase   إضافة مخزون (توريد)
 *   adjust     تعديل يدوي / جرد
 *
 * الواجهة (3 تبويبات):
 *   - المخزون: قائمة + إضافة/خصم/تعديل لكل منتج.
 *   - سجل الحركة: عرض كامل مع فلاتر (نوع/تاريخ/منتج) وتحميل بالـ cursor.
 *   - الجرد: ورقة جرد موحّدة بالكتابة أو بمسح الباركود ثم تطبيق الفروقات.
 * ===================================================================== */

const Inventory = (() => {
  let _tab = 'stock';
  let _countSession = []; // [{ productId, name, sku, system, counted }]
  let _productMap = null; // id -> product (للأسماء في السجل)

  /* ---------- النواة ---------- */
  async function applyMovement({ productId, delta, type, reason, refType, refId }) {
    const product = await DB.get('products', productId);
    if (!product) throw new Error('المنتج غير موجود (#' + productId + ')');

    const before = Number(product.stock) || 0;
    const after = before + Number(delta);
    product.stock = after;
    product.updatedAt = Date.now();
    if (type === 'purchase') product.lastPurchaseDate = new Date().toISOString().slice(0, 10);
    await DB.put('products', product);

    const user = (window.Auth && Auth.currentUser && Auth.currentUser()) || null;
    await DB.add('inventory_movements', {
      productId,
      type,
      qty: Number(delta),
      balanceBefore: before,
      balanceAfter: after,
      reason: reason || '',
      refType: refType || null,
      refId: refId != null ? refId : null,
      userId: user ? user.id : null,
      userName: user ? user.name : 'النظام',
      createdAt: Date.now(),
    });

    return { product, before, after };
  }

  /* ---------- عمليات يدوية (مع تسجيل في Audit) ---------- */
  async function manualMovement(productId, type, delta, reason) {
    if (!delta) throw new Error('الكمية يجب أن تكون أكبر من صفر');
    const res = await applyMovement({ productId, delta, type, reason, refType: 'manual' });
    await Audit.log(
      'inventory.' + type,
      'product',
      productId,
      { stock: res.before },
      { stock: res.after, delta, reason: reason || '' }
    );
    return res.product;
  }

  function addStock(productId, qty, reason) {
    return manualMovement(productId, 'purchase', Math.abs(Number(qty)), reason);
  }
  function deductStock(productId, qty, reason) {
    return manualMovement(productId, 'adjust', -Math.abs(Number(qty)), reason);
  }
  async function setStock(productId, newQty, reason) {
    const product = await DB.get('products', productId);
    if (!product) throw new Error('المنتج غير موجود');
    const delta = Number(newQty) - (Number(product.stock) || 0);
    if (delta === 0) return product;
    return manualMovement(productId, 'adjust', delta, reason || 'جرد');
  }

  function movementsOf(productId) {
    return DB.getByIndex('inventory_movements', 'productId', productId);
  }

  async function lowStockList() {
    const products = await DB.getAll('products');
    return products
      .filter((p) => !p.archived && Number(p.stock) <= Number(p.alertLevel))
      .sort((a, b) => a.stock - b.stock);
  }

  async function _loadProductMap() {
    const products = await DB.getAll('products');
    _productMap = {};
    products.forEach((p) => (_productMap[p.id] = p));
    return _productMap;
  }

  function typeLabel(t) {
    return (
      {
        sale: 'بيع',
        return: 'مرتجع',
        purchase: 'توريد',
        adjust: 'تعديل/جرد',
      }[t] || t
    );
  }

  /* ===================================================================
   * الواجهة
   * =================================================================== */
  function render(content) {
    content.innerHTML = `
      <div class="tabs">
        <button class="tab ${_tab === 'stock' ? 'active' : ''}" data-tab="stock">المخزون</button>
        <button class="tab ${_tab === 'log' ? 'active' : ''}" data-tab="log">سجل الحركة</button>
        <button class="tab ${_tab === 'count' ? 'active' : ''}" data-tab="count">الجرد</button>
      </div>
      <div id="inv-body"></div>`;
    content.querySelectorAll('.tab').forEach((b) => {
      b.onclick = () => {
        _tab = b.dataset.tab;
        render(content);
      };
    });
    const body = content.querySelector('#inv-body');
    if (_tab === 'stock') _renderStock(body);
    else if (_tab === 'log') _renderLog(body);
    else _renderCount(body);
  }

  /* ---------- تبويب المخزون ---------- */
  async function _renderStock(body) {
    body.innerHTML = '<div class="loading">جارٍ التحميل…</div>';
    const products = (await DB.getAll('products'))
      .filter((p) => !p.archived)
      .sort((a, b) => a.name.localeCompare(b.name, 'ar'));

    body.innerHTML = `
      <div class="toolbar">
        <input type="search" id="inv-search" class="search-input" placeholder="بحث بالاسم / SKU / باركود…" />
        <label class="chk-inline"><input type="checkbox" id="inv-low" /> الناقص فقط</label>
      </div>
      <div id="inv-stock-table"></div>`;

    const draw = () => {
      const q = body.querySelector('#inv-search').value.trim().toLowerCase();
      const lowOnly = body.querySelector('#inv-low').checked;
      const rows = products.filter((p) => {
        if (lowOnly && !(p.stock <= p.alertLevel)) return false;
        if (q && !(p.name + ' ' + p.sku + ' ' + p.barcode).toLowerCase().includes(q)) return false;
        return true;
      });
      const wrap = body.querySelector('#inv-stock-table');
      if (!rows.length) {
        wrap.innerHTML = '<div class="placeholder"><p>لا توجد منتجات مطابقة.</p></div>';
        return;
      }
      wrap.innerHTML = `
        <div class="table-meta">عدد المنتجات: ${rows.length.toLocaleString('ar-EG')}</div>
        <div class="table-scroll"><table class="data-table">
          <thead><tr><th>الاسم</th><th>SKU</th><th>المخزون</th><th>حد التنبيه</th><th>الحالة</th><th>إجراءات</th></tr></thead>
          <tbody>${rows
            .map((p) => {
              const low = p.stock <= p.alertLevel;
              return `<tr>
                <td>${Utils.escapeHtml(p.name)}</td>
                <td class="mono">${Utils.escapeHtml(p.sku)}</td>
                <td><strong class="${low ? 'stock-low' : ''}">${Number(p.stock).toLocaleString(
                'ar-EG'
              )}</strong></td>
                <td>${p.alertLevel}</td>
                <td>${low ? '<span class="tag tag-warn">ناقص</span>' : '<span class="tag tag-ok">جيد</span>'}</td>
                <td class="actions-cell">
                  <button class="btn btn-sm btn-ghost" data-add="${p.id}">+ إضافة</button>
                  <button class="btn btn-sm btn-ghost" data-deduct="${p.id}">− خصم</button>
                  <button class="btn btn-sm btn-ghost" data-set="${p.id}">تعديل</button>
                  <button class="btn btn-sm btn-ghost" data-hist="${p.id}">السجل</button>
                </td></tr>`;
            })
            .join('')}</tbody>
        </table></div>`;

      wrap.querySelectorAll('[data-add]').forEach((b) => {
        b.onclick = () => _opMovement(products.find((p) => p.id === +b.dataset.add), 'add', body);
      });
      wrap.querySelectorAll('[data-deduct]').forEach((b) => {
        b.onclick = () =>
          _opMovement(products.find((p) => p.id === +b.dataset.deduct), 'deduct', body);
      });
      wrap.querySelectorAll('[data-set]').forEach((b) => {
        b.onclick = () => _opMovement(products.find((p) => p.id === +b.dataset.set), 'set', body);
      });
      wrap.querySelectorAll('[data-hist]').forEach((b) => {
        b.onclick = () => _showHistory(products.find((p) => p.id === +b.dataset.hist));
      });
    };

    body.querySelector('#inv-search').oninput = draw;
    body.querySelector('#inv-low').onchange = draw;
    draw();
  }

  /* نافذة إضافة/خصم/تعديل لمنتج */
  function _opMovement(product, mode, body) {
    if (!product) return;
    const titles = { add: 'إضافة مخزون', deduct: 'خصم مخزون', set: 'تعديل المخزون (قيمة جديدة)' };
    const reasonRequired = mode !== 'add';
    const overlay = Utils.el(`
      <div class="modal-overlay"><div class="modal">
        <div class="modal-header">${titles[mode]} — ${Utils.escapeHtml(product.name)}</div>
        <form class="modal-body" id="op-form">
          <p>المخزون الحالي: <strong>${Number(product.stock).toLocaleString('ar-EG')}</strong></p>
          <label class="field">${mode === 'set' ? 'المخزون الجديد' : 'الكمية'}
            <input type="number" name="qty" min="0" step="1" value="${
              mode === 'set' ? product.stock : ''
            }" required />
          </label>
          <label class="field">السبب ${reasonRequired ? '*' : '(اختياري)'}
            <input type="text" name="reason" ${reasonRequired ? 'required' : ''}
              placeholder="${mode === 'add' ? 'توريد / فاتورة شراء' : 'تالف / فاقد / تصحيح جرد'}" />
          </label>
          <div class="form-error" id="op-err"></div>
        </form>
        <div class="modal-footer">
          <button class="btn btn-ghost" data-act="cancel">إلغاء</button>
          <button class="btn btn-primary" data-act="ok">تأكيد</button>
        </div>
      </div></div>`);
    document.body.appendChild(overlay);
    const form = overlay.querySelector('#op-form');
    const close = () => overlay.remove();
    overlay.querySelector('[data-act="cancel"]').onclick = close;
    overlay.addEventListener('click', (e) => e.target === overlay && close());
    overlay.querySelector('[data-act="ok"]').onclick = async () => {
      if (!form.reportValidity()) return;
      const qty = Number(form.qty.value);
      const reason = form.reason.value.trim();
      try {
        if (mode === 'add') await addStock(product.id, qty, reason);
        else if (mode === 'deduct') {
          if (qty <= 0) throw new Error('أدخل كمية صحيحة');
          await deductStock(product.id, qty, reason);
        } else await setStock(product.id, qty, reason);
        Utils.toast('تم تحديث المخزون', 'success');
        close();
        _renderStock(body);
      } catch (err) {
        overlay.querySelector('#op-err').textContent = err.message;
      }
    };
    setTimeout(() => form.qty.focus(), 50);
  }

  async function _showHistory(product) {
    if (!product) return;
    const moves = (await movementsOf(product.id)).sort((a, b) => b.createdAt - a.createdAt);
    const rows = moves.length
      ? moves
          .map(
            (m) => `<tr>
        <td>${Utils.fmtDateTime(m.createdAt)}</td>
        <td>${typeLabel(m.type)}</td>
        <td class="${m.qty < 0 ? 'stock-low' : ''}">${m.qty > 0 ? '+' : ''}${m.qty}</td>
        <td>${m.balanceAfter}</td>
        <td>${Utils.escapeHtml(m.reason || '-')}</td>
        <td>${Utils.escapeHtml(m.userName || '-')}</td></tr>`
          )
          .join('')
      : '<tr><td colspan="6">لا توجد حركات.</td></tr>';
    Utils.modal({
      title: 'سجل حركة: ' + product.name,
      bodyHtml: `<div class="table-scroll"><table class="data-table">
        <thead><tr><th>التاريخ</th><th>النوع</th><th>الكمية</th><th>الرصيد</th><th>السبب</th><th>المستخدم</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`,
      confirmText: 'إغلاق',
      cancelText: '',
    });
  }

  /* ---------- تبويب سجل الحركة ---------- */
  async function _renderLog(body) {
    body.innerHTML = '<div class="loading">جارٍ تحميل السجل…</div>';
    await _loadProductMap();
    body.innerHTML = `
      <div class="toolbar">
        <select id="log-type" class="filter-select">
          <option value="">كل الأنواع</option>
          <option value="sale">بيع</option>
          <option value="return">مرتجع</option>
          <option value="purchase">توريد</option>
          <option value="adjust">تعديل/جرد</option>
        </select>
        <input type="date" id="log-from" class="filter-select" title="من تاريخ" />
        <input type="date" id="log-to" class="filter-select" title="إلى تاريخ" />
        <input type="search" id="log-q" class="search-input" placeholder="بحث باسم المنتج…" />
        <button class="btn btn-primary" id="log-apply">عرض</button>
      </div>
      <div id="log-table"></div>`;

    const draw = async () => {
      const type = body.querySelector('#log-type').value;
      const fromV = body.querySelector('#log-from').value;
      const toV = body.querySelector('#log-to').value;
      const q = body.querySelector('#log-q').value.trim().toLowerCase();
      const from = fromV ? new Date(fromV + 'T00:00:00').getTime() : null;
      const to = toV ? new Date(toV + 'T23:59:59').getTime() : null;

      const LIMIT = 1000;
      const out = [];
      // المرور بالـ cursor تنازليًا حسب التاريخ لأداء أفضل مع البيانات الكبيرة.
      await DB.iterate(
        'inventory_movements',
        (m) => {
          if (type && m.type !== type) return;
          if (from && m.createdAt < from) return;
          if (to && m.createdAt > to) return;
          if (q) {
            const p = _productMap[m.productId];
            const name = (p ? p.name + ' ' + p.sku : '').toLowerCase();
            if (!name.includes(q)) return;
          }
          out.push(m);
          if (out.length >= LIMIT) return false; // إيقاف المرور
        },
        { index: 'createdAt', direction: 'prev' }
      );

      const wrap = body.querySelector('#log-table');
      if (!out.length) {
        wrap.innerHTML = '<div class="placeholder"><p>لا توجد حركات مطابقة.</p></div>';
        return;
      }
      wrap.innerHTML = `
        <div class="table-meta">عدد الحركات: ${out.length.toLocaleString('ar-EG')}${
        out.length >= LIMIT ? ' (أحدث 1000)' : ''
      }</div>
        <div class="table-scroll"><table class="data-table">
          <thead><tr><th>التاريخ</th><th>المنتج</th><th>النوع</th><th>الكمية</th><th>قبل</th><th>بعد</th><th>السبب</th><th>المستخدم</th></tr></thead>
          <tbody>${out
            .map((m) => {
              const p = _productMap[m.productId];
              return `<tr>
                <td>${Utils.fmtDateTime(m.createdAt)}</td>
                <td>${Utils.escapeHtml(p ? p.name : '#' + m.productId)}</td>
                <td>${typeLabel(m.type)}</td>
                <td class="${m.qty < 0 ? 'stock-low' : ''}">${m.qty > 0 ? '+' : ''}${m.qty}</td>
                <td>${m.balanceBefore}</td>
                <td>${m.balanceAfter}</td>
                <td>${Utils.escapeHtml(m.reason || '-')}</td>
                <td>${Utils.escapeHtml(m.userName || '-')}</td></tr>`;
            })
            .join('')}</tbody>
        </table></div>`;
    };

    body.querySelector('#log-apply').onclick = draw;
    body.querySelector('#log-q').onkeydown = (e) => {
      if (e.key === 'Enter') draw();
    };
    draw();
  }

  /* ---------- تبويب الجرد ---------- */
  function _renderCount(body) {
    body.innerHTML = `
      <div class="count-head">
        <input type="search" id="count-input" class="search-input"
          placeholder="امسح الباركود أو اكتب الاسم/SKU ثم Enter لإضافته لورقة الجرد…" autocomplete="off" />
        <button class="btn btn-ghost" id="count-clear">تفريغ</button>
        <button class="btn btn-primary" id="count-apply">تطبيق الجرد</button>
      </div>
      <p class="form-note">امسح المنتج بالباركود (تتجمّع الكمية تلقائيًا) أو اكتب اسمه. عدّل العدد الفعلي ثم اضغط "تطبيق الجرد" لتسوية الفروقات.</p>
      <div id="count-table"></div>`;

    const input = body.querySelector('#count-input');

    const findProduct = async (term) => {
      term = term.trim();
      if (!term) return null;
      return (
        (await DB.getOneByIndex('products', 'barcode', term)) ||
        (await DB.getOneByIndex('products', 'sku', term)) ||
        null
      );
    };

    const addToSession = async (term, fromScan) => {
      let p = await findProduct(term);
      if (!p && !fromScan) {
        // بحث بالاسم: نأخذ أول تطابق
        const all = (await DB.getAll('products')).filter((x) => !x.archived);
        const lc = term.toLowerCase();
        p = all.find((x) => x.name.toLowerCase().includes(lc));
      }
      if (!p) {
        Utils.toast('لا يوجد منتج مطابق', 'error');
        return;
      }
      const existing = _countSession.find((s) => s.productId === p.id);
      if (existing) existing.counted += 1; // زيادة تلقائية عند تكرار المسح
      else
        _countSession.push({
          productId: p.id,
          name: p.name,
          sku: p.sku,
          system: Number(p.stock) || 0,
          counted: 1,
        });
      _drawCount(body);
    };

    input.onkeydown = async (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const term = input.value;
      input.value = '';
      await addToSession(term, false);
    };

    body.querySelector('#count-clear').onclick = async () => {
      if (_countSession.length && (await Utils.confirmBox('تفريغ ورقة الجرد؟'))) {
        _countSession = [];
        _drawCount(body);
      } else if (!_countSession.length) {
        _drawCount(body);
      }
    };

    body.querySelector('#count-apply').onclick = () => _applyCount(body);

    _drawCount(body);
    setTimeout(() => input.focus(), 50);
  }

  function _drawCount(body) {
    const wrap = body.querySelector('#count-table');
    if (!_countSession.length) {
      wrap.innerHTML = '<div class="placeholder"><p>ورقة الجرد فارغة.</p></div>';
      return;
    }
    wrap.innerHTML = `
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>المنتج</th><th>SKU</th><th>النظام</th><th>الفعلي</th><th>الفرق</th><th></th></tr></thead>
        <tbody>${_countSession
          .map((s, i) => {
            const diff = s.counted - s.system;
            return `<tr>
              <td>${Utils.escapeHtml(s.name)}</td>
              <td class="mono">${Utils.escapeHtml(s.sku)}</td>
              <td>${s.system}</td>
              <td><input type="number" min="0" step="1" value="${s.counted}" data-cnt="${i}" style="width:80px" /></td>
              <td class="${diff < 0 ? 'stock-low' : diff > 0 ? 'stock-up' : ''}">${
              diff > 0 ? '+' : ''
            }${diff}</td>
              <td><button class="cl-remove" data-del="${i}">✕</button></td></tr>`;
          })
          .join('')}</tbody>
      </table></div>`;

    wrap.querySelectorAll('[data-cnt]').forEach((inp) => {
      inp.onchange = () => {
        _countSession[+inp.dataset.cnt].counted = Math.max(0, Math.floor(Number(inp.value) || 0));
        _drawCount(body);
      };
    });
    wrap.querySelectorAll('[data-del]').forEach((b) => {
      b.onclick = () => {
        _countSession.splice(+b.dataset.del, 1);
        _drawCount(body);
      };
    });
  }

  async function _applyCount(body) {
    if (!_countSession.length) return;
    const changes = _countSession.filter((s) => s.counted !== s.system);
    if (!changes.length) {
      Utils.toast('لا توجد فروقات للتطبيق', 'info');
      return;
    }
    const ok = await Utils.confirmBox(
      'سيتم تسوية ' + changes.length + ' منتج حسب العدد الفعلي. متابعة؟'
    );
    if (!ok) return;
    let done = 0;
    for (const s of changes) {
      try {
        await setStock(s.productId, s.counted, 'جرد');
        done++;
      } catch (e) {
        console.error('جرد فشل لمنتج', s.productId, e);
      }
    }
    _countSession = [];
    Utils.toast('تم تطبيق الجرد على ' + done + ' منتج', 'success');
    _drawCount(body);
  }

  return {
    applyMovement,
    manualMovement,
    addStock,
    deductStock,
    setStock,
    movementsOf,
    lowStockList,
    typeLabel,
    render,
  };
})();

window.Inventory = Inventory;
