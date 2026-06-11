'use strict';
/* طباعة خام للطابعات على ويندوز (ZPL/ESC-POS) عبر Win32 winspool —
 * بدون أي وحدات native تحتاج بناء: نستدعي PowerShell مع RawPrinterHelper.
 * data: نص (ZPL) أو سلسلة بايتات بترميز "binary/latin1" (ESC-POS). */
const { spawn } = require('child_process');

function printRaw(printerName, data) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') {
      resolve({ success: false, reason: 'الطباعة الخام مدعومة على ويندوز فقط' });
      return;
    }
    // نمرّر البيانات كـ Base64 لتفادي مشاكل الاقتباس/المحارف الخاصة
    const b64 = Buffer.from(String(data), 'binary').toString('base64');
    const safePrinter = String(printerName || '').replace(/'/g, "''");

    const script = [
      "$ErrorActionPreference='Stop'",
      'Add-Type @"',
      'using System;',
      'using System.Runtime.InteropServices;',
      'public class RawPrinterHelper {',
      '  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]',
      '  public struct DOCINFOW { [MarshalAs(UnmanagedType.LPWStr)] public string pDocName; [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile; [MarshalAs(UnmanagedType.LPWStr)] public string pDataType; }',
      '  [DllImport("winspool.Drv", EntryPoint="OpenPrinterW", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool OpenPrinter(string src, out IntPtr h, IntPtr pd);',
      '  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);',
      '  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterW", SetLastError=true, CharSet=CharSet.Unicode)] public static extern bool StartDocPrinter(IntPtr h, int level, ref DOCINFOW di);',
      '  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);',
      '  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);',
      '  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);',
      '  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)] public static extern bool WritePrinter(IntPtr h, byte[] buf, int count, out int written);',
      '  public static bool SendBytes(string printer, byte[] bytes) {',
      '    IntPtr h; if(!OpenPrinter(printer, out h, IntPtr.Zero)) return false;',
      '    DOCINFOW di = new DOCINFOW(); di.pDocName="Cashier RAW"; di.pDataType="RAW";',
      '    bool ok=false;',
      '    if(StartDocPrinter(h, 1, ref di)){ if(StartPagePrinter(h)){ int w; ok=WritePrinter(h, bytes, bytes.Length, out w); EndPagePrinter(h);} EndDocPrinter(h);}',
      '    ClosePrinter(h); return ok;',
      '  }',
      '}',
      '"@',
      "$bytes=[Convert]::FromBase64String('" + b64 + "')",
      '$printer=' + (safePrinter ? "'" + safePrinter + "'" : '(Get-CimInstance Win32_Printer | Where-Object {$_.Default -eq $true}).Name'),
      'if([string]::IsNullOrEmpty($printer)){ Write-Output "NOPRINTER"; exit 1 }',
      '$r=[RawPrinterHelper]::SendBytes($printer, $bytes)',
      'if($r){ Write-Output "OK" } else { Write-Output "FAIL" }',
    ].join('\n');

    let out = '';
    let err = '';
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true }
    );
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('error', (e) => resolve({ success: false, reason: String(e) }));
    child.on('close', (code) => {
      const success = /OK/.test(out);
      let reason = '';
      if (!success) {
        if (/NOPRINTER/.test(out)) reason = 'لم يتم تحديد طابعة ولا توجد طابعة افتراضية';
        else reason = (err || out || 'exit ' + code).trim();
      }
      resolve({ success, reason });
    });
  });
}

module.exports = { printRaw };
