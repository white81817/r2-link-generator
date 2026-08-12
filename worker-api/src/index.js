import { Hono } from 'hono';
import * as XLSX from 'xlsx';
import { zipSync } from 'fflate';

// ── CORS ──────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://didibox.cc',
  'https://ec.mallbic.com',
  'https://admin.1shop.tw',
  'https://scm.mamilove.com.tw',
];

function corsHeaders(origin) {
  // 允許 file:// 本機測試（瀏覽器送 Origin: null 或不送 Origin）
  if (!origin || origin === 'null') {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Quote-Token',
      'Access-Control-Max-Age': '86400',
    };
  }
  if (!ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Quote-Token',
    'Access-Control-Max-Age': '86400',
  };
}

const app = new Hono();

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/api/health', (c) => c.json({ status: 'ok', timestamp: new Date().toISOString() }));

// ── Cache ─────────────────────────────────────────────────────────────────────
// POST /api/cache  body: { key, value, ttl? }
app.post('/api/cache', async (c) => {
  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: '無法解析 JSON' }, 400); }

  const { key, value, ttl } = body;
  if (!key || value === undefined) return c.json({ error: '需要 key 與 value' }, 400);

  await c.env.CACHE.put(key, JSON.stringify(value), { expirationTtl: ttl || 300 });
  return c.json({ ok: true });
});

// GET /api/cache?key=mapping-12345
app.get('/api/cache', async (c) => {
  const key = c.req.query('key');
  if (!key) return c.json({ error: '需要 key 參數' }, 400);

  const v = await c.env.CACHE.get(key);
  if (!v) return c.text('not found', 404);
  return c.body(v, 200, { 'content-type': 'application/json' });
});

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

// ── Shared: parse 1shop productExport xlsx → rows ────────────────────────────
function parsePlatformXlsx(buf) {
  const wb        = XLSX.read(buf, { type: 'array' });
  const sheetName = wb.SheetNames[0];
  const rows      = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, defval: '' });
  return { rows, sheetName };
}

// ── Shared: rows + mapping → parts xlsx Uint8Array[] ─────────────────────────
// 從 gen-1shop-update 抽出來，給 v1 (zip) 與 v2 (KV store) 共用。
// 回 {stats, unmatchedCodes, parts:[{filename, bytes, dataRows}]}
function buildOneshopParts(rows, sheetName, mapping) {
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
  const parts    = [];

  if (dataRows.length > CHUNK) {
    let num = 1;
    for (let offset = 0; offset < dataRows.length; offset += CHUNK) {
      const chunk    = [header, ...dataRows.slice(offset, offset + CHUNK)];
      const filename = `官網_庫存更新_${ds}_part${num}.xlsx`;
      const newWb    = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(newWb, XLSX.utils.aoa_to_sheet(chunk), sheetName);
      parts.push({
        filename,
        bytes:    new Uint8Array(XLSX.write(newWb, { type: 'array', bookType: 'xlsx' })),
        dataRows: chunk.length - 1,
      });
      num++;
    }
  } else {
    const filename = `官網_庫存更新_${ds}.xlsx`;
    const newWb    = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(newWb, XLSX.utils.aoa_to_sheet(rows), sheetName);
    parts.push({
      filename,
      bytes:    new Uint8Array(XLSX.write(newWb, { type: 'array', bookType: 'xlsx' })),
      dataRows: dataRows.length,
    });
  }

  return { stats: { matched, updated, unmatched }, unmatchedCodes, parts };
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

// ── v2: Build 1shop parts and store in KV ────────────────────────────────────
// POST /api/build-1shop-parts
//   JSON body: { shopName, productExportUrl, mappingKey, cacheTTL? }
//   - server-side fetch productExportUrl (gateway URL 自帶 token, 不需 cookie)
//   - 從 KV 撈 mapping (mappingKey 來自 Step B 寫的 'mapping-today')
//   - 用共用 buildOneshopParts() 切 chunks
//   - 每個 part bytes 直接寫進 KV (ArrayBuffer)，key = `1shop-part-<safe>-<idx>-<ts>`
//   Response: { ok, stats, unmatchedCodes, parts: [{ filename, cacheKey, size }] }
//
// 配 /api/serve-part 一起用 — client 拿到 cacheKey 後 navigate 到 serve-part 觸發瀏覽器
// 原生下載 (Content-Disposition attachment)，落盤後再 file_upload 到 1shop。
// 詳細設計緣由見 2026-05-04 排程報告。
app.post('/api/build-1shop-parts', async (c) => {
  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: '無法解析 JSON' }, 400); }

  const { shopName, productExportUrl, mappingKey, cacheTTL } = body;
  if (!shopName || !productExportUrl || !mappingKey) {
    return c.json({ error: '需要 shopName / productExportUrl / mappingKey' }, 400);
  }

  // 1. 從 KV 拿 mapping
  const mappingRaw = await c.env.CACHE.get(mappingKey);
  if (!mappingRaw) return c.json({ error: `mapping cache key "${mappingKey}" 不存在或已過期` }, 404);
  let mapping;
  try { mapping = JSON.parse(mappingRaw); }
  catch { return c.json({ error: 'mapping JSON 格式錯誤' }, 400); }

  // 2. server-side fetch productExport
  let buf;
  try {
    const resp = await fetch(productExportUrl);
    if (!resp.ok) return c.json({ error: `productExport fetch 失敗: HTTP ${resp.status}` }, 502);
    buf = await resp.arrayBuffer();
  } catch (e) {
    return c.json({ error: 'productExport fetch error: ' + e.message }, 502);
  }

  // 3. parse + build parts
  let parsed;
  try { parsed = parsePlatformXlsx(buf); }
  catch (e) { return c.json({ error: '解析 productExport 失敗：' + e.message }, 400); }

  const { stats, unmatchedCodes, parts } = buildOneshopParts(parsed.rows, parsed.sheetName, mapping);

  // 4. 寫進 KV (binary)，key 帶 ts 避免跨 run 衝突
  const ttl       = Number(cacheTTL) || 3600;
  const ts        = Date.now();
  const safe      = String(shopName).replace(/[^A-Za-z0-9_-]/g, '_');
  const outParts  = [];
  for (let i = 0; i < parts.length; i++) {
    const cacheKey = `1shop-part-${safe}-${i + 1}-${ts}`;
    await c.env.CACHE.put(cacheKey, parts[i].bytes, { expirationTtl: ttl });
    outParts.push({
      filename: parts[i].filename,
      cacheKey,
      size:     parts[i].bytes.byteLength,
    });
  }

  return c.json({ ok: true, stats, unmatchedCodes, parts: outParts });
});

// ── v2: Serve a single 1shop part from KV with attachment header ──────────────
// GET /api/serve-part?key=<cacheKey>&name=<download filename, optional>
//   - 從 KV 撈 binary
//   - 回傳時 Content-Disposition: attachment; filename*=UTF-8''<encoded>
//   - 必須用 new Response(buf, {...})，Hono c.body 第三 arg 在 binary 不生效
//     (Content-Disposition 會掉)
app.get('/api/serve-part', async (c) => {
  const key  = c.req.query('key');
  const name = c.req.query('name') || 'part.xlsx';
  if (!key) return c.json({ error: '需要 key 參數' }, 400);

  const buf = await c.env.CACHE.get(key, { type: 'arrayBuffer' });
  if (!buf) return c.text('part not found or expired', 404);

  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type':        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control':       'no-store',
    },
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

// ── Quote helpers ─────────────────────────────────────────────────────────────
// 需在 Cloudflare 設定兩組 secret：QUOTE_PASSWORD（業務）、QUOTE_ADMIN_PASSWORD（主管）
function validateQuoteToken(token, env) {
  if (!token) return null;
  if (env.QUOTE_ADMIN_PASSWORD && token === env.QUOTE_ADMIN_PASSWORD) return 'admin';
  if (env.QUOTE_PASSWORD && token === env.QUOTE_PASSWORD) return 'user';
  return null;
}

// POST /api/quotes/auth  body: { password }
app.post('/api/quotes/auth', async (c) => {
  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: '無法解析 JSON' }, 400); }
  const role = validateQuoteToken(body.password, c.env);
  if (!role) return c.json({ error: '密碼錯誤' }, 401);
  return c.json({ role });
});

// POST /api/quotes  body: quote JSON
app.post('/api/quotes', async (c) => {
  const token = c.req.header('X-Quote-Token');
  const role = validateQuoteToken(token, c.env);
  if (!role) return c.json({ error: '未授權' }, 401);

  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: '無法解析 JSON' }, 400); }

  const id = `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const taxType   = body.taxType === 'excluded' ? 'excluded' : 'included';
  const subtotal  = (body.items || []).reduce((s, it) => s + (Number(it.subtotal) || 0), 0);
  const taxAmount = taxType === 'excluded' ? Math.round(subtotal * 0.05) : 0;
  const total     = subtotal + taxAmount;
  const quote = {
    id,
    company:       ['dippin', 'miji'].includes(body.company) ? body.company : 'dippin',
    staffName:     String(body.staffName || '').trim(),
    customerName:  String(body.customerName || '').trim(),
    customerNote:  String(body.customerNote || '').trim(),
    customerTaxId: String(body.customerTaxId || '').trim(),
    quoteDate:     String(body.quoteDate || now.slice(0, 10)),
    validUntil:    String(body.validUntil || ''),
    items:         body.items || [],
    note:          String(body.note || '').trim(),
    taxType,
    taxAmount,
    total,
    createdAt: now,
  };

  await c.env.CACHE.put(`quote:${id}`, JSON.stringify(quote));

  const listRaw = await c.env.CACHE.get('quote:list');
  const list = listRaw ? JSON.parse(listRaw) : [];
  list.unshift({ id, company: quote.company, staffName: quote.staffName, customerName: quote.customerName, quoteDate: quote.quoteDate, validUntil: quote.validUntil, total, createdAt: now });
  await c.env.CACHE.put('quote:list', JSON.stringify(list));

  return c.json({ ok: true, id });
});

// GET /api/quotes
app.get('/api/quotes', async (c) => {
  const token = c.req.header('X-Quote-Token');
  const role = validateQuoteToken(token, c.env);
  if (!role) return c.json({ error: '未授權' }, 401);

  const listRaw = await c.env.CACHE.get('quote:list');
  const list = listRaw ? JSON.parse(listRaw) : [];
  return c.json({ list, role });
});

// GET /api/quotes/:id
app.get('/api/quotes/:id', async (c) => {
  const token = c.req.header('X-Quote-Token');
  const role = validateQuoteToken(token, c.env);
  if (!role) return c.json({ error: '未授權' }, 401);

  const id = c.req.param('id');
  const raw = await c.env.CACHE.get(`quote:${id}`);
  if (!raw) return c.json({ error: '找不到報價單' }, 404);
  return c.body(raw, 200, { 'content-type': 'application/json' });
});

// DELETE /api/quotes/:id  (需要主管通行碼)
app.delete('/api/quotes/:id', async (c) => {
  const token = c.req.header('X-Quote-Token');
  const role = validateQuoteToken(token, c.env);
  if (role !== 'admin') return c.json({ error: '需要管理員權限' }, 403);

  const id = c.req.param('id');
  await c.env.CACHE.delete(`quote:${id}`);

  const listRaw = await c.env.CACHE.get('quote:list');
  if (listRaw) {
    const list = JSON.parse(listRaw).filter(q => q.id !== id);
    await c.env.CACHE.put('quote:list', JSON.stringify(list));
  }

  return c.json({ ok: true });
});

// ── 共用商品庫（產品建立）────────────────────────────────────────────────
// 沿用報價單的通行碼，不另設密碼。
// KV：product:<code> 存完整資料、product:list 存摘要清單。

// GET /api/products — 取得商品摘要清單
app.get('/api/products', async (c) => {
  const role = validateQuoteToken(c.req.header('X-Quote-Token'), c.env);
  if (!role) return c.json({ error: '未授權' }, 401);

  const raw = await c.env.CACHE.get('product:list');
  return c.json({ role, list: raw ? JSON.parse(raw) : [] });
});

// GET /api/products/:code — 取得單一商品完整資料
app.get('/api/products/:code', async (c) => {
  const role = validateQuoteToken(c.req.header('X-Quote-Token'), c.env);
  if (!role) return c.json({ error: '未授權' }, 401);

  const raw = await c.env.CACHE.get(`product:${c.req.param('code')}`);
  if (!raw) return c.json({ error: '找不到此商品' }, 404);
  return c.body(raw, 200, { 'content-type': 'application/json' });
});

// PUT /api/products/:code — 儲存商品
// body: { data, baseUpdatedAt, updatedBy, force }
// baseUpdatedAt 為此次編輯所根據的版本時間；與伺服器現況不符即視為衝突，回 409。
app.put('/api/products/:code', async (c) => {
  const role = validateQuoteToken(c.req.header('X-Quote-Token'), c.env);
  if (!role) return c.json({ error: '未授權' }, 401);

  const code = c.req.param('code');
  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: '無法解析 JSON' }, 400); }
  if (!body || typeof body.data !== 'object' || body.data === null) {
    return c.json({ error: '缺少 data' }, 400);
  }

  const existingRaw = await c.env.CACHE.get(`product:${code}`);
  const existing = existingRaw ? JSON.parse(existingRaw) : null;

  if (existing && !body.force && (body.baseUpdatedAt || '') !== (existing.updatedAt || '')) {
    return c.json({
      error: 'conflict',
      serverUpdatedAt: existing.updatedAt || '',
      serverUpdatedBy: existing.updatedBy || '',
      serverData: existing.data,
    }, 409);
  }

  const now = new Date().toISOString();
  const updatedBy = String(body.updatedBy || '').trim().slice(0, 40);
  const record = { code, data: body.data, updatedAt: now, updatedBy };
  await c.env.CACHE.put(`product:${code}`, JSON.stringify(record));

  const listRaw = await c.env.CACHE.get('product:list');
  const list = listRaw ? JSON.parse(listRaw) : [];
  const summary = {
    code,
    name:   String(body.data.name || ''),
    vendor: String(body.data.vendor || ''),
    updatedAt: now,
    updatedBy,
  };
  const at = list.findIndex(x => x.code === code);
  if (at >= 0) list[at] = summary; else list.unshift(summary);
  await c.env.CACHE.put('product:list', JSON.stringify(list));

  return c.json({ ok: true, updatedAt: now });
});

// DELETE /api/products/:code  (需要主管通行碼)
app.delete('/api/products/:code', async (c) => {
  const role = validateQuoteToken(c.req.header('X-Quote-Token'), c.env);
  if (role !== 'admin') return c.json({ error: '需要管理員權限' }, 403);

  const code = c.req.param('code');
  await c.env.CACHE.delete(`product:${code}`);

  const listRaw = await c.env.CACHE.get('product:list');
  if (listRaw) {
    const list = JSON.parse(listRaw).filter(x => x.code !== code);
    await c.env.CACHE.put('product:list', JSON.stringify(list));
  }
  return c.json({ ok: true });
});

// ── Fetch handler：外層 wrapper 確保 CORS 覆蓋所有 response ─────────────────
export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(origin);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const response = await app.fetch(request, env, ctx);

    const newHeaders = new Headers(response.headers);
    Object.entries(cors).forEach(([k, v]) => newHeaders.set(k, v));
    return new Response(response.body, { status: response.status, headers: newHeaders });
  },
};
