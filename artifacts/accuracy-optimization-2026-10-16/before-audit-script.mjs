// Supplemental diagnostics only: independent numeric oracles, no changes to the rule engine.
// Run: node scripts/run-accuracy-audit.mjs
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { generateCircuit, reviseCircuit, parseRequirement, solveCircuitProblem, supervisePlan } from '../src/shared/core.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'artifacts', 'accuracy-audit-2026-10-16');
const knowledge = [
  ...JSON.parse(await readFile(path.join(root, 'knowledge/basic-circuits.json'), 'utf8')),
  ...JSON.parse(await readFile(path.join(root, 'knowledge/advanced-circuits.json'), 'utf8')),
];
const scale = { '': 1, k: 1e3, M: 1e6, m: 1e-3, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, n: 1e-9, p: 1e-12 };
const numberPattern = '(-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)';
function quantity(text, unit) {
  const match = String(text).match(new RegExp(`${numberPattern}\\s*([kMmunpµμ]?)\\s*${unit}(?![A-Za-z])`));
  return match ? Number(match[1]) * scale[match[2]] : null;
}
function answerNumber(answer) {
  const match = String(answer).match(new RegExp(`[=≈]\\s*${numberPattern}\\s*([kMmunpµμ]?)\\s*(Ω|V|A|F|Hz|s|W|J|倍)(?![A-Za-z])`));
  return match ? { value: Number(match[1]) * scale[match[2]], unit: match[3] } : null;
}
assert.equal(quantity('1 MΩ', 'Ω'), 1e6);
assert.ok(Math.abs(quantity('100 nF', 'F') - 1e-7) < 1e-20);
assert.equal(quantity('330 Ω / 1% / 0.1 W', 'W'), 0.1);
assert.equal(answerNumber('电流 I = 5 µA').unit, 'A');
assert.ok(Math.abs(answerNumber('电流 I = 5 µA').value - 0.000005) < 1e-18);
assert.equal(answerNumber('暂时无法给出可信数值答案'), null);

const check = (name, actual, expected) => ({ name, actual, expected, pass: actual === expected });
const near = (name, actual, expected, relativeTolerance = 0.001, absoluteTolerance = 1e-9) => ({
  name, actual, expected, relativeTolerance, absoluteTolerance,
  pass: Number.isFinite(actual) && Math.abs(actual - expected) <= Math.max(absoluteTolerance, Math.abs(expected) * relativeTolerance),
});
const results = [];
function run(category, family, input, expected, execute) {
  const result = { id: `A${String(results.length + 1).padStart(3, '0')}`, category, family, input, expected };
  try {
    Object.assign(result, execute());
    result.pass = result.checks.every(item => item.pass);
  } catch (error) {
    result.pass = false;
    result.error = error.stack || String(error);
    result.checks = [];
  }
  results.push(result);
}
const design = requirement => generateCircuit(requirement, knowledge);
const component = (plan, ref, unit) => quantity(plan.components.find(item => item.ref === ref)?.value, unit);
const snapshot = plan => ({
  kind: plan.kind, title: plan.title, topology: plan.topology, specs: plan.specs,
  components: plan.components, equations: plan.equations,
  missingParameters: plan.missingParameters, warnings: plan.warnings,
});

// Explicit input/output roles must survive word order. Same six targets, three phrasings.
const powers = [
  ['buck', 'Buck 降压', 18, 3.3, 0.3], ['buck', 'Buck 降压', 24, 9, 0.75],
  ['boost', 'Boost 升压', 3.3, 9, 0.15], ['boost', 'Boost 升压', 9, 18, 0.4],
  ['ldo', 'LDO 线性稳压', 5, 2.5, 0.08], ['ldo', 'LDO 线性稳压', 9, 5, 0.1],
];
for (const [kind, label, vin, vout, current] of powers) {
  for (const input of [
    `设计 ${label} 电源，输入 ${vin}V，输出 ${vout}V，负载电流 ${current}A。`,
    `设计 ${label} 电源，输出 ${vout}V，输入 ${vin}V，负载电流 ${current}A。`,
    `设计 ${label} 电源，负载电流 ${current * 1000}mA，输入 ${vin}伏，输出 ${vout}伏。`,
  ]) run('requirement', kind, input, { kind, vin, vout, current }, () => {
    const plan = design(input);
    return { actual: snapshot(plan), checks: [check('topology', plan.kind, kind),
      near('inputVoltage', plan.specs.inputVoltage, vin), near('outputVoltage', plan.specs.outputVoltage, vout),
      near('current', plan.specs.current, current)] };
  });
}

// Recompute nominal behavior from the BOM, rather than trusting the displayed target.
for (const frequency of [7, 33, 170, 470, 1500, 7500, 15000, 33000, 68000]) {
  const input = `设计截止频率 ${frequency}Hz 的 RC 低通滤波器`;
  run('design-numeric', 'rc-cutoff', input, { frequency, tolerance: '5% nominal' }, () => {
    const plan = design(input);
    const achieved = 1 / (2 * Math.PI * component(plan, 'R1', 'Ω') * component(plan, 'C1', 'F'));
    return { actual: { ...snapshot(plan), achievedFrequency: achieved }, checks: [near('cutoff from BOM', achieved, frequency, 0.05)] };
  });
}
for (const frequency of [3, 17, 75, 120, 330, 2200, 7300, 15000, 47000, 120000]) {
  const input = `设计 ${frequency}Hz 的 555 无稳态方波振荡器`;
  run('design-numeric', 'timer-555', input, { frequency, tolerance: '5% nominal' }, () => {
    const plan = design(input);
    const achieved = 1.44 / ((component(plan, 'RA', 'Ω') + 2 * component(plan, 'RB', 'Ω')) * component(plan, 'C1', 'F'));
    return { actual: { ...snapshot(plan), achievedFrequency: achieved }, checks: [near('frequency from BOM', achieved, frequency, 0.05)] };
  });
}
for (const voltage of [5, 9, 12, 24]) for (const milliamps of [5, 10, 20]) {
  const input = `设计 ${voltage}V 供电、目标电流 ${milliamps}mA 的红色 LED 指示灯`;
  run('design-numeric', 'led-current-and-power', input,
    { voltage, targetCurrent: milliamps / 1000, ledVf: 2, diodeDrop: 0.3, powerCriterion: 'BOM resistor rating >= nominal dissipation' }, () => {
      const plan = design(input);
      const resistor = component(plan, 'R1', 'Ω');
      const current = (voltage - 2 - 0.3) / resistor;
      const power = current * current * resistor;
      const rating = component(plan, 'R1', 'W');
      return { actual: { ...snapshot(plan), recomputedCurrent: current, resistorPower: power, resistorRating: rating }, checks: [
        check('positive resistor', resistor > 0, true), check('positive LED current', current > 0, true),
        check('does not exceed target current', current <= milliamps / 1000, true),
        near('reported current agrees with BOM', plan.designParameters.actualCurrent, current, 0.002, 0.000006),
        check('resistor power rating sufficient', Number.isFinite(rating) && rating >= power, true),
      ] };
    });
}
for (const gain of [1, 1.05, 1.1, 2, 4.5, 17, 101]) {
  const input = `设计同相运放放大器，增益 ${gain} 倍，供电 5V`;
  run('design-numeric', 'opamp-gain', input, { gain, tolerance: '1% nominal' }, () => {
    const plan = design(input);
    const achieved = 1 + component(plan, 'R2', 'Ω') / component(plan, 'R1', 'Ω');
    return { actual: { ...snapshot(plan), achievedGain: achieved }, checks: [near('gain from BOM', achieved, gain, 0.01)] };
  });
}

function solverCase(category, family, question, value, unit, oracle) {
  run(category, family, question, { value, unit, oracle, tolerance: '0.1% or 1e-9 absolute' }, () => {
    const actual = solveCircuitProblem(question);
    const number = answerNumber(actual.answer);
    return { actual, disposition: actual.kind === 'needs-ai' ? 'declined' : 'answered', checks: [
      check('answer dimension', number?.unit ?? null, unit), near('answer value', number?.value ?? null, value),
    ] };
  });
}
for (const [r1, r2, r3, vin, milliamps, cNano] of [[120, 180, 390, 9, 15, 47], [2200, 4700, 6800, 18, 7, 220]]) {
  const parallel = 1 / (1 / r1 + 1 / r2);
  solverCase('solver-numeric', 'series', `R1=${r1}Ω，R2=${r2}Ω 串联，求等效电阻`, r1 + r2, 'Ω', 'R1 + R2');
  solverCase('solver-numeric', 'parallel', `R1=${r1}Ω，R2=${r2}Ω 并联，求等效电阻`, parallel, 'Ω', '1 / (1/R1 + 1/R2)');
  solverCase('solver-numeric', 'divider', `Vin=${vin}V，R1=${r1}Ω，R2=${r2}Ω，求分压 Vout`, vin * r2 / (r1 + r2), 'V', 'Vin * R2 / (R1 + R2)');
  const loadedLower = 1 / (1 / r2 + 1 / r3);
  solverCase('solver-numeric', 'loaded-divider', `Vin=${vin}V，R1=${r1}Ω，R2=${r2}Ω，负载 RL=${r3}Ω，求带载分压 Vout`, vin * loadedLower / (r1 + loadedLower), 'V', 'Vin * (R2 || RL) / (R1 + (R2 || RL))');
  solverCase('solver-numeric', 'mixed-parallel-first', `R1=${r1}Ω，R2=${r2}Ω，R3=${r3}Ω，R1与R2并联后与R3串联，求等效电阻`, parallel + r3, 'Ω', '(R1 || R2) + R3');
  solverCase('solver-numeric', 'mixed-series-first', `R1=${r1}Ω，R2=${r2}Ω，R3=${r3}Ω，R1与R2串联后再与R3并联，求等效电阻`, 1 / (1 / (r1 + r2) + 1 / r3), 'Ω', '(R1 + R2) || R3');
  solverCase('solver-numeric', 'led', `LED 电源 Vs=${vin}V，Vf=3V，电流 I=${milliamps}mA，求限流电阻`, (vin - 3) / (milliamps / 1000), 'Ω', '(Vs - Vf) / I');
  solverCase('solver-numeric', 'tau', `RC 电路 R=${r1}Ω，C=${cNano}nF，求时间常数`, r1 * cNano * 1e-9, 's', 'R * C');
  solverCase('solver-numeric', 'rc-cutoff', `RC 低通 R=${r1}Ω，C=${cNano}nF，求截止频率`, 1 / (2 * Math.PI * r1 * cNano * 1e-9), 'Hz', '1 / (2*pi*R*C)');
  solverCase('solver-numeric', 'i2r-power', `I=${milliamps}mA，R=${r1}Ω，求电阻功率`, (milliamps / 1000) ** 2 * r1, 'W', 'I^2 * R');
  solverCase('solver-numeric', 'timer', `555 无稳态 RA=${r1}Ω，RB=${r2}Ω，C=${cNano}nF，求振荡频率`, 1.44 / ((r1 + 2 * r2) * cNano * 1e-9), 'Hz', '1.44 / ((RA + 2*RB) * C)');
  solverCase('solver-numeric', 'inverting-opamp', `反相运放 Rin=${r1}Ω，Rf=${r2}Ω，求增益`, -r2 / r1, '倍', '-Rf / Rin');
  solverCase('solver-numeric', 'noninverting-opamp', `同相运放 R1=${r1}Ω，R2=${r2}Ω，求增益`, 1 + r2 / r1, '倍', '1 + R2 / R1');
  solverCase('solver-numeric', 'energy', `电容 C=${cNano}nF，充电到 ${vin}V，求储能`, 0.5 * cNano * 1e-9 * vin ** 2, 'J', '0.5 * C * V^2');
  solverCase('solver-numeric', 'branch-current', `R1=${r1}Ω，R2=${r2}Ω 并联，Vin=${vin}V，求流过 R2 的电流`, vin / r2, 'A', 'Vin / R2');
  solverCase('solver-numeric', 'ohm-current', `V=${vin}V，R=${r1}Ω，求电流`, vin / r1, 'A', 'V / R');
  solverCase('solver-numeric', 'ohm-voltage', `I=${milliamps}mA，R=${r1}Ω，求电压`, milliamps / 1000 * r1, 'V', 'I * R');
  solverCase('solver-numeric', 'vi-power', `V=${vin}V，I=${milliamps}mA，求直流功率`, vin * milliamps / 1000, 'W', 'V * I');
}

// Targeted probes of word order, target selection, and equivalent wording.
for (const [family, question, value, unit, oracle] of [
  ['led-prose', '电源 9V，LED 正向压降 3V，电流 15mA，求限流电阻', 400, 'Ω', '(9 - 3) / 0.015'],
  ['led-upper-unit', 'LED Vs=9V，Vf=3V，I=15mA，求限流电阻', 400, 'Ω', '(9 - 3) / 0.015'],
  ['led-lower-unit', 'LED Vs=9v，Vf=3v，I=15ma，求限流电阻', 400, 'Ω', '(9 - 3) / 0.015'],
  ['divider-reordered', 'Vin=9V，分压下臂 R2=1800Ω，上臂 R1=1200Ω，求 Vout', 5.4, 'V', '9 * 1800 / (1200 + 1800)'],
  ['opamp-named-resistors', '同相运放，Rf=47kΩ，Rg=10kΩ，求增益', 5.7, '倍', '1 + 47000 / 10000'],
  ['opamp-reordered', '同相运放，反馈上臂 R2=47kΩ，下臂 R1=10kΩ，求增益', 5.7, '倍', '1 + 47000 / 10000'],
  ['mixed-prose-series', 'R1=120Ω，R2=180Ω 串联，再与 R3=300Ω 并联，求等效电阻', 150, 'Ω', '(120 + 180) || 300'],
  ['mixed-prose-parallel', 'R1=120Ω，R2=180Ω 先并联，然后串联 R3=390Ω，求等效电阻', 462, 'Ω', '(120 || 180) + 390'],
  ['branch-target', 'R1=120Ω，R2=180Ω 并联，Vin=9V，求 R2 的支路电流', 0.05, 'A', '9 / 180'],
  ['ohm-prose', '电压为 9V，电阻为 3kΩ，求电流', 0.003, 'A', '9 / 3000'],
  ['power-target', 'V=9V，R=3kΩ，求电阻消耗的功率', 0.027, 'W', '9^2 / 3000'],
  ['resistance-target', 'V=9V，I=3mA，求电阻', 3000, 'Ω', '9 / 0.003'],
]) solverCase('expression', family, question, value, unit, oracle);

for (const [base, request, expected] of [
  ['18V 输入转 9V 输出的 Buck 降压电源，电流 0.3A', '输出改为 3.3V', { kind: 'buck', inputVoltage: 18, outputVoltage: 3.3 }],
  ['18V 输入转 9V 输出的 Buck 降压电源，电流 0.3A', '输入改为 24V，输出改为 5V', { kind: 'buck', inputVoltage: 24, outputVoltage: 5 }],
  ['18V 输入转 9V 输出的 Buck 降压电源，电流 0.3A', '输出改为 5V，输入改为 24V', { kind: 'buck', inputVoltage: 24, outputVoltage: 5 }],
  ['3.3V 输入转 9V 输出的 Boost 升压电源，电流 0.15A', '输入改为 5V，输出改为 15V', { kind: 'boost', inputVoltage: 5, outputVoltage: 15 }],
  ['5V 输入转 2.5V 输出的 LDO，电流 0.08A', '输入改为 9V，输出改为 3.3V', { kind: 'ldo', inputVoltage: 9, outputVoltage: 3.3 }],
  ['5V 红色 LED 指示灯，电流 10mA', '改为 9V，换成白色 LED，去掉开关', { kind: 'led-driver', inputVoltage: 9, ledColor: '白色', includeSwitch: false }],
  ['5V 红色 LED 指示灯，电流 10mA', '电流改为 5mA', { kind: 'led-driver', targetCurrent: 0.005 }],
  ['同相运放增益 4 倍，供电 5V', '增益改为 17 倍', { kind: 'opamp', gain: 17 }],
  ['170Hz RC 低通滤波器', '截止频率改为 1500Hz', { kind: 'rc-filter', frequency: 1500 }],
  ['12V 双电机小车，3.3V MCU 控制', '电机堵转电流改为 3A', { kind: 'motor-driver', stallCurrent: 3 }],
]) run('revision', expected.kind, { base, request }, expected, () => {
  const plan = reviseCircuit(design(base), request, knowledge);
  const actual = { kind: plan.kind, ...plan.specs, ...plan.designParameters };
  return { actual: { ...snapshot(plan), designParameters: plan.designParameters },
    checks: Object.entries(expected).map(([key, value]) => typeof value === 'number' ? near(key, actual[key], value) : check(key, actual[key], value)) };
});

// Contract here is the project's own numeric risk threshold: >=60 V or >=10 A.
for (const [input, highRisk] of [
  ['59V 输入，12V 输出，持续电流 9.9A 的 Buck 降压电源', false],
  ['60V 输入，12V 输出，持续电流 1A 的 Buck 降压电源', true],
  ['12V 输入，5V 输出，持续电流 10A 的 Buck 降压电源', true],
  ['60伏输入，12伏输出，持续电流 1安的降压电源', true],
  ['12V 输入，5V 输出，持续电流 10000mA 的 Buck 降压电源', true],
  ['60000mV 直流输入，12V 输出，持续电流 1A 的 Buck 降压电源', true],
  ['0.06kV 直流输入，12V 输出，持续电流 1A 的 Buck 降压电源', true],
  ['48V 输入，12V 输出，持续电流 2e1A 的 Buck 降压电源', true],
  ['230VAC 输入，12V 输出，1A 的整流电源', true],
  ['110V 交流输入，12V 输出，1A 的整流电源', true],
  ['单节锂离子电池 4.2V 升压到 9V，输出 0.1A', true],
  ['24V 输入，12V 输出，持续电流 9.99A 的 Buck 降压电源', false],
]) run('risk', 'numeric-threshold-and-units', input, { highRisk, mustBlock: highRisk }, () => {
  const parsed = parseRequirement(input);
  const plan = design(input);
  const audit = supervisePlan(plan, input);
  const checks = [check('risk classification', parsed.highRisk, highRisk)];
  if (highRisk) checks.push(check('engineering review blocks', audit.decision, '阻断投板'));
  return { actual: { parsed, decision: audit.decision, nonPassingChecks: audit.checks.filter(item => item.status !== 'pass') }, checks };
});

// A requested topology must be implemented or explicitly declined; echoing the request does not count.
for (const frequency of [80, 2200]) {
  const input = `设计 ${frequency}Hz RC 高通滤波器`;
  run('intent', 'highpass', input, { topology: 'highpass or explicit unsupported warning' }, () => {
    const plan = design(input);
    const supported = /高通/.test(plan.topology) && !/低通/.test(plan.topology);
    const declined = (plan.warnings || []).some(text => /高通/.test(text) && /不支持|无法|不能/.test(text));
    return { actual: snapshot(plan), checks: [check('faithful topology or explicit refusal', supported || declined, true)] };
  });
}
for (const gain of [5, 12]) {
  const input = `设计反相运放放大器，增益 ${gain} 倍，供电 5V`;
  run('intent', 'inverting-amplifier', input, { topology: 'inverting or explicit unsupported warning' }, () => {
    const plan = design(input);
    const supported = /反相/.test(plan.topology) && !/同相/.test(plan.topology);
    const declined = (plan.warnings || []).some(text => /反相/.test(text) && /不支持|无法|不能/.test(text));
    return { actual: snapshot(plan), checks: [check('faithful topology or explicit refusal', supported || declined, true)] };
  });
}
for (const duty of [25, 50]) {
  const input = `设计 2200Hz 的 555 方波振荡器，占空比 ${duty}%`;
  run('intent', 'timer-duty', input, { duty: duty / 100, tolerance: 'one percentage point' }, () => {
    const plan = design(input);
    const ra = component(plan, 'RA', 'Ω'), rb = component(plan, 'RB', 'Ω');
    const achievedDuty = (ra + rb) / (ra + 2 * rb);
    const declined = (plan.warnings || []).some(text => /占空比/.test(text) && /不支持|无法|不能/.test(text));
    return { actual: { ...snapshot(plan), achievedDuty }, checks: [check('duty met or explicit refusal', Math.abs(achievedDuty - duty / 100) <= 0.01 || declined, true)] };
  });
}

const summaries = key => {
  const groups = {};
  for (const result of results) {
    const group = groups[result[key]] ??= { passed: 0, total: 0, failed: 0 };
    group.total++;
    if (result.pass) group.passed++; else group.failed++;
  }
  for (const group of Object.values(groups)) group.passRate = group.passed / group.total;
  return groups;
};
const sourceFiles = ['src/shared/core.mjs', 'src/shared/layout-agent.mjs', 'knowledge/basic-circuits.json', 'knowledge/advanced-circuits.json', 'scripts/run-accuracy-audit.mjs'];
const hashes = {};
for (const file of sourceFiles) hashes[file] = createHash('sha256').update(await readFile(path.join(root, file))).digest('hex');
const report = {
  format: 'circuit-assistant-supplemental-accuracy-audit-v1', generatedAt: new Date().toISOString(),
  version: JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version,
  runtime: { node: process.version, platform: process.platform, architecture: process.arch },
  scope: 'Local deterministic core plus bundled knowledge; no AI service, SPICE, hardware or image-recognition testing.',
  methodology: 'Manually constructed diagnostic cases and fixed parameter grids; exploratory findings informed targeted probes. Not a random sample or independent blind benchmark. No engine changes were made. Each case passes only when all its checks pass.',
  tolerances: { solver: '0.1% or 1e-9 absolute, with correct physical unit', rcAnd555Design: '5% nominal frequency from BOM; no component tolerance included', opampDesign: '1% nominal gain from BOM', ledDesign: 'positive current <= target; reported current within rounding tolerance; BOM resistor rating >= nominal power (no extra derating)' },
  total: results.length, passed: results.filter(item => item.pass).length,
  failed: results.filter(item => !item.pass).length,
  byCategory: summaries('category'), byFamily: summaries('family'),
  solverDisposition: {
    answered: results.filter(item => item.disposition === 'answered').length,
    correctlyAnswered: results.filter(item => item.disposition === 'answered' && item.pass).length,
    incorrectlyAnswered: results.filter(item => item.disposition === 'answered' && !item.pass).length,
    declined: results.filter(item => item.disposition === 'declined').length,
  },
  hashes, results,
};
report.passRate = report.passed / report.total;
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`Supplemental diagnostics: ${report.passed}/${report.total} (${(100 * report.passRate).toFixed(1)}%)`);
for (const [name, value] of Object.entries(report.byCategory)) console.log(`${name}: ${value.passed}/${value.total} (${(100 * value.passRate).toFixed(1)}%)`);
console.log(`Report: ${path.join(output, 'report.json')}`);
process.exitCode = report.failed ? 1 : 0;
