#!/usr/bin/env python3
"""可注册域(根域)判定 —— 全项目**唯一**口径,基于官方 Public Suffix List。

## 两个概念,别混

  root_domain()   = **注册人身份**。ICANN + PRIVATE 段都算后缀。
                    `a.github.io` 和 `b.github.io` 是两个不同的人 → 两个根域。
                    用途:去重、判"是不是同一家"、安全校验(如验证链接必须落在本站)。

  quota_bucket()  = **SEO 引荐域**。只用 ICANN 段。
                    `a.github.io` 和 `b.github.io` 折成 `github.io` 一个桶 ——
                    对 Google 它们是一个引荐域,拿 N 条同域链 ≈ 拿 1 条的价值。
                    用途:同根域投放配额。

## 为什么走 PSL 而不是手写规则

2026-07-26 之前项目里有两套不一致的实现:`mail_sweeper.base_domain` 有一张手写的
多段后缀表(2026-07-25 才修,因为原来 `evil.co.uk` 和 `findtheneedle.co.uk` 判"相等"),
而投放侧 `dbw.js` 的 `canonDomain` 只剥 `www.` —— 同一个概念两个答案。

第一次尝试补表时用启发式(`<公共SLD>.<ccTLD>`),实测把 `web.cafe` / `go.dev` /
`store.app` / `gen.ai` / `info.link` 误判成公共后缀 —— 那会把不同注册人的域名合并成
一个桶,配额闸就会误杀正经资源。这类表只能用权威源,不能靠猜。

数据在 `psl_data.py`(生成物,勿手改)。零新依赖。

相关:[[string-containment-cannot-infer-identity]]
"""

import re

from psl_data import (ICANN_MULTI, PRIVATE_MULTI, WILDCARD, EXCEPTION,
                      WILDCARD_I, WILDCARD_P, EXCEPTION_I, EXCEPTION_P)

# 身份判定用全集;配额只用 ICANN 段。
# ⚠️ 通配/例外也必须分段:PSL 的 265 条通配里绝大多数在 PRIVATE 段
# (如 *.compute.amazonaws.com)。quota_bucket 若读到它们,
# a.x.compute.amazonaws.com 会保持独立桶而不折叠到 amazonaws.com,绕过根域配额
# (Codex 2026-07-26 [P2])。
ALL_MULTI = ICANN_MULTI | PRIVATE_MULTI
_ALL_WILD, _ALL_EXC = WILDCARD, EXCEPTION
_ICANN_WILD, _ICANN_EXC = WILDCARD_I, EXCEPTION_I

# 向后兼容:mail_sweeper 早期从这里取名字
MULTI_SUFFIX = ALL_MULTI
ICANN_SUFFIX = ICANN_MULTI


def host_of(d):
    """从域名/URL 取纯 host:小写、去协议/路径/端口/尾点/邮箱前缀。"""
    s = (d or "").strip().lower()
    s = re.sub(r"^[a-z][a-z0-9+.-]*://", "", s)
    s = s.split("/")[0].split("?")[0].split("#")[0].split("@")[-1]
    return re.sub(r":\d+$", "", s).rstrip(".")


def _public_suffix_len(parts, multi, wild, exc):
    """这个域名的公共后缀占几段。按 PSL 规则:例外 > 通配 > 精确 > 默认单段。"""
    # 例外规则(!city.kawasaki.jp):后缀比通配少一段
    for i in range(len(parts)):
        if ".".join(parts[i:]) in exc:
            return len(parts) - i - 1
    # 通配规则(*.ck):后缀是 通配基 + 1 段
    for i in range(1, len(parts)):
        if ".".join(parts[i:]) in wild:
            return len(parts) - i + 1
    # 精确多段后缀,从长到短匹配
    for i in range(len(parts) - 1):
        if ".".join(parts[i:]) in multi:
            return len(parts) - i
    return 1                       # 默认:单段 TLD


def _fold(d, multi, wild, exc):
    parts = [p for p in host_of(d).split(".") if p]
    if len(parts) < 2:
        return host_of(d)
    n = _public_suffix_len(parts, multi, wild, exc)
    keep = min(n + 1, len(parts))   # 公共后缀 + 一段 = 可注册域
    return ".".join(parts[-keep:])


def root_domain(d):
    """注册人身份用的可注册域(ICANN + PRIVATE 后缀,含两段的通配/例外)。"""
    return _fold(d, ALL_MULTI, _ALL_WILD, _ALL_EXC)


def quota_bucket(d):
    """SEO 引荐域用的桶(只认 **ICANN 段**的后缀/通配/例外)。"""
    return _fold(d, ICANN_MULTI, _ICANN_WILD, _ICANN_EXC)


def is_subdomain(d):
    """这个域名是不是某个根域的子域(而非根域本身,www. 不算)。"""
    h = host_of(d)
    if not h:
        return False
    return h != root_domain(h) and h.removeprefix("www.") != root_domain(h)


def same_root(a, b):
    ra, rb = root_domain(a), root_domain(b)
    return bool(ra) and ra == rb


if __name__ == "__main__":
    import sys
    for d in sys.argv[1:]:
        print(f"{d:38s} root={root_domain(d):30s} quota={quota_bucket(d):22s} sub={is_subdomain(d)}")
