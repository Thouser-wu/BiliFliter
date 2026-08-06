# 模型对比测试：deepseek-r1:1.5b vs qwen3:4b 弹幕判断质量
# 使用与扩展完全相同的 medium 提示词模板和 API 参数
import json, time, urllib.request

OLLAMA = "http://localhost:11434/api/chat"

PROMPT_MEDIUM = """你是一个B站弹幕审核助手。请判断以下弹幕是否有价值。
只输出JSON：{"keep": true/false, "reason": "简短原因"}
过滤以下无意义弹幕：
- 打卡/签名类：弹幕只要包含"一日游"、"到此一游"、"打卡"、"签到"、"留名"、"占位"、"路过"、"考古"等词，无论带什么人名或前缀（如"张三在弹幕里这里一日游"、"2023年考古路过"），都属于打卡弹幕，一律过滤
- 水弹幕：无意义的"来了"、"前排"、"打卡"、"1"、"哈哈哈"
- 纯表情/emoji、无意义重复
- 没有实质内容的凑字数弹幕
保留：有观点的评论、科普知识、对视频内容的讨论、幽默有趣的弹幕。
拿不准时倾向保留，避免误杀有内容的弹幕。
示例：
"黄茂坤在弹幕里这里一日游" → {"keep": false, "reason": "打卡一日游"}
"这个转场设计太妙了" → {"keep": true, "reason": "有观点"}
"前排" → {"keep": false, "reason": "水弹幕"}"""

# (弹幕, 期望: True=应保留)
CASES = [
    # 打卡类 → 应过滤
    ("黄茂坤在弹幕里这里一日游", False),
    ("打卡", False),
    ("路过", False),
    ("前排", False),
    ("留名纪念这个视频", False),
    ("2023年考古路过", False),
    ("我来签个到", False),
    ("李四在弹幕里占个坑", False),
    # 有价值 → 应保留
    ("这个转场设计太妙了", True),
    ("第一次看这个UP主的视频", True),
    ("这段代码的算法复杂度是O(n)", True),
    ("哈哈这个梗我懂", True),
    ("路过的大佬能讲讲吗", True),
    ("这个细节分析得很到位", True),
    ("前排提示：这里有个彩蛋", True),
]

def call_model(model, text):
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": PROMPT_MEDIUM},
            {"role": "user", "content": f'请判断以下弹幕是否有价值：\n"{text}"'},
        ],
        "stream": False,
        "think": False,
        "format": "json",
        "options": {"temperature": 0.3, "num_predict": 50},
    }).encode()
    req = urllib.request.Request(OLLAMA, data=body, headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read())
    dt = time.time() - t0
    content = data.get("message", {}).get("content", "") or data.get("message", {}).get("thinking", "")
    parsed = None
    try:
        import re
        m = re.search(r"\{[^}]+\}", content)
        if m: parsed = json.loads(m.group(0))
    except Exception:
        parsed = None
    return parsed, dt

def run(model):
    print(f"\n{'='*60}\n模型: {model}\n{'='*60}")
    tp = tn = fp = fn = 0
    total_time = 0.0
    for text, expect_keep in CASES:
        parsed, dt = call_model(model, text)
        total_time += dt
        if not parsed or "keep" not in parsed:
            print(f"  ⚠ 无法解析 [{text}] -> {parsed} ({dt:.1f}s)")
            continue
        keep = bool(parsed.get("keep"))
        reason = parsed.get("reason", "")
        correct = (keep == expect_keep)
        if correct:
            if keep: tp += 1
            else: tn += 1
            mark = "✓"
        else:
            if keep: fp += 1
            else: fn += 1
            mark = "✗"
        exp = "保留" if expect_keep else "过滤"
        act = "保留" if keep else "过滤"
        flag = "" if correct else f"  <<< 期望{exp}"
        print(f"  {mark} [{act}] {text} ({reason or '无理由'}) {dt:.1f}s{flag}")
    acc = (tp + tn) / len(CASES)
    print(f"\n  准确率: {acc:.0%} ({tp+tn}/{len(CASES)}) | 误杀: {fp} | 漏网: {fn} | 平均耗时: {total_time/len(CASES):.2f}s")
    return acc

if __name__ == "__main__":
    import sys
    models = sys.argv[1:] or ["deepseek-r1:1.5b", "qwen3:4b"]
    results = {}
    for m in models:
        try:
            results[m] = run(m)
        except Exception as e:
            print(f"\n模型 {m} 测试失败: {e}")
    print("\n\n==== 总结 ====")
    for m, acc in results.items():
        print(f"  {m}: {acc:.0%}")
