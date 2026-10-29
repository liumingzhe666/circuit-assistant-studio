import { readEngineeringQuantities, engineeringNumber } from './engineering.mjs';

// Recompute from serialized BOM values; never trust generated equations or cached results.
export function reviewNumericDesign(plan, requirement) {
  const checks = [];
  const add = (status, title, detail) => checks.push({ status, title, detail });
  const value = (ref, unit) => readEngineeringQuantities((plan.components || []).find(item => item.ref === ref)?.value, unit)[0]?.value;
  const agrees = (a, b, tolerance = 0.001) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * tolerance);
  const expected = plan.parsedSpec || requirement;
  const specs = plan.specs || {};
  if (plan.invalidParameters?.length || requirement.parameterIssues?.length) {
    add('fail', '参数解析有效性', [...(plan.invalidParameters || []), ...(requirement.parameterIssues || [])].join('；'));
  }
  for (const field of ['inputVoltage', 'outputVoltage', 'current', 'frequency']) {
    if (specs[field] != null && (!Number.isFinite(specs[field]) || specs[field] <= 0)) add('fail', '参数数值有效性', `${field} 必须是有限正数，当前值 ${specs[field]}。`);
  }
  if (['buck','boost','ldo'].includes(plan.kind)) {
    for (const field of ['inputVoltage', 'outputVoltage', 'current']) {
      if (expected[field] != null && !agrees(specs[field], expected[field])) add('fail', '需求参数一致性', `${field}：需求 ${expected[field]}，方案 ${specs[field]}。`);
    }
    if (plan.kind === 'ldo' && specs.inputVoltage != null && specs.outputVoltage != null) {
      add(specs.inputVoltage > specs.outputVoltage ? 'pass' : 'fail', 'LDO 压差方向', 'LDO 输入必须高于输出，并进一步核对实际 dropout。');
    }
  }
  if (expected.filterMode === 'highpass' && !/高通/.test(plan.topology)) add(plan.topology ? 'fail' : 'warn', '滤波拓扑匹配', '用户请求高通，需确认实际拓扑。');
  if (expected.filterMode === 'lowpass' && !/低通/.test(plan.topology)) add(plan.topology ? 'fail' : 'warn', '滤波拓扑匹配', '用户请求低通，需确认实际拓扑。');
  if (expected.opampMode === 'inverting' && !/反相/.test(plan.topology)) add(plan.topology ? 'fail' : 'warn', '放大拓扑匹配', '用户请求反相，需确认实际拓扑。');
  if (expected.opampMode === 'noninverting' && !/同相/.test(plan.topology)) add(plan.topology ? 'fail' : 'warn', '放大拓扑匹配', '用户请求同相，需确认实际拓扑。');

  if (plan.kind === 'led-driver') {
    const r = value('R1', 'Ω'), rating = value('R1', 'W');
    const vf = value('D1', 'V');
    const supply = specs.inputVoltage;
    const protectionDrop = plan.designParameters?.protectionDrop;
    if (r > 0 && Number.isFinite(vf) && Number.isFinite(supply) && Number.isFinite(protectionDrop)) {
      const current = (supply - vf - protectionDrop) / r;
      const power = current ** 2 * r;
      add(current > 0 ? 'pass' : 'fail', 'LED 工作点', `按 BOM 反算 LED 电流 ${engineeringNumber(current, 'A')}。`);
      add(Number.isFinite(rating) ? (rating + 1e-12 >= power ? 'pass' : 'fail') : 'warn', '限流电阻额定功率',
        `按 BOM 反算功耗 ${engineeringNumber(power, 'W')}；额定 ${rating == null ? '未注明' : engineeringNumber(rating, 'W')}。`);
      if (Number.isFinite(rating) && rating >= power) add(rating + 1e-12 >= power * 2 ? 'pass' : 'warn', '限流电阻降额', '项目标称负载率策略为 ≤50%；最高环境温度下仍需按器件手册复核。');
      const target = plan.designParameters?.targetCurrent;
      if (target != null) add(current <= target * 1.001 ? 'pass' : 'fail', 'LED 电流上限', `反算 ${engineeringNumber(current, 'A')}，目标上限 ${engineeringNumber(target, 'A')}。`);
      if (plan.designParameters?.actualCurrent != null) add(agrees(current, plan.designParameters.actualCurrent, 0.003) ? 'pass' : 'fail', 'LED 报告电流一致性', '报告电流必须与 BOM 电阻和声明的压降一致。');
    } else add('warn', 'LED 数值校核条件', '缺少可解析的 R1、电源、LED Vf 或保护压降，不能完成独立功耗校核。');
  }
  if (plan.kind === 'rc-filter' || plan.kind === 'timer555') {
    const c = value('C1', 'F');
    const ra = value('RA', 'Ω'), rb = value('RB', 'Ω');
    const r = value('R1', 'Ω');
    const actual = plan.kind === 'rc-filter' ? 1 / (2 * Math.PI * r * c) : 1.44 / ((ra + 2 * rb) * c);
    if (Number.isFinite(actual) && actual > 0 && specs.frequency > 0) {
      add(agrees(actual, specs.frequency, 0.05) ? 'pass' : 'fail', '标称频率独立复算', `BOM 反算 ${engineeringNumber(actual, 'Hz')}，目标 ${engineeringNumber(specs.frequency, 'Hz')}，容许标称偏差 5%。`);
      if (plan.designParameters?.actualFrequency != null) add(agrees(actual, plan.designParameters.actualFrequency) ? 'pass' : 'fail', '频率报告一致性', '报告的实际频率必须由 BOM 计算。');
    } else add('warn', '频率校核条件', '缺少合法定时元件或明确目标频率。');
    if (plan.kind === 'timer555' && expected.duty != null) {
      const actualDuty = (ra + rb) / (ra + 2 * rb);
      add(Math.abs(actualDuty - expected.duty / 100) <= 0.01 ? 'pass' : 'fail', '占空比匹配',
        `BOM 标称占空比 ${(actualDuty * 100).toFixed(3)}%，需求 ${expected.duty}%；未满足时必须另行设计，禁止视为完成。`);
    }
  }
  if (plan.kind === 'opamp') {
    const r1 = value('R1', 'Ω'), r2 = value('R2', 'Ω');
    const inverse = /反相/.test(plan.topology) && !/同相/.test(plan.topology);
    const target = expected.gain == null ? null : inverse ? -Math.abs(expected.gain) : expected.gain;
    if (r1 > 0 && r2 >= 0 && target != null) {
      const actual = inverse ? -r2 / r1 : 1 + r2 / r1;
      add(agrees(actual, target, 0.01) ? 'pass' : 'fail', '闭环增益独立复算', `按 BOM 得 ${actual} 倍，目标 ${target} 倍，容许标称偏差 1%。`);
      if (plan.designParameters?.actualGain != null) add(agrees(actual, plan.designParameters.actualGain) ? 'pass' : 'fail', '增益报告一致性', '报告增益必须与实际反馈电阻比一致。');
    } else if (target != null) add('warn', '增益校核条件', '缺少有效反馈电阻，无法独立验证增益。');
  }
  return checks;
}
