import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeOrders, createStory, createSelfStory, demoOrders, demoScenarios } from '../src/theater.mjs';

test('same food repeated within an order counts as one appearance, with quantities summed', () => {
  const facts = analyzeOrders([
    { id: 'opaque-a', items: [{ id: 'b', name: '板烧鸡腿堡', kind: 'burger', quantity: 2 }, { id: 'b', name: '板烧鸡腿堡', kind: 'burger', quantity: 1 }] },
    { id: 'opaque-b', items: [{ id: 'b', name: '板烧鸡腿堡', kind: 'burger', quantity: 1 }] },
  ]);
  assert.equal(facts.sample.orderCount, 2);
  assert.equal(facts.foods[0].orderCount, 2);
  assert.equal(facts.foods[0].quantity, 4);
  assert.ok(facts.signals[0].evidence[0].includes('2 笔'));
});

test('zero orders and zero usable foods fail clearly instead of falling back to demonstration', () => {
  assert.throws(() => analyzeOrders([], { source: 'mcp' }), { code: 'NO_ORDERS' });
  assert.throws(() => analyzeOrders([{ items: [] }], { source: 'mcp' }), { code: 'NO_FOODS' });
  assert.throws(() => createSelfStory([]), { code: 'NO_SELF_FOODS' });
});

test('analysis uses only the latest ten input orders and the actual denominator', () => {
  const orders = Array.from({ length: 12 }, (_, i) => ({ id: `o-${i}`, items: [{ id: i < 10 ? 'latest' : 'older', name: i < 10 ? '中薯条' : '巨无霸', kind: i < 10 ? 'fries' : 'burger', quantity: 1 }] }));
  const facts = analyzeOrders(orders, { source: 'mcp' });
  assert.equal(facts.sample.orderCount, 10);
  assert.equal(facts.foods.length, 1);
  assert.equal(facts.foods[0].orderCount, 10);
  assert.equal(facts.foods[0].name, '中薯条');
  assert.equal(facts.warnings.length, 1);
});

test('four different sample facts choose four genuinely different themes', () => {
  const stories = demoScenarios.map(scenario => createStory(analyzeOrders(scenario.orders)));
  assert.deepEqual(stories.map(story => story.themeId), ['repeat', 'drink-leading', 'variety', 'duo']);
  assert.equal(new Set(stories.map(story => story.groupName)).size, 4);
  for (const story of stories) {
    assert.ok(story.messages.length >= 3 && story.messages.length <= 5);
    assert.ok(story.members.length >= 1 && story.members.length <= 3);
    assert.ok(story.messages.every(message => story.members.some(member => member.id === message.speakerId)));
  }
});

test('variants change dialogue while keeping the evidence, source, theme and cast stable', () => {
  for (const scenario of demoScenarios) {
    const facts = analyzeOrders(scenario.orders);
    const before = JSON.stringify(facts);
    const original = createStory(facts, 0);
    const variation = createStory(facts, 1);
    assert.notDeepEqual(original.messages, variation.messages);
    for (const key of ['themeId', 'source', 'evidence', 'sampleLabel', 'members']) assert.deepEqual(original[key], variation[key]);
    assert.equal(JSON.stringify(facts), before);
  }
});

test('a paired cast requires observed co-occurrence, not merely equal counts or two portions', () => {
  const facts = analyzeOrders([
    { items: [{ id: 'a', name: '巨无霸', kind: 'burger', quantity: 2 }] },
    { items: [{ id: 'b', name: '中薯条', kind: 'fries', quantity: 1 }] },
    { items: [{ id: 'a', name: '巨无霸', kind: 'burger', quantity: 1 }] },
    { items: [{ id: 'b', name: '中薯条', kind: 'fries', quantity: 1 }] },
  ]);
  assert.ok(!facts.signals.some(signal => signal.id === 'duo'));
});

test('source labels distinguish demonstration, current orders and self selection', () => {
  const demo = createStory(analyzeOrders(demoOrders));
  const real = createStory(analyzeOrders(demoOrders, { source: 'mcp' }));
  const self = createSelfStory(['板烧鸡腿堡', '中薯条']);
  assert.equal(demo.source, 'demo');
  assert.ok(demo.sampleLabel.includes('虚构演示'));
  assert.equal(real.source, 'mcp');
  assert.ok(real.sampleLabel.includes('近期 5 笔'));
  assert.ok(!real.sampleLabel.includes('虚构'));
  assert.equal(self.source, 'self');
  assert.equal(self.sampleLabel, '自选餐品体验｜未读取订单');
  assert.ok(self.evidence[0].includes('自选'));
  assert.ok(!self.evidence.some(line => /\d+.*笔/.test(line)));
  assert.throws(() => analyzeOrders(demoOrders, { source: 'made-up' }), { code: 'INVALID_SOURCE' });
});

test('imported files keep declared provenance even if individual records claim MCP', () => {
  const declared = demoOrders.map(order => ({ ...order, source: 'mcp', verified: true }));
  const facts = analyzeOrders(declared, { source: 'imported' });
  const story = createStory(facts);
  assert.equal(facts.source, 'imported');
  assert.equal(story.source, 'imported');
  assert.equal(story.sampleLabel, '导入订单｜来源由文件提供者声明');
  assert.ok(story.disclaimer.includes('未独立核验'));
  assert.deepEqual(facts.foods, analyzeOrders(demoOrders).foods);
});

test('private fields and original identifiers never flow into facts or stories', () => {
  const privateValues = ['13812345678', '某小区3号楼', 'MCD_SECRET_TOKEN_123', 'secret-order-id', 'secret-product-id'];
  const orders = [{
    id: privateValues[3], phone: privateValues[0], address: privateValues[1], token: privateValues[2], price: 29,
    store: { name: '私密门店名称' },
    items: [{ id: privateValues[4], name: '板烧鸡腿堡', kind: 'burger', quantity: 1, contactName: '私密姓名' }],
  }];
  const facts = analyzeOrders(orders, { source: 'mcp' });
  const serialized = JSON.stringify({ facts, story: createStory(facts) });
  for (const value of [...privateValues, '私密门店名称', '私密姓名']) assert.ok(!serialized.includes(value));
  assert.ok(!serialized.includes('"price"'));
});

test('one food and a small sample produce a supported scene without invented repetition', () => {
  const story = createStory(analyzeOrders([{ items: [{ id: 'a', name: '麦香鱼', kind: 'burger', quantity: 1 }] }], { source: 'mcp' }));
  assert.equal(story.themeId, 'snapshot');
  assert.equal(story.members.length, 1);
  assert.equal(story.messages.length, 3);
  assert.ok(story.messages.every(message => message.speakerId === story.members[0].id));
});

test('invalid quantities are excluded without pretending the order disappeared', () => {
  const facts = analyzeOrders([
    { items: [{ id: 'a', name: '中薯条', kind: 'fries', quantity: 1 }] },
    { items: [{ id: 'a', name: '中薯条', kind: 'fries', quantity: -1 }] },
  ]);
  assert.equal(facts.sample.orderCount, 2);
  assert.equal(facts.foods[0].orderCount, 1);
  assert.equal(facts.foods[0].quantity, 1);
  assert.equal(facts.warnings.length, 1);
});

test('self selected foods deduplicate and keep a maximum three-person cast without frequency claims', () => {
  const story = createSelfStory(['中薯条', '中薯条', '板烧鸡腿堡', '无糖可乐', '香草甜筒'], 2);
  assert.equal(story.members.length, 3);
  assert.deepEqual(story.members.map(member => member.name), ['中薯条', '板烧鸡腿堡', '无糖可乐']);
  assert.ok(!JSON.stringify(story).includes('香草甜筒'));
  assert.ok(!story.messages.some(message => /\d+.*笔/.test(message.text)));
});

test('single self-selected food stays a solo scene in every variant', () => {
  for (let variant = 0; variant < 3; variant += 1) {
    const story = createSelfStory(['中薯条'], variant);
    assert.equal(story.members.length, 1);
    assert.ok(story.messages.every(message => message.speakerId === story.members[0].id));
    assert.ok(!story.messages.some(message => /你俩|我们|大家|你也|我也/.test(message.text)));
    assert.equal(story.sampleLabel, '自选餐品体验｜未读取订单');
  }
});
