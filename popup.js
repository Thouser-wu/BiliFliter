/**
 * Bilibili BulletFilter - Popup
 * 插件弹出窗口，提供快速控制界面
 */

document.addEventListener('DOMContentLoaded', async () => {
  // 加载设置
  const saved = await chrome.storage.local.get(['bulletfilter_settings']);
  const settings = saved.bulletfilter_settings || {};

  // 填充状态
  updateUI(settings);

  // 绑定事件
  bindEvents(settings);

  // 检查 Ollama 连接状态
  checkOllamaStatus(settings);

  // 拉取本地已部署模型，动态填充下拉框
  loadModelsFromOllama(settings);

  // 加载屏蔽词
  loadBlockwords();
  bindBlockwordEvents();

  // 屏蔽提示词：加载已有规则 + 绑定事件
  bindPromptEvents();
  loadPromptRules();

  refreshStats();
  setInterval(refreshStats, 1000);
  checkContentInjected();
});

function updateUI(settings) {
  // 主开关
  const enabledEl = document.getElementById('bf-popup-enabled');
  if (enabledEl) enabledEl.checked = settings.enabled ?? true;

  // 正则开关
  const regexEl = document.getElementById('bf-popup-regex');
  if (regexEl) regexEl.checked = settings.regexEnabled ?? true;

  // AI开关
  const aiEl = document.getElementById('bf-popup-ai');
  if (aiEl) aiEl.checked = settings.aiEnabled ?? true;

  // 敏感度
  const sensitivityEl = document.getElementById('bf-popup-sensitivity');
  if (sensitivityEl) sensitivityEl.value = settings.sensitivity || 'medium';

  // 模型选择由 loadModelsFromOllama 动态填充（只显示已部署模型）
  // Ollama地址
  const urlEl = document.getElementById('bf-popup-ollama-url');
  if (urlEl) urlEl.value = settings.ollamaUrl || 'http://localhost:11434';

  // 正则规则数
  const countEl = document.getElementById('bf-regex-count');
  if (countEl) countEl.textContent = (settings.regexPatterns || []).length;

  // 更新时间
  const timeEl = document.getElementById('bf-update-time');
  if (timeEl) timeEl.textContent = new Date().toLocaleString('zh-CN');
}

function getSettingsFromUI(fallbackSettings) {
  const url = document.getElementById('bf-popup-ollama-url')?.value?.trim() || fallbackSettings.ollamaUrl || 'http://localhost:11434';
  const aiModel = document.getElementById('bf-popup-model')?.value || fallbackSettings.aiModel || 'deepseek-r1:1.5b';
  const sensitivity = document.getElementById('bf-popup-sensitivity')?.value || fallbackSettings.sensitivity || 'medium';
  return { ollamaUrl: url, aiModel, sensitivity };
}

function sendMessage(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(response));
  });
}

async function sendMessageToActiveTab(message) {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (!tabId) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  } catch {
    return null;
  }
}

function formatStats(stats) {
  const seen = stats?.seen ?? 0;
  const kept = stats?.kept ?? 0;
  const filtered = stats?.filtered ?? 0;
  const regex = stats?.regexFiltered ?? 0;
  const hard = stats?.hardFiltered ?? 0;
  const bw = stats?.blockwordFiltered ?? 0;
  const rpt = stats?.repeatFiltered ?? 0;
  const ai = stats?.aiFiltered ?? 0;
  const lastResetAt = stats?.lastResetAt ? new Date(stats.lastResetAt) : null;
  const resetText = lastResetAt ? lastResetAt.toLocaleString('zh-CN') : '';
  const debug = stats?.diagnostics;
  const debugText = debug ? `
诊断：扫描 ${debug.watchdogRuns} / 标准节点 ${debug.standardNodes} / 屏蔽命中 ${debug.blockwordHits} / 隐藏调用 ${debug.hideCalls}${debug.lastHit ? ` / 最近命中「${debug.lastHit}」` : ''}` : '';
  return `已处理：${seen} 条
已过滤：${filtered} 条（正则 ${regex} / 固定 ${hard} / 屏蔽词 ${bw} / 刷屏 ${rpt} / AI ${ai}）
已保留：${kept} 条${resetText ? `
清零时间：${resetText}` : ''}${debugText}`;
}

// 自检：content script 是否已注入当前页面（确认扩展代码是否生效）
async function checkContentInjected() {
  const statusEl = document.getElementById('bf-popup-inject-status');
  const manifestVersion = chrome.runtime.getManifest().version || '?';
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    if (!tab?.id) { if (statusEl) statusEl.textContent = `v${manifestVersion}：无活动标签页`; return; }
    if (!tab.url || !tab.url.includes('bilibili.com')) {
      if (statusEl) statusEl.textContent = `v${manifestVersion}：当前不是 B 站页面`;
      return;
    }
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'bf_ping' }, { frameId: 0 });
    if (resp?.ok) {
      if (statusEl) { statusEl.style.color = '#0a7d32'; statusEl.textContent = `✅ v${resp.version} 已注入本页（扩展 v${manifestVersion}）`; }
    } else {
      if (statusEl) { statusEl.style.color = '#c0392b'; statusEl.textContent = `⚠️ v${manifestVersion} 未注入——请刷新本页`; }
    }
  } catch (e) {
    if (statusEl) {
      statusEl.style.color = '#c0392b';
      statusEl.textContent = `⚠️ v${manifestVersion} content script 未注入——请刷新 B 站页面`;
    }
  }
}

async function refreshStats() {
  const el = document.getElementById('bf-stats-text');
  if (!el) return;
  const resp = await sendMessageToActiveTab({ type: 'bf_get_stats' });
  if (!resp?.ok) {
    el.textContent = '仅在 B 站页面可用';
    return;
  }
  el.textContent = formatStats({ ...resp.stats, diagnostics: resp.diagnostics });
  // 列表展开时随统计自动刷新（每 1 秒），保证"共 N 条"实时更新
  const listEl = document.getElementById('bf-filtered-list');
  if (listEl && listEl.style.display !== 'none') {
    const mode = listEl.dataset.mode || 'filtered';
    if (mode === 'filtered') {
      renderFilteredList(true);
    } else if (mode === 'kept') {
      renderKeptList(true);
    }
  }
}

function bindEvents(settings) {
  // 主开关
  document.getElementById('bf-popup-enabled')?.addEventListener('change', async (e) => {
    settings.enabled = e.target.checked;
    await chrome.storage.local.set({ bulletfilter_settings: settings });
    updateStatus();
  });

  // 正则开关
  document.getElementById('bf-popup-regex')?.addEventListener('change', async (e) => {
    settings.regexEnabled = e.target.checked;
    await chrome.storage.local.set({ bulletfilter_settings: settings });
  });

  // AI开关
  document.getElementById('bf-popup-ai')?.addEventListener('change', async (e) => {
    settings.aiEnabled = e.target.checked;
    await chrome.storage.local.set({ bulletfilter_settings: settings });
  });

  // 敏感度
  document.getElementById('bf-popup-sensitivity')?.addEventListener('change', async (e) => {
    settings.sensitivity = e.target.value;
    await chrome.storage.local.set({ bulletfilter_settings: settings });
  });

  // 模型
  document.getElementById('bf-popup-model')?.addEventListener('change', async (e) => {
    settings.aiModel = e.target.value;
    await chrome.storage.local.set({ bulletfilter_settings: settings });
  });

  // Ollama地址
  document.getElementById('bf-popup-ollama-url')?.addEventListener('change', async (e) => {
    settings.ollamaUrl = e.target.value.trim();
    await chrome.storage.local.set({ bulletfilter_settings: settings });
    checkOllamaStatus(settings);
  });

  // 刷新按钮：全面重新同步（设置/规则/模型/Ollama/统计）
  document.getElementById('bf-popup-refresh')?.addEventListener('click', async () => {
    const statusEl = document.getElementById('bf-popup-sync-status');
    if (statusEl) statusEl.textContent = '正在重新同步...';
    const saved = await chrome.storage.local.get(['bulletfilter_settings']);
    const freshSettings = saved.bulletfilter_settings || settings;
    updateUI(freshSettings);
    checkOllamaStatus(freshSettings);
    loadModelsFromOllama(freshSettings);
    loadBlockwords();
    loadPromptRules();
    await refreshStats();
    if (statusEl) statusEl.textContent = '✅ 已重新同步';
    setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 2500);
  });


  // AI 调用验证
  document.getElementById('bf-test-run')?.addEventListener('click', async () => {
    const btn = document.getElementById('bf-test-run');
    const resultEl = document.getElementById('bf-test-result');
    const text = document.getElementById('bf-test-text')?.value || '';
    if (resultEl) resultEl.textContent = '测试中...';
    if (btn) btn.disabled = true;

    try {
      const current = getSettingsFromUI(settings);
      current.blockwords = getCurrentBlockwords();
      const resp = await sendMessage({ type: 'bf_test_ai', text, settings: current });
      if (!resultEl) return;

      if (!resp || resp.ok === false) {
        if (resp?.blockedByOrigin) {
          const origin = resp?.origin || `chrome-extension://${chrome.runtime.id}`;
          resultEl.textContent = `失败：${resp?.error || 'Ollama 拒绝了扩展来源(403)'}\n解决：把环境变量 OLLAMA_ORIGINS 设为该 Origin（或包含该 Origin 的列表），然后重启 Ollama\n建议值：${origin}`;
        } else {
          resultEl.textContent = `失败：${resp?.error || '未知错误'}`;
        }
        return;
      }

      const keepText = resp.keep ? '保留' : '过滤';
      const reasonText = resp.reason ? `（${resp.reason}）` : '';
      const meta = `${resp.model || current.aiModel} @ ${resp.url || current.ollamaUrl}`;
      resultEl.textContent = `结果：${keepText}${reasonText}\n${meta}`;
    } catch (e) {
      if (resultEl) resultEl.textContent = `失败：${e?.message || '未知错误'}`;
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // 统计刷新
  document.getElementById('bf-stats-refresh')?.addEventListener('click', async () => {
    await refreshStats();
  });

  // 统计清零
  document.getElementById('bf-stats-reset')?.addEventListener('click', async () => {
    const el = document.getElementById('bf-stats-text');
    if (el) el.textContent = '清零中...';
    const resp = await sendMessageToActiveTab({ type: 'bf_reset_stats' });
    if (!resp?.ok) {
      if (el) el.textContent = '仅在 B 站页面可用';
      return;
    }
    if (el) el.textContent = formatStats(resp.stats);
  });

  // 查看被过滤的弹幕
  document.getElementById('bf-show-filtered')?.addEventListener('click', async () => {
    renderFilteredList();
  });

  // 重置设置
  document.getElementById('bf-popup-reset')?.addEventListener('click', async () => {
    if (confirm('确定要重置所有设置吗？')) {
      await chrome.storage.local.clear();
      location.reload();
    }
  });
}

function updateStatus() {
  const statusEl = document.getElementById('bf-popup-status');
  if (statusEl) {
    statusEl.className = `bf-popup-status ${document.getElementById('bf-popup-enabled').checked ? 'on' : 'off'}`;
  }
}

// ==================== 自定义屏蔽词 ====================
let blockwordsData = { global: [], video: {} };
let currentVideoKey = '';

function getVideoKeyFromUrl(href) {
  try {
    const u = new URL(href);
    const m = u.pathname.match(/\/video\/(BV[0-9A-Za-z]+)/i);
    const bv = m ? m[1] : '';
    const p = u.searchParams.get('p') || '';
    if (bv) return `${bv}?p=${p}`;
    return '';
  } catch {
    return '';
  }
}

async function loadBlockwords() {
  const saved = await chrome.storage.local.get(['bulletfilter_blockwords']);
  blockwordsData = saved.bulletfilter_blockwords || { global: [], video: {} };
  if (typeof blockwordsData.global !== 'object' || !Array.isArray(blockwordsData.global)) blockwordsData.global = [];
  if (typeof blockwordsData.video !== 'object' || blockwordsData.video === null) blockwordsData.video = {};
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    currentVideoKey = tabs[0]?.url ? getVideoKeyFromUrl(tabs[0].url) : '';
  } catch {
    currentVideoKey = '';
  }
  renderBlockwords();
  renderActiveSummary();
}

function getScopeList() {
  const scope = document.getElementById('bf-blockword-scope')?.value || 'global';
  if (scope === 'global') return { list: blockwordsData.global, key: null };
  return { list: blockwordsData.video[currentVideoKey] || [], key: currentVideoKey };
}

function renderBlockwords() {
  const listEl = document.getElementById('bf-blockword-list');
  const hintEl = document.getElementById('bf-blockword-hint');
  const scopeEl = document.getElementById('bf-blockword-scope');
  if (!listEl || !scopeEl) return;

  const videoAvail = !!currentVideoKey;
  const videoOpt = scopeEl.querySelector('option[value="video"]');
  if (videoOpt) videoOpt.disabled = !videoAvail;
  if (scopeEl.value === 'video' && !videoAvail) scopeEl.value = 'global';

  const { list } = getScopeList();
  const isVideo = scopeEl.value === 'video';
  if (hintEl) {
    hintEl.textContent = isVideo
      ? (videoAvail ? `当前视频 ${currentVideoKey}` : '请先打开 B 站视频页')
      : `全局（共 ${list.length} 个）`;
  }
  if (!listEl) return;
  listEl.innerHTML = list.length === 0
    ? '<div class="bf-popup-filtered-empty">暂无屏蔽词</div>'
    : list.map((w, i) =>
        `<div class="bf-popup-blockword-item"><span>${escapeHtml(w)}</span><button data-idx="${i}" class="bf-blockword-del" title="删除">×</button></div>`
      ).join('');
  renderActiveSummary();
}

async function addBlockword() {
  const input = document.getElementById('bf-blockword-input');
  const word = input?.value?.trim();
  if (!word) return;
  const scopeEl = document.getElementById('bf-blockword-scope');
  if (scopeEl.value === 'global') {
    if (!blockwordsData.global.includes(word)) blockwordsData.global.push(word);
  } else {
    if (!currentVideoKey) return;
    if (!blockwordsData.video[currentVideoKey]) blockwordsData.video[currentVideoKey] = [];
    if (!blockwordsData.video[currentVideoKey].includes(word)) blockwordsData.video[currentVideoKey].push(word);
  }
  input.value = '';
  await chrome.storage.local.set({ bulletfilter_blockwords: blockwordsData });
  renderBlockwords();
  renderActiveSummary();
}

async function removeBlockword(idx) {
  const { list, key } = getScopeList();
  if (key) {
    blockwordsData.video[key].splice(idx, 1);
    if (blockwordsData.video[key].length === 0) delete blockwordsData.video[key];
  } else {
    blockwordsData.global.splice(idx, 1);
  }
  await chrome.storage.local.set({ bulletfilter_blockwords: blockwordsData });
  renderBlockwords();
  renderActiveSummary();
}

function bindBlockwordEvents() {
  document.getElementById('bf-blockword-scope')?.addEventListener('change', renderBlockwords);
  document.getElementById('bf-blockword-add')?.addEventListener('click', addBlockword);
  document.getElementById('bf-blockword-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addBlockword();
  });
  document.getElementById('bf-blockword-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.bf-blockword-del');
    if (btn && btn.dataset.idx !== undefined) removeBlockword(parseInt(btn.dataset.idx, 10));
  });
}

// 当前范围下的屏蔽词（供 AI 测试用）
function getCurrentBlockwords() {
  const { list } = getScopeList();
  return list.filter((w) => w && w.trim());
}

// 从 Ollama 拉取已部署模型，动态填充下拉框（只显示已部署的模型）
async function loadModelsFromOllama(settings) {
  const select = document.getElementById('bf-popup-model');
  const hint = document.getElementById('bf-popup-model-hint');
  if (!select) return;

  const offline = () => {
    select.innerHTML = '<option value="">Ollama 离线，未获取到模型</option>';
    if (hint) hint.textContent = '请先启动 Ollama 并部署模型';
  };

  try {
    const current = getSettingsFromUI(settings);
    const resp = await sendMessage({ type: 'bf_list_models', ollamaUrl: current.ollamaUrl });
    const savedModel = settings.aiModel || '';

    if (resp?.ok && Array.isArray(resp.models) && resp.models.length > 0) {
      const models = resp.models;
      select.innerHTML = '';
      models.forEach((name) => {
        const opt = document.createElement('option');
        opt.value = name;
        opt.textContent = name;
        select.appendChild(opt);
      });
      // 优先保持已保存的模型；不在列表则选第一个
      if (savedModel && models.includes(savedModel)) {
        select.value = savedModel;
      }
      if (hint) hint.textContent = `共 ${models.length} 个本地模型`;
    } else {
      offline();
    }
  } catch (e) {
    offline();
  }
}

async function checkOllamaStatus(settings) {
  const statusEl = document.getElementById('bf-popup-ollama-status');
  if (!statusEl) return;

  statusEl.textContent = '检测中...';

  try {
    const current = getSettingsFromUI(settings);
    const resp = await sendMessage({ type: 'bf_check_ollama', ollamaUrl: current.ollamaUrl });
    if (resp?.blockedByOrigin) {
      const origin = resp?.origin || `chrome-extension://${chrome.runtime.id}`;
      statusEl.textContent = `⚠️ Ollama 拒绝扩展来源(403)，需配置 OLLAMA_ORIGINS：${origin}`;
      statusEl.className = 'bf-popup-ollama disconnected';
      return;
    }
    if (!resp || !resp.online) throw new Error('离线');

    const modelCount = resp.modelCount ?? 0;
    if (modelCount === 0) {
      statusEl.textContent = '⚠️ Ollama 在线，但未发现模型（ollama list）';
      statusEl.className = 'bf-popup-ollama disconnected';
      return;
    }
    statusEl.textContent = `✅ Ollama 在线 (${modelCount} 个模型)`;
    statusEl.className = 'bf-popup-ollama connected';
  } catch (e) {
    statusEl.textContent = '❌ Ollama 离线';
    statusEl.className = 'bf-popup-ollama disconnected';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ==================== 屏蔽提示词 ====================
// 用户的一句话规则，注入本地 AI 的语义判断提示词（AI 判断每条弹幕时遵守）
let promptData = { global: [], video: {} };

function loadPromptRules() {
  chrome.storage.local.get(['bulletfilter_prompt_rules']).then((saved) => {
    promptData = saved.bulletfilter_prompt_rules || { global: [], video: {} };
    if (typeof promptData.global !== 'object' || !Array.isArray(promptData.global)) promptData.global = [];
    if (typeof promptData.video !== 'object' || promptData.video === null) promptData.video = {};
    renderPromptRules();
    renderActiveSummary();
  });
}

function renderPromptRules() {
  const listEl = document.getElementById('bf-prompt-list');
  if (!listEl) return;

  const globalRules = promptData.global || [];
  const videoRules = currentVideoKey ? (promptData.video?.[currentVideoKey] || []) : [];
  const items = [];
  globalRules.forEach((r) => items.push(promptItemHtml(r, '全局')));
  videoRules.forEach((r) => items.push(promptItemHtml(r, '当前视频')));

  listEl.innerHTML = items.length === 0
    ? '<div class="bf-popup-filtered-empty">暂无屏蔽提示词，试试「我希望屏蔽抽奖类弹幕」</div>'
    : items.join('');
}

function promptItemHtml(rule, scopeLabel) {
  return `<div class="bf-popup-intent-item">
    <div class="bf-popup-intent-item-head">
      <span class="bf-popup-intent-name">${escapeHtml(rule.text)}</span>
      <span class="bf-popup-intent-scope">${scopeLabel}</span>
      <button data-id="${escapeHtml(rule.id)}" class="bf-intent-del" title="删除">×</button>
    </div>
  </div>`;
}

async function addPromptRule() {
  const input = document.getElementById('bf-prompt-input');
  const text = input?.value?.trim();
  if (!text) {
    alert('请先输入屏蔽提示词，例如：我希望屏蔽抽奖类弹幕');
    return;
  }
  const scopeEl = document.getElementById('bf-prompt-scope');
  const scope = scopeEl?.value || 'global';
  const rule = {
    id: `pr_${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`,
    text,
    createdAt: Date.now(),
  };
  if (scope === 'global') {
    if (!promptData.global) promptData.global = [];
    promptData.global.push(rule);
  } else {
    if (!currentVideoKey) { alert('请先打开 B 站视频页'); return; }
    if (!promptData.video[currentVideoKey]) promptData.video[currentVideoKey] = [];
    promptData.video[currentVideoKey].push(rule);
  }
  await chrome.storage.local.set({ bulletfilter_prompt_rules: promptData });
  input.value = '';
  renderPromptRules();
  renderActiveSummary();
}

async function removePromptRule(id) {
  if (!id) return;
  promptData.global = (promptData.global || []).filter((r) => r.id !== id);
  if (currentVideoKey && promptData.video[currentVideoKey]) {
    promptData.video[currentVideoKey] = promptData.video[currentVideoKey].filter((r) => r.id !== id);
    if (promptData.video[currentVideoKey].length === 0) delete promptData.video[currentVideoKey];
  }
  await chrome.storage.local.set({ bulletfilter_prompt_rules: promptData });
  renderPromptRules();
  renderActiveSummary();
}

function bindPromptEvents() {
  document.getElementById('bf-prompt-add')?.addEventListener('click', addPromptRule);
  document.getElementById('bf-prompt-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addPromptRule();
  });
  document.getElementById('bf-prompt-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.bf-intent-del');
    if (btn && btn.dataset.id) removePromptRule(btn.dataset.id);
  });
}

// ==================== 生效屏蔽词总览 ====================
// 汇总当前正在生效的所有屏蔽词（手动 + AI意图），区分来源和范围
function renderActiveSummary() {
  const countEl = document.getElementById('bf-active-count');
  const listEl = document.getElementById('bf-active-list');
  if (!listEl) return;

  const globalBw = Array.isArray(blockwordsData?.global) ? blockwordsData.global : [];
  const videoBw = currentVideoKey && blockwordsData?.video?.[currentVideoKey]
    ? blockwordsData.video[currentVideoKey] : [];
  const globalPr = Array.isArray(promptData?.global) ? promptData.global : [];
  const videoPr = currentVideoKey && promptData?.video?.[currentVideoKey]
    ? promptData.video[currentVideoKey] : [];

  const total = globalBw.length + videoBw.length + globalPr.length + videoPr.length;

  if (countEl) {
    countEl.textContent = `共 ${total} 个生效` + (currentVideoKey ? ` · ${currentVideoKey}` : '');
  }

  const chip = (w, cls) => `<span class="bf-active-chip ${cls}">${escapeHtml(w)}</span>`;
  const group = (title, chipsHtml) =>
    `<div class="bf-popup-active-group"><div class="bf-popup-active-group-title">${title}</div><div>${chipsHtml}</div></div>`;

  let html = '';
  if (globalBw.length > 0) html += group(`手动 · 全局（${globalBw.length}）`, globalBw.map((w) => chip(w, 'bw')).join(''));
  if (videoBw.length > 0) html += group(`手动 · 当前视频（${videoBw.length}）`, videoBw.map((w) => chip(w, 'bw')).join(''));
  if (globalPr.length > 0) html += group(`提示词 · 全局（${globalPr.length}）`, globalPr.map((r) => `<div class="bf-active-prompt">${escapeHtml(r.text)}</div>`).join(''));
  if (videoPr.length > 0) html += group(`提示词 · 当前视频（${videoPr.length}）`, videoPr.map((r) => `<div class="bf-active-prompt">${escapeHtml(r.text)}</div>`).join(''));

  listEl.innerHTML = total === 0
    ? '<div class="bf-popup-filtered-empty">暂无生效屏蔽词</div>'
    : html;
}

// 查看已保留的弹幕
document.getElementById('bf-show-kept')?.addEventListener('click', async () => {
  renderKeptList();
});

// ==================== 列表渲染（被过滤 / 已保留，支持实时刷新） ====================

// 查看被过滤的弹幕：首次点击展开，再次点击收起；展开期间每 1 秒自动刷新
async function renderFilteredList(silentRefresh) {
  const listEl = document.getElementById('bf-filtered-list');
  if (!listEl) return;
  listEl.dataset.mode = 'filtered';

  if (listEl.style.display === 'none' || !listEl.style.display) {
    if (silentRefresh) return; // 定时刷新时列表未展开则不拉取
    listEl.style.display = 'block'; // 展开
  } else if (!silentRefresh) {
    listEl.style.display = 'none'; // 再次点击 → 收起
    return;
  }

  try {
    const resp = await sendMessageToActiveTab({ type: 'bf_get_filtered' });
    if (!resp?.ok) {
      if (!silentRefresh) {
        listEl.innerHTML = '<div class="bf-popup-filtered-empty">请先刷新 B 站页面（content script 未就绪）</div>';
      }
      return;
    }
    const total = resp.total ?? 0;
    const records = resp.filteredDanmakus || [];
    if (records.length === 0) {
      listEl.innerHTML = total > 0
        ? `<div class="bf-popup-filtered-count">共 ${total} 条被过滤（记录已超出缓冲）</div><div class="bf-popup-filtered-empty">暂无记录</div>`
        : '<div class="bf-popup-filtered-empty">暂无被过滤的弹幕</div>';
      return;
    }
    const items = records.map(item => {
      const time = new Date(item.time).toLocaleTimeString('zh-CN');
      return `<div class="bf-popup-filtered-item">
        <div class="bf-popup-filtered-text">${escapeHtml(item.text)}</div>
        <div class="bf-popup-filtered-reason">${escapeHtml(item.reason)} - ${time}</div>
      </div>`;
    }).join('');
    // total 用真实统计（记录可能因去重/上限少于统计）
    listEl.innerHTML = `<div class="bf-popup-filtered-count">共 ${total} 条被过滤（显示最近 ${records.length} 条）</div>${items}`;
  } catch (e) {
    if (!silentRefresh) {
      listEl.innerHTML = '<div class="bf-popup-filtered-empty">请先刷新 B 站页面（' + (e.message || '') + '）</div>';
    }
  }
}

// 查看已保留的弹幕：点击展开；展开期间每 1 秒自动刷新
async function renderKeptList(silentRefresh) {
  const listEl = document.getElementById('bf-filtered-list');
  if (!listEl) return;
  listEl.dataset.mode = 'kept';

  if (listEl.style.display === 'none' || !listEl.style.display) {
    if (silentRefresh) return;
    listEl.style.display = 'block'; // 展开
  } else if (!silentRefresh) {
    listEl.style.display = 'none'; // 再次点击 → 收起
    return;
  }

  try {
    const resp = await sendMessageToActiveTab({ type: 'bf_get_kept' });
    if (resp?.ok) {
      const items = (resp.keptDanmakus || []).slice().reverse();
      listEl.innerHTML = '';
      if (items.length === 0) {
        listEl.innerHTML = '<div class="bf-popup-filtered-empty">暂无已保留的弹幕</div>';
      } else {
        items.forEach((t) => {
          const d = document.createElement('div');
          d.className = 'bf-popup-filtered-item bf-popup-kept-item';
          d.textContent = t;
          listEl.appendChild(d);
        });
      }
      listEl.scrollTop = 0;
    } else if (!silentRefresh) {
      listEl.innerHTML = '<div class="bf-popup-filtered-empty">请先刷新 B 站页面（content script 未就绪）</div>';
    }
  } catch (e) {
    if (!silentRefresh) {
      listEl.innerHTML = '<div class="bf-popup-filtered-empty">请先刷新 B 站页面（' + (e.message || '') + '）</div>';
    }
  }
}
