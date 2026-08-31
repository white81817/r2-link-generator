#!/bin/bash
# 每天跑一次：一份 USALE 商品列表，餵給兩個系統。
#
#   ./daily_usale.sh <商品列表.xlsx>
#   ./daily_usale.sh                    # 不給檔名時自動挑 WATCH_DIR 裡最新的
#
# 通行碼放在 ~/.didibox_env（chmod 600），不要寫進 crontab：
#   export QUOTE_TOKEN='共用商品庫通行碼'
#   export PERF_TOKEN='老闆通行碼'
#
# 兩支腳本刻意分開跑而且互不影響——其中一支掛掉不該讓另一支不跑。

HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="${DIDIBOX_ENV:-$HOME/.didibox_env}"
SNAPSHOT="${SNAPSHOT_SCRIPT:-/Volumes/home/Drive/績效計算new/技能與腳本/snapshot_stock.py}"
WATCH_DIR="${WATCH_DIR:-$HOME/Downloads}"
LOG_DIR="${LOG_DIR:-$HOME/didibox-logs}"

[ -f "$ENV_FILE" ] && . "$ENV_FILE"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/$(date +%Y-%m-%d).log"
exec > >(tee -a "$LOG") 2>&1

echo "════════ $(date '+%Y-%m-%d %H:%M:%S') ════════"

FILE="${1:-}"
if [ -z "$FILE" ]; then
  # 沒指定就挑最新的一份，檔名關鍵字可用 FILE_PATTERN 覆寫
  FILE=$(ls -t "$WATCH_DIR"/*${FILE_PATTERN:-商品列表}*.xlsx 2>/dev/null | head -1)
  [ -n "$FILE" ] && echo "自動選檔：$FILE"
fi
if [ -z "$FILE" ] || [ ! -f "$FILE" ]; then
  echo "✗ 找不到商品列表。給檔名，或把檔案放進 $WATCH_DIR"
  exit 1
fi

# 檔案太舊多半是今天的下載沒成功，拿舊資料去覆蓋庫存比不跑更糟。
# GNU 用 -c %Y、BSD/macOS 用 -f %m；順序不能顛倒——Linux 的 stat -f 是
# 「檔案系統資訊」，會成功回傳一堆無關的東西，fallback 就永遠不會觸發。
MTIME=$(stat -c %Y "$FILE" 2>/dev/null || stat -f %m "$FILE" 2>/dev/null)
if [ -n "$MTIME" ]; then
  AGE_H=$(( ( $(date +%s) - MTIME ) / 3600 ))
  echo "檔案：$(basename "$FILE")（${AGE_H} 小時前）"
  if [ "$AGE_H" -gt "${MAX_AGE_HOURS:-24}" ]; then
    echo "✗ 檔案超過 ${MAX_AGE_HOURS:-24} 小時，可能是今天沒抓成功，中止"
    echo "  真的要用舊檔請加 MAX_AGE_HOURS=9999"
    exit 1
  fi
else
  echo "檔案：$(basename "$FILE")（無法判斷時間）"
fi

FAIL=0

echo
echo "──── 1/2 共用商品庫：庫存與銷售模式 ────"
if python3 "$HERE/sync_stock.py" "$FILE"; then
  echo "✓ 完成"
else
  echo "✗ 失敗"; FAIL=1
fi

echo
echo "──── 2/2 績效儀表板：庫存快照 ────"
if [ ! -f "$SNAPSHOT" ]; then
  echo "✗ 找不到 snapshot_stock.py：$SNAPSHOT（用 SNAPSHOT_SCRIPT 指定路徑）"
  FAIL=1
elif python3 "$SNAPSHOT" "$FILE"; then
  echo "✓ 完成"
else
  echo "✗ 失敗"; FAIL=1
fi

echo
[ "$FAIL" -eq 0 ] && echo "════════ 全部完成 ════════" || echo "════════ 有步驟失敗，看上面 ════════"
echo "log：$LOG"
exit "$FAIL"
