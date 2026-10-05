// 内存状态、修改操作、订阅。纯 JS，不碰 DOM；界面模块只能通过这里的 actions 改数据。
//
// store.get() → { journal, derived, ui }
//   journal：当前显示的数据（示例模式下是示例数据），整份冻结，只能读；
//   derived：{ grouped: {segments, trades, nextNo}, all, segStats: Map(系统行 id → 统计), tradeById, segmentById }，
//            每次修改后从 journal 重新算出来，不保存；
//   ui：{ selectedId, demo, dirty, localRev, readOnly }。
//     dirty：真实数据有还没写进本机存储的修改（示例模式下的修改不算）；
//     localRev：每次数据修改加 1；readOnly：null 或只读原因（'other-tab'、'newer-schema' 等）。
//
// store.subscribe(fn) → 取消订阅的函数。fn 收到 { type, ids, reason, fields? }：
//   'row'     一行的内容变了（ids 只有这一行）：只更新这一行的格子，焦点所在的输入框不要动；
//   'rows'    行增删（ids 是新增/删除/恢复的行）：按 id 增删表格行，再刷新行号和系统字母；
//             reason 为 'currency' 时 ids 是全部行，表头和金额格要换单位；
//   'journal' 整份数据换了（载入、恢复、进出示例模式）：整表重建；
//   'ui'      只有界面状态变了（选中行、保存状态、只读）。
//   不论哪种数据事件，系统行小计、顶部统计、曲线和空行的灰色默认值都要跟着刷新（都很便宜）。

import { deriveJournal, deriveTrade, EPS } from './calc.js';
import { parseNumber, todayLocal } from './format.js';
import {
  newSystemRow, newTrade, normalizeJournal, emptyJournal, sanitizeTradePatch, sanitizeSystemPatch, cleanText, isoNow,
} from './model.js';

function deepFreeze(v) {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b);
  return a === b || (Number.isNaN(a) && Number.isNaN(b));
}

/** 金额相等（相对容差，避免 1.8 × 100 这类浮点误差让"和自动值相等"判断失灵） */
function sameMoney(a, b) {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

function reportListenerError(err) {
  if (typeof globalThis.reportError === 'function') globalThis.reportError(err);
  else setTimeout(() => { throw err; });
}

/**
 * 空行里预先显示的值（7.4）：日期是今天，品种和止损金额沿用上一笔，方向默认"多"。
 * "上一笔"是表格里最后一笔交易。
 */
export function emptyRowDefaults(journal, now = new Date()) {
  let last = null;
  for (let i = journal.rows.length - 1; i >= 0; i--) {
    if (journal.rows[i].type === 'trade') { last = journal.rows[i]; break; }
  }
  return {
    date: todayLocal(now),
    symbol: last && typeof last.symbol === 'string' ? last.symbol : '',
    risk: last && typeof last.risk === 'number' && Number.isFinite(last.risk) && last.risk > 0 ? last.risk : null,
    direction: 'long',
  };
}

/**
 * 建一个 store。
 * @param {object|null} initial 读到的数据；null 表示首次使用，自动建一个名称为空的系统行。
 *   数据会先经过 normalizeJournal（迁移、校验、清洗、补第一行）；校验不过或数据比网站新时抛 ModelError，
 *   由调用方提示用户（NEWER_SCHEMA 时可以用 createStore(null, { readOnly: 'newer-schema' }) 进入只读）。
 * @param {{now?: () => Date, readOnly?: string|null}} [opts]
 */
export function createStore(initial, opts = {}) {
  const now = typeof opts.now === 'function' ? opts.now : () => new Date();

  let real = deepFreeze(initial == null ? emptyJournal({ now: now() }) : normalizeJournal(initial, { now: now() }));
  let journal = real; // 示例模式下是示例数据，real 仍是用户自己的数据
  let derived = deriveJournal(journal.rows);
  let ui = Object.freeze({ selectedId: null, demo: false, dirty: false, localRev: 0, readOnly: opts.readOnly || null });
  let state = Object.freeze({ journal, derived, ui });
  let lastRealRev = 0; // 最近一次修改真实数据时的 localRev
  let epoch = 0; // 每次整份换数据加 1，让旧的撤销失效
  const listeners = new Set();

  function emit(ev) {
    for (const fn of Array.from(listeners)) {
      try { fn(ev); } catch (err) { reportListenerError(err); }
    }
  }

  function setUi(patch) {
    ui = Object.freeze({ ...ui, ...patch });
    state = Object.freeze({ journal, derived, ui });
  }

  function setJournal(next, uiPatch) {
    journal = next;
    derived = deriveJournal(journal.rows);
    setUi(uiPatch || {});
  }

  /** 一次数据修改：localRev + 1；不在示例模式时同时更新真实数据并标 dirty。 */
  function commit(nextJournal, ev, uiPatch) {
    deepFreeze(nextJournal);
    const localRev = ui.localRev + 1;
    if (ui.demo) {
      setJournal(nextJournal, { ...uiPatch, localRev });
    } else {
      real = nextJournal;
      lastRealRev = localRev;
      setJournal(nextJournal, { ...uiPatch, localRev, dirty: true });
    }
    emit(ev);
  }

  const canEdit = () => ui.demo || !ui.readOnly;
  const indexOf = (id) => journal.rows.findIndex((r) => r.id === id);
  const tradeAt = (id) => {
    const i = indexOf(id);
    return i >= 0 && journal.rows[i].type === 'trade' ? i : -1;
  };

  function takenIds() {
    const taken = new Set();
    for (const r of journal.rows) {
      taken.add(r.id);
      if (Array.isArray(r.shots)) for (const s of r.shots) taken.add(s.id);
    }
    return taken;
  }

  function withRows(mutate) {
    const rows = journal.rows.slice();
    mutate(rows);
    return { ...journal, rows };
  }

  /** 改一行交易里已经清洗过的字段；没有实际变化时什么都不做，返回 false。 */
  function patchTrade(id, clean, reason) {
    const i = tradeAt(id);
    if (i < 0) return false;
    const old = journal.rows[i];
    const fields = Object.keys(clean).filter((k) => !sameValue(old[k], clean[k]));
    if (!fields.length) return false;
    const next = { ...old };
    for (const k of fields) next[k] = clean[k];
    next.updatedAt = isoNow(now());
    commit(withRows((rows) => { rows[i] = next; }), { type: 'row', ids: [id], reason, fields });
    return true;
  }

  /** 删除后的撤销：放回原来的位置（原来的上一行还在就放在它后面，否则放在原来的下一行前面）。 */
  function makeUndo(row, index, prevId, nextId) {
    const myEpoch = epoch;
    let used = false;
    return function undo() {
      if (used || epoch !== myEpoch || !canEdit()) return false;
      used = true;
      if (indexOf(row.id) !== -1) return false;
      let at = -1;
      const p = prevId ? indexOf(prevId) : -1;
      if (p !== -1) at = p + 1;
      else {
        const n = nextId ? indexOf(nextId) : -1;
        at = n !== -1 ? n : Math.min(index, journal.rows.length);
      }
      at = Math.max(at, 1); // 第一行永远是系统行
      commit(withRows((rows) => { rows.splice(at, 0, row); }), { type: 'rows', ids: [row.id], reason: 'undo' });
      return true;
    };
  }

  function removeRow(i, reason) {
    const row = journal.rows[i];
    const prevId = i > 0 ? journal.rows[i - 1].id : null;
    const nextId = i + 1 < journal.rows.length ? journal.rows[i + 1].id : null;
    commit(
      withRows((rows) => { rows.splice(i, 1); }),
      { type: 'rows', ids: [row.id], reason },
      ui.selectedId === row.id ? { selectedId: null } : null,
    );
    return makeUndo(row, i, prevId, nextId);
  }

  const actions = {
    /**
     * 第一次在空行输入时调用：按空行的默认值（今天、沿用上一笔的品种和止损、方向多）建一笔交易，
     * 再套上 patch（用户正在输入的那个字段），加在表格最后。不改选中行。返回新交易的 id。
     */
    createTradeFromEmptyRow(patch = {}) {
      if (!canEdit()) return null;
      const at = now();
      const d = emptyRowDefaults(journal, at);
      const trade = newTrade({ date: d.date, symbol: d.symbol, direction: d.direction, risk: d.risk, ...sanitizeTradePatch(patch).patch }, { now: at, taken: takenIds() });
      commit(withRows((rows) => { rows.push(trade); }), { type: 'rows', ids: [trade.id], reason: 'create' });
      return trade.id;
    },

    /** 改一笔交易的字段（date、symbol、direction、rr、risk、result、pnlOverride、reason、note、shots）。有变化返回 true。 */
    updateTrade(id, patch) {
      if (!canEdit()) return false;
      return patchTrade(id, sanitizeTradePatch(patch).patch, 'update');
    },

    /** 点结果格：空 → 盈 → 亏 → 空 循环，同时把手改金额清掉（6.2）。 */
    cycleResult(id) {
      if (!canEdit()) return false;
      const i = tradeAt(id);
      if (i < 0) return false;
      const cur = journal.rows[i].result;
      const next = cur === null ? 'win' : cur === 'win' ? 'loss' : null;
      return patchTrade(id, { result: next, pnlOverride: null }, 'result');
    },

    /** 键盘设结果（1/Y 盈、0/N 亏、Backspace 清空），同样清掉手改金额。 */
    setResult(id, result) {
      if (!canEdit()) return false;
      if (result !== 'win' && result !== 'loss' && result !== null) return false;
      return patchTrade(id, { result, pnlOverride: null }, 'result');
    },

    /**
     * 在盈亏金额格里输入（6.2）：
     * - 清空（null 或空串）→ pnlOverride = null，回到自动值；
     * - 输入的数先按正负定结果（正 → 盈、负 → 亏、0 → 结果不变），
     *   和这个结果下的自动值相等 → pnlOverride = null（不显示"改"），不相等 → pnlOverride = 输入值（显示"改"）。
     * 返回 true 表示输入看得懂（不论有没有变化）；false 表示无法解析，界面应恢复原来的显示。
     */
    setPnlInput(id, input) {
      if (!canEdit()) return false;
      const i = tradeAt(id);
      if (i < 0) return false;
      const t = journal.rows[i];
      if (input === null || input === undefined || (typeof input === 'string' && input.trim() === '')) {
        patchTrade(id, { pnlOverride: null }, 'pnl');
        return true;
      }
      const v = parseNumber(input, { currency: journal.currency });
      if (v === null) return false;
      const result = v > EPS ? 'win' : v < -EPS ? 'loss' : t.result;
      const auto = deriveTrade({ ...t, result, pnlOverride: null }).pnl;
      const pnlOverride = auto !== null && sameMoney(v, auto) ? null : v;
      patchTrade(id, { result, pnlOverride }, 'pnl');
      return true;
    },

    /** 删除一笔交易。返回撤销函数（调用后放回原位，返回是否成功）；没删成返回 null。 */
    deleteTrade(id) {
      if (!canEdit()) return null;
      const i = tradeAt(id);
      if (i < 0) return null;
      return removeRow(i, 'delete');
    },

    /**
     * 某个系统下面的「＋ 记一笔」：在这个系统的最后一笔后面（下一个系统行前面）加一笔，返回新交易的 id。
     * 默认值：今天、方向多，品种和止损沿用这个系统里的上一笔（这个系统还没有交易时沿用全表最后一笔）。
     */
    addTradeToSystem(sysId) {
      if (!canEdit()) return null;
      const i = indexOf(sysId);
      if (i < 0 || journal.rows[i].type !== 'system') return null;
      let end = i + 1;
      while (end < journal.rows.length && journal.rows[end].type !== 'system') end++;
      const at = now();
      const d = end > i + 1 ? emptyRowDefaults({ rows: journal.rows.slice(i, end) }, at) : emptyRowDefaults(journal, at);
      const trade = newTrade({ date: d.date, symbol: d.symbol, direction: d.direction, risk: d.risk }, { now: at, taken: takenIds() });
      commit(withRows((rows) => { rows.splice(end, 0, trade); }), { type: 'rows', ids: [trade.id], reason: 'create' });
      return trade.id;
    },

    /** 在某笔交易上方插入一个空的系统行，返回它的 id。 */
    insertSystemRowAbove(tradeId) {
      if (!canEdit()) return null;
      const i = tradeAt(tradeId);
      if (i < 1) return null;
      const sys = newSystemRow({}, { now: now(), taken: takenIds() });
      commit(withRows((rows) => { rows.splice(i, 0, sys); }), { type: 'rows', ids: [sys.id], reason: 'insertSystem' });
      return sys.id;
    },

    /**
     * "换交易系统"按钮：在最后一笔交易后面加一个空的系统行，返回它的 id（界面把焦点放到名称上）。
     * 如果表格末尾已经是一个下面还没有交易的系统行，就不再加，直接返回它的 id。
     */
    appendSystemRow() {
      if (!canEdit()) return null;
      const last = journal.rows[journal.rows.length - 1];
      if (last && last.type === 'system') return last.id;
      const sys = newSystemRow({}, { now: now(), taken: takenIds() });
      commit(withRows((rows) => { rows.push(sys); }), { type: 'rows', ids: [sys.id], reason: 'appendSystem' });
      return sys.id;
    },

    /** 改系统行的名称或说明（name、desc）。有变化返回 true。 */
    updateSystem(id, patch) {
      if (!canEdit()) return false;
      const i = indexOf(id);
      if (i < 0 || journal.rows[i].type !== 'system') return false;
      const old = journal.rows[i];
      const clean = sanitizeSystemPatch(patch).patch;
      const fields = Object.keys(clean).filter((k) => old[k] !== clean[k]);
      if (!fields.length) return false;
      commit(withRows((rows) => { rows[i] = { ...old, ...clean }; }), { type: 'row', ids: [id], reason: 'update', fields });
      return true;
    },

    /** 删除系统行（第一行不许删），它下面的交易并入上一个系统。返回撤销函数；没删成返回 null。 */
    deleteSystemRow(id) {
      if (!canEdit()) return null;
      const i = indexOf(id);
      if (i < 1 || journal.rows[i].type !== 'system') return null;
      return removeRow(i, 'deleteSystem');
    },

    /** 设置金额单位（去掉首尾空格，最多 8 个字符，可以为空）。有变化返回 true。 */
    setCurrency(cur) {
      if (!canEdit()) return false;
      const c = Array.from(cleanText(String(cur ?? '')).trim()).slice(0, 8).join('');
      if (c === journal.currency) return false;
      commit({ ...journal, currency: c }, { type: 'rows', ids: journal.rows.map((r) => r.id), reason: 'currency' });
      return true;
    },

    /**
     * 整份换数据。journal 会先经过 normalizeJournal，不合规时抛 ModelError。
     * - { demo: true }：进入示例模式。示例数据只在内存里，修改不标 dirty；用户自己的数据原封不动地留着。
     * - { external: true }：另一个标签页保存了新数据，这里重新读进来（不标 dirty）。
     *   在示例模式下只替换留着的真实数据，退出示例后看到的就是新的。
     * - 都不传：从 journal.json 恢复。替换真实数据并标 dirty（随后会写进本机存储），同时退出示例模式；
     *   只读时拒绝，返回 false。
     * 成功返回 true。
     */
    replaceJournal(next, { demo = false, external = false } = {}) {
      if (!demo && !external && ui.readOnly) return false;
      const j = deepFreeze(normalizeJournal(next, { now: now() }));
      if (demo) {
        epoch += 1;
        setJournal(j, { demo: true, selectedId: null, localRev: ui.localRev + 1 });
        emit({ type: 'journal', ids: [], reason: 'demo' });
        return true;
      }
      if (external) {
        real = j;
        if (ui.demo) return true;
        epoch += 1;
        setJournal(j, { selectedId: null, dirty: false, localRev: ui.localRev + 1 });
        emit({ type: 'journal', ids: [], reason: 'external' });
        return true;
      }
      epoch += 1;
      real = j;
      lastRealRev = ui.localRev + 1;
      setJournal(j, { demo: false, selectedId: null, dirty: true, localRev: lastRealRev });
      emit({ type: 'journal', ids: [], reason: 'restore' });
      return true;
    },

    /** 退出示例模式，回到用户自己的数据。不在示例模式时返回 false。 */
    exitDemo() {
      if (!ui.demo) return false;
      epoch += 1;
      setJournal(real, { demo: false, selectedId: null, localRev: ui.localRev + 1 });
      emit({ type: 'journal', ids: [], reason: 'exitDemo' });
      return true;
    },

    /** 选中一笔交易（单笔详情打开时），null 取消选中。事件的 ids 是取消和新选中的行。 */
    select(id) {
      const next = id == null ? null : derived.tradeById.has(id) ? id : undefined;
      if (next === undefined || next === ui.selectedId) return false;
      const prev = ui.selectedId;
      setUi({ selectedId: next });
      emit({ type: 'ui', ids: [prev, next].filter((x) => x !== null), reason: 'select' });
      return true;
    },

    /**
     * 本机存储写完后调用：rev 是发起保存时的 localRev。这之后真实数据没再改过，就清掉 dirty。
     */
    markSaved(rev) {
      if (!ui.dirty || rev < lastRealRev) return false;
      setUi({ dirty: false });
      emit({ type: 'ui', ids: [], reason: 'saved' });
      return true;
    },

    /** 设为只读（reason 是原因，例如 'other-tab'、'newer-schema'）或解除只读（null）。只读时示例模式仍可用。 */
    setReadOnly(reason) {
      const r = reason || null;
      if (r === ui.readOnly) return false;
      setUi({ readOnly: r });
      emit({ type: 'ui', ids: [], reason: 'readOnly' });
      return true;
    },
  };

  return {
    get: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    actions,
    /** 当前能不能改数据（示例模式下总能改） */
    canEdit,
    /** 用户自己的数据（示例模式下也返回真实数据，供导出备份等使用） */
    realJournal: () => real,
    /** 空行此刻该显示的默认值 */
    emptyRowDefaults: () => emptyRowDefaults(journal, now()),
  };
}
