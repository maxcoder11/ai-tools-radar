# 评审交接

评审对象:`main` 分支,提交范围 `e71a13b..HEAD`。**工作区干净,改动都已提交。**

## 时间线

| 轮次 | 谁 | 结果 |
|---|---|---|
| R1 | Claude 自审 | 全仓 review,修 26 条 |
| R2 | Codex 一审 | 判定**不建议合并**:5 P1 + 10 P2 + 1 条既存风险。**全对** |
| R3 | Claude | 按 R2 清单全修 + 逐条实测 |
| R4 | Codex 二审 | 判定"P1 全部已修"**不成立**:6 个新 P1 + 10 条其他。**又是全对** |
| R5 | Claude | 按 R4 清单全修 + 逐条实测 |
| R6 | Codex 三审 | 仍判**不建议合并**:7 P1 + 12 P2。**又是全对** |
| R7 | Claude | 按 R6 清单全修 + 逐条实测 |
| R8 | Codex 四审 | 5 P1 + 10 P2。**又是全对**,且 5 条 P1 里 4 条是 R7 修复自身的缺陷 |
| R9 | Claude | 按 R8 清单全修 + 逐条实测 |
| R10 | Codex 五审 | 5 P1 + 5 P2,**锁协议仍被击穿两条** |
| R11 | Claude | **换掉锁的设计**(不再打第五个补丁)+ 其余全修 ← **本文档写的是这之后的状态** |

**连续三轮外审,每轮都找出"上一轮只修了一半"。** R6 的 7 条 P1 里有 5 条属于此类:

- `driver.load_state` 做了键归一,**`state.mjs/py` 的 `currentStatus` 没做** ——
  账本里躺着 `www.Example.com/success` 时 `claimDelivery` 仍返回 `claimed:true`
- `spentToday` 改成 fail-closed 了,**`readJsonl` 没改** —— 账本只写不可读时
  认领闸整个 fail-open(实测 chmod 200 后仍 `claimed:true`)
- `configure` 与 `llm_config` 的 origin 统一了,但**统一到了 Python urlparse** ——
  真实请求走 Node WHATWG URL,`https://old.com\@new.com` 两边解析出不同 host
- `llm_config` 的路径 env 归一了,**`OUTREACH_STATE_DIR` 没归一** —— 相对路径下
  py 按 cwd、node 按 driver 传的 cwd,两套账本
- `sawAnyPage` 守卫加了,但它在**判 notFound 之前**置位 —— 渲染出来的 404 也算"看过页面"

**R8 把这个模式推到了极致:5 条 P1 里 4 条是我 R7 那批修复本身的缺陷。**
其中文件锁我连续改错三轮 —— 最后结论是**别自己造**:同一个仓里的 `creds.mjs`
早就有正确实现(检查持锁进程是否存活再决定要不要接管),R9 直接照抄它。

教训写在这里给下一轮:**改一个防御之前,先 grep 仓里有没有同类实现。**
`creds.mjs` 的锁、`:830` 的选择器转义、`:871` 的拒词、`save_state` 的原子写 ——
四轮里反复出现"仓里已有正确答案,而我在旁边新造了一个错的"。

这个模式值得下一轮继续按 §11 的两个问题扫。

---

## 1. R10(五审)—— 已修,其中锁是**换设计**不是打补丁

### 锁:连错四轮之后的结论 —— 这个做法本身不成立

R10 又击穿两条(陈旧接管的 ABA;O_EXCL 建空文件与写 owner 之间的空窗)。停下来看根因:

> 陈旧接管必须"读 owner → 判死 → 移走"三步,而 **POSIX 没有"按 inode 条件删除"的
> 原子操作** —— 三步之间总能插进第三方。这不是我没写好,是**纯文件锁的陈旧接管做不对**。

所以 R11 换设计,而不是打第五个补丁:

1. **认领闸不再依赖锁。** 认领的语义本来就不是临界区,而是"一个域一生只认领一次"
   (`delivery_ambiguous` 永不自动重投)。这正是 `O_EXCL` 建标记文件的语义:
   内核保证只有一个创建者成功,**不需要任何存活检测、租约或陈旧判断**。
   标记落在 `<DIR>/claims/<域>.claim`,py 与 node 共用。
   合法回池(`email_verified` 等非投达态)时由 `upsertSubmission` 显式撤标记 ——
   一处明确的写,不是竞态。
2. **锁只留给状态投影的读改写**,并且:
   - 先写临时文件、再 `link()` 原子发布 → **锁文件一出现就是完整的**,消除空窗(P1-2);
   - 陈旧接管**保留但简化成"超时直接覆盖"**:持有者已死 → 30s 接管;
     不管什么原因(pid 复用/挂死/读不出 owner)→ 120s 一律接管。
     **任何被遗弃的锁都自动回收,永远不需要人工 `rm`。**
     不为"会不会偷到活锁"做严格保证 —— 见下面那条关键性质,偷错了也只是丢一次
     守卫判定。临界区实测是毫秒级,120s 之外不存在合法持有者;
   - 单调时钟、严格 `pid=` 解析、去掉裸 `catch{continue}` 的热循环(P2-6)。

**关键性质:"会不会重复投递"从此不依赖锁的正确性。** 锁即使出现竞态,最坏是丢一次
守卫判定 —— 投影上多一条 `blocked`,该域被重投一次,而重投时 **claims 标记仍然挡得住
POST**。既然后果只是浪费一次跑,就不该为它上人工介入,也不该为它做复杂的 ABA 防护。
(上一版我要求人工 `rm`,是把安全关键路径的严格度错用在了一把已经不安全关键的锁上。)

实测:
- 12 个 node 进程忙等栅栏同时刻认领同一域 → `claimed` 恰好 1 次、账本恰好 1 行、零残留锁;
  20 进程混合 py/node 同样恰好 1 次
- 死进程留下的锁 → py/node 都在 **1-3ms 内自动接管**(不需要人工)
- mtime 已过 30s 陈旧线但持有者活着 → 等到超时也不偷
- 挂死超过 120s 兜底线 → 自动接管

### 其余 P1

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| 3 | `state.mjs` / `state.py` | 截断的账本**尾行**仍被当"不存在" → `currentStatus` 返回空、认领放行,新 JSON 还会拼到半行后面 | 取消"末行半截"豁免:安全读在锁内发生,不会有并发 append,持久截断必须 fail-closed |
| 4 | `agent_submit.mjs` | Turnstile/reCAPTCHA 分支**忽略 `queueForHuman` 的返回值**无条件置 `e.queued=true` → 人工任务写失败但账本可写时,永久落 manual 却没有任务;CF 分支反过来没置,成功入队后顶层还会再建一条 | 三个分支一律按真实返回值传 |
| 5 | `verify_link.mjs` | 单域预算截断只 `break`,没记"候选没看完" → sitemap 可读时结尾仍判证据充分,目标链接根本还没检查就 `offline_confirmed` | 加 `truncated` 标志,截断过就**绝不判死** |

### P2(5 条)

JS loader 补拦 `?|` 解析失败哨兵(`https://example.com:99999/v1` 原来 js 接受、py 拒绝);
`migrate_domain_key` 不再把**唯一那条脏键行**误判成"canon 目标被另一行占用"(行侧归一后
它会命中自己);2Captcha **轮询**的网络异常补 `infra` 标记;配置界面保存一张卡片时,
另一张卡片的**全部输入**(含非密钥字段)先快照、`render` 后原样还原。

**注意**:P2-10 我在 R9 声称修过,实际那次改动**没落到文件里**(断言通过但被后续覆盖)。
这轮按真实文件内容重做并复查了 R9 那批 configure.py 改动的其余部分(都在)。

---

## 2. R8(四审)—— 已修

### P1(5 条,其中 4 条是 R7 修复自身的缺陷)

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| 1 | `llm_config.mjs` | `originOf` 对畸形地址只返 `AMBIGUOUS` **哨兵字符串**,而只有存在第二配置源时才走比较 —— 单一来源的畸形 base 被直接接受。实测 `https://old.com\@new.com` js 放行(实连 old.com)、py 拒绝 | `load()` 返回前显式拒所有哨兵,有无 winner 都拦 |
| 2 | `configure.py` | `save()` **先替换 llm.json、之后才校验** → 校验失败时坏配置已落盘,所有组件拒绝启动 | 先在临时文件上跑一遍真实 `load()`,通过了才替换 |
| 3 | `state.mjs` / `state.py` | 陈旧锁**只看 mtime 就接管**,token 里明明有 pid 却不查存活 → 持锁进程被 SIGSTOP/慢 IO/休眠超 30s 就被偷锁,两个 `claimDelivery` 都 `claimed:true` | **照抄 `creds.mjs`**:`pidAlive` 活着就绝不偷 |
| 4 | `state.mjs` / `state.py` | R7 的"rename 到私名再删"释放法**更糟**:锁若已属于 B 会被 A 挪走,空窗里 C 建的新锁又被 A 的恢复 rename 覆盖 | 回到 `creds.mjs` 的"读一次、确认是自己的才 unlink";残余竞态由存活检查堵住 |
| 5 | `state.mjs` / `state.py` / `driver.py` | 读失败改 fail-closed 了,**JSON 解析失败仍静默过滤** → 一条截断的 `success` 行让 `currentStatus` 返回 null、认领放行 | 坏行一律抛;只容忍"文件不以换行结尾"时的最后一行(append 竞态) |

### P2(10 条)

`check_llm.probe` 要求 `{"ok":true}`(只验"是对象"的话 `{"ok":false}` 也算过,而运行期
`llm_judge` 会把缺 `kind` 的对象当 noise 并**把验证信标记完成**);`_queue_human` 返回成功
状态(原来吞异常又不返回 → 外层"入队失败就别丢件"永不执行);`--for-domain` 走 quick 预检
(父进程只给 120s,完整预检 45s×N + 90s 等待会超);2Captcha 边界统一故障分类(无效 key /
网络失败 / 未知状态原来抛裸 Error → 供应商故障被记成目标站 blocked);入队失败的 exit 43
输出补 `LEDGER_WRITE_FAILED` 标记(否则 driver 仍补写 blocked);driver 兜底写账接住 `OSError`;
无 key 分支置 `e.queued` 避免同一阻塞建两条 pending;`verify_link` 加**整域渲染预算** 140s
(原来预筛 40s + 8×25s 导航 = 240s 仍超 180s 看门狗);`OUTREACH_STATE_DIR` 统一**词法归一**
(Node `path.join` 不解 symlink、Python `open` 会解 → 同一 env 落到两个物理账本);
配置界面保存一张卡片不再清空另一张未保存的密钥。

### 关键验证

```
活锁不被偷:锁 mtime 改成 2020 年但持锁进程还活着 → 另一进程等到超时也没抢走
截断的 success 行 → 抛错 fail-closed,不再放行认领
畸形地址 https://old.com\@new.com → py 与 js **都**拒绝(R7 只有 py 拒)
非法配置保存 → 接口报错且 llm.json 原样未动
跨语言并发 12 进程 → claimed=1 次、零报错、零残留锁
对拍 38 用例 0 不一致
```

---

## 3. R6(三审)的 P1 —— 已修

| # | 位置 | 问题 | 修法 |
|---|---|---|---|
| 1 | `configure.py` | 比的是文件里的原始 `base_url`,不是**运行期实际生效**的 —— 旧配置只有 key、base 为空时运行期回落 OpenAI,而这里读到空串就跳过换源检查 | 空 base 按 `DEFAULT_BASE` 参与比较 |
| 2 | `configure.py` / `llm_config` | origin 判定用 Python `urlparse`,真实请求走 Node WHATWG URL:`https://old.com\@new.com` → py 得 `new.com`、js 得 `old.com`,**换源检查可绕过**(双端口实测新 host 收到旧 Authorization) | 不模仿 WHATWG 容错,**把歧义写法整个拒掉**(反斜杠/空白/userinfo/非 http(s)),两边同口径 |
| 3 | `state.mjs:109` / `state.py:148` | **`currentStatus` 只 canon 查询侧、不 canon 行侧** → 历史 `www.Example.com/success` 查不到 → `claimDelivery` 返回 `claimed:true` → 重复 POST。R5 只修了 driver 选池,直接跑 agent 仍中招 | 两侧都过 `rowKey`/`_row_key`;`stateRows`/`domainsWithStatus`/`verificationRows` 一并归一 |
| 4 | `state.mjs:101` | `readJsonl` 吞掉一切读失败 → 账本只写不可读时返回空 → **唯一的投递闸 fail-open** | 只有 ENOENT 算空,其余抛;Python 侧同步 |
| 5 | `capsolver.mjs:294` | only-2Captcha 分支的占位 `csErr` 没有任何分类标志,2Captcha 供应商故障(无效 key)于是 `infra/budget/noSolver/terminal` 全 false → 顶层烧目标域 | 占位打 `placeholder` 标记,真出错时直接抛 2Captcha 自己的错误对象 |
| 6 | `verify_link.mjs:435` | `sawAnyPage` 在**判 notFound 之前**置位 → 渲染出的 404 也算"看过页面";1 个 recorded 404 + 120 个预筛 404 → `probed_pages=121` → `offline_confirmed` | 挪到 notFound 判定**之后** |
| 7 | `driver.py:41` / `state.*` | 相对 `OUTREACH_STATE_DIR` 按 cwd 解析,而 driver 以 `cwd=outreach` 启 node → **py 与 node 两套账本**,投达态互不可见 | 空串当未设、相对路径锚到 `outreach/`(与 `llm_config` 同口径) |

### R6 的 12 条 P2 —— 已修

锁超时错误文本带上 `ledger locked` 以匹配调用方的 `/locked|busy/`;driver 接住
`RuntimeError`(原来只接 `ValueError`,锁超时会带 traceback 打死整波);锁释放改成
"rename 到私名再删"消除 TOCTOU(py/js 同步);CapSolver 的相对 `OUTREACH_MY_SITE`
与 `llm_config` 同口径;人工任务入队失败**不再落终态 manual**(否则域被永久排除却无人处理),
blocker 名统一;only-2Captcha 无代理时 CF 分支改抛 `noSolver` 而非返回普通字符串;
preflight 探的改成**运行期冻结的那份配置**;`SKIP_LLM_CHECK`/`LLM_ALLOW_SPLIT_CONFIG`
按真布尔解析;`check_llm.probe` 要求 JSON **顶层是对象**(数组/字符串会让 `llm_judge` 抛);
`VERIFY_PREFILTER_BUDGET_MS` 钳到 [5s,120s];OTP 主题支持句末域名(`Verify x.com.`)
同时仍挡住 `x.com.evil`;`build_data.NOT` 拆成 EXACT(整串相等)+ PREFIX,修掉
`notion.so → notion.software` 这类前缀误伤。

**注意**:`NOT` 我第一版顺手加了"子域也算",实测会把 1286 个 `*.wordpress.com` /
`*.blogspot.com` 一起过滤 —— 那是扩大范围不是修 bug,已改回最小修复(只补 `$` 边界)。

### 关键验证

```
历史 raw 键 www.Legacy.com/success → currentStatus 可见(py/js 都)、不重复认领
账本只写不可读(chmod 200) → 抛 "账本读取失败…fail-closed",不再放行
歧义地址 https://old.com\@new.com → py 与 js 同样拒绝
OTP 边界:Verify x.com. ✅ / Verify x.com! ✅ / x.com.evil ❌ / x.commerce ❌
NOT:notion.software/x.company/medium.community/shop.application 全部放行,
     notion.so/x.com/medium.com/shop.app 仍过滤,*.wordpress.com 不受影响
配置解析对拍:33 用例 0 不一致
```

---

## 4. R4(二审)的 P1 —— 已修

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

## 5. R2(一审)的 P1 —— 已修

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

## 6. R2 的 P2 —— 已修

`esc()` 的 `&#39;` 无效(HTML 属性值在内联 handler 编译成 JS **之前**就已实体解码,
真浏览器 PoC 可执行注入)→ 改 `data-*` + 事件委托,内联 handler 里一个不可信值都不放;
driver 回读键、2Captcha+CF 转人工、OTP 右边界含 `.`、park 超时不丢件、
看门狗 `process.exit` 前同步杀浏览器、`LLM_CONFIG` 空串/相对路径归一、
密钥文件权限告警、单域 JSON 版本化。

既存风险 **`claimDelivery` 无锁**也一并修了(R4 指出锁覆盖不全,见 §1 第 4 条)。

---

## 7. 请重点看这几处(我最不确定的)

### 7.1 认领闸换成 O_EXCL 标记(R11 换设计)★

R5 把 `upsertSubmission`(Node + Python 两侧)都放进了锁。这是本轮**改动面最大**的地方:

- 所有状态写现在都要拿锁,**热路径上多了一次文件锁开销**;账本本来就是全文件扫描,
  叠加之后 `--loop` 长跑的表现没有实测过
- 锁超时的归属 R6 已指出两个问题并修掉:错误文本现在带 `ledger locked` 以匹配调用方的
  `/locked|busy/`;driver 接住 `RuntimeError` 不再带 traceback 打死整波。
  **但"锁超时 → agent 顶层落到哪个分支"仍没有端到端跑过**(是 `e.ledger` 的 exit 43
  域留池,还是通用 catch 记 blocked?)。
- Python 侧 `with_file_lock` 与 Node 侧 `withFileLock` 是两份实现、共用一把锁文件。
  等待超时(8s)、`link()` 发布、严格 `pid=` 解析、单调时钟四者必须一致,
  **仍是手工对齐,没有对拍**。锁我连错四轮,虽然安全关键路径已经绕开它,
  **仍请优先攻它**。

### 7.2 同源绑定的"拒绝"是行为破坏性变更

一类**以前能跑**的配置现在直接报错,例如环境里有 `OPENAI_API_KEY`(给别的工具用)
+ `llm.json` 指了自定义 endpoint。我认为拒绝优于猜(那正是 P1 的根因),
但请判断:默认拒绝 + 逃生阀,还是默认放行 + 响亮告警?

### 7.3 `verify_link` 判死门槛已叠四层收紧

`sawAnyPage`(R3)+ 403/429/5xx 不计证据(R3)+ 只有 404/410 算不在(R5)。
方向是"判死门槛应高于判活",但**我始终没有真实域名样本验证分布变化** ——
可能过严,导致真掉链的站永远攒不够 3 次 `offline_confirmed`。这条最好用真实数据跑一轮。

### 7.4 `configure.py` 仍是最高风险面

**四轮里三次在这个文件出问题**(R2 前自查一条凭据外泄、R2 两条、R4 一条)。
请假定还有第五条。当前边界:

- token 在 URL query(进浏览器历史)
- `/api/test` 的闸是"origin 相同才用已存 key";**用户当场填的 key 仍会发给任意地址**
  (设计如此:那是他自己敲的)。这个边界对不对?
- `_write()` 的 tmp 窗口、`save()` 异常路径下的字段保留

### 7.5 看门狗强退时的 `SIGKILL`(R6 已给出结论,保留备忘)

R6 复核:`browser.process()` **在当前 Playwright 版本上不存在**,但 1.62.1 在
`process.exit()` 时会同步清理浏览器进程,真进程测试未遗留 Chromium —— 所以
`killBrowserSync()` 实际是个空操作兼保险。留着无害,但**别把它当成有效防线**。

---

## 8. 这些是有意为之,别当 bug "修"

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

## 9. 一处已自我更正的结论,别继承错前提

R1 我判断前端打字卡顿的瓶颈是 `LINKS_IDX.includes()`(15k × 1360 线性扫)。
**A/B 实测证伪**:354ms → 363ms 在噪声内。分段:

```
① 过滤+排序 0ms  ② 拼 HTML 21ms  ③ innerHTML 建 DOM 327ms ←全在这  ④ 绑 onclick 5ms
```

Set 那个改动留着了(数据结构本来就该是 Set),但**不解决卡顿**。真修是 140ms 输入防抖
(连打 5 键:5 次全表重渲 → 1 次)。彻底解法是分页/虚拟化,**没做**。

---

## 10. 仍未修的(知情不做)

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

## 11. 复核入口(不需要真 key / 不需要网络)

```bash
python3 outreach/tests/test_llm_config_parity.py   # 38 用例:歧义拒绝 / split 开关 / origin 归一化
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

## 12. 评审时值得带着的两个问题

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
