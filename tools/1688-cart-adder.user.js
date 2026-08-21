// ==UserScript==
// @name         didibox → 1688 加入進貨車
// @namespace    didibox
// @version      1.0
// @description  讀取 didibox 送來的採購計畫，在 1688 頁面上一鍵加入進貨車。下單與付款仍為人工。
// @match        https://detail.1688.com/offer/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      didibox-api.adam-061.workers.dev
// ==/UserScript==

/* 為什麼需要這支腳本：
 * didibox.cc 是跨網域，拿不到 1688 的登入 cookie，所以 addCargo 不能從那邊打。
 * 這支腳本跑在 1688 自己的頁面上，直接用頁面的 lib.mtop 送出，簽章與 cookie 都由網站處理。
 *
 * 踩過的坑（見 CLAUDE.md）：
 *  - Tampermonkey 在隔離沙箱裡，要用 unsafeWindow 才看得到 1688 掛的 lib.mtop
 *  - 跨網域請求要用 GM_xmlhttpRequest，不能用 fetch
 */
(function () {
  'use strict';

  const API = 'https://didibox-api.adam-061.workers.dev';
  const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  const req = (method, path, body) => new Promise((resolve, reject) => {
    const token = GM_getValue('quoteToken', '');
    GM_xmlhttpRequest({
      method, url: API + path,
      headers: { 'Content-Type': 'application/json', 'X-Quote-Token': token },
      data: body ? JSON.stringify(body) : undefined,
      onload: (r) => {
        let data = {};
        try { data = JSON.parse(r.responseText); } catch {}
        r.status >= 200 && r.status < 300 ? resolve(data) : reject(new Error(data.error || `HTTP ${r.status}`));
      },
      onerror: () => reject(new Error('連線失敗')),
    });
  });

  function box() {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:99999;background:#fff;border:1px solid #f97316;'
      + 'border-radius:8px;padding:12px 14px;box-shadow:0 4px 16px rgba(0,0,0,.15);font-size:13px;max-width:320px;'
      + 'font-family:-apple-system,BlinkMacSystemFont,"PingFang TC",sans-serif';
    document.body.appendChild(el);
    return el;
  }

  async function main() {
    if (!GM_getValue('quoteToken', '')) {
      const pw = prompt('第一次使用：請輸入 didibox 共用商品庫的通行碼');
      if (!pw) return;
      GM_setValue('quoteToken', pw.trim());
    }

    let plan;
    try {
      plan = await req('GET', '/api/1688/cart-plan');
    } catch (e) {
      if (/未授權/.test(e.message)) GM_setValue('quoteToken', '');   // 通行碼錯了就清掉，下次重問
      return;
    }
    if (!plan || !plan.items || !plan.items.length) return;          // 沒有待處理的計畫就安靜退場

    const el = box();
    const total = plan.items.reduce((a, x) => a + x.quantity, 0);
    const done = plan.consumedAt;
    el.innerHTML = `
      <div style="font-weight:600;margin-bottom:6px">didibox 採購計畫</div>
      <div style="color:#666;margin-bottom:8px">${plan.items.length} 個規格、共 ${total} 件${
        done ? '<br><span style="color:#ea580c">⚠ 這份計畫已加入過一次</span>' : ''}</div>
      <button id="dbx-add" style="background:#f97316;color:#fff;border:0;border-radius:5px;padding:6px 14px;cursor:pointer">
        加入進貨車（${plan.items.length}）</button>
      <button id="dbx-close" style="background:none;border:0;color:#999;cursor:pointer;margin-left:6px">關閉</button>
      <div id="dbx-msg" style="margin-top:8px;color:#666"></div>`;

    el.querySelector('#dbx-close').onclick = () => el.remove();
    el.querySelector('#dbx-add').onclick = async () => {
      const msg = el.querySelector('#dbx-msg');
      const btn = el.querySelector('#dbx-add');
      btn.disabled = true;
      msg.textContent = '加入中…';

      if (!W.lib || !W.lib.mtop) { msg.innerHTML = '<span style="color:#dc2626">頁面還沒載入 lib.mtop，請重整後再試</span>'; btn.disabled = false; return; }

      const goods = plan.items.map((x) => ({
        specId: x.specId, offerId: Number(x.offerId), quantity: x.quantity,
        flow: 'general', ext: { sceneCode: '' },
      }));

      try {
        const res = await W.lib.mtop.request({
          api: 'com.alibaba.china.buy.service.purchase.MtopPurchaseService.addCargo',
          v: '1.0', type: 'POST', dataType: 'originaljson',
          data: { client: 'pc', goodsParams: JSON.stringify(goods), purchaseType: '' },
        });
        const ok = /SUCCESS/i.test((res && res.ret && res.ret[0]) || '');
        msg.innerHTML = ok
          ? '<span style="color:#16a34a">✓ 已加入進貨車</span>　<a href="https://cart.1688.com" target="_blank">去結帳</a>'
          : `<span style="color:#dc2626">✗ ${(res && res.ret && res.ret[0]) || '失敗'}</span>`;
        await req('PUT', '/api/1688/cart-plan', { result: ok ? 'success' : JSON.stringify(res && res.ret) }).catch(() => {});
      } catch (e) {
        msg.innerHTML = `<span style="color:#dc2626">✗ ${e.message || e}</span>`;
        btn.disabled = false;
      }
    };
  }

  // 頁面資料是 SSR 的，但 lib.mtop 要等腳本載完
  setTimeout(main, 3000);
})();
