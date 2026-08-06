# BiliFliter 弹幕过滤扩展 — Handoff 交接文档

> 生成时间：2026-08-05 · 由 Hermes Agent 会话总结
> 项目路径：`D:\BiliFliter` · 浏览器：Chrome/Edge（MV3）

## 一、项目概述

自研 B 站弹幕过滤扩展（MV3）。**100% 本地化、隐私优先**（弹幕不出本机，AI 走本地 Ollama qwen3:4b）。过滤链：`DOM 节点捕获 → preHide(渲染前 opacity:0) → ①正则 → ②固定规则 → 2.5 屏蔽词(本地 includes) → 2.6 双阈值刷屏 → AI 批量(异步)`。

用户核心诉求（必须尊重）：
- **屏蔽词 = 完全本地确定性匹配（text.includes），实时同步，不依赖 Ollama**；**屏蔽提示词 = 用户原始一句话描述注入 AI system prompt**。两条链路分离。
- **统计恒等式必须严格成立**：`已处理 = 已过滤(正则+固定+屏蔽词+刷屏+AI) = 已保留`，明细合计 = 总数（用户反复验证）。
- 用户坚持拦所有含"我"的弹幕（不要移除"我"屏蔽词）。
- popup 无"重载页面"按钮；「🔄 重新同步」按钮保留。
- 速度敏感：AI 批量 3+并发 2、队列上限 20 超限直接放行（宁可漏杀不积压）。

## 二、当前文件状态（全部 node --check OK）

| 文件 | 说明 |
|---|---|
| `manifest.json` | **v1.1.0**；MV3；`all_frames: true`（本轮加，iframe 弹幕兜底）；权限 storage/activeTab/scripting；host 仅 B 站 + localhost:11434 |
| `content.js` | 核心过滤引擎（40+ 函数）。详见下方"本轮修复清单" |
| `background.js` | Service Worker：bf_check_ollama/bf_list_models/bf_call_ai_batch、buildPromptWithPromptRules（【用户屏蔽要求 - 优先级最高】区块）、默认模型 qwen3:4b |
| `popup.html/js/css` | 版本自检状态行（✅ v1.1.0 已注入本页）、屏蔽词+提示词双 section、统计行、「查看被过滤的弹幕」「查看已保留的弹幕」双列表 |
| `README.md` | **未更新**新架构（promptRules/批量队列/双阈值刷屏/统计模型）——待办 |
| `bench_models.py` | 模型对比脚本（保留） |

## 三、本轮会话修复清单（2026-08-05，含此前 compacted 会话的最终形态）

### A. 统计恒等式修复（已处理 = 已过滤 + 已保留）

最终采用**简化统计模型**（content.js `processDanmaku`）：

1. **每次判定（含文本变化重判 = 复用节点上的新弹幕）`stats.seen += 1`**——保证 B 站密集弹幕（复用池）统计持续增长，不再"瓶颈"。
2. **filtered/kept 按判定结果 +1**（重判拦 → filtered+1；重判放 → kept+1），移除旧的"翻转调整"逻辑。
3. **AI 转计保持总量**：弹幕入 AI 队列时 `kept+1`（瞬时平衡）；AI 判定 keep:false 时 `kept-1, filtered+1, aiFiltered+1`（总量不变 → 恒等式恒成立）。
4. **`aiJudgedElements` WeakSet**：AI 已转计的弹幕，本地重判不再重复转计（修"明细≠总数"：1+1+34+0+3=39 vs 总数 38）。
5. `keptDanmakus` 列表每次判定同步（复用节点新弹幕更新列表，旧文本移除）。

回归测试场景（node vm 提取 processDanmaku 验证）：正常放行/屏蔽词拦截/节点复用×3/分段先放后拦/复用放拦放/AI 保留/AI 拦截转计/AI+复用放行/单字/缓存命中/队列满——**全部恒等式成立 + 列表同步正确**。

### B. "弹幕消失/不显示"修复

| 根因 | 修复 |
|---|---|
| preHide 重复触发（主/容器/shadow 多 observer 对同节点多次 preHide，第二次后去重返回不 restore → 永久透明） | preHide 仅首次；**去重返回时兜底 `restoreVisibility`**（若 lastDecisionMap=false） |
| B 站"先建空节点再 textContent 填充"（Text 节点 addedNodes 被丢弃） | 处理 Text 节点，取其弹幕父元素走过滤链 |
| 分段填充（"这版大家觉"→"得如何，我太喜欢了"）首判后永久去重 | `lastJudgedText` 文本级去重（文本变化才重判） |
| **B 站复用池**：密集弹幕改旧节点文本（characterData，非 childList）→ 全部漏 + 统计停 | observer 加 `characterData: true`，Text 变化 → 重新判定 |
| 复用节点 display:none 残留（隐藏节点被复用渲染新弹幕 → 永远不可见） | `restoreVisibility` 改用 `removeProperty` 清 display/opacity/pointer-events |
| 多 observer 重复 preHide 后 opacity:0 残留（放行弹幕不显示） | 去重返回兜底 restore（同上） |

### C. "统计停止增长/瓶颈"修复

**根因**：B 站弹幕密集时用**节点复用池**（characterData 改文本渲染新弹幕），observer 只监听 childList → 复用弹幕完全漏掉 → 弹幕显示（漏网）+ 统计不涨。
**修复**：characterData 监听（见 B）+ 统计模型 seen 每次判定 +1（见 A）。

### D. "漏网之鱼"修复（本视频 BV1Enpxz5Ef3 实测驱动）

| 根因 | 修复 |
|---|---|
| **单字屏蔽词全漏**：`text.length <= 1` 直接放行，不查屏蔽词 → "中"（单字屏蔽词）全漏 | 单字分支加屏蔽词检查（`state.blockwords.find(w => text.includes(w))`）→ 手动验证"中"→ display:none ✅ |
| **B 站 JS 每帧写弹幕 style 覆盖 display:none**（attributes 465 次/25s）→ 存量弹幕拦不住 | `hideDanmaku` 改用 `setProperty(..., 'important')` + observer attributes 监控被拦节点（style 变化 → 重新隐藏） |
| **class 激活漏**：B 站节点插入时 class 未就绪，激活时才加 `bili-danmaku-x-dm`（实测 5 次 class 变化） | observer 加 `attributes: true`，class 变弹幕 class → 补处理 |
| **SPAN 分段（UP主弹幕）**：Text 节点父是 SPAN（class 不匹配）→ 丢弃 | Text 节点**向上查找弹幕祖先**（while 循环到 .bili-danmaku-x-dm） |
| iframe 弹幕 | manifest `all_frames: true` |
| **容器误隐藏**：`[class*="danmaku"]` 匹配轨道容器 `.bili-danmaku-x-pa` → 容器 textContent 全弹幕拼接含屏蔽词 → 隐藏整个弹幕层 → 全部消失 | queryDanmakuIn 去掉通配选择器（只用精确 class）+ 叶子保护（含弹幕子元素=容器跳过）+ hideDanmaku 容器保护（最后防线） |
| **正则误杀**：`^[^\D69]{1,3}$` 中 `[^\D69]` 匹配所有汉字（"好听"/"牛"/"绝"全拦） | → `^[0-578]{1,3}$`（只拦 111/888 类数字刷屏，666/999 由套路口令/刷屏处理） |
| "抽我"等抽奖变体不含"抽奖"子串 | **非代码问题**：建议用户用屏蔽提示词（AI 语义）"屏蔽抽奖/求中奖类弹幕" |

### E. 功能新增

- **「查看已保留的弹幕」**按钮（popup）：显示最近 200 条保留弹幕（keptDanmakus，绿色边条）。
- **popup 列表显示修复**：列表容器默认 display:none，"查看已保留"点击时 `display:block`（之前必须先后点"查看被过滤"才显示）。

## 四、测试基线与方法论

- **统计回归**：node vm 提取 processDanmaku 单测（弱依赖 mock），11+ 场景全过。
- **手动弹幕注入**：单字"中"→none、双字"恭喜抽奖"→none、正常→flex ✅。
- **真实页面注入**（base64+atob 方案）：不含屏蔽词 16/16 显示；含屏蔽词大部分拦截。
- **Playwright 硬约束**：`window.chrome` 是只读属性（configurable:false），main world 无法覆盖 → 注入测试必须**源码替换 `chrome.*` → `window.__bfStub.*`** 才真实有效。
- run-code 限制：顶层不能声明、无 require、无 Buffer → Python 生成器 base64 内嵌 + 页面 atob+TextDecoder 解码。
- **代码卫生**：heredoc 转义反复出错（`\n` 变真实换行、`\S`/`\1` 变单反斜杠/控制字符）→ 一律 **write_file 写独立 .py 修复脚本**（占位符替换 `__B64__` 等，不用 f-string 嵌套 JS）。

## 五、遗留问题与下一步

1. **用户待验证**（最新一轮修复）：单字屏蔽词、!important 隐藏、attributes 监控——用户需刷新扩展 + 页面后实测 BV1Enpxz5Ef3（屏蔽词"中""抽奖"）。
2. **"UP主弹幕"普通版节点**：B 站对 UP 主弹幕做特殊渲染（普通版 + UP主标记版两个节点），普通版在特定时序下仍可能漏（占比小，~10%）。手动复现同结构（分段+SPAN）全部拦截。若用户仍报漏，需提供具体弹幕文本定点修。
3. **存量弹幕**滚出屏幕后无法追溯（设计如此）；新弹幕走 observer 链会被拦。
4. **AI 弹幕 0.95s/批延迟**（先显示后判定）——设计取舍；用户嫌慢可关 AI 只用本地规则。
5. **README.md 未更新**新架构（promptRules 注入文案、批量队列、双阈值刷屏参数、统计模型、单字屏蔽词、!important 策略）。
6. `IDEA.md` 存在但内容未知，可参考。

## 六、关键参数（最终形态）

- 刷屏：归一化链（去尾标点→全角转半角→去空格→口令 `^23{2,}$`→2333、`^6{3,}$`→666→英文笑声 hhh/hahaha→哈哈、hehehe→呵呵、xixixi→嘻嘻→纯单字符重复归一到 2 字）；双阈值——刷屏词（归一化后 ∈ 哈哈/66/2333 等）第 3 条起拦（REPEAT_THRESHOLD=2），正常文本只拦完全相同、第 6 条起拦；30s 窗口、簇上限 100、无编辑距离合并。
- AI：批量 3 + 并发 2 + 队列上限 20 超限放行；5000 条缓存；默认保留倾向；AI 判定用**最新文本**（分段弹幕防误杀）。
- 存储键：`bulletfilter_settings` / `bulletfilter_blockwords` {global, video} / `bulletfilter_prompt_rules` {global: [], video: {BV号: []}}；`bulletfilter_intent_rules` 已作废；aiModel 旧值 deepseek-r1:1.5b 可能残留需重选。
- 环境：RTX 3060 Laptop 6GB / 16GB / i7-12650H；Ollama localhost:11434（qwen3:4b ~2.5GB、deepseek-r1:1.5b）；OLLAMA_MODELS=D:\ollama\ollama_models。

## 七、建议 skills（下一会话应加载）

- `bilibili-danmaku-filter` — 项目专属技能，开发/调试 BiliFliter 必读
- `playwright-cli` — 浏览器注入测试（run-code + base64 方案，chrome.*→__bfStub 替换）
- `browser-extension-dev` — MV3 扩展开发规范
- `windows-gitbash-file-editing` — Windows Git Bash 下改文件（避免转义损坏）
- `systematic-debugging` — 复杂 bug 分阶段定位方法论

## 八、对用户的操作提醒（每次改完代码）

1. `chrome://extensions` 刷新扩展（版本自检行会显示"未注入"提示）
2. **必须**刷新 B 站页面（Chrome 硬机制：重载扩展会杀掉已注入 content script，但不会重新注入到已打开页面）
3. 两个刷新缺一不可；popup 顶部版本自检行可确认注入状态（✅ v1.1.0 已注入本页）


---

## 九、后续会话更新（2026-08-06）

### 当前真实版本与校验

- `manifest.json` / content script `bf_ping`：**v1.1.9**。
- 本轮结束前已运行：`node --check content.js background.js popup.js`，通过。
- 工程目录不是 git 仓库；不要假设可用 git diff/commit 恢复历史。
- 本文档保持 UTF-16 编码；普通文本读取工具可能将其误报为二进制，编辑时需显式按 UTF-16 读写。

### 已确认的真实页面证据（BV1Enpxz5Ef3，约 70-100 秒）

1. 用户设置本地屏蔽词 `中` 与 `抽`；`抽`稳定不显示，但 `中` 在约 80-90 秒后重新可见。
2. 动态 Playwright 采样确认该时段的“中”仍为主文档标准节点：
   - class 流程：`.bili-danmaku-x-dm` → `.bili-danmaku-x-dm bili-danmaku-x-center` → 添加 `.bili-danmaku-x-show`。
   - 父节点：`.bpx-player-row-dm-wrap`。
   - 可见漏网节点曾被观测为 `display:flex`、没有 `data-bf-blocked` 标记。
3. 最新用户 popup 诊断数据：
   ```text
   已处理：484
   已过滤：390（正则 12 / 固定 0 / 屏蔽词 372 / 刷屏 4 / AI 2）
   已保留：94
   诊断：扫描 191 / 标准节点 42 / 屏蔽命中 6523 / 隐藏调用 10173 / 最近命中「每日一中」
   ```
4. 因此已排除“watchdog 停止”“屏蔽词没加载”“找不到标准节点”。`屏蔽命中`与`隐藏调用`持续增长，但用户仍看到“中”，说明存在**隐藏与恢复可见性之间的状态竞争**，或用户看到的是不带相同 DOM 节点的另一个视觉层。切勿再仅靠扩大选择器猜测。

### 本轮实现变更（v1.1.1 → v1.1.9）

| 类别 | 变更 |
|---|---|
| 多 frame 统计 | popup 对 `bf_ping`、统计、列表请求固定 `{frameId: 0}`；避免从 iframe 读到独立的 0 统计。 |
| 选择器边界 | `.dm-text` 等兼容类只有在弹幕轨道内才可作为候选，防止视频信息区/轨道容器误入隐藏管道。 |
| 节点复用 | 文本变化时清 `hiddenElements`，避免旧过滤节点复用为新正常弹幕后被 style observer 再次隐藏。 |
| 屏蔽词 | 去零宽字符后匹配；storage 更新后重扫存量；每次周期扫描都独立执行确定性屏蔽词 watchdog（不重复统计）。 |
| 强制隐藏 | `data-bf-blocked="1"` + CSS `display:none !important`；shadow root 中也注入样式并监听 childList/characterData/class/style。 |
| 诊断 | popup 统计增加 `扫描 / 标准节点 / 屏蔽命中 / 隐藏调用 / 最近命中`。content 消息 `bf_get_stats` 返回 `diagnostics` 和运行时合并后的 `blockwords`。 |
| 最新竞态修复 | watchdog 命中屏蔽词时写 `lastDecisionMap.set(el, true)`；`processDanmaku` 同文本分支若节点已有 `data-bf-blocked` 或当前仍命中屏蔽词，强制 `hideDanmaku`，不允许走旧放行 `restoreVisibility`。 |

### 重要未解决问题与下一步（优先级最高）

**问题尚未被用户验证为解决。** 用户在 v1.1.7 后仍报告约 90 秒的“中”可见；v1.1.8 的诊断数据证明命中与隐藏动作确实发生。v1.1.9 刚完成竞态修复，尚无用户实测结果。

下一会话应：

1. 让用户刷新扩展和页面，确认 popup 显示 `✅ v1.1.9 已注入本页`，从约 70 秒播放到 100 秒。
2. 若“中”仍可见，先索取同一时刻的完整诊断行，不要再改规则。
3. 给 content script 增加**有界的漏网证据缓冲区**：仅记录视觉可见、文本命中 `blockwords`、但没有 `data-bf-blocked` 的节点；记录时间、class、父/祖先 class、`display`、marker、是否在 shadow root、`lastDecisionMap` 状态。通过新的 `bf_get_diagnostics` 消息由 popup 显示/复制。
4. 同时应记录“节点先命中后被恢复”的因果链：为每个 element 分配临时 id（WeakMap），记录 `hideDanmaku`、`restoreVisibility`、class/style mutation 的最后 20 条事件。只在目标屏蔽词命中时记录，避免日志洪泛。
5. 重点验证用户实际加载路径就是 `D:\BiliFliter`；版本自检必须与 manifest 相同。不要把只在 Playwright 注入 stub 中成功的结果当成浏览器扩展实测。

### 当前关键实现位置

- `content.js`
  - `applyBlockwordsToExistingDanmaku()`：直接扫描标准 `.bili-danmaku-x-dm`（含 open shadow root），每 500ms 从 `scanDanmakuOnce()` 调用。
  - `getBlockwordHit()` / `normalizeDanmakuText()`：本地确定性匹配、零宽字符清理。
  - `processDanmaku()` 同文本去重分支：屏蔽词不得被旧放行状态恢复。
  - `hideDanmaku()`：写 `data-bf-blocked` 与内联 `!important`。
  - `bf_get_stats`：返回 `stats`、`diagnostics`、运行时合并后的 `blockwords`。
- `popup.js`
  - `formatStats()`/`refreshStats()`：显示诊断数据。
  - `sendMessageToActiveTab()`：固定 top frame。
- `manifest.json`：v1.1.9，`all_frames:true`。

### 建议 skills（更新）

- `bilibili-danmaku-filter`
- `systematic-debugging`
- `playwright-cli`
- `browser-extension-dev`
- `windows-gitbash-file-editing`
- `handoff`
