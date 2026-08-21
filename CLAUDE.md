# 專案說明（給 Claude Code 的上下文）

單一 HTML 檔的內部工具，部署在 Cloudflare Pages，搭配兩支 Cloudflare Worker。
使用者是台灣的電商團隊，商品同時上架官網（1shop）、momo、蝦皮，向大陸廠商採購。

## 架構

| 位置 | 說明 | 部署方式 |
|---|---|---|
| `index.html` | 全部前端，約 4700 行，六個分頁 | Cloudflare Pages 接 GitHub，推 main 自動部署 |
| `worker-api/` | `didibox-api`：ERP 解析、報價單、共用商品庫、1688 SKU 庫 | Workers Builds 接 GitHub，推 main 自動部署 |
| `worker/` | `label-sticker-worker`：PDF 分享、R2 圖片列表 | 同上（若未設定則需 `npx wrangler deploy`） |
| `tools/1688-sku-grabber.user.js` | Tampermonkey 腳本，抓 1688 SKU | 使用者手動貼進瀏覽器擴充 |

前端六個分頁：連結產生器、標籤產生器、產品建立、刷庫存、訂單編號整理、報價單。
**主要開發集中在「產品建立」**。

## 重要慣例

- **Tailwind 是 2.2.19**，預設調色盤**沒有** orange/sky/teal/amber。
  這些色系已在 `index.html` 開頭的 `<style>` 手動補上，新增顏色前先確認。
- 前端無建置流程，直接改 `index.html`。修改後務必做 script 區塊語法檢查。
- 改完一律推 `main`（Pages/Workers 自動部署），同時推工作分支。
- Worker 的通行碼存於 Cloudflare 的 **Settings → Variables and Secrets**（執行時期那個，
  不是 Build 底下那個）：`QUOTE_PASSWORD`、`QUOTE_ADMIN_PASSWORD`。報價單與共用商品庫共用同一組。
- `worker-api` 有 npm 相依（hono/xlsx/fflate），**不能用 Cloudflare 後台編輯器貼上**，
  只能靠 Workers Builds 或 `wrangler deploy` 打包。
- `/api/health` 有 `version` 欄位，改動 worker 時一併更新，用來確認部署是否生效。

## 成本計算（產品建立）

單一事實來源在 `calcStockCost` / `calcMiscCost` / `calcMargin`。

```
存貨成本  依「大陸/台灣/韓國廠商」與「廠商出貨包運費」標籤分支
          CNY 匯率 4.55、KRW 匯率 0.023
出貨運費包材 = 100 固定（有「集運出客人」標籤則為 0）
活動系統稅金服務費 = 售價 × 12.5%
廣告成本  = 售價 × 25%（蝦皮為 5%）
退貨損失成本 = 廣告成本×0.11 + 12×0.08 + 80×0.03 + 100×0.11
雜項成本 = 出貨運費包材 + 活動系統稅金服務費 + 退貨損失成本
客人負擔費用 = 售價 < 1000 時為 80，否則 0
毛利率 = (售價 + 客人負擔費用 − 存貨成本 − 雜項成本) / (售價 + 客人負擔費用)
```

毛利率燈號只有兩級：官網/momo ≥39% 為 🟢，蝦皮 ≥29% 為 🟢，未達為 🔴。

## 進行中的任務：1688 採購下單

目標分三階段：

1. **抓 offer 的 SKU 清單** ← 已解決（改用 Playwright，見下）
2. 料號文字 → skuId 比對 ← 進行中
3. 加入採購車／產生採購單（尚未開始）

使用者明確表示：**實際送出訂單與付款保持人工**，不做全自動下單。

### 資料現況

商品資料的「廠商料號」欄位是人工記錄，格式為 `規格文字<br>網址`，例如：

```
高2.6米【2根】管粗25mm+收纳袋<br>https://detail.1688.com/offer/933370072634.html?...
```

規格文字是**使用者在 1688 頁面上看到的選項文字，不是 skuId**，所以第 2 階段必須靠文字比對。

料號中的網址分布（共 307 個規格）：

| 網域 | 筆數 | 處理方式 |
|---|---|---|
| detail.1688.com | 99（51 個不重複 offer） | 直接抓 |
| lihi2.com | 87 | 短網址，需先解析 |
| item.taobao.com | 16 | 非 1688，略過 |
| qr.1688.com | 7 | 短網址，需先解析 |
| detail.tmall.com | 2 | 非 1688，略過 |

51 個 offer id 與 31 個短網址已內建於抓取腳本。

### 抓取腳本的演進與教訓

`tools/1688-sku-grabber.user.js` 已改版多次，踩過的坑都在這裡，**修改前務必看過**：

1. **`fetch` 會 Failed to fetch** —— 腳本執行於 `www.1688.com`，目標是 `detail.1688.com`，
   子網域不同即跨來源。必須用 `GM_xmlhttpRequest`。
2. **比對 HTML 文字行不通** —— 1688 商品頁版型多變，固定鍵名的正規表達式只認得部分頁面。
   現行做法是造訪商品頁後讀取頁面 JS 已解析好的物件，與版型無關。
3. **`localStorage` 跨子網域不共用** —— 巡覽時狀態會遺失，必須用 `GM_setValue`/`GM_getValue`。
4. **Tampermonkey 執行於隔離沙箱** —— 直接讀 `window` 看不到 1688 掛載的變數，須用 `unsafeWindow`。
5. **`Object.keys(window)` 有 200+ 個屬性** —— 若對走訪設了鍵數上限，會導致根本沒往下走訪。

### 實際頁面結構（2026-08-18 用 Playwright 實測 634162136992、933370072634）

SKU 資料在商品頁 SSR 就備妥，掛在：

```
window.context.result.data.Root.fields.dataJson.skuModel
  ├ skuProps    規格軸定義：[{ fid, prop:'颜色', value:[{ name, imageUrl }] }]
  ├ skuInfoMap  key = 頁面顯示的規格文字，value = { skuId, specId, price,
  │             discountPrice, canBookCount, saleCount, isPromotionSku }
  └ skuPriceScale
```

同層 `dataJson` 另有 `isSkuOffer`、`isPricePrivate`、
`orderParamModel.orderParam`（起訂量 beginNum、混批 mixParam、skuRangePrices）。

- **不需登入**即可取得完整 skuId 與價格（`isPricePrivate` 為 false 的商品）。
- 頁面沒有 `__INIT_DATA__` 之類的舊全域，只有 `window.context`；找不到時腳本會遞迴掃 window 找 `skuModel`。
- 會跳阿里滑塊驗證（`_____tmd_____` / punish），**這是真的驗證頁，不是誤判**（有截圖存證）。
  **一旦撞上，後續每一筆都會被擋**，必須有人在 Chrome 視窗手動拉滑塊才解除。
  腳本判定被擋時會存 `out/blocked-<offerId>.png` 與 `.html` 供事後確認。
- **登入的效果很明顯**（2026-08-19 實測）：
  匿名時約每 4～5 筆撞一次，跑 51 筆只成功 22 筆；
  先 `--login` 登入後，整輪只在第一筆撞一次，人工拉過之後連抓 26 筆零阻礙。
  **所以正確流程是：先 `--login`，開跑後守著第一次驗證，拉完就可以離開。**
- 人工通過驗證的瞬間頁面會跳轉，輪詢用的 `page.evaluate` 會丟
  `Execution context was destroyed`。那是**成功**的訊號，必須吞掉重試，不能當成失敗。
- 判斷有沒有登入要用 `context.cookies()`（`cookie2`/`unb`/`sgcookie` 是 HttpOnly），
  用 `document.cookie` 會得到假的「未登入」。
- 驗證頁的判斷條件只看**網址特徵**與**頁面上真的有滑塊元件**。
  早期版本拿 `document.body.innerText` 前 500 字比對「安全验证」，正常商品頁也會命中而誤判。
- Playwright 的 `page.waitForFunction(fn, arg, options)`：`timeout` 必須放**第三個**參數。
  放第二個會被當成 `arg`、靜默套用預設 30 秒——這個坑讓「等人工過驗證」實際只等了 30 秒。

### 比對規則的分級階梯（2026-08-22 強化）

由嚴到寬逐級嘗試，**每一級都要求「唯一命中」**，命中方式會回傳並顯示在畫面上：

1. 第一軸完全相同 ／ 2. 整串完全相同  ← 只有這兩級視為可信（黑色顯示）
3. 某一軸完全相同（料號記的可能不是第一軸）
4. 繁簡／符號差異（寬鬆正規化後相同）
5. 開頭相符 ／ 6. 包含
7. 相似度 ≥72% 且明顯勝過第二名（差 ≥8%）—— 差距不夠就寧可不猜

3～7 級在畫面上標橘色，明細面板會寫出是用哪一級對到的。

**繁簡是最常見的落差**：料號是台灣同仁打的繁體，1688 頁面是簡體。
`T2S` 表收了電商規格常見字，沒收到的靠相似度兜底。

用 783 個真實 SKU 做過壓力測試（把規格文字改成繁體、加空白、全形、去符號、缺一字）：
**七種變形全部「對到錯的 SKU」＝ 0**；繁簡／空白／全形／符號的命中率與原樣完全相同。

**真正的瓶頸不是寬鬆度，是資料**：783 個 SKU 裡只有 457 個（58%）能用第一軸唯一決定。
其餘 326 個是**多規格軸商品**（例如第一軸「黑色」，第二軸 S/M/L），
料號只記第一軸時本質上無法決定是哪一筆。這種情況會明確回報
「對到 N 筆（黑色>S、黑色>M…），料號要補上第二個規格」，不會亂猜。

**比對邏輯在 `index.html` 與 `tools/1688-cart-add.mjs` 各有一份，改動時兩邊要一起改。**
Node 那份是從 index.html 原樣搬過去的（函式名去掉 1688 後綴）。

### 第 2 階段的比對規則（已由實測資料確認）

`skuInfoMap` 的 key 在**多規格軸**商品會用 **`&gt;`**（HTML 逸出的 `>`）串接各軸，
例如 `高2.6米【2根】管粗25mm+收纳袋&gt;黑色`；單軸商品則沒有分隔符。
料號欄位記的是**第一軸的文字**，所以比對規則是：

1. 反逸出 `&gt;` `&lt;` `&amp;` `&quot;`
2. 去空白、全形括號轉半形
3. 用 `>` 切段，拿第一段與料號文字做完全比對

實測 `高2.6米【2根】管粗25mm+收纳袋` → skuId `5819443152404`（¥32.80），唯一命中。

### 抓取工具：`tools/1688-sku-fetch.mjs`

取代 Tampermonkey 腳本（user.js 仍留著，但跨網域、沙箱那些坑 Playwright 都沒有）。
offer 與短網址清單仍從 `1688-sku-grabber.user.js` 的 `TARGET_OFFERS` /
`TARGET_SHORT_LINKS` 讀取，維持單一來源。

```bash
cd tools && npm i            # 只裝 playwright，用本機 Chrome（channel: 'chrome'）
node 1688-sku-fetch.mjs --from-userscript    # 抓 51 個 offer → out/1688-sku.ndjson
node 1688-sku-fetch.mjs --resolve-short      # 短網址 → offer id
node 1688-sku-fetch.mjs --login              # 需要登入才顯示價格時，手動登入一次
```

- 用獨立 profile `tools/.chrome-1688`，**不碰使用者本人的 Chrome profile**
  （Chrome 136+ 起也禁止對預設 profile 開遠端偵錯）。
- 輸出 NDJSON、可續跑（已抓過的 offer 會略過），失敗記到 `out/1688-sku-errors.ndjson`。
- `out/`、`node_modules/`、`.chrome-1688/` 已在 `tools/.gitignore`。

### 抓取進度（2026-08-19）

51 個 offer 已完成 22 筆、185 個 SKU，存於 `tools/out/1688-sku.ndjson`。
其餘 29 筆全因滑塊驗證中斷（見上），要有人在旁邊才能續跑：

```bash
cd tools && node 1688-sku-fetch.mjs --from-userscript --delay 4000   # 已抓過的會自動略過
```

價格有兩種模型，已統一成 `unitPrice`（買 1 件的單價）+ `priceSource`：
`sku`（逐 SKU 定價，174 筆）／`range`（階梯價，全品同價，11 筆，價格取自 `skuRangePrices`）。
目前 185 個 SKU 全部都有價格。`beginNum`（起訂量）是後來才加的欄位，前 12 個 offer 是 null。

### 第 2 階段的實作（2026-08-20 完成）

資料流：`tools/out/*.ndjson` → `tools/1688-sku-upload.mjs` → didibox-api 的 KV
→「產品建立」分頁按〔🔍 比對 1688 SKU〕。

- **worker-api**：`/api/1688/skus` 的儲存欄位已擴充，多留 `specId`、`unitPrice`、
  `priceSource`、`canBookCount` 與 offer 層的 `beginNum`、`priceScale`
  （`specId` 第 3 階段加購物車要用）。另存一份短網址對照表在 KV 的
  `sku1688:shortlinks`，POST body 用 `shortLinks: { 短網址: offerId }` 更新，
  GET 全部時一併回傳——料號裡有 87 筆是 lihi2 短網址，前端自己展不開。
- **上傳**：通行碼走環境變數，不要寫進檔案或指令歷史。
  ```bash
  read -s QUOTE_TOKEN && export QUOTE_TOKEN
  node tools/1688-sku-upload.mjs --by 你的名字      # 加 --dry 可先看要送什麼
  ```
- **前端**：規格表在「廠商料號」後面多一欄「1688 SKU」，顯示 skuId 與 ¥單價
  （階梯價會標註）。比對結果存進 variant 的 `sku1688` 欄位，會跟著商品存檔，
  **匯出 ERP 的欄位沒有變動**。比對用 `shareToken`，沿用共用商品庫的連線，不另做登入。
- 比對失敗會逐列列出原因（未收錄、淘寶連結、找不到規格文字、短網址未收錄…），
  不會靜默略過。非完全相同的比對（開頭相符／包含）skuId 會顯示成橘色提醒人工確認。
- 實測 8 種情境（多軸、單軸、階梯價、短網址、淘寶、未收錄 offer、找不到規格、空料號）
  行為都正確；測試腳本的做法見下。

**測試 index.html 的 JS 時的坑**：`let` 宣告的頂層變數（如 `shareToken`）是詞法綁定，
**不掛在 window 上**，`page.evaluate` 裡要用裸賦值 `shareToken = 'x'` 才蓋得到。
另外「產品建立」分頁預設隱藏，要先 `switchTab('product')` 才量得到寬度、截得到圖。

### 第 3 階段：加入進貨車（2026-08-22）

**加入進貨車打的是 MTOP**，已用 `tools/1688-cart-capture.mjs` 側錄真實請求確認：

```
POST https://h5api.m.1688.com/h5/com.alibaba.china.buy.service.purchase.MtopPurchaseService.addCargo/1.0/
data.goodsParams = [{ specId, offerId, quantity, flow:'general', ext:{sceneCode:''} }]
回應 ret = ["SUCCESS::调用成功"]
```

- **goodsParams 是陣列**，整張採購單一次請求就能加完，不必逐頁操作。
- 需要的欄位只有 `specId` + `offerId` + `quantity`，全是第 2 階段已有的資料。
  實測錄到的 specId 與我們 KV 裡存的完全一致。
- `selectedTradeServices` 只在該 offer 有定制服務（如「包装定制」）時出現，一般可省略。
- **簽章不必自己實作**：頁面上有 `window.lib.mtop.request`，在 page.evaluate 裡呼叫它，
  sign 與 cookie 都由網站自己處理。自行實作 mtop sign（`_m_h5_tk` + md5）是沒必要的彎路。
- 側錄腳本的過濾條件要寫 `/addCargo|MtopPurchaseService/`，
  **不能只寫 `/purchase/`**——會被 `repurchase.access`（再次購買）誤中而提早收工。

工具：`tools/1688-cart-add.mjs`，採購單（xlsx/csv）→ 共用商品庫查料號 → 比對 SKU → 加入進貨車。
**預設是試算，要加 `--add` 才會真的動進貨車；送出訂單與付款一律人工。**

```bash
read -s QUOTE_TOKEN && export QUOTE_TOKEN
node tools/1688-cart-add.mjs --file 採購單.xlsx          # 試算
node tools/1688-cart-add.mjs --file 採購單.xlsx --add    # 實際加入
```

採購單欄位：`商品編號`、`樣式`、`尺寸`、`數量`（範本見 `tools/out/採購單範本.csv`）。
比對規則與 `index.html` 是同一套，**改動時兩邊要一起改**。

**已實測成功（2026-08-22）**：一次請求送出 6 個不同商家的 6 個規格，全部加入進貨車。
所以 `goodsParams` 陣列可跨店家批次加入，不必逐店處理。
`attributes`、`fromkv` 這兩個追蹤參數不帶也沒問題。

採購單也可以**直接寫廠商料號**（`廠商料號` 欄，格式同商品資料的 `規格文字<br>網址`），
不必先把商品放進共用商品庫——實際上商品多半只存在瀏覽器的 localStorage，
共用商品庫是空的，一開始假設要查那裡是錯的。

### 免終端機的採購流程（2026-08-22）

**為什麼要拆成兩段**：didibox.cc 是跨網域，瀏覽器不會把 1688 的登入 cookie 送到
`h5api.m.1688.com`，CORS 也不放行，所以 addCargo **不可能**從 didibox 直接打。

```
didibox「🛒 1688 採購」分頁          1688 商品頁（Tampermonkey）
上傳採購單 → 對照 skuId → 試算  ──→  KV: sku1688:cartplan  ──→  讀取計畫 → lib.mtop addCargo
```

- worker：`GET/POST/PUT /api/1688/cart-plan`，KV 鍵 `sku1688:cartplan`。
  PUT 用來標記已加入，避免重複。
- 腳本：`tools/1688-cart-adder.user.js`，只跑在 `detail.1688.com/offer/*`。
  用 `unsafeWindow.lib.mtop`（沙箱看不到頁面變數）與 `GM_xmlhttpRequest`（跨網域）。
  通行碼存在 `GM_setValue`，401 時自動清掉重問。
- 前端採購單可用 `廠商料號` 指定，或 `商品編號＋樣式＋尺寸` 從 **localStorage 的
  `productDB_v2`** 帶出——商品多半只存在本機，共用商品庫是空的。

**CSV 編碼的坑（Node 與瀏覽器都中過）**：`XLSX.read(buffer/arrayBuffer)` 讀 CSV 會
當成 latin1，中文表頭變亂碼、整張表讀不到任何欄位。副檔名是 csv 就要先用 UTF-8
讀成字串再 `XLSX.read(str, {type:'string'})`。xlsx 走 buffer 沒問題。

### 下一步

1. ~~抓完剩下 30 個 offer~~ 已完成：目前 **78 個 offer、783 個 SKU**，
   價格與 specId 都 100% 完整。只有 2 個抓不到，是**商品已下架**
   （`665866303228`、`580557461880`），那兩筆料號要換供應商連結。
2. 若要「完全不用終端機」：didibox 上傳採購單 → 存計畫到 KV → Tampermonkey 腳本在
   1688 頁面上一鍵加入。可行關鍵是 worker 的 CORS 白名單已含 `https://detail.1688.com`；
   最後那步無法在 didibox.cc 直接做，因為跨網域拿不到 1688 的登入 cookie。
3. ~~用 ¥單價 × 4.55 對照「廠商批價」標出成本過期~~ —— **使用者明確表示不需要**：
   廠商批價是廠商另外給的談定價，不是 1688 的標價，兩者本來就不會一致，比對沒有意義。

**雲端 session 連不到 1688（出口政策封鎖），本機 session 才有辦法。**

## 開發注意事項

- 修改 `index.html` 後的語法檢查：
  ```bash
  node --input-type=module -e "
  import fs from 'fs';
  const h=fs.readFileSync('index.html','utf8');
  const s=[...h.matchAll(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]);
  let ok=true; s.forEach((x,i)=>{try{new Function(x);}catch(e){ok=false;console.log('#'+i,e.message);}});
  console.log(ok?'語法 OK':'FAILED');"
  ```
- 規格表改欄位時，記得 `<th>` 與 `addVariantRow` 的 `<td>` 數量要一致，否則整張表會錯位。
- 用 Playwright 實測時，`page.route` 是**後註冊優先**，萬用路由會蓋掉特定路由。
