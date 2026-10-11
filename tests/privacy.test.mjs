import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeOrders, createStory, createSelfStory, redactText } from '../src/theater.mjs';

const privateSamples = [
  '13812345678',
  '+86 13812345678',
  '+86-138-1234-5678',
  'alice@example.com',
  'Bearer test-longtoken',
  'https://example.com/private?token=abc',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIiwiaWF0IjoxMjM0NTY3ODkwfQ.c2lnbmF0dXJlLXRlc3Q',
  'sk-proj-exampleSecret1234567890',
  'MCD_SECRET_TOKEN_123',
  'api_key=secret-key-12345678',
  'a91c30bfa47073a8d4ec1f673ad029ce',
];

test('recognizable phones, emails, credentials and URLs are redacted as complete spans', () => {
  for (const value of privateSamples) {
    assert.equal(redactText(value), '[已隐藏]', value);
    assert.equal(redactText(`餐品 ${value} 附注`), '餐品 [已隐藏] 附注', value);
  }
});

test('normal frequencies, product identifiers and menu numbers stay readable', () => {
  const normal = '板烧鸡腿堡｜4/5 笔｜productCode1547｜1024 程序员餐｜1+1 随心配｜5块麦乐鸡';
  assert.equal(redactText(normal), normal);
  assert.equal(redactText(1547), '1547');
  assert.equal(redactText(null), '');
});

test('sensitive strings embedded in imported food names never enter facts or stories', () => {
  for (const value of privateSamples) {
    const facts = analyzeOrders([{ id: 'opaque', items: [{ id: 'plate', name: `板烧 ${value}`, quantity: 1, kind: 'burger' }] }], { source: 'imported' });
    const story = createStory(facts);
    const serialized = JSON.stringify({ facts, story });
    assert.ok(!serialized.includes(value), value);
    assert.ok(serialized.includes('[已隐藏]'));
    assert.equal(story.source, 'imported');
  }
});

test('self selections and supplied story evidence use the same redaction function', () => {
  const self = createSelfStory(['板烧 13812345678 alice@example.com']);
  assert.ok(!JSON.stringify(self).includes('13812345678'));
  assert.ok(!JSON.stringify(self).includes('alice@example.com'));
  const facts = analyzeOrders([{ items: [{ id: 'plate', name: '板烧鸡腿堡', quantity: 1, kind: 'burger' }] }]);
  facts.signals[0].evidence.push('备注 Bearer test-longtoken 联系 alice@example.com');
  const story = createStory(facts);
  assert.ok(!JSON.stringify(story).includes('test-longtoken'));
  assert.ok(!JSON.stringify(story).includes('alice@example.com'));
});

test('repeat variant is a fictional rename scene with the same factual anchor', () => {
  const facts = analyzeOrders([
    ...Array.from({ length: 4 }, () => ({ items: [{ id: 'plate', name: '板烧鸡腿堡', kind: 'burger', quantity: 1 }] })),
    { items: [{ id: 'fish', name: '麦香鱼', kind: 'burger', quantity: 1 }] },
  ]);
  const renamed = createStory(facts, 0);
  const alternate = createStory(facts, 1);
  assert.equal(renamed.themeId, 'repeat');
  assert.deepEqual(renamed.evidence, alternate.evidence);
  assert.ok(renamed.messages.some(message => message.text.includes('4 笔')));
  assert.ok(!JSON.stringify(renamed).includes('想尝鲜'));
});
