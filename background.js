/**
 * Bilibili BulletFilter - Background Service Worker
 * 处理后台任务，如存储管理、版本更新通知等
 */

// 安装时初始化默认设置
const DEFAULT_REGEX_PATTERNS = [
  { pattern: '(.)\\1{14,}', flags: 'g', desc: '单条重复(极端)' },
  { pattern: '[〇○◎●■□▢▣▤▥▦▧▨▩]', flags: 'g', desc: '特殊符号' },
  { pattern: '[♠♣♥♦♤♧♡♢]', flags: 'g', desc: '花色符号' },
  { pattern: '(关注|粉丝|点赞|投币|收藏|转发|分享).*?(送|领|免费)', flags: 'ig', desc: '互动诱导+利益' },
  { pattern: 'v?\\d{9,}', flags: 'g', desc: '疑似QQ号/手机号' },
  { pattern: 'wx?[-_]\\w{4,}', flags: 'g', desc: '疑似微信号' },
  { pattern: '^(第|前).{1,4}[二三][排座]$|^[一二三四五六七八九十]+[排座]$', flags: 'g', desc: '排座党' },
  { pattern: '^来了$', flags: 'g', desc: '来了' },
  { pattern: '^来了\\.{3,}$', flags: 'g', desc: '来了带省略号' },
  { pattern: '^前排$', flags: 'g', desc: '前排' },
  { pattern: '^打卡$', flags: 'g', desc: '打卡' },
  { pattern: '^路过$', flags: 'g', desc: '路过' },
  { pattern: '^顶$', flags: 'g', desc: '顶' },
  { pattern: '^1$', flags: 'g', desc: '纯数字1' },
  { pattern: '^hh+$', flags: 'ig', desc: '哈哈哈简化' },
  { pattern: '^草+$', flags: 'ig', desc: '草的重复' },
  { pattern: '^\\d{4}[年-/]\\d{1,2}[月-/]\\d{1,2}(日)?$', flags: 'g', desc: '日期格式' },
  { pattern: '^\\d{1,2}:\\d{2}$', flags: 'g', desc: '时间格式' },
{ pattern: '.*(一日游|到此一游|占个坑|插眼|报到|签到).*', flags: 'g', desc: '打卡签名' },
  { pattern: '^[,，.。!?！？、；;：:：""「」『』【】…—\\s]+$|^\\s+$', flags: 'g', desc: '纯标点/空格' },
];

chrome.runtime.onInstalled.addListener((details) => {
  chrome.storage.local.get(['bulletfilter_settings'], (res) => {
    const existing = res.bulletfilter_settings;
    const merged = Object.assign({
      enabled: true,
      regexEnabled: true,
      aiEnabled: true,
      aiModel: 'qwen3:4b',
      ollamaUrl: 'http://localhost:11434',
      sensitivity: 'medium',
      regexPatterns: DEFAULT_REGEX_PATTERNS.map(p => ({ ...p, enabled: true })),
    }, existing && typeof existing === 'object' ? existing : {});

    if (!merged.regexPatterns || merged.regexPatterns.length === 0) {
      merged.regexPatterns = DEFAULT_REGEX_PATTERNS.map(p => ({ ...p, enabled: true }));
    }

    chrome.storage.local.set({ bulletfilter_settings: merged });
    if (details.reason === 'install') {
      console.log('[BulletFilter] 首次安装完成，已写入默认规则');
    }
  });
});

// 处理来自 content script 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'bf_check_ollama') {
    const url = message.ollamaUrl || message.url;
    checkOllamaHealth(url)
      .then((result) => sendResponse({ ...result, url: result.urlUsed, origin: `chrome-extension://${chrome.runtime.id}` }))
      .catch(() => sendResponse({ online: false, modelCount: 0, url }));
    return true; // 异步响应
  }

  if (message.type === 'bf_list_models') {
    const url = message.ollamaUrl || message.url;
    listModels(url)
      .then((result) => sendResponse({ ...result, url: result.urlUsed, origin: `chrome-extension://${chrome.runtime.id}` }))
      .catch(() => sendResponse({ ok: false, models: [], url }));
    return true;
  }

  if (message.type === 'bf_test_ai') {
    const text = (message.text || '').toString();
    const settings = message.settings || {};
    testAI(text, settings)
      .then((result) => sendResponse(result))
      .catch((e) => sendResponse({ ok: false, error: e?.message || '未知错误' }));
    return true;
  }

  // 处理content script的批量AI调用请求
  if (message.type === 'bf_call_ai_batch') {
    const texts = Array.isArray(message.texts) ? message.texts.map((t) => t.toString()) : [];
    const settings = message.settings || {};
    callAIBatchFromBackground(texts, settings)
      .then((result) => sendResponse(result))
      .catch((e) => sendResponse({ ok: false, error: e?.message || '未知错误' }));
    return true;
  }

  // 处理content script的AI调用请求
  if (message.type === 'bf_call_ai') {
    const text = (message.text || '').toString();
    const settings = message.settings || {};
    callAIFromBackground(text, settings)
      .then((result) => sendResponse(result))
      .catch((e) => sendResponse({ keep: true, reason: 'AI调用失败: ' + e.message }));
    return true;
  }
});

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

function normalizeOllamaUrl(url) {
  const u = (url || '').toString().trim();
  return u.length > 0 ? u.replace(/\/+$/, '') : 'http://localhost:11434';
}

// 将用户自定义屏蔽词追加到 AI 提示词（优先级最高）
function buildPromptWithBlockwords(basePrompt, blockwords) {
  const list = Array.isArray(blockwords) ? blockwords.filter((w) => w && w.trim()) : [];
  if (list.length === 0) return basePrompt;
  return basePrompt + "\n\n【用户自定义屏蔽词 - 优先级最高】\n以下关键词是用户根据视频内容手动设置的屏蔽词。弹幕只要包含其中任意一个词，无论上下文和语气，一律过滤，reason 注明\"自定义屏蔽词\"：\n- " + list.join("\n- ");
}

// 将用户屏蔽提示词（语义规则）追加到 AI 提示词（优先级最高，AI 判断时遵守）
function buildPromptWithPromptRules(basePrompt, promptRules) {
  const list = Array.isArray(promptRules) ? promptRules.filter((r) => r && r.text && r.text.trim()) : [];
  if (list.length === 0) return basePrompt;
  const lines = list.map((r) => '- ' + r.text.trim()).join('\n');
  return basePrompt + '\n\n【用户屏蔽要求 - 优先级最高】\n用户明确要求屏蔽以下类型的弹幕：\n' + lines + '\n弹幕只要符合以上任何一条要求，无论其他判断如何，一律过滤，reason 注明"用户要求"。';
}

// 构建批量判断的提示词：基础规则 + 屏蔽词 + 屏蔽提示词 + 批量输出格式
function buildBatchPrompt(settings) {
  const sensitivity = (settings.sensitivity || 'medium').toString();
  let prompt = AI_PROMPT_TEMPLATES[sensitivity] || AI_PROMPT_TEMPLATES.medium;
  prompt = buildPromptWithBlockwords(prompt, settings.blockwords);
  prompt = buildPromptWithPromptRules(prompt, settings.promptRules);
  prompt += `

我会一次给你多条弹幕，请逐条判断是否有价值。
只输出JSON：{"results": [{"text": "与输入完全一致的弹幕原文", "keep": true/false, "reason": "简短原因"}, ...]}
results 必须包含我提供的每一条弹幕，不能遗漏，text 字段与输入完全一致，顺序一致。
不要输出任何其他内容。`;
  return prompt;
}

// 批量调用 Ollama 判断多条弹幕（一次请求处理多条，显著提升吞吐）
async function callAIBatchFromBackground(texts, settings) {
  if (!texts || texts.length === 0) return { ok: true, results: [] };
  const baseUrl = normalizeOllamaUrl(settings.ollamaUrl);
  const model = (settings.aiModel || 'qwen3:4b').toString();
  const prompt = buildBatchPrompt(settings);

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: '弹幕列表：\n' + texts.map((t, i) => `${i + 1}. ${t}`).join('\n') },
      ],
      stream: false,
      think: false,
      format: 'json',
      options: { temperature: 0.2, num_predict: 500 },
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    if (response.status === 403) return { ok: false, error: 'Ollama 拒绝请求(403)' };
    throw new Error(`Ollama API 错误: ${response.status}`);
  }

  const data = await response.json();
  const content = data.message?.content || data.message?.thinking || '';

  let results = [];
  try {
    const jsonMatch = content.match(/\{[\s\S]+\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      results = Array.isArray(parsed.results) ? parsed.results : [];
    }
  } catch {
    results = [];
  }

  // 容错：JSON 截断时单独提取 results 数组
  if (results.length === 0) {
    try {
      const arrMatch = content.match(/"results"\s*:\s*(\[[\s\S]*\])/);
      if (arrMatch) {
        const arr = JSON.parse(arrMatch[1]);
        results = Array.isArray(arr) ? arr : [];
      }
    } catch {
      results = [];
    }
  }

  return {
    ok: true,
    results: results.filter((r) => r && typeof r.text === 'string' && typeof r.keep === 'boolean'),
  };
}

// 从background调用AI（不受CORS限制）
async function callAIFromBackground(text, settings) {
  const baseUrl = normalizeOllamaUrl(settings.ollamaUrl);
  const model = (settings.aiModel || 'qwen3:4b').toString();
  const sensitivity = (settings.sensitivity || 'medium').toString();
  const basePrompt = buildPromptWithBlockwords(AI_PROMPT_TEMPLATES[sensitivity] || AI_PROMPT_TEMPLATES.medium, settings.blockwords);
  const prompt = buildPromptWithPromptRules(basePrompt, settings.promptRules);

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: `请判断以下弹幕是否有价值：\n"${text}"` },
      ],
      stream: false,
      think: false,
      format: 'json',
      options: {
        temperature: 0.3,
        num_predict: 50,
      },
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Ollama API 错误: ${response.status}`);
  }

  const data = await response.json();
  const content = data.message?.content || data.message?.thinking || '';

  let parsed = null;
  try {
    const jsonMatch = content.match(/\{[^}]+\}/);
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
  } catch {
    parsed = null;
  }

  if (!parsed || typeof parsed.keep !== 'boolean') {
    return { keep: true, reason: '无法解析模型输出' };
  }

  // 如果reason包含"没有价值"等关键词，强制过滤
  const negativeReasons = ['没有价值', '无意义', '没有提供', '不具有价值', '不包含', '没有内容', '没有观点'];
  if (parsed.keep !== false && parsed.reason && negativeReasons.some(kw => parsed.reason.includes(kw))) {
    return { keep: false, reason: parsed.reason };
  }

  return parsed;
}

function normalizeForRules(text) {
  return (text || '').toString().trim().replace(/\s+/g, '');
}

function getHardBlockResult(text, sensitivity) {
  const t = normalizeForRules(text);
  if (!t) return { blocked: false };

  const s = (sensitivity || 'medium').toString();

  // 第一类：整条精确匹配（仅当弹幕恰好等于关键词）
  const low = new Set(['到此一游', '打卡', '路过']);
  const medium = new Set(['到此一游', '打卡', '路过', '签到', '前排', '来了', '顶']);
  const high = new Set(['到此一游', '打卡', '路过', '签到', '前排', '来了', '顶', '留名', '占位', '占个坑', '来了来了']);
  const exactSet = s === 'low' ? low : s === 'high' ? high : medium;
  if (exactSet.has(t)) return { blocked: true, reason: `命中固定规则：${t}` };

  // 第二类：包含式匹配 —— 弹幕中出现打卡/签名词即拦截
  // 解决 "黄茂坤在弹幕里这里一日游" 这类带人名/前缀的打卡弹幕
  const strongKeywords = ['一日游', '到此一游', '到此一坐', '占个坑', '占个位', '考古', '插眼', '留名', '留个名', '占位', '签到', '签个到', '打卡', '打个卡'];
  const mediumKeywords = ['报到', '标记'];
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

// AI 意图 → 屏蔽规则 生成器提示词
// 列出本地已部署的模型名称
async function listModels(url) {
  const baseUrl = normalizeOllamaUrl(url);
  try {
    const resp = await fetch(`${baseUrl}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return { ok: false, models: [], urlUsed: baseUrl, status: resp.status };
    const data = await resp.json();
    const models = Array.isArray(data.models) ? data.models.map(m => m.name) : [];
    return { ok: true, models, urlUsed: baseUrl };
  } catch {
    return { ok: false, models: [], urlUsed: baseUrl };
  }
}

async function checkOllamaHealth(url) {
  const baseUrl = normalizeOllamaUrl(url);
  try {
    const resp = await fetch(`${baseUrl}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) {
      if (resp.status === 403) {
        return { online: false, modelCount: 0, urlUsed: baseUrl, blockedByOrigin: true, status: 403 };
      }
      return { online: false, modelCount: 0, urlUsed: baseUrl, status: resp.status };
    }
    const data = await resp.json();
    const modelCount = Array.isArray(data.models) ? data.models.length : 0;
    return { online: true, modelCount, urlUsed: baseUrl, hasModels: modelCount > 0 };
  } catch {
    return { online: false, modelCount: 0, urlUsed: baseUrl };
  }
}

async function testAI(text, settings) {
  const baseUrl = normalizeOllamaUrl(settings.ollamaUrl);
  const model = (settings.aiModel || 'qwen3:4b').toString();
  const sensitivity = (settings.sensitivity || 'medium').toString();
  const basePrompt = buildPromptWithBlockwords(AI_PROMPT_TEMPLATES[sensitivity] || AI_PROMPT_TEMPLATES.medium, settings.blockwords);
  const prompt = buildPromptWithPromptRules(basePrompt, settings.promptRules);
  const origin = `chrome-extension://${chrome.runtime.id}`;

  if (!text || text.trim().length === 0) {
    return { ok: false, error: '请输入要测试的弹幕文本', url: baseUrl, model, origin };
  }

  const hard = getHardBlockResult(text, sensitivity);
  if (hard.blocked) {
    return { ok: true, keep: false, reason: hard.reason, raw: '', url: baseUrl, model, origin };
  }

  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: `请判断以下弹幕是否有价值：\n"${text}"` },
      ],
      stream: false,
      think: false,
      format: 'json',
      options: {
        temperature: 0.3,
        num_predict: 80,
      },
    }),
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    if (response.status === 403) {
      return {
        ok: false,
        error: `Ollama 拒绝了当前请求来源(403)。需要在 Ollama 允许该 Origin：${origin}（设置 OLLAMA_ORIGINS）。`,
        url: baseUrl,
        model,
        status: 403,
        blockedByOrigin: true,
        origin,
      };
    }
    return { ok: false, error: `Ollama API 错误: ${response.status}`, url: baseUrl, model, status: response.status, origin };
  }

  const data = await response.json();
  const content = data.message?.content || data.message?.thinking || '';

  let parsed = null;
  try {
    const jsonMatch = content.match(/\{[^}]+\}/);
    if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
  } catch {
    parsed = null;
  }

  if (!parsed || typeof parsed.keep !== 'boolean') {
    return { ok: true, keep: true, reason: '无法解析模型输出，按保留处理', raw: content, url: baseUrl, model, origin };
  }

  return {
    ok: true,
    keep: parsed.keep,
    reason: parsed.reason || '',
    raw: content,
    url: baseUrl,
    model,
    origin,
  };
}
