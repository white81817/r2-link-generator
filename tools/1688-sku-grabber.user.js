// ==UserScript==
// @name         1688 SKU 抓取器 → didibox
// @namespace    https://didibox.cc/
// @version      1.5.0
// @description  在 1688 頁面批次抓取商品 SKU（skuId／規格文字／價格／庫存）並上傳到 didibox-api，供產品建立的採購下單功能比對使用
// @match        https://*.1688.com/*
// @grant        GM_xmlhttpRequest
// @connect      detail.1688.com
// @connect      www.1688.com
// @connect      qr.1688.com
// @connect      lihi2.com
// @connect      didibox-api.adam-061.workers.dev
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const API = 'https://didibox-api.adam-061.workers.dev';

  // 由商品資料的廠商料號解析出的全部 1688 offer，供「抓取全部」一鍵處理
  // 料號中的短網址，需先解析出真正的目的地才知道是不是 1688 商品
  const TARGET_SHORT_LINKS = [
    'https://lihi2.com/3CB65',
    'https://lihi2.com/59PS4',
    'https://lihi2.com/5guuH',
    'https://lihi2.com/74cq4',
    'https://lihi2.com/BZPv0',
    'https://lihi2.com/BhHGz',
    'https://lihi2.com/Bv8tN',
    'https://lihi2.com/CJuZg',
    'https://lihi2.com/IevV4',
    'https://lihi2.com/M3oRO',
    'https://lihi2.com/NLOkj',
    'https://lihi2.com/P3vQV',
    'https://lihi2.com/QQjg3',
    'https://lihi2.com/RgL0h',
    'https://lihi2.com/Sg83L',
    'https://lihi2.com/UzhPR',
    'https://lihi2.com/V2x5L',
    'https://lihi2.com/a89Ro',
    'https://lihi2.com/ajIeY',
    'https://lihi2.com/dgxJK',
    'https://lihi2.com/fixjm',
    'https://lihi2.com/hIPF3',
    'https://lihi2.com/r3ofr',
    'https://lihi2.com/rk5Bp',
    'https://lihi2.com/tPU8B',
    'https://lihi2.com/uQDJD',
    'https://lihi2.com/wJHGU',
    'https://lihi2.com/xvjxG',
    'https://qr.1688.com/s/6Ziz0LQu',
    'https://qr.1688.com/s/Tr8bqWG0',
    'https://qr.1688.com/s/aL33sqEg',
  ];

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
  // ── SKU 解析 ────────────────────────────────────────────────────────────
  // 1688 商品頁版型多變，固定的鍵名正規表達式只認得部分頁面。
  // 改為通用做法：在整份 HTML 中找出所有含 skuId 的 JSON 物件，
  // 不依賴外層結構，因此新舊版型都能處理。
  function findObjectsContaining(html, key, limit) {
    const out = [];
    const SPAN = 30000;              // 單一物件的搜尋上限，避免掃過頭
    let idx = -1;
    while ((idx = html.indexOf(key, idx + 1)) !== -1 && out.length < (limit || 800)) {
      // 往回找到包住它的 {
      let depth = 0, start = -1;
      for (let i = idx; i >= 0 && idx - i < SPAN; i--) {
        const ch = html[i];
        if (ch === '}') depth++;
        else if (ch === '{') { if (depth === 0) { start = i; break; } depth--; }
      }
      if (start < 0) { continue; }

      // 往前找到對應的 }
      let d = 0, end = -1;
      for (let i = start; i < html.length && i - start < SPAN; i++) {
        const ch = html[i];
        if (ch === '{') d++;
        else if (ch === '}') { d--; if (d === 0) { end = i; break; } }
      }
      if (end < 0) { continue; }

      let obj = null;
      try { obj = JSON.parse(html.slice(start, end + 1)); } catch (e) { /* 非合法 JSON 就跳過 */ }
      if (obj) {
        // 規格文字常是外層 map 的鍵，往回取 "xxx": 作為補充
        let keyName = '';
        const before = html.slice(Math.max(0, start - 120), start);
        const km = before.match(/"([^"]{1,80})"\s*:\s*$/);
        if (km) keyName = km[1];
        out.push({ obj, keyName });
      }
      idx = end > idx ? end : idx;
    }
    return out;
  }

  const pick = (o, keys) => {
    for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
    return null;
  };

  function extractSkus(html) {
    let title = '';
    const t = html.match(/<title>([^<]*)<\/title>/i);
    if (t) title = t[1].replace(/[-_].*(阿里巴巴|1688).*/, '').trim();

    const found = findObjectsContaining(html, '"skuId"');
    const seen = new Set();
    const skus = [];
    for (const { obj, keyName } of found) {
      const skuId = pick(obj, ['skuId', 'specId']);
      if (!skuId || seen.has(String(skuId))) continue;

      // 規格文字可能在物件內，也可能是外層 map 的鍵
      let specText = pick(obj, ['specAttrs', 'specText', 'skuAttr', 'attributes', 'name']);
      if (specText && typeof specText === 'object') specText = JSON.stringify(specText);
      if (!specText) specText = keyName;

      let price = pick(obj, ['price', 'discountPrice', 'currentPrice', 'sellPrice']);
      if (price && typeof price === 'object') price = pick(price, ['price', 'value']) || null;

      seen.add(String(skuId));
      skus.push({
        skuId: String(skuId),
        specText: String(specText || '').slice(0, 200),
        price: price ?? null,
        stock: pick(obj, ['canBookCount', 'saleCount', 'amountOnSale', 'stock', 'quantity']),
      });
    }
    return { title, skus, rawKeys: skus.length ? null : diagnose(html) };
  }

  // 解析失敗時收集線索，用來判斷該頁用的是什麼結構
  function diagnose(html) {
    const keys = [...new Set((html.match(/"(sku[A-Za-z]*|spec[A-Za-z]*)"/g) || []))].slice(0, 25);
    return {
      htmlLength: html.length,
      skuLikeKeys: keys,
      hasInitData: /__INIT_DATA__|__NUXT__|__NEXT_DATA__|window\.__/.test(html),
      looksLikeLogin: /login\.1688\.com|passport/i.test(html),
    };
  }

  // GM_xmlhttpRequest 不受 CORS 限制，且會帶上目標網域的登入 cookie。
  // 這是本腳本能跨子網域抓 detail.1688.com 的關鍵（一般 fetch 會被擋）。
  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('GM_xmlhttpRequest 不可用，請確認腳本標頭含 @grant GM_xmlhttpRequest 並重新安裝'));
        return;
      }
      GM_xmlhttpRequest({
        method: opts.method || 'GET',
        url: opts.url,
        headers: opts.headers || {},
        data: opts.data,
        timeout: 30000,
        onload: r => resolve({ status: r.status, text: r.responseText, finalUrl: r.finalUrl }),
        onerror: () => reject(new Error('連線失敗')),
        ontimeout: () => reject(new Error('逾時')),
      });
    });
  }

  // 解析短網址：GM_xmlhttpRequest 會跟隨轉址並回報最終網址；
  // 若最終網址仍非商品頁（例如中間有落地頁），再從回應內容找 1688/淘寶連結。
  async function resolveShortLink(shortUrl) {
    const res = await gmRequest({ url: shortUrl, headers: { 'Accept': 'text/html' } });
    const candidates = [res.finalUrl || ''];
    const m = (res.text || '').match(/https?:\/\/(?:detail\.1688\.com\/offer\/\d+\.html|item\.taobao\.com[^"'\s]*|detail\.tmall\.com[^"'\s]*)/i);
    if (m) candidates.push(m[0]);

    for (const c of candidates) {
      const offer = (c.match(/detail\.1688\.com\/offer\/(\d+)\.html/) || [])[1];
      if (offer) return { shortUrl, offerId: offer, finalUrl: c, platform: '1688' };
    }
    const other = candidates.find(c => /taobao|tmall/i.test(c));
    if (other) return { shortUrl, offerId: null, finalUrl: other, platform: /tmall/i.test(other) ? '天貓' : '淘寶' };
    return { shortUrl, offerId: null, finalUrl: res.finalUrl || '', platform: '未知' };
  }

  async function fetchOffer(offerId) {
    // 同源請求，自動帶登入 cookie
    const url = `https://detail.1688.com/offer/${offerId}.html`;
    const res = await gmRequest({
      url,
      headers: {
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': 'https://www.1688.com/',
      },
    });
    if (res.status !== 200) throw new Error('HTTP ' + res.status);
    const html = res.text;
    if (/login\.1688\.com|滑动验证|安全验证|请输入验证码/i.test(html)) {
      throw new Error('被要求登入或出現驗證，請先在瀏覽器完成驗證再重試');
    }
    const { title, skus, rawKeys } = extractSkus(html);
    if (!skus.length) {
      const e = new Error('頁面解析不到 SKU');
      e.diagnostic = rawKeys;
      throw e;
    }
    return { offerId, title, url, skus, fetchedAt: new Date().toISOString() };
  }

  async function api(path, options) {
    const res = await gmRequest({
      url: API + path,
      method: (options && options.method) || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'X-Quote-Token': localStorage.getItem(TOKEN_KEY) || '',
      },
      data: options && options.body,
    });
    let data = {};
    try { data = JSON.parse(res.text); } catch (e) { /* 非 JSON 時保留空物件 */ }
    if (res.status < 200 || res.status >= 300) throw new Error(data.error || `HTTP ${res.status}`);
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
    const failedDiag = {};
    let okCount = 0;
    for (const id of ids) {
      try {
        const data = await fetchOffer(id);
        offers[id] = data;
        okCount++;
        log(`✓ ${id}　${data.skus.length} 個 SKU　${data.title.slice(0, 18)}`, '#080');
      } catch (e) {
        log(`✗ ${id}　${e.message}`, '#c00');
        if (e.diagnostic) {
          log('   線索：' + JSON.stringify(e.diagnostic).slice(0, 300), '#888');
          failedDiag[id] = e.diagnostic;
        }
      }
      // 放慢速度避免觸發風控
      await new Promise(r => setTimeout(r, 1200 + Math.random() * 800));
    }

    if (Object.keys(failedDiag).length) {
      window.__didiboxFailedDiag = failedDiag;
      log('解析失敗的診斷資料已存於 window.__didiboxFailedDiag，可複製回報', '#c60');
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

    // 先解析短網址，把其中的 1688 商品併入待抓清單
    const extra = [];
    if (TARGET_SHORT_LINKS.length) {
      log('解析 ' + TARGET_SHORT_LINKS.length + ' 個短網址…', '#0284c7');
      const stat = { '1688': 0, '淘寶': 0, '天貓': 0, '未知': 0, '失敗': 0 };
      for (const su of TARGET_SHORT_LINKS) {
        try {
          const r = await resolveShortLink(su);
          stat[r.platform] = (stat[r.platform] || 0) + 1;
          if (r.offerId) { extra.push(r.offerId); log('  ' + su.slice(-8) + ' → 1688 ' + r.offerId, '#080'); }
          else log('  ' + su.slice(-8) + ' → ' + r.platform, '#888');
        } catch (e) { stat['失敗']++; log('  ' + su.slice(-8) + ' → 解析失敗：' + e.message, '#c60'); }
        await new Promise(r => setTimeout(r, 700 + Math.random() * 500));
      }
      log('短網址解析完成：1688 ' + stat['1688'] + '　淘寶/天貓 ' + (stat['淘寶'] + stat['天貓'])
          + '　未知 ' + stat['未知'] + '　失敗 ' + stat['失敗'], '#0284c7');
    }

    const allTargets = [...new Set([...TARGET_OFFERS, ...extra])];
    const todo = allTargets.filter(id => !done.has(id));
    if (!todo.length) { log('全部都抓過了，無需處理', '#080'); return; }
    log('待抓取 ' + todo.length + ' / ' + allTargets.length + ' 個', '#0284c7');
    $('dbx-ids').value = todo.join('\n');
    $('dbx-run').click();
  };

  log('就緒：內建 ' + TARGET_OFFERS.length + ' 個 offer、' + TARGET_SHORT_LINKS.length + ' 個短網址待解析');
})();
