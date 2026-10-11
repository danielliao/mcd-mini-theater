import { analyzeOrders, createStory, createSelfStory, demoScenarios, redactText } from '../src/theater.mjs';
import { avatarSvg, drawAvatar, kinds } from './characters.mjs';

const $ = id => document.getElementById(id);
const fontStack = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
const foods = [
  { name: '板烧鸡腿堡', kind: 'burger' }, { name: '巨无霸', kind: 'burger' },
  { name: '中薯条', kind: 'fries' }, { name: '无糖可乐', kind: 'drink' },
  { name: '美式咖啡', kind: 'drink' }, { name: '麦乐鸡', kind: 'chicken' },
  { name: '香草甜筒', kind: 'dessert' }, { name: '麦香鱼', kind: 'burger' },
];
const scenarioDetails = {
  repeat: ['burger', '老朋友，又见面'], 'drink-leading': ['drink', '谁才是真正的主角'],
  variety: ['chicken', '今天的演员有点多'], duo: ['fries', '固定搭档，一起出场'],
};
const selectedFoods = new Set(['板烧鸡腿堡', '中薯条', '无糖可乐']);
let mode = 'demo';
let activeScenario = demoScenarios[0].id;
let facts = null;
let story = null;
let provenance = 'demo';
let variant = 0;
let importedKind = null;
let embeddedDemo = false;
let activeSelfFoods = [];
let exporting = false;
let collecting = false;
const localService = /^https?:$/.test(location.protocol) && ['localhost', '127.0.0.1'].includes(location.hostname);

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}
function foodAvatar(kind, className) {
  const node = element('span', className);
  // Only fixed SVG artwork from this module is inserted. File content never enters innerHTML.
  node.innerHTML = avatarSvg(kind);
  return node;
}
function announce(message, isError = false) {
  $('status').textContent = message;
  $('status').classList.toggle('error', isError);
}
function sourceText(short = false) {
  if (provenance === 'demo') return '虚构演示';
  if (provenance === 'self') return '自选体验';
  if (provenance === 'mcp') return '近期实际订单';
  return short ? '导入内容' : '导入内容 · 来源由提供者声明';
}
function render() {
  $('source-label').textContent = sourceText(true);
  $('preview-source').textContent = sourceText(true);
  $('poster-source').textContent = sourceText(true);
  $('story-summary').textContent = story.title;
  $('poster-title').textContent = '我的麦当劳\n背着我开了个群';
  $('group-name').textContent = story.groupName;
  $('member-count').textContent = `${story.members.length} 位群成员 · ${sourceText(true)}`;
  const stack = $('member-stack');
  stack.replaceChildren(...story.members.map(member => foodAvatar(member.kind, 'member-avatar')));
  const cast = new Map(story.members.map(member => [member.id, member]));
  const messages = story.messages.map(message => {
    const member = cast.get(message.speakerId);
    const row = element('div', 'chat-row');
    const content = element('div', 'chat-content');
    content.append(element('span', 'speaker-name', member.name), element('div', 'chat-bubble', message.text));
    row.append(foodAvatar(member.kind, 'chat-avatar'), content);
    return row;
  });
  $('message-list').replaceChildren(...messages);
  $('system-message').textContent = story.systemMessage;
  $('poster-disclaimer').textContent = provenance === 'imported'
    ? '导入内容 · 来源由提供者声明 · 食物群聊为娱乐创作'
    : provenance === 'demo'
      ? '虚构演示 · 未读取真实订单 · 食物群聊为娱乐创作'
      : provenance === 'mcp'
        ? '来自近期已完成订单 · 食物群聊为娱乐创作'
        : '自选体验 · 未读取订单 · 食物群聊为娱乐创作';
  $('poster-sample').textContent = story.sampleLabel;
  $('poster-evidence-text').textContent = story.evidence[0] ?? '未提供可核对的餐品依据。';
  const evidence = story.evidence.slice(0, 4).map(text => element('span', 'evidence-chip', text));
  $('evidence-list').replaceChildren(...evidence);
  $('reroll').disabled = importedKind === 'story' || exporting;
  $('reroll-hint').textContent = importedKind === 'story'
    ? embeddedDemo ? '内置演示已加载。点击“先玩一段”可切换场景与台词。' : '已保留导入故事的台词。可在助手中改稿后再次导入。'
    : '笑点可以重来，餐品事实保持不变。';
  for (const button of document.querySelectorAll('.scenario-button')) {
    button.setAttribute('aria-pressed', String(provenance === 'demo' && button.dataset.scenario === activeScenario));
  }
}
function switchMode(next) {
  mode = next;
  for (const key of ['demo', 'self', 'import', 'connect']) {
    $(`${key}-panel`).hidden = key !== next;
    $(`${key}-tab`).setAttribute('aria-selected', String(key === next));
  }
  announce('');
}
function showDemo(id) {
  embeddedDemo = false;
  const scenario = demoScenarios.find(item => item.id === id) || demoScenarios[0];
  activeScenario = scenario.id;
  provenance = 'demo';
  importedKind = null;
  variant = 0;
  facts = analyzeOrders(scenario.orders, { source: 'demo' });
  story = createStory(facts, variant);
  render();
}
function showSelf() {
  embeddedDemo = false;
  const choices = foods.filter(food => selectedFoods.has(food.name));
  if (choices.length < 2 || choices.length > 3) return announce('请先选 2–3 位群成员。', true);
  provenance = 'self';
  importedKind = null;
  variant = 0;
  facts = null;
  activeSelfFoods = choices.map(food => ({ ...food }));
  story = createSelfStory(activeSelfFoods, variant);
  render();
  announce('他们入群了。换一段台词，看看下一句。');
}
function safeText(input, label, max = 160, empty = false) {
  if (typeof input !== 'string' || input.length > max || (!empty && !input.trim())) throw new Error(`${label}的格式或长度不正确。`);
  return redactText(input.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim());
}
export function validateImportedStory(data) {
  if (!data || typeof data !== 'object' || data.version !== 1) throw new Error('请导入麦麦小剧场 version 1 故事文件。');
  if (!Array.isArray(data.members) || data.members.length < 1 || data.members.length > 6) throw new Error('故事应包含 1–6 位群成员。');
  const seen = new Map();
  const members = data.members.map((member, index) => {
    safeText(member?.id, '群成员 ID', 80);
    const rawId = member.id;
    if (seen.has(rawId)) throw new Error('群成员 ID 重复。');
    const id = `member-${index + 1}`;
    seen.set(rawId, id);
    return { id, name: safeText(member?.name, '餐品名称', 80), kind: kinds.includes(member?.kind) ? member.kind : 'other' };
  });
  if (!Array.isArray(data.messages) || data.messages.length < 1 || data.messages.length > 12) throw new Error('故事应包含 1–12 条台词。');
  const messages = data.messages.map(message => {
    safeText(message?.speakerId, '发言成员', 80);
    if (!seen.has(message.speakerId)) throw new Error('某条台词的发言者不在群成员名单中。');
    return { speakerId: seen.get(message.speakerId), text: safeText(message?.text, '台词', 180) };
  });
  if (!Array.isArray(data.evidence) || data.evidence.length > 10) throw new Error('故事证据卡的格式不正确。');
  return {
    version: 1, source: 'imported', themeId: typeof data.themeId === 'string' ? data.themeId.slice(0, 80) : 'imported',
    title: safeText(data.title, '标题', 80), groupName: safeText(data.groupName, '群名', 80),
    members, messages, systemMessage: safeText(data.systemMessage ?? '', '系统消息', 180, true),
    evidence: data.evidence.map(text => safeText(text, '证据卡', 240)),
    caption: safeText(data.caption ?? '我的麦当劳，背着我开了个群。你的会聊什么？', '分享文案', 1000),
    sampleLabel: `提供者标注：${safeText(data.sampleLabel ?? '未提供样本范围', '样本范围', 160)}`, disclaimer: '导入内容的餐品与台词由文件提供者声明；食品拟人台词为娱乐创作。',
  };
}
function sanitizeOrders(data) {
  const orders = Array.isArray(data) ? data : data?.orders;
  if (!Array.isArray(orders) || orders.length < 1 || orders.length > 100) throw new Error('订单文件应包含 1–100 笔订单数组；只分析最新在前的前 10 笔。');
  return orders.map((order, index) => {
    if (!Array.isArray(order?.items) || order.items.length < 1 || order.items.length > 60) throw new Error(`第 ${index + 1} 笔订单缺少有效餐品列表。`);
    return {
      id: `imported-order-${index + 1}`,
      items: order.items.map(item => {
        const name = safeText(item?.name, '餐品名称', 80);
        if (!Number.isSafeInteger(item?.quantity) || item.quantity < 1 || item.quantity > 100) throw new Error(`「${name}」的数量必须是 1–100 的整数。`);
        // IDs are deliberately converted to local opaque identifiers; no personal fields are retained.
        return { id: typeof item.id === 'number' || typeof item.id === 'string' ? `item-${String(item.id).slice(0, 100)}` : `name-${name}`, name, kind: kinds.includes(item.kind) ? item.kind : 'other', quantity: item.quantity };
      }),
    };
  });
}
function applyImport(data, filename = '导入内容') {
  embeddedDemo = false;
  const importedStory = data?.story ?? data;
  if (importedStory?.version === 1 && Array.isArray(importedStory.members) && Array.isArray(importedStory.messages)) {
    story = validateImportedStory(importedStory);
    facts = null;
    importedKind = 'story';
  } else {
    const orders = sanitizeOrders(data);
    facts = analyzeOrders(orders, { source: 'imported' });
    story = createStory(facts, 0);
    importedKind = 'orders';
  }
  provenance = 'imported';
  variant = 0;
  filename = redactText(String(filename).slice(0, 120));
  switchMode('import');
  $('import-status').hidden = false;
  $('import-status').classList.remove('error');
  $('import-status').textContent = `${filename} · 已载入${importedKind === 'story' ? '故事' : '餐品记录'}。来源由文件提供者声明。`;
  render();
  announce('已载入。请检查台词与来源标签，再分享。');
}
async function importFile(file) {
  if (!file) return;
  try {
    if (file.size > 1024 * 1024) throw new Error('文件太大，请导入 1 MB 以内的脱敏 JSON。');
    const data = JSON.parse(await file.text());
    applyImport(data, file.name);
  } catch (error) {
    $('import-status').hidden = false;
    $('import-status').classList.add('error');
    $('import-status').textContent = error instanceof SyntaxError ? '文件不是有效 JSON，请重新导出后导入。' : error.message;
    announce('未能导入，当前分享卡已保留。', true);
  } finally {
    $('file-input').value = '';
  }
}

function roundRect(ctx, x, y, width, height, radius, fill, stroke) {
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); }
}
function textLines(ctx, text, maxWidth) {
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const char of Array.from(paragraph)) {
      if (line && ctx.measureText(line + char).width > maxWidth) { lines.push(line); line = char; }
      else line += char;
    }
    lines.push(line);
  }
  return lines;
}
function paintText(ctx, lines, x, y, lineHeight, color) {
  ctx.fillStyle = color;
  lines.forEach((line, index) => ctx.fillText(line, x, y + index * lineHeight));
}
function canvasFont(ctx, size, weight = 400) {
  ctx.font = `${weight} ${size}px ${fontStack}`;
  ctx.textBaseline = 'top';
}
export async function createShareCanvas() {
  await document.fonts?.ready;
  const currentStory = structuredClone(story);
  const source = sourceText(true);
  const currentProvenance = provenance;
  const cast = new Map(currentStory.members.map(member => [member.id, member]));
  const measurement = document.createElement('canvas').getContext('2d');
  canvasFont(measurement, 28, 500);
  const rows = currentStory.messages.map(message => {
    const lines = textLines(measurement, message.text, 690);
    const widths = lines.map(line => measurement.measureText(line).width);
    return { message, lines, bubbleWidth: Math.min(738, Math.max(125, Math.max(...widths) + 48)), height: Math.max(86, lines.length * 43 + 38) };
  });
  canvasFont(measurement, 22);
  const systemLines = textLines(measurement, currentStory.systemMessage, 810);
  canvasFont(measurement, 20);
  const scopeLines = textLines(measurement, currentStory.sampleLabel, 814);
  const evidenceLines = textLines(measurement, currentStory.evidence[0] ?? '未提供可核对的餐品依据。', 814);
  const evidenceHeight = 36 + scopeLines.length * 28 + evidenceLines.length * 30;
  const chatHeight = rows.reduce((sum, row) => sum + row.height + 62, 0);
  const height = Math.max(1440, 548 + chatHeight + systemLines.length * 32 + evidenceHeight + 285);
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#FFD35B'; ctx.fillRect(0, 0, 1080, height);
  ctx.fillStyle = '#EEC557';
  for (let x = 20; x < 1080; x += 29) for (let y = 20; y < height; y += 29) { ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill(); }
  roundRect(ctx, 54, 68, 972, height - 105, 17, '#D3A333');
  roundRect(ctx, 54, 48, 972, height - 105, 17, '#FFFDF6');
  canvasFont(ctx, 32, 800); paintText(ctx, ['麦麦小剧场 ●'], 110, 102, 42, '#CE4133');
  canvasFont(ctx, 21, 550);
  const badgeWidth = ctx.measureText(source).width + 28;
  roundRect(ctx, 970 - badgeWidth, 104, badgeWidth, 34, 5, '#FFFDF6', '#E5DAC7');
  paintText(ctx, [source], 984 - badgeWidth, 110, 25, '#9C8C76');
  canvasFont(ctx, 79, 850); paintText(ctx, ['我的麦当劳', '背着我开了个群'], 108, 177, 100, '#312822');
  canvasFont(ctx, 95, 400); paintText(ctx, ['✳'], 898, 245, 110, '#CE4133');
  roundRect(ctx, 108, 416, 864, 98, 20, '#F8F0DF', '#E5D9C4');
  const avatarCount = currentStory.members.length;
  for (let index = 0; index < Math.min(avatarCount, 4); index++) await drawAvatar(ctx, currentStory.members[index].kind, 129 + index * 41, 436, 57);
  const groupX = Math.min(avatarCount, 4) * 41 + 161;
  canvasFont(ctx, 27, 700);
  const groupLines = textLines(ctx, currentStory.groupName, 897 - groupX);
  paintText(ctx, [groupLines[0] + (groupLines.length > 1 ? '…' : '')], groupX, 433, 35, '#312822');
  canvasFont(ctx, 19, 400); paintText(ctx, [`${avatarCount} 位群成员 · ${source}`], groupX, 471, 26, '#817363');
  canvasFont(ctx, 41); paintText(ctx, ['···'], 911, 443, 42, '#312822');
  let y = 548;
  for (const row of rows) {
    const member = cast.get(row.message.speakerId);
    canvasFont(ctx, 22, 450); paintText(ctx, [member.name], 221, y, 27, '#90816A');
    roundRect(ctx, 108, y + 32, 89, 89, 21, '#F5ECD9', '#ECE0CC');
    await drawAvatar(ctx, member.kind, 111, y + 35, 83);
    const index = rows.indexOf(row);
    roundRect(ctx, 221, y + 33, row.bubbleWidth, row.height, [6, 22, 22, 22], index % 3 === 0 ? '#FFF0C3' : '#F3EDDF', index % 3 === 0 ? '#ECD5A1' : '#E7DEC9');
    canvasFont(ctx, 28, 500); paintText(ctx, row.lines, 245, y + 51, 43, '#312822');
    y += row.height + 62;
  }
  canvasFont(ctx, 22, 400);
  for (const [index, line] of systemLines.entries()) {
    const content = index === 0 ? `↳ ${line}` : line;
    paintText(ctx, [content], (1080 - ctx.measureText(content).width) / 2, y + index * 32, 32, '#A38E69');
  }
  y += systemLines.length * 32 + 33;
  roundRect(ctx, 108, y, 864, evidenceHeight, 13, '#F8F3E8', '#E9DFCC');
  canvasFont(ctx, 20, 600); paintText(ctx, scopeLines, 133, y + 16, 28, '#A08B65');
  canvasFont(ctx, 20, 400); paintText(ctx, evidenceLines, 133, y + 22 + scopeLines.length * 28, 30, '#8D7D63');
  y += evidenceHeight + 35;
  ctx.beginPath(); ctx.setLineDash([6, 7]); ctx.moveTo(108, y); ctx.lineTo(972, y); ctx.strokeStyle = '#D9CDB8'; ctx.lineWidth = 2; ctx.stroke(); ctx.setLineDash([]);
  canvasFont(ctx, 31, 700); paintText(ctx, ['给你的订单，也开个群。'], 108, y + 31, 40, '#312822');
  canvasFont(ctx, 20, 450); paintText(ctx, ['麦麦小剧场 · 开源 Skill'], 108, y + 78, 27, '#9C8A6B');
  ctx.beginPath(); ctx.arc(931, y + 64, 41, 0, Math.PI * 2); ctx.fillStyle = '#CE4133'; ctx.fill();
  canvasFont(ctx, 54, 450); paintText(ctx, ['↗'], 909, y + 38, 60, '#FFFDF6');
  canvasFont(ctx, 17, 400);
  const disclaimer = source === '导入内容' ? '导入内容 · 来源由提供者声明 · 食物群聊为娱乐创作' : currentProvenance === 'mcp' ? '来自近期已完成订单 · 食物群聊为娱乐创作' : `${source} · 未读取真实订单 · 食物群聊为娱乐创作`;
  paintText(ctx, [disclaimer], (1080 - ctx.measureText(disclaimer).width) / 2, height - 92, 22, '#AB9B85');
  return canvas;
}
async function downloadPng() {
  if (exporting) return;
  exporting = true;
  $('download').disabled = true;
  $('download').textContent = '正在生成图片…';
  announce('');
  try {
    const canvas = await createShareCanvas();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('当前浏览器无法导出图片。');
    const url = URL.createObjectURL(blob);
    const link = element('a');
    link.href = url;
    link.download = `麦麦小剧场-${provenance}-${Date.now()}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    announce(`分享图已下载 · ${canvas.width} × ${canvas.height}。`);
  } catch (error) { announce(`图片生成失败：${error.message}`, true); }
  finally {
    exporting = false;
    $('download').disabled = false;
    $('download').replaceChildren(element('span', '', '↓'), document.createTextNode(' 下载分享图'));
    render();
  }
}
async function copyCaption() {
  const label = provenance === 'demo' ? '（虚构演示）' : provenance === 'self' ? '（自选餐品体验）' : provenance === 'mcp' ? '（来自近期已完成订单）' : '（导入内容，来源由提供者声明）';
  const text = `${story.caption}\n${label}\n给你的订单，也开个群。\n#麦麦小剧场`;
  try {
    let copied = false;
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(text); copied = true; } catch { /* Try the local-file compatible fallback below. */ }
    }
    if (!copied) {
      const input = document.createElement('textarea'); input.value = text; input.style.position = 'fixed'; input.style.opacity = '0'; document.body.append(input); input.select();
      copied = document.execCommand('copy'); input.remove();
    }
    if (!copied) throw new Error('当前浏览器不支持复制。');
    announce('分享文案已复制。和图片一起发给朋友吧。');
  } catch { announce('复制未成功，请使用浏览器允许的复制功能。', true); }
}
async function collectOrders(event) {
  event.preventDefault();
  if (!localService || collecting) return;
  const token = $('token-input').value.trim();
  $('token-input').value = '';
  if (!token) { $('connect-status').hidden = false; $('connect-status').classList.add('error'); $('connect-status').textContent = '请先粘贴麦当劳 MCP Token。'; return; }
  collecting = true;
  $('token-input').disabled = true;
  $('collect-button').disabled = true;
  $('collect-button').textContent = '正在读取订单…';
  $('connect-status').hidden = false;
  $('connect-status').classList.remove('error');
  $('connect-status').textContent = '正在连接官方 MCP 并读取近期已完成订单，请稍候。';
  announce('');
  try {
    const response = await fetch('/api/collect', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    let payload;
    try { payload = await response.json(); } catch { throw new Error('本机服务未返回可读的订单结果。请重启服务后重试。'); }
    if (!response.ok || payload.error) {
      const messages = { unauthorized: 'Token 未通过验证，请重新获取后重试。', auth_failed: 'Token 未通过验证，请重新获取后重试。', invalid_token: 'Token 格式无效，请确认复制完整。', invalid_token_input: 'Token 格式无效，请确认复制完整。', missing_token: '请先粘贴麦当劳 MCP Token。', request_in_progress: '正在读取订单，请等这次连接完成。', local_origin_required: '请从本机小剧场页面发起连接。', no_completed_orders: '没有找到可用的近期已完成订单。', no_orders: '没有找到可用的近期已完成订单。', timeout: '读取超时，请稍后重试。', network_error: '连接未成功，请检查网络后重试。', rate_limited: '官方服务请求较多，请稍后再试。' };
      throw new Error(messages[payload.error?.code] || '读取未成功，请检查 Token 与网络连接后重试。');
    }
    if (payload.source !== 'mcp') throw new Error('服务没有返回可验证的 MCP 读取结果，请重启本机服务后重试。');
    const orders = sanitizeOrders(payload);
    const nextFacts = analyzeOrders(orders, { source: 'mcp' });
    const nextStory = createStory(nextFacts, 0);
    facts = nextFacts;
    story = nextStory;
    variant = 0;
    importedKind = null;
    embeddedDemo = false;
    provenance = 'mcp';
    render();
    const warnings = Array.isArray(payload.warnings) ? payload.warnings.slice(0, 3).filter(warning => typeof warning === 'string').map(warning => redactText(warning.slice(0, 160).replaceAll(token, '[已隐藏]'))) : [];
    $('connect-status').textContent = `已读取 ${facts.sample.orderCount} 笔近期已完成订单，餐品已入群。${warnings.length ? ` ${warnings.join(' ')}` : ''}`;
    announce('你的剧场已生成。检查台词后，就可以下载分享。');
  } catch (error) {
    $('connect-status').classList.add('error');
    const detail = String(error?.message ?? '');
    const message = /[\u4e00-\u9fff]/.test(detail) ? detail : '连接未成功，请确认本机服务仍在运行后重试。';
    $('connect-status').textContent = `${redactText(message.replaceAll(token, '[已隐藏]'))} 当前分享卡已保留。`;
    announce('读取失败，未生成新的订单故事。', true);
  } finally {
    collecting = false;
    $('token-input').value = '';
    $('token-input').disabled = false;
    $('collect-button').disabled = false;
    $('collect-button').replaceChildren(document.createTextNode('读取我的订单 '), element('span', '', '↗'));
  }
}
function openUpload() { $('file-input').click(); }
function showHelp() { $('help-dialog').showModal(); }

for (const scenario of demoScenarios) {
  const details = scenarioDetails[scenario.id] ?? ['other', '选一个场景试试'];
  const button = element('button', 'scenario-button');
  button.type = 'button';
  button.dataset.scenario = scenario.id;
  button.setAttribute('aria-pressed', 'false');
  button.append(foodAvatar(details[0], 'scenario-icon'), element('strong', '', scenario.label === '双人搭配' ? '固定搭档' : scenario.label), element('small', '', details[1]));
  button.addEventListener('click', () => { showDemo(scenario.id); announce('他们换了个群。'); });
  $('scenario-list').append(button);
}
for (const food of foods) {
  const button = element('button', 'food-option');
  button.type = 'button';
  button.append(foodAvatar(food.kind, 'food-avatar'), element('span', '', food.name));
  const update = () => { button.classList.toggle('selected', selectedFoods.has(food.name)); button.setAttribute('aria-pressed', String(selectedFoods.has(food.name))); };
  update();
  button.addEventListener('click', () => {
    if (selectedFoods.has(food.name)) selectedFoods.delete(food.name);
    else if (selectedFoods.size < 3) selectedFoods.add(food.name);
    else return announce('群头像最多坐 3 位。先取消一位，再邀请新朋友。', true);
    update();
    announce('');
  });
  $('food-list').append(button);
}
for (const button of document.querySelectorAll('[data-mode]')) button.addEventListener('click', () => {
  const next = button.dataset.mode;
  switchMode(next);
  if (next === 'demo') showDemo(activeScenario);
});
for (const button of document.querySelectorAll('[data-mode]')) button.addEventListener('keydown', event => {
  const buttons = [...document.querySelectorAll('[data-mode]')];
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const index = buttons.indexOf(button);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
  buttons[next].focus(); buttons[next].click();
});
$('self-generate').addEventListener('click', showSelf);
$('reroll').addEventListener('click', () => {
  if (importedKind === 'story') return;
  variant += 1;
  story = provenance === 'self' ? createSelfStory(activeSelfFoods, variant) : createStory(facts, variant);
  render();
  announce('下一句来了。');
});
$('download').addEventListener('click', downloadPng);
$('copy').addEventListener('click', copyCaption);
$('upload-button').addEventListener('click', openUpload);
$('file-input').addEventListener('change', event => importFile(event.target.files[0]));
$('import-help-button').addEventListener('click', showHelp);
$('close-dialog').addEventListener('click', () => $('help-dialog').close());
$('dialog-upload').addEventListener('click', () => { $('help-dialog').close(); openUpload(); });
$('help-dialog').addEventListener('click', event => { if (event.target === $('help-dialog')) { const rect = $('help-dialog').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('help-dialog').close(); } });
$('connect-form').addEventListener('submit', collectOrders);
if (!localService) {
  $('token-input').disabled = true; $('collect-button').disabled = true;
  $('connect-help').textContent = '真实订单请打开本机服务，启动方法见作品包中的使用说明。此单文件页面仍可自选体验、导入文件和下载图片。';
}
showDemo(activeScenario);
if (globalThis.__MCD_THEATER_INITIAL_STORY__) {
  try {
    const initial = globalThis.__MCD_THEATER_INITIAL_STORY__;
    applyImport(initial, '助手生成的故事');
    // Only a locally bundled demo may retain its declared demo label. File uploads never enter this branch.
    if (initial.source === 'demo') {
      provenance = 'demo'; embeddedDemo = true;
      story.sampleLabel = safeText(initial.sampleLabel ?? '虚构演示', '样本范围', 160);
      switchMode('demo'); render(); announce('内置虚构演示已加载。');
    }
  }
  catch (error) { announce(`附带故事未能载入：${error.message}`, true); }
} else if (new URLSearchParams(location.search).get('story') === '/story.json' && /^https?:$/.test(location.protocol)) {
  try {
    const response = await fetch('/story.json', { credentials: 'same-origin' });
    if (!response.ok) throw new Error('未找到故事文件');
    const data = await response.json();
    applyImport(data, '助手生成的故事');
  } catch (error) { announce(`故事未能载入：${error.message}。请用“我的订单”手动导入。`, true); }
}
if (new URLSearchParams(location.search).get('mode') === 'connect') {
  switchMode('connect');
  if (!$('token-input').disabled) $('token-input').focus();
}
