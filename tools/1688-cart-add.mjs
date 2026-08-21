#!/usr/bin/env node
/**
 * 採購單（Excel/CSV）→ 1688 進貨車。
 *
 * 資料鏈路：
 *   採購單的「商品編號＋樣式＋尺寸＋數量」
 *     → 共用商品庫查出該規格的廠商料號
 *     → 料號的規格文字比對 1688 SKU 庫，得到 offerId + specId
 *     → 呼叫 MtopPurchaseService.addCargo 加入進貨車
 *
 * addCargo 的 goodsParams 是陣列，整張單一次請求就能加完。簽章交給頁面自己的
 * window.lib.mtop.request 處理，不必自行實作 mtop sign。
 *
 * **實際送出訂單與付款一律人工**：本工具只把東西放進進貨車。
 *
 * 用法：
 *   read -s QUOTE_TOKEN && export QUOTE_TOKEN
 *   node tools/1688-cart-add.mjs --file 採購單.xlsx           # 預設只試算，不動購物車
 *   node tools/1688-cart-add.mjs --file 採購單.xlsx --add     # 確認後真的加入
 *
 * 採購單欄位（有表頭，名稱可用中文或英文）：
 *   商品編號 code ／ 樣式 style ／ 尺寸 size ／ 數量 qty
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as XLSX from 'xlsx';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes(n);

const API   = flag('--api', 'https://didibox-api.adam-061.workers.dev');
const FILE  = flag('--file', '');
const DO_ADD = has('--add');
const TOKEN = process.env.QUOTE_TOKEN || '';
const PROFILE = path.join(HERE, '.chrome-1688');

const SUGGEST = has('--suggest');
if (!FILE && !SUGGEST) { console.error('需要 --file <採購單.xlsx 或 .csv>，或用 --suggest 列出可測試的品項'); process.exit(1); }
if (!TOKEN) { console.error('缺少通行碼。請先執行：read -s QUOTE_TOKEN && export QUOTE_TOKEN'); process.exit(1); }

// ── 讀採購單 ────────────────────────────────────────────────────────────────
const pick = (row, names) => {
  for (const n of names) {
    for (const k of Object.keys(row)) {
      if (String(k).trim().toLowerCase() === n.toLowerCase()) return row[k];
    }
  }
  return undefined;
};

// ESM 版的 xlsx 沒有綁 fs，XLSX.readFile 不存在，要自己讀檔再 parse。
// CSV 若丟 buffer 進去會被當成 latin1，中文表頭會變亂碼，所以要先用 UTF-8 讀成字串。
function readWorkbook(file) {
  const buf = fs.readFileSync(file);
  if (/\.(csv|txt)$/i.test(file)) {
    return XLSX.read(buf.toString('utf8').replace(/^\uFEFF/, ''), { type: 'string' });
  }
  return XLSX.read(buf, { type: 'buffer' });
}
const wb = SUGGEST ? null : readWorkbook(path.resolve(FILE));
const rawRows = wb ? XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' }) : [];
const orders = rawRows.map((r, i) => ({
  line:  i + 2,
  code:  String(pick(r, ['商品編號', '商品编号', 'code']) ?? '').trim(),
  style: String(pick(r, ['樣式', '样式', 'style']) ?? '').trim(),
  size:  String(pick(r, ['尺寸', 'size']) ?? '').trim(),
  // 料號可直接寫在採購單裡，這樣不必先把商品放進共用商品庫
  vendorCode: String(pick(r, ['廠商料號', '料號', 'vendorCode']) ?? '').trim(),
  qty:   Number(pick(r, ['數量', '数量', 'qty', 'quantity']) ?? 0),
})).filter((o) => (o.code || o.vendorCode) && o.qty > 0);

if (!SUGGEST && !orders.length) { console.error('採購單裡沒有有效資料（需要 商品編號 與 數量）'); process.exit(1); }
if (!SUGGEST) console.log(`採購單讀入 ${orders.length} 列`);

// ── 取共用商品庫與 1688 SKU 庫 ──────────────────────────────────────────────
const api = async (p) => {
  const res = await fetch(API + p, { headers: { 'X-Quote-Token': TOKEN } });
  if (!res.ok) throw new Error(`${p} → ${res.status}`);
  return res.json();
};

const skuDb = await api('/api/1688/skus');
console.log(`1688 SKU 庫：${skuDb.count} 個 offer、${Object.keys(skuDb.shortLinks || {}).length} 筆短網址`);

const productCache = new Map();
async function getProduct(code) {
  if (!productCache.has(code)) {
    productCache.set(code, await api(`/api/products/${encodeURIComponent(code)}`).catch(() => null));
  }
  return productCache.get(code);
}

// ── 比對規則（與前端 index.html 同一套，改動時兩邊要一起改）────────────────
const norm = (t) => String(t || '')
  .replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
  .replace(/[（）]/g, (m) => (m === '（' ? '(' : ')'))
  .replace(/\s+/g, '').toLowerCase();
const firstAxis = (t) => norm(t).split('>')[0];
const axes = (t) => norm(t).split('>').filter(Boolean);
const showSpec = (t) => String(t || '').replace(/&gt;/g, ' > ').replace(/&amp;/g, '&');

function parseVendorCode(raw, shortLinks) {
  const text = String(raw || '').replace(/<br\s*\/?>/gi, '\n');
  const url = (text.match(/https?:\/\/[^\s"'<>]+/) || [''])[0];
  const specText = text.replace(url, '').replace(/\n/g, ' ').trim();
  const direct = url.match(/\/offer\/(\d+)\.html/) || url.match(/[?&]offerId=(\d+)/);
  const offerId = direct ? direct[1]
    : (url && shortLinks ? (shortLinks[url] || shortLinks[url.split('?')[0]] || '') : '');
  return { specText, url, offerId, nonAli: /taobao\.com|tmall\.com/.test(url) };
}

const T2S = (() => {
  const pairs = '銀银紅红藍蓝綠绿黑黑灰灰紫紫橙橙粉粉棕棕咖咖金金鋼钢鐵铁鋁铝銅铜膠胶纖纤維维棉棉麻麻皮皮龍龙長长寬宽高高厚厚徑径號号碼码粗粗細细輕轻重重裝装組组套套雙双單单個个隻只條条張张塊块包包袋袋盒盒箱箱款款型型色色版版帶带無无有有送送贈赠配配備备全全半半折折疊叠收收納纳儲储掛挂支支架架桿杆頭头腳脚邊边面面底底蓋盖門门窗窗車车電电動动機机器器線线燈灯風风冷冷熱热溫温濕湿乾干淨净洗洗護护養养專专業业用用戶户外外內内國国產产進进質质量量優优級级標标準准適适合合兒儿童童男男女女親亲側侧後后前前左左右右上上下下大大中中小小加加減减多多少少新新舊旧買买賣卖價价錢钱貨货運运費费開开關关寶宝護护墊垫罩罩套套殼壳膜膜貼贴繩绳鏈链環环圈圈釘钉螺螺絲丝彈弹簧簧鎖锁扣扣夾夹鉤钩籃篮筐筐櫃柜桌桌椅椅床床墊垫枕枕被被毯毯巾巾帽帽鞋鞋襪袜褲裤衣衣裙裙包包傘伞鏡镜錶表筆笔紙纸書书畫画燈灯泡泡管管線线插插頭头充充器器池池板板片片塊块條条卷卷捲卷噴喷壺壶瓶瓶杯杯碗碗盤盘勺勺叉叉刀刀鍋锅爐炉烤烤煮煮蒸蒸炸炸攪搅拌拌顯显擴扩腦脑觸触靜静聲声響响攝摄錄录視视頻频網网絡络傳传輸输資资訊讯檔档記记憶忆體体螢萤鍵键盤盘滑滑鼠鼠麥麦喇喇適适轉转埠埠槽槽讀读寫写貼贴殼壳座座托托臂臂夾夹調调節节升升降降旋旋摺折攜携實实鋼钢玻玻璃璃亞亚矽硅尼尼滌涤綸纶純纯織织繡绣縫缝拉拉鍊链釦扣磁磁吸吸壁壁孔孔繫系綁绑鬆松緊紧軟软硬硬厚厚薄薄寬宽窄窄圓圆방방層层格格層层抽抽屜屉櫃柜盒盒蓋盖鎖锁鑰钥匙匙鏈链繩绳網网袋袋箱箱籃篮簍篓'
    .match(/../g) || [];
  const m = {};
  for (const p of pairs) if (p[0] !== p[1]) m[p[0]] = p[1];
  return m;
})();

function looseNorm(text) {
  return norm(text)
    .replace(/[！-～]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/[^\w一-鿿>.]/g, '')   // 括號、星號、間隔號一律拿掉
    .split('').map((c) => T2S[c] || c).join('');
}

function simRatio(a, b) {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[n] / Math.max(m, n);
}

function matchSku(specText, offer) {
  const target = norm(specText);
  if (!target || !offer || !Array.isArray(offer.skus)) return null;
  const loose = looseNorm(specText);
  const ambiguous = [];
  const pick = (list, how) => {
    if (list.length === 1) return { ...list[0], how };
    if (list.length > 1 && !ambiguous.length) ambiguous.push(...list);
    return null;
  };

  const hit =
    // 1) 逐字相同
    pick(offer.skus.filter(s => firstAxis(s.specText) === target), '第一軸完全相同')
    || pick(offer.skus.filter(s => norm(s.specText) === target), '整串完全相同')
    // 2) 料號記的可能不是第一軸，任一軸相同也算
    || pick(offer.skus.filter(s => axes(s.specText).includes(target)), '某一軸完全相同')
    // 3) 寬鬆正規化後相同（繁簡、全形、裝飾符號差異）
    || pick(offer.skus.filter(s => looseNorm(s.specText).split('>')[0] === loose), '繁簡／符號差異')
    || pick(offer.skus.filter(s => looseNorm(s.specText).split('>').includes(loose)), '繁簡／符號差異（非第一軸）')
    // 4) 開頭相符或包含
    || pick(offer.skus.filter(s => looseNorm(s.specText).split('>')[0].startsWith(loose)), '開頭相符')
    || pick(offer.skus.filter(s => looseNorm(s.specText).includes(loose)), '包含');
  if (hit) return hit;

  // 5) 最後才用相似度：要夠像（≥0.72），而且明顯勝過第二名（差 ≥0.08），
  //    否則寧可不猜——猜錯會買錯貨。
  const scored = offer.skus
    .map(s => ({ s, score: Math.max(
      simRatio(loose, looseNorm(s.specText).split('>')[0]),
      simRatio(loose, looseNorm(s.specText).replace(/>/g, '')),
    ) }))
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  if (best && best.score >= 0.72 && (!second || best.score - second.score >= 0.08)) {
    return { ...best.s, how: `相似度 ${(best.score * 100).toFixed(0)}%`, score: best.score };
  }
  // 對到多筆時要講清楚是「規格文字不夠細」而不是「找不到」，
  // 多規格軸商品若料號只記第一軸，本來就無法決定是哪一筆。
  return ambiguous.length ? { ambiguous } : null;
}

const EXACT = ['第一軸完全相同', '整串完全相同'];


if (SUGGEST) {
  const { list } = await api('/api/products');
  console.log(`共用商品庫有 ${list.length} 個商品，掃描哪些規格的料號能對到 1688 SKU…\n`);
  console.log('商品編號,樣式,尺寸,數量        ← 可直接貼進採購單（數量自己改）');
  let found = 0;
  for (const item of list) {
    const code = item.code || item;
    const prod = await api(`/api/products/${encodeURIComponent(code)}`).catch(() => null);
    const variants = prod?.variants || prod?.data?.variants || [];
    for (const v of variants) {
      const rec = v.sku1688?.specId ? v.sku1688 : null;
      let ok = !!rec, price = rec?.unitPrice;
      if (!ok) {
        const { specText, offerId, nonAli } = parseVendorCode(v.vendorCode, skuDb.shortLinks);
        if (nonAli || !offerId || !skuDb.offers[offerId]) continue;
        const m = matchSku(specText, skuDb.offers[offerId]);
        if (!m || !m.specId) continue;
        ok = true; price = m.unitPrice;
      }
      if (!ok) continue;
      found++;
      console.log(`${code},${v.style || ''},${v.size || ''},1        # ¥${price ?? '—'} ${(prod?.name || prod?.data?.name || '').slice(0, 20)}`);
      if (found >= Number(flag('--suggest-limit', 20))) break;
    }
    if (found >= Number(flag('--suggest-limit', 20))) break;
  }
  console.log(found ? `\n共列出 ${found} 筆可用的規格。` : '\n沒有找到任何能對到 1688 SKU 的規格——可能商品的料號還沒填 1688 網址，或那些 offer 還沒抓。');
  process.exit(0);
}

// ── 逐列解析成 offerId + specId ─────────────────────────────────────────────
const plan = [];
const problems = [];
for (const o of orders) {
  let v = null;

  if (o.vendorCode) {
    // 採購單自帶料號：不必查共用商品庫
    v = { vendorCode: o.vendorCode, style: o.style, size: o.size };
  } else {
    const prod = await getProduct(o.code);
    if (!prod) { problems.push(`第${o.line}列：共用商品庫沒有商品 ${o.code}（或改在採購單直接填「廠商料號」欄）`); continue; }

    const variants = prod.variants || (prod.data && prod.data.variants) || [];
    v = variants.find((x) =>
      (!o.style || String(x.style).trim() === o.style) &&
      (!o.size  || String(x.size).trim()  === o.size));
    if (!v) { problems.push(`第${o.line}列：${o.code} 找不到規格「${o.style} / ${o.size}」`); continue; }
  }

  // 商品存檔時若已比對過就直接用，否則現場用料號比對一次
  let rec = v.sku1688 && v.sku1688.specId ? v.sku1688 : null;
  let how = rec ? '沿用商品存檔的比對結果' : '';
  if (!rec) {
    const { specText, offerId, nonAli } = parseVendorCode(v.vendorCode, skuDb.shortLinks);
    if (nonAli)   { problems.push(`第${o.line}列：${o.code} 的料號指向淘寶／天貓`); continue; }
    if (!offerId) { problems.push(`第${o.line}列：${o.code} 的料號解不出 offer`); continue; }
    const offer = skuDb.offers[offerId];
    if (!offer)   { problems.push(`第${o.line}列：offer ${offerId} 尚未收錄進 SKU 庫`); continue; }
    const m = matchSku(specText, offer);
    if (m && m.ambiguous) {
      const opts = m.ambiguous.slice(0, 4).map((x) => showSpec(x.specText)).join('、');
      problems.push(`第${o.line}列：規格「${specText}」在 offer ${offerId} 對到 ${m.ambiguous.length} 筆（${opts}${m.ambiguous.length > 4 ? '…' : ''}），料號要補上第二個規格`);
      continue;
    }
    if (!m)       { problems.push(`第${o.line}列：offer ${offerId} 找不到規格「${specText}」`); continue; }
    rec = { offerId, skuId: m.skuId, specId: m.specId, specText: m.specText, unitPrice: m.unitPrice };
    how = m.how;
  }
  if (!rec.specId) { problems.push(`第${o.line}列：${o.code} 的比對結果沒有 specId，請重跑上傳與比對`); continue; }

  const offer = skuDb.offers[rec.offerId] || {};
  plan.push({
    ...o, ...rec, how,
    offerTitle: offer.title || '',
    beginNum: offer.beginNum ?? null,
    subtotal: rec.unitPrice ? Number(rec.unitPrice) * o.qty : null,
  });
}

// ── 顯示計畫 ────────────────────────────────────────────────────────────────
console.log('\n=== 採購計畫 ===');
for (const p of plan) {
  const warn = p.beginNum && p.qty < p.beginNum ? `  ⚠ 起訂量 ${p.beginNum}` : '';
  const label = p.code ? `${p.code} ${p.style}/${p.size}` : (p.offerTitle || '料號').slice(0, 24);
  console.log(`  ${label} ×${p.qty}  →  offer ${p.offerId} sku ${p.skuId}`);
  console.log(`      ${p.specText.replace(/&gt;/g, ' > ')} ｜ ¥${p.unitPrice ?? '—'} ｜ 小計 ¥${p.subtotal?.toFixed(2) ?? '—'} ｜ ${p.how}${warn}`);
}
const total = plan.reduce((a, p) => a + (p.subtotal || 0), 0);
console.log(`\n合計 ${plan.length} 個規格、¥${total.toFixed(2)}（約 NT$${Math.round(total * 4.55).toLocaleString()}，匯率 4.55）`);
if (problems.length) {
  console.log(`\n=== 無法處理的 ${problems.length} 列 ===`);
  problems.forEach((p) => console.log('  • ' + p));
}
if (!plan.length) process.exit(1);

if (!DO_ADD) {
  console.log('\n這是試算，沒有動你的進貨車。確認無誤後加上 --add 實際加入。');
  process.exit(0);
}

// ── 實際加入進貨車 ──────────────────────────────────────────────────────────
// 用頁面自己的 window.lib.mtop.request，簽章與 cookie 都交給網站處理。
const goodsParams = plan.map((p) => ({
  specId: p.specId,
  offerId: Number(p.offerId),
  quantity: p.qty,
  flow: 'general',
  ext: { sceneCode: '' },
}));

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: false, viewport: null, locale: 'zh-CN',
  args: ['--disable-blink-features=AutomationControlled'],
});
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto(`https://detail.1688.com/offer/${plan[0].offerId}.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => !!window.lib?.mtop?.request, undefined, { timeout: 30000 })
  .catch(() => { throw new Error('頁面上找不到 lib.mtop，可能被驗證頁擋住，請先在視窗內通過驗證'); });

const result = await page.evaluate(async (goods) => {
  try {
    const res = await window.lib.mtop.request({
      api: 'com.alibaba.china.buy.service.purchase.MtopPurchaseService.addCargo',
      v: '1.0',
      type: 'POST',
      dataType: 'originaljson',
      data: { client: 'pc', goodsParams: JSON.stringify(goods), purchaseType: '' },
    });
    return { ok: true, res };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e), raw: e };
  }
}, goodsParams);

console.log('\n=== addCargo 回應 ===');
console.log(JSON.stringify(result, null, 2).slice(0, 1500));
const ret = result?.res?.ret?.[0] || '';
if (/SUCCESS/i.test(ret)) {
  console.log(`\n✓ 已加入進貨車：${plan.length} 個規格。請到 https://cart.1688.com 核對後自行下單付款。`);
} else {
  console.log('\n✗ 加入失敗，請看上面的回應內容。');
}
await ctx.close();
