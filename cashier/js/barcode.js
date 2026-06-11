/* =====================================================================
 * barcode.js  —  توليد باركود Code128 (SVG) + طباعة ملصقات الباركود
 * بدون أي مكتبات خارجية — يعمل Offline بالكامل.
 * Code128 (Start B) يغطي الأرقام والحروف والرموز ASCII 32..126،
 * وهو ما تنتجه الأكواد المولّدة تلقائيًا في النظام.
 * ===================================================================== */

const Barcode = (() => {
  // جدول أنماط Code128 القياسي (القيمة = الفهرس) — عرض كل عنصر (شريط/فراغ)
  const PATTERNS = [
    '212222','222122','222221','121223','121322','131222','122213','122312','132212','221213',
    '221312','231212','112232','122132','122231','113222','123122','123221','223211','221132',
    '221231','213212','223112','312131','311222','321122','321221','312212','322112','322211',
    '212123','212321','232121','111323','131123','131321','112313','132113','132311','211313',
    '231113','231311','112133','112331','132131','113123','113321','133121','313121','211331',
    '231131','213113','213311','213131','311123','311321','331121','312113','312311','332111',
    '314111','221411','431111','111224','111422','121124','121421','141122','141221','112214',
    '112412','122114','122411','142112','142211','241211','221114','413111','241112','134111',
    '111242','121142','121241','114212','124112','124211','411212','421112','421211','212141',
    '214121','412121','111143','111341','131141','114113','114311','411113','411311','113141',
    '114131','311141','411131','211412','211214','211232','2331112',
  ];
  const START_B = 104;
  const STOP = 106;

  // إرجاع تسلسل العروض (modules) لقيمة نصية مرمّزة بـ Code128B
  function _encode(value) {
    value = String(value);
    let sum = START_B;
    const codes = [START_B];
    for (let i = 0; i < value.length; i++) {
      let v = value.charCodeAt(i) - 32;
      if (v < 0 || v > 94) v = 0; // أي رمز خارج النطاق يُعامَل كمسافة
      codes.push(v);
      sum += v * (i + 1);
    }
    codes.push(sum % 103); // رقم التحقق (checksum)
    codes.push(STOP);
    return codes.map((c) => PATTERNS[c]).join('');
  }

  /* SVG للباركود — يتمدد ليملأ الحاوية (الحجم الفعلي يُضبط بالـ CSS بالمليمتر) */
  function svg(value, opts) {
    opts = opts || {};
    const widths = _encode(value);
    const H = 100; // وحدات داخلية لـ viewBox فقط
    let x = 0;
    let totalModules = 0;
    let bar = true; // أول عنصر شريط
    const rects = [];
    for (let i = 0; i < widths.length; i++) {
      const w = +widths[i];
      if (bar) rects.push(`<rect x="${x}" y="0" width="${w}" height="${H}"/>`);
      x += w;
      totalModules += w;
      bar = !bar;
    }
    return (
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${totalModules} ${H}" ` +
      `preserveAspectRatio="none" width="100%" height="100%" shape-rendering="crispEdges">` +
      `<rect x="0" y="0" width="${totalModules}" height="${H}" fill="#fff"/>` +
      `<g fill="#000">${rects.join('')}</g></svg>`
    );
  }

  return { svg };
})();

/* ---------- طباعة ملصقات الباركود ---------- */
const Labels = (() => {
  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function _money(n, cur) {
    return (
      Number(n || 0).toLocaleString('ar-EG', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }) +
      ' ' +
      (cur || 'ج.م')
    );
  }

  /* labels: [{ name, price, barcode }] — كل عنصر = ملصق واحد (كرّره حسب الكمية) */
  function buildHtml(labels, settings) {
    const w = Number(settings.labelWidthMm) || 50;
    const h = Number(settings.labelHeightMm) || 30;
    const showName = settings.labelShowName !== false;
    const showPrice = settings.labelShowPrice !== false;
    const showStore = !!settings.labelShowStore;
    const cur = settings.currency || 'ج.م';

    // التدوير: auto = يدوّر تلقائيًا لو الملصق طويل ورفيع (الطول > العرض)
    const rmode = settings.labelRotate || 'auto';
    const rotate = rmode === 'v' || (rmode === 'auto' && h > w);
    // أبعاد منطقة التصميم؛ بعد التدوير 90° تصبح أفقية وتملأ الملصق
    const dw = rotate ? h : w; // عرض التصميم
    const dh = rotate ? w : h; // ارتفاع التصميم
    // ارتفاع الباركود ≈ نصف ارتفاع منطقة التصميم
    const bcMm = Math.max(5, (dh * 0.5).toFixed(1));

    const cells = labels
      .map(
        (l) => `<div class="page"><div class="lbl">
          ${showStore ? `<div class="l-store">${_esc(settings.storeName || '')}</div>` : ''}
          ${showName ? `<div class="l-name">${_esc(l.name)}</div>` : ''}
          <div class="l-bc">${Barcode.svg(l.barcode)}</div>
          <div class="l-code">${_esc(l.barcode)}</div>
          ${showPrice ? `<div class="l-price">${_money(l.price, cur)}</div>` : ''}
        </div></div>`
      )
      .join('');

    return `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="UTF-8"><style>
  @page { size: ${w}mm ${h}mm; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: 'Cairo','Tahoma',sans-serif; color:#000; }
  .page { width: ${w}mm; height: ${h}mm; position: relative; overflow: hidden; page-break-after: always; }
  .lbl {
    width: ${dw}mm; height: ${dh}mm;
    position: absolute; top: 50%; left: 50%;
    transform: translate(-50%, -50%)${rotate ? ' rotate(90deg)' : ''};
    padding: 0.5mm 1mm;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; gap: 0.3mm;
  }
  .l-store { font-size: 6pt; font-weight: bold; line-height: 1.05; }
  .l-name { font-size: 6pt; line-height: 1.05; max-height: 2.2em; overflow: hidden; }
  .l-bc { width: 100%; height: ${bcMm}mm; }
  .l-bc svg { display: block; width: 100%; height: 100%; }
  .l-code { font-size: 6pt; letter-spacing: 1px; font-family: monospace; }
  .l-price { font-size: 8pt; font-weight: bold; }
</style></head><body>${cells}</body></html>`;
  }

  function print(labels, settings) {
    if (!labels || !labels.length) return;
    const html = buildHtml(labels, settings);
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
        console.error('Label print failed', e);
      }
      setTimeout(() => iframe.remove(), 1500);
    }, 300);
  }

  return { buildHtml, print };
})();

window.Barcode = Barcode;
window.Labels = Labels;
