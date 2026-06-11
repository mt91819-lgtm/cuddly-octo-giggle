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
  const START_C = 105;
  const STOP = 106;

  // ترميز Set C للأرقام (رقمان لكل رمز) — يعطي باركود أنصاف العرض وأنسب للقراءة
  function _encodeC(value) {
    let sum = START_C;
    const codes = [START_C];
    let pos = 1;
    for (let i = 0; i < value.length; i += 2) {
      const v = parseInt(value.substr(i, 2), 10);
      codes.push(v);
      sum += v * pos++;
    }
    codes.push(sum % 103);
    codes.push(STOP);
    return codes.map((c) => PATTERNS[c]).join('');
  }

  // إرجاع تسلسل العروض (modules) — يستخدم Set C للأرقام الزوجية الطول، وإلا Set B
  function _encode(value) {
    value = String(value);
    if (/^\d+$/.test(value) && value.length % 2 === 0) return _encodeC(value);
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

  /* مجموع وحدات (modules) الباركود — لتقدير عرضه بالنقاط في ZPL */
  function _modulesWidth(value) {
    const widths = _encode(value);
    let total = 0;
    for (let i = 0; i < widths.length; i++) total += +widths[i];
    return total;
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

  /* قائمة الأشرطة السوداء كأبعاد (x,width) بوحدات modules + الإجمالي — لرسم ملصق مخصّص */
  function modules(value) {
    const widths = _encode(value);
    const rects = [];
    let x = 0;
    let total = 0;
    let bar = true;
    for (let i = 0; i < widths.length; i++) {
      const wd = +widths[i];
      if (bar) rects.push({ x: x, w: wd });
      x += wd;
      total += wd;
      bar = !bar;
    }
    return { rects: rects, total: total };
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
    // اتجاه الحقول: B = مدوّر -90° (الافتراضي، غير مقلوب)، R = مدوّر +90° (مقلوب)
    const o = rotate ? (settings.labelFlip ? 'R' : 'B') : 'N';

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
    } else if (ll <= 110 && pw >= ll * 2) {
      // ملصق عريض ومنخفض (مثل 40×10مم): الباركود على الشمال، السعر بجانبه على اليمين.
      const bcDots = _modulesWidth(data) * by; // عرض الباركود التقريبي بالنقاط
      const bh = Math.max(24, ll - 2 * m - fs); // ارتفاع الأعمدة (مع ترك مساحة لسطر الأرقام)
      lines.push(`^FO${m},${m}^BCN,${bh},Y,N,N^FD${data}^FS`);
      if (wantPrice) {
        const px = m + bcDots + Math.round(2 * dpmm);
        const pfs = Math.min(Math.round(ll * 0.6), 40);
        if (px + pfs < pw) lines.push(`^FO${px},${Math.round((ll - pfs) / 2)}^A0N,${pfs},${pfs}^FD${price}^FS`);
      }
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

  return { svg, modules, zpl, zplLabel };
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

  /* يبني الملصق كله كصورة SVG واحدة بالاتجاه الصحيح (بدون تدوير CSS) —
   * أكثر ثباتًا في الطباعة ولا يتعرّض للقصّ أو القلب من المتصفح/التعريف. */
  function labelSvg(label, settings) {
    settings = settings || {};
    const w = Number(settings.labelWidthMm) || 50;
    const h = Number(settings.labelHeightMm) || 30;
    const cur = settings.currency || 'ج.م';
    const showName = settings.labelShowName !== false;
    const showPrice = settings.labelShowPrice !== false;
    const rmode = settings.labelRotate || 'auto';
    const rotate = rmode === 'v' || (rmode === 'auto' && h > w);
    const flip = !!settings.labelFlip;

    const S = 10; // وحدة = 1/10 مم (للدقة)
    const W = Math.round(w * S);
    const H = Math.round(h * S);
    // نُصمّم أفقيًا: العرض = الطول الفعلي للملصق، الارتفاع = السُمك — ثم ندوّر المجموعة كلها داخل SVG
    const DW = rotate ? H : W; // محور الطول (يجري عليه الباركود)
    const DH = rotate ? W : H; // محور السُمك
    const m = Math.round(0.8 * S);

    const { rects, total } = Barcode.modules(String(label.barcode));
    const priceStr = showPrice ? _money(label.price, cur) : '';
    const nameStr = showName ? String(label.name || '') : '';

    // نحجز جزءًا من الطول للسعر (يُقرأ بمحاذاة الطول) والباقي للباركود
    const priceW = priceStr ? Math.round(DW * 0.28) : 0;
    const bcLen = DW - 2 * m - priceW;
    const bcH = Math.round(DH * (nameStr ? 0.5 : 0.62));
    const bcY = nameStr ? Math.round(DH * 0.22) : Math.round((DH - bcH - DH * 0.18) / 2) + m;
    const unit = bcLen / total;

    const bars = rects
      .map(
        (r) =>
          `<rect x="${(m + r.x * unit).toFixed(1)}" y="${bcY}" width="${(r.w * unit).toFixed(
            1
          )}" height="${bcH}"/>`
      )
      .join('');

    // اسم المنتج (فوق الباركود) — اختياري
    const nameFs = Math.round(DH * 0.16);
    const nameEl = nameStr
      ? `<text x="${m + bcLen / 2}" y="${Math.round(DH * 0.16)}" font-family="sans-serif" font-size="${nameFs}" text-anchor="middle">${_esc(
          nameStr
        )}</text>`
      : '';

    // أرقام الباركود تحت الأعمدة
    const numFs = Math.round(DH * 0.15);
    const numEl = `<text x="${m + bcLen / 2}" y="${bcY + bcH + numFs + 2}" font-family="monospace" font-size="${numFs}" text-anchor="middle" letter-spacing="1">${_esc(
      String(label.barcode)
    )}</text>`;

    // السعر — على امتداد الطول، بحجم يتلاءم مع المساحة المتاحة
    let priceEl = '';
    if (priceStr) {
      const fitFs = Math.floor((priceW * 1.7) / Math.max(6, priceStr.length));
      const priceFs = Math.max(Math.round(DH * 0.18), Math.min(fitFs, Math.round(DH * 0.5)));
      priceEl = `<text x="${DW - m - priceW / 2}" y="${DH / 2}" dominant-baseline="middle" font-family="sans-serif" font-weight="bold" font-size="${priceFs}" text-anchor="middle">${_esc(
        priceStr
      )}</text>`;
    }

    const design = `<rect x="0" y="0" width="${DW}" height="${DH}" fill="#fff"/><g fill="#000">${bars}</g>${nameEl}${numEl}${priceEl}`;

    let wrapped;
    if (!rotate) wrapped = design;
    else if (!flip) wrapped = `<g transform="translate(0,${H}) rotate(-90)">${design}</g>`;
    else wrapped = `<g transform="translate(${W},0) rotate(90)">${design}</g>`;

    return (
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}mm" height="${h}mm" ` +
      `viewBox="0 0 ${W} ${H}" shape-rendering="crispEdges">` +
      `<rect x="0" y="0" width="${W}" height="${H}" fill="#fff"/>${wrapped}</svg>`
    );
  }

  /* labels: [{ name, price, barcode }] — كل عنصر = ملصق واحد (كرّره حسب الكمية) */
  function buildHtml(labels, settings) {
    const w = Number(settings.labelWidthMm) || 50;
    const h = Number(settings.labelHeightMm) || 30;
    const cells = labels
      .map((l) => `<div class="page">${labelSvg(l, settings)}</div>`)
      .join('');

    return `<!DOCTYPE html>
<html lang="ar" dir="rtl"><head><meta charset="UTF-8"><style>
  @page { size: ${w}mm ${h}mm; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; }
  .page { width: ${w}mm; height: ${h}mm; overflow: hidden; page-break-after: always; }
  .page svg { display: block; width: 100%; height: 100%; }
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

  // طباعة عبر نسخة سطح المكتب (Electron): نطبع الملصق كصورة SVG صامتة،
  // مطابقة تمامًا للمعاينة في الإعدادات (تحكّم كامل في الاتجاه والتوسيط).
  function _desktopPrint(labels, settings) {
    const dp = window.desktopPrint;
    const html = buildHtml(labels, settings);
    const w = Number(settings.labelWidthMm) || 50;
    dp.html(html, settings.labelPrinterName || '', w).then((r) => {
      if (r && !r.success && window.Utils && Utils.toast)
        Utils.toast('تعذّرت طباعة الملصق: ' + (r.reason || ''), 'error');
    });
    return { method: 'desktop' };
  }

  function print(labels, settings) {
    if (!labels || !labels.length) return;
    settings = settings || {};
    // نسخة سطح المكتب: طباعة مباشرة بدون نافذة
    if (window.desktopPrint && window.desktopPrint.isDesktop) {
      return _desktopPrint(labels, settings);
    }
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

  return { buildHtml, labelSvg, print, printZpl };
})();

window.Barcode = Barcode;
window.Labels = Labels;
