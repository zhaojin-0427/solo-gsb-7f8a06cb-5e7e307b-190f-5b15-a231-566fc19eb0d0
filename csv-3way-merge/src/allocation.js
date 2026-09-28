'use strict';

/**
 * 合并金额尾差分摊（merged-amount remainder allocation）。
 *
 * 冲突全部裁决后，本模块按本轮保存的模型与当前裁决算出最终保留行（与 CSV 导出、
 * 来源账本、层级核验、导入顺序、键变更核对、最小决定列发现共用 merge.js 中的
 * resolveRowProvenance，行序与逐格取值完全一致），回答一个问题：**按分组列精确
 * 求和后四舍五入到分，与逐行向下取整到分之和的尾差，应该补给哪些行？**
 *
 * 规则：
 *  - 用户选择两个互异列：分组列与金额列（均可为唯一键列之外/之内的任意表头列，
 *    两列本身不能相同）；
 *  - 分组按分组列单元格的**原字符串**精确比较（不裁剪空白、不做归一化），
 *    空字符串 "" 也可自成一组；
 *  - 金额以**元**计，只接受非负、无指数、最多四位小数的十进制字符串
 *    （/^\d{1,18}(\.\d{1,4})?$/，整数部分最多 18 位，纯 "0" 合法）；
 *    空值（空字符串）或任何非法值都会指出其**最终 CSV 行号**并拒绝整次计算
 *    （不给出任何分组与分摊结果）；
 *  - 各组用整数运算（BigInt，单位 1/10000 元）精确求和，组总额四舍五入到分
 *    （0.005 元即 50 个 1/10000 元进位）；
 *  - 每行金额先向下取整到分，再把差额（组总额（分） − 各行取整（分）之和）
 *    按**原金额不足一分的余数降序**逐分分配，同余数时按**最终 CSV 行序**
 *    （升序）分配——每行至多补 1 分；
 *  - 页面展示每组总额（精确求和值与四舍五入到分值）与逐行分摊额，
 *    导出 CSV 按原行序追加 "分摊金额" 列（原表头已有同名列时明确报错）。
 *
 * 分摊只读：不改变任何数据、裁决与原合并 CSV；有未决冲突时不产出结论。
 */

const { resolveRowProvenance } = require('./merge');

/** 导出追加列名（原表头已有同名列时明确报错，不做覆盖或自动改名） */
const ALLOCATION_COLUMN = '分摊金额';

/** 金额整数部分最大位数（18 位，已远超任何现实金额；用 BigInt 精确运算） */
const AMOUNT_INTEGER_MAX = 18;

/** 合法金额：非负、无指数、无符号、无空白，最多四位小数（禁止 "1." / ".5" / "01" 之外的宽松形态） */
const AMOUNT_RE = new RegExp(`^\\d{1,${AMOUNT_INTEGER_MAX}}(?:\\.\\d{1,4})?$`);

/**
 * 校验分摊参数：分组列与金额列都必须给出、存在于表头，且两列互异。
 * 唯一键列可以作为分组列或金额列，不在此限制。
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
    return '分组列与金额列必须是不同的列';
  }
  return null;
}

/**
 * 原表头是否已含追加列 "分摊金额"：含有时整个功能必须明确报错，
 * 不允许覆盖已有列或自动改名追加。
 */
function hasAllocationColumn(model) {
  return model.headers.includes(ALLOCATION_COLUMN);
}

/**
 * 解析金额字符串为整数单位（1/10000 元）。
 * 合法形态：非负十进制、无指数 / 符号 / 空白、最多四位小数、整数部分 ≤ 18 位。
 * @returns {{ ok: true, units: bigint, text: string } | { ok: false, reason: 'empty'|'invalid' }}
 */
function parseAmount(raw) {
  const text = raw == null ? '' : String(raw);
  if (text === '') return { ok: false, reason: 'empty' };
  if (!AMOUNT_RE.test(text)) return { ok: false, reason: 'invalid' };
  const [intPart, fracPart = ''] = text.split('.');
  const fracPadded = (fracPart + '0000').slice(0, 4);
  return { ok: true, units: BigInt(intPart + fracPadded), text };
}

/**
 * 把 1/10000 元单位的非负 BigInt 格式化为十进制字符串（去掉小数末尾多余的 0，
 * 整元不带小数点）。
 */
function formatUnits(units) {
  const s = units.toString();
  const intPart = s.slice(0, -4) || '0';
  const frac = s.slice(-4).padStart(4, '0').replace(/0+$/, '');
  return frac ? `${intPart}.${frac}` : intPart;
}

/** 把分（非负整数 BigInt）格式化为两位小数字符串（元），如 12005n → "120.05" */
function formatCents(cents) {
  const s = cents.toString().padStart(3, '0');
  return `${s.slice(0, -2)}.${s.slice(-2)}`;
}

/**
 * 四舍五入到分：(units + 50) / 100 向下取整（单位 1/10000 元；
 * 0.005 元即 50 个单位进位，为标准 half-up）。
 */
function roundUnitsToCents(units) {
  return (units + 50n) / 100n;
}

/**
 * 计算金额尾差分摊。
 *
 * @param {object} model 服务端本轮保存的合并模型（buildMerge 的输出）
 * @param {object} decisions 已规范化的冲突裁决
 * @param {string} groupColumn 分组列名（调用前需先经 validateAllocationParams 校验）
 * @param {string} amountColumn 金额列名（同上）
 * @returns {{
 *   unresolved: number, unresolvedDetails: string[],
 *   amountErrors?: Array<{line:number, value:string, kind:'empty'|'invalid', message:string}>,
 *   result?: object,
 * }}
 *   有未决冲突时只返回 unresolved / unresolvedDetails（不给出结论）；
 *   存在空值 / 非法金额时返回 amountErrors（每行一项，按最终行序，拒绝整次计算）；
 *   否则 result 为完整分摊结果（无保留行时 groupCount=0、groups=[]）。
 */
function buildAllocation(model, decisions, groupColumn, amountColumn) {
  const headers = model.headers;
  const groupIdx = headers.indexOf(groupColumn);
  const amountIdx = headers.indexOf(amountColumn);

  // 最终保留行：与 CSV 导出、来源账本等同一套 resolveRowProvenance
  const finalRows = [];
  const unresolvedDetails = [];
  for (const row of model.rows) {
    const res = resolveRowProvenance(row, decisions, headers);
    for (const msg of res.unresolved) unresolvedDetails.push(`键 "${row.key}"：${msg}`);
    if (!res.deleted) {
      finalRows.push({
        key: res.key,
        cells: res.cells,
        finalIndex: finalRows.length,
      });
    }
  }
  if (unresolvedDetails.length > 0) {
    return { unresolved: unresolvedDetails.length, unresolvedDetails };
  }

  // 金额校验：任一空值 / 非法值都指出最终 CSV 物理行号并拒绝整次计算
  const amountErrors = [];
  const cellAt = (r, i) => {
    const v = r.cells[i];
    return v == null ? '' : String(v);
  };
  for (const r of finalRows) {
    const raw = cellAt(r, amountIdx);
    const parsed = parseAmount(raw);
    if (parsed.ok) {
      r.amountText = parsed.text;
      r.amountUnits = parsed.units;
    } else {
      const line = r.finalIndex + 2; // 最终 CSV 物理行号（表头为第 1 行，首行数据为第 2 行）
      if (parsed.reason === 'empty') {
        amountErrors.push({
          line,
          value: '',
          kind: 'empty',
          message: `第 ${line} 行：金额列 "${amountColumn}" 为空，无法进行尾差分摊`,
        });
      } else {
        const shown = raw.length > 20 ? `${raw.slice(0, 20)}…` : raw;
        amountErrors.push({
          line,
          value: raw,
          kind: 'invalid',
          message:
            `第 ${line} 行：金额 "${shown}" 不合法——金额以元计，只接受非负、无指数、` +
            `最多四位小数的十进制数字（整数部分最多 ${AMOUNT_INTEGER_MAX} 位），无法进行尾差分摊`,
        });
      }
    }
  }
  if (amountErrors.length > 0) {
    return { unresolved: 0, unresolvedDetails: [], amountErrors };
  }

  // 按分组列原字符串分组（Map 保持组的首次出现顺序；空字符串 "" 也可成组）
  const groups = new Map();
  for (const r of finalRows) {
    const g = cellAt(r, groupIdx);
    let list = groups.get(g);
    if (!list) {
      list = [];
      groups.set(g, list);
    }
    list.push(r);
  }

  const resultGroups = [];
  for (const [groupValue, members] of groups) {
    // 精确求和（BigInt，单位 1/10000 元）
    let sumUnits = 0n;
    for (const m of members) sumUnits += m.amountUnits;
    const totalCents = roundUnitsToCents(sumUnits);

    // 每行先向下取整到分，并保留不足一分的余数（0..99 个 1/10000 元）
    let floorCentsSum = 0n;
    for (const m of members) {
      m.floorCents = m.amountUnits / 100n;
      m.remainder = Number(m.amountUnits % 100n);
      floorCentsSum += m.floorCents;
    }

    // 差额（分）：总额四舍五入 − 各行向下取整之和；数学上 0 ≤ diff ≤ 组数内成员数，
    // 且不超过余数为正的行数，因此每行至多补 1 分。
    const diff = Number(totalCents - floorCentsSum);

    // 逐分分配：余数降序，同余数按最终行序（finalIndex）升序——
    // 排序稳定，前 diff 名各补 1 分（diff=0 时不产生补分）。
    const ranked = members
      .slice()
      .sort((a, b) =>
        b.remainder !== a.remainder
          ? b.remainder - a.remainder
          : a.finalIndex - b.finalIndex,
      );
    const extraSet = new Set();
    for (let t = 0; t < diff; t++) extraSet.add(ranked[t].finalIndex);

    const rows = members.map((m) => {
      const extra = extraSet.has(m.finalIndex);
      const allocatedCents = m.floorCents + (extra ? 1n : 0n);
      return {
        key: m.key,
        line: m.finalIndex + 2,
        groupValue,
        amount: m.amountText,
        floorAmount: formatCents(m.floorCents),
        remainder: m.remainder,
        remainderText: formatRemainder(m.remainder),
        extraCent: extra,
        allocated: formatCents(allocatedCents),
      };
    });

    const allocatedTotal = rows.reduce((acc, r) => acc + Number(r.extraCent), 0);
    resultGroups.push({
      groupValue,
      rowCount: members.length,
      sumExact: formatUnits(sumUnits),
      totalRounded: formatCents(totalCents),
      floorTotal: formatCents(floorCentsSum),
      diffCents: diff,
      allocatedExtraCount: allocatedTotal,
      rows,
    });
  }

  const result = {
    version: 1,
    generatedAt: new Date().toISOString(),
    keyColumn: model.keyColumn,
    groupColumn,
    amountColumn,
    allocationColumn: ALLOCATION_COLUMN,
    rowCount: finalRows.length,
    groupCount: resultGroups.length,
    groups: resultGroups,
  };
  return { unresolved: 0, unresolvedDetails: [], result };
}

/**
 * 余数文案：余数单位为 1/10000 元（0..99），即不足一分的部分；
 * 显示为"分"的两位小数（如 60 → "0.60 分"，即原金额分位之后还余 0.60 分）。
 */
function formatRemainder(remainder) {
  const s = String(remainder).padStart(2, '0');
  return `${s.slice(0, -2).padStart(1, '0')}.${s.slice(-2)} 分`;
}

/**
 * 生成分摊导出 CSV 的数据行（不含 BOM，由调用方与其它导出一致地添加）：
 * 沿用基准表头与原单元格值（与 /api/export 逐格一致），按原行序追加 "分摊金额" 列。
 * 无保留行时只输出新表头一行。
 * @param {object} model 服务端本轮保存的合并模型
 * @param {object} result buildAllocation 返回的 result
 * @param {string[][]} finalCells 最终保留行的单元格（最终 CSV 行序，resolveAll 的输出）
 * @returns {string[][]}
 */
function buildAllocationRows(model, result, finalCells) {
  // 最终键在结果中唯一（上传阶段已校验键列非空、文件内不重复），按键映射回分摊额
  const byKey = new Map();
  for (const g of result.groups) for (const r of g.rows) byKey.set(r.key, r);
  const header = [...model.headers, ALLOCATION_COLUMN];
  const rows = finalCells.map((cells) => {
    const key = cells[model.keyIndex];
    const alloc = byKey.get(key);
    return [...cells, alloc ? alloc.allocated : ''];
  });
  return [header, ...rows];
}

module.exports = {
  ALLOCATION_COLUMN,
  AMOUNT_INTEGER_MAX,
  validateAllocationParams,
  hasAllocationColumn,
  parseAmount,
  formatUnits,
  formatCents,
  buildAllocation,
  buildAllocationRows,
};
