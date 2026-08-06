/**
 * Bilibili BulletFilter - Content Script
 * 负责与B站页面交互，处理弹幕过滤逻辑
 * 控制面板通过 popup.html 提供，不再使用悬浮窗
 */

// ==================== 状态管理 ====================
const state = {
  enabled: true,              // 过滤器总开关
  regexEnabled: true,         // 正则过滤开关
  aiEnabled: true,            // AI过滤开关
  regexPatterns: [],          // 当前正则表达式列表
  aiModel: 'qwen3:4b', // AI模型名称（中文判断力强，推荐）
  ollamaUrl: 'http://localhost:11434', // Ollama地址
  sensitivity: 'medium',      // 敏感度: low | medium | high
  blockwords: [],            // 用户自定义屏蔽词（全局+当前视频合并）
  promptRules: [],           // 用户屏蔽提示词（语义规则，注入AI判断，全局+当前视频合并）
};

const diagnostics = {
  watchdogRuns: 0,
  standardNodes: 0,
  blockwordHits: 0,
  hideCalls: 0,
  lastHit: '',
  lastHitAt: 0,
};

const stats = {
  seen: 0,
  kept: 0,
  filtered: 0,
  regexFiltered: 0,
  hardFiltered: 0,
  blockwordFiltered: 0,
  repeatFiltered: 0,
  aiFiltered: 0,
  lastResetAt: Date.now(),
  lastUpdatedAt: Date.now(),
  filteredDanmakus: [],  // 存储被过滤的弹幕
  keptDanmakus: [],     // 存储已保留的弹幕（最近 200 条）
};

function resetStats() {
  stats.seen = 0;
  stats.kept = 0;
  stats.filtered = 0;
  stats.regexFiltered = 0;
  stats.hardFiltered = 0;
  stats.blockwordFiltered = 0;
  stats.repeatFiltered = 0;
  stats.aiFiltered = 0;
  stats.lastResetAt = Date.now();
  stats.lastUpdatedAt = Date.now();
  stats.filteredDanmakus = [];
  stats.keptDanmakus = [];
  aiDecisionCache.clear();
  dmClusters = [];
}

// ==================== 正则过滤规则 ====================
const DEFAULT_REGEX_PATTERNS = [
  // 1. 刷屏重复
  { pattern: '(\\S)\\1{14,}|(\\S{2,3}?)\\2{6,}', flags: 'g', desc: '单条重复(极端)' },

  // 2. 时间打卡
  { pattern: '^([\\d零一二两三四五六七八九十]+个?([hH]|min|分钟?|小?时)[之以已]?前?|我?来?[当是]?第[\\d零一二三四五六七八九十]+[条个]?(弹幕)?)[!！？?.。,，～~]*$', flags: 'g', desc: '时间打卡' },

  // 3. 观看次数
  { pattern: '^我?(已经)?是?看?第?[\\d一二三四五六七八九十百千]+次?(遍|次|周目|刷|观?看)(路过|完成|来)?[呀啊了耶的力哩咯]?[我人]?(路过)?(.*(觉得|感觉|想说|表示).*|[.。！!?~～]+)?$', flags: 'g', desc: '观看次数' },

  // 4. 日期考古
  { pattern: '\\d零一二三四五六七八九十]{2,4}[年y*•.—－/ -]+[\\d零一二三四五六七八九十]{1,3}[月y*•.—－/ -]+[\\d零一二三四五六七八九十]{1,3}|[\\d零一二三四五六七八九十]{2,4}.*(路过|考古|留名|报[到道]|到此一游|一日游)|(?:19|20)\\d{2}年', flags: 'g', desc: '日期考古' },

  // 5. 有人看吗
  { pattern: '^(现在)?(是否)?(有?没)?[没有]人在?看?[吗啊嘛么没]?[.。！!?？~～]*$', flags: 'g', desc: '有人看吗' },

  // 6. 观看人数
  { pattern: '^(屏幕前)?我?(那?(剩下)?的?那?|现在|[当目]前)?(另外?)?我?这?也?是?就?有?[\\d零一二两三四五六七八九十百千万wWkK]+\\+?个?((朋友|观众|人)(正?[在再]?看着?|出来)?|正?[再在]?看着?的?(朋友|观众|人)?(出来)?玩?|出来|(朋友|观众|人)?你?们?好)[诶哈呀呢吧啊玩]?[!！。.?？]*$|^\\d+\\+[.。！!?~～]*$', flags: 'g', desc: '观看人数' },

  // 7. 纯关键词
  { pattern: '^(秒[吃赤]|前排|好?早|烫|来[了啦]|热乎?的?|刚[刚来才]|接|到此一游|路过|插眼|打卡|留名|签到|标记|考古|测试|test|(关闭|开启|打开|启动|自动)?(字幕|翻译))+[!！？?.。,，～~]*$|^[0-578]{1,3}$', flags: 'g', desc: '纯关键词' },

  // 8. 还愿/许愿
  { pattern: '.*还愿.*', flags: 'g', desc: '还愿' },
  { pattern: '.*许愿.*', flags: 'g', desc: '许愿' },
  { pattern: '.*实名.*开卷.*', flags: 'g', desc: '实名开卷' },
  { pattern: '.*关注.*', flags: 'g', desc: '关注' },
  { pattern: '.*大学.*', flags: 'g', desc: '大学打卡' },

  // 9. 无意义字符
  { pattern: '^[,，.。!?！？、；;：:：""「」『』【】…—\\s]+$', flags: 'g', desc: '纯标点/空格' },
];

// ==================== AI系统提示词模板 ====================
const AI_PROMPT_TEMPLATES = {
  low: `你是一个B站弹幕审核助手。请判断以下弹幕是否有价值。
只输出JSON：{"keep": true/false, "reason": "简短原因"}
过滤：纯表情符号、无意义重复、打卡签名类弹幕（包含"一日游"、"到此一游"、"打卡"、"签到"等词的弹幕，无论带什么人名或前缀）、水弹幕。
保留：有观点的评论、科普知识、幽默有趣的弹幕。
拿不准时倾向保留，避免误杀。
示例：
"黄茂坤在弹幕里这里一日游" → {"keep": false, "reason": "打卡"}
"这个转场设计太妙了" → {"keep": true, "reason": "有观点"}`,
  medium: `你是一个B站弹幕审核助手。请判断以下弹幕是否有价值。
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
"前排" → {"keep": false, "reason": "水弹幕"}`,
  high: `你是一个B站弹幕审核助手。请严格判断以下弹幕是否有价值。
只输出JSON：{"keep": true/false, "reason": "简短原因"}
严格过滤所有无意义弹幕：
- 打卡/签名类：弹幕只要包含"一日游"、"到此一游"、"打卡"、"签到"、"留名"、"占位"、"路过"、"考古"、"报到"等词，无论带什么人名或前缀，一律过滤
- 水弹幕：无意义的"来了"、"前排"、"打卡"、"1"、"哈哈哈"、"草"
- 纯表情/emoji、无意义重复
- 没有实质内容的凑字数弹幕
只保留真正有价值的弹幕：有观点的评论、科普知识、对视频内容的深度讨论。
示例：
"黄茂坤在弹幕里这里一日游" → {"keep": false, "reason": "打卡一日游"}
"这个转场设计太妙了" → {"keep": true, "reason": "有观点"}`,
};

// ==================== 初始化 ====================
async function init() {
  // 加载保存的设置
  await loadSettings();
  setupSettingsListener();

  // 设置弹幕观察器
  setupDanmakuObserver();
  lastKnownVideoKey = getVideoKey(location.href);
  setupPeriodicScan();

  console.log('[BulletFilter] 已启动');
}

// ==================== 设置管理 ====================
async function loadSettings() {
  try {
    const saved = await chrome.storage.local.get(['bulletfilter_settings']);
    if (saved.bulletfilter_settings) {
      Object.assign(state, saved.bulletfilter_settings);
    }

    // 始终使用最新的默认正则规则
    state.regexPatterns = DEFAULT_REGEX_PATTERNS.map(p => ({ ...p, enabled: true }));

    // 加载用户自定义屏蔽词（全局 + 当前视频）
    const bw = await chrome.storage.local.get(['bulletfilter_blockwords']);
    state.blockwords = resolveBlockwords(bw.bulletfilter_blockwords, getVideoKey(location.href));

    // 加载用户屏蔽提示词（语义规则，注入AI判断；全局 + 当前视频）
    const pr = await chrome.storage.local.get(['bulletfilter_prompt_rules']);
    state.promptRules = resolvePromptRules(pr.bulletfilter_prompt_rules, getVideoKey(location.href));
  } catch (e) {
    console.warn('[BulletFilter] 加载设置失败:', e);
    state.regexPatterns = DEFAULT_REGEX_PATTERNS.map(p => ({ ...p, enabled: true }));
    state.blockwords = [];
  }
}

// 合并全局 + 当前视频的屏蔽词
function resolveBlockwords(data, videoKey) {
  const d = data || {};
  const globalList = Array.isArray(d.global) ? d.global : [];
  const videoList = (d.video && d.video[videoKey]) || [];
  return [...globalList, ...videoList].filter((w) => w && w.trim());
}

// 合并全局 + 当前视频的屏蔽提示词（语义规则）
function resolvePromptRules(data, videoKey) {
  const d = data || {};
  const globalList = Array.isArray(d.global) ? d.global : [];
  const videoList = (d.video && Array.isArray(d.video[videoKey])) ? d.video[videoKey] : [];
  return [...globalList, ...videoList].filter((r) => r && r.text);
}

async function saveSettings() {
  try {
    await chrome.storage.local.set({ bulletfilter_settings: state });
  } catch (e) {
    console.warn('[BulletFilter] 保存设置失败:', e);
  }
}

function setupSettingsListener() {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const change = changes.bulletfilter_settings;
    if (!change?.newValue) return;

    Object.assign(state, change.newValue);

    // 始终使用最新的默认正则规则
    state.regexPatterns = DEFAULT_REGEX_PATTERNS.map(p => ({ ...p, enabled: true }));
  });

  // 屏蔽词变化时同步
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const change = changes.bulletfilter_blockwords;
    if (!change?.newValue) return;
    state.blockwords = resolveBlockwords(change.newValue, getVideoKey(location.href));
    // 屏蔽词变更后立即重扫存量弹幕，不能等节点文本变化。
    applyBlockwordsToExistingDanmaku();
  });

  // 屏蔽提示词变化时同步
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const change = changes.bulletfilter_prompt_rules;
    if (!change?.newValue) return;
    state.promptRules = resolvePromptRules(change.newValue, getVideoKey(location.href));
  });
}

// ==================== 弹幕观察者 ====================
let danmakuObserver = null;
let processedElements = new WeakSet();
// 文本级去重：同一节点同一文本只判定一次；文本变化（B站分次填充/晚填充）时重新判定。
// 用 lastJudgedText 而非 processedElements 永久去重，避免"文本补齐后不再判定"导致的漏网
const lastJudgedText = new WeakMap();
// 记录每条弹幕的最后判定结果（true=拦 / false=放）与对应计数器，
// 供"文本变化重判导致判定翻转"时调整统计，保证 已处理 = 已过滤 + 已保留 恒等式
const lastDecisionMap = new WeakMap();
const lastCounterMap = new WeakMap();
// 已执行过 hideDanmaku 的元素（避免本地+AI 双重记录被过滤列表/重复操作）
const hiddenElements = new WeakSet();
// AI 已判定并转计（kept→filtered）的元素：本地重判不再重复转计（防止明细≠总数）
const aiJudgedElements = new WeakSet();
// 已入队 AI（或缓存命中已判定）的弹幕：统计由 AI 判定负责，
// 本地重判翻转不再调整统计，避免"本地翻转 + AI 判定"重复累计 filtered/kept
const aiQueuedElements = new WeakSet();
let aiDecisionCache = new Map();
let lastKnownVideoKey = null;
let urlWatcherTimer = null;
let scanTimer = null;

function getAiCacheKey(text) {
  return `${state.aiModel}::${state.sensitivity}::${text}`;
}

function getVideoKey(href) {
  try {
    const u = new URL(href);
    const m = u.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i);
    const bv = m ? m[1] : '';
    const p = u.searchParams.get('p') || '';
    if (bv) return `${bv}?p=${p}`;
    return `${u.origin}${u.pathname}`;
  } catch {
    return href;
  }
}

function handleDanmakuElement(el) {
  if (!el || el.nodeType !== Node.ELEMENT_NODE) return;
  // 叶子保护：容器/轨道（内含弹幕子元素）绝不判定，避免隐藏整个弹幕层
  if (isDanmakuContainer(el)) return;
  const text = normalizeDanmakuText(getTextContent(el));
  if (text && text.length > 0) {
    processDanmaku(el, text);
  } else if (!lastJudgedText.has(el)) {
    // 文本可能晚填充：延迟重试（B 站先建节点后填文本的场景兜底）
    retryEmptyDanmaku(el, 0);
  }
}

// 空文本弹幕延迟重试：最多 3 次（150ms / 500ms / 1200ms），期间节点保持 preHide 透明，
// 一旦取到文本立即判定——避免"漏网之鱼"（未处理就显示）和"透明不显示"（preHide 残留）
function retryEmptyDanmaku(el, attempt) {
  const delays = [150, 500, 1200, 2500, 4000];
  if (attempt >= delays.length || !el.isConnected || lastJudgedText.has(el)) return;
  setTimeout(() => {
    if (!el.isConnected || lastJudgedText.has(el)) return;
    const t = getTextContent(el);
    if (t && t.length > 0) {
      processDanmaku(el, t);
    } else {
      retryEmptyDanmaku(el, attempt + 1);
    }
  }, delays[attempt]);
}

function handleDanmakuFromNode(node) {
  if (!node) return;
  // Text 节点：B 站可能"先创建空弹幕节点，再 textContent 赋值填充"，
  // 此时 childList 的 addedNodes 是 Text 节点——必须处理父弹幕节点，
  // 否则这些弹幕永远不会被过滤（漏网之鱼），且空节点被 preHide 后永不恢复（透明不显示）
  if (node.nodeType === Node.TEXT_NODE) {
    // 向上查找弹幕祖先：分段弹幕（B站UP主弹幕）的文本在 SPAN 子元素内，
    // Text 节点的直接父是 SPAN（class 不匹配弹幕选择器），必须向上找到 .bili-danmaku-x-dm
    let parent = node.parentElement;
    while (parent && !matchDanmakuSelector(parent) && parent !== document.body) {
      parent = parent.parentElement;
    }
    if (parent && parent !== document.body) {
      const t = normalizeDanmakuText(parent.textContent || '');
      if (t && t.length > 0) {
        // 文本变化（分次填充）才 preHide + 重判；同文本重复插入不干扰已显示的弹幕
        if (lastJudgedText.get(parent) !== t) preHide(parent);
        handleDanmakuElement(parent);
      }
    }
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node;
  if (matchDanmakuSelector(el)) {
    // 仅在文本与上次判定不同时 preHide：同一节点可能被多个 observer（主文档/容器/shadow root）
    // 重复捕获，若二次 preHide 而 processDanmaku 因去重直接 return，
    // restoreVisibility 永远不会执行 → 弹幕永久透明（"一条都看不见"的 bug 根源）
    if (lastJudgedText.get(el) !== getTextContent(el)) preHide(el);
    handleDanmakuElement(el);
  }
  queryDanmakuIn(el).forEach((child) => {
    if (lastJudgedText.get(child) !== getTextContent(child)) preHide(child);
    handleDanmakuElement(child);
  });
}

const DANMAKU_ITEM_SELECTOR = '.bili-danmaku-x-dm, .bili-danmaku, .bili-danmaku-text, .dm-text, .danmaku-item';
const DANMAKU_LAYER_SELECTOR = '.bpx-player-row-dm-wrap, .bpx-player-dm-wrap, .bpx-player-dm-root, .bili-danmaku-x-pa, .bili-danmaku-x-dm-wrap, .danmaku-player';
const BF_BLOCKED_ATTR = 'data-bf-blocked';
let blockStyleInstalled = false;

function isWithinDanmakuLayer(el) {
  return Boolean(el?.closest?.(DANMAKU_LAYER_SELECTOR));
}

function installBlockStyle(root = document) {
  if (!root) return;
  const host = root === document ? document.documentElement : root;
  if (!host || host.querySelector?.(`style[data-bf-block-style="1"]`)) return;
  const style = document.createElement('style');
  style.dataset.bfBlockStyle = '1';
  style.textContent = `[${BF_BLOCKED_ATTR}="1"] { display: none !important; opacity: 0 !important; pointer-events: none !important; }`;
  if (root === document) (document.head || document.documentElement).appendChild(style);
  else root.appendChild(style);
  if (root === document) blockStyleInstalled = true;
}

function matchDanmakuSelector(el) {
  if (!el?.classList) return false;
  // 主播放器的标准节点可直接接受；兼容类名必须位于弹幕轨道内。
  // `.dm-text` 也用于视频信息等无关区域，不能仅凭 class 进入隐藏管道。
  if (el.classList.contains('bili-danmaku-x-dm')) return true;
  if (!isWithinDanmakuLayer(el)) return false;
  return el.classList.contains('bili-danmaku')
    || el.classList.contains('bili-danmaku-text')
    || el.classList.contains('dm-text')
    || el.classList.contains('danmaku-item');
}

function isDanmakuContainer(el) {
  return Boolean(el?.querySelector?.(DANMAKU_ITEM_SELECTOR));
}

function queryDanmakuIn(root) {
  const results = new Set();
  try {
    root.querySelectorAll?.(DANMAKU_ITEM_SELECTOR).forEach((el) => {
      // 叶子保护：元素内含弹幕子元素（是容器/轨道）则跳过，只处理弹幕本体。
      if (!isDanmakuContainer(el) && matchDanmakuSelector(el)) results.add(el);
    });
    // 兼容特殊弹幕：部分节点没有稳定 item class，但其文本确实处于播放器弹幕轨道中。
    root.querySelectorAll?.(DANMAKU_LAYER_SELECTOR).forEach((layer) => {
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        let el = walker.currentNode.parentElement;
        while (el && el !== layer && !matchDanmakuSelector(el)) el = el.parentElement;
        if (el && el !== layer && !isDanmakuContainer(el)) results.add(el);
      }
    });
  } catch {}
  return [...results];
}

function setupDanmakuObserver() {
  scanDanmakuOnce();
  danmakuObserver = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.type === 'characterData') {
        // B站弹幕密集时使用"节点复用池"：新弹幕通过修改旧节点文本（characterData）渲染，
        // 仅监听 childList 会漏掉这些弹幕（统计停止 + 漏网之鱼显示）
        if (mutation.target?.nodeType === Node.TEXT_NODE) {
          handleDanmakuFromNode(mutation.target);
        }
      } else if (mutation.type === 'attributes') {
        if (mutation.attributeName === 'class') {
          // B站激活弹幕节点时通过修改 class 标记（如添加 bili-danmaku-x-dm）：
          // 节点插入时 class 可能尚未就绪（不匹配选择器），激活时才加上弹幕 class，
          // 不监听 attributes 会漏掉这些弹幕（漏网之鱼）
          if (matchDanmakuSelector(mutation.target)) {
            handleDanmakuFromNode(mutation.target);
          }
        } else if (mutation.attributeName === 'style' && hiddenElements.has(mutation.target)) {
          // 被拦节点 style 被 B站 JS 覆盖（display 恢复）→ 立即重新隐藏
          hideDanmaku(mutation.target);
        }
      } else {
        mutation.addedNodes.forEach((node) => handleDanmakuFromNode(node));
      }
    }
  });
  danmakuObserver.observe(document.body, { childList: true, subtree: true, characterData: true, characterDataOldValue: true, attributes: true });
  const waitForContainer = () => {
    const container = findDanmakuContainer();
    if (container) observeDanmaku(container);
    setTimeout(waitForContainer, 2000);
  };
  waitForContainer();
  // 观察所有 open shadow root 内部的弹幕变化（B站新版播放器弹幕在 shadow DOM 内，
  // 主文档的 MutationObserver 看不到 shadow root 内部的节点变化）
  observeShadowRoots();
}

// 观察所有 open shadow root：弹幕节点一进 shadow DOM 就立即捕获（microtask 级），
// 配合 preHide 实现"渲染前隐藏"，不再依赖 500ms 周期扫描兜底
const observedShadowRoots = new WeakSet();

function observeShadowRoots() {
  try {
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT);
    while (walker.nextNode()) {
      const el = walker.currentNode;
      if (el.shadowRoot && !observedShadowRoots.has(el.shadowRoot)) {
        observedShadowRoots.add(el.shadowRoot);
        installBlockStyle(el.shadowRoot);
        const obs = new MutationObserver((mutations) => {
          for (const mutation of mutations) {
            if (mutation.type === 'characterData') handleDanmakuFromNode(mutation.target);
            else if (mutation.type === 'attributes') {
              if (mutation.attributeName === 'style' && hiddenElements.has(mutation.target)) hideDanmaku(mutation.target);
              else if (mutation.attributeName === 'class' && matchDanmakuSelector(mutation.target)) handleDanmakuFromNode(mutation.target);
            } else mutation.addedNodes.forEach((node) => handleDanmakuFromNode(node));
          }
        });
        obs.observe(el.shadowRoot, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'style'] });
        // 立即处理 shadow root 内已有的弹幕（首次挂载时存量节点）
        queryDanmakuIn(el.shadowRoot).forEach(handleDanmakuElement);
      }
    }
  } catch (e) {
    console.warn('[BulletFilter] shadow root 观察失败:', e.message);
  }
}

function findDanmakuContainer() {
  const candidates = document.querySelectorAll(
    '#dm_player_wrapper, .danmaku-player, .bpx-player-row-dm-wrap, #bilibili-player, .bpx-player-container, #playerWrap, .web-player, [class*="player"]'
  );
  for (const c of candidates) { if (c) return c; }
  return null;
}

function observeDanmaku(container) {
  if (container.dataset.bf_observed) return;
  container.dataset.bf_observed = 'true';
  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => handleDanmakuFromNode(node));
    }
  });
  observer.observe(container, { childList: true, subtree: true });
}

function normalizeDanmakuText(text) {
  // 去除 B 站单字弹幕中可能夹带的零宽字符。
  return (text || '').toString().replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

function getBlockwordHit(text) {
  const normalized = normalizeDanmakuText(text);
  return state.blockwords.find((word) => {
    const w = normalizeDanmakuText(word);
    return w && normalized.includes(w);
  }) || '';
}

function applyBlockwordsToExistingDanmaku() {
  // 屏蔽词 watchdog 只走 B 站标准弹幕类，独立于兼容选择器和扫描根节点。
  diagnostics.watchdogRuns += 1;
  const nodes = new Set();
  try {
    const roots = [document];
    const queue = collectOpenShadowRoots(document.documentElement, 1500);
    while (queue.length) {
      const root = queue.shift();
      roots.push(root);
      queue.push(...collectOpenShadowRoots(root, 1500));
      if (roots.length >= 20) break;
    }
    roots.forEach((root) => {
      root.querySelectorAll?.('.bili-danmaku-x-dm').forEach((el) => nodes.add(el));
      root.querySelectorAll?.(DANMAKU_LAYER_SELECTOR).forEach((layer) => {
        layer.querySelectorAll('.bili-danmaku-x-dm').forEach((el) => nodes.add(el));
      });
    });
  } catch {}
  diagnostics.standardNodes = nodes.size;
  nodes.forEach((el) => {
    if (isDanmakuContainer(el)) return;
    const text = normalizeDanmakuText(getTextContent(el));
    const hit = getBlockwordHit(text);
    if (hit) {
      diagnostics.blockwordHits += 1;
      diagnostics.lastHit = text;
      diagnostics.lastHitAt = Date.now();
      // 屏蔽词优先级高于该节点此前的放行判定，防止后续同文本回调恢复可见性。
      lastDecisionMap.set(el, true);
      lastCounterMap.set(el, 'blockwordFiltered');
      hideDanmaku(el, text, `屏蔽词：${hit}`);
    }
  });
}

function getTextContent(element) {
  if (!element) return '';
  const textSelectors = [
    '.bili-danmaku-x-dm', '.bili-danmaku-text', '.dm-text', '.text', '.danmaku-info .text', '.dm_item .text',
  ];
  for (const sel of textSelectors) {
    const el = element.matches?.(sel) ? element : element.querySelector(sel);
    if (el) { const t = el.textContent?.trim() || ''; if (t) return t; }
  }
  const direct = element.textContent?.trim() || '';
  return direct.length > 0 && direct.length <= 200 ? direct : '';
}

function collectOpenShadowRoots(root, limit) {
  const roots = [];
  try {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let count = 0;
    while (walker.nextNode() && count < limit) {
      const el = walker.currentNode;
      if (el && el.shadowRoot) roots.push(el.shadowRoot);
      count += 1;
    }
  } catch {
    return roots;
  }
  return roots;
}

function scanDanmakuOnce() {
  // 屏蔽词是确定性规则，必须独立于 lastJudgedText 去重；
  // B站高峰期若某次 class/text mutation 漏掉，下一次扫描仍要直接隐藏命中节点。
  applyBlockwordsToExistingDanmaku();
  const queue = [document];
  const visited = new Set();
  let processedRoots = 0;

  while (queue.length > 0 && processedRoots < 10) {
    const root = queue.shift();
    if (!root || visited.has(root)) continue;
    visited.add(root);
    processedRoots += 1;

    try {
      queryDanmakuIn(root === document ? document : root).forEach(handleDanmakuElement);
    } catch {
    }

    const shadows = collectOpenShadowRoots(root === document ? document.documentElement : root, 1500);
    shadows.forEach((sr) => queue.push(sr));
  }
}

function setupPeriodicScan() {
  if (scanTimer) return;
  scanTimer = setInterval(() => {
    scanDanmakuOnce();
    observeShadowRoots(); // 发现动态新增的 shadow root（如切换清晰度/全屏重挂载）
  }, 500);
}

// ==================== 弹幕处理核心逻辑 ====================
// 预隐藏：新弹幕在渲染前置为透明（observer 回调在 DOM 变更后、渲染前执行），
// 本地规则同步判定（微秒级）后立即恢复显示，命中的弹幕从第一帧就不可见，杜绝"闪现后被过滤"
function preHide(el) {
  if (!el) return;
  el.style.opacity = '0';
  el.dataset.bfPending = '1';
}

function restoreVisibility(el) {
  if (!el) return;
  delete el.dataset.bfPending;
  delete el.dataset.bfBlocked;
  // removeProperty 清除（含 !important 样式，B站复用节点改文本渲染新弹幕时需完全恢复）
  el.style.removeProperty('opacity');
  el.style.removeProperty('display');
  el.style.removeProperty('pointer-events');
}

// ==================== 多人刷屏拦截（参考 pakku.js 合并逻辑） ====================
// 识别逻辑移植自 pakku.js：
//   1. 预处理归一化（去尾标点/全半角/去空格/套路口令）——"哈哈哈~"、"哈哈！！"、"哈哈哈哈"归一为同类
//   2. 编辑距离相似聚类——同簇弹幕计数，超过阈值后拦截后续相同/相似弹幕
//   3. 30 秒时间窗口（pakku THRESHOLD=30）
// 例：30秒内"哈哈哈"（及变体）出现6次 → 前5条放行，第6条起拦截
const REPEAT_WINDOW_MS = 30000;
// 双阈值：刷屏词（哈哈/666/233 等归一化产物）第3条起拦截；正常文本仅拦完全相同的重复（第6条起）
const REPEAT_THRESHOLD_SPAM = 2;
const REPEAT_THRESHOLD_NORMAL = 5;
const CLUSTER_LIMIT = 100;   // 簇数量上限（性能保护）
// 归一化后属于"纯刷屏词"的集合（严格阈值拦截；正常文本不进此集合）
const SPAM_NORMALIZED = new Set([
  '哈哈', '呵呵', '嘻嘻', '嘿嘿', '嘿嘿嘿',
  '66', '2333', '11', '22', '33', '44', '55', '77', '88', '99', '00',
  '啊', '嗯', '哦', '嘛', '噢',
]);
let dmClusters = [];         // [{key, count, lastSeen}]

// ---- 预处理归一化（pakku detaolu_meta 简化版）----
const ENDING_CHARS = new Set('.。,，/?？!！…～~@^、+=-_♂♀ '.split(''));
const WIDTH_MAP = {
  '１': '1', '２': '2', '３': '3', '４': '4', '５': '5', '６': '6', '７': '7', '８': '8', '９': '9', '０': '0',
  '！': '!', '＠': '@', '＃': '#', '＄': '$', '％': '%', '＾': '^', '＆': '&', '＊': '*',
  '（': '(', '）': ')', '－': '-', '＝': '=', '＿': '_', '＋': '+',
  '［': '[', '］': ']', '｛': '{', '｝': '}', '；': ';', '：': ':', '＂': '"', '＇': "'",
  '，': ',', '．': '.', '／': '/', '＜': '<', '＞': '>', '？': '?', '～': '~',
  'ａ': 'a', 'ｂ': 'b', 'ｃ': 'c', 'ｄ': 'd', 'ｅ': 'e', 'ｆ': 'f', 'ｇ': 'g', 'ｈ': 'h',
  'ｉ': 'i', 'ｊ': 'j', 'ｋ': 'k', 'ｌ': 'l', 'ｍ': 'm', 'ｎ': 'n', 'ｏ': 'o', 'ｐ': 'p',
  'ｑ': 'q', 'ｒ': 'r', 'ｓ': 's', 'ｔ': 't', 'ｕ': 'u', 'ｖ': 'v', 'ｗ': 'w', 'ｘ': 'x', 'ｙ': 'y', 'ｚ': 'z',
  'Ａ': 'A', 'Ｂ': 'B', 'Ｃ': 'C', 'Ｄ': 'D', 'Ｅ': 'E', 'Ｆ': 'F', 'Ｇ': 'G', 'Ｈ': 'H',
  'Ｉ': 'I', 'Ｊ': 'J', 'Ｋ': 'K', 'Ｌ': 'L', 'Ｍ': 'M', 'Ｎ': 'N', 'Ｏ': 'O', 'Ｐ': 'P',
  'Ｑ': 'Q', 'Ｒ': 'R', 'Ｓ': 'S', 'Ｔ': 'T', 'Ｕ': 'U', 'Ｖ': 'V', 'Ｗ': 'W', 'Ｘ': 'X', 'Ｙ': 'Y', 'Ｚ': 'Z',
};

function normalizeForSimilarity(raw) {
  let text = (raw || '').toString();
  // 1. 去尾部标点（pakku TRIM_ENDING）
  let len = text.length;
  while (len > 0 && ENDING_CHARS.has(text.charAt(len - 1))) len--;
  if (len === 0) len = text.length;
  text = text.slice(0, len);
  // 2. 全角转半角（pakku TRIM_WIDTH）
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text.charAt(i);
    out += WIDTH_MAP[c] || c;
  }
  text = out;
  // 3. 去空格（pakku TRIM_SPACE）
  text = text.replace(/[ \u3000]+/g, '');
  // 4. 套路口令归一（pakku FORCELIST：重复数字归一）
  text = text.replace(/^23{2,}$/, '2333').replace(/^6{3,}$/, '6666');
  // 5. 纯单字符重复归一（"哈哈哈"、"哈哈哈哈哈哈" → "哈哈"，跨长度刷屏合并；
  //    仅对整条全是同一字符的弹幕生效，不影响有内容的弹幕如"哈哈哈哈我笑死"）
  text = text.replace(/^(\S)\1{2,}$/, '$1$1');
  // 6. 英文笑声/拼音缩写归一（B站常见刷屏："hhh"、"hahaha"、"hehehe"、"xixixi"）
  text = text.replace(/^h+$/i, '哈哈');
  text = text.replace(/^(ha)+$/i, '哈哈');
  text = text.replace(/^(he)+$/i, '呵呵');
  text = text.replace(/^(xi)+$/i, '嘻嘻');
  return text;
}

// ---- 编辑距离（两行 DP，带长度剪枝）----
function editDistance(a, b) {
  const m = a.length, n = b.length;
  if (Math.abs(m - n) > SIM_MAX_DIST) return SIM_MAX_DIST + 1; // 快速剪枝
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[n];
}

function isRepeatSpam(text) {
  const now = Date.now();
  const key = normalizeForSimilarity(text);
  if (!key) return false;

  // 清理过期簇（30 秒窗口）
  dmClusters = dmClusters.filter((c) => now - c.lastSeen <= REPEAT_WINDOW_MS);

  // 精确匹配（归一化后完全相同才算同一簇——不做编辑距离相似合并，
  // 避免误杀"好好听/好好听啊/太好听了"这类正常讨论弹幕）
  const exact = dmClusters.find((c) => c.key === key);
  if (exact) {
    exact.count += 1;
    exact.lastSeen = now;
    const threshold = SPAM_NORMALIZED.has(key) ? REPEAT_THRESHOLD_SPAM : REPEAT_THRESHOLD_NORMAL;
    return exact.count > threshold;
  }

  // 新簇
  if (dmClusters.length >= CLUSTER_LIMIT) dmClusters.shift();
  dmClusters.push({ key, count: 1, lastSeen: now });
  return false;
}

// 本地规则同步判定（正则/固定/屏蔽词/意图），全部本地执行、不依赖 AI
function evaluateLocalRules(text) {
  // 第一层：正则过滤
  if (state.regexEnabled) {
    const regexResult = applyRegexFilter(text);
    if (regexResult.blocked) return { blocked: true, reason: `正则：${regexResult.reason}`, counter: 'regexFiltered' };
  }

  // 第二层：固定规则过滤
  const hardResult = getHardBlockResult(text, state.sensitivity);
  if (hardResult.blocked) return { blocked: true, reason: `固定：${hardResult.reason}`, counter: 'hardFiltered' };

  // 第2.5层：手动屏蔽词（本地确定性匹配，不依赖AI，秒级生效）
  const bwHit = getBlockwordHit(text);
  if (bwHit) return { blocked: true, reason: `屏蔽词：${bwHit}`, counter: 'blockwordFiltered' };

  // 第2.7层：多人刷屏拦截（同文本弹幕窗口内重复超阈值）
  if (isRepeatSpam(text)) return { blocked: true, reason: '刷屏：多人重复', counter: 'repeatFiltered' };

  return { blocked: false };
}

function processDanmaku(element, text) {
  if (!element) return;
  // 同节点同文本不重复判定；文本变化（晚填充/分次填充/节点复用）则重新判定
  const lastText = lastJudgedText.get(element);
  if (lastText === text) {
    // 同文本回调不得覆盖确定性屏蔽词的最终隐藏状态。
    // 否则旧的“放行”判定会在 B站 class/style 变化时调用 restoreVisibility，
    // 与 watchdog 交替执行，表现为命中次数很高但弹幕仍周期性重新出现。
    const blockword = getBlockwordHit(text);
    if (element.dataset.bfBlocked === '1' || blockword) {
      lastDecisionMap.set(element, true);
      hideDanmaku(element, text, `屏蔽词：${blockword || '已命中'}`);
      return;
    }
    // 已被判定过：若判定为放行，兜底恢复显示。
    if (lastDecisionMap.get(element) === false) restoreVisibility(element);
    return;
  }
  // B站会复用已滚出的节点。旧弹幕被过滤过时必须解除该节点的隐藏标记，
  // 否则新文本被允许后 restoreVisibility 写入 style，会被 style observer 误判为旧弹幕复活并再次隐藏。
  hiddenElements.delete(element);
  lastJudgedText.set(element, text);
  processedElements.add(element);
  const isFirst = lastText === undefined;

  // 每次判定（含文本变化重判 = 复用节点上的新弹幕）都计入"已处理"，
  // 保证 B 站密集弹幕（复用池模式）统计持续增长
  stats.seen += 1;
  stats.lastUpdatedAt = Date.now();

  // 文本变化重判：同步已保留列表（旧文本记录作废）
  if (!isFirst) {
    const oi = stats.keptDanmakus.indexOf(lastText);
    if (oi !== -1) stats.keptDanmakus.splice(oi, 1);
  }

  // 单字弹幕：仍检查屏蔽词（用户可能用单字屏蔽词，如"中"——之前直接放行导致漏网）
  if (text.length <= 1) {
    const bwHit = getBlockwordHit(text);
    if (bwHit) {
      hideDanmaku(element, text, `屏蔽词：${bwHit}`);
      stats.filtered += 1;
      stats.blockwordFiltered += 1;
      stats.lastUpdatedAt = Date.now();
      return;
    }
    stats.kept += 1;
    if (stats.keptDanmakus.length < 200 && !stats.keptDanmakus.includes(text)) stats.keptDanmakus.push(text);
    restoreVisibility(element);
    return;
  }

  // 检查总开关
  if (!state.enabled) {
    stats.kept += 1;
    if (stats.keptDanmakus.length < 200 && !stats.keptDanmakus.includes(text)) stats.keptDanmakus.push(text);
    restoreVisibility(element);
    return;
  }

  // 本地规则同步判定（微秒级）
  const local = evaluateLocalRules(text);
  const blocked = local.blocked;
  lastDecisionMap.set(element, blocked);

  if (blocked) {
    lastCounterMap.set(element, local.counter);
    hideDanmaku(element, text, local.reason);
    // 每次判定按结果计 filtered（恒等式 seen = filtered + kept 自动成立；
    // AI 判定转计 kept-1+filtered+1 总量不变，恒等式保持）
    stats.filtered += 1;
    stats[local.counter] += 1;
    stats.lastUpdatedAt = Date.now();
    return;
  }

  // 本地通过 → 立即恢复显示（弹幕正常展示，不等 AI）
  restoreVisibility(element);

  // 第三层：AI过滤（批量 + 并发 + 积压保护，弹幕密集时不阻塞）
  if (state.aiEnabled && text.length > 0) {
    if (isFirst) {
      enqueueAI(text, element); // AI弹幕入队时内部计入 kept
    } else {
      // 重判（复用/分段补齐）弹幕：本地判定计入 kept（不入队 AI，避免重复判定）
      stats.kept += 1;
      if (stats.keptDanmakus.length < 200 && !stats.keptDanmakus.includes(text)) {
        stats.keptDanmakus.push(text);
      }
    }
    stats.lastUpdatedAt = Date.now();
    return;
  }

  stats.kept += 1;
  if (stats.keptDanmakus.length < 200 && !stats.keptDanmakus.includes(text)) stats.keptDanmakus.push(text);
  stats.lastUpdatedAt = Date.now();
}

function applyRegexFilter(text) {
  for (const rule of state.regexPatterns) {
    if (!rule.enabled || !rule.pattern) continue;

    try {
      const regex = new RegExp(rule.pattern, rule.flags);
      if (regex.test(text)) {
        return { blocked: true, reason: rule.desc };
      }
    } catch (e) {
      console.warn('[BulletFilter] 正则错误:', rule.pattern, e);
    }
  }

  return { blocked: false };
}

function normalizeForRules(text) {
  return (text || '').toString().trim().replace(/\s+/g, '');
}

function getHardBlockResult(text, sensitivity) {
  const t = normalizeForRules(text);
  if (!t) return { blocked: false };

  const s = (sensitivity || 'medium').toString();

  // 第一类：整条精确匹配（仅当弹幕恰好等于关键词）
  const low = new Set(['到此一游', '打卡', '路过', '签到', '来了', '前排']);
  const medium = new Set(['到此一游', '打卡', '路过', '签到', '来了', '前排', '顶']);
  const high = new Set(['到此一游', '打卡', '路过', '签到', '来了', '前排', '顶', '留名', '占位']);
  const exactSet = s === 'low' ? low : s === 'high' ? high : medium;
  if (exactSet.has(t)) return { blocked: true, reason: `命中固定规则：${t}` };

  // 第二类：包含式匹配 —— 弹幕中出现打卡/签名词即拦截
  // 解决 "黄茂坤在弹幕里这里一日游" 这类带人名/前缀的打卡弹幕（精确匹配和正则都拦不住）
  // 无歧义词：任何敏感度都拦（这些词出现在句中基本就是打卡/签名行为）
  const strongKeywords = ['一日游', '到此一游', '到此一坐', '占个坑', '占个位', '考古', '插眼', '留名', '留个名', '占位', '签到', '签个到', '打卡', '打个卡'];
  // 中等词：中/高敏感度才拦
  const mediumKeywords = ['报到', '标记'];
  // 高敏感度额外拦的弱水词
  const highKeywords = ['来了来了', '顶一下', '路过'];

  let keywords = [...strongKeywords];
  if (s !== 'low') keywords = keywords.concat(mediumKeywords);
  if (s === 'high') keywords = keywords.concat(highKeywords);

  for (const kw of keywords) {
    if (t.includes(kw)) return { blocked: true, reason: `命中固定规则：${kw}` };
  }

  // 排座党（中/高敏感度）
  if (s !== 'low') {
    if (/^(第|前).{0,4}[一二三四五六七八九十0-9]+[排座]$/.test(t)) return { blocked: true, reason: '命中固定规则：排座党' };
    if (/^[一二三四五六七八九十0-9]+[排座]$/.test(t)) return { blocked: true, reason: '命中固定规则：排座党' };
  }

  return { blocked: false };
}

// ==================== AI 批量判断队列 ====================
// 批量（3条/请求）+ 并发（2路）+ 积压保护（队列超限跳过AI，宁漏杀不过载），
// 大幅提升弹幕密集场景的 AI 吞吐（实测 ~2.6s/条 -> ~0.7s/条）
const AI_BATCH_SIZE = 3;
const AI_MAX_CONCURRENCY = 2;
const AI_QUEUE_LIMIT = 20;
let aiQueue = [];
let aiInFlight = 0;
let aiFlushTimer = null;

function enqueueAI(text, element) {
  const key = getAiCacheKey(text);

  // 缓存命中：同步判定（拦截的不可见，放行的正常）
  const cached = aiDecisionCache.get(key);
  if (cached) {
    // 缓存命中 = 统计已由本次判定负责；标记后本地重判翻转不再重复调整
    aiQueuedElements.add(element);
    if (!cached.keep) {
      hideDanmaku(element, text, `AI：${cached.reason || '无价值'}`);
      stats.filtered += 1;
      stats.aiFiltered += 1;
    } else {
      stats.kept += 1;
      if (stats.keptDanmakus.length < 200) stats.keptDanmakus.push(text);
    }
    stats.lastUpdatedAt = Date.now();
    return;
  }

  // 积压保护：待判断队列过载时跳过 AI（宁可漏杀，保证不过载不越积越多）
  if (aiQueue.length + aiInFlight >= AI_QUEUE_LIMIT) {
    stats.kept += 1;
    if (stats.keptDanmakus.length < 200) stats.keptDanmakus.push(text);
    stats.lastUpdatedAt = Date.now();
    return;
  }

  aiQueue.push({ text, element, key });
  aiQueuedElements.add(element);
  // 入队即计入"已保留"：AI 判定为过滤时转计 filtered（保证恒等式，避免异步期间已处理>已过滤+已保留）
  stats.kept += 1;
  if (stats.keptDanmakus.length < 200) stats.keptDanmakus.push(text);
  scheduleFlush();
}

function scheduleFlush() {
  if (aiFlushTimer) return;
  aiFlushTimer = setTimeout(flushAIQueue, 200);
}

async function flushAIQueue() {
  aiFlushTimer = null;
  while (aiQueue.length > 0 && aiInFlight < AI_MAX_CONCURRENCY) {
    const batch = aiQueue.splice(0, AI_BATCH_SIZE);
    aiInFlight += 1;
    processAIBatch(batch).finally(() => {
      aiInFlight -= 1;
      if (aiQueue.length > 0) scheduleFlush();
    });
  }
}

async function processAIBatch(batch) {
  try {
    // AI 判定用最新文本：分段填充的弹幕避免基于不完整文本误杀
    const texts = batch.map((b) => {
      const cur = b.element && b.element.isConnected ? getTextContent(b.element) : '';
      return cur && cur !== b.text ? cur : b.text;
    });
    const resp = await callAIBatch(texts);
    const results = (resp && resp.ok && Array.isArray(resp.results)) ? resp.results : [];
    const byText = new Map();
    for (const r of results) byText.set(r.text, r);

    for (const b of batch) {
      const judgedText = texts[batch.indexOf(b)];
      const r = byText.get(judgedText) || byText.get(b.text);
      if (r) {
        aiDecisionCache.set(b.key, r);
        if (aiDecisionCache.size > 5000) {
          const firstKey = aiDecisionCache.keys().next().value;
          if (firstKey) aiDecisionCache.delete(firstKey);
        }
        const localBlocked = lastDecisionMap.get(b.element) === true;
        if (!r.keep || localBlocked) {
          // AI 判定过滤，或重判后弹幕已被本地拦截
          hideDanmaku(b.element, judgedText, `AI：${r.reason || '无价值'}`);
          if (!localBlocked) {
            // 本地未拦：AI 判定过滤 → 转计（入队时 kept 已计）
            aiJudgedElements.add(b.element);
            stats.filtered += 1;
            stats.aiFiltered += 1;
            stats.kept = Math.max(0, stats.kept - 1);
            const ki = stats.keptDanmakus.indexOf(judgedText);
            if (ki !== -1) stats.keptDanmakus.splice(ki, 1);
            else {
              const ki2 = stats.keptDanmakus.indexOf(b.text);
              if (ki2 !== -1) stats.keptDanmakus.splice(ki2, 1);
            }
          }
          // 本地已拦：统计已由本地重判转计，AI 不重复累计
        }
        // keep:true 且未被本地拦截 → 保持入队时已计的 kept
      } else {
        // AI 未返回该条：保持入队时已计的 kept（按保留处理）
      }
      stats.lastUpdatedAt = Date.now();
    }
  } catch (e) {
    // AI 调用失败：弹幕保持入队时已计的 kept（保留），不重复累加
    console.warn('[BulletFilter] AI 批量过滤失败:', e.message);
    stats.lastUpdatedAt = Date.now();
  }
}

function callAIBatch(texts) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: 'bf_call_ai_batch',
      texts: texts,
      settings: {
        ollamaUrl: state.ollamaUrl,
        aiModel: state.aiModel,
        sensitivity: state.sensitivity,
        blockwords: state.blockwords || [],
        promptRules: state.promptRules || []
      }
    }, (response) => {
      resolve(response || { ok: false });
    });
  });
}

async function callAI(text) {
  // 通过background.js调用AI，避免CORS限制
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: 'bf_call_ai',
      text: text,
      settings: {
        ollamaUrl: state.ollamaUrl,
        aiModel: state.aiModel,
        sensitivity: state.sensitivity,
        blockwords: state.blockwords || [],
        promptRules: state.promptRules || []
      }
    }, (response) => {
      resolve(response || { keep: true, reason: 'AI调用失败' });
    });
  });
}

function hideDanmaku(element, text, reason) {
  if (!element || !matchDanmakuSelector(element)) return;
  // 容器保护：绝不隐藏弹幕容器/轨道（内含弹幕子元素），只隐藏单条弹幕本体
  if (isDanmakuContainer(element)) return;
  diagnostics.hideCalls += 1;
  installBlockStyle(element.getRootNode?.() || document);
  element.dataset.bfBlocked = '1';
  // 用 !important：B站 JS 每帧写弹幕节点 style（可能覆盖 display/opacity），
  // 普通内联样式会被覆盖导致存量弹幕"拦不住"（漏网之鱼）
  element.style.setProperty('display', 'none', 'important');
  element.style.setProperty('opacity', '0', 'important');
  element.style.setProperty('pointer-events', 'none', 'important');
  // 同一元素只记录一次被过滤（本地拦截 + AI 拦截可能先后触发同一元素）
  if (text && !hiddenElements.has(element) && stats.filteredDanmakus.length < 200) {
    hiddenElements.add(element);
    stats.filteredDanmakus.push({
      text: text,
      reason: reason || '未知',
      time: Date.now()
    });
  }
}

// ==================== 工具函数 ====================
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ==================== 启动 ====================
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'bf_ping') {
    sendResponse({ ok: true, version: '1.1.9', url: location.href });
    return;
  }
  if (message?.type === 'bf_get_stats') {
    sendResponse({ ok: true, stats: { ...stats }, diagnostics: { ...diagnostics, blockwords: [...state.blockwords] }, url: location.href });
    return;
  }

  if (message?.type === 'bf_reset_stats') {
    resetStats();
    processedElements = new WeakSet();
    sendResponse({ ok: true, stats: { ...stats }, url: location.href });
    return;
  }

  if (message?.type === 'bf_get_filtered') {
    sendResponse({ ok: true, filteredDanmakus: stats.filteredDanmakus || [], url: location.href });
    return;
  }
  if (message?.type === 'bf_get_kept') {
    sendResponse({ ok: true, keptDanmakus: stats.keptDanmakus || [], url: location.href });
    return;
  }
});

urlWatcherTimer = setInterval(async () => {
  const key = getVideoKey(location.href);
  if (key !== lastKnownVideoKey) {
    lastKnownVideoKey = key;
    resetStats();
    processedElements = new WeakSet();
    // 视频切换后重新合并该视频的屏蔽提示词
    const pr = await chrome.storage.local.get(['bulletfilter_prompt_rules']);
    state.promptRules = resolvePromptRules(pr.bulletfilter_prompt_rules, key);
  }
}, 800);
