# AI 工具榜 · AI Tools Radar

AI 工具站增长情报库：按**真实流量数据**排名的 AI 工具目录——不是投票榜，不是广告位。

An open growth-intelligence site for AI tools: real traffic estimates, growth curves, channel mix, backlink intel. Free & open, runs locally, zero dependencies.

## 快速开始 · Quickstart

```bash
git clone https://github.com/ppop123/ai-tools-radar.git
cd ai-tools-radar
python3 -m http.server 8899
# 打开 http://127.0.0.1:8899/
```

任何静态 HTTP 服务都行（`npx serve`、`nginx`、GitHub Pages…）。**不要**直接双击 `index.html`——浏览器不允许 `file://` 页面 fetch 本地 JSON。

## 四个视图 · Views

| 视图 | 内容 |
|---|---|
| **总榜** | 15,000+ AI 工具站，月访问量/自然搜索流量/环比增长/反链/全球排名/域名注册时间，点行展开详情抽屉（12 月流量曲线、渠道构成、头部关键词） |
| **增长榜** | 按流量环比增速排序——谁在起飞一眼可见 |
| **新品雷达** | 近 90 天新注册的 AI 工具站，按域名注册时间排序 |
| **外链库** | 12,000 个真实给出过 dofollow 外链的页面；**输入竞品域名，查它全部 dofollow 来源**（已覆盖 1,100+ 站），总榜反链列可下载单域 CSV |

中英双语（右上角切换）。All views available in English via the toggle.

## 看完数据想动手 · Outreach tool

`outreach/` 是一套**生产验证过的外链投放管道**（LLM-in-the-loop 浏览器代理）：查竞品的 dofollow 来源 → 生成投放清单 → 浏览器代理自动提交 → 自动收验证邮件点链接 → 终核链接真上线。

```bash
cd outreach
npm install                                                # playwright-core 等
cp my_site.example.json my_site.json                       # 填站点资料 + AgentMail 收信配置
cp kit.example.json kit.json                               # 产品资料包(文案槽位/forbidden_claims)
cp identities.example.json identities.json                 # 投放 persona
export LLM_ENDPOINT=... LLM_KEY=... LLM_MODEL=...          # OpenAI 兼容端点(必填,代理决策和邮件理解都靠它)
python3 targets.py                                         # 生成投放清单
python3 driver.py --limit 5                                # 小批试跑(先 5 个看状态)
python3 mail_sweeper.py --loop                             # 常驻:收验证邮件/点验证链接
node verify_link.mjs --pending --kit kit.json              # 终核:链接真上线才记 success
```

开工准备（缺了别跑）：免费 AgentMail 账号（agent.qq.com，收验证邮件）+ `npm i -g @tencent-qqmail/agently-cli` 授权一次；OpenAI 兼容 LLM 端点；persona 身份。详见 `outreach/README.md`。

三条红线由代码硬执行，LLM 无权越过：付费站即停 / 文案过 forbidden_claims 闸门 / 验证码不让 LLM 编答案（无 capsolver key 进人工队列）。单次核验不判死——终核连续 3 次 offline 才算掉链。

## 数据说明 · Data notes

- 流量/排名/渠道数据为第三方流量估算服务的估计值（SimilarWeb 口径），仅供研究参考
- 反链明细来自 Semrush 口径的 dofollow 索引快照（2026-08）
- 数据快照日期见页面数据；本项目**只含数据快照**，采集管道依赖私有账号体系，未包含在本仓库
- `scripts/` 里的构建脚本展示了数据如何聚合（供参考/复刻），需要自己的数据源才能跑

## 目录结构 · Layout

```
index.html          # 单文件站点(全部 UI 逻辑)
data/data.json      # 站点榜单数据(15k+ 行)
data/library.json   # 外链库(12k 页面)
data/links/<domain>.json  # 单域 dofollow 明细(外链库按需加载)
data/links/index.json     # 有明细的域名清单
scripts/            # 数据聚合脚本(需要私有数据源,仅参考)
```

## License

代码 MIT。数据为第三方估算值的聚合快照，版权归原作者所有，仅供研究参考。
