// 学习板块（study.js 和 state.js 里的学习操作）：校验、清洗、批注、编号、增删改和撤销、固定格式。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/state.js';
import { validateJournal, normalizeJournal, serialize, isoNow } from '../src/model.js';
import {
  validateStudy, sanitizeMark, sanitizeCardPatch, renumberPins, cleanName, isImgPath, studyFiles, findItem, SHORT_MAX,
  renumberAll, cardPages, pagesPatch, cardFiles, MAX_PAGES,
} from '../src/study.js';

const NOW = () => new Date(2026, 9, 14, 10, 0, 0);

function journal(study) {
  const j = {
    schemaVersion: 1, currency: '$',
    rows: [
      { type: 'system', id: 'sys_a', name: '系统', desc: '', createdAt: '2026-10-01T00:00:00Z' },
      { type: 'trade', id: 't_1', date: '2026-10-01', symbol: 'XAUUSD', direction: 'long', rr: 2, risk: 100, result: 'win', pnlOverride: null, reason: '', note: '',
        shots: [{ id: 'sh_1', label: 'open', file: 'shots/t_1/sh_1.webp', thumb: 'shots/t_1/sh_1.thumb.webp' }] },
    ],
  };
  if (study !== undefined) j.study = study;
  return j;
}

function setup(study) {
  const store = createStore(journal(study), { now: NOW });
  const events = [];
  store.subscribe((ev) => events.push(ev));
  return { store, events, a: store.actions, st: () => store.get().journal.study };
}

test('validateStudy：没有 study 不算错；结构不对逐条报出来', () => {
  assert.deepEqual(validateStudy(undefined), []);
  assert.deepEqual(validateStudy({ topics: [], cards: [] }), []);
  assert.equal(validateStudy([]).length, 1);
  const errs = validateStudy({
    topics: [{ id: 'x', name: 1, items: [{ id: 'kp_1', name: '', note: 3 }] }, { id: 'tp_2', name: '', items: 'no' }],
    cards: [{ id: 'c_1', item: '', title: '', kind: 'meh', symbol: '', tf: '', source: '', trade: 5, take: '', img: { file: '../x' }, marks: [1], notes: [{ n: 'a' }] }],
  });
  const text = errs.map((e) => e.message).join('\n');
  for (const part of ['tp_ 开头', '名字必须是字符串', '要点必须是字符串', 'items（知识点）必须是数组', 'kind', 'trade', '图片路径', '批注', '编号说明']) {
    assert.ok(text.includes(part), '应该提到：' + part);
  }
  assert.ok(errs.every((e) => e.field === 'study' && e.message.startsWith('学习板块：')));
});

test('validateStudy：id 重复要报；不认识的字段不算错', () => {
  const errs = validateStudy({ topics: [{ id: 'tp_1', name: '', items: [], future: 1 }, { id: 'tp_1', name: '', items: [] }], cards: [], extra: true });
  assert.equal(errs.length, 1);
  assert.match(errs[0].message, /重复/);
});

test('isImgPath：只认 shots/<id>/<文件名>', () => {
  assert.ok(isImgPath('shots/c_1/im_1.webp'));
  assert.ok(isImgPath('shots/t_1/sh_1.thumb.webp'));
  for (const p of ['shots/../x.webp', 'shots/c_1/../../a', 'study/c_1/a.webp', 'shots/c_1/a/b.webp', 'shots/c_1/..', '', null]) assert.equal(isImgPath(p), false, String(p));
});

test('cleanName：去首尾空白、并空白、去掉存不进去的字符、最多 SHORT_MAX 个字', () => {
  assert.equal(cleanName('  价格  行为 \n'), '价格 行为');
  assert.equal(cleanName('a\u0000b'), 'ab');
  assert.equal(cleanName('字'.repeat(SHORT_MAX + 3)), '字'.repeat(SHORT_MAX));
  assert.equal(cleanName(null), '');
});

test('sanitizeMark：坐标拉回画布、负宽高的框翻正、颜色不认识换成红色、坏的丢掉', () => {
  assert.deepEqual(sanitizeMark({ t: 'rect', x: 900, y: 500, w: -100, h: -50, c: 'blue' }), { t: 'rect', x: 800, y: 450, w: 100, h: 50, c: 'blue' });
  assert.deepEqual(sanitizeMark({ t: 'rect', x: 950, y: 0, w: 200, h: 10, c: 'x' }), { t: 'rect', x: 950, y: 0, w: 50, h: 10, c: 'red' });
  assert.equal(sanitizeMark({ t: 'rect', x: 1, y: 1, w: 0, h: 5 }), null);
  assert.deepEqual(sanitizeMark({ t: 'arrow', x1: -5, y1: 10.04, x2: 2000, y2: 600, c: 'green' }), { t: 'arrow', x1: 0, y1: 10, x2: 1000, y2: 562, c: 'green' });
  assert.deepEqual(sanitizeMark({ t: 'hline', y: 100, c: 'amber', label: ' 颈线 ' }), { t: 'hline', y: 100, c: 'amber', label: ' 颈线 ' });
  assert.deepEqual(sanitizeMark({ t: 'pin', n: 2, x: 1, y: 2 }), { t: 'pin', n: 2, x: 1, y: 2, c: 'red' });
  for (const bad of [null, { t: 'pin', n: 0, x: 1, y: 1 }, { t: 'circle' }, { t: 'arrow', x1: NaN, y1: 0, x2: 0, y2: 0 }]) assert.equal(sanitizeMark(bad), null);
});

test('sanitizeMark：大小 s 拉回 0.5–2.5、一位小数、等于 1 不写；dash 只给框、箭头、水平线留', () => {
  assert.deepEqual(sanitizeMark({ t: 'pin', n: 1, x: 1, y: 2, c: 'red', s: 1.84, dash: true }), { t: 'pin', n: 1, x: 1, y: 2, c: 'red', s: 1.8 });
  assert.equal(sanitizeMark({ t: 'pin', n: 1, x: 1, y: 2, s: 9 }).s, 2.5);
  assert.equal('s' in sanitizeMark({ t: 'pin', n: 1, x: 1, y: 2, s: 1 }), false);
  assert.equal('s' in sanitizeMark({ t: 'pin', n: 1, x: 1, y: 2, s: '2' }), false);
  assert.deepEqual(sanitizeMark({ t: 'hline', y: 5, c: 'blue', label: 'a', dash: false, s: 0.1 }), { t: 'hline', y: 5, c: 'blue', label: 'a', s: 0.5, dash: false });
  assert.equal('dash' in sanitizeMark({ t: 'arrow', x1: 0, y1: 0, x2: 5, y2: 5, dash: 'yes' }), false);
});

test('renumberPins：编号按出现顺序从 1 起，说明跟着走；多余的说明去掉、缺的补空', () => {
  const marks = [{ t: 'pin', n: 3, x: 0, y: 0 }, { t: 'rect' }, { t: 'pin', n: 1, x: 0, y: 0 }, { t: 'pin', n: 7, x: 0, y: 0 }];
  const notes = [{ n: 1, text: '一' }, { n: 3, text: '三' }, { n: 9, text: '九' }];
  const out = renumberPins(marks, notes);
  assert.deepEqual(out.marks.filter((m) => m.t === 'pin').map((m) => m.n), [1, 2, 3]);
  assert.deepEqual(out.notes, [{ n: 1, text: '三' }, { n: 2, text: '一' }, { n: 3, text: '' }]);
});

test('sanitizeCardPatch：认识的字段才收，不合规的记在 rejected', () => {
  const { patch, rejected } = sanitizeCardPatch({
    title: '双底', kind: 'bad', item: 'kp_1', trade: 't_1', take: '结论', img: { file: 'shots/c_1/im_1.webp', thumb: 'shots/c_1/im_1.thumb.webp', width: 10, extra: 1 },
    marks: [{ t: 'pin', n: 1, x: 1, y: 1 }, { t: 'nope' }], notes: [{ n: 1, text: 'a' }, 'x'],
    color: 'red', symbol: 3,
  });
  assert.deepEqual(rejected, ['color', 'symbol']);
  assert.deepEqual(patch.img, { file: 'shots/c_1/im_1.webp', thumb: 'shots/c_1/im_1.thumb.webp', width: 10 });
  assert.equal(patch.marks.length, 1);
  assert.deepEqual(patch.notes, [{ n: 1, text: 'a' }]);
  assert.deepEqual(sanitizeCardPatch({ item: 'tp_1', img: { file: 'x' }, kind: 'meh', trade: 'sys_1' }).rejected, ['item', 'img', 'kind', 'trade']);
});

test('主题和知识点：新建、改名、改要点，空名字不建；事件是 study', () => {
  const { a, st, events, store } = setup();
  assert.equal(st(), undefined, '还没用过学习板块时没有 study 键');
  assert.equal(a.addTopic('   '), null);
  const tp = a.addTopic(' 价格行为 ');
  assert.match(tp, /^tp_/);
  const kp = a.addItem(tp, '双底');
  assert.match(kp, /^kp_/);
  assert.equal(a.addItem('tp_nope', 'x'), null);
  assert.equal(a.renameTopic(tp, '价格行为'), false, '没变化');
  assert.equal(a.renameTopic(tp, 'PA'), true);
  assert.equal(a.updateItem(kp, { note: '第二底不破前低' }), true);
  assert.equal(a.updateItem(kp, { name: '  ' }), false, '空名字不改');
  assert.deepEqual(st().topics, [{ id: tp, name: 'PA', items: [{ id: kp, name: '双底', note: '第二底不破前低' }], createdAt: isoNow(NOW()) }]);
  assert.deepEqual(findItem(st(), kp).topic.id, tp);
  assert.ok(events.every((e) => e.type === 'study'));
  assert.deepEqual(events.map((e) => e.reason), ['addTopic', 'addItem', 'renameTopic', 'updateItem']);
  assert.deepEqual(validateJournal(store.get().journal), []);
});

test('学习卡：新建放最前面、编号重排、不认识的知识点当未归类；改动只记真正变了的字段', () => {
  const { a, st, store, events } = setup();
  const tp = a.addTopic('PA');
  const kp = a.addItem(tp, '双底');
  const c1 = a.addCard({ item: kp, title: '第一张', marks: [{ t: 'pin', n: 5, x: 10, y: 10 }], notes: [{ n: 5, text: '底' }] });
  const c2 = a.addCard({ item: 'kp_nope', img: { file: 'shots/t_1/sh_1.webp', thumb: 'shots/t_1/sh_1.thumb.webp' }, trade: 't_1' });
  assert.deepEqual(st().cards.map((c) => c.id), [c2, c1]);
  assert.equal(st().cards[0].item, '', '知识点不存在：未归类');
  assert.deepEqual(st().cards[1].notes, [{ n: 1, text: '底' }]);
  assert.equal(st().cards[1].marks[0].n, 1);
  events.length = 0;
  assert.equal(a.updateCard(c1, { title: '第一张' }), false);
  assert.equal(a.updateCard(c1, { title: '改了', kind: 'bad', color: 'x' }), true);
  assert.deepEqual(events[0].fields, ['title', 'kind']);
  // 只给 marks：说明按原来的对上
  assert.equal(a.updateCard(c1, { marks: [{ t: 'rect', x: 0, y: 0, w: 5, h: 5 }, { t: 'pin', n: 1, x: 1, y: 1 }, { t: 'pin', n: 2, x: 2, y: 2 }] }), true);
  assert.deepEqual(st().cards[1].notes, [{ n: 1, text: '底' }, { n: 2, text: '' }]);
  assert.equal(a.updateCard(c1, { item: 'kp_nope' }), false, '不存在的知识点不收');
  assert.deepEqual(validateJournal(store.get().journal), []);
});

test('删除知识点、主题会带走下面的卡片；撤销按原位置放回；整份换数据后撤销失效', () => {
  const { a, st, store } = setup();
  const tp = a.addTopic('PA');
  const k1 = a.addItem(tp, '双底');
  const k2 = a.addItem(tp, '旗形');
  const cA = a.addCard({ item: k1, title: 'A' });
  const cB = a.addCard({ item: k2, title: 'B' });
  const cC = a.addCard({ item: k1, title: 'C' });
  const loose = a.addCard({ title: '未归类' });
  const before = JSON.stringify(st());

  const undoItem = a.deleteItem(k1);
  assert.deepEqual(st().cards.map((c) => c.title), ['未归类', 'B']);
  assert.deepEqual(st().topics[0].items.map((x) => x.id), [k2]);
  assert.equal(undoItem(), true);
  assert.equal(JSON.stringify(st()), before, '放回原样');
  assert.equal(undoItem(), false, '只能撤销一次');

  const undoTopic = a.deleteTopic(tp);
  assert.deepEqual(st().topics, []);
  assert.deepEqual(st().cards.map((c) => c.id), [loose]);
  assert.equal(undoTopic(), true);
  assert.equal(JSON.stringify(st()), before);

  const undoCard = a.deleteCard(cB);
  assert.equal(st().cards.length, 3);
  store.actions.replaceJournal(journal(), { external: true });
  assert.equal(undoCard(), false, '整份换过数据，旧的撤销不再生效');
  assert.equal(a.deleteCard('c_nope'), null);
  void cA; void cC;
});

test('只读时学习操作都不生效', () => {
  const { a, store } = setup({ topics: [{ id: 'tp_1', name: 'PA', items: [{ id: 'kp_1', name: '双底', note: '' }] }], cards: [] });
  store.actions.setReadOnly('other-tab');
  assert.equal(a.addTopic('x'), null);
  assert.equal(a.addItem('tp_1', 'x'), null);
  assert.equal(a.addCard({}), null);
  assert.equal(a.updateItem('kp_1', { note: 'x' }), false);
  assert.equal(a.deleteTopic('tp_1'), null);
});

test('normalizeJournal：study 的文字被清洗，不认识的字段原样保留；坏的 study 整份拒收', () => {
  const j = normalizeJournal(journal({ topics: [{ id: 'tp_1', name: 'P\u0000A', items: [{ id: 'kp_1', name: 'x', note: 'y', future: 1 }] }], cards: [], v2: { a: 1 } }));
  assert.equal(j.study.topics[0].name, 'PA');
  assert.equal(j.study.topics[0].items[0].future, 1);
  assert.deepEqual(j.study.v2, { a: 1 });
  assert.throws(() => normalizeJournal(journal({ topics: 'x' })), /学习板块/);
});

test('固定格式：study 每个主题、每张卡一行，键顺序固定；写出再读回来一样', () => {
  const { a, store } = setup();
  const tp = a.addTopic('PA');
  const kp = a.addItem(tp, '双底');
  a.addCard({ item: kp, title: 'A', img: { file: 'shots/t_1/sh_1.webp' }, marks: [{ t: 'pin', n: 1, x: 1, y: 2 }], notes: [{ n: 1, text: '一' }] });
  const text = serialize(store.get().journal);
  const lines = text.split('\n');
  const at = lines.indexOf('  "study": {');
  assert.ok(at > 0);
  assert.equal(lines[at + 1], '    "topics": [');
  assert.match(lines[at + 2], /^ {6}\{"id":"tp_[0-9a-f]+","name":"PA","items":\[\{"id":"kp_[0-9a-f]+","name":"双底","note":""\}\],"createdAt":/);
  assert.equal(lines[at + 4], '    "cards": [');
  assert.match(lines[at + 5], /^ {6}\{"id":"c_[0-9a-f]+","item":"kp_[0-9a-f]+","title":"A","kind":"good",/);
  assert.deepEqual(JSON.parse(text), JSON.parse(JSON.stringify(store.get().journal)));
  assert.equal(serialize(JSON.parse(text)), text, '同一份数据写出来逐字节相同');
});

test('studyFiles：卡片引用的大图和缩略图，去重', () => {
  assert.deepEqual(studyFiles({ cards: [
    { img: { file: 'shots/c_1/a.webp', thumb: 'shots/c_1/a.thumb.webp' } }, { img: null }, { img: { file: 'shots/c_1/a.webp' } },
  ] }), ['shots/c_1/a.webp', 'shots/c_1/a.thumb.webp']);
  assert.deepEqual(studyFiles(undefined), []);
});

// ---------- 一张卡好几张图（0.4.1） ----------

const pin = (n, x = 10) => ({ t: 'pin', n, x, y: 10, c: 'red' });
const IMG = (k, label) => ({ file: `shots/t_1/sh_${k}.webp`, thumb: `shots/t_1/sh_${k}.thumb.webp`, ...(label ? { label } : {}) });

test('renumberAll：几张图的编号点连着编，第一张在前；说明跟着原来的号走', () => {
  const r = renumberAll([[pin(2), pin(5)], [], [pin(1)]], [{ n: 1, text: '甲' }, { n: 2, text: '乙' }, { n: 9, text: '多余' }]);
  assert.deepEqual(r.lists.map((l) => l.map((m) => m.n)), [[1, 2], [], [3]]);
  assert.deepEqual(r.notes, [{ n: 1, text: '乙' }, { n: 2, text: '' }, { n: 3, text: '甲' }]);
  assert.deepEqual(renumberPins([pin(3)], [{ n: 3, text: 'x' }]), { marks: [pin(1)], notes: [{ n: 1, text: 'x' }] }, '一张图时和以前一样');
});

test('cardPages / pagesPatch：第一张是 img + marks，后面是 more；没图是空的', () => {
  const card = { img: IMG(1, '开仓时'), marks: [pin(1)], more: [{ img: IMG(2), marks: [] }, { img: null, marks: [] }] };
  const pages = cardPages(card);
  assert.equal(pages.length, 2, '坏的那张跳过');
  assert.equal(pages[0].img.label, '开仓时');
  assert.deepEqual(pagesPatch(pages), { img: card.img, marks: [pin(1)], more: [{ img: IMG(2), marks: [] }] });
  assert.deepEqual(cardPages({ img: null, marks: [] }), []);
  assert.deepEqual(pagesPatch([]), { img: null, marks: [], more: [] });
  assert.deepEqual(cardFiles(card), ['shots/t_1/sh_1.webp', 'shots/t_1/sh_1.thumb.webp', 'shots/t_1/sh_2.webp', 'shots/t_1/sh_2.thumb.webp']);
});

test('sanitizeCardPatch：more 只留合规的图，最多 MAX_PAGES - 1 张；标签去空白、截长，空的不写', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ img: IMG(i + 2), marks: [pin(1), { t: 'bad' }] }));
  const { patch } = sanitizeCardPatch({ img: IMG(1, '  开仓  时 '), more: [{ img: { file: '../x' }, marks: [] }, 'x', ...many] });
  assert.equal(patch.img.label, '开仓 时');
  assert.equal(patch.more.length, MAX_PAGES - 1);
  assert.deepEqual(patch.more[0].marks, [pin(1)], '坏批注丢掉');
  assert.equal('label' in sanitizeCardPatch({ img: IMG(1, '   ') }).patch.img, false);
  assert.deepEqual(sanitizeCardPatch({ more: 'x' }).rejected, ['more']);
});

test('每张图自己的批注 img.note：留着（截到 LONG_MAX）、空的不写、不是字符串要报；固定格式在 label 后面', () => {
  assert.equal(sanitizeCardPatch({ img: { ...IMG(1, '开仓时'), note: '第一行\n第二行' } }).patch.img.note, '第一行\n第二行');
  assert.equal('note' in sanitizeCardPatch({ img: { ...IMG(1), note: '   ' } }).patch.img, false);
  const base = { id: 'c_1', item: '', title: '', kind: 'good', symbol: '', tf: '', source: '', trade: null, take: '', img: { ...IMG(1), note: 5 }, marks: [], notes: [] };
  assert.match(validateStudy({ cards: [base] }).map((e) => e.message).join(), /批注必须是字符串/);
  const { a, store } = setup();
  a.addCard({ img: { ...IMG(1, '开仓时'), note: '甲' }, more: [{ img: { ...IMG(2), note: '乙' }, marks: [] }] });
  const text = serialize(store.get().journal);
  assert.match(text, /"label":"开仓时","note":"甲"\}/);
  assert.match(text, /"more":\[\{"img":\{"file":"shots\/t_1\/sh_2.webp","thumb":"shots\/t_1\/sh_2.thumb.webp","note":"乙"\}/);
  assert.equal(serialize(JSON.parse(text)), text);
});

test('validateStudy：more 结构不对要报；没有第一张图却有 more 也要报', () => {
  const base = { id: 'c_1', item: '', title: '', kind: 'good', symbol: '', tf: '', source: '', trade: null, take: '', img: IMG(1), marks: [], notes: [] };
  assert.deepEqual(validateStudy({ cards: [{ ...base, more: [{ img: IMG(2, '持仓中'), marks: [pin(1)] }] }] }), []);
  const msg = (more, extra = {}) => validateStudy({ cards: [{ ...base, ...extra, more }] }).map((e) => e.message).join('\n');
  assert.match(msg('x'), /more/);
  assert.match(msg([{ img: { file: 'x' }, marks: [] }]), /第 2 张图路径/);
  assert.match(msg([{ img: IMG(2), marks: 'x' }]), /第 2 张图的 marks/);
  assert.match(msg([{ img: IMG(2), marks: [] }], { img: null }), /没有第一张图/);
  assert.match(msg([], { img: { ...IMG(1), label: 3 } }), /标签必须是字符串/);
});

test('学习卡几张图：新建时编号连着编；改了 more 重新编号；拿掉所有后加的图 more 键去掉；格式固定、读回一样', () => {
  const { a, st, store } = setup();
  const id = a.addCard({ img: IMG(1, '开仓时'), marks: [pin(7)], more: [{ img: IMG(2, '持仓中'), marks: [pin(3), pin(4)] }], notes: [{ n: 3, text: '持仓一' }, { n: 7, text: '开仓' }] });
  let c = st().cards[0];
  assert.deepEqual(c.marks.map((m) => m.n), [1]);
  assert.deepEqual(c.more[0].marks.map((m) => m.n), [2, 3]);
  assert.deepEqual(c.notes, [{ n: 1, text: '开仓' }, { n: 2, text: '持仓一' }, { n: 3, text: '' }]);
  const text = serialize(store.get().journal);
  assert.match(text, /"img":\{"file":"shots\/t_1\/sh_1.webp","thumb":"shots\/t_1\/sh_1.thumb.webp","label":"开仓时"\},"marks":\[[^\]]*\],"more":\[\{"img":\{/);
  assert.equal(serialize(JSON.parse(text)), text);
  assert.deepEqual(validateJournal(JSON.parse(text)), []);
  // 两张图对调：编号跟着新顺序重排，说明跟着编号点走
  const pages = cardPages(c);
  assert.equal(a.updateCard(id, pagesPatch([pages[1], pages[0]])), true);
  c = st().cards[0];
  assert.equal(c.img.label, '持仓中');
  assert.deepEqual(c.notes, [{ n: 1, text: '持仓一' }, { n: 2, text: '' }, { n: 3, text: '开仓' }]);
  // 只留一张：more 键去掉
  assert.equal(a.updateCard(id, pagesPatch([cardPages(c)[0]])), true);
  c = st().cards[0];
  assert.equal('more' in c, false);
  assert.deepEqual(c.notes.map((n) => n.text), ['持仓一', '']);
  assert.equal(a.updateCard(id, { more: [] }), false, '本来就没有 more，算没变');
  assert.equal('more' in st().cards[0], false);
  // 一张图的卡没有 more 键
  a.addCard({ img: IMG(3) });
  assert.equal('more' in st().cards[0], false);
});

test('示例数据 fixtures/demo-journal.json：交易和附录 A 一样，学习板块合规，示例图都在 fixtures/study/', async () => {
  const { readFileSync, existsSync } = await import('node:fs');
  const demo = JSON.parse(readFileSync(new URL('../fixtures/demo-journal.json', import.meta.url), 'utf8'));
  const sample = JSON.parse(readFileSync(new URL('../fixtures/sample-journal.json', import.meta.url), 'utf8'));
  assert.deepEqual(demo.rows, sample.rows);
  assert.deepEqual(validateJournal(demo), []);
  for (const p of studyFiles(demo.study)) assert.ok(existsSync(new URL('../fixtures/study/' + p.split('/').pop(), import.meta.url)), p);
});
