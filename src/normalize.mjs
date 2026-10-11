import { createHash } from 'node:crypto';
import { McpError } from './mcp.mjs';

// Official public guide, sections 4.2.13 and 4.2.14, inspected 2026-10-11.
// The SPA bundles its documentation; no other contestant's schema is used.
export const OFFICIAL_SCHEMA_SOURCE = 'https://open.mcd.cn/mcp/doc';
export const OFFICIAL_SCHEMA_ASSET = 'https://open.mcd.cn/static/js/index.42407507.025ffc2e.chunk.js';
export const SCOPE = '仅近期已完成订单';
const KINDS = new Set(['burger', 'fries', 'drink', 'chicken', 'dessert', 'other']);
const COMBO = /套餐|件套|随心配|分享餐|组合餐|超值餐|家庭餐/i;
const object = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v));
const positive = (v) => Number.isSafeInteger(v) && v > 0 && v <= 1000;

export function safeFoodName(value) {
  if (typeof value !== 'string' || !value.trim()) throw new McpError('unsupported_response_schema', '餐品名称缺失；未推断餐品内容。');
  const name = value.normalize('NFKC').replace(/https?:\/\/\S+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\bBearer\s+\S+|\b(?:sk-|eyJ)[\w.-]+/gi, '[已隐藏]')
    .replace(/\d{7,}/g, '[已隐藏]').replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/_\d{1,6}$/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!name) throw new McpError('unsupported_response_schema', '去敏后的餐品名称为空，已停止适配。');
  return name;
}

export function classifyFood(name) {
  if (COMBO.test(name)) return 'other';
  if (/薯条|fries/i.test(name)) return 'fries';
  if (/汉堡|鸡腿堡|牛堡|吉士堡|麦香鱼|麦香鸡|巨无霸|麦满分|burger/i.test(name)) return 'burger';
  if (/麦旋风|新地|甜筒|冰淇淋|冰激凌|苹果派|香芋派|菠萝派|dessert|sundae/i.test(name)) return 'dessert';
  if (/麦乐鸡|鸡翅|鸡块|鸡排|炸鸡|chicken nugget/i.test(name)) return 'chicken';
  if (/可乐|雪碧|芬达|咖啡|豆浆|牛奶|奶茶|果汁|柠檬茶|美式|拿铁|饮料|cola|coffee/i.test(name)) return 'drink';
  return 'other';
}

function productId(name, kind) { return `food-${createHash('sha256').update(`${kind}:${name}`).digest('hex').slice(0, 12)}`; }

export function extractBusinessPayload(raw) {
  if (raw?.isError) throw new McpError('tool_error', '订单查询失败；上游错误正文已隐藏。');
  const candidates = [raw?.structuredContent, raw];
  for (const content of raw?.content ?? []) if (content?.type === 'text' && typeof content.text === 'string') {
    let text = content.text.trim();
    if (/^```(?:json)?\s*\n[\s\S]*\n```$/i.test(text)) text = text.replace(/^```(?:json)?\s*\n/i, '').replace(/\n```$/, '');
    try { candidates.push(JSON.parse(text)); } catch { /* No guessing or evaluating non-JSON content. */ }
  }
  const payload = candidates.find((v) => object(v) && Object.hasOwn(v, 'success') && Object.hasOwn(v, 'data'));
  if (!payload) throw new McpError('unsupported_response_schema', '订单响应与已确认的官方示例结构不符；请在本机校准适配后重试。');
  if (payload.success !== true || payload.code !== 200) throw new McpError('upstream_error', '官方订单查询未成功；上游响应正文已隐藏。');
  return payload;
}

export function officialOrderRecords(raw, tool = 'order-list') {
  const payload = extractBusinessPayload(raw);
  if (!object(payload.data)) throw new McpError('unsupported_response_schema', '官方订单 data 结构变化；已停止适配。');
  if (tool === 'order-list' && Array.isArray(payload.data.list)) return payload.data.list;
  if (tool === 'query-order' && Array.isArray(payload.data.orderProductList)) return [payload.data];
  throw new McpError('unsupported_response_schema', '官方订单列表或详情路径变化；已停止适配。');
}

export function isCompletedOfficialOrder(order) { return order?.orderStatus === '订单已完成'; }
export function isUnknownOfficialStatus(order) {
  return !['订单已完成', '订单已取消', '待支付'].includes(order?.orderStatus);
}

function flattenOfficial(nodes, tool, warnings, orderLabel, child = false, depth = 0) {
  if (depth > 8) throw new McpError('unsupported_response_schema', '套餐结构超过安全层数；已停止适配。');
  const result = [];
  for (const node of nodes) {
    if (!object(node)) throw new McpError('unsupported_response_schema', '餐品结构变化；已停止适配。');
    const nameField = child ? (tool === 'query-order' ? 'itemName' : 'name') : 'productName';
    const quantityField = child && tool === 'query-order' ? 'itemQuantity' : 'quantity';
    const name = safeFoodName(node[nameField]);
    const quantity = node[quantityField];
    if (!positive(quantity)) throw new McpError('unsupported_response_schema', '餐品数量不是已确认的正整数；已停止适配。');
    if (Object.hasOwn(node, 'comboItemList') && !Array.isArray(node.comboItemList)) throw new McpError('unsupported_response_schema', '套餐子项结构变化；已停止适配。');
    const children = node.comboItemList;
    if (children?.length && quantity === 1) {
      result.push(...flattenOfficial(children, tool, warnings, orderLabel, true, depth + 1));
    } else if (children?.length || COMBO.test(name)) {
      // Public examples only establish quantity=1 semantics for a combo.
      // Never invent whether child quantities are per set or already totalled.
      warnings.push(`${orderLabel}：套餐组成或多份套餐的子项计数未完全确认，保留套餐整体，不推断内部餐品。`);
      result.push({ name, quantity, kind: 'other' });
    } else result.push({ name, quantity, kind: classifyFood(name) });
  }
  return result;
}

function aggregateItems(items) {
  const groups = new Map();
  for (const item of items) {
    const id = productId(item.name, item.kind);
    const old = groups.get(id);
    if (old) {
      old.quantity += item.quantity;
      if (!Number.isSafeInteger(old.quantity) || old.quantity > 10000) throw new McpError('invalid_quantity', '合并后的餐品数量超出安全范围。');
    } else groups.set(id, { id, name: item.name, quantity: item.quantity, kind: item.kind });
  }
  return [...groups.values()];
}

export function normalizeMcdRecords(records, { tool = 'order-list', source = 'mcp' } = {}) {
  if (!Array.isArray(records)) throw new McpError('unsupported_response_schema', '订单记录必须为数组。');
  const orders = [], warnings = [];
  let excluded = 0, unknown = 0;
  for (const record of records.slice(0, 10)) {
    if (!object(record)) throw new McpError('unsupported_response_schema', '订单记录结构变化；已停止适配。');
    if (!isCompletedOfficialOrder(record)) { excluded++; if (isUnknownOfficialStatus(record)) unknown++; continue; }
    if (!Array.isArray(record.orderProductList)) throw new McpError('unsupported_response_schema', '已完成订单缺少官方餐品列表；已停止适配。');
    const label = `第 ${orders.length + 1} 笔已完成订单`;
    const items = aggregateItems(flattenOfficial(record.orderProductList, tool, warnings, label));
    if (!items.length) { warnings.push(`${label}没有可识别餐品，未计入。`); continue; }
    orders.push({ id: `order-${String(orders.length + 1).padStart(3, '0')}`, items });
  }
  if (excluded) warnings.push(`已排除 ${excluded} 笔取消、待支付或未确认完成的订单。`);
  if (unknown) warnings.push(`${unknown} 笔订单的完成状态未知；需订单详情核实或由用户确认，未默认为完成。`);
  if (records.length > 10) warnings.push('输入超过 10 笔，仅处理前 10 笔近期记录；不能据此生成全年统计。');
  if (!orders.length) warnings.push('没有可确认已完成且包含餐品的近期订单。');
  return { version: 1, source, orders, warnings: [...new Set(warnings)], scope: SCOPE };
}

export function normalizeMcdResponse(raw, options = {}) {
  return normalizeMcdRecords(officialOrderRecords(raw, options.tool ?? 'order-list'), options);
}

// Local import contract, distinct from the official response schema:
// {orders:[{status:'completed',items:[{name,quantity,kind?,children?}]}]}.
// Explicit confirmation applies only to missing/unknown status, never cancelled/pending.
export function normalizeImportedOrders(input, { confirmedCompleted = false } = {}) {
  const records = Array.isArray(input) ? input : input?.orders;
  if (!Array.isArray(records)) throw new McpError('invalid_import', '本机导入 JSON 需要 orders 数组。');
  const orders = [], warnings = [];
  let excluded = 0;
  function flatten(nodes, label, depth = 0) {
    if (depth > 8 || !Array.isArray(nodes)) throw new McpError('invalid_import', '本机餐品列表或套餐结构无效。');
    const leaves = [];
    for (const item of nodes) {
      const name = safeFoodName(item?.name), quantity = item?.quantity;
      if (!positive(quantity)) throw new McpError('invalid_import', '本机餐品 quantity 必须是正整数。');
      if (Object.hasOwn(item, 'children') && !Array.isArray(item.children)) throw new McpError('invalid_import', '本机套餐 children 必须为数组。');
      if (item.children?.length && quantity === 1) leaves.push(...flatten(item.children, label, depth + 1));
      else if (item.children?.length || COMBO.test(name)) {
        warnings.push(`${label}：套餐内容未完全确认，保留整体。`); leaves.push({ name, quantity, kind: 'other' });
      } else leaves.push({ name, quantity, kind: KINDS.has(item.kind) ? item.kind : classifyFood(name) });
    }
    return leaves;
  }
  for (const record of records.slice(0, 10)) {
    if (!object(record)) throw new McpError('invalid_import', '本机订单记录无效。');
    if (['cancelled', 'pending_payment', '订单已取消', '待支付'].includes(record.status)) { excluded++; continue; }
    if (!['completed', '订单已完成'].includes(record.status)) {
      if (!confirmedCompleted) { excluded++; warnings.push('本机订单存在未确认完成状态，已排除；可核实后使用 --confirm-completed。'); continue; }
      warnings.push('部分本机订单的完成状态由用户显式确认，未经 MCP 状态核验。');
    }
    const items = aggregateItems(flatten(record.items, `第 ${orders.length + 1} 笔订单`));
    if (items.length) orders.push({ id: `order-${String(orders.length + 1).padStart(3, '0')}`, items });
  }
  if (excluded) warnings.push(`本机导入排除 ${excluded} 笔订单。`);
  if (records.length > 10) warnings.push('本机导入仅处理前 10 笔记录，不能据此生成全年统计。');
  return { version: 1, source: 'import', orders, warnings: [...new Set(warnings)], scope: SCOPE };
}
