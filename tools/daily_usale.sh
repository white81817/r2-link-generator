#!/bin/bash
# 每天跑一次：同一份 USALE 商品列表，兩個用途。
#
#   read -s QUOTE_TOKEN && export QUOTE_TOKEN     # 共用商品庫通行碼
#   read -s PERF_TOKEN  && export PERF_TOKEN      # 老闆通行碼（只有 1/10/20 需要）
#   ./daily_usale.sh <商品列表.xlsx>
#
# 庫存同步每天跑；績效快照只在每月 1／10／20 號跑，其餘日期自動略過。
set -euo pipefail

FILE="${1:-}"
[ -z "$FILE" ] && { echo "用法：$0 <商品列表.xlsx>"; exit 1; }
[ -f "$FILE" ] || { echo "找不到檔案：$FILE"; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
SNAPSHOT="${SNAPSHOT_SCRIPT:-/Volumes/home/Drive/績效計算new/技能與腳本/snapshot_stock.py}"

echo "=== 1/2 共用商品庫：同步庫存與銷售模式 ==="
python3 "$HERE/sync_stock.py" "$FILE"

DAY=$(date +%d)
case "$DAY" in
  01|10|20)
    echo
    echo "=== 2/2 績效儀表板：庫存快照（今天是 $DAY 號）==="
    if [ -f "$SNAPSHOT" ]; then
      python3 "$SNAPSHOT" "$FILE"
    else
      echo "找不到 snapshot_stock.py：$SNAPSHOT"
      echo "（用 SNAPSHOT_SCRIPT 環境變數指定正確路徑）"
    fi
    ;;
  *)
    echo
    echo "=== 2/2 績效快照：今天是 $DAY 號，只有 1／10／20 才跑，略過 ==="
    ;;
esac
