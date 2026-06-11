'use strict';
/* جسر آمن بين النظام (واجهة الويب) والعملية الرئيسية — يُتاح كـ window.desktopPrint */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopPrint', {
  isDesktop: true,
  // قائمة الطابعات المثبّتة: [{ name, displayName, isDefault }]
  listPrinters: () => ipcRenderer.invoke('printers:list'),
  // طباعة خام (ZPL/ESC-POS) — printerName فارغ = الطابعة الافتراضية
  raw: (printerName, data) => ipcRenderer.invoke('print:raw', { printerName, data }),
  // طباعة HTML صامتة (للإيصال) مع عرض الصفحة بالمليمتر
  html: (html, printerName, pageWidthMm) =>
    ipcRenderer.invoke('print:html', { html, printerName, pageWidthMm }),
});
