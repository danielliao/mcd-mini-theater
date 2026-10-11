import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMcdResponse, normalizeImportedOrders } from '../src/normalize.mjs';
import { collectOrders } from '../scripts/collect.mjs';
import { McpError } from '../src/mcp.mjs';

// Synthetic data modelled on the official public guide, never a live response.
const payload = (list) => ({ success: true, code: 200, data: { list } });
const row = (status = '订单已完成', products = [{ productName: '巨无霸', quantity: 1 }]) => ({ orderId: 'private-order-id', orderStatus: status, orderProductList: products });

test('only explicit official completed state counts; cancelled, unpaid, numeric and unknown do not', () => {
  const result = normalizeMcdResponse(payload([row(), row('订单已取消'), row('待支付'), row(30), row('制作中')]));
  const missing = row(); delete missing.orderStatus;
  assert.equal(normalizeMcdResponse(payload([missing])).orders.length, 0);
  assert.equal(result.orders.length, 1);
  assert.match(result.warnings.join(' '), /状态未知/);
});

test('combo parent is not counted alongside leaves; duplicate food rows aggregate quantities', () => {
  const products = [
    { productName: '巨无霸三件套', quantity: 1, comboItemList: [
      { productCode: 'burger', name: '巨无霸', quantity: 1 },
      { productCode: 'fries', name: '中薯条', quantity: 1 },
      { productCode: 'drink', name: '无糖可口可乐中杯', quantity: 1 },
    ] },
    { productCode: 'fries', productName: '中薯条', quantity: 1 },
  ];
  const { orders } = normalizeMcdResponse(payload([row('订单已完成', products)]));
  assert.equal(orders[0].items.length, 3);
  assert.equal(orders[0].items.find((v) => v.kind === 'fries').quantity, 2);
  assert.equal(orders[0].items.some((v) => v.name === '巨无霸三件套'), false);
});

test('a combo name does not imply its contents; ambiguous multi-set quantities stay opaque', () => {
  const { orders, warnings } = normalizeMcdResponse(payload([row('订单已完成', [
    { productName: '分享套餐', quantity: 1 },
    { productName: '双人套餐', quantity: 2, comboItemList: [{ name: '中薯条', quantity: 1 }] },
  ])]));
  assert.ok(orders[0].items.every((v) => v.kind === 'other'));
  assert.equal(orders[0].items.some((v) => v.name === '中薯条'), false);
  assert.match(warnings.join(' '), /不推断/);
});

test('official detail schema uses itemName/itemQuantity, not list child field guesses', () => {
  const raw = { success: true, code: 200, data: row('订单已完成', [{ productName: '套餐', quantity: 1, comboItemList: [{ itemName: '中薯条', itemQuantity: 1 }] }]) };
  const result = normalizeMcdResponse({ structuredContent: raw }, { tool: 'query-order' });
  assert.equal(result.orders[0].items[0].name, '中薯条');
  assert.equal(result.orders[0].items[0].kind, 'fries');
});

test('whitelist output strips all order/person/payment fields; item IDs are derived independently', () => {
  const original = { ...row(), address: 'private home', phone: '13812345678', storeName: 'private store', realTotalAmount: '123', traceId: 'private-trace', token: 'private-token', remark: 'private-note', createTime: 'exact-time' };
  original.orderProductList[0].couponCode = 'private-coupon';
  const result = normalizeMcdResponse({ content: [{ type: 'text', text: JSON.stringify(payload([original])) }] });
  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /private-|13812345678|exact-time|realTotalAmount|couponCode|storeName|createTime/);
  assert.deepEqual(Object.keys(result.orders[0]), ['id', 'items']);
  assert.deepEqual(Object.keys(result.orders[0].items[0]), ['id', 'name', 'quantity', 'kind']);
});

test('unsupported response paths, statuses and quantities fail closed or exclude', () => {
  assert.throws(() => normalizeMcdResponse({ success: true, code: 200, data: { orders: [] } }), { code: 'unsupported_response_schema' });
  assert.throws(() => normalizeMcdResponse(payload([row('订单已完成', [{ productName: '巨无霸', quantity: '1' }])])), { code: 'unsupported_response_schema' });
  assert.equal(normalizeMcdResponse(payload([row('已完成')])).orders.length, 0);
  assert.throws(() => normalizeMcdResponse({ success: false, code: 500, data: { phone: '13812345678' } }), { code: 'upstream_error' });
});

test('local import confirmation never overrides cancellation or unpaid status', () => {
  const input = { orders: [{ items: [{ name: '巨无霸', quantity: 1 }] }, { status: 'cancelled', items: [{ name: '中薯条', quantity: 1 }] }, { status: 'pending_payment', items: [{ name: '可乐', quantity: 1 }] }] };
  assert.equal(normalizeImportedOrders(input).orders.length, 0);
  const result = normalizeImportedOrders(input, { confirmedCompleted: true });
  assert.equal(result.orders.length, 1);
  assert.equal(result.source, 'import');
  assert.match(result.warnings.join(' '), /用户显式确认/);
});

test('collect uses detail only for unknown state and never persists or returns raw data', async () => {
  const calls = [];
  const client = { async callTool(name, args) {
    calls.push({ name, args });
    if (name === 'order-list') return { structuredContent: payload([row('制作中'), row('订单已取消')]) };
    return { structuredContent: { success: true, code: 200, data: row() } };
  } };
  const result = await collectOrders({ client });
  assert.deepEqual(calls.map((v) => v.name), ['order-list', 'query-order']);
  assert.equal(result.orders.length, 1);
  assert.equal(result.source, 'mcp');
  assert.doesNotMatch(JSON.stringify(result), /private-order-id/);
});

test('collect summarizes all excluded records, instead of repeating a misleading single-record count', async () => {
  const client = { async callTool() { return { structuredContent: payload([row('订单已取消'), row('待支付'), row('制作中')]) }; } };
  const result = await collectOrders({ client, detail: false });
  assert.equal(result.orders.length, 0);
  assert.match(result.warnings.join(' '), /已排除 3 笔/);
  assert.match(result.warnings.join(' '), /1 笔订单的完成状态未知/);
});

test('optional detail failures retain completed orders and never treat numeric status as completed', async (t) => {
  for (const code of ['tool_error', 'tool_unavailable', 'timeout', 'rpc_error', 'network_error', 'rate_limited', 'unsupported_response_schema']) {
    await t.test(code, async () => {
      const calls = [];
      const client = { async callTool(name) {
        calls.push(name);
        if (name === 'order-list') return { structuredContent: payload([row(), row(30)]) };
        // This sentinel intentionally contains private-looking upstream text;
        // collector warnings must be fixed text, even for injected clients.
        throw new McpError(code, 'private-upstream 13812345678 private-order-id');
      } };
      const result = await collectOrders({ client });
      assert.deepEqual(calls, ['order-list', 'query-order']);
      assert.equal(result.orders.length, 1);
      assert.equal(result.orders[0].items[0].name, '巨无霸');
      assert.match(result.warnings.join(' '), /详情补查未成功/);
      assert.match(result.warnings.join(' '), /已排除 1 笔/);
      assert.match(result.warnings.join(' '), /1 笔订单的完成状态未知/);
      assert.doesNotMatch(JSON.stringify(result), /private-|13812345678/);
    });
  }
});

test('authentication failure during detail and primary list failure remain fatal', async () => {
  const detailAuthClient = { async callTool(name) {
    if (name === 'order-list') return { structuredContent: payload([row(), row('配送中')]) };
    throw new McpError('authentication_failed', '麦当劳凭证无效或已失效，请重新获取凭证。');
  } };
  await assert.rejects(collectOrders({ client: detailAuthClient }), { code: 'authentication_failed' });
  const primaryClient = { async callTool() { throw new McpError('timeout', '麦当劳请求超时，请稍后重试。'); } };
  await assert.rejects(collectOrders({ client: primaryClient }), { code: 'timeout' });
});
