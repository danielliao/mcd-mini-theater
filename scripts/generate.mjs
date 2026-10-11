#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { analyzeOrders, createStory, demoScenarios } from '../src/theater.mjs';
import { buildStandalone } from './bundle.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
if (args.includes('--help')) {
  console.log('用法：\n  node scripts/generate.mjs --demo [--scenario 场景id] [--variant 1] --output generated\n  node scripts/generate.mjs --input 脱敏订单.json [--source imported|mcp] --output generated\n默认文件来源标为“导入订单”；--source mcp 仅供刚通过官方 MCP 实际取数的客户端使用。');
  process.exit(0);
}
try {
  const input = opt('--input');
  if (!!input === args.includes('--demo')) throw new Error('请选择 --demo 或 --input 其中一种。');
  const variant = Number(opt('--variant', 0));
  if (!Number.isInteger(variant) || variant < 0) throw new Error('variant 必须是非负整数。');
  let orders;
  let source;
  if (input) {
    const bytes = await readFile(resolve(input));
    if (bytes.length > 1024 * 1024) throw new Error('订单文件不能超过 1 MiB。');
    const data = JSON.parse(bytes.toString('utf8'));
    orders = Array.isArray(data) ? data : data.orders;
    if (!Array.isArray(orders)) throw new Error('输入需要已脱敏的标准 orders 数组，不接受官方原始响应。');
    source = opt('--source', 'imported');
    if (!['imported', 'mcp'].includes(source)) throw new Error('文件来源只能是 imported 或 mcp。');
  } else {
    const id = opt('--scenario', demoScenarios[0].id);
    const scenario = demoScenarios.find(s => s.id === id);
    if (!scenario) throw new Error(`可用场景：${demoScenarios.map(s => s.id).join('、')}`);
    orders = scenario.orders;
    source = 'demo';
  }
  const facts = analyzeOrders(orders, { source });
  const story = createStory(facts, variant);
  const output = resolve(opt('--output', 'generated'));
  await mkdir(output, { recursive: true });
  await writeFile(resolve(output, 'facts.json'), JSON.stringify(facts, null, 2));
  await writeFile(resolve(output, 'story.json'), JSON.stringify(story, null, 2));
  await writeFile(resolve(output, 'index.html'), await buildStandalone(story));
  console.log(`已生成 ${facts.sample.orderCount} 笔订单的小剧场：${output}/index.html\n数据来源：${source === 'demo' ? '虚构演示' : source === 'mcp' ? 'MCP（由调用客户端声明实际取数）' : '导入订单（来源由提供者声明）'}。`);
} catch (err) {
  // Only locally authored validation messages are emitted; no raw order or credential data.
  const safe = err.code === 'ENOENT' ? '输入文件或页面组件不存在。' : err instanceof SyntaxError ? '输入文件不是有效 JSON。' : String(err.message).slice(0, 200);
  console.error(`生成未完成：${safe}`);
  process.exitCode = 1;
}
