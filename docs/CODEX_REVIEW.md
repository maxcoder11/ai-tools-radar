# 评审交接

评审对象:`main` 分支,提交范围 `e71a13b..HEAD`。**工作区干净,改动都已提交。**

## 时间线

| 轮次 | 谁 | 结果 |
|---|---|---|
| R1 | Claude 自审 | 全仓 review,修 26 条 |
| R2 | Codex 一审 | 判定**不建议合并**:5 P1 + 10 P2 + 1 条既存风险。**全对** |
| R3 | Claude | 按 R2 清单全修 + 逐条实测 |
| R4 | Codex 二审 | 判定"P1 全部已修"**不成立**:6 个新 P1 + 10 条其他。**又是全对** |
| R5 | Claude | 按 R4 清单全修 + 逐条实测 ← **本文档写的是这之后的状态** |

R4 的六条 P1 里,**4 条是 R3 的修复本身引入的、或只修了一半**。连续两轮被找出
"修了一半",这个模式值得下一轮继续按 §9 的两个问题扫。

---

## 1. R4(二审)的 P1 —— 已修

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| 1 | `configure.py` | **空 base_url 绕过换供应商检查**(`and new_base` 直接短路)→ 写进空 base → `load()` 回落默认 OpenAI → 旧供应商的 key 发过去 | 空 base 直接拒;origin 比较改为复用 `llm_config.origin_of`,全仓一份实现 |
| 2 | `mail_sweeper.py` | endpoint/model 启动冻结、**key 首次请求才重载** → 运行中切配置会把 B 的 key 发给 A。**agent_submit 修过这个坑,这边没跟上** | 三者一次性同时冻结,只用启动那一刻的 `_LLM` |
| 3 | `llm_config.py/.mjs` | ① `LLM_ALLOW_SPLIT_CONFIG` 放行时**反向**把 base 覆盖成低优先级单元的地址;② `"0"`/`"false"` 也会开启这个安全阀 | 真布尔解析(`1/true/yes/on`);放行只是"别报错",仍用 winner 自己的 base |
| 4 | `state.mjs` / `state.py` | **只给 `claimDelivery` 加了锁**,其他状态写仍无锁 → 无锁的 `blocked` 插到认领行之后把 `delivery_ambiguous` 顶掉 → 下次认领又 `claimed=true` → **重复 POST** | `upsertSubmission` 也整段进锁;**Node 与 Python 共用同一把锁文件**;陈旧接管改成 token 化的"rename 偷"(原来直接 unlink 有接管竞态);锁前先建目录(新 `OUTREACH_STATE_DIR` 首用会 ENOENT) |
| 5 | `verify_link.mjs` | 注释说"只有 404/410 才是不在",实现把 **400/401/408/451 全当 notFound** → 120 个 401 的桩测也能判 `offline_confirmed`,三次写成 failed | 改白名单:只有 404/410 算"站方说没有这个页",其余一律"我们没看着" |
| 6 | `driver.py` | 查询键 canon 了,**历史账本行没有** → 升级前老 driver 写的 `www.Example.com/success` 用 `example.com` 查不到 → 重新投递 | `load_state` 同时按原样和 canon 建索引,canon 侧优先 |

### 其他 10 条(全部已修)

- `state.mjs` 成本账本:**带换行的完整坏末行**被当半截容忍;`amount_usd: null` 按 0 计
  → 改为只在"文件不以换行结尾"时容忍末行,null/缺字段直接抛
- `capsolver.mjs`:只配 2Captcha 撞上 CapSolver 独有任务(整页 CF 挑战)时,
  状态写 `manual` 却**没建人工任务** → 补幂等入队
- `verify_link.mjs` 预筛:40s 预算**每次调用各自重置**(两轮 = 80s)→ 改整域共享截止时刻;
  `mapLimit` 的 `NaN` → **0 个 worker,候选被静默丢弃**、`Infinity` → 恢复 120 并发
  → 加边界钳制(1..32,非法回落 6);全 403 时误报 `unknown_network` 且写"网络错误 0 次"
  → 分开归因为 `unknown_blocked`
- `mail_sweeper.py`:`CREDS_JSON` 硬读默认路径、无视 `OUTREACH_MY_SITE`
  → 界面显示保存成功但收信端看不到。统一走 `llm_config.MY_SITE`
- `mail_sweeper.py`:超 TTL 邮件**转人工失败仍从队列删除** → 磁盘异常会丢信。改为留在表里下轮重试
- `configure.py`:初始配置出错时 `/api/state` 返回 `{error}`,前端仍解引用 `s.llm` → 白屏
  → 先显示错误与修复指引
- `llm_config`:py 用 `netloc`、js 用 `host`,**默认端口/主机大小写/IPv6 三种都判定相反**
  → 统一 `origin_of` / `originOf`(scheme+host+port,全部小写、默认端口显式补齐、IPv6 去括号),
  并补 5 组对拍用例
- 文档口径:CSV 统计统一为**全量 1,360 文件 = 354 个字段**
  (此前 54 / 77 是 300 文件抽样,且早期漏算 `-`,三个数说的是同一件事)

### 关键验证

```
跨语言并发(6 node 认领 + 6 py 写 blocked,忙等栅栏对齐,同时刻打同一域):
    claimed=true 1 次 / 12    投达态未被顶掉    零报错    零残留锁
    (修前:10 个纯 node 进程有 7 个都 claimed=true)

origin 归一化 py/js 对拍:主机大小写 / 显式默认端口 / 非默认端口 / IPv6 / 缺省 —— 5 组全一致
成本账本:完整坏末行→抛   null 金额→抛   真半截(无尾换行)→容忍
历史 raw 键 www.Example.com/success + worklist 里 example.com → 不重投
OUTREACH_MY_SITE 生效 → sweeper 与 configure 读同一个文件
配置解析对拍:33 用例 0 不一致(含歧义拒绝、split 开关边界、origin 归一化)
```

---

## 2. R2(一审)的 P1 —— 已修

1. **LLM key 与 endpoint 没有原子绑定(5 条路径)**。根因是优先级做成了**按字段各自降级**,
   base 与 key 可以来自不同来源 → "A 供应商的 key 发给 B 供应商的地址"。
   改成**按来源单元整体绑定**:选第一个带 key 的单元,base 取它自己的;
   别的单元指了不同 origin 的 base → **直接抛错不猜**(`LLM_ALLOW_SPLIT_CONFIG` 可放行)。
   另外:跨 origin 302 摘 Authorization、`configure` 比整个 origin 而非 netloc、
   agent 的 key 与 endpoint 同时刻冻结。
2. **WAF/限流页被判死**:`inspect` 原来 `>=400` 一律 `notFound`,而调用方紧接着置
   `sawAnyPage=true`。已按语义拆开(R4 又把白名单收得更严,见 §1 第 5 条)。
3. **预筛并发与看门狗撞线**:R1 把 120 并发改成 6 → 最坏 `ceil(120/6)×9s = 180s`,
   正好等于单域看门狗。改成并发 10 + 单请求 6s + 整段 40s 墙钟预算。
4. **成本账本仍未 fail-closed**(R4 又补了两个边界)。
5. **预检只测主模型** → 按 `llm_judge` 的真实行为遍历降级链。

## 3. R2 的 P2 —— 已修

`esc()` 的 `&#39;` 无效(HTML 属性值在内联 handler 编译成 JS **之前**就已实体解码,
真浏览器 PoC 可执行注入)→ 改 `data-*` + 事件委托,内联 handler 里一个不可信值都不放;
driver 回读键、2Captcha+CF 转人工、OTP 右边界含 `.`、park 超时不丢件、
看门狗 `process.exit` 前同步杀浏览器、`LLM_CONFIG` 空串/相对路径归一、
密钥文件权限告警、单域 JSON 版本化。

既存风险 **`claimDelivery` 无锁**也一并修了(R4 指出锁覆盖不全,见 §1 第 4 条)。

---

## 4. 请重点看这几处(我最不确定的)

### 4.1 锁现在护住了整条状态写路径 ★

R5 把 `upsertSubmission`(Node + Python 两侧)都放进了锁。这是本轮**改动面最大**的地方:

- 所有状态写现在都要拿锁,**热路径上多了一次文件锁开销**;账本本来就是全文件扫描,
  叠加之后 `--loop` 长跑的表现没有实测过
- 锁等待 8s 超时会抛 `RuntimeError`/`Error`。**这条异常路径在各调用方的归属我仍没有
  端到端验证** —— 它会走 `e.ledger`(exit 43,域留池不烧)还是落到通用 catch 记 blocked?
- Python 侧 `with_file_lock` 与 Node 侧 `withFileLock` 是两份实现、共用一把锁文件。
  **它们的陈旧接管窗口(30s)和等待超时(8s)必须一致**,现在是手工对齐的,没有对拍

### 4.2 同源绑定的"拒绝"是行为破坏性变更

一类**以前能跑**的配置现在直接报错,例如环境里有 `OPENAI_API_KEY`(给别的工具用)
+ `llm.json` 指了自定义 endpoint。我认为拒绝优于猜(那正是 P1 的根因),
但请判断:默认拒绝 + 逃生阀,还是默认放行 + 响亮告警?

### 4.3 `verify_link` 判死门槛已叠三层收紧

`sawAnyPage`(R3)+ 403/429/5xx 不计证据(R3)+ 只有 404/410 算不在(R5)。
方向是"判死门槛应高于判活",但**我始终没有真实域名样本验证分布变化** ——
可能过严,导致真掉链的站永远攒不够 3 次 `offline_confirmed`。这条最好用真实数据跑一轮。

### 4.4 `configure.py` 仍是最高风险面

**四轮里三次在这个文件出问题**(R2 前自查一条凭据外泄、R2 两条、R4 一条)。
请假定还有第五条。当前边界:

- token 在 URL query(进浏览器历史)
- `/api/test` 的闸是"origin 相同才用已存 key";**用户当场填的 key 仍会发给任意地址**
  (设计如此:那是他自己敲的)。这个边界对不对?
- `_write()` 的 tmp 窗口、`save()` 异常路径下的字段保留

### 4.5 看门狗强退时的 `SIGKILL`

`killBrowserSync()` 用 `browser.process()` 拿 pid 再 SIGKILL,CDP 模式不登记
(连的是用户自己的浏览器)。请核:非 CDP 下 `browser.process()` 是否总可用、pid 是否可能已回收。

---

## 5. 这些是有意为之,别当 bug "修"

- **`mail_sweeper` 不给 `json_object` 做自由文本降级** —— 它驱动不可逆动作
  (写状态、点一次性验证链接),改成启动预检实探。`agent_submit` 有降级是对的
  (它 `JSON.parse` 失败只是跳过一步)。
- **`bet` 放过 `betplentia.com`** —— 为救回 8 个正常域的取舍,`casino|slot` 仍在。
- **配置界面不在 `index.html`** —— 那是要发 GitHub Pages 的公开静态站。
- **`upsert`/`queueForHuman` 里的撞锁重试**在 JSONL 版本来是死代码(SQLite 时代残留);
  **但 R5 之后账本真的会因锁超时抛错了** —— 见 §4.1,这段重试的错误匹配 `/locked|busy/`
  与新错误信息("账本锁等待超时")是否对得上,需要核。
- **`dbwpy.py` 对 `outreach_log` 主动抛** 是设计好的降级。
- **`alerts` / `mail_ws` 不在仓里**,已在 `outreach/README.md` 如实交代。

---

## 6. 一处已自我更正的结论,别继承错前提

R1 我判断前端打字卡顿的瓶颈是 `LINKS_IDX.includes()`(15k × 1360 线性扫)。
**A/B 实测证伪**:354ms → 363ms 在噪声内。分段:

```
① 过滤+排序 0ms  ② 拼 HTML 21ms  ③ innerHTML 建 DOM 327ms ←全在这  ④ 绑 onclick 5ms
```

Set 那个改动留着了(数据结构本来就该是 Set),但**不解决卡顿**。真修是 140ms 输入防抖
(连打 5 键:5 次全表重渲 → 1 次)。彻底解法是分页/虚拟化,**没做**。

---

## 7. 仍未修的(知情不做)

- **告警出口缺失**:`alerts` 模块不在仓里 → "QQ 信箱读到 0 封"这类事件只进日志。
- **账本全文件扫描 + 无压实路径**:`currentStatus`/`foldHumanTasks`/`spentToday`/
  `mail_done_since`(每秒轮询)全都重读整个 JSONL。**R5 加锁之后每次写还多一次锁开销**,
  `--loop` 跑几个月的表现没实测。
- **`scripts/` 硬编码绝对路径** `/Users/wy/cafe/toolradar`(与本仓名不同)。
- **Node 侧不认 `http_proxy`**(Python 侧认)→ 远端端点两边出网路径可能不同;
  本机端点已一致。
- **前端分页/虚拟化**。
- **`my_site.example.json` 缺 `agentmail` webhook 块**(`hook_events_moved` 读它)。

---

## 8. 复核入口(不需要真 key / 不需要网络)

```bash
python3 outreach/tests/test_llm_config_parity.py   # 33 用例:歧义拒绝 / split 开关 / origin 归一化
python3 outreach/llm_config.py                     # 当前解析结果(key 只显掩码)
for f in outreach/*.mjs; do node --check $f; done
python3 -m compileall -q outreach scripts
python3 outreach/configure.py --port 8790 --no-open  # 请攻它
```

数据侧断言(对 `data/` 真实文件统计,重跑即核):

```bash
python3 - <<'EOF'
import json, glob
files=[f for f in glob.glob('data/links/*.json') if not f.endswith('index.json')]
rows=[len(json.load(open(f))) for f in files]
print(f"域={len(files)} 最大行数={max(rows)} 总行数={sum(rows)}")   # 1360 / 100 / 135230
n=0
for f in files:
    for r in json.load(open(f)):
        for k in ('a','s'):
            v=str(r.get(k) or '').strip()
            if v and (v[0] in '=+@\t\r' or (v[0]=='-' and not v[1:2].isdigit())): n+=1
print("公式字符开头的字段:", n)                                      # 全量 354
EOF
```

并发相关的验证需要真并发,单进程跑不出来 —— 用忙等栅栏对齐开跑时刻:

```bash
D=/tmp/race; rm -rf $D; mkdir -p $D
START=$(python3 -c "import time;print(time.time()+3)")
for i in $(seq 1 6); do
  (OUTREACH_STATE_DIR=$D node -e "const s=$START;(async()=>{const d=await import('./outreach/state.mjs');
    while(Date.now()/1000<s){};const r=d.claimDelivery({domain:'race.com',source:'n'});
    if(r.claimed)console.log('CLAIMED');})();" >> $D/out.txt 2>&1 &)
done
sleep 6; grep -c CLAIMED $D/out.txt      # 必须是 1
```

---

## 9. 评审时值得带着的两个问题

四轮 findings 高度集中在这两个形状:

**1. "这条防御的执行路径真的到得了吗?"**

- R1:fail-closed 是空的 / 计划算了没人用 / meta 没人传 / 降级通道够不着
- R2:`sawAnyPage` 守卫被 `notFound` 绕过 / `finally` 被 `process.exit` 跳过 /
  `&#39;` 被 HTML 解码绕过
- R4:换供应商检查被空 base_url 短路 / `bool("0")` 让安全阀恒开 /
  锁只护了一个写入口

**2. "同一个坑在别处修过吗?"**

- R1:`:871` 修过 `:2042` 没跟上 / `:830` 做对了 `locate` 没有 /
  `save_state` 硬化过 `park_save` 没有 / `creds.mjs` 加锁了 `saveRecipe` 没有
- R2:`pick_batch` 修了 `:210` 没跟上 / `saveRecipe` 加锁了 `claimDelivery` 没有
- R4:`agent_submit` 的 key 冻结修了 `mail_sweeper` 没跟上 /
  `claimDelivery` 加锁了 `upsertSubmission` 没有 /
  `configure._origin` 与 `llm_config._origin` 各写一份且不一致
