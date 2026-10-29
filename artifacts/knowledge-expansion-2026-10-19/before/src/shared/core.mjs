import { optimizeSchematicLayout } from './layout-agent.mjs';
import { readEngineeringQuantities, readEngineeringRanges, voltageRoles, engineeringNumber, engineeringIssues, NUMBER_SOURCE } from './engineering.mjs';
import { reviewNumericDesign } from './design-review.mjs';
export { parseEngineeringValue } from './engineering.mjs';
export { solveCircuitProblem } from './solver.mjs';

const RISK_WORDS = /市电|高压|锂电|锂离子|大电流|电击|逆变/i;

const hasAny = (text, words) => words.some((word) => text.includes(word));
const round = (value, digits = 2) => Number(Number(value).toFixed(digits));
const unique = (items) => [...new Set((items || []).filter(Boolean))];

export function calculateEditorDragPosition({
  originX = 0,
  originY = 0,
  startX = 0,
  startY = 0,
  currentX = 0,
  currentY = 0,
  grid = 10,
  minX = 30,
  maxX = 970,
  minY = 35,
  maxY = 645,
} = {}) {
  const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || 0));
  const step = Math.max(1, Number(grid) || 10);
  const x = clamp(Number(originX) + Number(currentX) - Number(startX), minX, maxX);
  const y = clamp(Number(originY) + Number(currentY) - Number(startY), minY, maxY);
  return {
    x: round(x, 3),
    y: round(y, 3),
    snappedX: clamp(Math.round(x / step) * step, minX, maxX),
    snappedY: clamp(Math.round(y / step) * step, minY, maxY),
  };
}

export function parseRequirement(input) {
  const text = String(input || '').trim();
  const lower = text.toLowerCase();
  const quantities = readEngineeringQuantities(text);
  const parameterRanges = readEngineeringRanges(text);
  const voltageQuantities = quantities.filter(item => item.unit === 'V');
  const currentQuantities = quantities.filter(item => item.unit === 'A');
  const voltages = voltageQuantities.map(item => item.value);
  const currents = currentQuantities.map(item => item.value);
  const frequencies = quantities.filter(item => item.unit === 'Hz').map(item => item.value);
  const signalQuantities = voltageQuantities.filter(item => /(?:输入信号|输出信号|信号幅度|信号范围|共模范围)[^，,。；;]{0,20}$/.test(text.slice(0,item.index))
    || /^\s*(?:输入信号|输出信号|信号幅度)/.test(text.slice(item.end)));
  const powerQuantities = voltageQuantities.filter(item => !signalQuantities.includes(item));
  const roles = voltageRoles(text, powerQuantities);
  const contextual = (items, label) => items.find(item => {
    const index = items.indexOf(item);
    const before = text.slice(items[index - 1]?.end ?? 0, item.index).split(/[，,。；;\n]/).at(-1);
    const after = text.slice(item.end, items[index + 1]?.index ?? text.length).split(/[，,。；;\n]/)[0];
    return new RegExp(`(?:${label})[^\\d]{0,8}$`, 'i').test(before) || new RegExp(`^[^\\d]{0,8}(?:${label})`, 'i').test(after);
  })?.value ?? null;
  const gainMatch = lower.match(new RegExp(`(?:增益|放大)\\s*(?:改为|改成|为|到|约|=)?\\s*(${NUMBER_SOURCE})\\s*(?:倍|x)?`, 'i'));
  const dutyMatch = lower.match(new RegExp(`占空比\\s*(?:改为|改成|为|约|=)?\\s*(${NUMBER_SOURCE})\\s*%`, 'i'));
  const motorCountMatch = lower.match(/(\d+)\s*(?:路|个|台)?\s*(?:有刷|直流)?电机/i);
  const explicitMotorVoltage = contextual(voltageQuantities, '电机|马达|动力|母线');
  const explicitControlVoltage = contextual(voltageQuantities, '单片机|mcu|gpio|控制|逻辑');
  const stallCurrent = contextual(currentQuantities, '堵转|启动|峰值');

  let kind = 'generic';
  if (hasAny(lower, ['小车', '机器人车', '双电机', '双路电机', '正反转', 'h桥', 'h-bridge', '直流电机驱动', 'motor driver'])) kind = 'motor-driver';
  else if (hasAny(lower, ['升压', 'boost'])) kind = 'boost';
  else if (hasAny(lower, ['降压', 'buck', 'dc-dc', 'dcdc'])) kind = 'buck';
  else if (hasAny(lower, ['线性稳压', 'ldo'])) kind = 'ldo';
  else if (hasAny(lower, ['运放', '放大器', '放大'])) kind = 'opamp';
  else if (hasAny(lower, ['555', '方波', '振荡', '时钟'])) kind = 'timer555';
  else if (hasAny(lower, ['整流', '交流转直流', 'ac-dc', '桥堆'])) kind = 'rectifier';
  else if (hasAny(lower, ['继电器', '电机', '马达', 'mosfet', '电磁阀', '低边驱动', '舵机', '步进', '伺服', '风扇'])) kind = 'low-side-driver';
  else if (hasAny(lower, ['led', '发光二极管', '恒流', '灯泡', '点亮', '指示灯', '小灯', '照明'])) kind = 'led-driver';
  else if (hasAny(lower, ['单片机', 'mcu', 'esp32', 'stm32', '数字电路'])) kind = 'mcu-power';
  else if (hasAny(lower, ['滤波', '低通', '高通'])) kind = 'rc-filter';
  const explicitKind = kind !== 'generic';

  const mcuContext = hasAny(lower, ['单片机', 'mcu', 'esp32', 'stm32']);
  const supplyContext = /(?:给|为).{0,12}(?:供电|取电|电源)|(?:供电|取电).{0,8}(?:给|用于)/.test(lower);
  const powerKind = roles.inputVoltage > roles.outputVoltage ? 'buck' : roles.inputVoltage < roles.outputVoltage ? 'boost' : 'ldo';
  // 多电源域（≥3 个电压）：单一拓扑无法覆盖，按主电源方向选拓扑并强制走确认门禁。
  if (powerQuantities.length >= 3 && !['opamp','rc-filter','timer555','motor-driver'].includes(kind)) {
    kind = powerKind;
  } else if (voltages.length >= 2 && supplyContext && !mcuContext
    && ['generic', 'low-side-driver', 'led-driver'].includes(kind)) {
    // “给 X 供电”语境：执行器/负载关键词让位于电源拓扑（如“给电机驱动供电”）。
    kind = powerKind;
  }

  if (kind === 'generic' && voltages.length >= 2 && voltages.length < 3) {
    kind = powerKind;
  }

  const controlVoltage = explicitControlVoltage ?? (kind === 'motor-driver' && voltages.length > 1 ? Math.min(...voltages) : null);
  const motorCandidates = kind === 'motor-driver' ? voltages.filter((value) => controlVoltage == null || value !== controlVoltage) : [];
  const motorVoltage = explicitMotorVoltage ?? (motorCandidates.length ? Math.max(...motorCandidates) : null);
  const parameterIssues = quantities.filter(item => ['V','A','Hz'].includes(item.unit) && item.value <= 0 && !signalQuantities.includes(item))
    .map(item => `参数 ${item.raw} 必须为正值；请确认工作电源、负载或目标频率。`);
  parameterIssues.push(...engineeringIssues(text));
  parameterIssues.push(...parameterRanges.filter(item => !Number.isFinite(item.min) || !Number.isFinite(item.max) || item.min > item.max).map(item=>`范围 ${item.raw} 非法，请确认上下限。`));

  // 高风险判定：显式关键词 + 数值门禁（≥60V 直流 / 持续 ≥10A）。
  const riskCategories = ['市电', '高压', '锂电', '大电流', '电击', '逆变'].filter((word) => lower.includes(word));
  if ([...voltages,...parameterRanges.filter(item=>item.unit==='V').flatMap(item=>[item.min,item.max])].some((value) => Math.abs(value) >= 60) && !riskCategories.includes('高压')) riskCategories.push('高压');
  if ([...currents,...parameterRanges.filter(item=>item.unit==='A').flatMap(item=>[item.min,item.max])].some((value) => Math.abs(value) >= 10) && !riskCategories.includes('大电流')) riskCategories.push('大电流');
  const highRisk = RISK_WORDS.test(lower) || riskCategories.length > 0;

  return {
    text,
    lower,
    kind,
    explicitKind,
    explicitInputVoltage: roles.explicitInput,
    explicitOutputVoltage: roles.explicitOutput,
    inputVoltage: roles.inputVoltage,
    outputVoltage: roles.outputVoltage,
    signalVoltages: signalQuantities.map(item => item.value),
    current: contextual(currentQuantities, '持续|最大负载|目标|工作') ?? currents[0] ?? null,
    frequency: frequencies[0] ?? null,
    gain: gainMatch ? Number(gainMatch[1]) : null,
    duty: dutyMatch ? Number(dutyMatch[1]) : null,
    filterMode: /高通/.test(lower) ? 'highpass' : /低通/.test(lower) ? 'lowpass' : null,
    opampMode: /反相/.test(lower) && !/同相/.test(lower) ? 'inverting' : /同相/.test(lower) ? 'noninverting' : null,
    parameterIssues,
    parameterRanges,
    motorVoltage,
    controlVoltage,
    motorCount: motorCountMatch ? Math.max(1, Number(motorCountMatch[1])) : kind === 'motor-driver' ? 2 : null,
    stallCurrent,
    multiRail: new Set(powerQuantities.map(item => item.value)).size >= 3,
    bidirectional: kind === 'motor-driver' || hasAny(lower, ['正反转', '双向', 'h桥', 'h-bridge']),
    pwmControl: hasAny(lower, ['pwm', '调速', '速度控制', '变速']),
    batteryPowered: hasAny(lower, ['电池', '锂电', '电池组', 'battery']),
    ledColor: hasAny(lower, ['白色', '白光']) ? '白色' : hasAny(lower, ['蓝色', '蓝光']) ? '蓝色' : hasAny(lower, ['绿色', '绿光']) ? '绿色' : hasAny(lower, ['黄色', '黄光']) ? '黄色' : hasAny(lower, ['红色', '红光']) ? '红色' : null,
    includeSwitch: /(?:去掉|取消|不要|无需|不需要).{0,5}(?:开关|按钮)/i.test(lower) ? false : hasAny(lower, ['开关', '按钮', '按键']) ? true : null,
    highRisk,
    riskCategories,
  };
}

function terminal(ref, value, x, y) { return { type: 'terminal', ref, value, x, y }; }
function part(type, ref, value, x, y, rotate = 0) { return { type, ref, value, x, y, rotate }; }
function wire(...points) { return { points }; }

function selectE24Up(value) {
  const e24 = [10,11,12,13,15,16,18,20,22,24,27,30,33,36,39,43,47,51,56,62,68,75,82,91];
  const target = Math.max(1, Number(value) || 1);
  const decade = 10 ** Math.floor(Math.log10(target) - 1);
  for (const preferred of e24) {
    const candidate = preferred * decade;
    if (candidate >= target) return Math.round(candidate * 1000) / 1000;
  }
  return 100 * decade;
}

function preferredNeighbours(value) {
  const decade = 10 ** Math.floor(Math.log10(value));
  return [0.1, 1, 10].flatMap(scale => [1,1.1,1.2,1.3,1.5,1.6,1.8,2,2.2,2.4,2.7,3,3.3,3.6,3.9,4.3,4.7,5.1,5.6,6.2,6.8,7.5,8.2,9.1]
    .map(mantissa => Number((mantissa * decade * scale).toPrecision(10))))
    .sort((a, b) => Math.abs(a - value) - Math.abs(b - value)).slice(0, 2);
}
const TIMING_CAPACITORS = [-12,-11,-10,-9,-8,-7,-6,-5].flatMap(exponent => [1,1.5,2.2,3.3,4.7,6.8].map(value => value * 10 ** exponent));

function selectTimingValues(frequency, duty = null) {
  const candidates = [];
  for (const c of TIMING_CAPACITORS) {
    if (duty == null) {
      for (const r of preferredNeighbours(1 / (2 * Math.PI * frequency * c))) {
        if (r < 100 || r > 1e6) continue;
        const achieved = 1 / (2 * Math.PI * r * c);
        candidates.push({ r, c, achieved, score: Math.abs(achieved / frequency - 1) + Math.abs(Math.log10(r / 1e4)) * 1e-5 });
      }
    } else {
      const total = 1.44 / (frequency * c);
      for (const ra of preferredNeighbours(total * (2 * duty - 1))) for (const rb of preferredNeighbours(total * (1 - duty))) {
        if (Math.min(ra, rb) < 1e3 || Math.max(ra, rb) > 1e6) continue;
        const achieved = 1.44 / ((ra + 2 * rb) * c);
        const achievedDuty = (ra + rb) / (ra + 2 * rb);
        candidates.push({ ra, rb, c, achieved, achievedDuty,
          score: Math.abs(achieved / frequency - 1) + 4 * Math.abs(achievedDuty - duty) + Math.abs(Math.log10(rb / 1e4)) * 1e-5 });
      }
    }
  }
  return candidates.sort((a, b) => a.score - b.score)[0] || null;
}

function commonPlan(spec, values) {
  const plan = {
    id: `${spec.kind}-${Date.now()}`,
    kind: spec.kind,
    requirement: spec.text,
    source: '电路助手 · 本地规则核心',
    confidence: values.confidence,
    title: values.title,
    function: values.function,
    topology: values.topology,
    specs: {
      inputVoltage: values.resolvedSpecs?.inputVoltage ?? spec.inputVoltage,
      outputVoltage: values.resolvedSpecs?.outputVoltage ?? spec.outputVoltage,
      current: values.resolvedSpecs?.current ?? spec.current,
      frequency: values.resolvedSpecs?.frequency ?? spec.frequency,
      gain: values.resolvedSpecs?.gain ?? spec.gain,
    },
    parsedSpec: structuredClone(spec),
    revisionNumber: values.revisionNumber || 1,
    revisionHistory: values.revisionHistory || [],
    designBasis: values.designBasis || [],
    designParameters: values.designParameters || {},
    intentSummary: values.intentSummary || '',
    parameterCompleteness: values.parameterCompleteness ?? 0,
    missingParameters: values.missingParameters || [],
    clarifyingQuestions: values.clarifyingQuestions || [],
    engineeringChecks: values.engineeringChecks || [],
    verificationPlan: values.verificationPlan || [],
    knowledgeEvidence: values.knowledgeEvidence || [],
    assumptions: values.assumptions || [],
    components: values.components,
    connections: values.connections,
    schematic: optimizeSchematicLayout(values.schematic, { kind: spec.kind }),
    equations: values.equations || [],
    pcbTips: values.pcbTips || [],
    warnings: values.warnings || [],
    nextSteps: values.nextSteps || [],
    createdAt: new Date().toISOString(),
  };
  return plan;
}

function makeBuck(spec) {
  const vin = spec.inputVoltage ?? 12;
  const vout = spec.outputVoltage ?? 5;
  const current = spec.current ?? 1;
  const duty = vin > 0 ? Math.min(vout / vin, 0.95) : 0.42;
  const inductance = Math.max(10, Math.round((vin - vout) * duty / (0.3 * current * 500_000) * 1e6));
  return commonPlan(spec, {
    confidence: spec.inputVoltage && spec.outputVoltage ? 0.88 : 0.68,
    title: `${vin} V → ${vout} V 降压电源草案`,
    function: `将直流输入降压为 ${vout} V，目标负载电流约 ${current} A。`,
    topology: '同步 Buck 降压转换器',
    assumptions: ['默认开关频率 500 kHz', '电感纹波电流按输出电流的 30% 估算', '具体芯片需按输入范围和热条件选型'],
    components: [
      { ref: 'U1', value: 'Buck 控制器/集成转换器', role: '闭环降压', footprint: '按选型器件' },
      { ref: 'L1', value: `${inductance} µH 初估`, role: '储能与输出滤波', footprint: '屏蔽功率电感' },
      { ref: 'CIN1', value: '22 µF + 100 nF', role: '输入去耦', footprint: '0805 + 0603' },
      { ref: 'COUT1', value: '2 × 22 µF', role: '输出滤波', footprint: '0805/1206' },
      { ref: 'RFB1/RFB2', value: '按芯片 VREF 计算', role: '输出反馈', footprint: '0603 1%' },
    ],
    connections: [
      'VIN → CIN1 → U1.VIN', 'U1.SW → L1 → VOUT', 'VOUT → COUT1 → GND',
      'VOUT → RFB1/RFB2 → U1.FB', '所有功率地在 U1 裸露焊盘附近低阻汇接',
    ],
    schematic: {
      components: [terminal('J1', 'VIN', 62, 112), { ...part('ic', 'U1', 'BUCK', 170, 112), feedbackPin: true }, part('inductor', 'L1', `${inductance}µH`, 286, 112), terminal('J2', 'VOUT', 498, 112), part('capacitor', 'COUT', '44µF', 390, 176), part('ground', 'GND', '', 390, 240), part('capacitor', 'CIN', '22µF', 92, 176), part('ground', 'GND', '', 92, 240), part('resistor', 'RFB1', '设定', 356, 260, 90), part('resistor', 'RFB2', '设定', 356, 350, 90), part('ground', 'GND', '', 356, 410)],
      wires: [wire([62,112],[100,112],[100,100],[113,100]), wire([227,100],[237,100],[237,112],[247,112]), wire([325,112],[498,112]), wire([390,112],[390,146]), wire([390,206],[390,230]), wire([92,112],[92,146]), wire([92,206],[92,230]), wire([430,112],[430,210],[356,210],[356,221]), wire([356,299],[356,311]), wire([356,305],[285,305],[285,154],[194,154]), wire([356,389],[356,400])],
    },
    equations: [`理想占空比 D ≈ Vout / Vin = ${round(duty, 3)}`, `输出功率 Pout ≈ ${round(vout * current)} W`, `电感初估约 ${inductance} µH（最终按芯片数据手册复算）`],
    pcbTips: ['最小化 VIN–高边开关–GND 的高 di/dt 热环路', 'CIN 紧贴 VIN/PGND 引脚，SW 铜皮短且远离 FB', '反馈分压从输出电容正端 Kelvin 取样', '预留热过孔并按最大结温核算铜面积'],
    verificationPlan: [
      '断电检查：核对输入极性、VM–GND 阻抗与控制接口默认电平',
      '限流上电：空载验证输出电压、纹波与软启动，再逐步加载',
      '负载阶跃：最小/最大输入电压下观察过冲与恢复时间',
      '温升与纹波实测达标后再进入 PCB 阶段',
    ],
    warnings: vin <= vout ? ['输入电压不高于输出电压，Buck 拓扑不成立，应改用升降压。'] : [],
    nextSteps: ['确定输入最小/最大电压与瞬态', '按效率和温升选定实际芯片', '用厂商模型仿真环路与负载阶跃', '完成 ERC 后再转 PCB'],
  });
}

function makeBoost(spec) {
  const vin = spec.inputVoltage ?? 5;
  const vout = spec.outputVoltage ?? 12;
  const current = spec.current ?? 0.5;
  return commonPlan(spec, {
    confidence: spec.inputVoltage && spec.outputVoltage ? 0.86 : 0.65,
    title: `${vin} V → ${vout} V 升压电源草案`,
    function: `将直流输入升压至 ${vout} V，目标输出电流约 ${current} A。`,
    topology: '非隔离 Boost 升压转换器',
    assumptions: ['默认连续导通模式', '占空比未计开关和二极管损耗', '峰值电流需结合效率和输入最低电压复算'],
    components: [
      { ref: 'U1', value: 'Boost 控制器', role: '开关调节', footprint: '按选型器件' },
      { ref: 'L1', value: '10–22 µH 初选', role: '输入储能', footprint: '屏蔽功率电感' },
      { ref: 'D1', value: '肖特基/同步整流', role: '输出整流', footprint: '按峰值电流' },
      { ref: 'COUT1', value: '47 µF + 100 nF', role: '输出滤波', footprint: '低 ESR' },
      { ref: 'RFB1/RFB2', value: '按 VREF 计算', role: '反馈采样', footprint: '0603 1%' },
    ],
    connections: ['VIN → L1 → SW 节点', 'SW → D1 → VOUT', 'U1 开关管：SW → GND', 'VOUT → COUT1 → GND', 'VOUT 分压后送 U1.FB'],
    schematic: {
      components: [terminal('J1','VIN',55,112), part('inductor','L1','10–22µH',150,112), part('diode','D1','Schottky',300,112), terminal('J2','VOUT',490,112), {...part('ic','U1','BOOST',222,220),powerPins:true}, part('capacitor','COUT','47µF',400,180), part('ground','GND','',400,245), part('ground','GND','',222,295)],
      wires: [wire([55,112],[111,112]),wire([189,112],[263,112]),wire([337,112],[490,112]),wire([222,112],[222,178]),wire([400,112],[400,150]),wire([400,210],[400,235]),wire([222,262],[222,285])],
    },
    equations: [`理想占空比 D ≈ 1 − Vin/Vout = ${round(1 - vin / vout, 3)}`, `输出功率约 ${round(vout * current)} W`],
    pcbTips: ['SW 节点面积尽量小', '输入电感、电流检测和开关管构成功率回路应紧凑', '输出二极管与电容贴近 SW/PGND', 'FB 远离电感和 SW 节点'],
    warnings: vin >= vout ? ['输入电压不低于输出电压，Boost 可能无法稳压，应改用 Buck-Boost。'] : [],
    nextSteps: ['补充输入最低电压和效率目标', '核算电感饱和电流与开关峰值电流', '核算输出纹波与二极管反向耐压'],
  });
}

function makeLdo(spec) {
  const vin = spec.inputVoltage ?? 5;
  const vout = spec.outputVoltage ?? 3.3;
  const current = spec.current ?? 0.2;
  const loss = Math.max(0, (vin - vout) * current);
  return commonPlan(spec, {
    confidence: 0.8,
    title: `${vin} V → ${vout} V 低噪声线性电源`,
    function: '用 LDO 获得低纹波、低器件数的稳压输出。',
    topology: '低压差线性稳压器',
    assumptions: ['默认输入始终高于输出加 dropout', '电容值须满足器件稳定性要求'],
    components: [{ ref:'U1', value:'低噪声 LDO', role:'线性稳压', footprint:'SOT-23-5/DFN' },{ ref:'CIN1', value:'1–10 µF', role:'输入去耦', footprint:'0603/0805' },{ ref:'COUT1', value:'4.7–10 µF', role:'输出稳定', footprint:'0603/0805' }],
    connections: ['VIN → CIN1/U1.IN', 'U1.OUT → COUT1/VOUT', 'U1.GND、输入输出电容地就近接地'],
    schematic:{components:[terminal('J1','VIN',60,130),part('capacitor','CIN','4.7µF',110,200),{...part('ic','U1','LDO',240,130),powerPins:true},part('capacitor','COUT','10µF',380,200),terminal('J2','VOUT',490,130),part('ground','GND','',110,270),part('ground','GND','',380,270),part('ground','GND','',240,270)],wires:[wire([60,130],[170,130],[170,118],[183,118]),wire([297,118],[310,118],[310,130],[490,130]),wire([110,130],[110,170]),wire([110,230],[110,260]),wire([380,130],[380,170]),wire([380,230],[380,260]),wire([240,172],[240,260])]},
    equations: [`芯片损耗 P ≈ (Vin−Vout)×I = ${round(loss,3)} W`],
    pcbTips:['输入/输出电容紧贴引脚','裸露焊盘和地铜用于散热','敏感模拟负载使用干净地回流'],
    warnings: loss > 1 ? [`估算损耗 ${round(loss,2)} W，线性稳压温升可能过高。`] : [],
    nextSteps:['核对 dropout、静态电流和稳定电容 ESR 范围','按 θJA 与环境温度计算结温'],
  });
}

function makeOpAmp(spec) {
  const inverting = spec.opampMode === 'inverting';
  const requested = spec.gain ?? 2;
  const gain = inverting ? -Math.abs(requested) : requested;
  const r1 = 10;
  const r2 = inverting ? Math.abs(gain) * r1 : Math.max(0, (gain - 1) * r1);
  const actualGain = inverting ? -r2 / r1 : 1 + r2 / r1;
  const mode = inverting ? '反相' : '同相';
  const noninvertingSchematic = {components:[terminal('J1','VIN',55,145),part('opamp','U1','OP AMP',245,165),terminal('J2','VOUT',490,165),part('resistor','R2',`${r2}k`,350,265),part('resistor','R1',`${r1}k`,220,335,90),part('ground','GND','',220,400)],wires:[wire([55,145],[172,145]),wire([290,165],[490,165]),wire([420,165],[420,265],[389,265]),wire([311,265],[220,265],[220,185],[172,185]),wire([220,265],[220,296]),wire([220,374],[220,390])]};
  const invertingSchematic = {components:[terminal('J1','VIN',35,185),part('resistor','R1',`${r1}k`,110,185),part('opamp','U1','OP AMP',245,165),terminal('J2','VOUT',490,165),part('resistor','R2',`${r2}k`,350,265),part('ground','GND','',140,240)],wires:[wire([35,185],[71,185]),wire([149,185],[172,185]),wire([290,165],[490,165]),wire([420,165],[420,265],[389,265]),wire([311,265],[220,265],[220,185],[172,185]),wire([172,145],[140,145],[140,230])]};
  return commonPlan(spec, {
    confidence: spec.gain ? 0.86 : 0.68,
    title: `${mode}运算放大器 · 增益 ${gain} 倍`,
    function: inverting ? '按负反馈电阻比进行反相放大，输入偏置和供电范围需要另行核对。' : '对输入模拟信号进行高输入阻抗同相放大。',
    topology: `${mode}运放闭环放大器`,
    designParameters: { opampMode: inverting ? 'inverting' : 'noninverting', targetGain: gain, actualGain, gainErrorPercent: (actualGain - gain) / (gain || 1) * 100 },
    assumptions: ['未指定带宽、噪声、源阻抗与输出负载', '供电、参考电位与输入共模范围必须按实际信号核对'],
    components:[{ref:'U1',value:'轨到轨运放（待选型）',role:'放大',footprint:'SOIC-8/TSSOP-8'},{ref:'R1',value:engineeringNumber(r1 * 1000, 'Ω'),role:inverting ? '输入电阻 Rin' : '反馈下臂',footprint:'0603 0.1–1%'},{ref:'R2',value:engineeringNumber(r2 * 1000, 'Ω'),role:'反馈电阻 Rf',footprint:'0603 0.1–1%'},{ref:'C1',value:'100 nF',role:'电源去耦',footprint:'0603'}],
    connections:inverting ? ['VIN → R1 → U1.−','VOUT → R2 → U1.−','U1.+ → GND/已确认参考电位','VCC → C1 → GND，C1 紧贴 U1'] : ['VIN → U1.+','VOUT → R2 → U1.−','U1.− → R1 → GND','VCC → C1 → GND，C1 紧贴 U1'],
    schematic: inverting ? invertingSchematic : noninvertingSchematic,
    equations:[inverting ? `Av = −R2/R1 = −${r2}/${r1} = ${round(actualGain, 6)}` : `Av = 1 + R2/R1 = 1 + ${r2}/${r1} = ${round(actualGain, 6)}`, `目标增益 ${gain}，按 BOM 反算 ${round(actualGain, 6)}，标称偏差 ${round((actualGain - gain) / (gain || 1) * 100, 4)}%`],
    pcbTips:['反馈网络紧贴反相输入','输入走线远离数字时钟与开关节点','每个电源引脚就近放置 100 nF 去耦','为高阻节点设置护环需结合漏电要求'],
    warnings: !inverting && gain < 1 ? ['同相结构增益不能小于 1，当前目标无法满足，必须修改增益或拓扑。'] : [],
    nextSteps:['补充信号幅度、直流偏置和目标带宽','检查 GBW、压摆率、输入共模与输出摆幅','仿真相位裕度与容性负载'],
  });
}

function makeTimer(spec) {
  const f = spec.frequency ?? 1000;
  const requestedDuty = spec.duty == null ? null : spec.duty / 100;
  const unsupportedDuty = requestedDuty != null && (requestedDuty <= 0.5 || requestedDuty >= 1);
  const duty = unsupportedDuty ? 0.7 : requestedDuty ?? 0.7;
  const selected = selectTimingValues(f, duty);
  if (!selected) return makeGeneric({ ...spec, kind: 'generic' });
  const { ra, rb, c, achieved, achievedDuty } = selected;
  const cLabel = engineeringNumber(c, 'F');
  return commonPlan(spec, {
    confidence: spec.frequency ? 0.85 : 0.66,
    title: `NE555 无稳态振荡器 · 目标 ${engineeringNumber(f, 'Hz')}`,
    function: '产生连续方波；频率和占空比由实际列出的标称 R/C 反算。',
    topology:'NE555 astable 无稳态多谐振荡器',
    designParameters: { targetFrequency:f, actualFrequency:achieved, frequencyErrorPercent:(achieved/f-1)*100, targetDuty:requestedDuty, actualDuty:achievedDuty },
    assumptions:['标准无稳态拓扑占空比高于 50%','标称频率未计 R/C 容差、阈值与放电管压降，芯片频率范围待核对'],
    components:[{ref:'U1',value:'NE555/CMOS 555',role:'定时器',footprint:'SOIC-8'},{ref:'RA',value:engineeringNumber(ra, 'Ω'),role:'充电电阻',footprint:'0603'},{ref:'RB',value:engineeringNumber(rb, 'Ω'),role:'充放电电阻',footprint:'0603'},{ref:'C1',value:cLabel,role:'定时电容',footprint:'0603/0805'},{ref:'C2',value:'10 nF',role:'控制端滤波',footprint:'0603'}],
    connections:['RA：VCC → DISCH','RB：DISCH → THR/TRIG','C1：THR/TRIG → GND','RESET → VCC','OUT → 输出端'],
    schematic:{components:[terminal('J1','VCC',55,105),part('resistor','RA',engineeringNumber(ra, 'Ω'),130,105),{...part('ic','U1','555',270,180),powerPins:true},terminal('J2','OUT',490,180),part('resistor','RB',engineeringNumber(rb, 'Ω'),170,255,90),part('capacitor','C1',cLabel,170,355),part('ground','GND','',170,420),part('ground','GND','',270,300)],wires:[wire([55,105],[91,105]),wire([169,105],[270,105],[270,138]),wire([327,168],[350,168],[350,180],[490,180]),wire([170,105],[170,216]),wire([170,294],[170,325]),wire([170,385],[170,410]),wire([170,310],[213,310],[213,192]),wire([270,222],[270,290])]},
    equations:[`f ≈ 1.44 / ((RA + 2RB) × C) ≈ ${round(achieved,4)} Hz`, `目标 ${f} Hz，标称频率偏差 ${round((achieved/f-1)*100,4)}%`, `占空比 D = (RA+RB)/(RA+2RB) ≈ ${round(achievedDuty*100,4)}%`],
    missingParameters: unsupportedDuty ? ['指定占空比需要独立充放电路径或其他振荡拓扑，当前参考未满足目标'] : [],
    pcbTips:['定时 R/C 靠近 555 引脚','电源脚并联 100 nF + 1 µF','输出驱动感性负载时增加缓冲与续流路径'],
    warnings: unsupportedDuty ? [`标准 555 无稳态拓扑无法实现 ${spec.duty}% 占空比；当前仅保留约 70% 的参考，不满足该需求。需要增加独立充放电路径或改用 MCU 定时器，不能把本草案视为已完成设计。`] : [],
    nextSteps:['按具体芯片检查供电、定时电阻范围与最高频率','需要 ≤50% 占空比时另行设计独立充放电路径','检查负载电流与输出电平'],
  });
}

function makeRectifier(spec) {
  const vac = spec.inputVoltage ?? 12;
  const current = spec.current ?? 1;
  return commonPlan(spec, {
    confidence:0.78,title:`${vac} V AC 桥式整流与滤波草案`,function:'将低压交流全波整流并滤波为脉动直流。',topology:'全桥整流 + 储能电容',assumptions:['默认输入为隔离后的低压交流','默认电网频率 50 Hz','输出仍需后级稳压'],
    components:[{ref:'BR1',value:'桥式整流器',role:'全波整流',footprint:'按电流/耐压'},{ref:'C1',value:`≥ ${Math.ceil(current/(100*1)*1000)} µF 初估`,role:'储能滤波',footprint:'径向电解'},{ref:'F1',value:'按输入能力选型',role:'过流保护',footprint:'保险丝座'}],
    connections:['AC 输入经 F1 接 BR1.AC','BR1.+ → C1+ → VRAW','BR1.− → C1− → GND'],
    schematic:{components:[terminal('J1','AC1',55,105),terminal('J2','AC2',55,265),part('diode','D1','',155,105),part('diode','D2','',155,265),part('diode','D3','',285,105,180),part('diode','D4','',285,265,180),part('capacitor','C1','FILTER',400,185),terminal('J3','VRAW',490,105),part('ground','GND','',400,280)],wires:[wire([55,105],[118,105]),wire([192,105],[248,105]),wire([322,105],[490,105]),wire([55,265],[118,265]),wire([192,265],[248,265]),wire([322,265],[400,265]),wire([400,105],[400,155]),wire([400,215],[400,270])]},
    equations:[`空载峰值约 Vac×√2−2Vf ≈ ${round(vac*Math.SQRT2-1.4)} V`,`电容初估 C ≈ I/(2fΔV)`],pcbTips:['整流大电流回路短而宽','电解电容纹波电流额定值需留裕量','交流入口与低压信号保持间距'],warnings: [...(spec.highRisk ? ['若输入直接连接市电，本草案不适用；必须采用合规隔离、保险、浪涌与爬电设计。'] : []),'交流输入必须确认已隔离（变压器/隔离电源），整流输出为脉动直流，负载需要稳压时必须增加后级 DC-DC 或 LDO。'],nextSteps:['确认输入是否已隔离','确定允许纹波和负载电流','核对桥堆浪涌电流及电容耐压'],
  });
}

function makeDriver(spec) {
  const voltage = spec.outputVoltage ?? spec.inputVoltage ?? 12;
  const current = spec.current ?? 1;
  return commonPlan(spec,{confidence:0.78,title:`${voltage} V / ${current} A 低边负载驱动`,function:'用逻辑电平 N-MOSFET 控制继电器、电机或电磁阀等直流负载。',topology:'N 沟道 MOSFET 低边开关',assumptions:['控制信号默认 3.3 V','负载默认感性，因此配置续流二极管'],components:[{ref:'Q1',value:'逻辑电平 N-MOSFET',role:'功率开关',footprint:'按损耗/散热'},{ref:'D1',value:'续流二极管',role:'吸收关断能量',footprint:'按负载电流'},{ref:'RG',value:'22–100 Ω',role:'限制栅极尖峰电流',footprint:'0603'},{ref:'RPD',value:'100 kΩ',role:'默认关断',footprint:'0603'}],connections:['控制输入 → RG → Q1.G','Q1.G → RPD → GND','负载+ → 电源+；负载− → Q1.D','Q1.S → GND','D1 反向并联于负载两端'],schematic:{components:[terminal('J1','CTRL',55,130),part('resistor','RG','47Ω',135,130),part('mosfet','Q1','N-MOS',285,205),terminal('J2','LOAD−',490,130),part('diode','D1','FLYBACK',395,70,180),part('resistor','RPD','100k',220,275,90),part('ground','GND','',285,350),part('ground','GND','',220,350)],wires:[wire([55,130],[96,130]),wire([174,130],[250,130],[250,205]),wire([293,164],[320,164],[320,130],[490,130]),wire([320,130],[432,130],[432,70]),wire([358,70],[320,70],[320,130]),wire([293,246],[293,330],[285,330],[285,340]),wire([220,130],[220,236]),wire([220,314],[220,340])]},equations:[`导通损耗约 Pcond = I²×RDS(on)，需按 ${current} A 与实际栅压核算`],pcbTips:['功率回路短宽，负载回流不要穿过逻辑地','栅极电阻靠近 MOSFET Gate','续流二极管靠近负载接口/开关回路','大电流连接器与铜厚需按温升核算'],warnings:[],nextSteps:['提供负载类型、启动/堵转电流和 PWM 频率','按 3.3 V 下 RDS(on) 选型','核对雪崩能力、二极管恢复与散热'],});
}

function makeMotorDriver(spec) {
  const motorVoltage = spec.motorVoltage ?? spec.inputVoltage ?? 6;
  const logicVoltage = spec.controlVoltage ?? (spec.inputVoltage && spec.inputVoltage < motorVoltage ? spec.inputVoltage : 3.3);
  const motorCount = Math.min(4, Math.max(1, spec.motorCount || 2));
  const continuousCurrent = spec.current ?? 0.8;
  const peakCurrent = spec.stallCurrent ?? round(continuousCurrent * 2.5, 2);
  const missingParameters = [
    ...(!spec.motorVoltage && !spec.inputVoltage ? ['电机电源的正常范围和满充电压'] : []),
    ...(!spec.stallCurrent ? ['每个电机的启动/堵转电流'] : []),
    ...(!spec.controlVoltage ? ['控制器 GPIO 电平（例如 3.3 V）'] : []),
    ...(!spec.frequency ? ['PWM 频率与可接受的电机噪声'] : []),
  ];
  const parameterCompleteness = Math.round((4 - Math.min(4, missingParameters.length)) / 4 * 100);
  const confidence = missingParameters.length >= 3 ? 0.72 : missingParameters.length ? 0.81 : 0.88;
  const driverCriteria = `双路全桥；VM 覆盖 ${motorVoltage} V；每路持续 ≥${continuousCurrent} A、峰值 ≥${peakCurrent} A；兼容 ${logicVoltage} V 逻辑`;
  return commonPlan(spec, {
    confidence,
    title: `${motorVoltage} V 双电机小车驱动电路 · 工程首版`,
    function: `用双路全桥独立控制 ${motorCount} 个有刷直流电机的正转、反转、滑行、制动与 PWM 调速，并隔离电机噪声对控制器供电的影响。`,
    topology: '受保护动力输入 + 双路 MOSFET H 桥 + MCU PWM/方向控制',
    intentSummary: `识别为低压双轮/多轮小车动力控制；需要双向电流，因此选择双 H 桥而不是单管低边开关。`,
    parameterCompleteness,
    resolvedSpecs: { inputVoltage: motorVoltage, outputVoltage: motorVoltage, current: continuousCurrent, frequency: spec.frequency },
    missingParameters,
    clarifyingQuestions: [
      ...(!spec.stallCurrent ? ['请实测或提供单个电机在目标电压下的堵转电流。'] : []),
      ...(!spec.motorVoltage && !spec.inputVoltage ? ['电池/适配器的最低、标称和最高电压分别是多少？'] : []),
      ...(!spec.controlVoltage ? ['控制板是 3.3 V 还是 5 V GPIO？是否需要 EN/FAULT 回读？'] : []),
      ...(!spec.frequency ? ['希望超声 PWM（约 20 kHz）还是更低开关损耗的 PWM？'] : []),
    ].slice(0, 3),
    designParameters: { motorVoltage, logicVoltage, motorCount, continuousCurrent, stallCurrent: spec.stallCurrent, peakCurrent, peakCurrentEvidence: spec.stallCurrent ? 'user-input' : 'assumption', pwmFrequency: spec.frequency || null },
    designBasis: [
      '小车需要左右轮独立正反转与差速转向，因此选双路 H 桥；单个低边 MOSFET 不能完成反转或主动制动。',
      spec.stallCurrent
        ? `已将用户给出的 ${peakCurrent} A 堵转/峰值电流作为驱动器、保护和铜箔的首轮筛选门槛；仍需核对测量电压、持续时间和温度。`
        : `在缺少堵转数据时，仅把 ${continuousCurrent} A/路作为低压教学首版假设，并按 2.5 倍得到 ${peakCurrent} A 峰值筛选门槛；定型前必须用实测堵转电流替换。`,
      '板外电源依次经过保险、反接保护和 TVS 评估；驱动器旁设置高频去耦与大容量储能，避免电机启动造成控制器复位。',
      '所有控制输入设置默认关断下拉，确保 MCU 复位或线缆断开时电机不会意外启动。',
    ],
    assumptions: [
      `默认使用已隔离的 ${motorVoltage} V 直流电源或低压电池组`,
      `默认 ${motorCount} 个有刷直流减速电机、每路持续 ${continuousCurrent} A`,
      `默认 ${logicVoltage} V MCU 控制；PWM 频率需结合驱动器、听感和开关损耗确定`,
      '反接与浪涌器件的最终额定值必须按电池满充、线缆电感和驱动器绝对最大值协调',
    ],
    components: [
      { ref:'J1', type:'connector', value:`${motorVoltage} V 动力输入`, role:'电池/适配器接口', footprint:'锁紧式 2Pin 连接器' },
      { ref:'F1', type:'fuse', value:`PTC/保险丝 ${round(continuousCurrent * motorCount * 1.25, 1)} A 初选`, role:'输入短路与过流保护', footprint:'按保持电流和分断能力' },
      { ref:'QREV1', type:'mosfet', value:'P-MOS/理想二极管反接保护', role:'降低串联二极管压降', footprint:'按最大输入电流与热设计' },
      { ref:'DTVS1', type:'diode', value:`单向 TVS；VRWM>${motorVoltage} V 且钳位低于 U1 极限`, role:'线缆与电机回生浪涌钳位', footprint:'SMA/SMBJ（按脉冲能量）' },
      { ref:'CBULK1', type:'capacitor', value:`470 µF / ≥${Math.max(16, Math.ceil(motorVoltage * 1.5))} V / 低 ESR 初选`, role:'电机启动与制动储能', footprint:'径向/贴片电解' },
      { ref:'CIN1', type:'capacitor', value:'10 µF + 100 nF X7R', role:'驱动器 VM 高频去耦', footprint:'0805 + 0603' },
      { ref:'U1', type:'ic', value:'双路 MOSFET H 桥驱动器', role:driverCriteria, footprint:'带散热焊盘封装优先' },
      { ref:'RIN1…4', type:'resistor', value:'33 Ω', role:'限制控制边沿振铃/EMI', footprint:'0603' },
      { ref:'RPD1…4', type:'resistor', value:'100 kΩ', role:'上电与复位期间默认关断', footprint:'0603' },
      { ref:'CM1/CM2', type:'capacitor', value:'100 nF（按电机 EMI 实测调整）', role:'电机端子差模抑制', footprint:'靠近电机端子/接口' },
      { ref:'J2', type:'connector', value:`${logicVoltage} V CTRL：AIN1/2、BIN1/2、PWM/EN、FAULT、GND`, role:'MCU 控制接口', footprint:'2.54 mm 排针/锁紧连接器' },
      { ref:'J3/J4', type:'connector', value:'MOTOR-A / MOTOR-B', role:'左右电机输出', footprint:'锁紧式 2Pin 连接器' },
    ],
    connections: [
      'J1+ → F1 → QREV1 → VM；J1− → PGND；DTVS1 与 CBULK1 跨接 VM–PGND',
      'VM → CIN1 → U1.VM；CIN1 的 100 nF 与 U1 VM/PGND 形成最小高频回路',
      'U1.AOUT1/AOUT2 → J3 → 左电机；U1.BOUT1/BOUT2 → J4 → 右电机',
      'J2 控制信号经 RIN1…4 接 U1 输入；每个输入经 RPD1…4 下拉到逻辑地',
      'MCU GND 与 U1 逻辑地在驱动器参考点相连；电机大电流回流直接返回 CBULK1/J1，不穿过 MCU 区域',
      'FAULT/电流检测（若器件提供）接 MCU 输入并配置上拉；固件在故障或欠压时关闭两路输出',
    ],
    schematic: {
      components: [
        terminal('J1','BAT+',35,100), part('fuse','F1','INPUT',100,100), part('mosfet','QREV1','REV',195,100),
        part('ic','U1','DUAL H-BRIDGE',330,190), terminal('J3','MOTOR-A',500,135), terminal('J4','MOTOR-B',500,245),
        part('capacitor','CBULK','470µF',245,285), part('capacitor','CIN','10µ+100n',315,285),
        terminal('J2','MCU CTRL',55,245), part('resistor','RIN','4×33Ω',150,245),
        part('diode','TVS','CLAMP',190,330), part('ground','PGND','',245,390), part('ground','GND','',315,390),
      ],
      wires: [
        wire([35,100],[65,100]), wire([135,100],[160,100]), wire([230,100],[330,100],[330,150]),
        wire([375,170],[500,135]), wire([375,220],[500,245]), wire([55,245],[111,245]), wire([189,245],[285,245]),
        wire([245,100],[245,255]), wire([245,315],[245,380]), wire([315,100],[315,255]), wire([315,315],[315,380]),
        wire([190,100],[190,300]), wire([190,360],[245,360]),
      ],
    },
    equations: [
      `驱动器持续电流门槛：Icont ≥ ${continuousCurrent} A/路（必须用实测工作电流复核）`,
      spec.stallCurrent
        ? `输入的堵转/峰值电流：Ipeak = ${peakCurrent} A/路；需核对驱动器允许的峰值持续时间与限流策略`
        : `暂定峰值筛选门槛：Ipeak ≥ 2.5×Icont ≈ ${peakCurrent} A/路；真正门槛应取堵转电流和驱动器限流策略`,
      `输入持续电流初估：Isupply ≈ ${motorCount}×${continuousCurrent} = ${round(motorCount * continuousCurrent, 2)} A（不含启动同时性与效率裕量）`,
      '导通损耗需按电流路径中高、低侧 MOSFET 的总 RDS(on) 计算：Pcond≈Irms²×Rpath',
      '储能电容压降初估：ΔV≈I×Δt/C；应由允许母线跌落和启动持续时间反算，而不是固定使用 470 µF',
    ],
    engineeringChecks: [
      '按电池满充电压核对 U1、QREV1、TVS 和电容耐压，并至少覆盖插拔/制动回生瞬态',
      '获取电机堵转电流后核对驱动器峰值时间、过流保护、SOA、铜箔温升和连接器额定值',
      '检查 PWM 模式下的续流路径、快衰减/慢衰减模式、制动真值表和上下桥臂死区',
      '分别验证两电机同时启动、快速反转、车轮堵转和电池低电压场景',
      '用示波器短地弹簧测量 VM、逻辑电源和输出振铃；根据实测决定 TVS、RC snubber 与电机端电容',
    ],
    pcbTips: [
      'J1、F1、反接保护、TVS 与 CBULK 沿动力入口紧凑排列；TVS 回路直接返回输入地',
      'U1 的 VM 去耦 100 nF 紧贴 VM/PGND 引脚，大电流 H 桥回路短、宽、上下层多过孔并联',
      '电机输出远离 MCU 时钟、复位、ADC 与天线；不要让电机回流穿过逻辑地或传感器地',
      '散热焊盘按数据手册布置完整铜面和热过孔，避免热过孔吸锡导致焊接空洞',
      'AIN/BIN/PWM 输入串阻靠近驱动器；FAULT、EN 和关键电源轨预留测试点',
    ],
    warnings: [
      ...(!spec.stallCurrent ? ['未提供堵转电流；当前峰值与保险值仅是演示假设，不能据此定型驱动器或投板。'] : []),
      ...(spec.batteryPowered && spec.highRisk ? ['若使用锂电池组，必须使用与电芯串数匹配的合规 BMS、充电器、温度和短路保护；本方案不包含电池管理。'] : []),
    ],
    nextSteps: [
      '记录电池最低/标称/满充电压，并用限流电源实测单个电机空载、负载和堵转电流',
      '依据实测电流和热阻选择具体 H 桥型号，再逐项核对引脚、真值表、限流、死区和保护行为',
      '完成原理图 ERC、最坏值/热分析和动力回路 PCB DRC，再进行限流上电',
    ],
    verificationPlan: [
      '断电：检查反接保护方向、VM–GND 短路、控制输入默认下拉与电机端绝缘',
      '限流上电：先不接电机验证逻辑、欠压与故障脚，再单电机低占空比启动',
      '功能：覆盖正转、反转、滑行、制动、左右轮差速和紧急停机真值表',
      '应力：两电机同时启动、轮轴堵转、快速换向、电池最低/最高电压和最高环境温度',
      '波形/EMI：测量 VM 跌落与尖峰、输出振铃、逻辑地弹和 MCU 复位；按结果迭代钳位/缓冲/布局',
    ],
  });
}

function makeLed(spec) {
  const supply = spec.inputVoltage ?? 5;
  const requestedCurrent = spec.current ?? 0.01;
  const color = spec.ledColor || '红色';
  const vf = { 红色:2.0, 黄色:2.1, 绿色:2.2, 蓝色:3.0, 白色:3.0 }[color] || 2.0;
  const protectionDrop = 0.3;
  const minimumResistance = Math.max(10, (supply - protectionDrop - vf) / requestedCurrent);
  const resistor = selectE24Up(minimumResistance * 1.15);
  const actualCurrent = Math.max(0, (supply - protectionDrop - vf) / resistor);
  const resistorPower = actualCurrent * actualCurrent * resistor;
  // Explicit policy: nominal dissipation uses at most 50% of the selected rating.
  const resistorRating = [0.1,0.125,0.25,0.5,1,2,3,5,10,20].find(rating => rating >= resistorPower * 2)
    ?? Math.ceil(resistorPower * 2);
  const resistorFootprint = resistorRating <= 0.1 ? '0603' : resistorRating <= 0.125 ? '0805'
    : resistorRating <= 0.25 ? '1206' : resistorRating <= 0.5 ? '2010/2512，按所选器件额定值复核' : '通孔/功率电阻，按额定功率与散热选型';
  const includeSwitch = spec.includeSwitch !== false;
  const schematicComponents = [
    terminal('J1.1',`+${supply}V`,35,145),
    part('fuse','F1','0.1A',110,145),
    part('diode','D2','SS14',205,145),
    ...(includeSwitch ? [part('switch','SW1','ON/OFF',300,145)] : []),
    part('resistor','R1',`${resistor >= 1000 ? `${round(resistor/1000,2)}k` : resistor}Ω`,includeSwitch ? 405 : 350,145),
    part('led','D1',`${color} LED`,includeSwitch ? 500 : 465,145),
    part('ground','GND','',includeSwitch ? 500 : 465,230),
    part('ground','J1.2 / GND','',35,230),
  ];
  const schematicWires = includeSwitch
    ? [wire([35,145],[75,145]),wire([145,145],[168,145]),wire([242,145],[262,145]),wire([338,145],[366,145]),wire([444,145],[463,145]),wire([537,145],[545,145],[545,195],[500,195],[500,220])]
    : [wire([35,145],[75,145]),wire([145,145],[168,145]),wire([242,145],[311,145]),wire([389,145],[428,145]),wire([502,145],[520,145],[520,195],[465,195],[465,220])];
  const warnings = [];
  if (supply <= vf + protectionDrop + 0.5) warnings.push('供电电压与 LED 正向压降余量过小，亮度可能随器件和温度变化；应改用更高供电或恒流驱动。');
  if (requestedCurrent > 0.02) warnings.push('指示 LED 电流高于 20 mA，首版仍按串联限流展示；必须核对 LED 额定值并优先考虑恒流驱动。');
  return commonPlan(spec,{
    confidence: spec.inputVoltage || /灯泡|点亮|指示灯|led/i.test(spec.text) ? 0.86 : 0.76,
    title:`${supply} V ${color} LED 点亮电路 · 第一版`,
    function:`使用外部稳压 ${supply} V 直流电源，经输入保护、${includeSwitch ? '机械开关、' : ''}限流电阻点亮单颗${color}指示 LED。`,
    topology:'低压直流输入 + 保护 + 串联电阻限流 LED',
    resolvedSpecs:{inputVoltage:supply,current:round(actualCurrent,5)},
    designParameters:{ledColor:color,ledForwardVoltage:vf,targetCurrent:requestedCurrent,actualCurrent:round(actualCurrent,5),resistor,resistorPower,resistorRating,resistorUtilizationLimit:0.5,includeSwitch,protectionDrop},
    designBasis:[
      '需求未指定灯具类型时，首版选择低风险、易验证的单颗指示 LED，不生成市电灯泡电路。',
      `默认使用外部稳压 ${supply} V DC；D2 选用 SS14 串联反接保护，F1 使用 100 mA 自恢复保险丝。`,
      `按 ${color} LED 典型 Vf≈${vf} V、目标 ${round(requestedCurrent*1000,2)} mA 计算，并上调到 E24 ${resistor >= 1000 ? `${round(resistor/1000,2)} kΩ` : `${resistor} Ω`} 为压降和电源波动留裕量。`,
      `估算工作电流约 ${round(actualCurrent*1000,2)} mA，R1 功耗约 ${round(resistorPower*1000,2)} mW，按标称功耗不超过额定值 50% 的策略选择 ${resistorRating} W；最高环境温度仍须按数据手册降额。`,
    ],
    assumptions:[`“灯泡”按单颗${color}指示 LED 解释`,`电源为已隔离、稳压的 ${supply} V 直流输入`,`LED 典型正向压降按 ${vf} V 估算，量产前按数据手册最大/最小值复核`],
    components:[
      {ref:'J1',type:'connector',value:'KF301-2P / 5.08 mm',role:`${supply} V DC 输入接口`,footprint:'TerminalBlock 1x02 P5.08mm'},
      {ref:'F1',type:'fuse',value:`PTC 0.10 A / 额定电压 ≥${Math.max(6,supply)} V`,role:'输入过流保护',footprint:'1206/按实际电压额定值'},
      {ref:'D2',type:'diode',value:'SS14',role:'串联反接保护',footprint:'SMA'},
      ...(includeSwitch ? [{ref:'SW1',type:'switch',value:'SPST 常开',role:'人工通断控制',footprint:'2Pin P2.54mm/按实物'}] : []),
      {ref:'R1',type:'resistor',value:`${resistor >= 1000 ? `${round(resistor/1000,2)} kΩ` : `${resistor} Ω`} / 1% / ${resistorRating} W`,role:'LED 限流',footprint:resistorFootprint},
      {ref:'D1',type:'led',value:`${color} LED · Vf≈${vf} V`,role:'发光指示',footprint:'LED 0603'},
    ],
    connections:[
      `J1.1（+${supply}V）→ F1.1；J1.2 → GND`,
      'F1.2 → D2.A；D2.K → VPROT（SS14 正向串联）',
      ...(includeSwitch ? ['VPROT → SW1.1；SW1.2 → R1.1'] : ['VPROT → R1.1']),
      'R1.2 → D1.A（LED 阳极）',
      'D1.K（LED 阴极）→ GND',
    ],
    schematic:{components:schematicComponents,wires:schematicWires},
    equations:[`Rmin = (Vs−VD2−Vf)/I = (${supply}−${protectionDrop}−${vf})/${requestedCurrent} ≈ ${round(minimumResistance)} Ω`,`首版选用 ${resistor >= 1000 ? `${round(resistor/1000,2)} kΩ` : `${resistor} Ω`}，预计 ILED ≈ ${round(actualCurrent*1000,2)} mA`,`PR1 = I²R ≈ ${round(resistorPower*1000,2)} mW；额定 ${resistorRating} W，标称负载率 ${round(resistorPower/resistorRating*100,2)}%`],
    pcbTips:['J1、F1、D2 沿电源进入方向依次放置','D1 丝印必须标明阴极方向，SW1 丝印标明 ON/OFF','R1 和 D1 靠近放置，地回路直接返回输入地','电源与地各预留测试点，首次上电使用限流电源'],
    verificationPlan:[
      '断电核对：输入极性、保险与防反二极管方向、LED 极性',
      '限流上电：用可调电源限流至 20mA 验证点亮与电流',
      '实测 R1 两端电压反算 LED 电流，并核对与设计值偏差',
      '开关通断 20 次确认接触可靠，测量整板温升',
    ],
    warnings,
    nextSteps:['用户可在下方继续提出“改为 12V、换白色 LED、去掉开关”等修改','按实际 LED 数据手册的 Vf 范围复算最大电流','装配后先用限流电源上电并测量 R1 两端电压与 LED 电流'],
  });
}

function makeMcuPower(spec) {
  const vout = spec.outputVoltage ?? (spec.inputVoltage === 5 ? 3.3 : 3.3);
  return commonPlan(spec,{confidence:0.7,title:`${vout} V MCU 最小供电与复位框架`,function:'为单片机提供稳定电源、逐引脚去耦、复位与调试接口。',topology:'MCU 最小系统电源域',assumptions:['未指定 MCU 型号','时钟、启动脚和下载接口需按实际芯片调整'],components:[{ref:'U1',value:'MCU（待选型）',role:'主控',footprint:'按芯片'},{ref:'C1…Cn',value:'每个 VDD 100 nF',role:'高频去耦',footprint:'0402/0603'},{ref:'CBULK',value:'4.7–10 µF',role:'局部储能',footprint:'0603/0805'},{ref:'RRESET',value:'10 kΩ',role:'复位上拉',footprint:'0603'},{ref:'JTAG/SWD',value:'调试接口',role:'下载调试',footprint:'2×5 1.27 mm'}],connections:['每个 VDD/VSS 对就近接 100 nF','模拟电源按数据手册经磁珠/滤波接入','RESET 上拉并引出测试点','SWDIO/SWCLK/GND/VREF 引出调试座'],schematic:{components:[terminal('J1','3V3',55,100),{...part('ic','U1','MCU',280,200),powerPins:true},part('capacitor','C1','100n',120,175),part('capacitor','C2','100n',170,175),part('capacitor','CB','4.7µ',420,175),part('ground','GND','',120,270),part('ground','GND','',170,270),part('ground','GND','',280,280),part('ground','GND','',420,270),part('connector','J2','SWD',460,350)],wires:[wire([55,100],[420,100]),wire([280,100],[280,158]),wire([120,100],[120,145]),wire([120,205],[120,260]),wire([170,100],[170,145]),wire([170,205],[170,260]),wire([420,100],[420,145]),wire([420,205],[420,260]),wire([280,242],[280,270]),wire([337,212],[380,212],[380,338],[416,338])]},equations:[],pcbTips:['去耦电容与电源引脚形成最小回路','完整参考地平面，避免高速回流跨分割','晶振贴近芯片且远离板边/开关节点','调试与关键总线预留测试点'],warnings:[],nextSteps:['确定 MCU 完整型号并读取硬件设计指南','核对所有电源域、启动脚和未用引脚','完成时钟/复位/下载接口与 ESD 设计'],});
}

function makeFilter(spec) {
  const f = spec.frequency ?? 1000;
  const selected = selectTimingValues(f);
  if (!selected) return makeGeneric({ ...spec, kind: 'generic' });
  const { r, c, achieved } = selected;
  const highpass = spec.filterMode === 'highpass';
  const mode = highpass ? '高通' : '低通';
  const rLabel = engineeringNumber(r, 'Ω'), cLabel = engineeringNumber(c, 'F');
  const schematic = highpass
    ? {components:[terminal('J1','VIN',55,130),part('capacitor','C1',cLabel,180,130,90),terminal('J2','VOUT',490,130),part('resistor','R1',rLabel,350,205,90),part('ground','GND','',350,280)],wires:[wire([55,130],[150,130]),wire([210,130],[490,130]),wire([350,130],[350,166]),wire([350,244],[350,270])]}
    : {components:[terminal('J1','VIN',55,130),part('resistor','R1',rLabel,180,130),terminal('J2','VOUT',490,130),part('capacitor','C1',cLabel,350,205),part('ground','GND','',350,280)],wires:[wire([55,130],[141,130]),wire([219,130],[490,130]),wire([350,130],[350,175]),wire([350,235],[350,270])]};
  return commonPlan(spec,{confidence:0.73,title:`${f} Hz 一阶 RC ${mode}滤波器`,function:highpass ? '衰减截止频率以下的低频分量。' : '衰减截止频率以上的高频分量。',topology:`无源一阶 RC ${mode}`,
    designParameters:{filterMode:highpass?'highpass':'lowpass',targetFrequency:f,actualFrequency:achieved,frequencyErrorPercent:(achieved/f-1)*100},
    assumptions:['默认后级输入阻抗远高于 R','未计信号源阻抗与器件容差'],
    components:[{ref:'R1',value:rLabel,role:highpass?'输出下拉电阻':'串联阻抗',footprint:'0603'},{ref:'C1',value:cLabel,role:highpass?'串联隔直电容':'旁路高频',footprint:'0603/0805'}],
    connections:highpass?['VIN → C1 → VOUT','VOUT → R1 → GND']:['VIN → R1 → VOUT','VOUT → C1 → GND'],schematic,
    equations:[`fc = 1/(2πRC) ≈ ${round(achieved,4)} Hz`,`目标 ${f} Hz，按 BOM 反算偏差 ${round((achieved/f-1)*100,4)}%`],
    pcbTips:['电容接地回路短','高阻输出节点远离噪声源','若驱动 ADC，需结合采样电容验证稳定时间'],warnings:[],nextSteps:['补充源阻抗、负载阻抗和允许衰减','仿真幅频/相频响应','对 ADC 前端检查采样建立时间']});
}

function makeGeneric(spec) {
  return commonPlan(spec,{confidence:0.42,title:'通用电路架构草案',function:'需求信息不足，先建立输入、处理、保护、输出四个功能块。',topology:'待澄清',assumptions:['当前无法可靠选择具体拓扑'],components:[{ref:'J1',value:'输入接口',role:'能源/信号输入',footprint:'待定'},{ref:'U1',value:'核心处理模块',role:'待定义',footprint:'待定'},{ref:'J2',value:'输出接口',role:'负载/信号输出',footprint:'待定'}],connections:['输入接口 → 保护/调理 → 核心模块 → 输出接口','电源、地与反馈网络待需求明确后细化'],schematic:{components:[terminal('J1','INPUT',55,165),part('block','B1','保护/调理',160,165),part('block','U1','核心处理',300,165),part('block','B2','输出/保护',430,165),terminal('J2','OUTPUT',510,165)],wires:[wire([55,165],[90,165],[90,153],[103,153]),wire([217,153],[243,153]),wire([357,153],[373,153]),wire([487,153],[500,153],[500,165],[510,165])]},equations:[],pcbTips:['先定义电源域和接口等级','根据电流/频率决定分层、线宽与回流路径'],warnings:['需求不足，不能据此选择器件或投板。'],nextSteps:['补充输入类型与范围','补充输出目标、最大负载和精度','补充环境、尺寸、成本与安全约束'],});
}

function enrichPlanWithKnowledge(plan, spec, entries = []) {
  const aliases = {
    buck: 'buck 降压 开关电源 环路 EMI 热环路',
    boost: 'boost 升压 开关电源 环路 二极管 关断直通',
    ldo: 'ldo 线性稳压 dropout 热设计 稳定性',
    opamp: '运放 放大 稳定性 相位裕度 GBW 压摆率',
    timer555: '555 振荡 方波 定时',
    rectifier: '整流 桥堆 浪涌 储能 安全',
    'low-side-driver': 'mosfet 继电器 电机 栅极驱动 续流 SOA',
    'motor-driver': '电机 小车 H桥 MOSFET 栅极驱动 堵转 PWM TVS EMI 去耦 PCB',
    'led-driver': 'led 限流 反接 保护 功率',
    'mcu-power': 'mcu 退耦 回流 ESD 接口 PCB',
    'rc-filter': 'RC 滤波 ADC 建立时间 运放',
    generic: spec.text,
  };
  const verified = (entries || []).filter((entry) => entry?.verified === true && entry?.source?.url);
  const matches = knowledgeSearch(verified, `${spec.text} ${aliases[spec.kind] || ''}`, 7);
  const applicable = matches.filter((entry) => {
    const kinds = entry.rules?.appliesTo;
    return !Array.isArray(kinds) || !kinds.length || kinds.includes(spec.kind) || kinds.includes('*');
  });
  const rules = applicable.map((entry) => entry.rules).filter(Boolean);
  plan.knowledgeEvidence = applicable.map((entry) => ({
    id: entry.id,
    title: entry.title,
    category: entry.category,
    sourceTitle: entry.source.title,
    url: entry.source.url,
    maturity: '厂商/标准公开资料',
  }));
  plan.engineeringChecks = unique([
    ...(plan.engineeringChecks || []),
    ...rules.flatMap((rule) => rule.requiredChecks || []),
  ]);
  plan.verificationPlan = unique([
    ...(plan.verificationPlan || []),
    ...rules.flatMap((rule) => rule.verification || []),
  ]);
  plan.pcbTips = unique([
    ...(plan.pcbTips || []),
    ...rules.flatMap((rule) => rule.pcb || []),
  ]);
  plan.warnings = unique([
    ...(plan.warnings || []),
    ...rules.flatMap((rule) => rule.warnings || []),
  ]);

  const requiredByKind = {
    buck: [['inputVoltage','输入电压范围'],['outputVoltage','输出电压'],['current','最大负载电流']],
    boost: [['inputVoltage','输入电压范围'],['outputVoltage','输出电压'],['current','最大负载电流']],
    ldo: [['inputVoltage','输入电压范围'],['outputVoltage','输出电压'],['current','最大负载电流']],
    opamp: [['gain','闭环增益'],['inputVoltage','供电电压与输入信号范围']],
    timer555: [['frequency','目标频率']],
    'low-side-driver': [['current','负载启动/堵转电流']],
    'motor-driver': [['motorVoltage','电机电源范围'],['stallCurrent','电机堵转电流'],['controlVoltage','GPIO 电平']],
    'rc-filter': [['frequency','目标截止频率']],
  };
  const required = requiredByKind[spec.kind] || [];
  const derivedMissing = required.filter(([field]) => spec[field] == null).map(([,label]) => label);
  plan.invalidParameters = unique(spec.parameterIssues || []);
  plan.missingParameters = unique([...(plan.missingParameters || []), ...derivedMissing, ...plan.invalidParameters]);
  plan.warnings = unique([...plan.warnings, ...plan.invalidParameters]);
  const ranges = spec.parameterRanges || [];
  if (ranges.length) {
    const message = `给定范围 ${ranges.map(item=>item.raw).join('、')}：当前仅计算标称端点，尚未完成全范围最坏工况校核。`;
    plan.warnings = unique([...plan.warnings,message]);
    plan.missingParameters = unique([...plan.missingParameters,'范围内的名义工作点与多工况验证']);
  }
  // 多电源域：单一拓扑只覆盖主电源轨，次要电源域必须显式列入缺失参数并要求确认。
  if (spec.multiRail) {
    plan.missingParameters = unique([...(plan.missingParameters || []), '次要电源域的电压、电流与上电时序']);
    plan.clarifyingQuestions = unique([
      ...(plan.clarifyingQuestions || []),
      '检测到多个电源域：请确认次要电源轨（电压/电流/上电顺序）由哪一路拓扑提供。',
    ]);
  }
  if (!plan.parameterCompleteness && required.length) {
    plan.parameterCompleteness = Math.round((required.length - derivedMissing.length) / required.length * 100);
  }
  if (!plan.intentSummary) {
    plan.intentSummary = spec.kind === 'generic'
      ? '尚未识别出足以安全选择器件级拓扑的功能目标。'
      : `已识别 ${plan.topology}，并保留缺失参数与工程边界。`;
  }
  if (!plan.clarifyingQuestions?.length && derivedMissing.length) {
    plan.clarifyingQuestions = derivedMissing.slice(0, 3).map((label) => `请补充${label}；该参数会影响拓扑、额定值或器件选型。`);
  }
  if (applicable.length) {
    plan.source = `${plan.source} · ${applicable.length} 条可追溯工程依据`;
    plan.confidence = round(plan.confidence + Math.min(0.03, applicable.length * 0.005), 2);
  }
  const confidenceCeiling = plan.missingParameters.length >= 3 ? 0.59 : plan.missingParameters.length ? 0.79 : 0.91;
  plan.confidence = round(Math.min(confidenceCeiling, plan.confidence), 2);
  plan.reasoning = {
    intent: spec.kind,
    parameterCompleteness: plan.parameterCompleteness,
    evidenceCount: plan.knowledgeEvidence.length,
    evidenceMaturity: plan.knowledgeEvidence.length ? '厂商/标准公开资料 + 参数化计算' : '内置参数化计算',
    unresolvedCount: plan.missingParameters.length,
  };
  return plan;
}

export function generateCircuit(requirement, knowledge = []) {
  const spec = parseRequirement(requirement);
  const factories = { buck: makeBuck, boost: makeBoost, ldo: makeLdo, opamp: makeOpAmp, timer555: makeTimer, rectifier: makeRectifier, 'low-side-driver': makeDriver, 'motor-driver': makeMotorDriver, 'led-driver': makeLed, 'mcu-power': makeMcuPower, 'rc-filter': makeFilter, generic: makeGeneric };
  const plan = spec.parameterIssues.length ? makeGeneric({...spec, kind:'generic'}) : (factories[spec.kind] || makeGeneric)(spec);
  if (spec.highRisk) {
    plan.warnings.unshift(`检测到高风险关键词（${(spec.riskCategories || []).join('/') || '综合判断'}）：必须由具备资质的工程师复核隔离、保护、安规距离和失效模式。`);
  }
  return enrichPlanWithKnowledge(plan, spec, knowledge);
}

export function reviseCircuit(currentPlan, changeRequest, knowledge = []) {
  if (!currentPlan) return generateCircuit(changeRequest, knowledge);
  const change = parseRequirement(changeRequest);
  const base = currentPlan.parsedSpec || parseRequirement((currentPlan.requirement || '').split('\n修改要求：')[0]);
  const powerKinds = new Set(['buck','boost','ldo']);
  const keepsMotorTopology = currentPlan.kind === 'motor-driver'
    && ['generic','low-side-driver','mcu-power','timer555'].includes(change.kind);
  const next = {
    ...base,
    text: `${currentPlan.requirement || ''}\n修改要求：${String(changeRequest || '').trim()}`.trim(),
    lower: `${currentPlan.requirement || ''} ${changeRequest || ''}`.toLowerCase(),
    kind: keepsMotorTopology ? 'motor-driver' : change.explicitKind ? change.kind : currentPlan.kind || base.kind,
    inputVoltage: currentPlan.specs?.inputVoltage ?? base.inputVoltage,
    outputVoltage: currentPlan.specs?.outputVoltage ?? base.outputVoltage,
    current: currentPlan.designParameters?.targetCurrent ?? currentPlan.specs?.current ?? base.current,
    frequency: currentPlan.specs?.frequency ?? base.frequency,
    gain: currentPlan.specs?.gain ?? base.gain,
    duty: change.duty ?? base.duty,
    filterMode: change.filterMode ?? currentPlan.designParameters?.filterMode ?? base.filterMode,
    opampMode: change.opampMode ?? currentPlan.designParameters?.opampMode ?? base.opampMode,
    parameterIssues: change.parameterIssues,
    multiRail: Boolean(base.multiRail || change.multiRail),
    ledColor: currentPlan.designParameters?.ledColor || base.ledColor,
    includeSwitch: currentPlan.designParameters?.includeSwitch ?? base.includeSwitch,
    motorVoltage: currentPlan.designParameters?.motorVoltage ?? base.motorVoltage,
    controlVoltage: currentPlan.designParameters?.logicVoltage ?? base.controlVoltage,
    motorCount: currentPlan.designParameters?.motorCount ?? base.motorCount,
    stallCurrent: currentPlan.designParameters?.stallCurrent ?? base.stallCurrent,
    highRisk: Boolean(base.highRisk || change.highRisk),
  };
  if (change.inputVoltage != null && !(next.kind === 'motor-driver' && change.controlVoltage != null && change.motorVoltage == null)) next.inputVoltage = change.inputVoltage;
  if (change.outputVoltage != null && powerKinds.has(next.kind)) next.outputVoltage = change.outputVoltage;
  if (change.current != null) next.current = change.current;
  if (change.stallCurrent != null) next.stallCurrent = change.stallCurrent;
  if (change.frequency != null) next.frequency = change.frequency;
  if (change.gain != null) next.gain = change.gain;
  if (change.ledColor) next.ledColor = change.ledColor;
  if (change.includeSwitch != null) next.includeSwitch = change.includeSwitch;
  if (change.motorVoltage != null) next.motorVoltage = change.motorVoltage;
  else if (base.kind === 'motor-driver' && change.inputVoltage != null && change.controlVoltage == null) next.motorVoltage = change.inputVoltage;
  if (change.controlVoltage != null) next.controlVoltage = change.controlVoltage;
  if (change.motorCount != null) next.motorCount = change.motorCount;
  const factories = { buck: makeBuck, boost: makeBoost, ldo: makeLdo, opamp: makeOpAmp, timer555: makeTimer, rectifier: makeRectifier, 'low-side-driver': makeDriver, 'motor-driver': makeMotorDriver, 'led-driver': makeLed, 'mcu-power': makeMcuPower, 'rc-filter': makeFilter, generic: makeGeneric };
  const revised = next.parameterIssues.length ? makeGeneric({...next, kind:'generic'}) : (factories[next.kind] || makeGeneric)(next);
  revised.parentId = currentPlan.id;
  revised.revisionNumber = Number(currentPlan.revisionNumber || 1) + 1;
  revised.title = revised.title.replace(/· 第一版$/, `· 修订版 v${revised.revisionNumber}`);
  revised.revisionHistory = [...(currentPlan.revisionHistory || []), { request: String(changeRequest || '').trim(), fromKind:currentPlan.kind, toKind:revised.kind,
    changes:Object.fromEntries(Object.keys(revised.specs).filter(key => currentPlan.specs?.[key] !== revised.specs[key]).map(key => [key,{before:currentPlan.specs?.[key],after:revised.specs[key]}])), createdAt: new Date().toISOString() }];
  revised.source = `${revised.source} · 基于上一版修订`;
  if (currentPlan.kind !== revised.kind) revised.warnings.push(`根据本次明确功能要求，拓扑由 ${currentPlan.kind} 切换为 ${revised.kind}；请复核新的器件与接口条件。`);
  if (next.highRisk) revised.warnings.unshift('检测到高风险关键词：必须由具备资质的工程师复核隔离、保护、安规距离和失效模式。');
  // 电机驱动方案不允许降级为单管低边开关：正反转/制动必须保留 H 桥。
  if (currentPlan.kind === 'motor-driver' && ['low-side-driver', 'generic'].includes(change.kind)) {
    revised.warnings.push('已保留双 H 桥拓扑：正反转与制动无法用单个 MOSFET 低边开关实现，本次修订未降低驱动能力。');
  }
  return enrichPlanWithKnowledge(revised, next, knowledge);
}

export function supervisePlan(plan, requirement = '') {
  const parsed = parseRequirement(requirement || plan.requirement);
  const spec = { ...parsed, inputVoltage: plan.specs?.inputVoltage ?? parsed.inputVoltage, outputVoltage: plan.specs?.outputVoltage ?? parsed.outputVoltage, current: plan.specs?.current ?? parsed.current };
  const checks = [];
  const add = (status, title, detail) => checks.push({ status, title, detail });
  checks.push(...reviewNumericDesign(plan, parsed));

  add(plan.components?.length >= 2 ? 'pass' : 'fail', '器件与连接完整性', plan.components?.length >= 2 ? `已给出 ${plan.components.length} 组器件/功能件。` : '器件清单不足。');
  add(plan.connections?.length >= 2 ? 'pass' : 'fail', '网络关系', plan.connections?.length >= 2 ? `已生成 ${plan.connections.length} 条连接说明。` : '缺少连接关系。');
  const concreteParts = (plan.components || []).filter((item) => !/待定|核心处理|功能模块/i.test(`${item.value || ''} ${item.role || ''}`));
  add(concreteParts.length === (plan.components || []).length && concreteParts.length >= 2 ? 'pass' : 'warn', '具体器件与数值', concreteParts.length === (plan.components || []).length ? `已为 ${concreteParts.length} 项器件给出型号、数值或明确规格。` : '仍有待定功能块或器件，不能作为可接线首版。');
  if (plan.kind === 'led-driver') {
    const refs = new Set((plan.components || []).map((item) => item.ref));
    const complete = ['J1','F1','D2','R1','D1'].every((ref) => refs.has(ref));
    add(complete ? 'pass' : 'fail', 'LED 首版完整性', complete ? '输入、过流保护、反接保护、限流与发光器件齐全。' : 'LED 首版缺少输入、保护、限流或发光器件。');
  }
  if (plan.kind === 'motor-driver') {
    const refs = new Set((plan.components || []).map((item) => item.ref));
    const hasBridge = (plan.components || []).some((item) => /h\s*桥|h-bridge|全桥/i.test(`${item.value || ''} ${item.role || ''}`));
    const hasPowerProtection = ['F1','QREV1','DTVS1','CBULK1','CIN1'].every((ref) => refs.has(ref));
    const hasMeasuredCurrentInput = !(plan.missingParameters || []).some((item) => /堵转电流|启动电流/.test(item));
    add(hasBridge ? 'pass' : 'fail', '电机双向驱动拓扑', hasBridge ? '已使用双 H 桥，能够表达正反转、滑行和制动状态。' : '小车双向驱动不能退化为单管低边开关。');
    add(hasPowerProtection ? 'pass' : 'fail', '动力入口与回生保护', hasPowerProtection ? '保险、反接、TVS 评估、储能和高频去耦均已列入首版。' : '动力入口保护或回生吸收路径不完整。');
    add(hasMeasuredCurrentInput ? 'pass' : 'warn', '堵转电流依据', hasMeasuredCurrentInput ? `已按输入的 ${spec.current} A 电流建立筛选门槛；仍需确认该值的测量条件。` : '缺少堵转电流，只能输出参数化架构，不能定型 H 桥、保险、铜箔或连接器。');
  }
  if (['buck','boost','ldo'].includes(plan.kind)) {
    add(spec.inputVoltage != null ? 'pass' : 'warn', '输入电压', spec.inputVoltage != null ? `输入 ${spec.inputVoltage} V。` : '未给出输入电压范围。');
    add(spec.outputVoltage != null ? 'pass' : 'warn', '输出电压', spec.outputVoltage != null ? `输出 ${spec.outputVoltage} V。` : '未给出输出电压。');
    add(spec.current != null ? 'pass' : 'warn', '负载电流', spec.current != null ? `目标 ${spec.current} A。` : '未给出最大/持续负载电流。');
  }
  if (plan.kind === 'buck' && spec.inputVoltage != null && spec.outputVoltage != null) {
    add(spec.inputVoltage > spec.outputVoltage ? 'pass' : 'fail', '拓扑方向', spec.inputVoltage > spec.outputVoltage ? 'Buck 的输入高于输出。' : 'Buck 输入必须高于输出并留出调节余量。');
  }
  if (plan.kind === 'boost' && spec.inputVoltage != null && spec.outputVoltage != null) {
    add(spec.inputVoltage < spec.outputVoltage ? 'pass' : 'fail', '拓扑方向', spec.inputVoltage < spec.outputVoltage ? 'Boost 的输入低于输出。' : 'Boost 不适合输入不低于输出的全范围。');
  }
  add(plan.pcbTips?.length >= 2 ? 'pass' : 'warn', 'PCB 可实施性', plan.pcbTips?.length >= 2 ? '已附布局与回流路径提示。' : '缺少关键布局规则。');
  add(plan.nextSteps?.length >= 2 && plan.verificationPlan?.length >= 2 ? 'pass' : 'warn', '验证闭环', plan.verificationPlan?.length >= 2 ? `已列出 ${plan.verificationPlan.length} 项上电、应力或实测步骤。` : '缺少覆盖上电、应力和实测的验证步骤。');
  add(plan.knowledgeEvidence?.length ? 'pass' : 'warn', '可追溯依据', plan.knowledgeEvidence?.length ? `已匹配 ${plan.knowledgeEvidence.length} 条带公开来源的工程知识。` : '未匹配到带公开来源的专项规则；应以具体器件数据手册为准。');
  if (plan.missingParameters?.length) add('warn', '关键参数门禁', `仍缺少：${plan.missingParameters.join('、')}。当前只能作为参数化草案。`);
  const numericRisk = [plan.specs?.inputVoltage, plan.specs?.outputVoltage].some(value => Number.isFinite(value) && Math.abs(value) >= 60)
    || [plan.specs?.current, plan.designParameters?.targetCurrent, plan.designParameters?.stallCurrent].some(value => Number.isFinite(value) && Math.abs(value) >= 10);
  if (spec.highRisk || numericRisk) add('fail', '安全边界', '高压、市电、锂电或大电流设计不得只依据自动生成草案投板。');
  else add('pass', '安全关键词', '未检测到显式高风险关键词；仍需按实际电压、电流复核。');
  (plan.warnings || []).forEach((warning) => add('warn', '方案警告', warning));

  const penalty = checks.reduce((sum, check) => sum + (check.status === 'fail' ? 24 : check.status === 'warn' ? 7 : 0), 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));
  return {
    agent: '工程校验',
    score,
    decision: checks.some((item) => item.status === 'fail') ? '阻断投板' : checks.some((item) => item.status === 'warn') ? '补全后复核' : '通过概念审查',
    checks,
    disclaimer: '该审查用于概念设计辅助，不替代器件数据手册、ERC/DRC、仿真、样机测试与专业安全评审。',
  };
}

// 内存检索的领域同义词：与 SQLite 端 (knowledge-db.cjs) 的方向一致，让内置条目
// 与 SQL 片段在口语化查询下表现一致。
const KNOWLEDGE_SYNONYMS = Object.freeze({
  '降压': ['buck', '开关电源'],
  'buck': ['降压'],
  '升压': ['boost', '开关电源'],
  'boost': ['升压'],
  '稳压': ['ldo', '线性稳压', 'regulator'],
  'ldo': ['线性稳压', 'dropout'],
  '去耦': ['退耦', 'decoupling'],
  '退耦': ['去耦', 'decoupling'],
  '运放': ['opamp', '运算放大器', '放大器'],
  'opamp': ['运放', '运算放大器'],
  '运算放大器': ['运放', 'opamp'],
  '增益': ['gain', '放大'],
  '带宽': ['gbw', '增益带宽积'],
  '电机': ['马达', 'motor'],
  '马达': ['电机', 'motor'],
  '小车': ['电机驱动', 'h桥'],
  'h桥': ['h-bridge', '全桥'],
  '堵转': ['stall', '启动电流'],
  'pwm': ['调速', '占空比'],
  'mosfet': ['场效应管', '栅极'],
  'led': ['发光二极管', '指示灯'],
  '灯泡': ['led', '点亮'],
  '指示灯': ['led'],
  '保险': ['fuse', '保险丝', '过流保护'],
  'tvs': ['浪涌', '钳位'],
  '浪涌': ['tvs', '瞬态'],
  'esd': ['静电', '接口保护'],
  '反接': ['极性保护', '防反'],
  'mcu': ['单片机', '微控制器'],
  '单片机': ['mcu', '微控制器'],
  '晶振': ['crystal', '时钟'],
  '复位': ['reset', '监控'],
  'pcb': ['版图', '布局', '布线'],
  '布局': ['layout', 'pcb'],
  '接地': ['地平面', '回流'],
  '回流': ['地平面', '接地'],
  '整流': ['rectifier', '桥堆'],
  '滤波': ['filter', '低通'],
  '截止频率': ['rc', '低通'],
  '分压': ['电压采样'],
  'adc': ['采样', '模数转换'],
  '采样': ['adc', '采集'],
  '续流': ['flyback', '感性负载'],
  '继电器': ['relay'],
  '热设计': ['散热', '结温'],
  '结温': ['热阻', '温升'],
  'emi': ['电磁干扰', '噪声'],
  '锂电': ['锂电池', 'bms'],
  '隔离': ['光耦'],
  '上拉': ['pull-up', 'i2c'],
  '下拉': ['pull-down', '默认电平'],
});

function expandKnowledgeTokens(rawQuery, tokens) {
  const expanded = new Set(tokens);
  const haystack = `${rawQuery} ${tokens.join(' ')}`.toLowerCase();
  for (const [key, synonyms] of Object.entries(KNOWLEDGE_SYNONYMS)) {
    if (!haystack.includes(key)) continue;
    for (const synonym of synonyms) expanded.add(synonym.toLowerCase());
  }
  // 整句中文查询切出双字词：没有标点的长查询也能逐词命中（与 SQLite 端一致）。
  for (const token of [...expanded]) {
    if (/^[\u3400-\u9fff]+$/.test(token) && token.length > 2) {
      for (let index = 0; index < token.length - 1; index += 1) expanded.add(token.slice(index, index + 2));
    }
  }
  return [...expanded];
}

export function knowledgeSearch(entries, query, limit = 6) {
  const rawQuery = String(query || '').toLowerCase();
  const originalTokens = rawQuery.split(/[\s,，。;；/、：:→+()（）]+/).filter(Boolean);
  const tokens = expandKnowledgeTokens(rawQuery, originalTokens);
  return (entries || []).map((entry) => {
    const haystack = `${entry.title || ''} ${(entry.tags || []).join(' ')} ${entry.summary || ''} ${entry.content || ''}`.toLowerCase();
    const tags = (entry.tags || []).map((tag) => String(tag).toLowerCase());
    const tokenScore = tokens.reduce((sum, token) => sum + (haystack.includes(token) ? (originalTokens.includes(token) ? 2 : 1) : 0) + (tags.includes(token) ? 4 : 0), 0);
    const phraseScore = tags.reduce((sum, tag) => sum + (tag.length >= 2 && rawQuery.includes(tag) ? 5 : 0), 0);
    const title = String(entry.title || '').toLowerCase();
    const titleScore = tokens.some((token) => token.length >= 2 && title.includes(token)) ? 3 : 0;
    const semanticScore = tokenScore + phraseScore + titleScore;
    const sourceBonus = semanticScore > 0 && entry.verified === true && entry.source?.url ? 1 : 0;
    const score = tokens.length || rawQuery ? semanticScore + sourceBonus : 1;
    return { ...entry, _score: score };
  }).filter((entry) => entry._score > 0).sort((a,b) => b._score - a._score).slice(0, limit);
}

export function ingestTextDocument(file, index = 0) {
  const content = String(file.content || '').replace(/\r/g, '').trim();
  const lines = content.split('\n').map((line) => line.trim()).filter(Boolean);
  const title = (lines[0] || file.name || `导入资料 ${index + 1}`).replace(/^#+\s*/, '').slice(0, 80);
  const tags = [...new Set((content.match(/buck|boost|ldo|mosfet|运放|电源|滤波|整流|mcu|pcb|退耦|接地/gi) || []).map((item) => item.toLowerCase()))].slice(0, 8);
  return {
    id: `user-${Date.now()}-${index}`,
    title,
    category: '用户资料',
    tags,
    summary: lines.slice(1, 4).join(' ').slice(0, 240) || '用户导入的本地电路资料。',
    content: content.slice(0, 100_000),
    source: { title: file.name || '本地文件', url: '' },
    importedAt: new Date().toISOString(),
    verified: false,
  };
}

export function planToCsv(plan) {
  const quote = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return ['Ref,Value,Role,Footprint', ...(plan.components || []).map((item) => [item.ref,item.value,item.role,item.footprint].map(quote).join(','))].join('\r\n');
}

export function planToBundle(plan, audit) {
  return JSON.stringify({ format: 'circuit-assistant-v1', generatedBy: '电路助手 Studio 0.8.0', plan, audit, notice: '参考原理图交换文件；导入 EDA 前必须复核器件引脚、封装、网络、额定值并完成验证。' }, null, 2);
}

export const COMPONENT_LIBRARY = Object.freeze([
  { type: 'resistor', name: '电阻', prefix: 'R', value: '10 kΩ', category: '无源器件', icon: 'R', description: '限流、偏置、反馈与终端' },
  { type: 'potentiometer', name: '电位器', prefix: 'RV', value: '10 kΩ', category: '无源器件', icon: 'RV', description: '可调分压、增益与阈值设定' },
  { type: 'thermistor', name: '热敏电阻', prefix: 'RT', value: 'NTC 10K', category: '无源器件', icon: 'RT', aliases: ['ntc', '温度', '感温'], description: 'NTC/PTC 温度检测与浪涌抑制' },
  { type: 'varistor', name: '压敏电阻', prefix: 'RV', value: '14D431K', category: '无源器件', icon: 'RV', aliases: ['mov', '浪涌吸收'], description: '过压吸收与电源入口浪涌保护' },
  { type: 'photoresistor', name: '光敏电阻', prefix: 'RL', value: 'GL5528', category: '无源器件', icon: 'RL', aliases: ['光电阻', '光感'], description: '环境光检测与光控开关' },
  { type: 'ferrite-bead', name: '磁珠', prefix: 'FB', value: '600Ω@100MHz', category: '无源器件', icon: 'FB', aliases: ['滤波', '噪声'], description: '高频噪声抑制与电源隔离' },
  { type: 'capacitor', name: '电容', prefix: 'C', value: '100 nF', category: '无源器件', icon: 'C', description: '退耦、滤波与储能' },
  { type: 'electrolytic', name: '电解电容', prefix: 'C', value: '100 µF / 25 V', category: '无源器件', icon: 'C+', description: '有极性储能、整流滤波与低频旁路' },
  { type: 'tantalum', name: '钽电容', prefix: 'C', value: '10 µF / 16 V', category: '无源器件', icon: 'C+', aliases: ['钽'], description: '小体积大容量储能，注意耐压降额' },
  { type: 'inductor', name: '电感', prefix: 'L', value: '10 µH', category: '无源器件', icon: 'L', description: '储能、滤波与阻抗匹配' },
  { type: 'crystal', name: '晶振', prefix: 'Y', value: '8 MHz', category: '无源器件', icon: 'Y', description: 'MCU 时钟与精密频率基准' },
  { type: 'transformer', name: '变压器', prefix: 'T', value: '1:1', category: '无源器件', icon: 'T', description: '隔离、升降压与阻抗变换' },
  { type: 'diode', name: '二极管', prefix: 'D', value: '1N4148', category: '半导体', icon: 'D', description: '整流、钳位与保护' },
  { type: 'schottky', name: '肖特基二极管', prefix: 'D', value: 'SS14', category: '半导体', icon: 'SD', description: '低压降整流、续流与 OR-ing' },
  { type: 'zener', name: '齐纳二极管', prefix: 'D', value: '5.1 V', category: '半导体', icon: 'ZD', description: '稳压、基准与过压钳位' },
  { type: 'tvs-diode', name: 'TVS 二极管', prefix: 'D', value: 'SMAJ5.0A', category: '半导体', icon: 'TVS', aliases: ['瞬态抑制', '浪涌'], description: 'ESD 与浪涌瞬态钳位保护' },
  { type: 'photodiode', name: '光敏二极管', prefix: 'D', value: 'PD', category: '半导体', icon: 'PD', aliases: ['接收管'], description: '光信号接收与光电检测' },
  { type: 'led', name: 'LED', prefix: 'D', value: 'LED', category: '半导体', icon: 'LED', description: '发光指示' },
  { type: 'bjt', name: '三极管', prefix: 'Q', value: 'NPN 2N3904', category: '半导体', icon: 'Q', description: '小信号放大、开关与偏置' },
  { type: 'mosfet', name: 'N-MOSFET', prefix: 'Q', value: 'Logic NMOS', category: '半导体', icon: 'Q', description: '低边开关与功率控制' },
  { type: 'pmosfet', name: 'P-MOSFET', prefix: 'Q', value: 'Logic PMOS', category: '半导体', icon: 'Q', description: '高边开关与反接保护' },
  { type: 'scr', name: '单向可控硅', prefix: 'Q', value: 'BT151', category: '半导体', icon: 'SCR', aliases: ['晶闸管', 'scr'], description: '大功率半波控制与过压保护' },
  { type: 'triac', name: '双向可控硅', prefix: 'Q', value: 'BTA16', category: '半导体', icon: 'TRIAC', aliases: ['调光', '交流控制'], description: '交流负载调压与调光控制' },
  { type: 'igbt', name: 'IGBT', prefix: 'Q', value: 'IGBT', category: '半导体', icon: 'IGBT', aliases: ['绝缘栅'], description: '高压大电流功率开关' },
  { type: 'opto', name: '光耦', prefix: 'U', value: 'PC817', category: '半导体', icon: 'OC', description: '信号隔离与电平转换' },
  { type: 'opamp', name: '运算放大器', prefix: 'U', value: 'OP AMP', category: '模拟与集成', icon: '△', description: '放大、滤波与信号调理' },
  { type: 'comparator', name: '比较器', prefix: 'U', value: 'LM393', category: '模拟与集成', icon: 'CMP', description: '阈值检测、窗口比较与整形' },
  { type: 'ic', name: '集成电路', prefix: 'U', value: 'IC', category: '模拟与集成', icon: 'IC', description: '控制器、稳压器或主控' },
  { type: 'timer', name: '555 定时器', prefix: 'U', value: 'NE555', category: '模拟与集成', icon: '555', description: '振荡与定时' },
  { type: 'voltage-regulator', name: '稳压器', prefix: 'U', value: 'LDO 3.3 V', category: '模拟与集成', icon: 'REG', description: '线性稳压、使能与电源管理' },
  { type: 'logic-gate', name: '逻辑门', prefix: 'U', value: '74HC00', category: '模拟与集成', icon: 'AND', description: '数字逻辑、组合与时序控制' },
  { type: 'source', name: '直流电源', prefix: 'V', value: '5 V', category: '电源与接口', icon: 'V', description: '直流电压源' },
  { type: 'battery', name: '电池', prefix: 'B', value: '3.7 V', category: '电源与接口', icon: 'BAT', description: '电池或电池组输入' },
  { type: 'battery-holder', name: '电池座', prefix: 'BT', value: 'CR2032', category: '电源与接口', icon: 'BT', aliases: ['纽扣电池', '电池盒'], description: '纽扣电池或电池盒安装座' },
  { type: 'ground', name: '参考地', prefix: 'GND', value: 'GND', category: '电源与接口', icon: '⏚', description: '电路参考节点' },
  { type: 'connector', name: '连接器', prefix: 'J', value: 'CONN', category: '电源与接口', icon: 'J', description: '板外输入输出接口' },
  { type: 'header', name: '排针', prefix: 'J', value: '1×4 P2.54', category: '电源与接口', icon: 'J', aliases: ['排母', 'pin header'], description: '板间连接与调试引出' },
  { type: 'jumper', name: '跳线', prefix: 'JP', value: 'JMP', category: '电源与接口', icon: 'JP', aliases: ['选择跳线'], description: '配置选择与电路断接' },
  { type: 'usb-port', name: 'USB 接口', prefix: 'J', value: 'USB-A', category: '电源与接口', icon: 'USB', aliases: ['type-c', 'typec'], description: 'USB 供电与数据接口' },
  { type: 'dc-jack', name: 'DC 电源座', prefix: 'J', value: 'DC-005', category: '电源与接口', icon: 'DC', aliases: ['电源插座'], description: '5.5×2.1 适配器输入接口' },
  { type: 'switch', name: '开关', prefix: 'SW', value: 'SWITCH', category: '电源与接口', icon: 'SW', description: '手动或受控断接' },
  { type: 'push-button', name: '按键开关', prefix: 'SW', value: '6×6 按键', category: '电源与接口', icon: 'SW', aliases: ['按钮', '轻触开关', 'reset'], description: '瞬时按压控制与复位输入' },
  { type: 'dip-switch', name: '拨码开关', prefix: 'SW', value: '2 位拨码', category: '电源与接口', icon: 'SW', aliases: ['地址开关'], description: '多位配置选择与地址设定' },
  { type: 'testpoint', name: '测试点', prefix: 'TP', value: 'TEST', category: '电源与接口', icon: 'TP', description: '示波器、万用表与生产测试探针' },
  { type: 'antenna', name: '天线', prefix: 'E', value: 'ANT 433M', category: '电源与接口', icon: 'ANT', aliases: ['馈线'], description: '射频信号辐射与接收' },
  { type: 'fuse', name: '保险丝', prefix: 'F', value: 'PTC', category: '保护', icon: 'F', description: '输入或支路过流保护' },
  { type: 'relay', name: '继电器', prefix: 'K', value: '5 V Relay', category: '执行器', icon: 'K', description: '隔离触点、负载切换与控制' },
  { type: 'motor', name: '直流电机', prefix: 'M', value: '6 V DC Motor', category: '执行器', icon: 'M', description: '电机、风扇与泵类负载' },
  { type: 'stepper', name: '步进电机', prefix: 'M', value: '28BYJ-48', category: '执行器', icon: 'M', aliases: ['步进'], description: '角度定位与精确运动控制' },
  { type: 'servo', name: '舵机', prefix: 'M', value: 'SG90', category: '执行器', icon: 'M', aliases: ['伺服'], description: 'PWM 角度控制机械臂/云台' },
  { type: 'fan', name: '风扇', prefix: 'M', value: '5V FAN', category: '执行器', icon: 'M', aliases: ['散热风扇'], description: '散热强迫风冷' },
  { type: 'solenoid', name: '电磁铁', prefix: 'YV', value: 'Solenoid', category: '执行器', icon: 'YV', aliases: ['电磁阀'], description: '电磁驱动锁具与阀门' },
  { type: 'buzzer', name: '蜂鸣器', prefix: 'BZ', value: '5 V Buzzer', category: '执行器', icon: 'BZ', description: '声音提示与报警输出' },
  { type: 'speaker', name: '扬声器', prefix: 'LS', value: '8Ω 0.5W', category: '执行器', icon: 'LS', aliases: ['喇叭', 'audio'], description: '音频播放与语音输出' },
  { type: 'mic', name: '驻极体麦克风', prefix: 'MK', value: '9.7mm', category: '执行器', icon: 'MK', aliases: ['咪头', '声音传感'], description: '声音采集与声控输入' },
  { type: 'ir-receiver', name: '红外接收头', prefix: 'U', value: 'VS1838B', category: '功能模块', icon: 'IR', aliases: ['遥控接收', '红外'], description: '38kHz 红外遥控信号接收' },
  { type: 'sensor3', name: '三引脚传感器', prefix: 'U', value: 'SENSOR 3P', category: '功能模块', icon: 'S', aliases: ['dht11', 'ds18b20', '温度'], description: 'VCC/DATA/GND 三线传感器' },
  { type: 'sensor4', name: 'I2C 传感器', prefix: 'U', value: 'SENSOR I2C', category: '功能模块', icon: 'S', aliases: ['mpu6050', 'bmp280', 'bh1750'], description: 'VCC/GND/SCL/SDA 四线 I2C 传感器' },
  { type: 'sonar', name: '超声波模块', prefix: 'U', value: 'HC-SR04', category: '功能模块', icon: 'US', aliases: ['测距', '超声'], description: 'Trig/Echo 测距模块' },
  { type: 'lcd', name: '显示屏', prefix: 'U', value: 'LCD1602', category: '功能模块', icon: 'LCD', aliases: ['oled', '液晶', '显示'], description: '字符/点阵显示模块（I2C/SPI）' },
  { type: 'wireless-module', name: '无线模块', prefix: 'U', value: 'RF MODULE', category: '功能模块', icon: 'RF', aliases: ['蓝牙', 'wifi', 'lora', 'nrf24', 'gps'], description: '串口透明传输无线模组' },
  { type: 'block', name: '功能模块', prefix: 'B', value: 'MODULE', category: '功能模块', icon: '▣', description: '自定义功能块' },
  { type: 'mcu', name: '微控制器', prefix: 'U', value: 'MCU', category: '功能模块', icon: 'µC', description: '数字控制与处理' },
]);

// 市场元件库：仿嘉立创 EDA 的常用器件预设。part 是市场上真实可买到的型号，
// symbolType 指向 COMPONENT_LIBRARY 中的符号；点击/拖入即放置为带型号的元件。
// 价格与库存以立创商城等供应商实时信息为准，这里不保存价格。
export const MARKET_PARTS_LIBRARY = Object.freeze([
  // —— 主控与逻辑 ——
  { id: 'mkt-stm32f103', part: 'STM32F103C8T6', name: 'ARM Cortex-M3 单片机', group: '主控与逻辑', symbolType: 'mcu', value: 'STM32F103C8T6', footprint: 'LQFP-48', specs: '72MHz · 64KB Flash · 20KB RAM', description: '最常用的入门 ARM 单片机，蓝板同款主控。' },
  { id: 'mkt-atmega328', part: 'ATMEGA328P-AU', name: '8 位 AVR 单片机', group: '主控与逻辑', symbolType: 'mcu', value: 'ATMEGA328P-AU', footprint: 'TQFP-32', specs: '16MHz · 32KB Flash · Arduino UNO 同款', description: 'Arduino UNO/Nano 同款 8 位单片机。' },
  { id: 'mkt-esp32wroom', part: 'ESP32-WROOM-32E', name: 'WiFi/蓝牙双核模组', group: '主控与逻辑', symbolType: 'wireless-module', value: 'ESP32-WROOM-32E', footprint: '模组 18×25.5mm', specs: '240MHz 双核 · WiFi+BT4.2', description: '带 WiFi 与蓝牙的集成模组，物联网首选。' },
  { id: 'mkt-esp12f', part: 'ESP-12F (ESP8266)', name: 'WiFi 模组', group: '主控与逻辑', symbolType: 'wireless-module', value: 'ESP-12F', footprint: '模组 16×24mm', specs: '80MHz · 4MB Flash · WiFi', description: '低成本 WiFi 模组，NodeMCU 同款。' },
  { id: 'mkt-ne555', part: 'NE555P', name: '定时器', group: '主控与逻辑', symbolType: 'timer', value: 'NE555', footprint: 'DIP-8 / SOP-8', specs: '4.5–16V · 经典振荡/定时', description: '经典 555 定时器，振荡与 PWM 生成。' },
  { id: 'mkt-74hc595', part: '74HC595D', name: '8 位移位寄存器', group: '主控与逻辑', symbolType: 'ic', value: '74HC595', footprint: 'SOIC-16', specs: '2–6V · 串入并出', description: '用 3 个 IO 扩展 8 个输出口。' },
  { id: 'mkt-74hc00', part: '74HC00D', name: '四路与非门', group: '主控与逻辑', symbolType: 'logic-gate', value: '74HC00', footprint: 'SOIC-14', specs: '2–6V · 4×NAND', description: '基础逻辑门，搭建组合/时序逻辑。' },

  // —— 电源管理 ——
  { id: 'mkt-ams1117', part: 'AMS1117-3.3', name: 'LDO 稳压器 3.3V', group: '电源管理', symbolType: 'voltage-regulator', value: 'AMS1117-3.3', footprint: 'SOT-223', specs: '1A · 最大压差约 1.1V', description: '最常用的 3.3V 线性稳压，注意热与压差。' },
  { id: 'mkt-lm7805', part: 'LM7805', name: '线性稳压器 5V', group: '电源管理', symbolType: 'voltage-regulator', value: 'LM7805', footprint: 'TO-220', specs: '1A · 输入 7–35V', description: '经典 7805 三端稳压，压差大时注意发热。' },
  { id: 'mkt-lm2596', part: 'LM2596S-5.0', name: '降压开关电源 3A', group: '电源管理', symbolType: 'ic', value: 'LM2596S-5.0', footprint: 'TO-263-5', specs: '4.5–40V 输入 · 3A · 150kHz', description: '大电流降压模块常用芯片，5V 固定输出版。' },
  { id: 'mkt-mp1584', part: 'MP1584EN', name: '同步降压 3A', group: '电源管理', symbolType: 'ic', value: 'MP1584EN', footprint: 'SOIC-8 EP', specs: '4.5–28V 输入 · 3A · 1.5MHz', description: '小型化高效率降压，常见于模块电源。' },
  { id: 'mkt-mt3608', part: 'MT3608', name: '升压转换器', group: '电源管理', symbolType: 'ic', value: 'MT3608', footprint: 'SOT-23-6', specs: '2–24V 输入 · 最高 28V 输出 · 1.2MHz', description: '低成本升压芯片，注意最低输入电压下的峰值电流。' },
  { id: 'mkt-tp4056', part: 'TP4056', name: '锂电池充电管理', group: '电源管理', symbolType: 'ic', value: 'TP4056', footprint: 'SOP-8', specs: '1A 线性充电 · 4.2V 截止', description: '单节锂电充电芯片，需配合保护板使用。' },

  // —— 电机与功率 ——
  { id: 'mkt-l298n', part: 'L298N', name: '双 H 桥电机驱动', group: '电机与功率', symbolType: 'ic', value: 'L298N', footprint: 'Multiwatt15', specs: '最高 46V · 2A/路 · 压降较大', description: '经典双 H 桥，适合大电压有刷电机。' },
  { id: 'mkt-tb6612', part: 'TB6612FNG', name: '双 H 桥电机驱动', group: '电机与功率', symbolType: 'ic', value: 'TB6612FNG', footprint: 'SSOP-24', specs: '15V · 1.2A/路 · 3.3/5V 控制', description: '低压高效双 H 桥，小车驱动常用。' },
  { id: 'mkt-drv8833', part: 'DRV8833PWP', name: '双 H 桥电机驱动', group: '电机与功率', symbolType: 'ic', value: 'DRV8833', footprint: 'HTSSOP-16', specs: '2.7–10.8V · 1.5A/路', description: '低压大电流双 H 桥，内置保护。' },
  { id: 'mkt-a4988', part: 'A4988', name: '步进电机驱动', group: '电机与功率', symbolType: 'ic', value: 'A4988', footprint: 'QFN-28', specs: '8–35V · 2A 峰值 · 细分可选', description: '步进电机细分驱动，3D 打印机同款。' },
  { id: 'mkt-uln2003', part: 'ULN2003ADR', name: '达林顿阵列', group: '电机与功率', symbolType: 'ic', value: 'ULN2003A', footprint: 'SOIC-16', specs: '7 通道 · 500mA/通道 · 带续流', description: '驱动继电器/步进的七路达林顿。' },
  { id: 'mkt-irlz44n', part: 'IRLZ44N', name: 'N 沟道功率 MOSFET', group: '电机与功率', symbolType: 'mosfet', value: 'IRLZ44N', footprint: 'TO-220', specs: '55V · 47A · 逻辑电平栅极', description: '逻辑电平驱动的大电流 MOSFET。' },
  { id: 'mkt-ao3400', part: 'AO3400A', name: 'N-MOSFET 贴片', group: '电机与功率', symbolType: 'mosfet', value: 'AO3400A', footprint: 'SOT-23', specs: '30V · 5.7A · 1.8V 可驱动', description: '小体积低边开关，3.3V GPIO 可直接驱动。' },
  { id: 'mkt-bta16', part: 'BTA16-600B', name: '双向可控硅', group: '电机与功率', symbolType: 'triac', value: 'BTA16-600B', footprint: 'TO-220', specs: '600V · 16A', description: '交流调压/调光功率器件，需隔离触发。' },
  { id: 'mkt-smaj5a', part: 'SMAJ5.0A', name: 'TVS 二极管', group: '电机与功率', symbolType: 'tvs-diode', value: 'SMAJ5.0A', footprint: 'SMA', specs: '5V 反向 · 400W 峰值', description: 'USB/低压接口浪涌钳位。' },
  { id: 'mkt-ss14', part: 'SS14', name: '肖特基二极管', group: '电机与功率', symbolType: 'schottky', value: 'SS14', footprint: 'SMA', specs: '40V · 1A · 压降约 0.3V', description: '反接保护与续流的常用选择。' },
  { id: 'mkt-1n4007', part: '1N4007', name: '整流二极管', group: '电机与功率', symbolType: 'diode', value: '1N4007', footprint: 'DO-41', specs: '1000V · 1A', description: '通用整流与续流二极管。' },

  // —— 传感器 ——
  { id: 'mkt-dht11', part: 'DHT11', name: '温湿度传感器', group: '传感器', symbolType: 'sensor3', value: 'DHT11', footprint: '模组 12×15.5mm', specs: '单总线 · 温度±2℃ · 湿度±5%RH', description: '最常见温湿度传感器，单总线读取。' },
  { id: 'mkt-ds18b20', part: 'DS18B20', name: '数字温度传感器', group: '传感器', symbolType: 'sensor3', value: 'DS18B20', footprint: 'TO-92', specs: '单总线 · -55~+125℃ · ±0.5℃', description: '单总线温度传感器，支持多点组网。' },
  { id: 'mkt-hcsr04', part: 'HC-SR04', name: '超声波测距模块', group: '传感器', symbolType: 'sonar', value: 'HC-SR04', footprint: '模组 45×20mm', specs: '2cm–4m · Trig/Echo', description: '经典超声波测距，避叉车/机器人常用。' },
  { id: 'mkt-hcsr501', part: 'HC-SR501', name: '人体红外感应', group: '传感器', symbolType: 'sensor3', value: 'HC-SR501', footprint: '模组 32×24mm', specs: 'PIR · 7m · 输出 3.3V', description: '人体感应开关，感应灯常用。' },
  { id: 'mkt-mpu6050', part: 'MPU6050', name: '六轴姿态传感器', group: '传感器', symbolType: 'sensor4', value: 'MPU6050', footprint: 'QFN-24 / 模组', specs: '三轴加速度+陀螺仪 · I2C', description: '平衡车/云台常用姿态传感器。' },
  { id: 'mkt-bmp280', part: 'BMP280', name: '气压传感器', group: '传感器', symbolType: 'sensor4', value: 'BMP280', footprint: 'LGA-8 / 模组', specs: '300–1100hPa · I2C/SPI', description: '气压海拔与天气站常用。' },
  { id: 'mkt-bh1750', part: 'BH1750', name: '光照传感器', group: '传感器', symbolType: 'sensor4', value: 'BH1750', footprint: 'WSOF6I / 模组', specs: '1–65535 lx · I2C', description: '数字光照度传感器，直接输出勒克斯。' },
  { id: 'mkt-mq2', part: 'MQ-2', name: '烟雾气体传感器', group: '传感器', symbolType: 'sensor3', value: 'MQ-2', footprint: '模组 32×22mm', specs: '烟雾/可燃气体 · 模拟输出', description: '烟雾报警与燃气检测。' },

  // —— 无线与通信 ——
  { id: 'mkt-hc05', part: 'HC-05', name: '蓝牙串口模块', group: '无线与通信', symbolType: 'wireless-module', value: 'HC-05', footprint: '模组 26.9×13mm', specs: 'BT2.0 SPP · AT 命令配置', description: '透明串口蓝牙，透传调试常用。' },
  { id: 'mkt-nrf24', part: 'NRF24L01+', name: '2.4G 无线模块', group: '无线与通信', symbolType: 'wireless-module', value: 'NRF24L01+', footprint: 'DIP 模组 29×15mm', specs: 'SPI · 2Mbps · 多通道', description: '低功耗 2.4G 组网遥控常用。' },
  { id: 'mkt-sx1278', part: 'SX1278 LoRa', name: 'LoRa 远距离模块', group: '无线与通信', symbolType: 'wireless-module', value: 'SX1278 433MHz', footprint: 'DIP 模组 16×17mm', specs: 'LoRa 调制 · 数公里距离', description: '远距离低速率物联网组网。' },
  { id: 'mkt-max485', part: 'MAX485', name: 'RS-485 收发器', group: '无线与通信', symbolType: 'ic', value: 'MAX485', footprint: 'DIP-8 / SOP-8', specs: '半双工 · 2.5Mbps', description: '工业总线 RS-485 收发。' },
  { id: 'mkt-max3232', part: 'MAX3232', name: 'RS-232 电平转换', group: '无线与通信', symbolType: 'ic', value: 'MAX3232', footprint: 'SOIC-16', specs: '双通道 · 3–5.5V 供电', description: '与 RS-232 设备通信的电平转换。' },
  { id: 'mkt-neo6m', part: 'Neo-6M GPS', name: 'GPS 定位模块', group: '无线与通信', symbolType: 'wireless-module', value: 'u-blox NEO-6M', footprint: '模组带陶瓷天线', specs: 'UART NMEA 输出', description: '定位与授时模块，串口读取。' },

  // —— 显示与人机交互 ——
  { id: 'mkt-lcd1602', part: 'LCD1602', name: '字符液晶屏', group: '显示与交互', symbolType: 'lcd', value: 'LCD1602', footprint: '16 引脚 2.54mm', specs: '16×2 字符 · 5V · 可接 I2C 转接板', description: '经典两行字符屏。' },
  { id: 'mkt-oled096', part: '0.96" OLED', name: 'OLED 显示屏', group: '显示与交互', symbolType: 'lcd', value: 'SSD1306 0.96"', footprint: 'I2C 4P', specs: '128×64 · I2C/SPI · 3.3–5V', description: '小型点阵 OLED，仪表显示常用。' },
  { id: 'mkt-tm1637', part: 'TM1637', name: '数码管驱动', group: '显示与交互', symbolType: 'ic', value: 'TM1637', footprint: 'SOP-20 / 模组', specs: '4 位数码管 · 两线控制', description: '带按键扫描的数码管驱动。' },
  { id: 'mkt-vs1838', part: 'VS1838B', name: '红外接收头', group: '显示与交互', symbolType: 'ir-receiver', value: 'VS1838B', footprint: 'DIP-3', specs: '38kHz 载波 · 遥控接收', description: '通用红外遥控接收头。' },
  { id: 'mkt-sg90', part: 'SG90', name: '9g 舵机', group: '显示与交互', symbolType: 'servo', value: 'SG90', footprint: '三线 2.54mm', specs: 'PWM 50Hz · 约 180°', description: '小型舵机，云台与机械臂常用。' },
  { id: 'mkt-28byj48', part: '28BYJ-48', name: '步进电机', group: '显示与交互', symbolType: 'stepper', value: '28BYJ-48', footprint: '四线 + 公共端', specs: '5V · 减速比 1:64', description: '常配 ULN2003 驱动的小步进电机。' },

  // —— 存储与接口转换 ——
  { id: 'mkt-ch340', part: 'CH340G', name: 'USB 转串口', group: '存储与接口', symbolType: 'ic', value: 'CH340G', footprint: 'SOP-16', specs: 'USB 全速 · UART 波特率最高 2Mbps', description: '下载调试 USB 串口芯片。' },
  { id: 'mkt-w25q64', part: 'W25Q64JVSSIQ', name: 'SPI Flash 8MB', group: '存储与接口', symbolType: 'ic', value: 'W25Q64', footprint: 'SOIC-8', specs: '64Mbit · SPI · 80MHz', description: '固件与数据存储 SPI Flash。' },
  { id: 'mkt-at24c02', part: 'AT24C02', name: 'EEPROM 2Kbit', group: '存储与接口', symbolType: 'ic', value: 'AT24C02', footprint: 'SOP-8', specs: '256 字节 · I2C', description: '掉电保存参数的 I2C EEPROM。' },
  { id: 'mkt-pc817', part: 'PC817', name: '光耦', group: '存储与接口', symbolType: 'opto', value: 'PC817', footprint: 'DIP-4', specs: 'CTRI 50–600% · 5kV 隔离', description: '信号隔离常用光耦。' },
  { id: 'mkt-sn74lvc245', part: 'SN74LVC245A', name: '电平转换/总线收发', group: '存储与接口', symbolType: 'ic', value: '74LVC245', footprint: 'SOIC-20', specs: '1.65–3.6V · 8 位双向', description: '3.3V↔5V 总线电平转换。' },

  // —— 常用基础件 ——
  { id: 'mkt-r0603-10k', part: '0603 10kΩ ±1%', name: '贴片电阻', group: '常用基础件', symbolType: 'resistor', value: '10 kΩ', footprint: '0603', specs: '1/10W · 厚膜', description: '万能阻值，上下拉/分压/限流常备。' },
  { id: 'mkt-c0805-104', part: '0805 100nF X7R', name: '贴片电容', group: '常用基础件', symbolType: 'capacitor', value: '100 nF', footprint: '0805', specs: '50V · X7R', description: '每个芯片电源引脚的去耦标配。' },
  { id: 'mkt-cel-100u', part: '100µF/25V 电解', name: '铝电解电容', group: '常用基础件', symbolType: 'electrolytic', value: '100 µF / 25 V', footprint: 'φ6.3×7.7', specs: '25V · 注意纹波电流与寿命', description: '电源储能与低频滤波。' },
  { id: 'mkt-tant-10u', part: '10µF/16V 钽', name: '钽电容', group: '常用基础件', symbolType: 'tantalum', value: '10 µF / 16 V', footprint: '3216/3528', specs: '16V · 降额到 50% 使用更可靠', description: '小体积储能，注意耐压降额。' },
  { id: 'mkt-l-cd', part: 'CD 系列 10µH 功率电感', name: '功率电感', group: '常用基础件', symbolType: 'inductor', value: '10 µH', footprint: 'CD54/CD75', specs: '额定电流按饱和电流选', description: 'Buck/Boost 储能电感，注意 Isat。' },
  { id: 'mkt-xtal-8m', part: '8MHz HC-49S', name: '无源晶振', group: '常用基础件', symbolType: 'crystal', value: '8 MHz', footprint: 'HC-49S', specs: '±20ppm · CL=20pF', description: 'MCU 外部主时钟。' },
  { id: 'mkt-xtal-32768', part: '32.768kHz', name: '表晶', group: '常用基础件', symbolType: 'crystal', value: '32.768 kHz', footprint: '3215/圆柱', specs: 'CL=12.5pF', description: 'RTC 时钟源。' },
  { id: 'mkt-fuse-500ma', part: '1206 自恢复 0.5A', name: 'PTC 自恢复保险丝', group: '常用基础件', symbolType: 'fuse', value: 'PTC 0.5A', footprint: '1206', specs: '0.5A 保持 · 6V', description: 'USB/接口过流保护。' },
  { id: 'mkt-ntc-10k', part: 'NTC 10K B3950', name: '热敏电阻', group: '常用基础件', symbolType: 'thermistor', value: 'NTC 10K B3950', footprint: 'MF52 引线型', specs: '25℃ 10kΩ · B=3950', description: '温度采集与浪涌抑制。' },
  { id: 'mkt-mov-431', part: '14D431K', name: '压敏电阻', group: '常用基础件', symbolType: 'varistor', value: '14D431K', footprint: '引线 14D', specs: '430V 钳位 · 浪涌吸收', description: '电源入口浪涌防护（配合保险使用）。' },
  { id: 'mkt-gl5528', part: 'GL5528', name: '光敏电阻', group: '常用基础件', symbolType: 'photoresistor', value: 'GL5528', footprint: 'φ5mm', specs: '亮阻 10–20kΩ · 暗阻 1MΩ', description: '光控开关与亮度检测。' },
  { id: 'mkt-fb-600', part: '0603 磁珠 600Ω', name: '铁氧体磁珠', group: '常用基础件', symbolType: 'ferrite-bead', value: '600Ω@100MHz', footprint: '0603', specs: '600Ω@100MHz · 500mA', description: '模拟电源与数字电源之间的隔离。' },
  { id: 'mkt-btn-6x6', part: '6×6×5 轻触按键', name: '轻触开关', group: '常用基础件', symbolType: 'push-button', value: 'SW-SPST NO', footprint: 'DIP-4 6×6', specs: '瞬时 · 50mA', description: '复位/模式按键。' },
  { id: 'mkt-dip2', part: '2 位拨码开关', name: '拨码开关', group: '常用基础件', symbolType: 'dip-switch', value: 'DIP-2', footprint: '2.54mm 间距', specs: '2 位 · 25/100mA', description: '地址/模式配置。' },
  { id: 'mkt-dc005', part: 'DC-005 5.5×2.1', name: 'DC 电源座', group: '常用基础件', symbolType: 'dc-jack', value: 'DC-005', footprint: 'DC-005 5.5×2.1mm', specs: '适配器输入 · 3 引脚带切换', description: '适配器输入标准座。' },
  { id: 'mkt-usba', part: 'USB-A 母座', name: 'USB 接口', group: '常用基础件', symbolType: 'usb-port', value: 'USB-A 母座', footprint: 'DIP 直插/贴片', specs: '4P · 5V/500mA 起', description: 'USB 供电与数据接口。' },
  { id: 'mkt-header4', part: '排针 1×4 P2.54', name: '排针连接器', group: '常用基础件', symbolType: 'header', value: '1×4 P2.54', footprint: '直排/弯排', specs: '3A/针 · 可做排母配对', description: '模块接口与调试引出。' },
  { id: 'mkt-cr2032', part: 'CR2032 电池座', name: '纽扣电池座', group: '常用基础件', symbolType: 'battery-holder', value: 'CR2032', footprint: 'CR2032 卧式', specs: '3V · 约 220mAh', description: 'RTC 后备电源。' },
  { id: 'mkt-speaker8r', part: '8Ω 0.5W 小喇叭', name: '扬声器', group: '常用基础件', symbolType: 'speaker', value: '8Ω 0.5W', footprint: 'φ28mm', specs: '8Ω · 0.5W', description: '语音播放输出，配功放使用。' },
  { id: 'mkt-mic9mm', part: '9.7mm 驻极体咪头', name: '驻极体麦克风', group: '常用基础件', symbolType: 'mic', value: '9.7×6.7mm', footprint: 'DIP-2', specs: '灵敏度约 -38dB', description: '声音采集，需偏置电阻。' },
  { id: 'mkt-ant433', part: '433MHz 弹簧天线', name: '天线', group: '常用基础件', symbolType: 'antenna', value: '433MHz', footprint: 'SMA/IPEX 或焊盘', specs: '驻波匹配影响距离', description: '射频模块外置天线。' },
]);


export function optimizeCircuit(input, goals = []) {
  const components = Array.isArray(input?.components) ? input.components : [];
  const wires = Array.isArray(input?.wires) ? input.wires : [];
  const refs = components.map((item) => String(item.ref || '').toUpperCase()).filter(Boolean);
  const types = components.map((item) => String(item.type || '').toLowerCase());
  const recommendations = [];
  const add = (priority, area, title, detail, tradeoff = '') => recommendations.push({ priority, area, title, detail, tradeoff });

  if (!types.includes('ground') && !refs.includes('GND')) add('high','连接','补充明确参考地','当前项目未发现 GND 元件；多数仿真、ERC 与接口定义都需要明确参考节点。');
  if (components.length > 1 && wires.length < Math.max(1, components.length - 1)) add('high','连接','检查未连接网络',`当前有 ${components.length} 个器件，但只有 ${wires.length} 条连线。请检查悬空引脚和电源回路。`);
  const duplicates = [...new Set(refs.filter((ref, index) => refs.indexOf(ref) !== index))];
  if (duplicates.length) add('high','可制造性','修复重复位号',`重复位号：${duplicates.join('、')}。BOM 和 PCB 回标要求位号唯一。`);
  const missingValues = components.filter((item) => !String(item.value || '').trim());
  if (missingValues.length) add('medium','文档','补齐器件值',`${missingValues.length} 个器件缺少阻值、容值或型号。`);
  const hasActive = types.some((type) => ['ic','opamp','mcu','timer','sensor','comparator','voltage-regulator','logic-gate','opto'].includes(type));
  const hasDecoupling = components.some((item) => item.type === 'capacitor' && /100\s*n|0\.1\s*u|退耦/i.test(item.value || item.role || ''));
  if (hasActive && !hasDecoupling) add('high','电源完整性','增加逐芯片退耦','检测到有源器件但未发现典型 100 nF 去耦电容；应按每个电源引脚建立最短高频回路。','增加少量面积和 BOM 成本。');
  const hasConnector = types.includes('connector');
  const hasProtection = components.some((item) => /保险|tvs|esd|反接|钳位/i.test(`${item.value || ''} ${item.role || ''}`));
  if (hasConnector && !hasProtection) add('medium','可靠性','评估接口保护','板外连接器可能引入 ESD、浪涌或反接，应按接口环境决定 TVS、串阻、保险或滤波。','保护器件会增加寄生参数。');
  if (goals.includes('low-noise')) add('medium','低噪声','分离噪声源与敏感节点','缩小开关热环路，反馈/高阻节点远离 SW、时钟和磁性元件，并保持连续参考平面。','隔离与滤波可能增加面积。');
  if (goals.includes('low-power')) add('medium','低功耗','核算静态与动态损耗','比较静态电流、开关损耗、导通损耗和轻载模式；避免只看满载效率。','更低功耗器件可能成本更高。');
  if (goals.includes('low-cost')) add('low','成本','合并器件与统一封装','优先使用通用阻容值和统一封装，并评估集成方案对 BOM/装配成本的影响。','过度集成会降低替代性。');
  if (goals.includes('small-size')) add('medium','尺寸','先压缩关键回路','优先压缩高频和大电流回路，不要为了面积牺牲散热、爬电和可制造间距。','更小封装提高焊接和返修难度。');
  if (goals.includes('reliability')) add('medium','可靠性','建立额定值降额表','逐项核对电压、电流、功率、温度、寿命与容差，并覆盖启动、短路和开路状态。','降额通常增加成本和体积。');
  if (!recommendations.length) add('low','完整性','进入器件级复核','基础结构未发现明显缺项；下一步绑定真实型号、引脚和封装，并运行 ERC/仿真。');

  const penalty = recommendations.reduce((sum, item) => sum + (item.priority === 'high' ? 16 : item.priority === 'medium' ? 8 : 3), 0);
  return {
    score: Math.max(0, 100 - penalty),
    grade: recommendations.some((item) => item.priority === 'high') ? '需要整改' : recommendations.some((item) => item.priority === 'medium') ? '建议优化' : '结构良好',
    stats: { components: components.length, wires: wires.length, goals: goals.length },
    recommendations,
    disclaimer: '优化建议基于结构和规则，不替代器件模型、仿真、热测试、EMC/安规验证。',
  };
}
