/* =====================================================================
 * inventory.js  —  المخزون وحركاته
 * النواة المشتركة لحركة المخزون تُستخدم من البيع والمرتجعات والجرد.
 * (واجهة الجرد والتعديل اليدوي تُبنى بالكامل في المرحلة 4)
 *
 * أنواع الحركة (type):
 *   sale        خصم بسبب بيع
 *   return      إضافة بسبب مرتجع
 *   purchase    إضافة مخزون (توريد)
 *   adjust      تعديل يدوي / جرد
 * ===================================================================== */

const Inventory = (() => {
  /* تطبيق حركة مخزون: تحدّث رصيد المنتج وتسجّل الحركة وتُرجع المنتج المحدّث.
   * delta موجب للإضافة وسالب للخصم. */
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
      type, // sale | return | purchase | adjust
      qty: Number(delta), // موجب/سالب
      balanceBefore: before,
      balanceAfter: after,
      reason: reason || '',
      refType: refType || null, // invoice | return | manual | count
      refId: refId != null ? refId : null,
      userId: user ? user.id : null,
      userName: user ? user.name : 'النظام',
      createdAt: Date.now(),
    });

    return product;
  }

  /* جلب حركات منتج معيّن */
  function movementsOf(productId) {
    return DB.getByIndex('inventory_movements', 'productId', productId);
  }

  /* قائمة إعادة الشراء: المنتجات النشطة التي وصلت لحد التنبيه أو أقل */
  async function lowStockList() {
    const products = await DB.getAll('products');
    return products
      .filter((p) => !p.archived && Number(p.stock) <= Number(p.alertLevel))
      .sort((a, b) => a.stock - b.stock);
  }

  /* ---------- الواجهة (تُبنى في المرحلة 4) ---------- */
  function render(content) {
    content.innerHTML = `
      <div class="placeholder">
        <div class="placeholder-icon">🏷️</div>
        <h3>المخزون والجرد</h3>
        <p>تُفعَّل واجهة الجرد والتعديل اليدوي وسجل الحركة في المرحلة 4.
        (نواة حركة المخزون تعمل بالفعل وتُستخدم في البيع.)</p>
      </div>`;
  }

  return { applyMovement, movementsOf, lowStockList, render };
})();

window.Inventory = Inventory;
