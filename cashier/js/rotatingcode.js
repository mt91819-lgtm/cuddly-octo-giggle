/* =====================================================================
 * rotatingcode.js  —  كود المدير المتغيّر بالوقت (TOTP مبسّط)
 * يعمل Offline بالكامل. يُشتق كود من "سر" المدير + نافذة زمنية (ساعتان)،
 * فيتغيّر تلقائيًا كل ساعتين. نفس الخوارزمية مستخدمة في صفحة المولّد
 * المستقلة (manager-code.html) حتى يتطابق الكود في الجهتين.
 *
 * ملاحظة أمان: نخزّن "السر" فقط (وليس الكود)، والكود يُحسب لحظيًا.
 * ===================================================================== */

const RotatingCode = (() => {
  const PERIOD_MS = 2 * 60 * 60 * 1000; // ساعتان

  /* ---- SHA-256 خالص (نفس النسخة المتحقَّق منها في auth.js) ---- */
  function _sha256Hex(ascii) {
    function rightRotate(value, amount) {
      return (value >>> amount) | (value << (32 - amount));
    }
    const mathPow = Math.pow;
    const maxWord = mathPow(2, 32);
    let result = '';
    const words = [];
    const asciiBitLength = ascii.length * 8;

    let hash = _sha256Hex.h || (_sha256Hex.h = []);
    let k = _sha256Hex.k || (_sha256Hex.k = []);
    let primeCounter = k.length;

    if (!primeCounter) {
      const isComposite = {};
      for (let candidate = 2, p = 0; p < 64; candidate++) {
        if (!isComposite[candidate]) {
          for (let i = 0; i < 313; i += candidate) isComposite[i] = candidate;
          hash[p] = (mathPow(candidate, 0.5) * maxWord) | 0;
          k[p++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
        }
      }
    }

    ascii += '\x80';
    while ((ascii.length % 64) - 56) ascii += '\x00';
    for (let i = 0; i < ascii.length; i++) {
      const j = ascii.charCodeAt(i);
      if (j >> 8) return;
      words[i >> 2] |= j << (((3 - i) % 4) * 8);
    }
    words[words.length] = (asciiBitLength / maxWord) | 0;
    words[words.length] = asciiBitLength;

    for (let j = 0; j < words.length; ) {
      const w = words.slice(j, (j += 16));
      const oldHash = hash;
      hash = hash.slice(0, 8);

      for (let i = 0; i < 64; i++) {
        const w15 = w[i - 15];
        const w2 = w[i - 2];
        const a = hash[0];
        const e = hash[4];
        const temp1 =
          hash[7] +
          (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25)) +
          ((e & hash[5]) ^ (~e & hash[6])) +
          k[i] +
          (w[i] =
            i < 16
              ? w[i]
              : (w[i - 16] +
                  (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3)) +
                  w[i - 7] +
                  (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))) |
                0);
        const temp2 =
          (rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22)) +
          ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]));
        hash = [(temp1 + temp2) | 0].concat(hash);
        hash[4] = (hash[4] + temp1) | 0;
      }

      for (let i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }

    for (let i = 0; i < 8; i++) {
      for (let j = 3; j + 1; j--) {
        const b = (hash[i] >> (j * 8)) & 255;
        result += (b < 16 ? '0' : '') + b.toString(16);
      }
    }
    return result;
  }

  function _utf8(str) {
    return unescape(encodeURIComponent(str));
  }

  function windowIndex(ts) {
    return Math.floor((ts || Date.now()) / PERIOD_MS);
  }

  function codeForWindow(secret, win) {
    const h = _sha256Hex(_utf8(String(secret) + ':' + win));
    const num = parseInt(h.slice(0, 8), 16) % 1000000;
    return String(num).padStart(6, '0');
  }

  function current(secret, ts) {
    return codeForWindow(secret, windowIndex(ts));
  }

  /* قبول النافذة الحالية والسابقة (سماحية عند حدود الوقت) */
  function verify(secret, code, ts) {
    if (!secret || !code) return false;
    code = String(code).trim();
    const w = windowIndex(ts);
    return code === codeForWindow(secret, w) || code === codeForWindow(secret, w - 1);
  }

  function msToNext(ts) {
    const t = ts || Date.now();
    return PERIOD_MS - (t % PERIOD_MS);
  }

  function genSecret() {
    const arr = new Uint8Array(20);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(arr);
    else for (let i = 0; i < 20; i++) arr[i] = Math.floor(Math.random() * 256);
    return Array.from(arr)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  return { current, verify, codeForWindow, windowIndex, msToNext, genSecret, PERIOD_MS };
})();

if (typeof window !== 'undefined') window.RotatingCode = RotatingCode;
if (typeof module !== 'undefined' && module.exports) module.exports = RotatingCode;
