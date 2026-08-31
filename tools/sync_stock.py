"""
每天把 USALE 商品列表的「可用庫存」與「銷售模式」同步到共用商品庫。

只更新這兩個欄位，售價、標籤、圖片、複合商品一律不動——ERP 沒有那些資料，
全量覆蓋會把同仁在 didibox 調好的東西殺掉。

用法：
    read -s QUOTE_TOKEN && export QUOTE_TOKEN
    python3 sync_stock.py <商品列表.xlsx>
    python3 sync_stock.py <商品列表.xlsx> --dry      # 只解析不上傳，先看欄位對不對

跟 snapshot_stock.py 的關係：
    兩支讀同一份商品列表，但用途、通行碼、頻率都不同，所以分開跑：
      snapshot_stock.py  每月 1/10/20  PERF_TOKEN   → 績效儀表板的庫存快照
      sync_stock.py      每天          QUOTE_TOKEN  → 共用商品庫的庫存與銷售模式
"""
import os, sys, json, urllib.request, urllib.error

API = 'https://didibox-api.adam-061.workers.dev/api/products/sync-stock'
BATCH = 2000
VALID_MODES = {'可追', '售完', '下架'}

# 欄位名稱按優先序比對，USALE 的匯出欄位名稱不完全固定
COL_BARCODE = ['品項條碼', '條碼']
COL_STOCK   = ['可用庫存', '實際庫存(可用庫存+配貨)', '實際庫存', '庫存量', '現貨庫存']
COL_MODE    = ['銷售模式']

args = [a for a in sys.argv[1:] if not a.startswith('--')]
dry = '--dry' in sys.argv
if not args:
    raise SystemExit(__doc__)

path = args[0]
if not os.path.exists(path):
    raise SystemExit(f'找不到商品列表：{path}')

import pandas as pd, warnings
warnings.filterwarnings('ignore')

df = pd.read_excel(path)
cols = [str(c).strip() for c in df.columns]


def pick(cands, label):
    """先找完全相同，再找開頭相符——USALE 有些欄位後面帶括號說明"""
    for want in cands:
        for c in cols:
            if c == want:
                return c
    for want in cands:
        for c in cols:
            if c.startswith(want):
                return c
    raise SystemExit(f'找不到「{label}」欄位。試過：{"、".join(cands)}\n'
                     f'這份檔案的欄位有：\n  ' + '\n  '.join(cols))


c_bar = pick(COL_BARCODE, '品項條碼')
c_stk = pick(COL_STOCK, '可用庫存')
c_mod = pick(COL_MODE, '銷售模式')
print(f'來源：{os.path.basename(path)}（{len(df)} 列）')
print(f'欄位對應：品項條碼 ← {c_bar}｜可用庫存 ← {c_stk}｜銷售模式 ← {c_mod}\n')


def num(v):
    """在庫天數／庫存超過 1000 會帶千分位逗號"""
    s = str(v).replace(',', '').strip()
    if s in ('', 'nan', 'None'):
        return None
    try:
        return int(float(s))
    except ValueError:
        return None


items, skipped_mode, no_barcode = [], [], 0
for _, r in df.iterrows():
    barcode = str(r[c_bar]).strip()
    if not barcode or barcode.lower() == 'nan':
        no_barcode += 1
        continue
    mode = str(r[c_mod]).strip()
    if mode in ('nan', 'None'):
        mode = ''
    if mode and mode not in VALID_MODES:
        skipped_mode.append(f'{barcode}：{mode}')
        mode = ''
    items.append({'barcode': barcode, 'stock': num(r[c_stk]), 'salesMode': mode})

print(f'可送出 {len(items)} 筆'
      + (f'，{no_barcode} 列沒有品項條碼已略過' if no_barcode else ''))
if skipped_mode:
    print(f'⚠ {len(skipped_mode)} 筆的銷售模式不是可追／售完／下架，該欄不送：'
          + '、'.join(skipped_mode[:5]) + ('…' if len(skipped_mode) > 5 else ''))
for it in items[:3]:
    print('  範例：', it)

if dry:
    print('\n(--dry 未上傳)')
    raise SystemExit(0)
if not items:
    raise SystemExit('\n沒有可送出的資料')

token = os.environ.get('QUOTE_TOKEN', '').strip()
if not token:
    raise SystemExit('\n請先設定環境變數 QUOTE_TOKEN（共用商品庫通行碼）')

total = {'received': 0, 'changedProducts': 0, 'changedVariants': 0}
not_found = []
for i in range(0, len(items), BATCH):
    chunk = items[i:i + BATCH]
    req = urllib.request.Request(
        API, method='POST',
        data=json.dumps({'items': chunk, 'updatedBy': 'ERP 同步'},
                        ensure_ascii=False).encode('utf-8'),
        headers={
            'Content-Type': 'application/json',
            'X-Quote-Token': token,
            # Cloudflare 會擋 Python 預設 UA（403 code 1010），必須偽裝成瀏覽器
            'User-Agent': ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                           'AppleWebKit/537.36 (KHTML, like Gecko) '
                           'Chrome/126.0.0.0 Safari/537.36'),
            'Accept': 'application/json',
            'Origin': 'https://didibox.cc',
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            d = json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        raise SystemExit(f'\n上傳失敗 {e.code}：{e.read().decode()[:300]}')
    for k in total:
        total[k] += d.get(k, 0)
    not_found += d.get('notFound', [])
    print(f'  第 {i // BATCH + 1} 批 {len(chunk)} 筆 → 變動 {d.get("changedVariants", 0)} 個欄位')

print(f'\n同步完成：讀到 {total["received"]} 筆，'
      f'實際變動 {total["changedProducts"]} 個商品、{total["changedVariants"]} 個欄位')
if not_found:
    print(f'共用庫找不到的品項條碼 {len(not_found)} 筆（ERP 有但這裡還沒建的新品，正常）：')
    print('  ' + '、'.join(not_found[:10]) + ('…' if len(not_found) > 10 else ''))
