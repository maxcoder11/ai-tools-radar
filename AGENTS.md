# AGENTS.md — 给 AI agent 的操作手册

把这个项目丢给 AI 时，读这个文件就够了。

## 跑起来（唯一需要做的事）

```bash
cd <本目录> && python3 -m http.server 8899
# 浏览器打开 http://127.0.0.1:8899/
```

- 纯静态，无依赖、无构建、无 npm。
- 必须用 HTTP 服务打开；`file://` 直接双击打不开数据（fetch 限制）。
- 验证方式：`curl -s http://127.0.0.1:8899/data/data.json | head -c 200` 返回 JSON 即正常。

## 结构

- `index.html` — 全部 UI（原生 JS，无框架）。四个视图：总榜/增长榜/新品雷达/外链库。
- `data/data.json` — 站点数组。每行字段：
  `domain, name, desc_zh, desc_en, categories[], free, signup, visits, clicks, bl, bl_blog, global_rank, sem_traffic, sem_positions, mix{organic,direct,…}, monthly[[YYYY-MM-DD,visits]…], mom, kw[{n,v,c}], listed_month, n_dirs, registered, organic, dr`
- `data/library.json` — 外链库页面数组：`url, src, title, plat, ascore, nt, targets[{d,a}], seen`
- `data/links/<domain>.json` — 单域 dofollow 明细：`[{u,s,a,p,s2,f}]`（u=来源页,s=标题,a=锚文本,p=平台,s2=权重分,f=首见 epoch 秒）
- `data/links/index.json` — 有明细的域名清单（字符串数组）。

## 改 UI 时的注意点

- index.html 里 fetch 路径全部以 `data/` 开头，移动文件要同步改。
- 数据文件加了 `?t=<timestamp>` 防缓存，别去掉。
- 新视图加进 `VIEWS` 数组 + `SORTS` 映射 + I18N 双语键（zh/en 都要）。
- 截图自测（有 playwright-core 的话）：起服务后访问四个 tab 各截一张。

## outreach/（外链投放工具）

用户看完数据要投放时用这个：

```bash
cd outreach && pip install playwright && playwright install chromium
cp my_site.example.json my_site.json   # 必须先把示例站信息改成用户自己的
python3 targets.py && python3 submit.py --limit 5 --show
```

**开工前确认用户已准备**（缺了别跑）：能收验证邮件的邮箱（自己的或 agentmail/agently 账号）、
persona 身份（author_name/email/site）、站点简介。验证邮件需要用户人工点链接，工具不代收。

- `my_site.json` 里的 name/url/description/email/persona 必须替换成用户真实信息,别用示例值投
- 先 `--limit 5 --show` 有头验证,没问题再放量;state.jsonl 是唯一状态源,别手改
- manual(验证码)队列就交给用户人工处理,不要尝试自动过码
- 改表单识别逻辑在 submit.py 的 FIELD_MAP / JS_FILL;tier 分层在 targets.py

## 数据更新

本仓库只含数据快照。`scripts/` 下的聚合脚本（build_data / build_link_library / build_links_split）
演示了聚合逻辑，但它们读的是私有数据湖（backlinks-v2/datasets），外部跑不了。
要换自己的数据：按上面的 JSON 字段格式生成 `data/data.json` 即可，UI 不用动。

## 免责声明

流量/排名/反链数据为第三方服务估算值，仅研究参考，别当精确值引用。
