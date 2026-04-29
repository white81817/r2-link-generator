import { Hono } from 'hono';
import { cors } from 'hono/cors';
import * as XLSX from 'xlsx';
import { zipSync } from 'fflate';

const app = new Hono();

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use('/api/*', cors({
  origin: [
    'https://ec.mallbic.com',
    'https://admin.1shop.tw',
    'https://scm.mamilove.com.tw',
  ],
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type'],
  credentials: false,
}));

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ── Parse ERP ─────────────────────────────────────────────────────────────────
// POST /api/parse-erp
// FormData: single (xlsx, optional), composite (xlsx, optional)
// Response: JSON mapping
app.post('/api/parse-erp', async (c) => {
  let formData;
  try { formData = await c.req.formData(); }
  catch { return c.json({ error: '無法解析 FormData' }, 400); }

  const singleFile    = formData.get('single');
  const compositeFile = formData.get('composite');
  if (!singleFile && !compositeFile) {
    return c.json({ error: '請提供 single 或 composite 檔案' }, 400);
  }

  // ── 解析單品 ──
  const erpSingleMap          = {};
  const erpSingleCanPreorder  = {};
  const erpBarcodeMap         = {};
  const erpBarcodeCanPreorder = {};
  const erpProductCodeMap     = {};
  const erpProductCodeCanPreorder = {};

  if (singleFile) {
    try {
      const buf  = await singleFile.arrayBuffer();
      const wb   = XLSX.read(buf, { type: 'array' });
      const sn   = wb.SheetNames.find(n => n.includes('商品資料')) || wb.SheetNames[0];
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '' });

      for (let i = 1; i < rows.length; i++) {
        const row         = rows[i];
        const productCode = String(row[0]  || '').trim();
        const barcode     = String(row[19] || '').trim();
        const stock       = Number(row[20]) || 0;
        const canPreorder = String(row[18] || '').trim() === '可追';
        if (!productCode) continue;

        const trueCode = barcode || productCode;
        if (!(trueCode in erpSingleMap) || stock > erpSingleMap[trueCode])
          erpSingleMap[trueCode] = stock;
        erpSingleCanPreorder[trueCode] = canPreorder || (erpSingleCanPreorder[trueCode] || false);

        if (barcode) {
          if (!(barcode in erpBarcodeMap) || stock > erpBarcodeMap[barcode])
            erpBarcodeMap[barcode] = stock;
          erpBarcodeCanPreorder[barcode] = canPreorder || (erpBarcodeCanPreorder[barcode] || false);
        }
        if (!(productCode in erpProductCodeMap) || stock > erpProductCodeMap[productCode])
          erpProductCodeMap[productCode] = stock;
        erpProductCodeCanPreorder[productCode] = canPreorder || (erpProductCodeCanPreorder[productCode] || false);
      }
    } catch (e) {
      return c.json({ error: '解析單品檔案失敗：' + e.message }, 400);
    }
  }

  // ── 解析複合商品（單品必須先跑完）──
  const erpCompositeMap = {};

  if (compositeFile) {
    try {
      const buf  = await compositeFile.arrayBuffer();
      const wb   = XLSX.read(buf, { type: 'array' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });

      const groups = {};
      for (let i = 1; i < rows.length; i++) {
        const row           = rows[i];
        const compositeCode = String(row[0]  || '').trim();
        const compCode      = String(row[9]  || '').trim();
        const compBarcode   = String(row[10] || '').trim();
        if (!compositeCode || !compCode) continue;
        const trueCode = compBarcode || compCode;
        if (!groups[compositeCode]) groups[compositeCode] = {};
        groups[compositeCode][trueCode] = (groups[compositeCode][trueCode] || 0) + 1;
      }

      for (const [compositeCode, components] of Object.entries(groups)) {
        let minSets = Infinity, bottleneckCode = '', bottleneckStock = 0;
        for (const [tc, qty] of Object.entries(components)) {
          const avail = erpSingleMap[tc] ?? 0;
          const sets  = Math.floor(avail / qty);
          if (sets < minSets) { minSets = sets; bottleneckCode = tc; bottleneckStock = avail; }
        }
        let canPreorder = Object.keys(components).length > 0;
        for (const tc of Object.keys(components)) {
          if (!erpSingleCanPreorder[tc]) { canPreorder = false; break; }
        }
        erpCompositeMap[compositeCode] = {
          sets: minSets === Infinity ? 0 : minSets,
          bottleneckCode,
          bottleneckStock,
          canPreorder,
        };
      }
    } catch (e) {
      return c.json({ error: '解析複合商品檔案失敗：' + e.message }, 400);
    }
  }

  return c.json({
    barcodeMap:             erpBarcodeMap,
    barcodeCanPreorder:     erpBarcodeCanPreorder,
    compositeMap:           erpCompositeMap,
    productCodeMap:         erpProductCodeMap,
    productCodeCanPreorder: erpProductCodeCanPreorder,
  });
});

// ── Lookup helper ─────────────────────────────────────────────────────────────
function lookup(code, mapping) {
  const { barcodeMap, barcodeCanPreorder, compositeMap, productCodeMap, productCodeCanPreorder } = mapping;
  if (barcodeMap[code]    !== undefined) return { stock: barcodeMap[code],    canPreorder: barcodeCanPreorder[code]    || false };
  if (compositeMap[code]  !== undefined) return { stock: compositeMap[code].sets, canPreorder: compositeMap[code].canPreorder || false };
  if (productCodeMap[code] !== undefined) return { stock: productCodeMap[code], canPreorder: productCodeCanPreorder[code] || false };
  return null;
}

// ── Date helper ───────────────────────────────────────────────────────────────
function dateStr() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}

// ── Gen 1shop update ──────────────────────────────────────────────────────────
// POST /api/gen-1shop-update
// FormData: platform (xlsx), mapping (JSON string from parse-erp)
// Response: zip (N xlsx + manifest.json)
app.post('/api/gen-1shop-update', async (c) => {
  let formData;
  try { formData = await c.req.formData(); }
  catch { return c.json({ error: '無法解析 FormData' }, 400); }

  const platformFile = formData.get('platform');
  const mappingStr   = formData.get('mapping');
  if (!platformFile || !mappingStr) return c.json({ error: '需要 platform 檔案與 mapping JSON' }, 400);

  let mapping;
  try { mapping = JSON.parse(mappingStr); }
  catch { return c.json({ error: 'mapping JSON 格式錯誤' }, 400); }

  let rows, sheetName;
  try {
    const buf  = await platformFile.arrayBuffer();
    const wb   = XLSX.read(buf, { type: 'array' });
    sheetName  = wb.SheetNames[0];
    rows       = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
  } catch (e) {
    return c.json({ error: '解析平台檔案失敗：' + e.message }, 400);
  }

  let matched = 0, updated = 0, unmatched = 0;
  const unmatchedCodes = [];

  // col 1=類型, col 13=貨號, col 16=現貨數量, col 17=預購數量
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][1] || '').trim() !== '子項') continue;
    const code = String(rows[i][13] || '').trim();
    if (!code) continue;
    matched++;
    const result = lookup(code, mapping);
    if (result !== null) {
      rows[i][16] = result.stock;
      rows[i][17] = result.canPreorder ? 500 : 0;
      updated++;
    } else {
      rows[i][16] = 0;
      rows[i][17] = 0;
      unmatched++;
      unmatchedCodes.push(code);
    }
  }

  const CHUNK = 500;
  const header   = rows[0];
  const dataRows = rows.slice(1);
  const ds       = dateStr();
  const zipFiles = {};
  const parts    = [];

  if (dataRows.length > CHUNK) {
    let num = 1;
    for (let offset = 0; offset < dataRows.length; offset += CHUNK) {
      const chunk    = [header, ...dataRows.slice(offset, offset + CHUNK)];
      const filename = `官網_庫存更新_${ds}_part${num}.xlsx`;
      const newWb    = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(newWb, XLSX.utils.aoa_to_sheet(chunk), sheetName);
      zipFiles[filename] = new Uint8Array(XLSX.write(newWb, { type: 'array', bookType: 'xlsx' }));
      parts.push({ filename, dataRows: chunk.length - 1 });
      num++;
    }
  } else {
    const filename = `官網_庫存更新_${ds}.xlsx`;
    const newWb    = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(newWb, XLSX.utils.aoa_to_sheet(rows), sheetName);
    zipFiles[filename] = new Uint8Array(XLSX.write(newWb, { type: 'array', bookType: 'xlsx' }));
    parts.push({ filename, dataRows: dataRows.length });
  }

  const manifest = { generatedAt: new Date().toISOString(), platform: '1shop',
    stats: { matched, updated, unmatched }, unmatchedCodes, parts };
  zipFiles['manifest.json'] = new TextEncoder().encode(JSON.stringify(manifest, null, 2));

  const zipped = zipSync(zipFiles);
  return c.body(zipped, 200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="1shop_update_${ds}.zip"`,
  });
});

// ── Gen 媽咪愛 update ──────────────────────────────────────────────────────────
// POST /api/gen-mamilove-update
// FormData: platform (xlsx), mapping (JSON string from parse-erp)
// Response: zip (1 xlsx + manifest.json)
app.post('/api/gen-mamilove-update', async (c) => {
  let formData;
  try { formData = await c.req.formData(); }
  catch { return c.json({ error: '無法解析 FormData' }, 400); }

  const platformFile = formData.get('platform');
  const mappingStr   = formData.get('mapping');
  if (!platformFile || !mappingStr) return c.json({ error: '需要 platform 檔案與 mapping JSON' }, 400);

  let mapping;
  try { mapping = JSON.parse(mappingStr); }
  catch { return c.json({ error: 'mapping JSON 格式錯誤' }, 400); }

  let rows, sheetName;
  try {
    const buf  = await platformFile.arrayBuffer();
    const wb   = XLSX.read(buf, { type: 'array' });
    sheetName  = wb.SheetNames[0];
    rows       = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
  } catch (e) {
    return c.json({ error: '解析平台檔案失敗：' + e.message }, 400);
  }

  let matched = 0, updated = 0, unmatched = 0;
  const unmatchedCodes = [];

  // col 2=商品貨號, col 4=客訂數, col 6=備貨量
  for (let i = 1; i < rows.length; i++) {
    const code = String(rows[i][2] || '').trim();
    if (!code) continue;
    matched++;
    const result = lookup(code, mapping);
    if (result !== null) {
      rows[i][6] = Math.max(0, result.stock - (Number(rows[i][4]) || 0));
      updated++;
    } else {
      unmatched++;
      unmatchedCodes.push(code);
    }
  }

  const ds       = dateStr();
  const filename = `媽咪愛_庫存更新_${ds}.xlsx`;
  const newWb    = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(newWb, XLSX.utils.aoa_to_sheet(rows), sheetName);
  const xlsxData = new Uint8Array(XLSX.write(newWb, { type: 'array', bookType: 'xlsx' }));

  const manifest = { generatedAt: new Date().toISOString(), platform: 'mamilove',
    stats: { matched, updated, unmatched }, unmatchedCodes,
    parts: [{ filename, dataRows: rows.length - 1 }] };

  const zipped = zipSync({
    [filename]: xlsxData,
    'manifest.json': new TextEncoder().encode(JSON.stringify(manifest, null, 2)),
  });

  return c.body(zipped, 200, {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="mamilove_update_${ds}.zip"`,
  });
});

export default app;
