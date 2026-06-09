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
