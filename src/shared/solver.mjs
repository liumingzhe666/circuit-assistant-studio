import { readEngineeringQuantities, readEngineeringRanges, engineeringNumber, engineeringIssues } from './engineering.mjs';

const round = (value, digits = 4) => Number(value.toFixed(digits));
const parallel = values => 1 / values.reduce((sum, value) => sum + 1 / value, 0);
const sum = values => values.reduce((a, b) => a + b, 0);

function needs(reason, knowns = []) {
  return { kind: 'needs-ai', title: '需要补充题目条件', knowns, formula: '—',
    steps: [reason, '请明确所求物理量、元件数值和连接关系。'],
    answer: '暂时无法给出可信数值答案', confidence: 0.28, warnings: [reason],
    computed: null, source: '电路助手 · 本地解析求解器' };
}

export function solveCircuitProblem(question) {
  const text = String(question || '').trim();
  const facts = readEngineeringQuantities(text);
  const values = unit => facts.filter((item,index) => item.unit === unit && (!item.name || facts.findIndex(other=>other.name===item.name)===index));
  const rs = values('Ω'), vs = values('V'), cs = values('F'), is = values('A');
  const named = Object.fromEntries(facts.filter(item => item.name).map(item => [item.name, item]));
  const get = (...names) => names.map(name => named[name]?.value).find(value => value != null);
  const knowns = facts.map(item => `${item.name || item.unit} = ${engineeringNumber(item.value, item.unit)}`);
  const issues = engineeringIssues(text);
  if (issues.length) return needs(issues.join('；'), knowns);
  if (readEngineeringRanges(text).length) return needs('题目给定数值范围，当前无法唯一确定标称值；请明确要求某一工况还是最小/最大结果。', knowns);
  const quantityAtLabel = (unit, pattern) => values(unit).find(item =>
    pattern.test(text.slice(0, item.index).split(/[，,。；;\n]/).at(-1)))?.value;
  const finish = (kind, title, formula, steps, label, value, unit, warnings = [], confidence = 0.92) => {
    if (!Number.isFinite(value)) return needs('计算出现非有限值，请检查零分母、单位和条件。', knowns);
    const answer = `${label}${unit === '倍' ? `${round(value)} 倍` : engineeringNumber(value, unit)}`;
    return { kind, title, knowns, formula, steps, answer, confidence, warnings,
      computed: { value, unit, verified: true, method: 'deterministic-formula' },
      source: '电路助手 · 本地解析求解器' };
  };
  for (const fact of facts) {
    if ((fact.unit === 'Ω' && fact.value < 0) || (['F', 'H'].includes(fact.unit) && fact.value <= 0)) {
      return needs('无源元件数值无效：电阻不能为负，电容/电感必须大于零。', knowns);
    }
    if (fact.name && facts.some(other => other.name === fact.name && (other.unit !== fact.unit || other.value !== fact.value))) {
      return needs(`同一变量 ${fact.name} 存在冲突赋值，请确认采用哪个值。`, knowns);
    }
  }
  // Read the requested quantity before dispatching to a formula.
  const requested = text.match(/(?:求(?:出|解)?|计算)\s*([^。；;]*)(?:[。；;]|$)/g)?.at(-1) || '';
  const goal = requested || text;
  if (/(?:电压|电流|功率|电阻|增益|频率)\s*(?:和|及|、|与)\s*(?:总)?(?:电压|电流|功率|电阻|增益|频率)/.test(requested)) return needs('当前题目包含多个所求物理量，请分开提问，以便逐项给出可复核结果。', knowns);
  let target = /功率|功耗|耗散|\bP\b/i.test(goal) ? 'power'
    : /能量|储能/.test(goal) ? 'energy'
      : /时间常数|τ|tau/i.test(goal) ? 'tau'
        : /频率|频点|截止|\bfc\b/i.test(goal) ? 'frequency'
          : /增益|\bAv\b/i.test(goal) ? 'gain'
            : /电流|分流|支路|\bI\b/i.test(goal) ? 'current'
              : /电压|vout|\bV\b|\bU\b/i.test(goal) ? 'voltage'
                : /电阻|阻值|等效|\breq\b|\bR\b/i.test(goal) ? 'resistance' : null;
  if (requested && !target) return needs('当前未识别出所求物理量，请明确电流、电压、电阻、功率、增益、频率或时间常数。', knowns);
  if (!target) {
    if (/串联|并联/.test(text)) target = 'resistance';
    else if (/555|截止|低通|高通|\bRC\b/i.test(text)) target = 'frequency';
    else if (/同相|反相|运放/.test(text)) target = 'gain';
    else if (vs.length && is.length) target = 'power';
    else if (rs.length && vs.length) target = 'current';
    else if (rs.length && is.length) target = 'voltage';
  }
  const voltage = get('VIN', 'VS', 'V', 'U', 'V1') ?? vs[0]?.value;
  const current = get('I', 'I1') ?? is[0]?.value;
  const resistance = get('R') ?? (rs.length === 1 ? rs[0].value : undefined);
  const capacitance = get('C', 'C1') ?? cs[0]?.value;

  if (target === 'resistance' && /LED|限流/i.test(text)) {
    const vf = get('VF') ?? quantityAtLabel('V', /(?:正向)?压降\s*(?:为|是|=|约)?\s*$/i);
    const supply = get('VS', 'VIN', 'V') ?? quantityAtLabel('V', /电源|供电/i) ?? vs.find(item => item.value !== vf)?.value;
    if (vf == null || supply == null || !(current > 0) || !(supply > vf)) return needs('LED 限流需要电源电压、明确的正向压降及正的目标电流，且电源应高于正向压降。', knowns);
    return finish('led-resistor', 'LED 限流电阻计算', 'R = (Vs − Vf) / I',
      [`电阻压降 = ${engineeringNumber(supply - vf, 'V')}`, '按给定 Vf 计算，未用默认压降替代已知量。'],
      '限流电阻 R = ', (supply - vf) / current, 'Ω', ['按 LED 的 Vf 最小值复核最坏电流，并校核电阻功率与温度降额。']);
  }

  if (target === 'resistance' && /串联|并联/.test(text)) {
    if (rs.length < 2) return needs('串并联等效计算至少需要两个明确阻值及连接关系。', knowns);
    const operations = [...text.matchAll(/串联|并联/g)];
    const mixed = operations.some(op => op[0] === '串联') && operations.some(op => op[0] === '并联');
    if (mixed) {
      if (operations.length !== 2) return needs('混联包含多层连接，请用括号或逐组说明串并联关系；当前不能唯一建立网络。', knowns);
      const namesIn = segment => [...new Set([...segment.matchAll(/\bR[A-Za-z0-9]*\b/gi)].map(match => match[0].toUpperCase()))]
        .filter(name => named[name]?.unit === 'Ω');
      const first = operations[0], second = operations[1];
      const between = namesIn(text.slice(first.index + first[0].length, second.index));
      const group2 = between.length ? between : namesIn(text.slice(second.index + second[0].length));
      const group1 = namesIn(text.slice(0, first.index)).filter(name => !group2.includes(name));
      const allNames = new Set(rs.map(item => item.name));
      if (group1.length < 2 || !group2.length || [...allNames].some(name => !group1.includes(name) && !group2.includes(name))) {
        return needs('混联分组不明确，请说明先连接哪些电阻、再与哪些电阻连接。', knowns);
      }
      const firstValues = group1.map(name => named[name].value), secondValues = group2.map(name => named[name].value);
      const parallelFirst = first[0] === '并联';
      const a = parallelFirst ? parallel(firstValues) : sum(firstValues);
      const b = parallelFirst ? sum(secondValues) : parallel(secondValues);
      const result = parallelFirst ? a + b : parallel([a, b]);
      return finish('mixed-network', '电阻混联网络（分组化简）', parallelFirst ? '先并联化简再串联：Req = Rp + R串' : '先串联再并联：Req = R串 ∥ R并',
        [`第一组 ${group1.join('、')}：${engineeringNumber(a, 'Ω')}`, `第二组 ${group2.join('、')}：${engineeringNumber(b, 'Ω')}`, '按明确的两组连接关系合并。'],
        '等效电阻 Req = ', result, 'Ω');
    }
    const parallelOnly = operations[0][0] === '并联';
    return finish(parallelOnly ? 'parallel-resistance' : 'series-resistance', parallelOnly ? '并联电阻等效计算' : '串联电阻等效计算',
      parallelOnly ? '1/Req = 1/R1 + 1/R2 + …' : 'Req = R1 + R2 + …',
      [parallelOnly ? '并联各支路电导相加后取倒数。' : '串联阻值直接相加。'],
      '等效电阻 Req = ', parallelOnly ? (rs.some(item => item.value === 0) ? 0 : parallel(rs.map(item => item.value))) : sum(rs.map(item => item.value)), 'Ω');
  }

  if (target === 'voltage' && /分压|vout/i.test(text)) {
    const r1 = get('R1'), r2 = get('R2');
    if (r1 == null || r2 == null || voltage == null || r1 + r2 <= 0) return needs('分压需要输入电压、上臂 R1 和下臂 R2；只给输出电压无法唯一求出两个阻值。', knowns);
    const loaded = /负载|带载/.test(text);
    const rl = get('RL', 'R3');
    if (loaded && !(rl > 0)) return needs('带载分压必须给出正的负载电阻 RL，不能按空载公式代替。', knowns);
    const lower = loaded ? parallel([r2, rl]) : r2;
    return finish(loaded ? 'loaded-divider' : 'voltage-divider', loaded ? '带载电阻分压' : '电阻分压计算',
      loaded ? 'Vout = Vin × (R2 ∥ RL) / (R1 + R2 ∥ RL)' : 'Vout = Vin × R2 / (R1 + R2)',
      [`下臂等效 ${engineeringNumber(lower, 'Ω')}`, '用具名电阻的角色代入分压比。'],
      loaded ? '带载输出电压 Vout = ' : '输出电压 Vout = ', voltage * lower / (r1 + lower), 'V',
      [loaded ? '负载改变下臂等效阻值，更换负载后须重算。' : '默认输出端为空载；负载会改变分压比。'], 0.94);
  }

  if (target === 'current' && /并联/.test(text) && rs.length >= 2) {
    const targetName = requested.match(/\bR[A-Za-z0-9]*\b/i)?.[0]?.toUpperCase()
      || text.match(/流过\s*(R[A-Za-z0-9]*)/i)?.[1]?.toUpperCase();
    if (/总电流/.test(goal) && voltage != null) return finish('current-divider', '并联总电流', 'I总 = V × Σ(1/R)', ['并联各支路电流相加。'], '总电流 I = ', voltage / parallel(rs.map(item => item.value)), 'A');
    if (!targetName || !(named[targetName]?.value > 0)) return needs('请明确所求支路位号，并提供正的支路电阻。', knowns);
    if (voltage != null) return finish('current-divider', '并联分流计算', 'I支路 = V / R支路（并联各支路电压相同）',
      [`按位号选择 ${targetName}，与书写顺序无关。`], `流过 ${targetName} 的电流 I = `, voltage / named[targetName].value, 'A', ['总电流为各并联支路电流之和。'], 0.9);
    if (current != null) return finish('current-divider', '并联分流计算', 'I支路 = I总 × Req / R支路', ['用各支路电导分配总电流。'],
      `流过 ${targetName} 的电流 I = `, current * parallel(rs.map(item => item.value)) / named[targetName].value, 'A');
    return needs('并联分流需要已知两端电压或总电流。', knowns);
  }

  if (target === 'tau' && resistance != null && capacitance != null) return finish('rc-tau', 'RC 时间常数', 'τ = RC',
    ['电阻与电容先归一到 Ω 和 F，再相乘。'], '时间常数 τ = ', resistance * capacitance, 's', ['一阶网络约在 3τ~5τ 后接近工程稳态。'], 0.93);
  if (target === 'frequency' && /555|无稳态|多谐/.test(text)) {
    const ra = get('RA'), rb = get('RB');
    if (!(ra > 0) || !(rb > 0) || !(capacitance > 0)) return needs('555 无稳态频率需要正的 RA、RB 和定时电容 C。', knowns);
    return finish('timer-555', '555 无稳态振荡频率', 'f ≈ 1.44 / ((RA + 2RB) × C)',
      [`RA + 2RB = ${engineeringNumber(ra + 2 * rb, 'Ω')}`, '按标称 RC 值计算。'], '振荡频率 f ≈ ',
      1.44 / ((ra + 2 * rb) * capacitance), 'Hz', ['器件容差和阈值离散会导致实际频率偏差；本值为公式计算。'], 0.9);
  }
  if (target === 'frequency' && /RC|截止|滤波|低通|高通/i.test(text) && resistance > 0 && capacitance > 0) {
    return finish('rc-cutoff', 'RC 一阶截止频率', 'fc = 1 / (2πRC)', ['按无源一阶网络、轻负载假设计算。'],
      '截止频率 fc ≈ ', 1 / (2 * Math.PI * resistance * capacitance), 'Hz', ['需另外核对信号源和负载阻抗。'], 0.93);
  }
  if (target === 'gain' && /运放|同相|反相/.test(text)) {
    const inverse = /反相/.test(text) && !/同相/.test(text);
    const rf = get('RF', 'R2');
    const rg = inverse ? get('RIN', 'R1') : get('RG', 'R1');
    if (!(rg > 0) || rf == null) return needs('请给出反馈电阻 Rf/R2 与输入或下臂电阻 Rin/Rg/R1。', knowns);
    return finish(inverse ? 'opamp-inverting' : 'opamp-gain', inverse ? '反相运放闭环增益' : '同相运放闭环增益',
      inverse ? 'Av = −Rf / Rin' : 'Av = 1 + Rf/Rg', ['按电阻角色计算反馈比，不按出现顺序取值。'],
      '闭环增益 Av = ', inverse ? -rf / rg : 1 + rf / rg, '倍', ['需核对 GBW、压摆率、共模范围、输出摆幅和相位裕度。'], 0.9);
  }
  if (target === 'energy' && capacitance > 0 && voltage != null) return finish('capacitor-energy', '电容储能计算', 'E = ½CV²',
    ['先换算电容为 F，再将电压平方。'], '储存能量 E ≈ ', 0.5 * capacitance * voltage ** 2, 'J', ['实际可用能量取决于放电截止电压、ESR 与耐压裕量。']);
  if (target === 'power') {
    if (voltage != null && current != null) return finish('power', '直流功率计算', 'P = VI', ['只计算用户要求的功率，并核对量纲。'], '功率 P = ', voltage * current, 'W');
    if (current != null && resistance != null) return finish('power-i2r', '电阻功耗计算（I²R）', 'P = I² × R', ['电流平方乘电阻。'], '功率 P = ', current ** 2 * resistance, 'W', ['按持续功耗与环境温度选择额定功率及降额。'], 0.93);
    if (voltage != null && resistance > 0) return finish('power-v2r', '电阻功耗计算（V²/R）', 'P = V² / R', ['电阻两端电压平方除以电阻。'], '功率 P = ', voltage ** 2 / resistance, 'W');
  }
  if (target === 'resistance' && voltage != null && current != null && current !== 0) return finish('ohms-law', '欧姆定律求电阻', 'R = V / I', ['按所求物理量重排欧姆定律。'], '电阻 R = ', voltage / current, 'Ω');
  if (target === 'current' && voltage != null && resistance > 0) return finish('ohms-law', '欧姆定律求电流', 'I = V/R', ['电压除以电阻，结果单位为 A。'], '电流 I = ', voltage / resistance, 'A');
  if (target === 'voltage' && current != null && resistance != null) return finish('ohms-law', '欧姆定律求电压', 'V = IR', ['电流乘电阻，结果单位为 V。'], '电压 V = ', current * resistance, 'V');
  return needs('已知量不足、连接关系不明或题型尚未支持，不能唯一计算所求物理量。', knowns);
}
