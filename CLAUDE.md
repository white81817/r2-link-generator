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

目標分三階段，**目前卡在第一階段**：

1. **抓 offer 的 SKU 清單** ← 進行中
2. 料號文字 → skuId 比對（尚未開始）
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

### 下一步

使用者需先執行 v2.2 腳本抓取，取得真實的 SKU 資料後，才能設計第 2 階段的比對邏輯
（規格文字如何對應到 skuId，需要看實際文字格式才能決定用完全比對、正規化比對或模糊比對）。

若抓取仍失敗，需要在能連上 1688 的環境查看實際頁面結構。
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
