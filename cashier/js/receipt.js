/* =====================================================================
 * receipt.js  —  طباعة الإيصالات
 * يدعم ثلاثة مقاسات: 58mm / 80mm / A4.
 * يطبع عبر iframe مخفي (يعمل Offline بدون نوافذ منبثقة).
 * يُستخدم من البيع (POS) ومن المرتجعات لاحقًا.
 * ===================================================================== */

const Receipt = (() => {
  function _money(n) {
    const v = Number(n || 0);
    return (
      v.toLocaleString('ar-EG', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
      ' ' +
      (window.__currency || 'ج.م')
    );
  }

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function _payLabel(m) {
    return m === 'cash' ? 'كاش' : m === 'instapay' ? 'Instapay' : m === 'wallet' ? 'Wallet' : m;
  }

  function _pageCss(fmt) {
    if (fmt === '58mm') {
      return `@page { size: 58mm auto; margin: 2mm; }
        body { width: 54mm; font-size: 11px; }
        .r-title { font-size: 14px; }`;
    }
    if (fmt === 'A4') {
      return `@page { size: A4; margin: 14mm; }
        body { width: auto; font-size: 14px; }
        .r-title { font-size: 22px; }
        table { font-size: 13px; }`;
    }
    // 80mm افتراضي
    return `@page { size: 80mm auto; margin: 3mm; }
      body { width: 72mm; font-size: 12px; }
      .r-title { font-size: 16px; }`;
  }

  /* بناء HTML الإيصال (يصلح للبيع وللمرتجع) */
  function buildHtml(invoice, settings, opts = {}) {
    const fmt = (settings && settings.printFormat) || '80mm';
    const isReturn = !!opts.isReturn;
    const items = invoice.items || [];

    const rows = items
      .map(
        (it) => `<tr>
          <td class="r-name">${_esc(it.name)}</td>
          <td class="r-c">${it.qty}</td>
          <td class="r-c">${_money(it.unitPrice)}</td>
          <td class="r-c">${_money(it.lineTotal != null ? it.lineTotal : it.unitPrice * it.qty)}</td>
        </tr>`
      )
      .join('');

    const store = (settings && settings.storeName) || 'المتجر';
    const footer = (settings && settings.receiptFooter) || '';

    return `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="UTF-8">
<style>
  ${_pageCss(fmt)}
  * { box-sizing: border-box; }
  body { font-family: 'Cairo','Tahoma',sans-serif; color:#000; margin:0; padding:0; }
  .r-center { text-align:center; }
  .r-title { font-weight:bold; margin-bottom:2px; }
  .r-muted { color:#333; }
  hr { border:none; border-top:1px dashed #000; margin:6px 0; }
  table { width:100%; border-collapse:collapse; }
  th, td { padding:2px 1px; }
  .r-name { text-align:right; }
  .r-c { text-align:center; white-space:nowrap; }
  thead th { border-bottom:1px solid #000; text-align:center; }
  .r-tot { display:flex; justify-content:space-between; margin:1px 0; }
  .r-grand { font-weight:bold; font-size:1.15em; border-top:1px solid #000; padding-top:3px; margin-top:3px; }
  .r-tag { text-align:center; font-weight:bold; border:1px solid #000; padding:2px; margin:4px 0; }
</style></head>
<body>
  <div class="r-center">
    <div class="r-title">${_esc(store)}</div>
    ${isReturn ? '<div class="r-tag">إيصال مرتجع</div>' : ''}
  </div>
  <hr>
  <div>فاتورة: <strong>${_esc(invoice.number)}</strong></div>
  <div class="r-muted">التاريخ: ${new Date(invoice.createdAt).toLocaleString('ar-EG')}</div>
  ${invoice.userName ? `<div class="r-muted">الكاشير: ${_esc(invoice.userName)}</div>` : ''}
  ${
    opts.originalNumber
      ? `<div class="r-muted">من فاتورة: ${_esc(opts.originalNumber)}</div>`
      : ''
  }
  <hr>
  <table>
    <thead><tr><th class="r-name">الصنف</th><th>كمية</th><th>سعر</th><th>إجمالي</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <hr>
  <div class="r-tot"><span>الإجمالي الفرعي</span><span>${_money(invoice.subtotal)}</span></div>
  ${
    invoice.totalDiscount
      ? `<div class="r-tot"><span>الخصم</span><span>- ${_money(invoice.totalDiscount)}</span></div>`
      : ''
  }
  <div class="r-tot r-grand"><span>${isReturn ? 'إجمالي المرتجع' : 'الإجمالي'}</span><span>${_money(
      invoice.total
    )}</span></div>
  <div class="r-tot"><span>الدفع</span><span>${_payLabel(invoice.paymentMethod)}</span></div>
  ${
    invoice.paidAmount
      ? `<div class="r-tot"><span>المدفوع</span><span>${_money(invoice.paidAmount)}</span></div>
         <div class="r-tot"><span>الباقي</span><span>${_money(invoice.change || 0)}</span></div>`
      : ''
  }
  ${invoice.note ? `<hr><div>ملاحظة: ${_esc(invoice.note)}</div>` : ''}
  <hr>
  <div class="r-center r-muted">${_esc(footer)}</div>
</body></html>`;
  }

  function print(invoice, settings, opts) {
    const html = buildHtml(invoice, settings, opts);
    // نسخة سطح المكتب (Electron): طباعة صامتة مباشرة بدون نافذة طباعة
    if (window.desktopPrint && window.desktopPrint.isDesktop) {
      const fmt = (settings && settings.printFormat) || '80mm';
      const widthMm = fmt === '58mm' ? 58 : fmt === 'A4' ? 210 : 80;
      const pName = (settings && settings.receiptPrinterName) || '';
      window.desktopPrint.html(html, pName, widthMm).then((r) => {
        if (r && !r.success && window.Utils && Utils.toast)
          Utils.toast('تعذّرت طباعة الإيصال: ' + (r.reason || ''), 'error');
      });
      return;
    }
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;';
    document.body.appendChild(iframe);
    const doc = iframe.contentWindow.document;
    doc.open();
    doc.write(html);
    doc.close();
    setTimeout(() => {
      try {
        iframe.contentWindow.focus();
        iframe.contentWindow.print();
      } catch (e) {
        console.error('Print failed', e);
      }
      setTimeout(() => iframe.remove(), 1500);
    }, 300);
  }

  return { buildHtml, print };
})();

window.Receipt = Receipt;
