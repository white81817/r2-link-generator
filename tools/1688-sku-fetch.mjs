#!/usr/bin/env node
/**
 * 1688 SKU 抓取（Playwright 版，取代 Tampermonkey 腳本）
 *
 * 資料來源：商品頁 SSR 掛在 window 上的
 *   window.context.result.data.Root.fields.dataJson.skuModel
 *     ├ skuProps    規格軸定義（prop 名稱 + 各選項的 name/imageUrl）
 *     └ skuInfoMap  key = 使用者在頁面上看到的規格文字，value = { skuId, specId, price, ... }
 *   → 料號欄位記的規格文字可直接當 key 查 skuId，第 2 階段不必做模糊比對。
 *
 * 實測不需登入即可取得。首次執行會在 --profile 指定的目錄建立獨立 Chrome profile，
 * 若日後遇到需登入才顯示的價格（dataJson.isPricePrivate），用 --login 開著視窗手動登入一次即可。
 *
 * 用法：
 *   node tools/1688-sku-fetch.mjs --from-userscript          # 抓 user.js 內建的 51 個 offer
 *   node tools/1688-sku-fetch.mjs 634162136992 933370072634  # 抓指定 offer
 *   node tools/1688-sku-fetch.mjs --resolve-short            # 解析 user.js 內建短網址 → offer id
 *   node tools/1688-sku-fetch.mjs --login                    # 只開瀏覽器供手動登入
 * 選項：
 *   --out <path>      輸出 NDJSON，預設 tools/out/1688-sku.ndjson（重跑會略過已抓過的 offer）
 *   --profile <path>  Chrome profile 目錄，預設 tools/.chrome-1688
 *   --headed          顯示瀏覽器視窗（預設顯示；--headless 可關）
 *   --delay <ms>      每筆間隔，預設 3000
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i === -1 ? d : argv[i + 1]; };
const has = (n) => argv.includes(n);

const OUT = path.resolve(flag('--out', path.join(HERE, 'out', '1688-sku.ndjson')));
const PROFILE = path.resolve(flag('--profile', path.join(HERE, '.chrome-1688')));
const DELAY = Number(flag('--delay', 3000));
const HEADLESS = has('--headless');
const BLOCK_WAIT = Number(flag('--block-wait', 120000)); // 判定為驗證頁時等人工處理的上限

function fromUserscript(varName) {
  const src = fs.readFileSync(path.join(HERE, '1688-sku-grabber.user.js'), 'utf8');
  const m = src.match(new RegExp(`${varName}\\s*=\\s*\\[([\\s\\S]*?)\\]`));
  if (!m) throw new Error(`user.js 內找不到 ${varName}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

// 注意：要排除緊跟在 --flag 後面的值，否則 `--block-wait 300000` 的 300000
// 會被當成 offer id 抓下去。
const positional = argv.filter((a, i) => !a.startsWith('--') && !(argv[i - 1] || '').startsWith('--'));
const offers = has('--from-userscript')
  ? fromUserscript('TARGET_OFFERS')
  : positional.filter((a) => /^\d{6,}$/.test(a));

async function open() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless: HEADLESS,
    viewport: null,
    locale: 'zh-CN',
    args: ['--disable-blink-features=AutomationControlled', '--window-size=1440,900'],
  });
  return { ctx, page: ctx.pages()[0] || (await ctx.newPage()) };
}

/** 讀取頁面已解析好的 skuModel；主路徑失效時往 window 下遞迴找備援 */
const readSkuModel = (page) => page.evaluate(() => {
  const j = (o) => { try { return JSON.parse(JSON.stringify(o)); } catch { return null; } };
  const dj = window.context?.result?.data?.Root?.fields?.dataJson;
  if (dj?.skuModel) return { via: 'context', dataJson: j({ ...dj, skuModel: dj.skuModel }) };
  const seen = new WeakSet();
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || depth > 6 || seen.has(o)) return null;
    seen.add(o);
    let keys; try { keys = Object.keys(o); } catch { return null; }
    for (const k of keys) {
      let v; try { v = o[k]; } catch { continue; }
      if (k === 'skuModel' && v?.skuInfoMap) return v;
      const hit = walk(v, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  for (const k of Object.keys(window)) {
    let v; try { v = window[k]; } catch { continue; }
    if (v && typeof v === 'object' && v !== window) {
      const hit = walk(v, 1);
      if (hit) return { via: 'scan:' + k, dataJson: { skuModel: j(hit) } };
    }
  }
  return null;
});

/** 驗證頁的判斷條件；等待解除時必須用同一組條件，否則靠頁面文字判定的頁面永遠等不到解除 */
const BLOCK_RE = /_____tmd_____|punish|nocaptcha|_____sec_____/;
const isBlocked = (page) => page.evaluate((src) => {
  // 只認網址上的驗證特徵，以及頁面上真的存在滑塊元件。
  // 早期版本拿 body 前 500 字比對「安全验证」，正常商品頁也會命中而誤判。
  if (new RegExp(src).test(location.href)) return true;
  return !!document.querySelector('.nc-container, #nc_1_wrapper, .nc_scale, [id^="nocaptcha"]');
}, BLOCK_RE.source);

async function grabOffer(page, id) {
  const url = `https://detail.1688.com/offer/${id}.html`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // 注意：waitForFunction 的簽名是 (fn, arg, options)，timeout 必須放第三個參數，
  // 放第二個會被當成 arg、靜默套用預設 30 秒。
  await page.waitForFunction(
    () => !!window.context?.result?.data?.Root?.fields?.dataJson,
    undefined,
    { timeout: 20000 },
  ).catch(() => {});

  if (await isBlocked(page)) {
    if (HEADLESS) throw new Error('遇到滑塊驗證，請改用 --headed 手動通過');
    const shot = path.join(path.dirname(OUT), `blocked-${id}.png`);
    await page.screenshot({ path: shot }).catch(() => {});
    fs.writeFileSync(path.join(path.dirname(OUT), `blocked-${id}.html`), await page.content());
    console.log(`   ⚠ 判定為驗證頁，已存證 ${shot}；請在 Chrome 視窗內手動通過（最多等 ${BLOCK_WAIT / 1000} 秒）…`);
    const until = Date.now() + BLOCK_WAIT;
    // 人工通過驗證的瞬間頁面會跳轉，evaluate 會丟 "Execution context was destroyed"。
    // 那是成功的訊號，不是失敗——輪詢時要吞掉並重試。
    for (;;) {
      let blocked;
      try {
        blocked = await isBlocked(page);
      } catch {
        await page.waitForTimeout(1500);
        continue;
      }
      if (!blocked) break;
      if (Date.now() > until) throw new Error(`驗證等待逾時（${BLOCK_WAIT / 1000} 秒），略過此筆`);
      await page.waitForTimeout(3000);
    }
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    console.log('   ✓ 驗證已通過，繼續');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      () => !!window.context?.result?.data?.Root?.fields?.dataJson,
      undefined,
      { timeout: 20000 },
    ).catch(() => {});
  }

  if (!grabOffer.loginChecked) {
    grabOffer.loginChecked = true;
    // 登入 cookie（cookie2/unb/sgcookie）多半是 HttpOnly，document.cookie 看不到，
    // 必須用 context.cookies()；再加一個 DOM 標記交叉確認。
    const cookies = await page.context().cookies();
    const names = new Set(cookies.map((c) => c.name));
    const signed = ['cookie2', 'unb', 'sgcookie', '_nk_', 'havana_lgc_exp'].filter((n) => names.has(n));
    const nick = cookies.find((c) => c.name === '_nk_')?.value;
    const domMark = await page.evaluate(() =>
      !!document.querySelector('[class*="member-nick"], [class*="user-nick"], .sn-login-name')
      || /退出|我的阿里/.test(document.body.innerText.slice(0, 3000)));
    console.log(signed.length
      ? `   ℹ 已登入（cookie: ${signed.join(',')}${nick ? '、暱稱 ' + decodeURIComponent(nick) : ''}；DOM 標記 ${domMark ? '有' : '無'}）`
      : `   ℹ 未登入：找不到任何登入 cookie（DOM 標記 ${domMark ? '有' : '無'}）`);
  }

  const res = await readSkuModel(page);
  if (!res) {
    // 下架商品沒有 window.context，只有一句「商品已下架」，要講人話而不是「找不到 skuModel」
    const delisted = await page.evaluate(() =>
      /商品已下架|该商品已下架|商品不存在/.test((document.body?.innerText || '').slice(0, 200)));
    throw new Error(delisted ? '商品已下架' : '找不到 skuModel');
  }
  const dj = res.dataJson;
  const sm = dj.skuModel;
  // 兩種定價模型：
  //   a) 逐 SKU 定價 —— skuInfoMap 各筆自帶 price/discountPrice
  //   b) 階梯價     —— skuInfoMap 各筆「沒有」price，全品同價，價格在 skuRangePrices
  //                    （例：1 件 52 元 / 500 件 50 元 / 5000 件 48 元）
  // unitPrice 統一填「買 1 件的單價」，priceSource 標明來源，下游不必分兩套處理。
  const ranges = dj.orderParamModel?.orderParam?.skuParam?.skuRangePrices ?? null;
  const rangeUnit = ranges?.length
    ? ranges.reduce((a, b) => (Number(a.beginAmount) <= Number(b.beginAmount) ? a : b)).price
    : null;

  const skus = Object.entries(sm.skuInfoMap || {}).map(([specText, v]) => {
    const own = v.discountPrice ?? v.price ?? null;
    return {
      specText,                    // 頁面顯示文字 = 料號欄位記的字串
      skuId: v.skuId,
      specId: v.specId,
      price: v.price ?? null,
      discountPrice: v.discountPrice ?? null,
      unitPrice: own ?? rangeUnit,
      priceSource: own ? 'sku' : (rangeUnit ? 'range' : 'none'),
      canBookCount: v.canBookCount,
    };
  });

  return {
    offerId: id,
    url,
    title: await page.title(),
    via: res.via,
    isSkuOffer: dj.isSkuOffer,
    isPricePrivate: dj.isPricePrivate,
    props: (sm.skuProps || []).map((p) => ({ fid: p.fid, prop: p.prop, values: (p.value || []).map((v) => v.name) })),
    priceScale: sm.skuPriceScale ?? null,
    rangePrices: ranges,
    beginNum: dj.orderParamModel?.orderParam?.beginNum ?? null,
    skuCount: skus.length,
    skus,
    fetchedAt: new Date().toISOString(),
  };
}

async function resolveShort(page, link) {
  await page.goto(link, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(2500);
  const finalUrl = page.url();
  const m = finalUrl.match(/offer\/(\d+)\.html/) || finalUrl.match(/[?&]offerId=(\d+)/);
  return { short: link, finalUrl, offerId: m ? m[1] : null };
}

// ── 主流程 ────────────────────────────────────────────────
if (has('--login')) {
  const { ctx, page } = await open();
  await page.goto('https://login.1688.com/member/signin.htm');
  console.log('請在視窗內登入，完成後關掉視窗即可（登入狀態會留在 profile）。');
  await page.waitForEvent('close', { timeout: 0 }).catch(() => {});
  await ctx.close();
} else if (has('--resolve-short')) {
  const links = fromUserscript('TARGET_SHORT_LINKS');
  const { ctx, page } = await open();
  const outFile = OUT.replace(/\.ndjson$/, '-short.ndjson');
  const done = new Set(fs.existsSync(outFile)
    ? fs.readFileSync(outFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).short) : []);
  for (const [i, link] of links.entries()) {
    if (done.has(link)) { console.log(`[${i + 1}/${links.length}] 略過 ${link}`); continue; }
    try {
      const r = await resolveShort(page, link);
      fs.appendFileSync(outFile, JSON.stringify(r) + '\n');
      console.log(`[${i + 1}/${links.length}] ${link} → ${r.offerId || '（非 1688：' + r.finalUrl.slice(0, 60) + '）'}`);
    } catch (e) { console.log(`[${i + 1}/${links.length}] ${link} 失敗：${e.message}`); }
    await page.waitForTimeout(DELAY);
  }
  await ctx.close();
} else if (!offers.length) {
  console.log('沒有指定 offer。用 --from-userscript 或直接給 offer id，說明見檔頭。');
} else {
  const done = new Set(fs.existsSync(OUT)
    ? fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).offerId) : []);
  const { ctx, page } = await open();
  let ok = 0, fail = 0;
  for (const [i, id] of offers.entries()) {
    if (done.has(id)) { console.log(`[${i + 1}/${offers.length}] ${id} 已抓過，略過`); continue; }
    try {
      const rec = await grabOffer(page, id);
      fs.appendFileSync(OUT, JSON.stringify(rec) + '\n');
      ok++;
      console.log(`[${i + 1}/${offers.length}] ${id} ✓ ${rec.skuCount} 個 SKU  ${rec.title.slice(0, 30)}`);
    } catch (e) {
      fail++;
      fs.appendFileSync(OUT.replace(/\.ndjson$/, '-errors.ndjson'),
        JSON.stringify({ offerId: id, error: e.message, at: new Date().toISOString() }) + '\n');
      console.log(`[${i + 1}/${offers.length}] ${id} ✗ ${e.message}`);
    }
    await page.waitForTimeout(DELAY);
  }
  console.log(`\n完成：成功 ${ok}、失敗 ${fail}，輸出 ${OUT}`);
  await ctx.close();
}
