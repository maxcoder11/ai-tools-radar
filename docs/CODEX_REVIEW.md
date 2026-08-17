# 评审交接(第 2 轮)

工作区**未提交**。评审对象 = `git diff` + 新增文件。

## 时间线

1. **R1**:Claude 全仓 review,修 26 条。
2. **R2**:Codex 独立复审(read-only),判定**不建议合并**,给出 5 个 P1 + 10 个 P2 +
   1 条既存上线级风险。**逐条复核下来基本全对,没有可辩的。**
3. **R3(本轮)**:按 Codex 清单全部修掉并各自实测。这份文档写的是 R3 之后的状态。

---

## 1. R2 的 P1 —— 全部已修,附复现与验证

### P1-1 LLM key 与 endpoint 没有原子绑定(5 条路径)

根因是我把优先级做成了**按字段各自降级**,于是 base 与 key 可以来自不同来源 ——
"A 供应商的 key 发给 B 供应商的地址"。已改成**按来源单元整体绑定**:

- 单元优先级:`LLM_BASE_URL`+`LLM_API_KEY` > `LLM_ENDPOINT`+`LLM_KEY`(旧名)
  > `OPENAI_BASE_URL`+`OPENAI_API_KEY` > `llm.json` > `my_site.json` 旧字段
- 选中**第一个带 key 的单元**,base 取它自己的;
- 别的单元指了**不同 origin** 的 base → **直接抛错,不猜**
  (`LLM_ALLOW_SPLIT_CONFIG=1` 可放行,自担风险)

| 子项 | 修法 | 验证 |
|---|---|---|
| 切 Base URL、key 留空仍留旧供应商 key | `save()` 拒绝:换 endpoint 必须重填 key | 实测返回 `换了 endpoint(provider-a → provider-b)就必须重填 API Key` |
| base/key 按字段独立降级 | 来源单元整体绑定 + 歧义即拒 | 对拍 25 用例,4 个歧义配置在 py/js **同样地拒绝** |
| agent 冻结 endpoint 却每次重载 key | `llmKey()` 改用模块加载时那一份,与 endpoint 同时刻 | — |
| 302 跨 origin 仍带 Authorization | `_NoCrossOriginAuthRedirect`:跨 origin 摘头 | 实测跨域落点收到 `Authorization=None`,同源落点仍保留 |
| 测试接口只比 netloc,允许 https→http | 改比整个 origin(scheme+host+port) | 实测 `http://` 同主机被拒:`目标 http://…:80 与已保存的 https://…:443 不是同一个 origin` |

### P1-2 WAF/限流页仍可能被连续判死

`inspect()` 原来 `>=400` 一律 `notFound`,而调用方紧接着置 `sawAnyPage=true` ——
我 R1 加的 `sawAnyPage` 守卫因此形同虚设。已按语义拆开:

- **403 / 429 / 5xx → `blocked`**:既不算"看过页面"也不算"明确结论",只计 `blockedPages`
- 只有 **404 / 410** 才是站方说"没有这个页"
- 预筛里同口径:被挡的**不计入 `resolved`**(原来先 `resolved++` 再判,等于把限流当证据)
- 判不了时的 evidence 带上 `blocked_pages`,好解释"为什么判不了"

### P1-3 新并发上限与 180s 看门狗撞线

R1 我把 `Promise.all`(120 并发)改成并发 6 —— 最坏 `ceil(120/6)×9s = 180s`,
正好等于单域看门狗,而 `Promise.race` 不取消已发出的请求。**这是我改出来的回归。**

改成:并发 10 + 单请求 6s + **整段 40s 墙钟预算**,到点把剩余候选按"排除不掉"交给渲染
并打日志。硬上限 40s,给 sitemap+渲染留 140s。

### P1-4 成本账本仍未真正 fail-closed

坏行被静默跳过、非法金额被 `|| 0` 吞掉 → **少算花销 = 熔断放行**。已改:

- 中间行损坏 → 抛(只容忍**最后一行**半截,那是 append 的固有竞态)
- 金额非有限数或为负 → 抛

实测:干净账本 40;中间坏行→抛;非法金额→抛;末行半截→40(容忍)。

### P1-5 预检只测主模型

`llm_judge` 本来就会遍历降级链,预检却只探 `models[0]` → 主模型挂了就拒绝启动。
已改成按 `llm_judge` 的真实行为逐个探,任一可用即放行;若靠的是降级链会额外告警。

---

## 2. R2 的 P2 —— 全部已修

| 位置 | 问题 | 修法 |
|---|---|---|
| `index.html` | **`esc()` 的 `&#39;` 无效**:HTML 属性值在内联 handler 编译成 JS **之前**就已实体解码 | 内联 handler 里**一个不可信值都不放**:改 `data-*` + 事件委托 |
| `driver.py:210` | 运行后仍用原始域回读(R1 只修了 `pick_batch`) | 同走 `_key()` |
| `capsolver.mjs` | 只配 2Captcha 时整页 CF 挑战落 blocked,不进人工队列 | 无对应任务类型且没 capsolver → 打 `noSolver` |
| `read_otp.py` | 右边界漏排除 `.`,`tools.com` 命中 `tools.com.evil` | 负向前瞻补 `.` |
| `mail_sweeper.py` | 库内站 handle 持续 False + 超 TTL → 静默丢件 | 转人工(`blocker=park_stuck`),不无声吞 |
| `agent_submit.mjs` | 看门狗走 `process.exit()`,**跳过 R1 新加的 finally** | 登记浏览器句柄,强退前 `SIGKILL` 同步收(CDP 模式不杀用户浏览器) |
| `llm_config.py/.mjs` | 相对/空 `LLM_CONFIG` 在 py/node/不同 cwd 下解析不同 | 空串=未设、相对路径锚到 `outreach/`;已进对拍用例 |
| `llm.example.json` / `configure.py` | `cp` 出 0644 密钥文件;tmp 未被 gitignore | 权限过宽告警;`.gitignore` 补 `outreach/*.tmp.*`、`*.lock` |
| `index.html` | 单域 JSON 没带 `DATA_VERSION` | 三处 fetch 都带上,并 `encodeURIComponent` |

### 既存风险(非本轮引入)也修了

**`claimDelivery()` 无锁的"先查后追加"** —— 这是全系统防重复投递的**唯一**闸
(只有 `claimed=true` 才允许对外 click/POST)。已加 `withFileLock`,查与写在同一把锁内。

实测(10 进程同时刻认领同一域,忙等栅栏对齐):

```
修前:claimed=true 7 次 / 10
修后:claimed=true 1 次 / 10,零报错,零残留锁文件
```

### 文档口径漂移

parity 用例数(12→**25**)、webhook proxy 已不再硬编码、2Captcha 文案矛盾、
CSV 统计脚本漏算 `-`(补上后是 **77** 个字段而非 54)—— 四处都已改。

---

## 3. R3 请重点看这几处(我最不确定的)

### 3.1 同源绑定的"拒绝"是否过严 ★

新规则会让一类**以前能跑**的配置直接报错,例如:

- 环境里有 `OPENAI_API_KEY`(给别的工具用的)+ `llm.json` 指了自定义 endpoint → 拒
- `LLM_BASE_URL` 与 `LLM_ENDPOINT` 同时设且指向不同供应商 → 拒

我认为拒绝优于猜(这正是 P1-1 的根因),但**这是行为破坏性变更**。
请判断:默认拒绝 + `LLM_ALLOW_SPLIT_CONFIG` 逃生阀,还是默认放行 + 响亮告警?

### 3.2 `verify_link` 判死门槛现在有多严

叠加了两层收紧(R1 的 `sawAnyPage` + R3 的 403/429/5xx 不计证据)。方向是
"判死门槛应高于判活",但**我没有真实域名样本验证过分布变化** —— 可能过严,
导致真掉链的站永远攒不够 3 次 `offline_confirmed`。请评估,最好用真实数据。

### 3.3 `withFileLock` 现在护着两条关键路径

原本只护 `saveRecipe`(丢了不过是重新探路),现在也护 `claimDelivery`(防重复投递的核心)。
两点请核:

- 陈旧锁接管是**直接 unlink**,比 `creds.mjs` 的"rename 成随机名再删"更弱(有 TOCTOU 窗口)。
  现在它护的是投递认领,代价变高了 —— 是否该对齐 `creds.mjs` 的手法?
- 锁等待 8s 超时会抛。`claimDelivery` 抛错在调用方是 `e.ledger` 路径(exit 43,域留池不烧)
  还是会落到通用 catch 记 blocked?**我没有端到端验证这条异常路径。**

### 3.4 `configure.py` 仍是最高风险面

R2 之前我自己在这查出过一条凭据外泄路径,R2 又查出两条(save 保留旧 key、netloc 比较)。
**三次都在同一个文件** —— 请假定还有第四条。尤其:

- token 在 URL query(进浏览器历史)
- `/api/test` 现在的闸是"origin 相同才用已存 key",但**用户当场填的 key 仍会发给任意地址**
  (设计如此:那是他自己敲的)。这个边界对不对?
- `_write()` 的 tmp 窗口、`save()` 异常路径下的字段保留

### 3.5 看门狗强退时的 `SIGKILL`

`killBrowserSync()` 用 `browser.process()` 拿子进程 pid 再 `SIGKILL`。
CDP 模式下不登记句柄(连的是用户自己的浏览器,不该杀)。请核:
非 CDP 模式下 `browser.process()` 是否总是可用、pid 是否可能已被回收。

---

## 4. 这些是有意为之,别当 bug "修"

- **`mail_sweeper` 不给 `json_object` 做自由文本降级** —— 它驱动不可逆动作
  (写状态、点一次性验证链接),改成启动预检实探。`agent_submit` 有降级是对的
  (它 `JSON.parse` 失败只是跳过一步)。
- **`bet` 放过 `betplentia.com`** —— 为救回 8 个正常域的取舍,`casino|slot` 仍在。
- **配置界面不在 `index.html`** —— 那是要发 GitHub Pages 的公开静态站。
- **`upsert`/`queueForHuman` 里的撞锁重试在 JSONL 版是死代码**(SQLite 时代残留)。
  注意 `claimDelivery` 现在**真的会**因锁超时抛错了,见 §3.3。
- **`dbwpy.py` 对 `outreach_log` 主动抛** 是设计好的降级。
- **`alerts` / `mail_ws` 不在仓里**,已在 `outreach/README.md` 如实交代。

---

## 5. 一处已自我更正的结论,别继承错前提

R1 我判断前端打字卡顿的瓶颈是 `LINKS_IDX.includes()`(15k × 1360 线性扫)。
**A/B 实测证伪**:354ms → 363ms 在噪声内。分段:

```
① 过滤+排序 0ms  ② 拼 HTML 21ms  ③ innerHTML 建 DOM 327ms ←全在这  ④ 绑 onclick 5ms
```

Set 那个改动留着了(数据结构本来就该是 Set),但**不解决卡顿**。真修是 140ms 输入防抖
(连打 5 键:5 次全表重渲 → 1 次)。彻底解法是分页/虚拟化,**没做**。

---

## 6. 仍未修的(知情不做)

- **告警出口缺失**:`alerts` 模块不在仓里 → "QQ 信箱读到 0 封"这类事件只进日志。
- **账本全文件扫描**:`currentStatus`/`foldHumanTasks`/`spentToday`/`mail_done_since`
  (每秒轮询)全都重读整个 JSONL,且**没有压实路径**。`--loop` 跑几个月会明显。
  加锁之后 `claimDelivery` 的这条路径还多了一次锁开销。
- **`scripts/` 硬编码绝对路径** `/Users/wy/cafe/toolradar`(与本仓名不同)。
- **Node 侧不认 `http_proxy`**(Python 侧认)→ 远端端点两边出网路径可能不同;
  本机端点已一致。要统一得给 undici 配 dispatcher。
- **前端分页/虚拟化**。
- **`my_site.example.json` 缺 `agentmail` webhook 块**(`hook_events_moved` 读它)。

---

## 7. 复核入口(不需要真 key / 不需要网络)

```bash
python3 outreach/tests/test_llm_config_parity.py   # 25 用例,含歧义拒绝行为
python3 outreach/llm_config.py                     # 当前解析结果(key 只显掩码)
for f in outreach/*.mjs; do node --check $f; done
python3 -m compileall -q outreach scripts
python3 outreach/configure.py --port 8790 --no-open  # 请攻它
```

数据侧断言(对 `data/` 真实文件统计,重跑即核):

```bash
python3 - <<'EOF'
import json, glob, itertools
files=[f for f in glob.glob('data/links/*.json') if not f.endswith('index.json')]
rows=[len(json.load(open(f))) for f in files]
print(f"域={len(files)} 最大行数={max(rows)} 总行数={sum(rows)}")   # 1360 / 100 / 135230
n=0
for f in itertools.islice(iter(files),300):
    for r in json.load(open(f)):
        for k in ('a','s'):
            v=str(r.get(k) or '').strip()
            if v and (v[0] in '=+@\t\r' or (v[0]=='-' and not v[1:2].isdigit())): n+=1
print("公式字符开头的字段:", n)                                      # 77
EOF
```

---

## 8. 评审时值得带着的两个问题

R1/R2 两轮的 findings 高度集中在这两个形状,值得继续用它们扫:

1. **"这条防御的执行路径真的到得了吗?"**
   R1:fail-closed 是空的 / 计划算了没人用 / meta 没人传 / 降级通道够不着。
   R2:`sawAnyPage` 守卫被 `notFound` 绕过 / `finally` 被 `process.exit` 跳过 /
   `&#39;` 被 HTML 解码绕过。
2. **"同一个坑在别处修过吗?"**
   R1:`:871` 修过 `:2042` 没跟上 / `:830` 做对了 `locate` 没有 /
   `save_state` 硬化过 `park_save` 没有 / `creds.mjs` 加锁了 `saveRecipe` 没有。
   R2:`pick_batch` 修了 `:210` 没跟上 / `saveRecipe` 加锁了 `claimDelivery` 没有。
