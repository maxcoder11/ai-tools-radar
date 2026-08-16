# outreach/ — LLM-in-the-loop 外链投放管道

看完数据想动手？这个目录把"竞品的 dofollow 来源"变成你的投放清单，并用一个
**LLM 决策的浏览器代理**完成目录站提交：观察页面 → LLM 决策 → 执行 → 再观察，
像人一样处理每个站的表单变体。移植自一套生产验证过的私有管道，三条红线由代码
硬执行，LLM 无权越过：

1. **付费**：LLM 选择付费/结账类动作 → 直接 `skipped_paid` 终止；
2. **文案**：所有填入值必须过 `kit.json` 的 `forbidden_claims` 正则闸门，
   LLM 只能选预设槽位或基于 kit 事实组合；
3. **验证码**：LLM 只声明验证码类型，解题由代码走 CapSolver，不让 LLM 编答案；
   没配 `capsolver_key` → 该域标记 `manual` 进人工队列，不硬刚。

另有：投递认领（submit 类动作单发派发，防重复提交）、`delivery_ambiguous` 终态
（永不自动重投，人工裁决）、状态迁移守卫（投达态不许被辅助步骤异常打回
blocked/failed）、站点约束 TTL、成功打法沉淀 recipe 下次快放。

## 开工前必须准备（缺了别跑）

1. **OpenAI 兼容 LLM 端点**（必填）：环境变量 `LLM_ENDPOINT` / `LLM_KEY` /
   `LLM_MODEL`（可选降级链 `LLM_FALLBACKS`，逗号分隔）。提交代理每一步都靠它决策，
   邮件理解也靠它判意图；
2. **一个 AgentMail 信箱，二选一**（都免费，收验证/审核邮件）：
   - `agent.qq.com`（默认）：注册账号 → `npm install -g @tencent-qqmail/agently-cli`
     → `agently-cli auth login` 授权一次（`auth status` 可查状态）；
   - `agentmail.to`：`console.agentmail.to` 注册拿 API key（am_ 开头）+
     inbox_id，填 `my_site.json` 的 `mail_backend:"agentmail"` /
     `agentmail_api_key` / `agentmail_inbox_id`（或 env `AGENTMAIL_API_KEY` /
     `AGENTMAIL_INBOX_ID`）；REST 直连零 SDK。⚠️ 此后端按官方文档编写，**未实测**；
   `mail_sweeper.py` 自动收信、LLM 判意图、点验证链接
   —— 四条安全闸别动（只处理投过的域 / 链接注册域=发件域且路径含验证词 /
   跳转逐跳不出域 / message-id 幂等）；
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
  各供应商日预算熔断 $50（`CAPSOLVER_DAILY_BUDGET_USD` 等可调）；
- `HTTPS_PROXY`：出站代理。⚠️ 用 Cloudflare 整页挑战解题时必须配——
  `cf_clearance` 绑定 IP+UA，浏览器和解题必须同一出口。

## 用法

```bash
cd outreach
npm install                                  # playwright-core
cp my_site.example.json my_site.json         # 填 capsolver(可选);信箱走 agently-cli
cp kit.example.json kit.json                 # 填你的产品资料(红线文案在此)
cp identities.example.json identities.json   # 填你的 persona 池
export LLM_ENDPOINT=... LLM_KEY=... LLM_MODEL=...

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
- 三态：`online` / `offline_confirmed`（sitemap 可读或 ≥10 页明确结论才判）/
  `unknown_network` / `unknown_blocked` —— 判不了的绝不写成"未上线"；
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
- `delivery_ambiguous`：submit 已派发但终局未定 —— **永不自动重投**，人工裁决；
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
| `mail_sweeper.py` | scripts/mail_sweeper.py | 邮件理解；双后端收信(agently-cli / agentmail.to REST,后者未实测) |
| `read_otp.py` | scripts/read_otp.py | 给 agent 取验证码/验证链接 |
| `driver.py` | scripts/rolling_submit.py 简化 | 滚动驱动：选池/节流/退避/persona 轮换 |
| `verify_link.mjs` | node-tools/verify_link.js | 终核器：四路探针 + 三态 + nofollow 判定 |
| `esp_hosts.json` | scripts/esp_hosts.json | ESP 跳转域白名单（唯一来源） |

### driver.py 对照生产 rolling_submit.py 的取舍

**已带（生产能力）**：每域每天一次、域间 20-40s、persona 按域 hash 轮换 +
评论作者网址池（`AUTHOR_URL_POOL`，评论腿注入 IDENTITY_FORCE，目录腿不覆盖）、
429/LLM 瞬态退避 60s、打码预算熔断停波（exit 42）、写账失败不补记（exit 43）、
无声退出兜底补记 blocked（SILENT_SKIP_MARKERS 豁免）、900s 包装超时补记、
逐域完整日志落 `run/agent_logs/`。

**未包含（私有基建，不带）**：代理节点池轮换（mihomo/Surge，本机 7891/8234）、
CF 签名站的住宅出口重投与 cloak 指纹内核救援（依赖私有二进制和家庭宽带出口）、
远程核验模式（VERIFY_JOB）。这些与你的网络环境强绑定，开源版用 `HTTPS_PROXY`
单代理替代；CF 挑战多的话自己配静态住宅代理。

## 纪律（踩过的坑沉淀）

- 验证码不硬碰：没配 capsolver_key 的验证码站 → manual 人工队列；
- 每域每天最多一次，域间 20-40 秒随机间隔；
- 只投实证页：清单全部来自"给竞品发过 dofollow"的页面（targets.py）；
- `delivery_ambiguous` 和 manual 队列在 `human_tasks.jsonl`，人工接活；
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
