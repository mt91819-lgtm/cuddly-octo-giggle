'use strict';
/* العملية الرئيسية لـ Electron: تفتح النظام الحالي في نافذة برنامج،
 * وتوفّر طباعة مباشرة (ZPL خام للـ Zebra) وطباعة صامتة للإيصال (بدون نافذة طباعة). */
const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const { printRaw } = require('./print-raw');

let mainWindow = null;

// منع تشغيل أكثر من نسخة (نسختان تتنازعان قفل قاعدة البيانات → Internal error)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    title: 'Cashier Pro',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  Menu.setApplicationMenu(null); // إخفاء شريط القوائم
  mainWindow.loadFile(path.join(__dirname, '..', 'cashier', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ---------- معالجات الطباعة (IPC) ---------- */

// قائمة الطابعات المثبّتة على الجهاز
ipcMain.handle('printers:list', async (event) => {
  try {
    const printers = await event.sender.getPrintersAsync();
    return printers.map((p) => ({ name: p.name, displayName: p.displayName, isDefault: p.isDefault }));
  } catch (e) {
    return [];
  }
});

// طباعة خام: ترسل البايتات كما هي للطابعة (ZPL / ESC-POS) — بدون نافذة ولا تحويل
ipcMain.handle('print:raw', async (event, payload) => {
  const printerName = (payload && payload.printerName) || '';
  const data = (payload && payload.data) || '';
  return printRaw(printerName, data);
});

// طباعة HTML صامتة (للإيصال العربي): تُرسم في نافذة مخفية وتُطبع بدون نافذة طباعة،
// مع ضبط طول الصفحة على طول المحتوى حتى لا تتغذّى ورق فاضي.
ipcMain.handle('print:html', async (event, payload) => {
  const html = (payload && payload.html) || '';
  const printerName = (payload && payload.printerName) || '';
  const pageWidthMm = Number(payload && payload.pageWidthMm) || 80;

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { offscreen: false, javascript: true },
    });
    let settled = false;
    const done = (success, reason) => {
      if (settled) return;
      settled = true;
      resolve({ success, reason: reason || '' });
      setTimeout(() => {
        try { if (!win.isDestroyed()) win.close(); } catch (e) {}
      }, 1500);
    };

    win.webContents.on('did-finish-load', async () => {
      try {
        // طول المحتوى بالبكسل ← مايكرومتر (1px = 1/96 بوصة)
        const h = await win.webContents.executeJavaScript(
          'Math.ceil(document.body.scrollHeight)'
        );
        const widthMicrons = Math.round(pageWidthMm * 1000);
        const heightMicrons = Math.max(20000, Math.round((Number(h) / 96) * 25400));
        const opts = {
          silent: true,
          printBackground: true,
          margins: { marginType: 'none' },
          pageSize: { width: widthMicrons, height: heightMicrons },
        };
        if (printerName) opts.deviceName = printerName;
        win.webContents.print(opts, (success, reason) => done(success, reason));
      } catch (e) {
        done(false, String(e));
      }
    });

    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });
});
