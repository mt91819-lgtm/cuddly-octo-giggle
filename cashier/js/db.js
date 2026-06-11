/* =====================================================================
 * db.js  —  طبقة قاعدة البيانات (IndexedDB)
 * نظام Cashier Pro Offline
 * يعمل بالكامل محليًا بدون أي خادم أو إنترنت.
 *
 * يحتوي هذا الملف على:
 *   - تعريف قاعدة البيانات وكل الجداول (Object Stores) لكل المراحل.
 *   - دوال مساعدة عامة للقراءة والكتابة (CRUD).
 *   - عدّاد آمن لأرقام الفواتير (لمنع التكرار).
 *
 * ملاحظة: تم تعريف كل الجداول مسبقًا حتى يبقى مخطط القاعدة ثابتًا
 *         عبر كل المراحل القادمة دون الحاجة لترقيات لاحقة.
 * ===================================================================== */

const DB = (() => {
  const DB_NAME = 'cashier_pro_db';
  const DB_VERSION = 1;

  let _db = null;

  /* تعريف الجداول وفهارسها */
  const STORES = {
    users: {
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        { name: 'username', keyPath: 'username', unique: true },
        { name: 'role', keyPath: 'role', unique: false },
        { name: 'active', keyPath: 'active', unique: false },
      ],
    },
    products: {
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        { name: 'sku', keyPath: 'sku', unique: true },
        { name: 'barcode', keyPath: 'barcode', unique: true },
        { name: 'name', keyPath: 'name', unique: false },
        { name: 'category', keyPath: 'category', unique: false },
        { name: 'supplier', keyPath: 'supplier', unique: false },
        { name: 'archived', keyPath: 'archived', unique: false },
      ],
    },
    categories: {
      keyPath: 'id',
      autoIncrement: true,
      indexes: [{ name: 'name', keyPath: 'name', unique: true }],
    },
    suppliers: {
      keyPath: 'id',
      autoIncrement: true,
      indexes: [{ name: 'name', keyPath: 'name', unique: true }],
    },
    invoices: {
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        { name: 'number', keyPath: 'number', unique: true },
        { name: 'status', keyPath: 'status', unique: false },
        { name: 'userId', keyPath: 'userId', unique: false },
        { name: 'shiftId', keyPath: 'shiftId', unique: false },
        { name: 'createdAt', keyPath: 'createdAt', unique: false },
        { name: 'paymentMethod', keyPath: 'paymentMethod', unique: false },
      ],
    },
    inventory_movements: {
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        { name: 'productId', keyPath: 'productId', unique: false },
        { name: 'type', keyPath: 'type', unique: false },
        { name: 'createdAt', keyPath: 'createdAt', unique: false },
      ],
    },
    returns: {
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        { name: 'invoiceId', keyPath: 'invoiceId', unique: false },
        { name: 'userId', keyPath: 'userId', unique: false },
        { name: 'createdAt', keyPath: 'createdAt', unique: false },
      ],
    },
    expenses: {
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        { name: 'type', keyPath: 'type', unique: false },
        { name: 'userId', keyPath: 'userId', unique: false },
        { name: 'createdAt', keyPath: 'createdAt', unique: false },
      ],
    },
    shifts: {
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        { name: 'userId', keyPath: 'userId', unique: false },
        { name: 'status', keyPath: 'status', unique: false },
        { name: 'openedAt', keyPath: 'openedAt', unique: false },
      ],
    },
    cash_movements: {
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        { name: 'shiftId', keyPath: 'shiftId', unique: false },
        { name: 'type', keyPath: 'type', unique: false },
        { name: 'createdAt', keyPath: 'createdAt', unique: false },
      ],
    },
    audit_log: {
      keyPath: 'id',
      autoIncrement: true,
      indexes: [
        { name: 'userId', keyPath: 'userId', unique: false },
        { name: 'action', keyPath: 'action', unique: false },
        { name: 'entity', keyPath: 'entity', unique: false },
        { name: 'createdAt', keyPath: 'createdAt', unique: false },
      ],
    },
    counters: {
      keyPath: 'key',
      autoIncrement: false,
      indexes: [],
    },
    settings: {
      keyPath: 'key',
      autoIncrement: false,
      indexes: [],
    },
  };

  /* فتح / إنشاء قاعدة البيانات (مع إعادة محاولة عند قفل مؤقت) */
  function open() {
    if (_db) return Promise.resolve(_db);
    return _openOnce().catch((err) => {
      // "Internal error" يحدث غالبًا عند تنازع نسختين على قفل القاعدة — نعيد المحاولة
      const msg = (err && err.message) || '';
      if (/internal error|unknownerror/i.test(msg) || (err && err.name === 'UnknownError')) {
        return _delay(1500)
          .then(_openOnce)
          .catch(() => _delay(3000).then(_openOnce))
          .catch(() => {
            throw new Error(
              'تعذّر فتح قاعدة البيانات (قد تكون نسخة أخرى من البرنامج مفتوحة). ' +
                'أغلق كل نسخ البرنامج أو أعد تشغيل الجهاز ثم افتح البرنامج من جديد.'
            );
          });
      }
      throw err;
    });
  }

  function _delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function _openOnce() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('المتصفح لا يدعم IndexedDB'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);

      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        Object.entries(STORES).forEach(([name, cfg]) => {
          let store;
          if (!db.objectStoreNames.contains(name)) {
            store = db.createObjectStore(name, {
              keyPath: cfg.keyPath,
              autoIncrement: cfg.autoIncrement,
            });
          } else {
            store = e.target.transaction.objectStore(name);
          }
          (cfg.indexes || []).forEach((idx) => {
            if (!store.indexNames.contains(idx.name)) {
              store.createIndex(idx.name, idx.keyPath, { unique: idx.unique });
            }
          });
        });
      };

      req.onsuccess = (e) => {
        _db = e.target.result;
        _db.onversionchange = () => {
          _db.close();
          _db = null;
        };
        resolve(_db);
      };

      req.onerror = (e) => reject(e.target.error);
    });
  }

  /* تنفيذ معاملة (transaction) على جدول واحد */
  function _tx(storeName, mode, fn) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, mode);
          const store = tx.objectStore(storeName);
          let result;
          try {
            result = fn(store, tx);
          } catch (err) {
            reject(err);
            return;
          }
          tx.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error || new Error('تم إلغاء المعاملة'));
        })
    );
  }

  /* تغليف طلب IndexedDB في Promise يكتمل عند انتهاء المعاملة */
  function _wrap(request) {
    return { __req: request };
  }

  /* ---------- دوال CRUD عامة ---------- */

  function add(storeName, value) {
    return _tx(storeName, 'readwrite', (store) => _wrap(store.add(value)));
  }

  function put(storeName, value) {
    return _tx(storeName, 'readwrite', (store) => _wrap(store.put(value)));
  }

  function get(storeName, key) {
    return _tx(storeName, 'readonly', (store) => _wrap(store.get(key)));
  }

  function remove(storeName, key) {
    // حذف فعلي — يُستخدم فقط للبيانات المؤقتة، وليس للمنتجات أو الفواتير.
    return _tx(storeName, 'readwrite', (store) => _wrap(store.delete(key)));
  }

  function getAll(storeName) {
    return _tx(storeName, 'readonly', (store) => _wrap(store.getAll()));
  }

  function count(storeName) {
    return _tx(storeName, 'readonly', (store) => _wrap(store.count()));
  }

  function clear(storeName) {
    return _tx(storeName, 'readwrite', (store) => _wrap(store.clear()));
  }

  /* كتابة مجموعة سجلات في معاملة واحدة (للاستيراد) */
  function bulkPut(storeName, records) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, 'readwrite');
          const store = tx.objectStore(storeName);
          (records || []).forEach((r) => store.put(r));
          tx.oncomplete = () => resolve((records || []).length);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        })
    );
  }

  /* استبدال محتوى جدول بالكامل (مسح ثم كتابة) في معاملة واحدة */
  function replaceStore(storeName, records) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, 'readwrite');
          const store = tx.objectStore(storeName);
          store.clear();
          (records || []).forEach((r) => store.put(r));
          tx.oncomplete = () => resolve((records || []).length);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        })
    );
  }

  /* جلب السجلات عبر فهرس بقيمة محددة */
  function getByIndex(storeName, indexName, value) {
    return _tx(storeName, 'readonly', (store) => {
      const index = store.index(indexName);
      return _wrap(index.getAll(value));
    });
  }

  /* جلب أول سجل مطابق عبر فهرس (مفيد للـ unique مثل username / sku / barcode) */
  function getOneByIndex(storeName, indexName, value) {
    return _tx(storeName, 'readonly', (store) => {
      const index = store.index(indexName);
      return _wrap(index.get(value));
    });
  }

  /* المرور على السجلات بكفاءة (cursor) — مهم للبيانات الكبيرة */
  function iterate(storeName, callback, { index, range, direction } = {}) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction(storeName, 'readonly');
          const store = tx.objectStore(storeName);
          const source = index ? store.index(index) : store;
          const req = source.openCursor(range || null, direction || 'next');
          req.onsuccess = (e) => {
            const cursor = e.target.result;
            if (cursor) {
              const stop = callback(cursor.value, cursor);
              if (stop === false) {
                resolve();
                return;
              }
              cursor.continue();
            } else {
              resolve();
            }
          };
          req.onerror = () => reject(req.error);
        })
    );
  }

  /* ---------- عدّاد آمن (لأرقام الفواتير وغيرها) ---------- */
  /* يستخدم معاملة واحدة لقراءة + زيادة القيمة لمنع التكرار نهائيًا. */
  function nextCounter(key) {
    return open().then(
      (db) =>
        new Promise((resolve, reject) => {
          const tx = db.transaction('counters', 'readwrite');
          const store = tx.objectStore('counters');
          const getReq = store.get(key);
          let value;
          getReq.onsuccess = () => {
            const rec = getReq.result;
            value = (rec ? rec.value : 0) + 1;
            store.put({ key, value });
          };
          tx.oncomplete = () => resolve(value);
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error);
        })
    );
  }

  /* عدّاد يومي لأرقام الفواتير: مفتاح منفصل لكل يوم */
  function nextDailyInvoiceSeq(dateKey) {
    return nextCounter('invoice_' + dateKey);
  }

  return {
    open,
    add,
    put,
    get,
    remove,
    getAll,
    count,
    clear,
    bulkPut,
    replaceStore,
    getByIndex,
    getOneByIndex,
    iterate,
    nextCounter,
    nextDailyInvoiceSeq,
    STORES,
    DB_NAME,
    DB_VERSION,
  };
})();

window.DB = DB;
