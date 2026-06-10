/* =====================================================================
 * auth.js  —  المصادقة وإدارة المستخدمين
 * - تسجيل الدخول
 * - المستخدم الحالي (Session)
 * - تشفير كلمات المرور / PIN محليًا عبر SubtleCrypto (يعمل Offline)
 * - قفل الشاشة
 * - التحقق من صلاحية المدير للعمليات الحساسة
 * ===================================================================== */

const Auth = (() => {
  const SESSION_KEY = 'cashier_session_user';
  let _current = null;

  /* ---------- تشفير ----------
   * نستخدم SubtleCrypto عند توفّره (https / localhost)، ونرجع تلقائيًا
   * إلى تنفيذ SHA-256 خالص بـ JavaScript عند فتح الملف مباشرةً (file://)
   * حيث تكون crypto.subtle غير متاحة. بهذا يعمل النظام في كل الحالات Offline.
   */

  function _getRandomBytes(len) {
    const arr = new Uint8Array(len);
    if (window.crypto && crypto.getRandomValues) {
      crypto.getRandomValues(arr);
    } else {
      for (let i = 0; i < len; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    return arr;
  }

  function _randomSalt(len = 16) {
    return Array.from(_getRandomBytes(len))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  /* تنفيذ SHA-256 خالص (بديل عند غياب crypto.subtle) */
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
      if (j >> 8) return; // ASCII فقط (نضمن ذلك عبر ترميز UTF-8 مسبقًا)
      words[i >> 2] |= j << (((3 - i) % 4) * 8);
    }
    words[words.length] = (asciiBitLength / maxWord) | 0;
    words[words.length] = asciiBitLength;

    for (let j = 0; j < words.length; ) {
      const w = words.slice(j, (j += 16));
      const oldHash = hash;
      // إعادة ضبط متغيرات العمل إلى قيمة الـ digest الحالية في بداية كل كتلة
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

  function _utf8ToBinaryString(str) {
    // تحويل نص UTF-8 إلى سلسلة بايتات (لكل حرف بايت واحد) لتغذية SHA-256.
    const utf8 = unescape(encodeURIComponent(str));
    return utf8;
  }

  async function hashPassword(password, salt) {
    const useSalt = salt || _randomSalt();
    const input = useSalt + ':' + password;

    if (window.crypto && crypto.subtle && crypto.subtle.digest) {
      try {
        const data = new TextEncoder().encode(input);
        const buf = await crypto.subtle.digest('SHA-256', data);
        const hash = Array.from(new Uint8Array(buf))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        return { salt: useSalt, hash, algo: 'subtle' };
      } catch (e) {
        /* نتابع للبديل */
      }
    }
    const hash = _sha256Hex(_utf8ToBinaryString(input));
    return { salt: useSalt, hash, algo: 'js' };
  }

  async function verifyPassword(password, salt, expectedHash) {
    const { hash } = await hashPassword(password, salt);
    return hash === expectedHash;
  }

  /* ---------- تهيئة أول مستخدم (مدير افتراضي) ---------- */

  async function ensureDefaultAdmin() {
    const users = await DB.getAll('users');
    if (users && users.length > 0) return;
    const { salt, hash } = await hashPassword('1234');
    const admin = {
      name: 'المدير',
      username: 'admin',
      salt,
      passwordHash: hash,
      role: 'manager', // manager = صلاحية كاملة
      permissions: ['*'],
      pinSalt: salt,
      pinHash: hash, // PIN الافتراضي = 1234 أيضًا
      active: 1,
      createdAt: Date.now(),
    };
    await DB.add('users', admin);
  }

  /* ---------- تسجيل الدخول ---------- */

  async function login(username, password) {
    const user = await DB.getOneByIndex('users', 'username', String(username).trim());
    if (!user) return { ok: false, error: 'اسم المستخدم غير موجود' };
    if (!user.active) return { ok: false, error: 'هذا الحساب موقوف' };
    const ok = await verifyPassword(password, user.salt, user.passwordHash);
    if (!ok) return { ok: false, error: 'كلمة المرور غير صحيحة' };
    _setSession(user);
    return { ok: true, user };
  }

  function _setSession(user) {
    _current = user;
    // لا نخزّن الهاش في الجلسة
    const safe = {
      id: user.id,
      name: user.name,
      username: user.username,
      role: user.role,
      permissions: user.permissions || [],
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(safe));
  }

  function logout() {
    _current = null;
    localStorage.removeItem(SESSION_KEY);
  }

  function restoreSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      _current = JSON.parse(raw);
      return _current;
    } catch (e) {
      return null;
    }
  }

  /* تحديث بيانات الجلسة بعد تعديل المستخدم الحالي (دون إعادة دخول) */
  function refreshSession(user) {
    if (!user) return;
    _setSession(user);
  }

  function currentUser() {
    return _current;
  }

  function isManager() {
    return _current && _current.role === 'manager';
  }

  function hasPermission(section) {
    if (!_current) return false;
    if (_current.role === 'manager') return true;
    const perms = _current.permissions || [];
    return perms.includes('*') || perms.includes(section);
  }

  /* ---------- التحقق من المدير لعملية حساسة ---------- */
  /* يستقبل كلمة مرور أو PIN لأي حساب مدير ويتحقق منها. */
  async function verifyManager(secret) {
    const users = await DB.getAll('users');
    for (const u of users) {
      if (u.role !== 'manager' || !u.active) continue;
      if (await verifyPassword(secret, u.salt, u.passwordHash)) return { ok: true, user: u };
      if (u.pinHash && (await verifyPassword(secret, u.pinSalt, u.pinHash)))
        return { ok: true, user: u };
    }
    return { ok: false, error: 'كلمة مرور / PIN المدير غير صحيحة' };
  }

  return {
    ensureDefaultAdmin,
    hashPassword,
    verifyPassword,
    login,
    logout,
    restoreSession,
    refreshSession,
    currentUser,
    isManager,
    hasPermission,
    verifyManager,
  };
})();

window.Auth = Auth;
