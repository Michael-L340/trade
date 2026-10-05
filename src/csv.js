// 导出 CSV（交接文档第 9.3 节）。纯函数，不碰 DOM；界面拿返回的字符串生成下载文件。
// - UTF-8，开头加 BOM（Excel 打开中文不乱码），换行用 CRLF；
// - 含逗号、引号、换行的字段用双引号包起来，内部引号写两遍；
// - 系统行不单独成行，系统名称写在每笔交易的"系统"列里（名称为空时写"系统 A"这样的标签）；
// - 数字列写成纯数字（ASCII 负号、不加千分位和正号），Excel 可以直接计算；
// - 文字列以 = + - @ 开头时前面加一个 '，免得 Excel 把"-50 提前平仓"当成公式显示成 #NAME?。

import { deriveJournal } from './calc.js';
import { OUTCOME_LABEL, fmtDirection, todayLocal } from './format.js';

export const CSV_COLUMNS = Object.freeze([
  '序号', '系统', '日期', '品种', '方向', '盈亏比', '止损金额', '止盈金额', '结果', '盈亏金额', '是否手改', 'R', '开仓理由', '备注', '截图数',
]);

/** 下载时用的 MIME 类型 */
export const CSV_MIME = 'text/csv;charset=utf-8';

const BOM = '\u{FEFF}';
const CRLF = '\r\n';

/** 数字列：去掉 180.00000000000003 这种浮点尾巴，没有值时留空 */
function num(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '';
  const clean = Number(v.toPrecision(12));
  return String(clean === 0 ? 0 : clean);
}

/** 文字列：防止被 Excel 当成公式 */
function text(s) {
  const t = typeof s === 'string' ? s : '';
  return /^[=+\-@\t\r]/.test(t) ? "'" + t : t;
}

/** 含逗号、引号、换行的字段加双引号，内部引号写两遍 */
function quote(s) {
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/**
 * 把整份数据导出成 CSV 文本（含 BOM，CRLF 换行，末尾有换行）。一笔交易一行。
 * @param {{rows: object[]}} journal
 * @returns {string}
 */
export function toCsv(journal) {
  const { grouped } = deriveJournal(journal.rows);
  const lines = [CSV_COLUMNS.join(',')];
  for (const seg of grouped.segments) {
    const system = seg.sys && seg.sys.name ? seg.sys.name : '系统 ' + seg.letter;
    for (const it of seg.trades) {
      const t = it.t;
      const d = it.d;
      lines.push([
        String(it.no),
        text(system),
        typeof t.date === 'string' ? t.date : '',
        text(t.symbol),
        fmtDirection(t.direction),
        num(t.rr),
        num(t.risk),
        num(d.takeProfit),
        OUTCOME_LABEL[d.outcome] || '',
        num(d.pnl),
        d.edited ? '是' : '否',
        num(d.r),
        text(t.reason),
        text(t.note),
        String(Array.isArray(t.shots) ? t.shots.length : 0),
      ].map(quote).join(','));
    }
  }
  return BOM + lines.join(CRLF) + CRLF;
}

/** 导出文件名：交易日志-2026-10-05.csv（日期按本地时区） */
export function csvFileName(now = new Date()) {
  return '交易日志-' + todayLocal(now) + '.csv';
}
