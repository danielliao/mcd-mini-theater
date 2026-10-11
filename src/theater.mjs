/** Deterministic, local storytelling from an already redacted order format. */
const KINDS = new Set(['burger', 'fries', 'drink', 'chicken', 'dessert', 'other']);
const SOURCES = new Set(['demo', 'mcp', 'imported', 'self']);
const MAX_ORDERS = 10;

function fail(code, message, Type = Error) {
  const error = new Type(message);
  error.code = code;
  throw error;
}

/** Mask recognizable private strings; does not reinterpret ordinary menu numbers. */
export function redactText(value) {
  const hidden = '[已隐藏]';
  return String(value ?? '')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]+/gi, hidden)
    .replace(/\bhttps?:\/\/[^\s<>"']+/gi, hidden)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, hidden)
    .replace(/(?<!\d)(?:\+?86[\s-]?)?1[3-9]\d(?:[\s-]?\d){8}(?!\d)/g, hidden)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, hidden)
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,}|MCD_(?:SECRET_)?TOKEN_[A-Za-z0-9_-]+)\b/gi, hidden)
    .replace(/\b(?:api[_-]?key|access[_-]?token|mcd[_-]?mcp[_-]?token|authorization|password|secret|token)\s*[:=]\s*["']?[A-Za-z0-9._~+\/=-]{8,}["']?/gi, hidden)
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, token => /[A-Za-z]/.test(token) && /\d/.test(token) ? hidden : token);
}

function cleanName(value) {
  if (typeof value !== 'string') return '';
  return redactText(value.normalize('NFC')).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function labelFor(source, count) {
  if (source === 'self') return '自选餐品体验｜未读取订单';
  if (source === 'demo') return `虚构演示｜${count} 笔虚构订单`;
  if (source === 'imported') return '导入订单｜来源由文件提供者声明';
  return `近期 ${count} 笔已完成订单｜最多 10 笔`;
}

function rankFoods(a, b) {
  return b.orderCount - a.orderCount || b.quantity - a.quantity || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

function appearance(food, count) {
  return `这 ${count} 笔订单中，「${food.name}」出现在 ${food.orderCount} 笔；同单多份只算一次出现。`;
}

/** Input order is newest first; completion status is checked by the caller. */
export function analyzeOrders(orders, { source = 'demo' } = {}) {
  if (!SOURCES.has(source) || source === 'self') fail('INVALID_SOURCE', '订单分析的来源只能是 demo、mcp 或 imported。', TypeError);
  if (!Array.isArray(orders)) fail('INVALID_ORDERS', '订单必须是数组。', TypeError);
  if (!orders.length) fail('NO_ORDERS', '没有可分析的订单。请连接真实订单或明确选择虚构演示。', RangeError);

  const selected = orders.slice(0, MAX_ORDERS);
  const totals = new Map();
  const appearances = [];
  let invalidItems = 0;

  for (const order of selected) {
    if (!order || !Array.isArray(order.items)) fail('INVALID_ORDERS', '每笔标准订单都必须包含 items 数组。', TypeError);
    const seen = new Set();
    for (const item of order.items) {
      const name = cleanName(item?.name);
      const quantity = item?.quantity;
      if (!name || !Number.isSafeInteger(quantity) || quantity <= 0) {
        invalidItems += 1;
        continue;
      }
      const kind = KINDS.has(item.kind) ? item.kind : 'other';
      // Source IDs are used internally for identity, never copied into results.
      const identity = typeof item.id === 'string' || typeof item.id === 'number'
        ? `id:${String(item.id)}` : `name:${kind}:${name}`;
      if (!totals.has(identity)) totals.set(identity, { name, kind, orderCount: 0, quantity: 0, identity });
      const food = totals.get(identity);
      food.quantity += quantity;
      if (!seen.has(identity)) food.orderCount += 1;
      seen.add(identity);
    }
    appearances.push(seen);
  }

  if (!totals.size) fail('NO_FOODS', '这些订单里没有有效餐品，无法生成小剧场。', RangeError);
  const ranked = [...totals.values()].sort(rankFoods);
  const foods = ranked.map((food, index) => ({
    id: `food-${index + 1}`, name: food.name, kind: food.kind,
    orderCount: food.orderCount, quantity: food.quantity,
  }));
  const identityById = new Map(foods.map((food, index) => [food.id, ranked[index].identity]));
  const count = selected.length;
  const signals = [];

  const drink = foods.find(food => food.kind === 'drink');
  const rival = foods.find(food => food.kind !== 'drink');
  if (drink && rival && drink.orderCount >= 2 && drink.orderCount > rival.orderCount) {
    signals.push({
      id: 'drink-leading', foodIds: [drink.id, rival.id],
      evidence: [appearance(drink, count), appearance(rival, count), '本样本中，这款饮料的出现笔数高于每一款非饮料餐品。'],
    });
  }

  const mains = foods.filter(food => food.kind === 'burger' || food.kind === 'chicken');
  const guestMains = mains.length >= 3 && mains.every(food => food.orderCount <= count / 2)
    ? mains.slice(0, 3) : [];
  const oneOffs = foods.filter(food => food.orderCount === 1);
  const guests = guestMains.length ? guestMains : count >= 2 && oneOffs.length >= 3 ? oneOffs.slice(0, 3) : [];
  if (guests.length) {
    signals.push({
      id: 'variety', foodIds: guests.map(food => food.id),
      evidence: guests.map(food => appearance(food, count)),
    });
  }

  // A duo is a pair of foods, never an inference about the number of diners.
  const anchor = foods[0];
  const partner = foods.slice(1).find(food => {
    if (anchor.orderCount < 2 || food.orderCount !== anchor.orderCount) return false;
    const a = identityById.get(anchor.id);
    const b = identityById.get(food.id);
    return appearances.filter(seen => seen.has(a) && seen.has(b)).length === anchor.orderCount;
  });
  if (partner) {
    signals.push({
      id: 'duo', foodIds: [anchor.id, partner.id],
      evidence: [`这 ${count} 笔订单中，「${anchor.name}」与「${partner.name}」在 ${anchor.orderCount} 笔中同单出现；本样本中没有单独出现。`],
    });
  }

  const regulars = foods.filter(food => food.orderCount >= 2 && food.orderCount / count >= 0.6).slice(0, 3);
  if (regulars.length) {
    signals.push({ id: 'repeat', foodIds: regulars.map(food => food.id), evidence: regulars.map(food => appearance(food, count)) });
  }
  if (!signals.length) {
    const cast = foods.slice(0, 3);
    signals.push({ id: 'snapshot', foodIds: cast.map(food => food.id), evidence: cast.map(food => appearance(food, count)) });
  }

  const warnings = [];
  if (orders.length > MAX_ORDERS) warnings.push('输入超过 10 笔，只分析按最新在前排列的前 10 笔。');
  if (invalidItems) warnings.push(`有 ${invalidItems} 项餐品因名称或数量格式无效而未计入，订单样本分母保持不变。`);

  return {
    version: 1, source, sample: { orderCount: count, scopeLabel: labelFor(source, count) },
    foods, signals, warnings,
  };
}

function variantIndex(variant) {
  const number = Number.isFinite(Number(variant)) ? Math.trunc(Number(variant)) : 0;
  return ((number % 3) + 3) % 3;
}

function makeMessages(cast, texts) {
  return texts.map(([index, text]) => ({ speakerId: cast[index]?.id ?? cast[0].id, text }));
}

export function createStory(facts, variant = 0) {
  if (!facts || facts.version !== 1 || !SOURCES.has(facts.source) || !Array.isArray(facts.foods) || !facts.foods.length || !Array.isArray(facts.signals) || !facts.signals.length) {
    fail('INVALID_FACTS', '缺少有效事实，无法生成小剧场。', TypeError);
  }
  if (facts.source !== 'self' && (!Number.isInteger(facts.sample?.orderCount) || facts.sample.orderCount < 1 || facts.sample.orderCount > MAX_ORDERS)) {
    fail('INVALID_FACTS', '订单样本数必须在 1 到 10 之间。', TypeError);
  }
  const signal = facts.signals[0];
  const rawCast = signal.foodIds?.slice(0, 3).map(id => facts.foods.find(food => food.id === id));
  if (!rawCast?.length || rawCast.some(food => !food)) fail('INVALID_FACTS', '故事中的餐品没有对应事实。', TypeError);
  const cast = rawCast.map(food => ({ ...food, id: redactText(food.id), name: cleanName(food.name), kind: KINDS.has(food.kind) ? food.kind : 'other' }));
  const [a, b, c] = cast;
  const n = facts.sample?.orderCount ?? 0;
  const v = variantIndex(variant);
  let title, groupName, systemMessage, options;

  switch (signal.id) {
    case 'drink-leading':
      title = '饮料说：我才是这桌的主角';
      groupName = '配角升职通知群';
      systemMessage = `系统已将「${a.name}」设为群主。`;
      options = [
        [[0, '先说清楚，我只是个随餐饮料。'], [1, `这 ${n} 笔你来了 ${a.orderCount} 笔，我只来了 ${b.orderCount} 笔。`], [0, '这个“随”字，是不是放反了？']],
        [[1, '谁来主持今天的群聊？'], [0, `我先点名。这 ${n} 笔里，我有 ${a.orderCount} 笔在场。`], [1, '明白了，我才是被顺便带上的。']],
        [[0, '大家一直把我当配角。'], [1, `你的出场记录是 ${a.orderCount}/${n}，我的只有 ${b.orderCount}/${n}。`], [0, '群头像要不要重新排一下？']],
      ];
      break;
    case 'variety':
      title = '餐品正在核对出场名单';
      groupName = '客串演员集合处';
      systemMessage = '系统已建立「客串演员集合处」。';
      options = [
        [[0, `这 ${n} 笔名单里，我占 ${a.orderCount} 笔。`], [1, `我也来了 ${b.orderCount} 笔。`], [2, '那先别把群名写成某一位的粉丝群。']],
        [[0, '今天谁坐群头像的中间？'], [1, '出场名单里也有我的名字。'], [2, '做拼图吧，别只裁一个人。']],
        [[0, '我以为这群只邀请了我。'], [1, `我是「${b.name}」，我也有出场记录。`], [2, '名单不长，演员挺丰富。']],
      ];
      break;
    case 'duo':
      title = '它们说：我们总是一起出场';
      groupName = '固定搭档工作群';
      systemMessage = '群名已修改为「固定搭档工作群」。';
      options = [
        [[0, '我发现，这份样本里每次我在，你也在。'], [1, `核对过了，我们一起出现在 ${a.orderCount} 笔里。`], [0, '怪不得群头像一直裁不下我们俩。']],
        [[0, '谁又把我们排在同一张出场表？'], [1, `这 ${n} 笔里，有 ${a.orderCount} 笔我们一起在。`], [0, '那群昵称给你留半个位置。']],
        [[1, '这份样本里，好像没有我的单人镜头。'], [0, '因为有你出场的订单里，也都有我。'], [1, '懂了，群头像用合照。']],
      ];
      break;
    case 'repeat': {
      title = '它们的群聊，有固定座位';
      groupName = '固定阵容群';
      systemMessage = '群名已修改为「固定阵容群」。';
      const other = b ? 1 : 0;
      options = [
        [[0, '群名怎么还叫“临时搭伙群”？'], [other, `这 ${n} 笔里你有 ${a.orderCount} 笔在，已经是固定阵容了。`], [0, '那我申请把“临时”两个字撤掉。']],
        [[0, '我在这份出场名单里，有点眼熟。'], [other, `眼熟？你都出现在 ${a.orderCount} 笔里了。`], [0, '那我把椅子搬进群头像吧。']],
        [[0, '谁把我的座位焊住了？'], [other, `你的 ${a.orderCount}/${n} 出场记录，自己提交的。`], [0, '不是置顶消息，是置顶演员。']],
      ];
      if (c) options = options.map(messages => [...messages.slice(0, 2), [2, `我也在这 ${n} 笔里出现了 ${c.orderCount} 笔。`], ...messages.slice(2)]);
      break;
    }
    case 'self': {
      title = '你选的餐品，刚刚开了个群';
      groupName = '自选演员试镜群';
      systemMessage = '这是自选餐品体验，未读取历史订单。';
      options = cast.length === 1 ? [
        [[0, '这个群头像，我想拍成特写。'], [0, '左边是我，右边还是我。'], [0, '好了，单人海报也是海报。']],
        [[0, '群名先空着，我先选头像。'], [0, '这张用正脸，下一张用侧脸。'], [0, '一个演员，也能忙得很。']],
        [[0, '今天我负责开场。'], [0, '也负责接自己的话。'], [0, '这个群先拍一张单人照。']],
      ] : cast.length === 2 ? [
        [[0, '先说好，群头像留我半张脸。'], [1, '我已经伸进去了，不好意思。'], [0, '好，封面摄影师省事了。']],
        [[0, '我已经把名字写进群公告。'], [1, '公告先放放，我还没选好头像。'], [0, '群聊才开门，我们已经开会了。']],
        [[0, '谁把群头像裁得这么近？'], [1, '先别裁，我得露个角。'], [0, '我们这是群聊，还是合照摄影棚？']],
      ] : [
        [[0, '先说好，群头像留我半张脸。'], [1, '我已经伸进去了，不好意思。'], [2, '谁把群聊变成全家福了？']],
        [[0, '我已经把名字写进群公告。'], [1, '公告先放放，我还没选好头像。'], [2, '群聊才开门，你俩已经开会了。']],
        [[0, '谁把群头像裁得这么近？'], [1, '先别裁，我得露个角。'], [2, '我们这是群聊，还是合照摄影棚？']],
      ];
      break;
    }
    case 'snapshot': {
      title = '餐品正在确认这份出场名单';
      groupName = '样本出场名单群';
      systemMessage = '样本有限，只讲这份名单里能核对的事实。';
      const other = b ? 1 : 0;
      options = [
        [[0, `这 ${n} 笔样本中，有 ${a.orderCount} 笔点了我。`], [other, '先核对名单，再演戏。'], [0, '这就是我们的开场白。']],
        [[0, '演员名单拿到了。'], [other, '每个名字都能在这份样本里找到。'], [0, '群头像可以开拍了。']],
        [[0, '群里谁负责讲事实？'], [other, '下方证据卡负责。'], [0, '那我们负责群聊气氛。']],
      ];
      break;
    }
    default:
      fail('INVALID_FACTS', '不支持这个事实锚点。', TypeError);
  }

  const disclaimer = facts.source === 'demo'
    ? '这是虚构演示，未读取真实订单。食品拟人台词为创作，不代表实际聊天。'
    : facts.source === 'self'
      ? '餐品由你自选；未读取订单，也未推断购买次数。食品拟人台词为虚构创作。'
      : facts.source === 'imported'
        ? '统计仅依据导入文件，来源由提供者声明，未独立核验为 MCP 取数。食品拟人台词为虚构创作。'
        : '食品拟人台词为虚构创作；事实依据仅限标注的近期样本，不代表全年习惯或个人特征。';
  return {
    version: 1, source: facts.source, themeId: signal.id, title, groupName,
    members: cast.map(food => ({ id: food.id, name: food.name, kind: food.kind })),
    messages: makeMessages(cast, options[v]).map(message => ({ ...message, text: redactText(message.text) })), systemMessage: redactText(systemMessage),
    evidence: signal.evidence.map(redactText), caption: '我的餐品，背着我开了个群。你的会聊什么？',
    sampleLabel: labelFor(facts.source, n), disclaimer,
  };
}

export function createSelfStory(names, variant = 0) {
  if (!Array.isArray(names)) fail('INVALID_SELF_FOODS', '请提供自选餐品名称数组。', TypeError);
  const selected = [];
  const seen = new Set();
  for (const input of names) {
    const name = cleanName(typeof input === 'string' ? input : input?.name);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    selected.push({ id: `food-${selected.length + 1}`, name, kind: KINDS.has(input?.kind) ? input.kind : 'other', orderCount: 0, quantity: 0 });
    if (selected.length === 3) break;
  }
  if (!selected.length) fail('NO_SELF_FOODS', '至少选择一款餐品，才能生成自选体验。', RangeError);
  return createStory({
    version: 1, source: 'self', sample: { orderCount: 0, scopeLabel: labelFor('self', 0) },
    foods: selected, warnings: [], signals: [{
      id: 'self', foodIds: selected.map(food => food.id),
      evidence: [`本次自选的餐品是${selected.map(food => `「${food.name}」`).join('、')}；未读取历史订单。`],
    }],
  }, variant);
}

const item = (id, name, kind, quantity = 1) => ({ id, name, kind, quantity });
const order = (id, items) => ({ id, items });
const plate = () => item('plate', '板烧鸡腿堡', 'burger');
const fries = () => item('fries', '中薯条', 'fries');
const cola = () => item('cola', '无糖可乐', 'drink');
const coffee = () => item('coffee', '美式咖啡', 'drink');
const bigMac = () => item('bigmac', '巨无霸', 'burger');

export const demoScenarios = [
  {
    id: 'repeat', label: '固定阵容', orders: [
      order('demo-r1', [plate(), fries(), cola()]),
      order('demo-r2', [plate(), fries(), cola()]),
      order('demo-r3', [plate(), fries()]),
      order('demo-r4', [plate(), cola()]),
      order('demo-r5', [plate(), fries()]),
    ],
  },
  {
    id: 'drink-leading', label: '饮料 C 位', orders: [
      order('demo-d1', [coffee(), bigMac()]),
      order('demo-d2', [coffee()]),
      order('demo-d3', [coffee(), fries()]),
      order('demo-d4', [coffee()]),
      order('demo-d5', [coffee(), bigMac()]),
      order('demo-d6', [coffee()]),
    ],
  },
  {
    id: 'variety', label: '客串大会', orders: [
      order('demo-v1', [plate(), fries()]),
      order('demo-v2', [bigMac()]),
      order('demo-v3', [item('fish', '麦香鱼', 'burger'), fries()]),
      order('demo-v4', [item('chicken-burger', '麦辣鸡腿汉堡', 'burger')]),
    ],
  },
  {
    id: 'duo', label: '双人搭配', orders: [
      order('demo-p1', [plate(), fries()]),
      order('demo-p2', [plate(), fries(), cola()]),
      order('demo-p3', [plate(), fries()]),
      order('demo-p4', [item('ice-cream', '香草甜筒', 'dessert')]),
    ],
  },
];

export const demoOrders = demoScenarios[0].orders;
