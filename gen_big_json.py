#!/usr/bin/env python3
"""生成一个约 2MB 的多类型、多字段、高复杂度 JSON 测试文件。

- 字段值都很短（字符串 ≤10 字符，数字 0-999），靠大量记录堆出体积
- 覆盖全部 JSON 类型：string / int / float / bool / null / array / object / 空容器
- 嵌套 6 层以上；输出为紧凑格式（无缩进），纯 ASCII，字节数可控

用法：python3 gen_big_json.py   （调整 TARGET / SEED 可改体积与随机序列）
"""
import json
import os
import random
import string

TARGET = 2 * 1024 * 1024          # 目标字节数：2,097,152
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "big_complex.json")
SEED = 42

random.seed(SEED)

CITIES = ["BJ", "SH", "GZ", "SZ", "CD", "HZ", "NJ", "WH", "XA", "CQ"]
LANGS = ["zh", "en", "jp", "fr", "de"]
THEMES = ["dark", "light", "auto"]
ACTS = ["login", "view", "click", "pay", "logout", "share"]


def rs(n: int) -> str:
    """随机短字符串"""
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=n))


def maybe(p: float = 0.8) -> bool:
    return random.random() < p


def dumps(x) -> str:
    return json.dumps(x, ensure_ascii=False, separators=(",", ":"))


def gen_event(j: int) -> dict:
    ev = {
        "ts": "2026-%02d-%02dT%02d:%02d:00Z" % (
            random.randint(1, 12), random.randint(1, 28),
            random.randint(0, 23), random.randint(0, 59)),
        "act": random.choice(ACTS),
        "ok": maybe(0.9),
        "dur": random.randint(1, 999),
    }
    if maybe(0.5):
        ev["detail"] = {"code": random.randint(100, 999), "msg": rs(8), "retry": maybe(0.2)}
    return ev


def gen_item(j: int) -> dict:
    it = {
        "sku": "S%d" % random.randint(100000, 999999),
        "qty": random.randint(1, 9),
        "price": round(random.uniform(1, 99), 2),
        "onSale": maybe(0.3),
    }
    if maybe(0.6):
        it["attr"] = {
            "color": random.choice(["red", "blue", "blk", "wht", "grn"]),
            "size": random.choice(["S", "M", "L", "XL"]),
            "weight": round(random.uniform(0.1, 5), 1),
        }
    return it


def gen_record(i: int) -> dict:
    rec = {
        "id": i,
        "uid": "u%06d" % i,
        "name": "rec-" + rs(6),
        "active": maybe(0.8),
        "verified": maybe(0.5),
        "score": round(random.uniform(0, 100), 1),
        "level": random.randint(1, 20),
        "ratio": round(random.random(), 3),
        "delta": random.randint(-50, 50),
        "deleted": None,
        "note": rs(10),
        "ts": "2026-10-27T00:00:00Z",
        "tags": [rs(3) for _ in range(random.randint(0, 4))],
        "nums": [random.randint(0, 99) for _ in range(random.randint(0, 5))],
        "flags": [maybe() for _ in range(random.randint(0, 3))],
        "mixed": [random.choice([1, "x", True, None, 1.5]) for _ in range(random.randint(0, 4))],
        "matrix": [[random.randint(0, 9) for _ in range(3)] for _ in range(random.randint(1, 3))],
        "address": {
            "city": random.choice(CITIES),
            "zip": str(random.randint(100000, 999999)),
            "geo": {
                "lat": round(random.uniform(20.0, 50.0), 4),
                "lng": round(random.uniform(100.0, 130.0), 4),
            },
        },
        "profile": {
            "age": random.randint(18, 60),
            "gender": random.choice("MFU"),
            "prefs": {
                "lang": random.choice(LANGS),
                "theme": random.choice(THEMES),
                "notify": maybe(),
                "freq": random.choice(["daily", "weekly", "off"]),
            },
        },
        "events": [gen_event(j) for j in range(random.randint(0, 3))],
        "items": [gen_item(j) for j in range(random.randint(0, 4))],
        "extra": {
            "k%d" % j: random.choice([rs(4), random.randint(0, 99), maybe(), None])
            for j in range(random.randint(1, 5))
        },
    }
    if maybe(0.3):
        rec["deep"] = {"l1": {"l2": {"l3": {"l4": {"v": random.randint(0, 9), "w": rs(3)}}}}}
    if maybe(0.1):
        rec["emptyObj"] = {}
    if maybe(0.1):
        rec["emptyArr"] = []
    if maybe(0.05):
        rec["opt"] = rs(5)
    return rec


def main() -> None:
    parts: list[str] = []
    total = len('{"meta":{},"records":[') + len("]}")   # 粗估包裹开销
    i = 0
    while total < TARGET:
        s = dumps(gen_record(i))
        total += len(s) + (1 if parts else 0)
        parts.append(s)
        i += 1

    meta = {
        "schema": "v1.2.0",
        "generated": "2026-10-27T00:00:00Z",
        "generator": "gen_big_json.py",
        "seed": SEED,
        "count": len(parts),
        "flags": {"compact": True, "ascii": True},
    }
    out = '{"meta":' + dumps(meta) + ',"records":[' + ",".join(parts) + "]}"

    # 微调：若明显超出目标就去掉最后一条记录
    while len(out) > TARGET and len(parts) > 1:
        parts.pop()
        meta["count"] = len(parts)
        out = '{"meta":' + dumps(meta) + ',"records":[' + ",".join(parts) + "]}"

    with open(OUT, "w", encoding="utf-8") as f:
        f.write(out)

    size = os.path.getsize(OUT)
    print("文件: %s" % OUT)
    print("大小: %d 字节 (%.2f MB)" % (size, size / 1024 / 1024))
    print("记录数: %d" % len(parts))


if __name__ == "__main__":
    main()
