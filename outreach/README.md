# outreach/ — 半自动外链投放器

看完数据想动手？这个工具把"竞品的 dofollow 来源"变成你的投放清单。

## 开工前必须准备（缺了别跑）

1. **一个能收信的邮箱 + 它的 IMAP 配置**：目录站提交后发验证/审核邮件，`mailbot.py` 自动收、自动点验证链接（安全闸：只处理投过的域、链接不出域、幂等）。自己的 Gmail（应用专用密码）/QQ 邮箱（授权码）即可，或注册 agentmail(agently) 账号专门收
2. **一套 persona 身份**：投放用的名字/邮箱/个人网址（`my_site.json` 的 `persona` 段）。别用主身份裸奔；量大的话准备 2-3 套轮换（同域同 persona，防标记）
3. **你的站点资料**：名称、URL、一句话卖点、两三句简介（填 `my_site.json`）
4. 浏览器：`playwright install chromium`，或设 `CHROME_BIN` 指向本机已有 Chrome/Chromium

可选增强：

- `llm_endpoint/key/model`：你自己的 OpenAI 兼容端点——按目标页内容生成简介/评论，转化率显著提升
- `capsolver_key`：验证码服务——有了才尝试过验证码的站（默认跳过进人工队列）

## 用法

```bash
pip install playwright && playwright install chromium
cp my_site.example.json my_site.json   # 填好上面的准备项
python3 targets.py                     # 生成 worklist.jsonl(tier1 提交页优先)
python3 submit.py --limit 5 --show     # 先 5 个有头模式亲眼验证
python3 submit.py --limit 50           # 没问题再放量
python3 mailbot.py --loop              # 常驻:自动收验证邮件、点验证链接
```

**完整闭环**：submit.py 投放 → 站点发验证邮件 → mailbot.py 自动收信点链接 → state.jsonl 记 `email_verified`。
收录通过/拒绝的邮件也会按规则分类记录（approved/rejected），每天看一眼 state.jsonl 就知道战果。

## 工作原理

1. **targets.py**：从 `data/library.json` 筛"给竞品发过 dofollow"的实证页——平台分类为 blog/cms/wiki/forum 的才收；同域去重；分两层（tier1=带 submit/add/directory 等提交入口的页，tier2=高权重机会页）
2. **submit.py**：playwright 开页面 → 规则识别表单（评论/提交两类）→ 按 `my_site.json` 填充 → 提交 → 记录结果到 `state.jsonl`
3. 状态：done / done_unverified / manual(验证码) / failed。重跑自动续，done/manual 不重投

## 纪律（踩过的坑沉淀）

- 验证码不硬碰：检测到 recaptcha/hcaptcha/turnstile 直接进人工队列
- 每域每天最多一次，域间 20-40 秒随机间隔
- 只投实证页：清单全部来自"给竞品发过 dofollow"的页面
- 提交后 1-4 周盯邮箱：收录审核大多要人工等，验证邮件不点 = 白投

## 老实交代

- 表单识别是启发式的，结构怪异的站会失败（记 failed，3 次后放弃）
- `done_unverified` = 提交了但未见成功关键词——抽查几个校准
- tier2 机会页很多没有可用表单（新闻稿等），失败率高是预期行为，不是 bug
- 收录率本质低：我们私有库实测 ~1% 终核上线，这个工具的价值是把"找到哪里能投"的成本降到零，转化靠持续投
