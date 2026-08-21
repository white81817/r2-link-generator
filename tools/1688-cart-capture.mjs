#!/usr/bin/env node
/**
 * 錄製「加入进货车」的真實請求，供第 3 階段組出 addCargo 呼叫。
 *
 * 加入進貨車打的是 MTOP：
 *   com.alibaba.china.buy.service.purchase.MtopPurchaseService.addCargo
 * 其 goodsParams 由頁面內部的 dataManager 依當下規格選擇狀態產生，
 * 無法在外部憑空拼湊，所以先錄一次真實請求。
 *
 * 這支腳本「不會」自己點按鈕：它只開頁面並側錄，由使用者本人操作。
 *
 * 用法：node tools/1688-cart-capture.mjs [offerId]
 */
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OFFER = process.argv.find((a) => /^\d{6,}$/.test(a)) || '933370072634';
const OUT = path.join(HERE, 'out');
const PROFILE = path.join(HERE, '.chrome-1688');
fs.mkdirSync(OUT, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chrome', headless: false, viewport: null, locale: 'zh-CN',
  args: ['--disable-blink-features=AutomationControlled', '--window-size=1440,900'],
});
const page = ctx.pages()[0] || await ctx.newPage();

const hits = [];
page.on('request', (req) => {
  const u = req.url();
  // 只認 addCargo；早期版本寫成 /purchase/i，會被 repurchase.access（再次購買）誤中而提早結束
  if (!/addCargo|MtopPurchaseService/i.test(u)) return;
  hits.push({
    at: new Date().toISOString(),
    method: req.method(),
    url: u,
    headers: req.headers(),
    postData: req.postData(),
  });
  console.log(`\n★ 錄到請求：${req.method()} ${u.slice(0, 120)}`);
});
page.on('response', async (res) => {
  if (!/addCargo|MtopPurchaseService/i.test(res.url())) return;
  let body = '';
  try { body = await res.text(); } catch {}
  hits[hits.length - 1] && (hits[hits.length - 1].responseStatus = res.status());
  hits[hits.length - 1] && (hits[hits.length - 1].responseBody = body.slice(0, 5000));
  console.log(`★ 回應 ${res.status()}：${body.slice(0, 200)}`);
});

await page.goto(`https://detail.1688.com/offer/${OFFER}.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
console.log(`
────────────────────────────────────────────────────────
已開啟 offer ${OFFER}。

請在視窗裡：
  1. 選一個規格（建議挑最便宜的），數量填 1
  2. 按「加入进货车」
  3. 加完可以直接去購物車刪掉，不影響錄製結果

錄到請求後會自動存檔並關閉（最多等 10 分鐘）。
────────────────────────────────────────────────────────
`);

const until = Date.now() + 600000;
while (!hits.some((h) => h.postData) && Date.now() < until) {
  await page.waitForTimeout(2000);
}

const file = path.join(OUT, 'cart-addcargo.json');
fs.writeFileSync(file, JSON.stringify(hits, null, 2));
console.log(hits.length ? `\n✓ 已存 ${hits.length} 筆到 ${file}` : '\n✗ 逾時，沒有錄到請求');
await ctx.close();
