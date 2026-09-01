#!/bin/sh
# 一把跑完两套自测（零依赖，不需要联网、不需要企业微信凭证）：
#   sh tests/run.sh              跑全部
#   sh tests/run.sh py           只跑 Python（抓取规整化 + 增量合并 + HTTP 接口）
#   sh tests/run.sh js           只跑指标层（Node 直接加载 web/js 源码）
set -e
cd "$(dirname "$0")/.."
part="${1:-all}"
fail=0

if [ "$part" = "all" ] || [ "$part" = "py" ]; then
  echo "== Python：抓取规整化 / 增量合并 / HTTP 接口 =="
  python3 -m unittest discover -s tests -t tests -p 'test_*.py' || fail=1
fi

if [ "$part" = "all" ] || [ "$part" = "js" ]; then
  echo
  echo "== Node：指标层口径与图表数据 =="
  if command -v node >/dev/null 2>&1; then
    node tests/test_metrics.js || fail=1
    node tests/test_policy_v2.js || fail=1
    node tests/test_charts_smoke.js || fail=1
    node tests/test_map_effects.js || fail=1
  else
    echo "  失败：未安装 node（不能把未运行的指标测试当通过）"
    fail=1
  fi
fi

echo
if [ "$fail" = "0" ]; then echo "全部自测通过 ✅"; else echo "有自测失败 ❌"; fi
exit $fail
