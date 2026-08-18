// ==UserScript==
// @name         1688 SKU 抓取器 → didibox
// @namespace    https://didibox.cc/
// @version      1.2.0
// @description  在 1688 頁面批次抓取商品 SKU（skuId／規格文字／價格／庫存）並上傳到 didibox-api，供產品建立的採購下單功能比對使用
// @match        https://*.1688.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const API = 'https://didibox-api.adam-061.workers.dev';

  // 由商品資料的廠商料號解析出的全部 1688 offer，供「抓取全部」一鍵處理
  const TARGET_OFFERS = [
    '1004092290315',
    '1005503266568',
    '1019344974493',
    '1024837027371',
    '1026849397397',
    '1034705134103',
    '1044476900282',
    '1044976888730',
    '1055517644671',
    '1062215344087',
    '527498129100',
    '571976706851',
    '587253792142',
    '634162136992',
    '672041840952',
    '676646368903',
    '679250263576',
    '692243157850',
    '692567108047',
    '731188094415',
    '762418064424',
    '768798996295',
    '776781295952',
    '778281484398',
    '799936854408',
    '800072146445',
    '820721957066',
    '829686976232',
    '841516156399',
    '873752531966',
    '884908161516',
    '891439657364',
    '896500523851',
    '896616865501',
    '913166288456',
    '920965125734',
    '930934104963',
    '933370072634',
    '945521037045',
    '949797922200',
    '950242580897',
    '953713233440',
    '959130002227',
    '961182143989',
    '975514885637',
    '986277159142',
    '986729295390',
    '988916632923',
    '991047601637',
    '995589572095',
    '995988445516',
  ];
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
  // 收合狀態的小圓鈕：1688 自己的登入視窗、彈窗很多，面板常駐會擋到操作，
  // 因此預設收合，只留一顆小按鈕，需要時再展開。
  const bubble = document.createElement('div');
  bubble.textContent = 'SKU';
  bubble.title = 'didibox SKU 抓取器（點擊展開）';
  bubble.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;width:46px;height:46px;'
    + 'border-radius:50%;background:#0284c7;color:#fff;font:bold 13px/46px sans-serif;text-align:center;'
    + 'cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.3);user-select:none';
  document.body.appendChild(bubble);

  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:16px;bottom:70px;z-index:2147483000;background:#fff;border:1px solid #d0d0d0;'
    + 'border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.18);font:13px/1.6 sans-serif;width:320px;overflow:hidden;display:none';
  panel.innerHTML = `
    <div id="dbx-head" style="background:#0284c7;color:#fff;padding:8px 12px;font-weight:bold;display:flex;justify-content:space-between;cursor:move">
      <span>didibox SKU 抓取器</span>
      <span id="dbx-min" style="cursor:pointer;padding:0 4px">✕</span>
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
        <button id="dbx-run" style="flex:1;padding:6px;border:0;background:#0284c7;color:#fff;border-radius:4px;cursor:pointer;font-weight:bold">抓取清單</button>
      </div>
      <button id="dbx-all" style="width:100%;padding:7px;border:0;background:#16a34a;color:#fff;border-radius:4px;cursor:pointer;font-weight:bold;margin-bottom:8px">&#9889; 抓取全部待處理</button>
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
  bubble.onclick = () => { panel.style.display = 'block'; bubble.style.display = 'none'; };
  $('dbx-min').onclick = () => { panel.style.display = 'none'; bubble.style.display = 'block'; };

  // 標題列可拖曳，避免固定位置剛好壓到頁面上要點的東西
  (() => {
    const head = $('dbx-head');
    let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
    head.addEventListener('mousedown', e => {
      if (e.target.id === 'dbx-min') return;
      dragging = true;
      const r = panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      panel.style.left = ox + 'px'; panel.style.top = oy + 'px';
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      panel.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
      panel.style.top  = Math.max(0, oy + e.clientY - sy) + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  })();

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

  // 一鍵處理：先問伺服器已收錄哪些，只補差集，中斷後再按可接續
  $('dbx-all').onclick = async () => {
    const token = $('dbx-token').value.trim();
    if (!token) { log('請先輸入 didibox 通行碼', '#c00'); return; }
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, $('dbx-user').value.trim());

    log('查詢已抓取的資料…', '#0284c7');
    let done = new Set();
    try {
      const r = await api('/api/1688/skus');
      done = new Set(Object.keys(r.offers || {}));
      log('資料庫已有 ' + done.size + ' 個 offer');
    } catch (e) {
      log('查詢失敗（將全部重抓）：' + e.message, '#c60');
    }

    const todo = TARGET_OFFERS.filter(id => !done.has(id));
    if (!todo.length) { log('全部都抓過了，無需處理', '#080'); return; }
    log('待抓取 ' + todo.length + ' / ' + TARGET_OFFERS.length + ' 個', '#0284c7');
    $('dbx-ids').value = todo.join('\n');
    $('dbx-run').click();
  };

  log('就緒：填好通行碼後按綠色按鈕即可（內建 ' + TARGET_OFFERS.length + ' 個 offer）');
})();
