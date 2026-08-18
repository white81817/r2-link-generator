// ==UserScript==
// @name         1688 SKU 抓取器 → didibox
// @namespace    https://didibox.cc/
// @version      1.0.0
// @description  在 1688 頁面批次抓取商品 SKU（skuId／規格文字／價格／庫存）並上傳到 didibox-api，供產品建立的採購下單功能比對使用
// @match        https://*.1688.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const API = 'https://didibox-api.adam-061.workers.dev';
  const TOKEN_KEY = 'didibox_token';
  const USER_KEY  = 'didibox_user';

  // ── 從商品頁的內嵌資料取出 SKU ──────────────────────────────────────────
  // 1688 會把商品資料以 JSON 放進 script，不同版型鍵名略有差異，逐一嘗試。
  function extractSkus(html) {
    const out = [];
    let title = '';
    const t = html.match(/<title>([^<]*)<\/title>/i);
    if (t) title = t[1].replace(/[-_].*(阿里巴巴|1688).*/, '').trim();

    // 版型一：skuInfoMap = { "規格文字": {skuId, price, canBookCount} }
    const m1 = html.match(/"skuInfoMap"\s*:\s*(\{.*?\})\s*,\s*"[a-zA-Z]/s);
    if (m1) {
      try {
        const map = JSON.parse(m1[1]);
        for (const [specText, v] of Object.entries(map)) {
          out.push({
            specText,
            skuId: String(v.skuId ?? v.specId ?? ''),
            price: v.price ?? v.discountPrice ?? null,
            stock: v.canBookCount ?? v.saleCount ?? null,
          });
        }
      } catch (e) { console.warn('[didibox] skuInfoMap 解析失敗', e); }
    }

    // 版型二：skuModel.skuInfoMapList = [{skuId, specAttrs, price, canBookCount}]
    if (!out.length) {
      const m2 = html.match(/"skuInfoMapList"\s*:\s*(\[.*?\])\s*,\s*"[a-zA-Z]/s);
      if (m2) {
        try {
          JSON.parse(m2[1]).forEach(v => out.push({
            specText: String(v.specAttrs ?? v.specId ?? ''),
            skuId: String(v.skuId ?? ''),
            price: v.price ?? v.discountPrice ?? null,
            stock: v.canBookCount ?? null,
          }));
        } catch (e) { console.warn('[didibox] skuInfoMapList 解析失敗', e); }
      }
    }

    return { title, skus: out.filter(s => s.skuId || s.specText) };
  }

  async function fetchOffer(offerId) {
    // 同源請求，自動帶登入 cookie
    const url = `https://detail.1688.com/offer/${offerId}.html`;
    const res = await fetch(url, { credentials: 'include' });
    const html = await res.text();
    if (/login\.1688\.com|滑动验证|安全验证|请输入验证码/i.test(html)) {
      throw new Error('被要求登入或出現驗證，請先在瀏覽器完成驗證再重試');
    }
    const { title, skus } = extractSkus(html);
    if (!skus.length) throw new Error('頁面解析不到 SKU（版型可能不同）');
    return { offerId, title, url, skus, fetchedAt: new Date().toISOString() };
  }

  async function api(path, options) {
    const res = await fetch(API + path, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'X-Quote-Token': localStorage.getItem(TOKEN_KEY) || '',
        ...(options && options.headers),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ── 介面 ────────────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:999999;background:#fff;border:1px solid #d0d0d0;'
    + 'border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.18);font:13px/1.6 sans-serif;width:320px;overflow:hidden';
  panel.innerHTML = `
    <div style="background:#0284c7;color:#fff;padding:8px 12px;font-weight:bold;display:flex;justify-content:space-between">
      <span>didibox SKU 抓取器</span>
      <span id="dbx-min" style="cursor:pointer">—</span>
    </div>
    <div id="dbx-body" style="padding:12px">
      <div style="margin-bottom:8px">
        <input id="dbx-token" type="password" placeholder="didibox 通行碼" style="width:100%;padding:5px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box">
      </div>
      <div style="margin-bottom:8px">
        <input id="dbx-user" type="text" placeholder="你的名字" style="width:100%;padding:5px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box">
      </div>
      <div style="margin-bottom:8px">
        <textarea id="dbx-ids" rows="4" placeholder="offer id，一行一個&#10;或直接貼 1688 網址" style="width:100%;padding:5px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box;font-family:monospace;font-size:12px"></textarea>
      </div>
      <div style="display:flex;gap:6px;margin-bottom:8px">
        <button id="dbx-here" style="flex:1;padding:6px;border:1px solid #ccc;background:#f5f5f5;border-radius:4px;cursor:pointer">抓目前頁面</button>
        <button id="dbx-run" style="flex:1;padding:6px;border:0;background:#0284c7;color:#fff;border-radius:4px;cursor:pointer;font-weight:bold">批次抓取</button>
      </div>
      <div id="dbx-log" style="max-height:180px;overflow:auto;background:#f8f8f8;border-radius:4px;padding:6px;font-size:12px;color:#444"></div>
    </div>`;
  document.body.appendChild(panel);

  const $ = id => panel.querySelector('#' + id);
  const log = (msg, color) => {
    const d = document.createElement('div');
    if (color) d.style.color = color;
    d.textContent = msg;
    $('dbx-log').appendChild(d);
    $('dbx-log').scrollTop = $('dbx-log').scrollHeight;
  };

  $('dbx-token').value = localStorage.getItem(TOKEN_KEY) || '';
  $('dbx-user').value  = localStorage.getItem(USER_KEY)  || '';
  $('dbx-min').onclick = () => {
    const b = $('dbx-body');
    b.style.display = b.style.display === 'none' ? 'block' : 'none';
  };

  function currentOfferId() {
    const m = location.href.match(/\/offer\/(\d+)\.html/);
    return m ? m[1] : '';
  }

  $('dbx-here').onclick = () => {
    const id = currentOfferId();
    if (!id) { log('目前頁面不是商品頁', '#c00'); return; }
    $('dbx-ids').value = id;
    log('已帶入目前頁面 offer：' + id);
  };

  $('dbx-run').onclick = async () => {
    const token = $('dbx-token').value.trim();
    const user  = $('dbx-user').value.trim();
    if (!token) { log('請先輸入 didibox 通行碼', '#c00'); return; }
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, user);

    // 支援直接貼網址，從中取出 offer id
    const ids = [...new Set(
      $('dbx-ids').value.split(/[\s,]+/)
        .map(x => (x.match(/(\d{6,})/) || [])[1])
        .filter(Boolean)
    )];
    if (!ids.length) { log('沒有可用的 offer id', '#c00'); return; }

    log(`開始抓取 ${ids.length} 個 offer…`, '#0284c7');
    const offers = {};
    let okCount = 0;
    for (const id of ids) {
      try {
        const data = await fetchOffer(id);
        offers[id] = data;
        okCount++;
        log(`✓ ${id}　${data.skus.length} 個 SKU　${data.title.slice(0, 18)}`, '#080');
      } catch (e) {
        log(`✗ ${id}　${e.message}`, '#c00');
      }
      // 放慢速度避免觸發風控
      await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));
    }

    if (!okCount) { log('沒有成功的資料，不上傳', '#c00'); return; }
    try {
      const r = await api('/api/1688/skus', {
        method: 'POST',
        body: JSON.stringify({ offers, uploadedBy: user }),
      });
      log(`已上傳 ${r.saved} 個 offer，資料庫共 ${r.total} 個`, '#0284c7');
    } catch (e) {
      log('上傳失敗：' + e.message, '#c00');
    }
  };

  log('就緒。先填通行碼，再貼 offer id 或網址。');
})();
