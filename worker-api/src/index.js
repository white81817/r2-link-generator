import { Hono } from 'hono';
import * as XLSX from 'xlsx';
import { zipSync } from 'fflate';

// ── CORS ──────────────────────────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://didibox.cc',
  'https://white81817.github.io',        // GitHub Pages
  'https://r2-link-generator.pages.dev', // Cloudflare Pages
  'https://ec.mallbic.com',
  'https://admin.1shop.tw',
  'https://scm.mamilove.com.tw',
  'https://detail.1688.com',              // 1688 SKU 抓取腳本
  'https://www.1688.com',
];

function corsHeaders(origin) {
  // 允許 file:// 本機測試（瀏覽器送 Origin: null 或不送 Origin）
  if (!origin || origin === 'null') {
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Quote-Token, X-Perf-Token',
      'Access-Control-Max-Age': '86400',
    };
  }
  if (!ALLOWED_ORIGINS.includes(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Quote-Token, X-Perf-Token',
    'Access-Control-Max-Age': '86400',
  };
}

const app = new Hono();

// ── Health ────────────────────────────────────────────────────────────────────
// version 用來確認自動部署是否生效：改版時一併更新，開 /api/health 即可比對
app.get('/api/health', (c) => c.json({
  status: 'ok',
  version: '2026-08-28-items-v1',
  features: ['erp', 'cache', 'quotes', 'products', '1688probe', '1688skudb', 'performance', '1688cartplan'],
  timestamp: new Date().toISOString(),
}));

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

// 產品建立（共用商品庫 / 1688 SKU 查詢）用的驗證：
// 除了報價單那兩組通行碼，四位 PM 的個人通行碼（PW_*）也可通行，權限視為一般使用者。
// 報價單本身仍只認 QUOTE_PASSWORD / QUOTE_ADMIN_PASSWORD，不受影響。
function validateProductToken(token, env) {
  const quoteRole = validateQuoteToken(token, env);
  if (quoteRole) return quoteRole;
  const perf = validatePerfToken(token, env);   // PW_PETER / PW_YUKI / PW_KAI / PW_PATTY
  if (perf) return perf.role === 'owner' ? 'admin' : 'user';
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
// 摘要清單要能用標籤篩選，就得把標籤一起存進去。
// tagsChecked 是勾選的固定標籤，tagsCustom 是自由輸入（以頓號／逗號／空白分隔）。
function productTags(data) {
  const checked = Array.isArray(data && data.tagsChecked) ? data.tagsChecked.map(String) : [];
  const custom = String((data && data.tagsCustom) || '')
    .split(/[、,，\s]+/).map(t => t.trim()).filter(Boolean);
  return [...new Set([...checked, ...custom])].slice(0, 30);
}

// 複合商品要靠「品項條碼 → 批價／重量」查成員，但摘要清單只有商品層級的欄位。
// 另外維護一份品項索引 product:items，寫入商品時一併更新（跟 product:list 同樣
// 只在每次請求結束前寫一次，避免對同一個 key 高頻寫入被 KV 節流）。
function productItemEntries(code, data) {
  const name = String((data && data.name) || '');
  return ((data && data.variants) || []).map((v, i) => ({
    barcode: String(v.barcode || '').trim(),
    code,
    name,
    style: String(v.style || ''),
    size: String(v.size || ''),
    wholesale: v.wholesale === '' || v.wholesale == null ? null : Number(v.wholesale),
    weight: v.weight === '' || v.weight == null ? null : Number(v.weight),
    idx: i + 1,
  }));
}

// items 以品項條碼為鍵；沒有條碼的品項改用「商品編號#序號」，
// 這樣至少商品編號那條比對路徑還在。
function mergeItems(map, code, data) {
  for (const k of Object.keys(map)) {
    if (map[k] && map[k].code === code) delete map[k];
  }
  productItemEntries(code, data).forEach(e => {
    map[e.barcode || `${code}#${e.idx}`] = e;
  });
}

// KV：product:<code> 存完整資料、product:list 存摘要清單。

// GET /api/products — 取得商品摘要清單
app.get('/api/products', async (c) => {
  const role = validateProductToken(c.req.header('X-Quote-Token'), c.env);
  if (!role) return c.json({ error: '未授權' }, 401);

  const raw = await c.env.CACHE.get('product:list');
  return c.json({ role, list: raw ? JSON.parse(raw) : [] });
});

// GET /api/products/items — 品項索引（品項條碼 → 商品編號／批價／重量），複合商品比對成員用
app.get('/api/products/items', async (c) => {
  if (!validateProductToken(c.req.header('X-Quote-Token'), c.env)) return c.json({ error: '未授權' }, 401);
  const raw = await c.env.CACHE.get('product:items');
  const items = raw ? JSON.parse(raw) : {};
  return c.json({ ok: true, count: Object.keys(items).length, items });
});

// GET /api/products/:code — 取得單一商品完整資料
app.get('/api/products/:code', async (c) => {
  const role = validateProductToken(c.req.header('X-Quote-Token'), c.env);
  if (!role) return c.json({ error: '未授權' }, 401);

  const raw = await c.env.CACHE.get(`product:${c.req.param('code')}`);
  if (!raw) return c.json({ error: '找不到此商品' }, 404);
  return c.body(raw, 200, { 'content-type': 'application/json' });
});

// PUT /api/products/:code — 儲存商品
// body: { data, baseUpdatedAt, updatedBy, force }
// baseUpdatedAt 為此次編輯所根據的版本時間；與伺服器現況不符即視為衝突，回 409。
app.put('/api/products/:code', async (c) => {
  const role = validateProductToken(c.req.header('X-Quote-Token'), c.env);
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
    tags:   productTags(body.data),
    updatedAt: now,
    updatedBy,
  };
  const at = list.findIndex(x => x.code === code);
  if (at >= 0) list[at] = summary; else list.unshift(summary);
  await c.env.CACHE.put('product:list', JSON.stringify(list));

  const itemsRaw = await c.env.CACHE.get('product:items');
  const items = itemsRaw ? JSON.parse(itemsRaw) : {};
  mergeItems(items, code, body.data);
  await c.env.CACHE.put('product:items', JSON.stringify(items));

  return c.json({ ok: true, updatedAt: now });
});

// PUT /api/products — 批次儲存（上傳本機資料用）
// 逐筆打 /api/products/:code 有兩個問題：一是 N 趟往返很慢，
// 二是每筆都重寫 product:list —— KV 對「同一個 key」有寫入頻率限制，
// 連續快寫會被節流，而且讀到舊清單時會把前面剛寫進去的洗掉。
// 這裡把 product:<code> 平行寫（不同 key 沒有這個限制），product:list 最後只寫一次。
const BULK_MAX = 100;
app.put('/api/products', async (c) => {
  const role = validateProductToken(c.req.header('X-Quote-Token'), c.env);
  if (!role) return c.json({ error: '未授權' }, 401);

  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: '無法解析 JSON' }, 400); }

  const items = Array.isArray(body && body.items) ? body.items : null;
  if (!items || !items.length) return c.json({ error: '缺少 items' }, 400);
  if (items.length > BULK_MAX) return c.json({ error: `一次最多 ${BULK_MAX} 筆，收到 ${items.length}` }, 400);

  const updatedBy = String(body.updatedBy || '').trim().slice(0, 40);
  const force = !!body.force;
  // skipExisting：共用庫已經有這個商品編號就整筆跳過，不覆蓋別人的資料
  const skipExisting = !!body.skipExisting;
  const now = new Date().toISOString();

  const saved = [];
  const items2 = [];
  const skipped = [];
  const conflicts = [];
  const invalid = [];
  const summaries = [];

  // 併發拉高會讓 KV 開始丟錯，20 是實務上穩定的數字
  const CHUNK = 20;
  for (let i = 0; i < items.length; i += CHUNK) {
    await Promise.all(items.slice(i, i + CHUNK).map(async (item) => {
      const code = String((item && item.code) || '').trim();
      if (!code || !item.data || typeof item.data !== 'object') { invalid.push(code || '(無編號)'); return; }

      if (skipExisting || !force) {
        const existingRaw = await c.env.CACHE.get(`product:${code}`);
        const existing = existingRaw ? JSON.parse(existingRaw) : null;
        if (existing && skipExisting) { skipped.push(code); return; }
        if (existing && !force && (item.baseUpdatedAt || '') !== (existing.updatedAt || '')) {
          conflicts.push(code);
          return;
        }
      }

      await c.env.CACHE.put(`product:${code}`, JSON.stringify({ code, data: item.data, updatedAt: now, updatedBy }));
      saved.push(code);
      items2.push({ code, data: item.data });
      summaries.push({
        code,
        name:   String(item.data.name || ''),
        vendor: String(item.data.vendor || ''),
        tags:   productTags(item.data),
        updatedAt: now,
        updatedBy,
      });
    }));
  }

  if (summaries.length) {
    const listRaw = await c.env.CACHE.get('product:list');
    const list = listRaw ? JSON.parse(listRaw) : [];
    summaries.forEach((sm) => {
      const at = list.findIndex(x => x.code === sm.code);
      if (at >= 0) list[at] = sm; else list.unshift(sm);
    });
    await c.env.CACHE.put('product:list', JSON.stringify(list));

    const itemsRaw = await c.env.CACHE.get('product:items');
    const items = itemsRaw ? JSON.parse(itemsRaw) : {};
    items2.forEach(({ code, data }) => mergeItems(items, code, data));
    await c.env.CACHE.put('product:items', JSON.stringify(items));
  }

  return c.json({ ok: true, saved, skipped, conflicts, invalid, updatedAt: now });
});

// POST /api/products/rebuild-list — 依現有的 product:<code> 重建摘要清單
// 摘要多了 tags 欄位，舊資料的清單沒有；重存一次太麻煩，用這支一次補齊。
app.post('/api/products/rebuild-list', async (c) => {
  const role = validateProductToken(c.req.header('X-Quote-Token'), c.env);
  if (!role) return c.json({ error: '未授權' }, 401);

  const listRaw = await c.env.CACHE.get('product:list');
  const list = listRaw ? JSON.parse(listRaw) : [];
  const rebuilt = [];
  const missing = [];

  const CHUNK = 20;
  for (let i = 0; i < list.length; i += CHUNK) {
    const part = await Promise.all(list.slice(i, i + CHUNK).map(async (it) => {
      const raw = await c.env.CACHE.get(`product:${it.code}`);
      // 讀不到完整資料就保留原摘要、標籤給空陣列——直接從清單移除等於偷偷刪資料
      if (!raw) { missing.push(it.code); return { ...it, tags: Array.isArray(it.tags) ? it.tags : [] }; }
      const rec = JSON.parse(raw);
      return {
        code: it.code,
        name:   String((rec.data && rec.data.name) || it.name || ''),
        vendor: String((rec.data && rec.data.vendor) || it.vendor || ''),
        tags:   productTags(rec.data),
        updatedAt: rec.updatedAt || it.updatedAt || '',
        updatedBy: rec.updatedBy || it.updatedBy || '',
      };
    }));
    rebuilt.push(...part.filter(Boolean));
  }

  await c.env.CACHE.put('product:list', JSON.stringify(rebuilt));

  // 品項索引也一起重建：複合商品比對成員靠它，舊資料寫入時還沒有這個索引
  const items = {};
  for (let i = 0; i < list.length; i += CHUNK) {
    await Promise.all(list.slice(i, i + CHUNK).map(async (it) => {
      const raw = await c.env.CACHE.get(`product:${it.code}`);
      if (!raw) return;
      const rec = JSON.parse(raw);
      mergeItems(items, it.code, rec.data);
    }));
  }
  await c.env.CACHE.put('product:items', JSON.stringify(items));

  return c.json({ ok: true, count: rebuilt.length, items: Object.keys(items).length, missing });
});

// ===== 商品編號流水號 =====
//   SH 0S 0001 00 ── 倉庫(2) + 材積(2) + 四位流水號 + 兩位規格流水號
// 號碼用到哪，權威來源是 USALE 匯出的全商品清單（很多商品只存在 ERP，
// 共用庫看不到），所以先用 /api/codes/baseline 灌進來當底，
// 之後 /api/codes/next 每發一號就往上加，並比對共用庫避免撞號。
const CODE_RE = /^(SH|CF)([01]S)(\d{4})/;

app.get('/api/codes', async (c) => {
  if (!validateProductToken(c.req.header('X-Quote-Token'), c.env)) return c.json({ error: '未授權' }, 401);
  const raw = await c.env.CACHE.get('codeseq:all');
  return c.json({ ok: true, seq: raw ? JSON.parse(raw) : {} });
});

// POST /api/codes/baseline — body: { codes: ["SH0S000100", ...] }
// 只取每個「倉庫+材積」用到的最大流水號，取代不了就不動（只會往上調）
app.post('/api/codes/baseline', async (c) => {
  if (!validateProductToken(c.req.header('X-Quote-Token'), c.env)) return c.json({ error: '未授權' }, 401);
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: '無法解析 JSON' }, 400); }
  const codes = Array.isArray(body && body.codes) ? body.codes : null;
  if (!codes) return c.json({ error: '缺少 codes' }, 400);

  const raw = await c.env.CACHE.get('codeseq:all');
  const seq = raw ? JSON.parse(raw) : {};
  let matched = 0;
  const unmatched = [];
  for (const c0 of codes) {
    const m = CODE_RE.exec(String(c0 || '').trim().toUpperCase());
    if (!m) { if (unmatched.length < 50) unmatched.push(String(c0)); continue; }
    matched++;
    const prefix = m[1] + m[2];
    const n = parseInt(m[3], 10);
    if (!(prefix in seq) || n > seq[prefix]) seq[prefix] = n;
  }
  await c.env.CACHE.put('codeseq:all', JSON.stringify(seq));
  return c.json({ ok: true, seq, matched, unmatchedCount: codes.length - matched, unmatched });
});

// POST /api/codes/next — body: { warehouse: "SH", size: "0S", count: 1 }
app.post('/api/codes/next', async (c) => {
  if (!validateProductToken(c.req.header('X-Quote-Token'), c.env)) return c.json({ error: '未授權' }, 401);
  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: '無法解析 JSON' }, 400); }
  const warehouse = String((body && body.warehouse) || '').toUpperCase();
  const size = String((body && body.size) || '').toUpperCase();
  if (!['SH', 'CF'].includes(warehouse)) return c.json({ error: '倉庫只能是 SH 或 CF' }, 400);
  if (!['0S', '1S'].includes(size)) return c.json({ error: '材積只能是 0S 或 1S' }, 400);
  const count = Math.min(Math.max(parseInt((body && body.count) || 1, 10) || 1, 1), 50);

  const prefix = warehouse + size;
  const raw = await c.env.CACHE.get('codeseq:all');
  const seq = raw ? JSON.parse(raw) : {};

  // 共用庫裡已經有的編號也算數，免得基準沒灌到就重複發號
  const listRaw = await c.env.CACHE.get('product:list');
  const list = listRaw ? JSON.parse(listRaw) : [];
  const used = new Set();
  let maxInList = 0;
  for (const it of list) {
    const m = CODE_RE.exec(String(it.code || '').toUpperCase());
    if (!m || m[1] + m[2] !== prefix) continue;
    used.add(parseInt(m[3], 10));
    maxInList = Math.max(maxInList, parseInt(m[3], 10));
  }

  let n = Math.max(seq[prefix] || 0, maxInList);
  const codes = [];
  while (codes.length < count) {
    n++;
    if (n > 9999) return c.json({ error: `${prefix} 的四位流水號已用到 9999，無法再發號` }, 409);
    if (used.has(n)) continue;
    codes.push(prefix + String(n).padStart(4, '0') + '00');
  }

  seq[prefix] = n;
  await c.env.CACHE.put('codeseq:all', JSON.stringify(seq));
  return c.json({ ok: true, codes, prefix, next: n });
});

// DELETE /api/products/:code  (一般通行碼即可刪除)
app.delete('/api/products/:code', async (c) => {
  const role = validateProductToken(c.req.header('X-Quote-Token'), c.env);
  if (!role) return c.json({ error: '未授權' }, 401);

  const code = c.req.param('code');
  await c.env.CACHE.delete(`product:${code}`);

  const listRaw = await c.env.CACHE.get('product:list');
  if (listRaw) {
    const list = JSON.parse(listRaw).filter(x => x.code !== code);
    await c.env.CACHE.put('product:list', JSON.stringify(list));
    const itemsRaw = await c.env.CACHE.get('product:items');
    if (itemsRaw) {
      const items = JSON.parse(itemsRaw);
      for (const k of Object.keys(items)) if (items[k] && items[k].code === code) delete items[k];
      await c.env.CACHE.put('product:items', JSON.stringify(items));
    }
  }
  return c.json({ ok: true });
});

// ── 1688 商品資料探測 ───────────────────────────────────────────────────────
// 用途：確認 Cloudflare 伺服器端能否讀到 1688 商品頁，並嘗試解析 SKU。
// 1688 有反爬機制，抓不到屬預期結果之一，回傳診斷資訊供判斷該走哪條路。
app.get('/api/1688/offer', async (c) => {
  const role = validateProductToken(c.req.header('X-Quote-Token'), c.env);
  if (!role) return c.json({ error: '未授權' }, 401);

  const id = (c.req.query('id') || '').trim();
  if (!/^\d+$/.test(id)) return c.json({ error: 'id 需為數字的 1688 offer id' }, 400);

  const url = `https://detail.1688.com/offer/${id}.html`;
  let res, html = '';
  try {
    res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
      },
      redirect: 'follow',
    });
    html = await res.text();
  } catch (e) {
    return c.json({ ok: false, stage: 'fetch', error: e.message, url }, 502);
  }

  // 判斷是否被導去登入或風控頁
  const blocked =
    /login\.1688\.com|passport|滑动验证|安全验证|验证码|请输入验证码/i.test(html) ||
    /sec\.1688\.com|punish/i.test(res.url || '');

  // 1688 會把商品資料以 JSON 內嵌於 script，嘗試幾種常見鍵名
  const skus = [];
  let title = '';
  const t = html.match(/<title>([^<]*)<\/title>/i);
  if (t) title = t[1].trim();

  // skuInfoMap / skuProps 是常見的規格結構
  const grab = (re) => { const m = html.match(re); return m ? m[1] : null; };
  const skuInfoRaw = grab(/"skuInfoMap"\s*:\s*(\{.*?\})\s*,\s*"/s);
  const skuPropsRaw = grab(/"skuProps"\s*:\s*(\[.*?\])\s*,\s*"/s);

  if (skuInfoRaw) {
    try {
      const map = JSON.parse(skuInfoRaw);
      for (const [specText, v] of Object.entries(map)) {
        skus.push({
          specText,
          skuId: String(v.skuId || v.specId || ''),
          price: v.price ?? v.discountPrice ?? null,
          stock: v.canBookCount ?? v.saleCount ?? null,
        });
      }
    } catch (e) { /* 解析失敗時保留診斷資訊即可 */ }
  }

  return c.json({
    ok: !blocked && skus.length > 0,
    url,
    finalUrl: res.url || url,
    httpStatus: res.status,
    htmlLength: html.length,
    title,
    blocked,
    hasSkuInfoMap: !!skuInfoRaw,
    hasSkuProps: !!skuPropsRaw,
    skuCount: skus.length,
    skus: skus.slice(0, 50),
    // 抓不到時附上片段，用來判斷 1688 回了什麼
    sample: (skus.length || blocked) ? undefined : html.slice(0, 400),
  });
});

// ── 1688 SKU 資料庫 ────────────────────────────────────────────────────────
// 由瀏覽器端的使用者腳本在 1688 頁面抓取後上傳（帶登入 cookie，成功率最高）。
// KV 以單一鍵存放 offerId → SKU 清單的對照表。
const SKU1688_KEY = 'sku1688:all';
// 料號欄位有 87 筆記的是 lihi2 短網址，前端無法自行展開，
// 因此另存一份 短網址 → offerId 的對照表。
const SKU1688_SHORT_KEY = 'sku1688:shortlinks';

async function readSku1688(env) {
  const raw = await env.CACHE.get(SKU1688_KEY);
  return raw ? JSON.parse(raw) : {};
}

async function readSku1688Short(env) {
  const raw = await env.CACHE.get(SKU1688_SHORT_KEY);
  return raw ? JSON.parse(raw) : {};
}

// GET /api/1688/skus            取得全部
// GET /api/1688/skus?id=123456  取得單一 offer
app.get('/api/1688/skus', async (c) => {
  const role = validateProductToken(c.req.header('X-Quote-Token'), c.env);
  if (!role) return c.json({ error: '未授權' }, 401);

  const all = await readSku1688(c.env);
  const id = (c.req.query('id') || '').trim();
  if (id) {
    return all[id] ? c.json(all[id]) : c.json({ error: '尚未收錄此 offer' }, 404);
  }
  const shortLinks = await readSku1688Short(c.env);
  return c.json({
    count: Object.keys(all).length,
    offers: all,
    shortLinks,
  });
});

// POST /api/1688/skus  body: { offers: { "<offerId>": {title,url,skus:[...],fetchedAt} } }
// 以 offerId 為單位覆蓋更新，未包含的 offer 保持不變。
app.post('/api/1688/skus', async (c) => {
  const role = validateQuoteToken(c.req.header('X-Quote-Token'), c.env);
  if (!role) return c.json({ error: '未授權' }, 401);

  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: '無法解析 JSON' }, 400); }
  const incoming = body && body.offers;
  if (!incoming || typeof incoming !== 'object') return c.json({ error: '缺少 offers' }, 400);

  const all = await readSku1688(c.env);
  const now = new Date().toISOString();
  const saved = [];
  for (const [offerId, data] of Object.entries(incoming)) {
    if (!/^\d+$/.test(offerId) || !data || !Array.isArray(data.skus)) continue;
    all[offerId] = {
      offerId,
      title: String(data.title || '').slice(0, 200),
      url:   String(data.url || ''),
      // specId 與 unitPrice 是下單階段要用的：specId 進採購車，
      // unitPrice 已統一為「買 1 件的單價」（階梯價商品取自 skuRangePrices）。
      skus:  data.skus.slice(0, 500).map(s => ({
        skuId:        String(s.skuId || ''),
        specId:       String(s.specId || ''),
        specText:     String(s.specText || '').slice(0, 200),
        price:        s.price ?? null,
        unitPrice:    s.unitPrice ?? s.price ?? null,
        priceSource:  s.priceSource || (s.price ? 'sku' : 'none'),
        canBookCount: s.canBookCount ?? null,
        stock:        s.stock ?? s.canBookCount ?? null,
      })),
      beginNum:   data.beginNum ?? null,
      priceScale: data.priceScale ?? null,
      fetchedAt: data.fetchedAt || now,
      uploadedBy: String(body.uploadedBy || '').slice(0, 40),
    };
    saved.push(offerId);
  }

  // 短網址對照表：{ "https://lihi2.com/xxxxx": "<offerId>" }，累加更新
  let shortSaved = 0;
  if (body.shortLinks && typeof body.shortLinks === 'object') {
    const shortAll = await readSku1688Short(c.env);
    for (const [url, offerId] of Object.entries(body.shortLinks)) {
      if (!/^https?:\/\//.test(url) || !/^\d+$/.test(String(offerId))) continue;
      shortAll[url] = String(offerId);
      shortSaved++;
    }
    if (shortSaved) await c.env.CACHE.put(SKU1688_SHORT_KEY, JSON.stringify(shortAll));
  }

  if (!saved.length && !shortSaved) return c.json({ error: '沒有有效的 offer 資料' }, 400);

  if (saved.length) await c.env.CACHE.put(SKU1688_KEY, JSON.stringify(all));
  return c.json({ ok: true, saved: saved.length, shortSaved, offerIds: saved, total: Object.keys(all).length });
});

// ── 1688 採購計畫 ──────────────────────────────────────────────────────────
// didibox 上傳採購單、對照出 skuId 之後把計畫放這裡；
// 使用者在 1688 頁面上的 Tampermonkey 腳本再讀走並呼叫 addCargo。
// 之所以要繞這一圈：didibox.cc 是跨網域，拿不到 1688 的登入 cookie，
// 最後那一步只能在 1688 自己的頁面上執行（CORS 白名單已含 detail.1688.com）。
const CART_PLAN_KEY = 'sku1688:cartplan';

// GET /api/1688/cart-plan   取出目前的採購計畫
app.get('/api/1688/cart-plan', async (c) => {
  const role = validateQuoteToken(c.req.header('X-Quote-Token'), c.env);
  if (!role) return c.json({ error: '未授權' }, 401);
  const raw = await c.env.CACHE.get(CART_PLAN_KEY);
  return c.json(raw ? JSON.parse(raw) : { items: [], empty: true });
});

// POST /api/1688/cart-plan  body: { items:[{offerId,specId,quantity,label}], createdBy }
app.post('/api/1688/cart-plan', async (c) => {
  const role = validateQuoteToken(c.req.header('X-Quote-Token'), c.env);
  if (!role) return c.json({ error: '未授權' }, 401);

  let body;
  try { body = await c.req.json(); } catch { return c.json({ error: '無法解析 JSON' }, 400); }
  const items = Array.isArray(body.items) ? body.items : null;
  if (!items || !items.length) return c.json({ error: '缺少 items' }, 400);

  const clean = items
    .filter((x) => /^\d+$/.test(String(x.offerId)) && x.specId && Number(x.quantity) > 0)
    .slice(0, 200)
    .map((x) => ({
      offerId:  String(x.offerId),
      specId:   String(x.specId),
      quantity: Math.max(1, Math.floor(Number(x.quantity))),
      label:    String(x.label || '').slice(0, 120),
    }));
  if (!clean.length) return c.json({ error: '沒有有效的項目' }, 400);

  const plan = {
    items: clean,
    createdAt: new Date().toISOString(),
    createdBy: String(body.createdBy || '').slice(0, 40),
    consumedAt: null,
  };
  await c.env.CACHE.put(CART_PLAN_KEY, JSON.stringify(plan));
  return c.json({ ok: true, count: clean.length });
});

// PUT /api/1688/cart-plan   標記已加入（腳本執行完回報，避免重複加入）
app.put('/api/1688/cart-plan', async (c) => {
  const role = validateQuoteToken(c.req.header('X-Quote-Token'), c.env);
  if (!role) return c.json({ error: '未授權' }, 401);
  const raw = await c.env.CACHE.get(CART_PLAN_KEY);
  if (!raw) return c.json({ error: '沒有採購計畫' }, 404);
  const plan = JSON.parse(raw);
  const body = await c.req.json().catch(() => ({}));
  plan.consumedAt = new Date().toISOString();
  plan.result = String(body.result || '').slice(0, 500);
  await c.env.CACHE.put(CART_PLAN_KEY, JSON.stringify(plan));
  return c.json({ ok: true });
});

// DELETE /api/1688/skus?id=123456   移除單一 offer（重抓前清資料用）
app.delete('/api/1688/skus', async (c) => {
  const role = validateQuoteToken(c.req.header('X-Quote-Token'), c.env);
  if (!role) return c.json({ error: '未授權' }, 401);
  const id = (c.req.query('id') || '').trim();
  if (!id) return c.json({ error: '需要 id' }, 400);

  const all = await readSku1688(c.env);
  if (!all[id]) return c.json({ error: '找不到此 offer' }, 404);
  delete all[id];
  await c.env.CACHE.put(SKU1688_KEY, JSON.stringify(all));
  return c.json({ ok: true, total: Object.keys(all).length });
});

// ── 績效儀表板 ────────────────────────────────────────────────────────────────
// 資料為機密（各 PM 業績/毛利/庫存），一律需通行碼，且 PM 只看得到自己的。
// Cloudflare secrets：
//   QUOTE_ADMIN_PASSWORD → 老闆：看全部 + 唯一可寫入（沿用既有那組）
//   PW_PETER             → 主管(Peter)：看全部，不可寫入
//   PW_YUKI / PW_KAI / PW_PATTY → 各 PM：只看得到自己
const PERF_KEY = 'perf:data';
const PERF_PMS = ['Peter', 'Yuki', 'Kai', 'Patty'];

// 回傳 { role:'owner' } / { role:'admin', pm } / { role:'pm', pm } / null
// owner 與 admin 都看全部；只有 owner 能寫入。
function validatePerfToken(token, env) {
  if (!token) return null;
  if (env.QUOTE_ADMIN_PASSWORD && token === env.QUOTE_ADMIN_PASSWORD) return { role: 'owner' };
  if (env.PW_PETER && token === env.PW_PETER) return { role: 'admin', pm: 'Peter' };
  for (const pm of ['Yuki', 'Kai', 'Patty']) {
    const pw = env['PW_' + pm.toUpperCase()];
    if (pw && token === pw) return { role: 'pm', pm };
  }
  return null;
}

const perfCanSeeAll = auth => auth.role === 'owner' || auth.role === 'admin';

async function readPerf(env) {
  const raw = await env.CACHE.get(PERF_KEY);
  if (!raw) return { months: {} };
  try { const v = JSON.parse(raw); return v && v.months ? v : { months: {} }; }
  catch { return { months: {} }; }
}

// POST /api/performance/auth  body: { password }
app.post('/api/performance/auth', async (c) => {
  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: '無法解析 JSON' }, 400); }
  const auth = validatePerfToken(body.password, c.env);
  if (!auth) return c.json({ error: '通行碼錯誤' }, 401);
  return c.json(auth);
});

// GET /api/performance  → 依角色回傳：admin 全部、pm 只有自己
app.get('/api/performance', async (c) => {
  const auth = validatePerfToken(c.req.header('X-Perf-Token'), c.env);
  if (!auth) return c.json({ error: '未授權' }, 401);

  const all = await readPerf(c.env);
  if (perfCanSeeAll(auth)) return c.json({ ...auth, ...all });

  // PM：只保留自己的欄位
  const months = {};
  for (const [m, rows] of Object.entries(all.months)) {
    if (rows && rows[auth.pm]) months[m] = { [auth.pm]: rows[auth.pm] };
  }
  return c.json({ ...auth, generated: all.generated, age_th: all.age_th, months });
});

// POST /api/performance  body: { generated?, age_th?, months:{ '2026-07': { Peter:{...}, ... } } }
// 以月份為單位合併：同月覆蓋、新月追加（保留歷史）。僅老闆通行碼可寫入。
app.post('/api/performance', async (c) => {
  const auth = validatePerfToken(c.req.header('X-Perf-Token'), c.env);
  if (!auth || auth.role !== 'owner') return c.json({ error: '未授權（需老闆通行碼）' }, 401);

  let body;
  try { body = await c.req.json(); }
  catch { return c.json({ error: '無法解析 JSON' }, 400); }
  const incoming = body && body.months;
  if (!incoming || typeof incoming !== 'object') return c.json({ error: '缺少 months' }, 400);

  const all = await readPerf(c.env);
  const saved = [];
  for (const [month, rows] of Object.entries(incoming)) {
    if (!/^\d{4}-\d{2}$/.test(month) || !rows || typeof rows !== 'object') continue;
    all.months[month] = rows;
    saved.push(month);
  }
  all.generated = String(body.generated || new Date().toISOString().slice(0, 16).replace('T', ' '));
  if (body.age_th) all.age_th = Number(body.age_th) || 60;
  await c.env.CACHE.put(PERF_KEY, JSON.stringify(all));
  return c.json({ ok: true, saved, total: Object.keys(all.months).length });
});

// DELETE /api/performance?month=2026-07  → 刪掉某月（僅老闆）
app.delete('/api/performance', async (c) => {
  const auth = validatePerfToken(c.req.header('X-Perf-Token'), c.env);
  if (!auth || auth.role !== 'owner') return c.json({ error: '未授權（需老闆通行碼）' }, 401);
  const month = c.req.query('month');
  if (!month) return c.json({ error: '缺少 month' }, 400);
  const all = await readPerf(c.env);
  if (!all.months[month]) return c.json({ error: '找不到該月份' }, 404);
  delete all.months[month];
  await c.env.CACHE.put(PERF_KEY, JSON.stringify(all));
  return c.json({ ok: true, total: Object.keys(all.months).length });
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
