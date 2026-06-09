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

  /* ---------- تشفير ---------- */

  function _randomSalt(len = 16) {
    const arr = new Uint8Array(len);
    crypto.getRandomValues(arr);
    return Array.from(arr)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  async function hashPassword(password, salt) {
    const useSalt = salt || _randomSalt();
    const enc = new TextEncoder();
    const data = enc.encode(useSalt + ':' + password);
    const buf = await crypto.subtle.digest('SHA-256', data);
    const hash = Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    return { salt: useSalt, hash };
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
    currentUser,
    isManager,
    hasPermission,
    verifyManager,
  };
})();

window.Auth = Auth;
