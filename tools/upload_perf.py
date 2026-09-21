"""
月報上傳：把 calc_script.py 算好的結果送進 didibox 的 KV，績效儀表板才看得到。

每個月跑一次，接在月報計算後面。只需要 calc_script.py 的輸出資料夾。

用法：
    export PERF_TOKEN='老闆通行碼'
    python3 upload_perf.py <out_dir> --month 2026-08 --dry   # 只算不上傳，先看數字
    python3 upload_perf.py <out_dir> --month 2026-08

<out_dir> 就是跑 calc_script.py 時指定的那個資料夾，裡面要有
margin_multi.pkl / prod_pm.pkl / return_loss.pkl / ad_gw_alloc.json。

與另外兩支腳本的分工（三者寫進 KV 的是不同東西，不會互相覆蓋）：
  · snapshot_stock.py → perf:data.snapshots   每天跑，庫存快照（呆貨／長庫齡）
  · sync_stock.py     → product:*             每天跑，共用商品庫的庫存與銷售模式
  · upload_perf.py    → perf:data.months      每月跑，業績／貢獻毛利／毛利率／明細清單

庫存數字的處理：
儀表板的呆貨、長庫齡、滯銷率一律優先採用 snapshot_stock.py 的每日快照，
本腳本送的 inv/invx/dead/aged/slowrate 只是「該期間完全沒有快照時」的退路。
所以庫存金額這裡跟 snapshot_stock.py 用同一套算法（批價要乘匯率），
否則沒快照時總庫存會比呆貨還小。
"""
import os, sys, json, argparse, urllib.request, urllib.error
import pandas as pd, numpy as np, warnings
warnings.filterwarnings('ignore')

API = 'https://didibox-api.adam-061.workers.dev/api/performance'
PMS = ['Peter', 'Yuki', 'Kai', 'Patty']
RMB_RATE, KRW_RATE = 4.741, 0.023   # 與 calc_script.py / snapshot_stock.py 保持一致
AGE_TH = 60                          # 長庫齡門檻（天）
COVER_N, COVER_C = 90, 180           # 庫存覆蓋天數門檻：一般／訂製
LIST_LIMIT = 400                     # 每個清單最多送幾筆（KV 單鍵有大小限制）

ap = argparse.ArgumentParser()
ap.add_argument('out_dir', help='calc_script.py 的輸出資料夾')
ap.add_argument('--month', required=True, help='毛利月份，格式 YYYY-MM，例如 2026-08')
ap.add_argument('--dry', action='store_true', help='只印出要送的內容，不上傳')
ap.add_argument('--save-json', metavar='FILE',
                help='把要送的內容存成 JSON 檔（不上傳）。之後可用 curl --data-binary @FILE 送，'
                     '那台機器就不需要裝 pandas')
args = ap.parse_args()

if not __import__('re').match(r'^\d{4}-\d{2}$', args.month):
    raise SystemExit(f'--month 格式要是 YYYY-MM，收到：{args.month}')

need = ['margin_multi.pkl', 'prod_pm.pkl', 'return_loss.pkl', 'ad_gw_alloc.json']
miss = [f for f in need if not os.path.exists(os.path.join(args.out_dir, f))]
if miss:
    raise SystemExit(f'{args.out_dir} 裡缺少：{", ".join(miss)}\n請先跑 calc_script.py')

calc_df = pd.read_pickle(os.path.join(args.out_dir, 'margin_multi.pkl'))
prod_pm = pd.read_pickle(os.path.join(args.out_dir, 'prod_pm.pkl'))
ret_df = pd.read_pickle(os.path.join(args.out_dir, 'return_loss.pkl'))
with open(os.path.join(args.out_dir, 'ad_gw_alloc.json'), encoding='utf-8') as f:
    ad_gw_alloc = json.load(f)['alloc']


# ── 庫存：與 snapshot_stock.py 同一套算法（批價 × 匯率 × 庫存量）────────────
def num(col):
    """先移除千分位逗號再轉數字（在庫天數超過 1000 會帶逗號）"""
    return pd.to_numeric(col.astype(str).str.replace(',', '', regex=False).str.strip(),
                         errors='coerce').fillna(0)


p = prod_pm.copy()
p['inv_qty'] = num(p['實際庫存(可用庫存+配貨)'])
p['age'] = num(p['平均在庫天數'])
p['s30'] = num(p['30日銷售數'])
p['pv'] = num(p['廠商批價'])
p = p[p['inv_qty'] > 0].copy()

fx = p['廠商類型'].map({'台灣廠商': 1.0, '韓國廠商': KRW_RATE}).fillna(RMB_RATE)
p['成本值'] = p['pv'] * fx * p['inv_qty']
p['cov'] = np.where(p['s30'] > 0, p['inv_qty'] / (p['s30'] / 30), np.inf)
p['訂製'] = p['訂製'].fillna(False).astype(bool)
p['過季轉換品'] = p['過季轉換品'].fillna(False).astype(bool)
p['滯銷'] = ((p['age'] > AGE_TH)
             & (p['cov'] > np.where(p['訂製'], COVER_C, COVER_N))
             & (~p['過季轉換品']))
p['長庫齡'] = p['age'] > AGE_TH


def f0(x):
    """統一四捨五入成整數，NaN/Inf 轉成 None，避免 JSON 出現 NaN"""
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return None if not np.isfinite(v) else round(v)


def f3(x):
    try:
        v = float(x)
    except (TypeError, ValueError):
        return None
    return None if not np.isfinite(v) else round(v, 4)


months = {}
rows = {}
for pm in PMS:
    sub = calc_df[calc_df['PM'] == pm]
    rev = sub['總售價'].sum()
    gm = (sub['貢獻毛利'] * sub['銷售量']).sum()          # 未扣官網廣告／退貨
    cogs = (sub['商品成本'] * sub['銷售量']).sum()
    ad_gw = ad_gw_alloc.get(pm, 0)
    ret = ret_df[ret_df['PM'] == pm]['退貨損失成本'].sum() if len(ret_df) else 0
    final = gm - ad_gw - ret

    s = p[p['PM'] == pm]
    sx = s[~s['過季轉換品']]                              # 滯銷率的計算範圍排除過季轉換品
    inv = sx['成本值'].sum() + s[s['過季轉換品']]['成本值'].sum()
    invx = sx['成本值'].sum()
    dead = sx[sx['滯銷']]['成本值'].sum()
    aged = s[s['長庫齡']]['成本值'].sum()
    qj = s[s['過季轉換品']]['成本值'].sum()

    # ── 明細清單：儀表板的三個分頁（毛利／呆貨／長庫齡）────────────────
    g = (sub.assign(_rev=sub['總售價'],
                    _gm=sub['貢獻毛利'] * sub['銷售量'],
                    _qty=sub['銷售量'])
            .groupby(['商品編號', '商品名稱', '樣式', '尺寸', '通路'], dropna=False)
            .agg(qty=('_qty', 'sum'), rev=('_rev', 'sum'), gm=('_gm', 'sum'))
            .reset_index()
            .sort_values('rev', ascending=False)
            .head(LIST_LIMIT))
    margin_list = [{
        'code': str(r['商品編號']), 'name': str(r['商品名稱']),
        'style': '' if pd.isna(r['樣式']) else str(r['樣式']),
        'size': '' if pd.isna(r['尺寸']) else str(r['尺寸']),
        'ch': str(r['通路']), 'qty': f0(r['qty']),
        'rev': f0(r['rev']), 'gm': f0(r['gm']),
        'rate': f3(r['gm'] / r['rev']) if r['rev'] else None,
    } for _, r in g.iterrows()]

    def inv_list(df):
        df = df.sort_values('成本值', ascending=False).head(LIST_LIMIT)
        return [{
            'code': str(r['商品編號']), 'name': str(r['商品名稱']),
            'style': '' if pd.isna(r['樣式']) else str(r['樣式']),
            'size': '' if pd.isna(r['尺寸']) else str(r['尺寸']),
            'days': f0(r['age']), 'inv': f0(r['inv_qty']), 'cost': f0(r['成本值']),
            'cover': f0(r['cov']),          # 無限大（30 天無銷量）會變成 None，前端顯示「無銷量」
            'dead': bool(r['滯銷']), 'qj': bool(r['過季轉換品']), 'custom': bool(r['訂製']),
        } for _, r in df.iterrows()]

    rows[pm] = {
        'rev': f0(rev), 'final': f0(final), 'rate': f3(final / rev) if rev else None,
        'cogs': f0(cogs), 'adgw': f0(ad_gw), 'ret': f0(ret),
        'gm': f0(gm), 'qty': f0(sub['銷售量'].sum()),
        # 庫存：僅在該期間沒有任何每日快照時才會被儀表板採用
        'inv': f0(inv), 'invx': f0(invx), 'dead': f0(dead), 'old': f0(aged),
        'qj': f0(qj), 'alive': f0(invx - dead),
        'slowrate': f3(dead / invx) if invx else None,
        'lists': {'margin': margin_list,
                  'dead': inv_list(sx[sx['滯銷']]),
                  'aged': inv_list(s[s['長庫齡']])},
    }

months[args.month] = rows

print(f'毛利月份：{args.month}')
print(f"{'PM':7}{'業績':>13}{'最終貢獻毛利':>15}{'毛利率':>9}{'官網廣告':>11}{'滯銷率':>9}")
for pm in PMS:
    r = rows[pm]
    rate = '—' if r['rate'] is None else f"{r['rate']:.1%}"
    slow = '—' if r['slowrate'] is None else f"{r['slowrate']:.1%}"
    print(f"{pm:7}{r['rev']:>13,}{r['final']:>15,}{rate:>9}{r['adgw']:>11,}{slow:>9}")

payload = {'months': months, 'age_th': AGE_TH,
           'generated': pd.Timestamp.now().strftime('%Y-%m-%d %H:%M')}
size = len(json.dumps(payload, ensure_ascii=False).encode('utf-8'))
print(f'\n封包大小：{size / 1024:.0f} KB'
      f"（明細清單每個 PM 各 {LIST_LIMIT} 筆上限）")

if args.save_json:
    with open(args.save_json, 'w', encoding='utf-8') as f:
        # allow_nan=False：JSON 不能有 NaN/Infinity，Worker 端的 JSON.parse 會直接失敗
        json.dump(payload, f, ensure_ascii=False, allow_nan=False)
    print(f'\n已存檔：{args.save_json}')
    print('在有網路的機器上這樣送（不需要 pandas）：')
    print('    read -s PERF_TOKEN && export PERF_TOKEN')
    print(f'    curl -X POST {API} \\\n'
          '      -H "Content-Type: application/json" \\\n'
          '      -H "X-Perf-Token: $PERF_TOKEN" \\\n'
          '      -H "Origin: https://didibox.cc" \\\n'
          '      -A "Mozilla/5.0" \\\n'
          f'      --data-binary @{args.save_json}')
    raise SystemExit(0)

if args.dry:
    print('\n(--dry 未上傳)')
    raise SystemExit(0)

token = os.environ.get('PERF_TOKEN', '').strip()
if not token:
    raise SystemExit('\n請先設定環境變數 PERF_TOKEN（老闆通行碼）：\n'
                     "    read -s PERF_TOKEN && export PERF_TOKEN")

req = urllib.request.Request(
    API, method='POST',
    data=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
    headers={
        'Content-Type': 'application/json',
        'X-Perf-Token': token,
        # Cloudflare 會擋 Python 預設 UA（403 code 1010），必須偽裝成瀏覽器
        'User-Agent': ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) '
                       'AppleWebKit/537.36 (KHTML, like Gecko) '
                       'Chrome/126.0.0.0 Safari/537.36'),
        'Accept': 'application/json',
        'Origin': 'https://didibox.cc',
    },
)
try:
    with urllib.request.urlopen(req, timeout=60) as r:
        print('\n上傳成功：', json.loads(r.read().decode()))
        print('打開儀表板，月份選', args.month, '就看得到了。')
except urllib.error.HTTPError as e:
    body = e.read().decode()[:300]
    if e.code == 401:
        raise SystemExit(f'\n上傳失敗 401：{body}\n'
                         'POST /api/performance 需要「老闆通行碼」，PM 個人通行碼沒有寫入權限。')
    raise SystemExit(f'\n上傳失敗 {e.code}：{body}')
