// ==UserScript==
// @name         1688 SKU 抓取器 → didibox
// @namespace    https://didibox.cc/
// @version      2.2.0
// @description  逐頁造訪 1688 商品頁，直接讀取頁面自身已解析的 SKU 資料（不依賴 HTML 版型），批次上傳至 didibox-api
// @match        https://*.1688.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
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
  const K = {
    token: 'didibox_token',
    user:  'didibox_user',
    queue: 'dbx_queue',      // 待造訪的 offerId
    result:'dbx_result',     // 已抓到的資料
    active:'dbx_active',     // 是否在自動巡覽中
    home:  'dbx_home',       // 巡覽結束後要回到的頁面
    log:   'dbx_log',        // 跨頁保留的日誌
  };

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

  // www.1688.com 與 detail.1688.com 屬不同來源，localStorage 並不共用，
  // 巡覽跨子網域時狀態會遺失，故改用 Tampermonkey 的跨來源儲存。
  const hasGM = typeof GM_setValue === 'function' && typeof GM_getValue === 'function';
  const ls = {
    get: (k, d) => {
      try {
        const raw = hasGM ? GM_getValue(k, null) : localStorage.getItem(k);
        return raw === null || raw === undefined ? d : (JSON.parse(raw) ?? d);
      } catch (e) { return d; }
    },
    set: (k, v) => {
      const raw = JSON.stringify(v);
      if (hasGM) GM_setValue(k, raw); else localStorage.setItem(k, raw);
    },
    del: (k) => {
      if (hasGM && typeof GM_deleteValue === 'function') GM_deleteValue(k); else localStorage.removeItem(k);
    },
  };

  // ── 通訊 ────────────────────────────────────────────────────────────────
  function gmRequest(opts) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') { reject(new Error('GM_xmlhttpRequest 不可用')); return; }
      GM_xmlhttpRequest({
        method: opts.method || 'GET', url: opts.url, headers: opts.headers || {}, data: opts.data, timeout: 30000,
        onload: r => resolve({ status: r.status, text: r.responseText, finalUrl: r.finalUrl }),
        onerror: () => reject(new Error('連線失敗')),
        ontimeout: () => reject(new Error('逾時')),
      });
    });
  }

  async function api(path, options) {
    const res = await gmRequest({
      url: API + path,
      method: (options && options.method) || 'GET',
      headers: { 'Content-Type': 'application/json', 'X-Quote-Token': ls.get(K.token, '') || '' },
      data: options && options.body,
    });
    let data = {};
    try { data = JSON.parse(res.text); } catch (e) { /* 非 JSON */ }
    if (res.status < 200 || res.status >= 300) throw new Error(data.error || ('HTTP ' + res.status));
    return data;
  }

  // ── 從「目前這個頁面」讀取 SKU ──────────────────────────────────────────
  // 關鍵改變：不再比對 HTML 文字，而是讀取頁面自身 JS 已經解析好的物件。
  // 1688 不論用哪種版型，執行後都會把商品資料放進 window 底下，故版型無關。
  function scanForSkus() {
    const hits = [];
    const seen = new Set();

    const consider = (v, keyName) => {
      if (!v || typeof v !== 'object') return;
      const skuId = v.skuId ?? v.specId;
      if (skuId === undefined || skuId === null || skuId === '') return;
      const id = String(skuId);
      if (seen.has(id)) return;
      seen.add(id);

      let spec = v.specAttrs ?? v.specText ?? v.skuAttr ?? v.attributes ?? v.name ?? keyName ?? '';
      if (spec && typeof spec === 'object') {
        spec = Array.isArray(spec) ? spec.map(x => x && (x.value ?? x.name ?? x.text) || '').filter(Boolean).join(' ')
                                   : JSON.stringify(spec);
      }
      let price = v.price ?? v.discountPrice ?? v.currentPrice ?? v.sellPrice ?? null;
      if (price && typeof price === 'object') price = price.price ?? price.value ?? null;

      hits.push({
        skuId: id,
        specText: String(spec || '').slice(0, 200),
        price: price ?? null,
        stock: v.canBookCount ?? v.amountOnSale ?? v.saleCount ?? v.stock ?? v.quantity ?? null,
      });
    };

    // Tampermonkey 腳本執行於隔離沙箱，其 window 並非頁面真正的 window，
    // 必須透過 unsafeWindow 才讀得到 1688 自己掛上去的商品資料。
    const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;

    // 廣度優先走訪，限制深度與節點數，避免在大型頁面上卡住
    const visited = new WeakSet();
    const queue = [{ o: W, d: 0, key: '' }];
    let steps = 0;
    while (queue.length && steps < 60000) {
      const { o, d, key } = queue.shift();
      steps++;
      if (!o || typeof o !== 'object' || d > 7) continue;
      if (visited.has(o)) continue;
      visited.add(o);

      consider(o, key);

      let keys;
      try { keys = Object.keys(o); } catch (e) { continue; }
      // window 本身就有數百個屬性，故僅對深層的巨大物件套用上限
      if (d > 0 && keys.length > 800) continue;
      for (const k of keys) {
        if (/^(window|self|top|parent|opener|document|frames|location|history|navigator)$/.test(k)) continue;
        let v;
        try { v = o[k]; } catch (e) { continue; }      // getter 可能拋錯
        if (v && typeof v === 'object' && !(v instanceof Node)) queue.push({ o: v, d: d + 1, key: k });
      }
    }
    return hits;
  }

  function pageTitle() {
    const t = (document.title || '').replace(/[-_].*(阿里巴巴|1688).*/, '').trim();
    return t.slice(0, 200);
  }

  function currentOfferId() {
    const m = location.href.match(/\/offer\/(\d+)\.html/);
    return m ? m[1] : '';
  }

  // ── 短網址解析 ──────────────────────────────────────────────────────────
  async function resolveShortLink(shortUrl) {
    const res = await gmRequest({ url: shortUrl, headers: { Accept: 'text/html' } });
    const cands = [res.finalUrl || ''];
    const m = (res.text || '').match(/https?:\/\/(?:detail\.1688\.com\/offer\/\d+\.html|item\.taobao\.com[^"'\s]*|detail\.tmall\.com[^"'\s]*)/i);
    if (m) cands.push(m[0]);
    for (const c of cands) {
      const offer = (c.match(/detail\.1688\.com\/offer\/(\d+)\.html/) || [])[1];
      if (offer) return { offerId: offer, platform: '1688' };
    }
    const other = cands.find(c => /taobao|tmall/i.test(c));
    return { offerId: null, platform: other ? (/tmall/i.test(other) ? '天貓' : '淘寶') : '未知' };
  }

  // ── 介面 ────────────────────────────────────────────────────────────────
  const bubble = document.createElement('div');
  bubble.textContent = 'SKU';
  bubble.title = 'didibox SKU 抓取器';
  bubble.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483000;width:46px;height:46px;border-radius:50%;'
    + 'background:#0284c7;color:#fff;font:bold 13px/46px sans-serif;text-align:center;cursor:pointer;'
    + 'box-shadow:0 2px 10px rgba(0,0,0,.3);user-select:none';
  document.body.appendChild(bubble);

  const panel = document.createElement('div');
  panel.style.cssText = 'position:fixed;right:16px;bottom:70px;z-index:2147483000;background:#fff;border:1px solid #d0d0d0;'
    + 'border-radius:10px;box-shadow:0 4px 16px rgba(0,0,0,.18);font:13px/1.6 sans-serif;width:340px;overflow:hidden;display:none';
  panel.innerHTML = `
    <div id="dbx-head" style="background:#0284c7;color:#fff;padding:8px 12px;font-weight:bold;display:flex;justify-content:space-between;cursor:move">
      <span>didibox SKU 抓取器 v2</span><span id="dbx-min" style="cursor:pointer;padding:0 4px">✕</span>
    </div>
    <div id="dbx-body" style="padding:12px">
      <input id="dbx-token" type="password" placeholder="didibox 通行碼" style="width:100%;padding:5px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box;margin-bottom:6px">
      <input id="dbx-user" type="text" placeholder="你的名字" style="width:100%;padding:5px;border:1px solid #ccc;border-radius:4px;box-sizing:border-box;margin-bottom:8px">
      <button id="dbx-start" style="width:100%;padding:8px;border:0;background:#16a34a;color:#fff;border-radius:4px;cursor:pointer;font-weight:bold;margin-bottom:6px">⚡ 開始自動巡覽抓取</button>
      <div style="display:flex;gap:6px;margin-bottom:8px">
        <button id="dbx-here" style="flex:1;padding:6px;border:1px solid #ccc;background:#f5f5f5;border-radius:4px;cursor:pointer">只抓這頁</button>
        <button id="dbx-stop" style="flex:1;padding:6px;border:1px solid #e5a;background:#fee;border-radius:4px;cursor:pointer">停止</button>
      </div>
      <div id="dbx-log" style="max-height:200px;overflow:auto;background:#f8f8f8;border-radius:4px;padding:6px;font-size:12px;color:#444"></div>
    </div>`;
  document.body.appendChild(panel);

  const $ = id => panel.querySelector('#' + id);
  function log(msg, color) {
    const arr = ls.get(K.log, []);
    arr.push({ msg, color });
    ls.set(K.log, arr.slice(-200));
    renderLog();
  }
  function renderLog() {
    const box = $('dbx-log');
    box.innerHTML = '';
    ls.get(K.log, []).forEach(({ msg, color }) => {
      const d = document.createElement('div');
      if (color) d.style.color = color;
      d.textContent = msg;
      box.appendChild(d);
    });
    box.scrollTop = box.scrollHeight;
  }

  $('dbx-token').value = ls.get(K.token, '') || '';
  $('dbx-user').value  = ls.get(K.user, '');
  bubble.onclick = () => { panel.style.display = 'block'; bubble.style.display = 'none'; renderLog(); };
  $('dbx-min').onclick = () => { panel.style.display = 'none'; bubble.style.display = 'block'; };

  (() => {
    const head = $('dbx-head');
    let sx = 0, sy = 0, ox = 0, oy = 0, drag = false;
    head.addEventListener('mousedown', e => {
      if (e.target.id === 'dbx-min') return;
      drag = true;
      const r = panel.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      panel.style.right = 'auto'; panel.style.bottom = 'auto';
      panel.style.left = ox + 'px'; panel.style.top = oy + 'px';
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!drag) return;
      panel.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
      panel.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
    });
    document.addEventListener('mouseup', () => { drag = false; });
  })();

  // ── 自動巡覽 ────────────────────────────────────────────────────────────
  function saveCurrentPage() {
    const id = currentOfferId();
    if (!id) return null;
    const skus = scanForSkus();
    if (!skus.length) return { id, skus: [], title: pageTitle() };
    const results = ls.get(K.result, {});
    results[id] = { offerId: id, title: pageTitle(), url: location.href.split('?')[0], skus, fetchedAt: new Date().toISOString() };
    ls.set(K.result, results);
    return { id, skus, title: pageTitle() };
  }

  async function finishAndUpload() {
    ls.set(K.active, false);
    const results = ls.get(K.result, {});
    const n = Object.keys(results).length;
    if (!n) { log('沒有抓到任何資料', '#c00'); return; }
    log('巡覽完成，上傳 ' + n + ' 個 offer…', '#0284c7');
    try {
      const r = await api('/api/1688/skus', {
        method: 'POST',
        body: JSON.stringify({ offers: results, uploadedBy: ls.get(K.user, '') || '' }),
      });
      log('已上傳 ' + r.saved + ' 個，資料庫共 ' + r.total + ' 個', '#080');
      ls.del(K.result);
    } catch (e) {
      log('上傳失敗（資料仍保留，可稍後重試）：' + e.message, '#c00');
    }
  }

  function goNext() {
    const queue = ls.get(K.queue, []);
    if (!queue.length) { finishAndUpload(); return; }
    const next = queue.shift();
    ls.set(K.queue, queue);
    log('前往 ' + next + '（剩 ' + queue.length + '）');
    // 稍作停頓再換頁，降低觸發風控的機率
    setTimeout(() => { location.href = 'https://detail.1688.com/offer/' + next + '.html'; }, 1500 + Math.random() * 1000);
  }

  // 進到商品頁時，若正在巡覽就自動抓取並前往下一個
  if (ls.get(K.active, false) && currentOfferId()) {
    setTimeout(() => {
      const r = saveCurrentPage();
      if (r && r.skus.length) log('✓ ' + r.id + '　' + r.skus.length + ' 個 SKU　' + r.title.slice(0, 16), '#080');
      else log('✗ ' + r.id + '　這頁讀不到 SKU', '#c00');
      goNext();
    }, 2500);   // 等頁面自身的 JS 把資料準備好
  }

  $('dbx-start').onclick = async () => {
    const token = $('dbx-token').value.trim();
    if (!token) { log('請先輸入 didibox 通行碼', '#c00'); return; }
    ls.set(K.token, token);
    ls.set(K.user, $('dbx-user').value.trim());
    ls.set(K.log, []);
    ls.set(K.home, location.href);

    let done = new Set();
    try {
      const r = await api('/api/1688/skus');
      done = new Set(Object.keys(r.offers || {}));
      log('資料庫已有 ' + done.size + ' 個 offer');
    } catch (e) { log('查詢已抓取清單失敗：' + e.message, '#c60'); }

    const extra = [];
    if (TARGET_SHORT_LINKS.length) {
      log('解析 ' + TARGET_SHORT_LINKS.length + ' 個短網址…', '#0284c7');
      for (const su of TARGET_SHORT_LINKS) {
        try {
          const r = await resolveShortLink(su);
          if (r.offerId) { extra.push(r.offerId); log('  ' + su.slice(-8) + ' → 1688 ' + r.offerId, '#080'); }
          else log('  ' + su.slice(-8) + ' → ' + r.platform + '（略過）', '#888');
        } catch (e) { log('  ' + su.slice(-8) + ' → 失敗：' + e.message, '#c60'); }
        await new Promise(r => setTimeout(r, 600 + Math.random() * 400));
      }
    }

    const all = [...new Set([...TARGET_OFFERS, ...extra])].filter(id => !done.has(id));
    if (!all.length) { log('全部都抓過了', '#080'); return; }
    ls.set(K.queue, all);
    ls.set(K.result, {});
    ls.set(K.active, true);
    log('開始巡覽 ' + all.length + ' 個商品頁，過程中請勿關閉分頁', '#0284c7');
    goNext();
  };

  $('dbx-here').onclick = () => {
    const r = saveCurrentPage();
    if (!r) { log('目前不是商品頁', '#c00'); return; }
    if (!r.skus.length) { log('這頁讀不到 SKU', '#c00'); return; }
    log('✓ ' + r.id + '　' + r.skus.length + ' 個 SKU', '#080');
    log(JSON.stringify(r.skus.slice(0, 3)), '#888');
  };

  $('dbx-stop').onclick = () => {
    ls.set(K.active, false);
    ls.del(K.queue);
    log('已停止。已抓到的資料仍保留，可按開始重新續抓。', '#c60');
  };

  if (!ls.get(K.active, false)) {
    log('就緒：' + TARGET_OFFERS.length + ' 個 offer、' + TARGET_SHORT_LINKS.length + ' 個短網址');
  }
})();
