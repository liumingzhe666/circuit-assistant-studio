// One SI parser for requirements, solvers, BOMs and review. Prefix case is significant.
export const NUMBER_SOURCE = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:[eE][+-]?\\d+)?';
const PREFIX_SOURCE = '(?:[mM][eE][gG]|[GMkKmµμunp])?';
const UNIT_SOURCE = '微伏|毫伏|千伏|伏特|伏|毫安|微安|安培|安|兆赫兹|千赫兹|赫兹|兆赫|千赫|毫法|微法|纳法|皮法|法拉|法|毫亨|微亨|纳亨|亨利|亨|毫欧姆|微欧姆|千欧姆|兆欧姆|毫欧|微欧|千欧|兆欧|欧姆|欧|毫瓦|瓦特|瓦|毫秒|微秒|纳秒|秒|焦耳|Ω|[oO][hH][mM][sS]?|[vV](?:[aA][cC]|[dD][cC])?|[aA](?:[aA][cC]|[dD][cC])?|[hH][zZ]|[fF]|[hH]|[wW]|[sS]|[jJ]';
const CANONICAL = { v: 'V', vac: 'V', vdc: 'V', a: 'A', aac: 'A', adc: 'A', hz: 'Hz', f: 'F', h: 'H', w: 'W', s: 's', j: 'J', ohm: 'Ω', ohms: 'Ω', 'ω': 'Ω' };
const CHINESE = {
  '毫伏': ['V', 1e-3], '千伏': ['V', 1e3], '伏特': ['V', 1], '伏': ['V', 1],
  '毫安': ['A', 1e-3], '微安': ['A', 1e-6], '安培': ['A', 1], '安': ['A', 1],
  '兆赫兹': ['Hz', 1e6], '兆赫': ['Hz', 1e6], '千赫兹': ['Hz', 1e3], '千赫': ['Hz', 1e3], '赫兹': ['Hz', 1],
  '微法': ['F', 1e-6], '纳法': ['F', 1e-9], '皮法': ['F', 1e-12], '法拉': ['F', 1], '法': ['F', 1],
  '毫亨': ['H', 1e-3], '微亨': ['H', 1e-6], '亨利': ['H', 1], '亨': ['H', 1],
  '千欧姆': ['Ω', 1e3], '兆欧姆': ['Ω', 1e6], '欧姆': ['Ω', 1], '欧': ['Ω', 1],
  '毫瓦': ['W', 1e-3], '瓦特': ['W', 1], '瓦': ['W', 1],
  '毫秒': ['s', 1e-3], '微秒': ['s', 1e-6], '纳秒': ['s', 1e-9], '秒': ['s', 1], '焦耳': ['J', 1],
  '毫欧姆': ['Ω', 1e-3], '毫欧': ['Ω', 1e-3], '微欧姆': ['Ω', 1e-6], '微欧': ['Ω', 1e-6],
  '千欧': ['Ω', 1e3], '兆欧': ['Ω', 1e6], '微伏': ['V', 1e-6], '毫法': ['F', 1e-3], '纳亨': ['H', 1e-9],
};
const PREFIXES = { '': 1, G: 1e9, M: 1e6, k: 1e3, K: 1e3, m: 1e-3, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, n: 1e-9, p: 1e-12 };
const canonicalUnit = unit => CHINESE[unit]?.[0] || CANONICAL[String(unit).toLowerCase()] || unit;
const prefixFactor = prefix => /^meg$/i.test(prefix) ? 1e6 : PREFIXES[prefix];

export function readEngineeringQuantities(text, expectedUnit = '') {
  const input = String(text || '');
  const pattern = new RegExp(`(${NUMBER_SOURCE})\\s*(${PREFIX_SOURCE})\\s*(${UNIT_SOURCE})(?![A-Za-zΩ])`, 'g');
  const results = [];
  for (const match of input.matchAll(pattern)) {
    const [, number, prefix = '', rawUnit] = match;
    // Permit adjacent complete quantities (5V1A), but never suffixes of identifiers/invalid numbers.
    const previous = input[match.index - 1] || '';
    const rangeEnd = number.startsWith('-') && /\d/.test(previous);
    if (/[A-Za-z0-9_.]/.test(previous) && results.at(-1)?.end !== match.index && !rangeEnd) continue;
    const unit = canonicalUnit(rawUnit);
    if (expectedUnit && unit !== canonicalUnit(expectedUnit)) continue;
    const value = Number(rangeEnd ? number.slice(1) : number) * prefixFactor(prefix) * (CHINESE[rawUnit]?.[1] ?? 1);
    if (!Number.isFinite(value)) continue;
    const before = input.slice(0, match.index);
    const name = before.match(/\b([A-Za-z][A-Za-z0-9]{0,7})\s*(?:=|为|是|:|：)\s*$/)?.[1]
      || before.match(/\b((?:R|C|L|V|U|I|P)(?:[A-Za-z]{0,3}|\d+))\s+$/i)?.[1];
    results.push({ value, unit, raw: match[0], index: match.index, end: match.index + match[0].length,
      name: name?.toUpperCase() || null, ac: /ac$/i.test(rawUnit) || /交流\s*$/.test(before.slice(-8)) });
  }
  return results;
}

export function engineeringIssues(text) {
  const input = String(text || ''), quantities = readEngineeringQuantities(input);
  const issues = [];
  const candidate = new RegExp(`(?<![A-Za-z0-9_.])${NUMBER_SOURCE}\\s*[A-Za-zµμΩ]{1,10}`, 'g');
  for (const match of input.matchAll(candidate)) {
    if (/(?:[vVaAfFhHwWΩ]|[hH][zZ]|[oO][hH][mM])$/.test(match[0]) && !quantities.some(item => item.index <= match.index && item.end >= match.index + match[0].length)) {
      issues.push(`无法可靠解析参数 ${match[0]}，请补充合法数值及单位。`);
    }
  }
  for (const item of quantities) {
    const required = /^R(?:\d*|F|G|IN|L)$/.test(item.name || '') ? 'Ω'
      : /^C\d*$/.test(item.name || '') ? 'F'
        : /^(?:V|U)(?:\d*|IN|OUT|S|F)$/.test(item.name || '') ? 'V'
          : /^I\d*$/.test(item.name || '') ? 'A' : null;
    if (required && required !== item.unit) issues.push(`${item.name} 的单位应为 ${required}，当前为 ${item.unit}。`);
  }
  return issues;
}

export function readEngineeringRanges(text) {
  const input=String(text || '');
  const pattern=new RegExp(`(?<![A-Za-z0-9_.])(${NUMBER_SOURCE})\\s*(?:-|–|~|～|至|到)\\s*(${NUMBER_SOURCE})\\s*(${PREFIX_SOURCE})\\s*(${UNIT_SOURCE})(?![A-Za-zΩ])`,'g');
  return [...input.matchAll(pattern)].map(match=>{
    const factor=prefixFactor(match[3] || '')*(CHINESE[match[4]]?.[1] ?? 1);
    return {min:Number(match[1])*factor,max:Number(match[2])*factor,unit:canonicalUnit(match[4]),raw:match[0],index:match.index,end:match.index+match[0].length};
  });
}

export function parseEngineeringValue(raw, expectedUnit = '') {
  const text = String(raw ?? '').trim();
  const parsed = readEngineeringQuantities(text, expectedUnit)[0];
  if (parsed) return parsed;
  // A bare number is allowed only with an explicitly supplied unit, or without any suffix.
  const match = text.match(new RegExp(`^(${NUMBER_SOURCE})\\s*(${PREFIX_SOURCE})$`));
  if (!match) return null;
  const value = Number(match[1]) * prefixFactor(match[2] || '');
  return Number.isFinite(value) ? { value, unit: canonicalUnit(expectedUnit), raw: text } : null;
}

export function engineeringNumber(value, unit = '') {
  if (!Number.isFinite(value)) return '待确认';
  value = Number(value.toPrecision(14));
  if (value === 0) return `0 ${unit}`.trim();
  const abs = Math.abs(value);
  const options = unit === 'Ω' ? [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, '']]
    : unit === 'F' ? [[1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']]
      : [[1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''], [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p']];
  const selected = options.find(([factor]) => abs >= factor) || options.at(-1);
  return `${Number((value / selected[0]).toFixed(4))} ${selected[1]}${unit}`.trim();
}

// Explicit role labels take precedence over occurrence order. Keep unspecified roles null.
export function voltageRoles(text, quantities = readEngineeringQuantities(text, 'V')) {
  const assigned = { inputVoltage: null, outputVoltage: null };
  const roles = [];
  let consumedSuffixEnd = 0;
  const roleName = label => /输出|vout/i.test(label) ? 'outputVoltage' : 'inputVoltage';
  quantities.forEach((quantity, index) => {
    const before = text.slice(Math.max(quantities[index - 1]?.end ?? 0, consumedSuffixEnd), quantity.index).split(/[，,。；;\n]/).at(-1);
    const after = text.slice(quantity.end, quantities[index + 1]?.index ?? text.length).split(/[，,。；;\n]/)[0];
    const prefix = before.match(/(输入(?:电压)?|输出(?:电压)?|供电(?:电压)?|电源(?:电压)?|vin|vout)\s*(?:改为|改成|调整为|调整到|设置为|设为|为|是|到|=|:|：)?\s*$/i);
    const suffix = after.match(/^\s*(?:直流|交流)?\s*(输入|输出|供电)/)
      || after.match(/^\s*\d+(?:\.\d+)?\s*(?:mA|A|毫安|安)\s*(输出)/i);
    const named = quantity.name && /^(?:VIN|VOUT)$/.test(quantity.name) ? quantity.name : null;
    const label = prefix?.[1] || named || suffix?.[1];
    if (!prefix && !named && suffix) consumedSuffixEnd = quantity.end + suffix.index + suffix[0].length;
    const role = label ? roleName(label) : null;
    roles.push(role);
    if (role) assigned[role] = quantity.value;
  });
  const unassigned = quantities.filter((_, index) => !roles[index]);
  if (assigned.inputVoltage == null && unassigned.length) assigned.inputVoltage = unassigned.shift().value;
  if (assigned.outputVoltage == null && unassigned.length) assigned.outputVoltage = unassigned.shift().value;
  return { ...assigned, explicitInput: roles.includes('inputVoltage'), explicitOutput: roles.includes('outputVoltage') };
}
