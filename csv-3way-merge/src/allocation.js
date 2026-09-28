'use strict';

/**
 * 合并金额尾差分摊（cent rounding-difference allocation）。
 *
 * 冲突全部裁决后，本模块按本轮保存的模型与当前裁决算出最终保留行（与 CSV 导出、
 * 来源账本、层级核验、键变更核对、最小决定列发现共用 merge.js 中的
 * resolveRowProvenance，行序与逐格取值完全一致），把金额列按分组列分组后做
 * "四舍五入到分且组分摊总额守恒"的尾差分摊：
 *
 *  1. 金额以**元**计，只接受非负、无指数、最多四位小数的十进制字符串
 *     （空串也非法）；非法值逐行指出**最终 CSV 行号**并拒绝整次计算，
 *     不产出任何分摊结果。
 *  2. 分组列按**原字符串**精确分组（不裁剪空白、不做归一化），空串 "" 也是组。
 *  3. 各组先用万分之一元为单位（BigInt 整数）**精确求和**，再对组总额四舍五入
 *     到分（0.01 元，半值向上）。
 *  4. 每行先**向下取整到分**；组总额四舍五入与各行取整之和的差额（单位：分，
 *     0 ≤ 差额 ≤ 行数）按"原金额不足一分的余数"**降序**逐分分配，余数相同
 *     时按**最终 CSV 行序**靠前者优先——即余数排名前 D 行各多得 1 分。
 *
 * 因此每组各行分摊额之和**精确等于**组总额四舍五入到分的结果；所有计算只用
 * BigInt 整数，不经过浮点。分析只读，不改变任何数据、裁决与原合并 CSV 导出；
 * 有未决冲突时不产出结论。
 */

const { resolveRowProvenance } = require('./merge');

/** 导出 CSV 追加的列名（固定；原表头已有同名列时明确报错，绝不覆盖原列） */
const APPENDED_HEADER = '分摊金额';

/**
 * 金额字符串白名单：非负、无指数、最多四位小数的十进制字符串。
 * 接受 "0" / "1" / "1.2" / "0.0001" / "123.4567"；
 * 拒绝空串、空白、正负号、指数、前导零、省略整数或小数位、超过四位小数。
 */
const AMOUNT_PATTERN = /^(?:0|[1-9]\d*)(?:\.\d{1,4})?$/;

/**
 * 解析金额字符串为万分之一元（1e-4 元）的非负 BigInt；
 * 合法时返回 bigint，非法时返回 null。
 * @param {string} raw
 * @returns {bigint|null}
 */
function parseAmountUnits(raw) {
  if (typeof raw !== 'string' || !AMOUNT_PATTERN.test(raw)) return null;
  const dot = raw.indexOf('.');
  if (dot < 0) return BigInt(raw) * 10000n;
  const whole = raw.slice(0, dot);
  const frac = raw.slice(dot + 1).padEnd(4, '0');
  return BigInt(whole) * 10000n + BigInt(frac);
}

/**
 * 万分之一元（1e-4 元）整数格式化为最多四位小数的元字符串（截去尾随零）。
 * @param {bigint} units 非负 BigInt
 * @returns {string}
 */
function formatYuan10(units) {
  const whole = units / 10000n;
  const frac = (units % 10000n).toString().padStart(4, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/**
 * 分（0.01 元）整数格式化为固定两位小数的元字符串。
 * @param {bigint|number} cents 非负
 * @returns {string}
 */
function formatCents(cents) {
  const c = typeof cents === 'bigint' ? cents : BigInt(cents);
  return `${c / 100n}.${(c % 100n).toString().padStart(2, '0')}`;
}

/**
 * 不足一分的余数（取值 0～99，单位为百分之一分 = 万分之一元）格式化为分字符串：
 * 0 → "0"，1 → "0.01"，50 → "0.5"。
 * @param {bigint} rem 0n～99n
 * @returns {string}
 */
function formatRemainderCents(rem) {
  const r = Number(rem);
  if (r === 0) return '0';
  const intPart = Math.floor(r / 100);
  const frac = (r % 100).toString().padStart(2, '0').replace(/0+$/, '');
  return frac ? `${intPart}.${frac}` : `${intPart}`;
}

/**
 * 校验分摊参数：
 *  - 分组列 / 金额列必须给出且存在于表头，两列必须互异；
 *  - 追加列名（"分摊金额"）不得与原表头任一列同名。
 * 分组列允许是唯一键列，空字符串分组值由计算阶段处理。
 * @returns {string|null} 错误信息；合法时返回 null
 */
function validateAllocationParams(model, groupColumn, amountColumn) {
  if (!groupColumn || typeof groupColumn !== 'string') {
    return '请求缺少 groupColumn（分组列）';
  }
  if (!amountColumn || typeof amountColumn !== 'string') {
    return '请求缺少 amountColumn（金额列）';
  }
  if (!model.headers.includes(groupColumn)) {
    return `分组列 "${groupColumn}" 不在表头中`;
  }
  if (!model.headers.includes(amountColumn)) {
    return `金额列 "${amountColumn}" 不在表头中`;
  }
  if (groupColumn === amountColumn) {
    return '分组列与金额列必须互异（不能选择同一列）';
  }
  if (model.headers.includes(APPENDED_HEADER)) {
    return `原表头已存在名为 "${APPENDED_HEADER}" 的列，拒绝追加同名列，请先在源数据中改名`;
  }
  return null;
}

/**
 * 计算合并金额尾差分摊。
 *
 * @param {object} model 服务端本轮保存的合并模型（buildMerge 的输出）
 * @param {object} decisions 已规范化的冲突裁决
 * @param {string} groupColumn 分组列名（调用前需先经 validateAllocationParams 校验）
 * @param {string} amountColumn 金额列名（同上）
 * @returns {{ unresolved: number, unresolvedDetails: string[],
 *             valueErrors?: Array<{line:number, key:string, message:string}>,
 *             allocation?: object, rows?: string[][] }}
 *   有未决冲突时只返回 unresolved / unresolvedDetails（不给出结论）；
 *   存在非法金额值时返回 valueErrors（逐行附最终 CSV 行号，拒绝整次计算）；
 *   否则 allocation 为完整分摊结果，rows 为追加分摊金额列后的导出行（原行序）。
 */
function buildAllocation(model, decisions, groupColumn, amountColumn) {
  const headers = model.headers;
  const groupIdx = headers.indexOf(groupColumn);
  const amountIdx = headers.indexOf(amountColumn);

  // 最终保留行：与 CSV 导出 / 账本 / 各分析模块同一套 resolveRowProvenance
  const finalRows = [];
  const unresolvedDetails = [];
  for (const row of model.rows) {
    const res = resolveRowProvenance(row, decisions, headers);
    for (const msg of res.unresolved) unresolvedDetails.push(`键 "${row.key}"：${msg}`);
    if (!res.deleted) finalRows.push({ key: res.key, cells: res.cells });
  }
  if (unresolvedDetails.length > 0) {
    return { unresolved: unresolvedDetails.length, unresolvedDetails };
  }

  const exportHeader = headers.concat([APPENDED_HEADER]);

  // 无保留行：只输出新表头（无分组、无行、无错误）
  if (finalRows.length === 0) {
    return {
      unresolved: 0,
      unresolvedDetails: [],
      allocation: {
        version: 1,
        generatedAt: new Date().toISOString(),
        keyColumn: model.keyColumn,
        groupColumn,
        amountColumn,
        appendedHeader: APPENDED_HEADER,
        rowCount: 0,
        noData: true,
        groups: [],
      },
      rows: [exportHeader],
    };
  }

  // 先逐行解析金额，任一非法都收集最终 CSV 行号并拒绝整次计算
  const parsedRows = [];
  const valueErrors = [];
  for (let i = 0; i < finalRows.length; i++) {
    const r = finalRows[i];
    const line = i + 2; // 最终 CSV 物理行号（表头为第 1 行）
    const groupValue = r.cells[groupIdx] == null ? '' : r.cells[groupIdx];
    const rawAmount = r.cells[amountIdx] == null ? '' : r.cells[amountIdx];
    const units = parseAmountUnits(rawAmount);
    if (units === null) {
      valueErrors.push({
        line,
        key: r.key,
        // 行号由错误信封的 line 字段承载（页面渲染为"第 N 行"前缀），消息内不重复
        message:
          `键 "${r.key}" 的金额列 "${amountColumn}" 值 ${JSON.stringify(rawAmount)} 不是合法金额：` +
          '金额以元计，必须是非负、无指数、最多四位小数的十进制字符串',
      });
      continue;
    }
    parsedRows.push({ index: i, line, key: r.key, groupValue, rawAmount, units });
  }
  if (valueErrors.length > 0) {
    valueErrors.sort((a, b) => a.line - b.line);
    return { unresolved: 0, unresolvedDetails: [], valueErrors };
  }

  // 按分组列原字符串分组（Map 保留组首次出现顺序；空串也是普通组键）
  const groupsMap = new Map();
  for (const pr of parsedRows) {
    let g = groupsMap.get(pr.groupValue);
    if (!g) {
      g = { groupValue: pr.groupValue, members: [] };
      groupsMap.set(pr.groupValue, g);
    }
    g.members.push(pr);
  }

  const groups = [];
  // 行键（最终行下标）→ 分摊额文本，供导出按原行序追加
  const allocatedByIndex = new Map();

  for (const g of groupsMap.values()) {
    // 组内成员本就按最终行序追加
    let exactUnits = 0n;
    let floorTotal = 0n;
    for (const m of g.members) {
      m.floorCents = m.units / 100n;
      m.remainder = m.units % 100n; // 不足一分的余数（0～99 个万分之一元）
      exactUnits += m.units;
      floorTotal += m.floorCents;
    }
    // 组总额四舍五入到分（半值向上）
    const roundedCents = (exactUnits + 50n) / 100n;
    // 需要逐分分配的差额（分数）：恒有 0 ≤ D ≤ 行数
    const difference = roundedCents - floorTotal;

    // 余数降序、同余数按最终行序（下标升序）：稳定排序后前 D 行各多得 1 分
    const ranked = g.members
      .map((m) => m)
      .sort((a, b) => {
        if (a.remainder !== b.remainder) return a.remainder < b.remainder ? 1 : -1;
        return a.index - b.index;
      });
    const bonusSet = new Set();
    for (let k = 0; k < Number(difference); k++) bonusSet.add(ranked[k].index);

    const rowsOut = g.members.map((m) => {
      const got = bonusSet.has(m.index);
      const allocatedCents = m.floorCents + (got ? 1n : 0n);
      allocatedByIndex.set(m.index, formatCents(allocatedCents));
      return {
        key: m.key,
        line: m.line,
        amountRaw: m.rawAmount,
        floorText: formatCents(m.floorCents),
        remainder: Number(m.remainder),
        remainderCentsText: formatRemainderCents(m.remainder),
        gotDifference: got,
        allocatedText: formatCents(allocatedCents),
      };
    });

    groups.push({
      groupValue: g.groupValue,
      rowCount: g.members.length,
      exactTotalText: formatYuan10(exactUnits),
      roundedTotalText: formatCents(roundedCents),
      differenceCents: Number(difference),
      // 尾差分配顺序（余数降序、并列按最终行序）对应的最终行号
      allocationOrder: ranked.slice(0, Number(difference)).map((m) => m.line),
      rows: rowsOut,
    });
  }

  // 导出：按原行序逐行追加分摊金额列；无行时只输出新表头（已在上方处理）
  const exportRows = parsedRows.map((pr) =>
    finalRows[pr.index].cells.concat([allocatedByIndex.get(pr.index)]),
  );

  return {
    unresolved: 0,
    unresolvedDetails: [],
    allocation: {
      version: 1,
      generatedAt: new Date().toISOString(),
      keyColumn: model.keyColumn,
      groupColumn,
      amountColumn,
      appendedHeader: APPENDED_HEADER,
      rowCount: parsedRows.length,
      noData: false,
      groups,
    },
    rows: [exportHeader, ...exportRows],
  };
}

module.exports = {
  APPENDED_HEADER,
  AMOUNT_PATTERN,
  parseAmountUnits,
  formatYuan10,
  formatCents,
  formatRemainderCents,
  validateAllocationParams,
  buildAllocation,
};
