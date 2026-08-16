# 继开源 AI 工具情报库之后，我把生产用的外链投放系统也开源了

上周发了一个 [AI 工具站情报库](https://github.com/ppop123/ai-tools-radar)（15,662 个站的真实流量 + 12 万条 dofollow 外链明细）。评论区最实在的反馈是：**看完数据然后呢？**

然后当然是动手发外链。但干过这活的都知道这里面有多少脏活：

- 每个目录站表单长得都不一样，逐站填到人麻
- 提交完一堆验证邮件，漏点一个就白投
- 过两周想不起来哪些投过、哪些上了、哪些掉了

我们内部跑这套流程跑了一个月，踩了无数坑，现在把这套**生产环境正在用的投放管道**整个开源出来，就在同一个仓库的 `outreach/` 目录。

## 它怎么用数据

情报库里有个"外链库"：12,000 个**真实给 AI 工具站发过 dofollow** 的页面（不是"可能接受投稿"的猜测，是实证）。工具干的第一件事就是从里面挑目标：

- 只收 blog/cms/wiki/forum 分类的页（新闻稿投了也没用）
- 带 submit/add/directory 路径的提交页排最前
- 同域去重、权重分排序，一键生成 500 个目标的清单

## 它怎么投

一个 **LLM 决策的浏览器代理**：打开目标页 → 观察 → LLM 决策 → 执行 → 再观察，像人一样处理每个站的表单变体。但有三条红线是代码硬执行的，LLM 无权越过：

1. **付费即停**：LLM 选了付费/结账动作，直接终止该站
2. **文案闸门**：所有填入内容必须过 forbidden_claims 正则，LLM 只能用你 kit 里的事实素材
3. **验证码不让 LLM 编**：声明类型后由代码走打码服务；没配打码 key 就进人工队列，不硬刚

投放身份按域轮换（persona 池），同一域名固定用同一个人——这是被 Akismet 跨站签名烧过域之后学到的。

## 它怎么收尾（这是和"脚本"最大的区别）

投出去只是开始。管道里还有两个生产件：

- **收信理解**：自动收目录站的邮件，LLM 判断意图（验证链接/收录通过/拒绝/要 badge），验证链接自动点——但有四条安全闸：只处理投过的域、链接必须同域且含验证词、跳转不许出域、幂等不重复点
- **终核器**：收录邮件说"通过"不算数。终核器去页面上找真实存在的 `<a href>`，四路探针（记录 URL→sitemap→站内搜索→路径枚举），还顺带判定 rel=nofollow——**nofollow 的收录不上账**。而且单次核验不判死，连续 3 次找不到才算掉链（都是血泪教训）

## 开工要准备什么（都免费）

1. OpenAI 兼容 LLM 端点（代理决策和邮件理解都靠它）
2. 一个 AgentMail 账号收验证邮件：agent.qq.com 或 agentmail.to 二选一，免费注册
3. 你的产品资料包（kit.json）和投放 persona（identities.json）
4. 本机有个 Chrome 就行

```bash
cd outreach
npm install && pip install agentmail curl_cffi playwright
# 配好 my_site.json / kit.json / identities.json + LLM_* 环境变量
python3 targets.py          # 生成清单
python3 driver.py --limit 5 # 先 5 个看状态
python3 mail_sweeper.py --loop   # 常驻收信
node verify_link.mjs --pending --kit kit.json   # 终核
```

## 说实话的部分

- 目录站收录率本质就低，我们生产实测终核上线率 ~1%。这套系统不提高转化率，它把**"找目标+填表单+盯邮件+核验"的时间成本**降到接近零——转化靠持续投
- 表单识别对结构怪异的站会失败，失败了会记录、最多重试 3 次
- 数据是 SimilarWeb/Semrush 口径的估算值，方向判断够用，别当精确值

仓库：https://github.com/ppop123/ai-tools-radar
在线看数据：https://ppop123.github.io/ai-tools-radar/

仓库里有 AGENTS.md——把仓库丢给 AI，它读完自己能把整套管道跑起来。有问题评论区聊。
