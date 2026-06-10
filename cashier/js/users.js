/* =====================================================================
 * users.js  —  الموظفون والصلاحيات (المرحلة 6)
 * - إدارة الموظفين: إضافة / تعديل / تفعيل-إيقاف (لا حذف فعلي).
 * - الدور: مدير (صلاحية كاملة) أو موظف (صلاحيات بالأقسام).
 * - كلمة مرور + PIN لكل موظف (تُشفَّر عبر Auth.hashPassword).
 * - حماية: لا يمكن إيقاف آخر مدير نشط.
 * (للمدير فقط — يُربط في الراوتر)
 * ===================================================================== */

const Users = (() => {
  async function _list() {
    return (await DB.getAll('users')).sort((a, b) => (a.id || 0) - (b.id || 0));
  }

  async function _activeManagerCount(excludeId) {
    const users = await DB.getAll('users');
    return users.filter((u) => u.role === 'manager' && u.active && u.id !== excludeId).length;
  }

  /* إنشاء موظف جديد */
  async function createUser(data) {
    const username = String(data.username || '').trim().toLowerCase();
    const name = String(data.name || '').trim();
    if (!name) throw new Error('الاسم مطلوب');
    if (!username) throw new Error('اسم المستخدم مطلوب');
    if (!data.password) throw new Error('كلمة المرور مطلوبة');

    const existing = await DB.getOneByIndex('users', 'username', username);
    if (existing) throw new Error('اسم المستخدم مستخدم بالفعل');

    const pwd = await Auth.hashPassword(data.password);
    const pin = data.pin ? await Auth.hashPassword(String(data.pin)) : null;
    const isManager = data.role === 'manager';

    const user = {
      name,
      username,
      salt: pwd.salt,
      passwordHash: pwd.hash,
      pinSalt: pin ? pin.salt : null,
      pinHash: pin ? pin.hash : null,
      // سر الكود المتغيّر للمدير (يُولّد تلقائيًا إن لم يُمرَّر)
      pinSecret: isManager ? data.pinSecret || RotatingCode.genSecret() : null,
      role: isManager ? 'manager' : 'cashier',
      permissions: isManager ? ['*'] : data.permissions || [],
      active: 1,
      createdAt: Date.now(),
    };
    const id = await DB.add('users', user);
    user.id = id;
    await Audit.log('user.create', 'user', id, null, _safe(user));
    return user;
  }

  /* تعديل موظف */
  async function updateUser(id, data) {
    const old = await DB.get('users', id);
    if (!old) throw new Error('الموظف غير موجود');

    const next = Object.assign({}, old);
    next.name = String(data.name || '').trim() || old.name;
    next.role = data.role === 'manager' ? 'manager' : 'cashier';
    next.permissions = next.role === 'manager' ? ['*'] : data.permissions || [];
    // إدارة سر الكود المتغيّر: للمدير فقط، يُولّد إن لم يوجد، ويُحدّث عند إعادة التوليد
    if (next.role === 'manager') {
      if (data.pinSecret) next.pinSecret = data.pinSecret;
      else if (!next.pinSecret) next.pinSecret = RotatingCode.genSecret();
    } else {
      next.pinSecret = null;
    }

    // منع إنزال آخر مدير نشط إلى موظف
    if (old.role === 'manager' && next.role !== 'manager') {
      if ((await _activeManagerCount(id)) === 0)
        throw new Error('لا يمكن إزالة صلاحية المدير من آخر مدير نشط');
    }

    if (data.password) {
      const pwd = await Auth.hashPassword(data.password);
      next.salt = pwd.salt;
      next.passwordHash = pwd.hash;
    }
    if (data.pin) {
      const pin = await Auth.hashPassword(String(data.pin));
      next.pinSalt = pin.salt;
      next.pinHash = pin.hash;
    }
    next.updatedAt = Date.now();

    await DB.put('users', next);
    await Audit.log('user.update', 'user', id, _safe(old), _safe(next));

    // لو عُدّل المستخدم الحالي، نحدّث الجلسة
    const cur = Auth.currentUser();
    if (cur && cur.id === id) {
      Auth.refreshSession && Auth.refreshSession(next);
    }
    return next;
  }

  async function setActive(id, active) {
    const old = await DB.get('users', id);
    if (!old) throw new Error('الموظف غير موجود');
    if (!active && old.role === 'manager' && (await _activeManagerCount(id)) === 0)
      throw new Error('لا يمكن إيقاف آخر مدير نشط');
    const cur = Auth.currentUser();
    if (!active && cur && cur.id === id) throw new Error('لا يمكنك إيقاف حسابك الحالي');

    old.active = active ? 1 : 0;
    old.updatedAt = Date.now();
    await DB.put('users', old);
    await Audit.log(active ? 'user.activate' : 'user.deactivate', 'user', id, null, _safe(old));
    return old;
  }

  function _safe(u) {
    return {
      id: u.id,
      name: u.name,
      username: u.username,
      role: u.role,
      permissions: u.permissions,
      active: u.active,
    };
  }

  /* ===================================================================
   * الواجهة
   * =================================================================== */
  async function render(content) {
    if (!Auth.isManager()) {
      content.innerHTML =
        '<div class="placeholder"><div class="placeholder-icon">🔒</div><p>هذا القسم للمدير فقط.</p></div>';
      return;
    }
    content.innerHTML = '<div class="loading">جارٍ التحميل…</div>';
    const users = await _list();
    content.innerHTML = `
      <div class="toolbar">
        <h3 style="flex:1;margin:0">الموظفون</h3>
        <button class="btn btn-primary" id="usr-add">+ إضافة موظف</button>
      </div>
      <div class="table-scroll"><table class="data-table">
        <thead><tr><th>الاسم</th><th>اسم المستخدم</th><th>الدور</th><th>الصلاحيات</th><th>الحالة</th><th>إجراءات</th></tr></thead>
        <tbody>${users
          .map(
            (u) => `<tr class="${u.active ? '' : 'row-archived'}">
            <td>${Utils.escapeHtml(u.name)}</td>
            <td class="mono">${Utils.escapeHtml(u.username)}</td>
            <td>${u.role === 'manager' ? '<span class="tag tag-ok">مدير</span>' : 'موظف'}</td>
            <td>${
              u.role === 'manager'
                ? 'كل الأقسام'
                : Utils.escapeHtml(_permLabels(u.permissions).join('، ') || 'لا شيء')
            }</td>
            <td>${u.active ? '<span class="tag tag-ok">نشط</span>' : '<span class="tag tag-muted">موقوف</span>'}</td>
            <td class="actions-cell">
              <button class="btn btn-sm btn-ghost" data-edit="${u.id}">تعديل</button>
              <button class="btn btn-sm btn-ghost" data-toggle="${u.id}">${
              u.active ? 'إيقاف' : 'تفعيل'
            }</button>
            </td></tr>`
          )
          .join('')}</tbody>
      </table></div>`;

    content.querySelector('#usr-add').onclick = () => _openForm(null, content);
    content.querySelectorAll('[data-edit]').forEach((b) => {
      b.onclick = async () => {
        const u = await DB.get('users', +b.dataset.edit);
        _openForm(u, content);
      };
    });
    content.querySelectorAll('[data-toggle]').forEach((b) => {
      b.onclick = async () => {
        try {
          const u = await DB.get('users', +b.dataset.toggle);
          await setActive(u.id, !u.active);
          Utils.toast('تم التحديث', 'success');
          render(content);
        } catch (err) {
          Utils.toast(err.message, 'error');
        }
      };
    });
  }

  function _permLabels(perms) {
    const map = {};
    App.PERMISSION_KEYS.forEach((p) => (map[p.key] = p.label));
    return (perms || []).map((k) => map[k] || k);
  }

  function _openForm(user, content) {
    const isEdit = !!user;
    const perms = (user && user.permissions) || [];
    const role = (user && user.role) || 'cashier';
    const permChecks = App.PERMISSION_KEYS.map(
      (p) => `<label class="chk-inline">
        <input type="checkbox" name="perm" value="${p.key}" ${perms.includes(p.key) ? 'checked' : ''} />
        ${Utils.escapeHtml(p.label)}
      </label>`
    ).join('');

    const overlay = Utils.el(`
      <div class="modal-overlay"><div class="modal modal-lg">
        <div class="modal-header">${isEdit ? 'تعديل موظف' : 'إضافة موظف'}</div>
        <form class="modal-body form-grid" id="usr-form">
          <label>الاسم *<input name="name" required value="${Utils.escapeHtml(
            (user && user.name) || ''
          )}" /></label>
          <label>اسم المستخدم *
            <input name="username" required value="${Utils.escapeHtml(
              (user && user.username) || ''
            )}" ${isEdit ? 'readonly' : ''} class="mono" />
          </label>
          <label>كلمة المرور ${isEdit ? '(اتركها فارغة للإبقاء عليها)' : '*'}
            <input name="password" type="password" autocomplete="new-password" ${
              isEdit ? '' : 'required'
            } />
          </label>
          <label>PIN (اختياري — للموافقات السريعة)
            <input name="pin" type="text" inputmode="numeric" autocomplete="off" />
          </label>
          <label class="span-2">الدور
            <select name="role" id="usr-role">
              <option value="cashier" ${role === 'cashier' ? 'selected' : ''}>موظف</option>
              <option value="manager" ${role === 'manager' ? 'selected' : ''}>مدير (صلاحية كاملة)</option>
            </select>
          </label>
          <div class="span-2" id="perm-box">
            <div class="form-section-title" style="margin:0 0 8px">صلاحيات الأقسام</div>
            <div class="perm-grid">${permChecks}</div>
          </div>
          <div class="span-2" id="code-box"></div>
          <div class="form-error span-2" id="usr-err"></div>
        </form>
        <div class="modal-footer">
          <button class="btn btn-ghost" data-act="cancel">إلغاء</button>
          <button class="btn btn-primary" data-act="save">${isEdit ? 'حفظ' : 'إضافة'}</button>
        </div>
      </div></div>`);
    document.body.appendChild(overlay);
    const form = overlay.querySelector('#usr-form');
    const roleSel = overlay.querySelector('#usr-role');
    const permBox = overlay.querySelector('#perm-box');
    const codeBox = overlay.querySelector('#code-box');

    // حالة سر الكود المتغيّر داخل النموذج
    let pinSecret = (user && user.pinSecret) || null;
    let codeTimer = null;

    const drawCodeBox = () => {
      if (roleSel.value !== 'manager') {
        codeBox.innerHTML = '';
        return;
      }
      if (!pinSecret) {
        codeBox.innerHTML = `
          <div class="form-section-title" style="margin:0 0 8px">الكود المتغيّر للمدير</div>
          <p class="form-note">يُولَّد سر للمدير، ومنه يُحسب كود يتغيّر كل ساعتين تلقائيًا. الموظف يطلب الكود الحالي منك عند العمليات الحساسة.</p>
          <button type="button" class="btn btn-ghost" id="gen-secret">توليد سر الكود المتغيّر</button>`;
        codeBox.querySelector('#gen-secret').onclick = () => {
          pinSecret = RotatingCode.genSecret();
          drawCodeBox();
        };
        return;
      }
      codeBox.innerHTML = `
        <div class="form-section-title" style="margin:0 0 8px">الكود المتغيّر للمدير 🔐</div>
        <div class="code-live">
          <div>
            <div class="code-now" id="code-now">------</div>
            <div class="form-note" id="code-left"></div>
          </div>
          <div class="code-secret">
            <div class="form-note">السر (انسخه إلى المولّد على موبايلك مرة واحدة):</div>
            <code class="secret-val" id="secret-val">${Utils.escapeHtml(pinSecret)}</code>
            <div class="code-actions">
              <button type="button" class="btn btn-sm btn-ghost" id="copy-secret">نسخ السر</button>
              <button type="button" class="btn btn-sm btn-ghost" id="regen-secret">إعادة توليد</button>
            </div>
          </div>
        </div>
        <p class="form-note">افتح ملف <strong>manager-code.html</strong> على موبايلك، الصق السر مرة واحدة، وستظهر لك الأكواد المتغيّرة دائمًا — حتى بدون إنترنت.</p>`;

      const tick = () => {
        const now = Date.now();
        const codeNow = overlay.querySelector('#code-now');
        const codeLeft = overlay.querySelector('#code-left');
        if (!codeNow) return;
        codeNow.textContent = RotatingCode.current(pinSecret, now);
        const ms = RotatingCode.msToNext(now);
        const m = Math.floor(ms / 60000);
        const sec = Math.floor((ms % 60000) / 1000);
        codeLeft.textContent = 'يتغيّر خلال ' + m + ':' + String(sec).padStart(2, '0');
      };
      tick();
      clearInterval(codeTimer);
      codeTimer = setInterval(tick, 1000);

      overlay.querySelector('#copy-secret').onclick = () => {
        navigator.clipboard && navigator.clipboard.writeText(pinSecret);
        Utils.toast('تم نسخ السر', 'success');
      };
      overlay.querySelector('#regen-secret').onclick = async () => {
        if (await Utils.confirmBox('إعادة توليد السر ستُبطل الكود على المولّد القديم. متابعة؟')) {
          pinSecret = RotatingCode.genSecret();
          drawCodeBox();
        }
      };
    };

    const syncPerm = () => {
      permBox.style.display = roleSel.value === 'manager' ? 'none' : 'block';
      drawCodeBox();
    };
    roleSel.onchange = syncPerm;
    syncPerm();

    const close = () => {
      clearInterval(codeTimer);
      overlay.remove();
    };
    overlay.querySelector('[data-act="cancel"]').onclick = close;
    overlay.addEventListener('click', (e) => e.target === overlay && close());
    overlay.querySelector('[data-act="save"]').onclick = async () => {
      if (!form.reportValidity()) return;
      const permissions = Array.from(form.querySelectorAll('input[name="perm"]:checked')).map(
        (c) => c.value
      );
      const data = {
        name: form.name.value,
        username: form.username.value,
        password: form.password.value,
        pin: form.pin.value,
        role: form.role.value,
        permissions,
        pinSecret,
      };
      try {
        if (isEdit) await updateUser(user.id, data);
        else await createUser(data);
        Utils.toast('تم الحفظ', 'success');
        close();
        App.renderNav(); // تحديث القائمة لو تغيّرت صلاحيات المستخدم الحالي
        render(content);
      } catch (err) {
        overlay.querySelector('#usr-err').textContent = err.message;
      }
    };
    setTimeout(() => form.name.focus(), 50);
  }

  return { render, createUser, updateUser, setActive };
})();

window.Users = Users;
