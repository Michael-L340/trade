// @ts-check
// 「学习」板块的数据（journal 顶层的 study 键）：校验、清洗、修改内容的清洗。纯函数，不碰 DOM。
//
// study = {
//   topics: [{ id: 'tp_…', name, items: [{ id: 'kp_…', name, note }] }],   主题 → 知识点；note 是知识点的「要点」
//   cards:  [{ id: 'c_…', item: 'kp_…' 或 ''（未归类）, title, kind: 'good'|'bad', symbol, tf, source,
//             trade: 't_…' 或 null（从复盘收进来的那一笔）, take（一句话结论）,
//             img: null 或 { file, thumb?, width?, height?, bytes? }, marks: [批注], notes: [{ n, text }],
//             createdAt, updatedAt }]
// }
// 卡片在数组里的先后就是显示的先后（新卡放最前面）。知识点被删掉后，引用它的卡片不会悬空：删知识点时一起删掉
// （可以撤销）；读到别处来的、item 指向不存在知识点的卡片，界面当成「未归类」显示。
//
// 批注 marks 的坐标在 1000 × 562 的画布上（16:9），和图片的实际像素无关：
//   { t: 'rect', x, y, w, h, c }      框
//   { t: 'arrow', x1, y1, x2, y2, c } 箭头
//   { t: 'hline', y, c, label }       水平线（label 是线的名字，可以为空）
//   { t: 'pin', n, x, y, c }          编号点，和 notes 里同一个 n 的说明对应
// c 是颜色：'red' | 'blue' | 'amber' | 'green'。
//
// 图片和复盘截图放在同一个地方：shots/<卡片 id>/<图片 id>.webp（缩略图 .thumb.webp）；
// 从复盘收进来的卡片直接引用那一笔的截图路径 shots/<交易 id>/<截图 id>.webp，不另存一份。

export { STUDY_KEYS, TOPIC_KEYS, ITEM_KEYS, CARD_KEYS, IMG_KEYS } from './journal-format.js';

/** 批注画布的大小（16:9） */
export const MARK_W = 1000;
export const MARK_H = 562;
export const MARK_COLORS = Object.freeze(['red', 'blue', 'amber', 'green']);
export const KINDS = Object.freeze(['good', 'bad']);
/** 名字、标题这类短文字最多几个字；要点、结论、说明这类长文字最多几个字 */
export const SHORT_MAX = 40;
export const LONG_MAX = 2000;
/** 一张卡最多几个批注（防止误操作画出成千上万个） */
export const MAX_MARKS = 200;

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;
/** 图片路径：shots/<卡片或交易 id>/<文件名> */
const IMG_PATH = /^shots\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/;

function isPlainObject(v) {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** 去掉 U+0000、孤立代理项换成 U+FFFD（和 model.js 的 cleanText 一样；这里不 import，免得循环引用） */
function clean(s) {
  if (typeof s !== 'string') return '';
  const t = s.indexOf('\x00') === -1 ? s : s.split('\x00').join('');
  if (typeof t.toWellFormed === 'function') return t.toWellFormed();
  return t.replace(/[\u{D800}-\u{DFFF}]/gu, '\u{FFFD}');
}

/** 清洗 + 截到 max 个字（按字数，不切坏 emoji） */
function cut(s, max) {
  const t = clean(s);
  return t.length <= max ? t : Array.from(t).slice(0, max).join('');
}

/** 名字类：去掉首尾空白、连续空白并成一个 */
export function cleanName(s) {
  return cut(clean(s).replace(/\s+/g, ' ').trim(), SHORT_MAX);
}

export function isImgPath(p) {
  return typeof p === 'string' && IMG_PATH.test(p) && !p.split('/').some((x) => x === '.' || x === '..');
}

// ---------- 校验 ----------

/**
 * 校验 study（journal.study）。没有 study 键（undefined）不算错。
 * 返回错误列表，每条 { row: null, id, field: 'study', message }，和 validateJournal 的写法一致。
 * 不认识的字段不算错，会原样保留。
 */
export function validateStudy(study) {
  const errors = [];
  if (study === undefined) return errors;
  const bad = (id, message) => errors.push({ row: null, id: id || null, field: 'study', message: '学习板块：' + message });
  if (!isPlainObject(study)) { bad(null, '不是一个对象'); return errors; }
  const seen = new Set();
  const useId = (id, prefix, what) => {
    if (typeof id !== 'string' || !id.startsWith(prefix) || !ID_PATTERN.test(id)) { bad(null, `${what}的 id 必须以 ${prefix} 开头`); return false; }
    if (seen.has(id)) { bad(id, `${what}的 id ${id} 重复`); return false; }
    seen.add(id);
    return true;
  };
  if (study.topics !== undefined) {
    if (!Array.isArray(study.topics)) bad(null, 'topics（主题）必须是数组');
    else study.topics.forEach((tp, i) => {
      const what = `第 ${i + 1} 个主题`;
      if (!isPlainObject(tp)) { bad(null, what + '不是一个对象'); return; }
      useId(tp.id, 'tp_', what);
      if (typeof tp.name !== 'string') bad(tp.id, what + '的名字必须是字符串');
      if (!Array.isArray(tp.items)) { bad(tp.id, what + '的 items（知识点）必须是数组'); return; }
      tp.items.forEach((it, k) => {
        const w = `${what}的第 ${k + 1} 个知识点`;
        if (!isPlainObject(it)) { bad(tp.id, w + '不是一个对象'); return; }
        useId(it.id, 'kp_', w);
        if (typeof it.name !== 'string') bad(it.id, w + '的名字必须是字符串');
        if (typeof it.note !== 'string') bad(it.id, w + '的要点必须是字符串');
      });
    });
  }
  if (study.cards !== undefined) {
    if (!Array.isArray(study.cards)) bad(null, 'cards（学习卡）必须是数组');
    else study.cards.forEach((c, i) => {
      const what = `第 ${i + 1} 张学习卡`;
      if (!isPlainObject(c)) { bad(null, what + '不是一个对象'); return; }
      useId(c.id, 'c_', what);
      for (const f of ['item', 'title', 'symbol', 'tf', 'source', 'take']) {
        if (typeof c[f] !== 'string') bad(c.id, `${what}的 ${f} 必须是字符串`);
      }
      if (!KINDS.includes(c.kind)) bad(c.id, what + '的 kind 必须是 "good" 或 "bad"');
      if (c.trade !== null && typeof c.trade !== 'string') bad(c.id, what + '的 trade 必须是交易 id 或 null');
      if (c.img !== null) {
        if (!isPlainObject(c.img)) bad(c.id, what + '的 img 必须是对象或 null');
        else {
          if (!isImgPath(c.img.file)) bad(c.id, `${what}的图片路径必须是 shots/<id>/<文件名>，实际是 ${JSON.stringify(c.img.file)}`);
          if (c.img.thumb !== undefined && !isImgPath(c.img.thumb)) bad(c.id, `${what}的缩略图路径必须是 shots/<id>/<文件名>`);
          for (const f of ['width', 'height', 'bytes']) {
            if (c.img[f] !== undefined && !(isNum(c.img[f]) && c.img[f] >= 0)) bad(c.id, `${what}的图片 ${f} 必须是不小于 0 的数字`);
          }
        }
      }
      if (!Array.isArray(c.marks)) bad(c.id, what + '的 marks（批注）必须是数组');
      else if (c.marks.some((m) => !isPlainObject(m))) bad(c.id, what + '的批注必须都是对象');
      if (!Array.isArray(c.notes)) bad(c.id, what + '的 notes（编号说明）必须是数组');
      else if (c.notes.some((n) => !isPlainObject(n) || !Number.isInteger(n.n) || typeof n.text !== 'string')) bad(c.id, what + '的编号说明格式不对');
      for (const f of ['createdAt', 'updatedAt']) if (c[f] !== undefined && typeof c[f] !== 'string') bad(c.id, `${what}的 ${f} 必须是字符串`);
    });
  }
  return errors;
}

// ---------- 读进来时的清洗 ----------

/** 读进来的 study 整理一遍：文字过 clean，缺的数组补上。不改动入参；没有 study 时返回 undefined。 */
export function cleanStudy(study) {
  if (!isPlainObject(study)) return undefined;
  const out = { ...study };
  out.topics = (Array.isArray(study.topics) ? study.topics : []).map((tp) => ({
    ...tp,
    name: clean(tp.name),
    items: tp.items.map((it) => ({ ...it, name: clean(it.name), note: clean(it.note) })),
  }));
  out.cards = (Array.isArray(study.cards) ? study.cards : []).map((c) => ({
    ...c,
    title: clean(c.title), symbol: clean(c.symbol), tf: clean(c.tf), source: clean(c.source), take: clean(c.take), item: clean(c.item),
    marks: c.marks.map((m) => (typeof m.label === 'string' ? { ...m, label: clean(m.label) } : m)),
    notes: c.notes.map((n) => ({ ...n, text: clean(n.text) })),
  }));
  return out;
}

export function emptyStudy() {
  return { topics: [], cards: [] };
}

// ---------- 修改内容的清洗 ----------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const round1 = (v) => Math.round(v * 10) / 10;
const px = (v) => round1(clamp(v, 0, MARK_W));
const py = (v) => round1(clamp(v, 0, MARK_H));

/** 一个批注：认识的形状、坐标在画布里（超出的拉回边上）、颜色认识；不合规返回 null */
export function sanitizeMark(m) {
  if (!isPlainObject(m)) return null;
  const c = MARK_COLORS.includes(m.c) ? m.c : 'red';
  switch (m.t) {
    case 'rect': {
      if (![m.x, m.y, m.w, m.h].every(isNum)) return null;
      const x = px(m.w < 0 ? m.x + m.w : m.x);
      const y = py(m.h < 0 ? m.y + m.h : m.y);
      const w = round1(clamp(Math.abs(m.w), 0, MARK_W - x));
      const h = round1(clamp(Math.abs(m.h), 0, MARK_H - y));
      return w > 0 && h > 0 ? { t: 'rect', x, y, w, h, c } : null;
    }
    case 'arrow':
      if (![m.x1, m.y1, m.x2, m.y2].every(isNum)) return null;
      return { t: 'arrow', x1: px(m.x1), y1: py(m.y1), x2: px(m.x2), y2: py(m.y2), c };
    case 'hline':
      if (!isNum(m.y)) return null;
      return { t: 'hline', y: py(m.y), c, label: cut(typeof m.label === 'string' ? m.label : '', SHORT_MAX) };
    case 'pin':
      if (![m.x, m.y].every(isNum) || !Number.isInteger(m.n) || m.n < 1) return null;
      return { t: 'pin', n: m.n, x: px(m.x), y: py(m.y), c };
    default:
      return null;
  }
}

/**
 * 编号点从 1 起按出现顺序重新编号，说明跟着改号；没有对应编号点的说明去掉、缺说明的编号点补一条空说明。
 * @returns {{marks: object[], notes: {n: number, text: string}[]}}
 */
export function renumberPins(marks, notes) {
  const map = new Map();
  let k = 0;
  const outMarks = marks.map((m) => {
    if (m.t !== 'pin') return m;
    k += 1;
    if (!map.has(m.n)) map.set(m.n, k);
    return { ...m, n: k };
  });
  const byOld = new Map();
  for (const n of notes) if (isPlainObject(n) && Number.isInteger(n.n) && !byOld.has(n.n)) byOld.set(n.n, typeof n.text === 'string' ? n.text : '');
  const outNotes = [];
  let j = 0;
  for (const m of marks) {
    if (m.t !== 'pin') continue;
    j += 1;
    outNotes.push({ n: j, text: byOld.has(m.n) ? byOld.get(m.n) : '' });
  }
  return { marks: outMarks, notes: outNotes };
}

/**
 * 清洗对学习卡的修改：只留认识的字段，值不合规的丢掉（记在 rejected 里）。
 * marks、notes 要一起给（编号点和说明对得上）；只给其中一个时另一个按原卡片的补上——这一步由调用方（state.js）做。
 * @returns {{patch: object, rejected: string[]}}
 */
export function sanitizeCardPatch(fields) {
  const patch = {};
  const rejected = [];
  if (!isPlainObject(fields)) return { patch, rejected };
  for (const key of Object.keys(fields)) {
    const v = fields[key];
    switch (key) {
      case 'title':
      case 'symbol':
      case 'tf':
      case 'source':
        if (typeof v === 'string') patch[key] = cut(v, SHORT_MAX); else rejected.push(key);
        break;
      case 'take':
        if (typeof v === 'string') patch.take = cut(v, LONG_MAX); else rejected.push(key);
        break;
      case 'item':
        if (v === '' || (typeof v === 'string' && v.startsWith('kp_') && ID_PATTERN.test(v))) patch.item = v; else rejected.push(key);
        break;
      case 'kind':
        if (KINDS.includes(v)) patch.kind = v; else rejected.push(key);
        break;
      case 'trade':
        if (v === null || (typeof v === 'string' && v.startsWith('t_') && ID_PATTERN.test(v))) patch.trade = v; else rejected.push(key);
        break;
      case 'img':
        if (v === null) patch.img = null;
        else if (isPlainObject(v) && isImgPath(v.file) && (v.thumb === undefined || isImgPath(v.thumb))) {
          const img = { file: v.file };
          if (v.thumb !== undefined) img.thumb = v.thumb;
          for (const f of ['width', 'height', 'bytes']) if (isNum(v[f]) && v[f] >= 0) img[f] = v[f];
          patch.img = img;
        } else rejected.push(key);
        break;
      case 'marks':
        if (Array.isArray(v)) patch.marks = v.map(sanitizeMark).filter(Boolean).slice(0, MAX_MARKS); else rejected.push(key);
        break;
      case 'notes':
        if (Array.isArray(v)) patch.notes = v.filter((n) => isPlainObject(n) && Number.isInteger(n.n)).map((n) => ({ n: n.n, text: cut(typeof n.text === 'string' ? n.text : '', LONG_MAX) }));
        else rejected.push(key);
        break;
      default:
        rejected.push(key);
    }
  }
  return { patch, rejected };
}

// ---------- 查询 ----------

/** 知识点 id → { topic, item }；找不到返回 null */
export function findItem(study, itemId) {
  if (!study || !Array.isArray(study.topics) || !itemId) return null;
  for (const topic of study.topics) {
    for (const item of topic.items) if (item.id === itemId) return { topic, item };
  }
  return null;
}

/** 学习卡引用的图片路径（大图和缩略图） */
export function cardFiles(card) {
  const out = [];
  if (card && isPlainObject(card.img)) {
    for (const p of [card.img.file, card.img.thumb]) if (typeof p === 'string' && p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** 整个学习板块引用的图片路径 */
export function studyFiles(study) {
  const out = [];
  const cards = study && Array.isArray(study.cards) ? study.cards : [];
  for (const c of cards) for (const p of cardFiles(c)) if (!out.includes(p)) out.push(p);
  return out;
}
