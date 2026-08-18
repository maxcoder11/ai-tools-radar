# outreach/ — LLM-in-the-loop 外链投放管道

看完数据想动手？这个目录把"竞品的 dofollow 来源"变成你的投放清单，并用一个
**LLM 决策的浏览器代理**完成目录站提交：观察页面 → LLM 决策 → 执行 → 再观察，
像人一样处理每个站的表单变体。移植自一套生产验证过的私有管道，三条红线由代码
硬执行，LLM 无权越过：

1. **付费**：LLM 选择付费/结账类动作 → 直接 `skipped_paid` 终止；
2. **文案**：所有填入值必须过 `kit.json` 的 `forbidden_claims` 正则闸门，
   LLM 只能选预设槽位或基于 kit 事实组合；
3. **验证码**：LLM 只声明验证码类型，解题由代码走 CapSolver/2Captcha，不让 LLM 编答案；
   两个打码 key 一个都没配 → 该域标记 `manual` 进人工队列，不硬刚。

另有：投递认领（submit 类动作单发派发，防重复提交）、`delivery_ambiguous` 终态
（永不自动重投，人工裁决）、状态迁移守卫（投达态不许被辅助步骤异常打回
blocked/failed）、站点约束 TTL、成功打法沉淀 recipe 下次快放。

## 开工前必须准备（缺了别跑）

1. **OpenAI 兼容 LLM 端点**（必填）。提交代理每一步都靠它决策，邮件理解也靠它判意图。
   最省事的配法是开配置界面：

   ```bash
   python3 configure.py        # 本机 127.0.0.1:8790，填完点「测试连接」再保存
   ```

   也可以纯命令行（优先级从高到低，三选一）：

   ```bash
   export LLM_BASE_URL=https://openrouter.ai/api/v1   # 填供应商文档给的 base URL 即可
   export LLM_API_KEY=sk-...                         # 不用自己拼 /chat/completions
   export LLM_MODEL=openai/gpt-4o-mini               # 可选降级链 LLM_FALLBACKS（逗号分隔）

   export OPENAI_BASE_URL=... OPENAI_API_KEY=...     # 或直接吃现成的通用变量

   cp llm.example.json llm.json                      # 或写文件（env 优先于文件）
   ```

   ⚠️ **模型必须支持 `response_format: json_object`** —— `mail_sweeper.py` 判的是
   不可逆动作（写状态、点一次性验证链接），所以它不接受自由文本降级，而是
   **启动时实探一次，不通就拒绝开跑**（`SKIP_LLM_CHECK=1` 可跳过）。
   随时可单独验：`python3 check_llm.py`；
2. **收信信箱，两条腿至少通一条**（都免费，收验证/审核邮件）：
   - `agent.qq.com`：注册账号 → `npm install -g @tencent-qqmail/agently-cli`
     → `agently-cli auth login` 授权一次（`auth status` 可查状态）；
   - `agentmail.to`：`console.agentmail.to` 注册拿 API key（am_ 开头）+
     inbox_id，填 `my_site.json` 的 `agentmail_api_key` / `agentmail_inbox_id`
     （或 env `AGENTMAIL_API_KEY` / `AGENTMAIL_INBOX_ID`）+ `pip install agentmail curl_cffi`；
   一条腿不通会降级打日志，不影响另一条。`mail_sweeper.py` 自动收信、LLM 判意图、
   点验证链接 —— 四条安全闸别动（只处理投过的域 / 链接注册域=发件域且路径含
   验证词 / 跳转逐跳不出域 / message-id 幂等）；
3. **产品资料包**：`cp kit.example.json kit.json`，把产品名/URL/文案槽位/
   forbidden_claims 全部换成你的真实资料；`submitter.email` 必须落进上面的 AgentMail
   信箱（验证码发到这）；
4. **persona 身份**：`cp identities.example.json identities.json`，换成你的投放
   身份（姓名 + gmail 等中性域邮箱）。agent 按域 hash 固定抽取（同域稳定、跨域
   轮换），裸跑会被 Akismet 跨站签名烧域；
5. **浏览器**：`npm install` + 本机有 Chrome，或 `CHROME_BIN` 指一个
   Chrome/Chromium，或 `npx playwright install chromium`。

可选增强：

- `capsolver_key`（+ `twocaptcha_key` 降级通道）：有了才自动过验证码的站；
  各供应商日预算熔断 $50（`CAPSOLVER_DAILY_BUDGET_USD` 等可调），出码前查 `costs.jsonl`、
  **fail-closed**（账本读不出来就拒绝新建付费任务，不是当零花销放行）。
  两个 key 配任意一个即可：只配 `twocaptcha_key` 时直接走 2Captcha，
  两个都配时 capsolver 优先、终态错误自动降级 2Captcha；一个都没配才标 `manual` 转人工；
- `HTTPS_PROXY`：出站代理。⚠️ 用 Cloudflare 整页挑战解题时必须配——
  `cf_clearance` 绑定 IP+UA，浏览器和解题必须同一出口。

## 用法

```bash
cd outreach
npm install                                  # playwright-core
pip install agentmail curl_cffi            # mail_sweeper 收信/点链依赖(两条腿共用)

python3 configure.py                         # 配 LLM 端点 + 打码/收信 key(带实测按钮)
python3 check_llm.py                         # 或纯命令行验一次端点

cp kit.example.json kit.json                 # 填你的产品资料(红线文案在此)
cp identities.example.json identities.json   # 填你的 persona 池

python3 targets.py                           # 生成 worklist.jsonl(tier1 提交页优先)
node agent_submit.mjs https://某站/submit --steps 2   # 单站干跑验证装载
python3 driver.py --limit 5                  # 先 5 个亲眼验证
python3 driver.py --limit 50                 # 没问题再放量
python3 mail_sweeper.py --dry-run            # 先演一遍判定质量
python3 mail_sweeper.py --loop               # 常驻:自动收信点验证链接
```

**完整闭环**：driver.py 投放 → 站点发验证邮件 → mail_sweeper.py 收信点链接 →
state.jsonl 记 `email_verified`，卡死的 blocked 站自动回池重投；收录通过/拒绝的
来信按 LLM 意图分类写回（pending_review/failed/skipped_badge）→ **verify_link.mjs
终核**确认链接真的上线（见下节）。每天看一眼 state.jsonl 和 human_tasks.jsonl
就知道战果和待办。

## 终核（verify_link.mjs）

`pending_review` 只是"站方说收到了/来信说收录了"，不算上线。终核器用**确定性判据**
收口：页面上有没有指向你域的 `<a href>`（不问 LLM，顺手消除"搜索页回显被当成
上线"的假阳性）。

- 四路探针：已记录 URL → sitemap → 站内搜索 → 路径枚举；`oracles_tried` 记录
  试过哪些，证明 offline 是真的找过而不是没找到；
- 三态：`online` / `offline_confirmed`（sitemap 可读，或**真渲染看过至少一页**
  且探到 ≥10 页明确结论才判）/ `unknown_network` / `unknown_blocked` ——
  判不了的绝不写成"未上线"。**403/429/5xx 只说明"我们被挡在外面",既不算看过页面
  也不算明确结论** —— 拿不到内容 ≠ 页面不存在,WAF/限流不该把域推向判死；
  预筛并发上限 10、单请求 6s、整段 40s 墙钟预算（`VERIFY_PREFILTER_CONCURRENCY` /
  `VERIFY_PREFILTER_BUDGET_MS` 可调）:既不对单站开突发,也不会把单域拖过 180s 看门狗；
- SEO 价值字段：rel（**nofollow 判定**）、meta robots、X-Robots-Tag、canonical、
  跳转落地；侧栏/widget 回显锚不算收录证据；
- 每次核验追加 `verifications.jsonl`（默认只读，不动状态）。

```bash
node verify_link.mjs --pending                 # 核所有 pending_review/emailed/success/delivery_ambiguous
node verify_link.mjs --pending --update-status # 确认才动状态:online+dofollow→success;
                                               # online 但 nofollow→保持 pending_review;
                                               # offline_confirmed 连续 ≥3 次才→failed(单次不判死);
                                               # unknown 不动
node verify_link.mjs --known                   # 复核已知链,查掉链
node verify_link.mjs example.com               # 指定域
```

建议投放后每周跑一次 `--pending --update-status`，每天跑一次 `--known`（掉链监控）。
口径对应：`success` = 终核在线且 dofollow；这是 README 里"~1% 终核上线"的"终核"。

## 状态口径（与生产一致）

- `success` / `pending_review`：页面有严格回执文案（否定句/条件句先过滤）；
  success 还要过"实站可检索"自验证，检索不到降 pending_review；
- `emailed`：仅限站内联系表单提交成功且回执可见（代理无发信能力）；
- `blocked` / `failed`：未投达（每天最多重试一次）；
- `delivery_ambiguous`：submit 已派发但终局未定 —— **永不自动重投**。
  防重复投递有**两道独立的闸**:账本状态 + `claims/<域>.claim` 标记文件。

  **人工只需要做一件事:去站上看链接在不在。**
  在(且 dofollow)→ 标 `success`(`verify_link.mjs --pending --update-status` 会自动做);
  不在、或看不出来 → **什么都别动**,让它停在这个状态。
  这个状态的语义就是"可能已经投出去了",把它放回池 = 可能给站方发两份 ——
  少一个目标域的代价远小于此。(`releaseClaim()` 存在,但那是收拾残局的逃生阀,
  不是日常动作,别写进流程。)
- `manual`：有验证码但没配打码 key，已进人工队列；
- `skipped_paid` / `skipped_badge` / `skipped_fit`：按政策跳过；
- `email_verified`：验证信点通，blocked 解除回池。

账本文件（全部 gitignore）：`state.jsonl`（当前态投影）/ `events.jsonl`（事件）/
`costs.jsonl`（LLM+打码花费）/ `constraints.jsonl`（站点约束带 TTL）/
`human_tasks.jsonl`（人工队列）/ `recipes.json`（打法沉淀）/
`verifications.jsonl`（终核记录）/ `creds.json`（站点注册账号，排他锁+原子写）。

## 文件对应（移植自生产管道）

| 文件 | 生产对应 | 说明 |
|---|---|---|
| `agent_submit.mjs` | node-tools/agent_submit.js | 观察-决策-执行主循环 + 三条红线 |
| `state.mjs` / `state.py` | node-tools/dbw.js / scripts/dbwpy.py | SQLite → JSONL 账本，守卫语义逐条对齐 |
| `submission_safety.mjs` | node-tools/submission_safety.js | 提交类控件判定 + 回执分类 |
| `agent_submit_runtime.mjs` | node-tools/agent_submit_runtime.js | 动作结果结构化 + 看门狗预算 |
| `wall_detect.mjs` | node-tools/wall_detect.js | 墙识别/约束归因/reCAPTCHA 探测 |
| `outbound_guard.mjs` | node-tools/outbound_guard.js | 出站 SSRF 闸 |
| `capsolver.mjs` | node-tools/capsolver.js | 打码客户端（key 走 my_site.json） |
| `creds.mjs` | node-tools/creds.js | 站点账号凭据（锁+原子写） |
| `rootdomain.mjs` + `psl_data.json` | scripts/rootdomain.py 的 JS 版 | PSL 根域判定，数据公开 PSL |
| `mail_sweeper.py` | scripts/mail_sweeper.py | **生产文件逐字复制 + 最小改动**(LLM env 化/DB→state.jsonl/凭据入 my_site.json) |
| `dbwpy.py` | scripts/dbwpy.py | 兼容层:生产 API 面落 state.jsonl,sweeper 调用点零改动 |
| `read_otp.py` | scripts/read_otp.py | 给 agent 取验证码/验证链接 |
| `driver.py` | scripts/rolling_submit.py 简化 | 滚动驱动：选池/节流/退避/persona 轮换 |
| `verify_link.mjs` | node-tools/verify_link.js | 终核器：四路探针 + 三态 + nofollow 判定 |
| `esp_hosts.json` | scripts/esp_hosts.json | ESP 跳转域白名单（唯一来源） |
| `llm_config.py` / `.mjs` | （开源版新增） | LLM 端点配置唯一解析口，两份规则逐条一致 |
| `check_llm.py` | scripts/check_llm.py | 端点自检（连通性 + json_object），启动预检共用 |
| `configure.py` | （开源版新增） | 本机配置界面，只绑 127.0.0.1 |

### driver.py 对照生产 rolling_submit.py 的取舍

**已带（生产能力）**：每域每天一次、域间 20-40s、persona 按域 hash 轮换 +
评论作者网址池（`AUTHOR_URL_POOL`，评论腿注入 IDENTITY_FORCE，目录腿不覆盖）、
429/LLM 瞬态退避 60s、打码预算熔断停波（exit 42）、写账失败不补记（exit 43）、
无声退出兜底补记 blocked（SILENT_SKIP_MARKERS 豁免）、900s 包装超时补记、
逐域完整日志落 `run/agent_logs/`。

两处兜底补记**都经 `state.upsert_submission` 的迁移守卫**：agent 若已投达
（pending_review/success/emailed/delivery_ambiguous），这条 blocked 会被拒并打一行
`[账本] 状态守卫拒绝 …` —— 那种域本来就在终态里不会被重选，绝不能被兜底打回可重投
（重投 = 重复提交）。**别绕过守卫直接往 state.jsonl 追加行。**

**未包含（私有基建，不带）**：代理节点池轮换（mihomo/Surge，本机 7891/8234）、
CF 签名站的住宅出口重投与 cloak 指纹内核救援（依赖私有二进制和家庭宽带出口）、
远程核验模式（VERIFY_JOB）。这些与你的网络环境强绑定，开源版用 `HTTPS_PROXY`
单代理替代；CF 挑战多的话自己配静态住宅代理。

**mail_sweeper 侧同样有没带过来的东西**（都是 `try/except` 包着的可选依赖，缺了不影响
主流程，但要知道它们是哑的）：

- `alerts` 模块（告警出口）不在本仓 —— 所以"QQ 信箱本轮读到 0 封"、"收信轮次异常"
  这些本该升级成告警的事件，开源版只会打进日志。**常驻要长期跑就自己盯日志**，
  或者补一个 `alerts.py`（需要 `raise_alert(source, level, msg, detail, dedup_key)`
  和 `resolve(dedup_key, msg)` 两个函数）；
- `mail_ws` 模块（WebSocket 秒级唤醒）不在本仓 —— 收信延迟退化成周期轮询
  （空闲 `SWEEP_IDLE_SEC` 默认 900s，有 agent 等信时 `SWEEP_BUSY_SEC` 默认 5s），
  正确性不受影响；
- `hook_events_moved()`（webhook 计数兜底）的出站代理走 `WEBHOOK_PROXY` /
  `HTTPS_PROXY`，没配就直连（原来写死作者本机的 `127.0.0.1:7891`，换机器必然连不上）。

## 规范化配置（LLM 端点）

配置解析收口在 `llm_config.py` / `llm_config.mjs`（**两份规则逐条一致**，25 个用例
跨语言对拍过，含歧义配置的拒绝行为）。要点：

- **填 base URL 就行**，不用自己拼 `/chat/completions`。根域 / `/v1` / 带尾斜杠 /
  完整地址 / `/v1beta` / Azure 带 query，六种写法都认；
- **base 与 key 必须同源**：按"来源单元"整体挑,不按字段各自降级 ——
  否则会把 A 供应商的 key 发给 B 供应商的地址。单元优先级:
  `LLM_BASE_URL`+`LLM_API_KEY` > 旧名 `LLM_ENDPOINT`+`LLM_KEY`（仍可用，会提示改名）
  > `OPENAI_BASE_URL`+`OPENAI_API_KEY` > `llm.json` >
  `my_site.json` 的 `llm_endpoint`/`llm_key`/`llm_model`（历史遗留，**此前代码从没读过**）。
  选中第一个带 key 的单元，base 取它自己的；**别的单元指了不同 origin 的 base 就直接报错**，
  不猜（`LLM_ALLOW_SPLIT_CONFIG=1` 可放行，自担风险）；
- `python3 llm_config.py` 直接看当前解析结果（key 只显示掩码）；
- 配置文件路径可用 env 覆盖：`LLM_CONFIG` / `OUTREACH_MY_SITE`。

### 配置界面（`python3 configure.py`）

管 `llm.json` 与 `my_site.json` 两个文件，带「测试连接」实测按钮。**它不在公开站
`index.html` 里**——那是要发 GitHub Pages 的纯静态页，浏览器写不了本地文件，
而且在公开域名的页面上放 API key 输入框本身就是坏模式。安全边界（别为省事去掉）：
只绑 `127.0.0.1`、每次启动生成一次性 token、Host 必须是环回地址（防 DNS 重绑定）、
Origin 跨源即拒、key 只回掩码、写文件 0600、**保留界面不认识的字段**（比如
`my_site.json` 里的 agentmail webhook 块）、页面零外部资源（否则 token 随 Referer 外泄）。

### 已知差异：远端端点的代理行为

Python 侧（`mail_sweeper` / `check_llm`）走 urllib，**认 `http_proxy`/`https_proxy`
环境变量**；Node 侧（`agent_submit`）用内置 fetch，**不认**。所以远端端点在两边的
出网路径可能不同（国内环境常见）。**本机端点（127.0.0.1/localhost）两边一致**——
Python 侧显式绕开了代理，否则设了代理的机器上「本机 Ollama/vLLM」必然探测失败
（代理回 503，错误信息还完全看不出是代理干的）。

要让 Node 侧也走代理得给 undici 配 dispatcher，会引入新依赖，目前没做。

## 纪律（踩过的坑沉淀）

- 验证码不硬碰：没配 capsolver_key 的验证码站 → manual 人工队列；
- 每域每天最多一次，域间 20-40 秒随机间隔；
- 只投实证页：清单全部来自"给竞品发过 dofollow"的页面（targets.py）；
- `delivery_ambiguous` 和 manual 队列在 `human_tasks.jsonl`，人工接活；
- 单站时间预算 `SUBMIT_MAX_MINUTES`（默认 8，driver 传 10）：看门狗触发点按 driver
  的 900s 包装硬杀倒推，超过约 12 分钟会被自动钳住（启动日志会说明）——要真跑更久，
  得连 driver.py 的 `timeout=900` 一起抬，否则 agent 会先被杀、终局落不了账；
- 提交后 1-4 周盯邮箱：收录审核大多要人工等，验证邮件不点 = 白投
  （`mail_sweeper.py --loop` 常驻自动点）；
- 别手改 state.jsonl；它是唯一状态源，重跑自动续。

## 老实交代

- LLM 决策质量取决于你给的端点；弱模型会在表单上烧步数（每站 24 步上限）；
- `pending_review` ≠ 上线：目录站审核 1-4 周，收录率本质低（我们私有库实测
  ~1% 终核上线），这个工具的价值是把"找到哪里能投+投出去"的成本降到零，
  转化靠持续投；
- 反检测件（抹 webdriver/逐字打字/流量治理）能降低被拦率，但不是隐身衣；
  Cloudflare 整页挑战要 capsolver + 代理同出口才有机会；
- 跑之前想清楚：批量提交目录站在某些站的 ToS 里是灰色地带，后果自负。
