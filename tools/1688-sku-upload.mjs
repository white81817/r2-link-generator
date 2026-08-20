#!/usr/bin/env node
/**
 * 把 1688-sku-fetch.mjs 抓到的 NDJSON 上傳到 didibox-api 的 KV，
 * 供「產品建立」分頁做料號 → skuId 比對。
 *
 * 通行碼請用環境變數帶入，不要寫進檔案或指令歷史：
 *   read -s QUOTE_TOKEN && export QUOTE_TOKEN
 *   node tools/1688-sku-upload.mjs
 *
 * 選項：
 *   --file <path>   SKU NDJSON，預設 tools/out/1688-sku.ndjson
 *   --short <path>  短網址 NDJSON，預設 tools/out/1688-sku-short.ndjson
 *   --api <url>     API 位址，預設 https://didibox-api.adam-061.workers.dev
 *   --by <name>     上傳者名稱，記在資料裡
 *   --dry           只顯示會送出什麼，不實際上傳
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes(n);

const API   = flag('--api', 'https://didibox-api.adam-061.workers.dev');
const FILE  = path.resolve(flag('--file', path.join(HERE, 'out', '1688-sku.ndjson')));
const SHORT = path.resolve(flag('--short', path.join(HERE, 'out', '1688-sku-short.ndjson')));
const BY    = flag('--by', '');
const TOKEN = process.env.QUOTE_TOKEN || '';

if (!has('--dry') && !TOKEN) {
  console.error('缺少通行碼。請先執行：read -s QUOTE_TOKEN && export QUOTE_TOKEN');
  process.exit(1);
}

const readNdjson = (f) => (fs.existsSync(f)
  ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : []);

const records = readNdjson(FILE);
if (!records.length) { console.error(`讀不到資料：${FILE}`); process.exit(1); }

const offers = {};
for (const r of records) {
  offers[r.offerId] = {
    title: r.title,
    url:   r.url,
    beginNum:   r.beginNum ?? null,
    priceScale: r.priceScale ?? null,
    fetchedAt:  r.fetchedAt,
    skus: r.skus.map((s) => ({
      skuId:        s.skuId,
      specId:       s.specId,
      specText:     s.specText,
      price:        s.price,
      unitPrice:    s.unitPrice,
      priceSource:  s.priceSource,
      canBookCount: s.canBookCount,
    })),
  };
}

const shortLinks = {};
for (const s of readNdjson(SHORT)) {
  if (s.offerId) shortLinks[s.short] = String(s.offerId);
}

const payload = { offers, shortLinks, uploadedBy: BY };
const skuCount = Object.values(offers).reduce((a, o) => a + o.skus.length, 0);
console.log(`準備上傳：${Object.keys(offers).length} 個 offer、${skuCount} 個 SKU、${Object.keys(shortLinks).length} 筆短網址對照`);
console.log(`大小約 ${(JSON.stringify(payload).length / 1024).toFixed(1)} KB → ${API}/api/1688/skus`);

if (has('--dry')) {
  const [id, one] = Object.entries(offers)[0];
  console.log('\n--dry：範例一筆\n', JSON.stringify({ [id]: { ...one, skus: one.skus.slice(0, 2) } }, null, 2));
  process.exit(0);
}

const res = await fetch(`${API}/api/1688/skus`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Quote-Token': TOKEN },
  body: JSON.stringify(payload),
});
const data = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`上傳失敗（${res.status}）：${data.error || JSON.stringify(data)}`);
  process.exit(1);
}
console.log(`✓ 上傳成功：offer ${data.saved} 筆、短網址 ${data.shortSaved} 筆，KV 現有 ${data.total} 個 offer`);
