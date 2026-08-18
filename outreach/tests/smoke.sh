#!/usr/bin/env bash
# 关键路径冒烟。**"语法过 + import 过"不算回归** ——
# 曾经有 6 个 state.py 函数被整段替换时误删,语法和 import 都照样通过,
# NameError 只在真正调用到那一行时才炸。这个脚本把每条公开路径真的执行一遍。
#
#   bash outreach/tests/smoke.sh
#
# 不需要网络、不需要真 key;全部写在临时目录,不碰工作区。
set -uo pipefail
cd "$(dirname "$0")/.."
D="$(mktemp -d)"; trap 'rm -rf "$D"' EXIT
export OUTREACH_STATE_DIR="$D" OUTREACH_MY_SITE="$D/my_site.json" LLM_CONFIG="$D/llm.json"
fail=0

echo "── 语法 ──"
for f in *.mjs; do node --check "$f" || fail=1; done
python3 -c "
import ast,glob,sys
for f in glob.glob('*.py')+glob.glob('tests/*.py'):
    try: ast.parse(open(f).read())
    except SyntaxError as e: print('SyntaxError', f, e); sys.exit(1)" || fail=1
echo "   ok"

echo "── Python 关键路径 ──"
python3 tests/smoke_py.py || fail=1

echo "── Node 关键路径 ──"
node tests/smoke_js.mjs || fail=1

echo "── 配置解析 py/js 对拍 ──"
python3 tests/test_llm_config_parity.py | tail -1 || fail=1

echo "── 并发认领(12 进程,必须恰好 1 个成功)──"
CD="$D/conc"; mkdir -p "$CD"
START=$(python3 -c "import time;print(time.time()+3)")
for i in $(seq 1 12); do
  (OUTREACH_STATE_DIR="$CD" node -e "const s=$START;(async()=>{const d=await import('./state.mjs');
    while(Date.now()/1000<s){};try{if(d.claimDelivery({domain:'race.com',source:'n'}).claimed)console.log('C')}
    catch(e){console.log('E')}})();" >> "$CD/o.txt" 2>&1 &)
done
sleep 6
n=$(grep -c '^C$' "$CD/o.txt" || true)
if [ "$n" = "1" ]; then echo "   ok(claimed=1)"; else echo "   ❌ claimed=$n(应为 1)"; fail=1; fi

[ "$fail" = "0" ] && echo && echo "全部通过 ✅" || { echo; echo "有失败 ❌"; exit 1; }
