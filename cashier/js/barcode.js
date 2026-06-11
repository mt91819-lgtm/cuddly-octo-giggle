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

  /* ----- ZPL: أمر طباعة مباشر لطابعات Zebra (مثل ZD410) ----- *
   * يعطي جودة باركود مثالية ومقاسًا مضبوطًا، ويتجاوز إعدادات نافذة طباعة المتصفح.
   * label: { name, price, barcode } — settings: { labelDpi, labelWidthMm,
   * labelHeightMm, labelRotate, labelShowName, labelShowPrice, currency }
   */
  function _zplClean(s) {
    // إزالة محارف تحكّم ZPL والاحتفاظ بـ ASCII القابل للطباعة فقط
    return String(s == null ? '' : s).replace(/[\^~]/g, ' ').replace(/[^\x20-\x7E]/g, '').trim();
  }

  function zplLabel(label, settings) {
    settings = settings || {};
    const dpi = Number(settings.labelDpi) === 300 ? 300 : 203;
    const dpmm = dpi / 25.4;
    const wmm = Number(settings.labelWidthMm) || 10;
    const hmm = Number(settings.labelHeightMm) || 40;
    const pw = Math.round(wmm * dpmm); // عرض الطباعة (عرض رأس الطابعة)
    const ll = Math.round(hmm * dpmm); // طول الملصق (اتجاه التغذية)

    const rmode = settings.labelRotate || 'auto';
    const rotate = rmode === 'v' || (rmode === 'auto' && hmm > wmm);
    const o = rotate ? 'R' : 'N'; // اتجاه الحقول: R = مدوّر 90°

    const m = Math.round(1.2 * dpmm); // هامش ~1.2مم
    const by = dpi >= 300 ? 3 : 2; // عرض أنحف شريط (نقاط)
    const fs = dpi >= 300 ? 30 : 20; // ارتفاع خط النص (نقاط)

    const data = _zplClean(label.barcode);
    const name = _zplClean(label.name);
    const price = _zplClean(_zplMoney(label.price, settings.currency));
    let wantName = settings.labelShowName !== false && !!name;
    let wantPrice = settings.labelShowPrice !== false && !!price;

    const lines = [];
    lines.push('^XA');
    lines.push('^CI28'); // UTF-8
    lines.push('^PW' + pw);
    lines.push('^LL' + ll);
    lines.push('^LH0,0');
    lines.push(`^BY${by}`);

    if (rotate) {
      // الأعمدة تترتّب جنبًا إلى جنب عبر عرض الملصق (10مم)، كلٌّ يمتد بطول الملصق (40مم).
      // المساحة ضيقة: نعطي الأولوية للباركود ثم السعر، ونُسقِط الاسم لو لم يتّسع.
      const col = fs + 4; // عرض عمود نص واحد
      const avail = pw - 2 * m;
      let need = (wantName ? col : 0) + (wantPrice ? col : 0);
      let barLen = avail - need;
      if (barLen < 24 && wantName) { wantName = false; need -= col; barLen = avail - need; }
      if (barLen < 24 && wantPrice) { wantPrice = false; need -= col; barLen = avail - need; }
      barLen = Math.max(24, barLen);
      const y = Math.round(ll * 0.06);
      let x = m;
      lines.push(`^FO${x},${y}^BC${o},${barLen},Y,N,N^FD${data}^FS`);
      x += barLen + 4;
      if (wantPrice) { lines.push(`^FO${x},${y}^A0${o},${fs},${fs}^FD${price}^FS`); x += col; }
      if (wantName) { lines.push(`^FO${x},${y}^A0${o},${fs},${fs}^FD${name}^FS`); }
    } else {
      const barLen = Math.max(24, Math.round(ll * 0.5));
      let y = m;
      if (wantName) {
        lines.push(`^FO${m},${y}^A0N,${fs},${fs}^FD${name}^FS`);
        y += fs + 4;
      }
      lines.push(`^FO${m},${y}^BCN,${barLen},Y,N,N^FD${data}^FS`);
      y += barLen + fs + 8;
      if (wantPrice) {
        lines.push(`^FO${m},${y}^A0N,${fs},${fs}^FD${price}^FS`);
      }
    }
    lines.push('^XZ');
    return lines.join('\n');
  }

  function _zplMoney(n, cur) {
    const num = Number(n || 0).toFixed(2);
    // العملات غير اللاتينية (مثل "ج.م") لا تتوفر في خط Zebra الافتراضي → نستخدم EGP
    const c = /^[\x20-\x7E]+$/.test(String(cur || '')) ? cur : 'EGP';
    return num + ' ' + c;
  }

  /* نص ZPL لعدة ملصقات (كتلة لكل ملصق) */
  function zpl(labels, settings) {
    return (labels || []).map((l) => zplLabel(l, settings)).join('\n');
  }

  return { svg, zpl, zplLabel };
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
    // ملصق صغير الارتفاع: نقلّل المحتوى ونصغّر الخطوط حتى لا يُقصّ
    const tiny = dh <= 16;
    const bcMm = Math.max(4, +(dh * (tiny ? 0.42 : 0.5)).toFixed(1));
    const fName = tiny ? 4.5 : 6; // pt
    const fCode = tiny ? 4 : 6;
    const fPrice = tiny ? 6 : 8;
    const showCode = !tiny; // على الملصق الصغير نكتفي بالباركود لتوفير المساحة

    const cells = labels
      .map(
        (l) => `<div class="page"><div class="lbl">
          ${showStore ? `<div class="l-store">${_esc(settings.storeName || '')}</div>` : ''}
          ${showName ? `<div class="l-name">${_esc(l.name)}</div>` : ''}
          <div class="l-bc">${Barcode.svg(l.barcode)}</div>
          ${showCode ? `<div class="l-code">${_esc(l.barcode)}</div>` : ''}
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
    padding: ${tiny ? '0.2mm 0.5mm' : '0.5mm 1mm'};
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    text-align: center; gap: ${tiny ? '0.1mm' : '0.3mm'}; line-height: 1;
  }
  .l-store { font-size: ${fName}pt; font-weight: bold; line-height: 1.05; }
  .l-name { font-size: ${fName}pt; line-height: 1.05; max-height: ${tiny ? '1.1em' : '2.2em'}; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; max-width: 100%; }
  .l-bc { width: 100%; height: ${bcMm}mm; }
  .l-bc svg { display: block; width: 100%; height: 100%; }
  .l-code { font-size: ${fCode}pt; letter-spacing: 1px; font-family: monospace; }
  .l-price { font-size: ${fPrice}pt; font-weight: bold; }
</style></head><body>${cells}</body></html>`;
  }

  // عناوين خدمة Zebra Browser Print (تختلف حسب الإصدار: HTTPS:9101 الأحدث، HTTP:9100 الأقدم)
  const BP_BASES = [
    'https://127.0.0.1:9101',
    'https://localhost:9101',
    'http://127.0.0.1:9100',
    'http://localhost:9100',
  ];

  async function _bpSend(base, data) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    try {
      const res = await fetch(base + '/default?type=printer', { signal: ctrl.signal });
      const device = await res.json();
      await fetch(base + '/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device: device, data: data }),
      });
      return true;
    } finally {
      clearTimeout(t);
    }
  }

  /* إرسال ZPL لطابعة Zebra: يجرّب Zebra Browser Print محليًا، وإلا ينزّل ملف .zpl */
  async function printZpl(labels, settings) {
    const data = Barcode.zpl(labels, settings);
    // 1) محاولة Zebra Browser Print على كل العناوين المعروفة
    for (const base of BP_BASES) {
      try {
        await _bpSend(base, data);
        return { method: 'browserprint' };
      } catch (e) {
        /* جرّب العنوان التالي */
      }
    }
    // 2) البديل: تنزيل ملف .zpl ليُرسَل عبر Zebra Setup Utilities
    try {
      const blob = new Blob([data], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'labels.zpl';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e2) {
      console.error('ZPL download failed', e2);
    }
    if (window.Utils && Utils.toast) {
      Utils.toast(
        'لم يتم العثور على Zebra Browser Print — تم تنزيل ملف ZPL. ثبّت Browser Print للطباعة المباشرة، أو أرسل الملف عبر Zebra Setup Utilities.',
        'info'
      );
    }
    return { method: 'download' };
  }

  function print(labels, settings) {
    if (!labels || !labels.length) return;
    settings = settings || {};
    if (settings.labelPrinter === 'zebra-zpl') {
      return printZpl(labels, settings);
    }
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

  return { buildHtml, print, printZpl };
})();

window.Barcode = Barcode;
window.Labels = Labels;
