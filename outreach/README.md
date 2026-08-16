# outreach/ — 半自动外链投放器

看完数据想动手？这个工具把"竞品的 dofollow 来源"变成你的投放清单。

## 用法

```bash
pip install playwright && playwright install chromium
cp my_site.example.json my_site.json   # 填你的站点信息
python3 targets.py                     # 从外链库生成工作清单(默认 ascore≥30,top 500)
python3 submit.py --limit 20           # 先小批试;--show 开有头模式观察
```

## 工作原理

1. **targets.py**：从 `data/library.json` 筛"给竞品发过 dofollow"的实证页——只要平台分类为 blog/cms/wiki/forum 的（这些才可能接受投稿/评论），同域去重，权重分降序
2. **submit.py**：playwright 开页面 → 规则识别表单（评论表单/提交表单）→ 用 `my_site.json` 填 url/名称/邮箱/简介 → 提交 → 记录结果
3. 状态全在 `state.jsonl`：done / done_unverified / manual(有验证码) / failed。重跑自动续，done 和 manual 不重复投

## 纪律（踩过的坑沉淀）

- 验证码不硬碰：检测到 recaptcha/hcaptcha/turnstile 直接进人工队列，别浪费配额也别硬刚
- 每域每天最多一次，域间 20-40 秒随机间隔
- 只投实证页：清单全部来自"给竞品发过 dofollow"的页面，不投来路不明的站
- 目录提交页的转化率远高于评论页；评论务必言之有物（LLM 接入后可生成上下文相关评论）

## 可选增强（my_site.json 里配）

- `llm_endpoint`：你自己的 OpenAI 兼容端点（本地网关或官方 API）——有了它,简介/评论可按目标页内容生成，转化率显著提升
- `capsolver_key`：验证码服务——有了它可尝试过验证码的站（默认跳过）

## 老实交代

- 表单识别是启发式的，对结构怪异的站会失败（记 failed，下轮重试，3 次放弃）
- `done_unverified` = 提交了但页面没出现成功关键词——人工抽查几个校准
- 目录站的收录审核周期从几天到几周不等，投放后记得隔周复查
