import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import {
  parseRequirement,
  generateCircuit,
  reviseCircuit,
  supervisePlan,
  knowledgeSearch,
  ingestTextDocument,
  planToCsv,
  planToBundle,
  COMPONENT_LIBRARY,
  solveCircuitProblem,
  optimizeCircuit,
  calculateEditorDragPosition,
} from '../src/shared/core.mjs';
import {
  auditEditorConnectivity,
  bindEditorWireEndpoints,
  componentTerminalPoints,
  normalizeEditorWireEndpoints,
  resolveEditorWirePoints,
} from '../src/shared/layout-agent.mjs';

const require = createRequire(import.meta.url);
const { parseJson, validateEndpoint, localKnowledgePrompt } = require('../src/main/ai-provider.cjs');
const advancedKnowledge = JSON.parse(readFileSync(new URL('../knowledge/advanced-circuits.json', import.meta.url), 'utf8'));

test('解析降压电源的电压与电流', () => {
  const spec = parseRequirement('设计 12V 输入、5V 2A 输出的 Buck 降压电源');
  assert.equal(spec.kind, 'buck');
  assert.equal(spec.inputVoltage, 12);
  assert.equal(spec.outputVoltage, 5);
  assert.equal(spec.current, 2);
});

test('生成 Buck 草案包含可绘制原理图和 BOM', () => {
  const plan = generateCircuit('设计 12V 输入、5V 2A 输出的同步 Buck 降压电源');
  assert.equal(plan.kind, 'buck');
  assert.ok(plan.components.length >= 5);
  assert.ok(plan.schematic.components.length >= 5);
  assert.match(plan.title, /12 V → 5 V/);
  assert.match(plan.equations.join(' '), /10 W/);
});

test('监督智能体阻断错误的 Buck 拓扑', () => {
  const requirement = '设计 5V 输入、12V 1A 输出的 Buck 降压电源';
  const plan = generateCircuit(requirement);
  const audit = supervisePlan(plan, requirement);
  assert.equal(audit.decision, '阻断投板');
  assert.ok(audit.checks.some((item) => item.status === 'fail' && item.title === '拓扑方向'));
});

test('监督智能体阻断高风险直投', () => {
  const requirement = '设计 220V 市电整流电路';
  const plan = generateCircuit(requirement);
  const audit = supervisePlan(plan, requirement);
  assert.equal(audit.decision, '阻断投板');
  assert.ok(plan.warnings.some((item) => item.includes('高风险')));
});

test('运放增益生成正确的反馈比', () => {
  const plan = generateCircuit('设计一个增益 11 倍的同相运放电路');
  assert.equal(plan.kind, 'opamp');
  assert.ok(plan.equations.some((item) => item.includes('11')));
});

test('知识智能体可检索并摄取本地文本', () => {
  const entry = ingestTextDocument({ name: 'notes.md', content: '# Buck 布局笔记\n输入电容靠近开关电源。\n注意 PCB 热环路。' });
  assert.equal(entry.verified, false);
  assert.ok(entry.tags.includes('buck'));
  const hits = knowledgeSearch([entry], 'buck pcb');
  assert.equal(hits[0].id, entry.id);
});

test('导出 BOM 与 PCB 交接包', () => {
  const plan = generateCircuit('12V 输入、5V 1A 输出降压电源');
  const audit = supervisePlan(plan);
  assert.match(planToCsv(plan), /Ref,Value,Role,Footprint/);
  const bundle = JSON.parse(planToBundle(plan, audit));
  assert.equal(bundle.format, 'circuit-assistant-v1');
  assert.equal(bundle.audit.agent, '工程校验');
});

test('AI JSON 解析兼容代码围栏', () => {
  assert.deepEqual(parseJson('```json\n{"confidence":0.8}\n```'), { confidence: 0.8 });
});

test('AI 接口只允许 HTTPS 或本机 HTTP', () => {
  assert.match(validateEndpoint('http://127.0.0.1:11434/'), /^http:\/\/127\.0\.0\.1/);
  assert.match(validateEndpoint('https://models.example.com/v1'), /^https:/);
  assert.throws(() => validateEndpoint('http://models.example.com/v1'), /仅允许 HTTPS/);
});

test('本地书籍片段只会交给本机模型接口', () => {
  const entries = [{ title: '电路与电子技术', publisher: '电子工业出版社', pageStart: 12, content: '节点电压法用于建立线性方程组。' }];
  assert.match(localKnowledgePrompt({ provider: 'ollama', ollamaBaseUrl: 'http://127.0.0.1:11434' }, entries), /节点电压法/);
  assert.match(localKnowledgePrompt({ provider: 'openai-compatible', remoteBaseUrl: 'http://127.0.0.1:8080/v1' }, entries), /电路与电子技术/);
  assert.equal(localKnowledgePrompt({ provider: 'openai-compatible', remoteBaseUrl: 'https://api.example.com/v1' }, entries), '');
});

test('物品栏提供可用于构图的基础元件', () => {
  assert.ok(COMPONENT_LIBRARY.length >= 14);
  assert.ok(COMPONENT_LIBRARY.some((item) => item.type === 'resistor'));
  assert.ok(COMPONENT_LIBRARY.some((item) => item.type === 'mcu'));
});

test('物品栏覆盖常用分立、控制、电源与执行器件', () => {
  const expected = [
    'potentiometer', 'electrolytic', 'crystal', 'transformer',
    'bjt', 'pmosfet', 'zener', 'schottky', 'opto', 'comparator',
    'voltage-regulator', 'logic-gate', 'battery', 'testpoint',
    'relay', 'motor', 'buzzer',
  ];
  assert.ok(COMPONENT_LIBRARY.length >= 30);
  expected.forEach((type) => assert.ok(COMPONENT_LIBRARY.some((item) => item.type === type), type));
  assert.equal(new Set(COMPONENT_LIBRARY.map((item) => item.type)).size, COMPONENT_LIBRARY.length);
});

test('题目助手求解串联与分压题', () => {
  const series = solveCircuitProblem('R1=2kΩ、R2=3kΩ 串联，求等效电阻');
  assert.equal(series.kind, 'series-resistance');
  assert.match(series.answer, /5 kΩ/);
  const divider = solveCircuitProblem('Vin=12V，R1=10kΩ，R2=5kΩ 构成分压，求 Vout');
  assert.equal(divider.kind, 'voltage-divider');
  assert.match(divider.answer, /4 V/);
});

test('题目助手求解 RC 截止频率', () => {
  const result = solveCircuitProblem('RC 低通电路中 R=10kΩ，C=100nF，求截止频率');
  assert.equal(result.kind, 'rc-cutoff');
  assert.match(result.answer, /159/);
});

test('优化智能体发现缺少参考地、连线和退耦', () => {
  const report = optimizeCircuit({components:[{id:'u1',type:'mcu',ref:'U1',value:'MCU'}],wires:[]},['reliability']);
  assert.equal(report.grade, '需要整改');
  assert.ok(report.recommendations.some((item) => item.title.includes('参考地')));
  assert.ok(report.recommendations.some((item) => item.title.includes('退耦')));
});

test('自然语言“点亮灯泡”生成器件齐全的低压 LED 第一版', () => {
  const plan = generateCircuit('请生成一个电路，要求能够使灯泡点亮');
  assert.equal(plan.kind, 'led-driver');
  assert.equal(plan.specs.inputVoltage, 5);
  assert.ok(plan.components.length >= 6);
  assert.ok(['J1','F1','D2','SW1','R1','D1'].every((ref) => plan.components.some((item) => item.ref === ref)));
  assert.ok(plan.schematic.components.some((item) => item.type === 'fuse'));
  assert.ok(plan.schematic.components.some((item) => item.type === 'switch'));
  assert.ok(!plan.schematic.components.some((item) => item.type === 'block'));
  assert.match(plan.components.find((item) => item.ref === 'R1').value, /Ω/);
  assert.ok(plan.designBasis.length >= 3);
});

test('用户可基于第一版修改供电、LED颜色和开关', () => {
  const first = generateCircuit('生成一个能点亮指示灯的完整低压电路');
  const revised = reviseCircuit(first, '改为 12V 供电，换成白色 LED，去掉开关');
  assert.equal(revised.revisionNumber, 2);
  assert.equal(revised.specs.inputVoltage, 12);
  assert.equal(revised.designParameters.ledColor, '白色');
  assert.equal(revised.designParameters.includeSwitch, false);
  assert.ok(!revised.components.some((item) => item.ref === 'SW1'));
  assert.ok(revised.designParameters.resistor > first.designParameters.resistor);
  assert.equal(revised.revisionHistory.length, 1);
});

test('监督智能体检查 LED 首版的具体器件与完整性', () => {
  const plan = generateCircuit('让指示灯点亮');
  const audit = supervisePlan(plan);
  assert.ok(audit.checks.some((item) => item.title === '具体器件与数值' && item.status === 'pass'));
  assert.ok(audit.checks.some((item) => item.title === 'LED 首版完整性' && item.status === 'pass'));
});

test('自然语言“驱动小车”生成双 H 桥而不是通用方框图', () => {
  const plan = generateCircuit('生成一个能够驱动小车的电路', advancedKnowledge);
  assert.equal(plan.kind, 'motor-driver');
  assert.match(plan.topology, /H 桥/i);
  assert.ok(plan.components.some((item) => item.ref === 'U1' && /H 桥/i.test(`${item.value} ${item.role}`)));
  assert.ok(['F1','QREV1','DTVS1','CBULK1','CIN1'].every((ref) => plan.components.some((item) => item.ref === ref)));
  assert.ok(plan.clarifyingQuestions.some((item) => item.includes('堵转电流')));
  assert.ok(plan.missingParameters.some((item) => item.includes('满充电压')));
  assert.ok(plan.confidence < 0.6);
  assert.ok(!plan.schematic.components.some((item) => item.ref === 'B1'));
  assert.equal(plan.schematic.layout.connectivity.danglingEndpoints, 0);
});

test('每次生成和修订小车电路都会通过关键引脚连通校验', () => {
  for (let index = 0; index < 5; index += 1) {
    const plan = generateCircuit(`生成一个能够驱动小车的电路，第 ${index + 1} 次`, advancedKnowledge);
    assert.equal(plan.schematic.layout.connectivity.checked, true);
    assert.equal(plan.schematic.layout.connectivity.connectedPins, 22);
    assert.equal(plan.schematic.layout.connectivity.danglingEndpoints, 0);
    const revised = reviseCircuit(plan, `修改为 ${6 + index}V 电机`, advancedKnowledge);
    assert.equal(revised.schematic.layout.connectivity.connectedPins, 22);
    assert.equal(revised.schematic.layout.connectivity.danglingEndpoints, 0);
  }
});

test('所有内置原理图模板都没有悬空端点或断线段', () => {
  const requirements = [
    '12V 输入 5V 1A Buck 降压电源',
    '5V 输入 12V 0.5A Boost 升压电源',
    '5V 转 3.3V LDO',
    '增益 11 倍运放',
    '1kHz 555 方波振荡器',
    '12V 低压交流整流',
    'MOSFET 低边驱动 12V 1A 负载',
    '驱动双电机小车',
    '点亮白色 LED',
    'MCU 最小供电系统',
    '1kHz RC 低通滤波器',
    '搭建一个输入处理输出电路',
  ];
  requirements.forEach((requirement) => {
    const plan = generateCircuit(requirement, advancedKnowledge);
    assert.equal(plan.schematic.layout.connectivity.checked, true, requirement);
    assert.equal(plan.schematic.layout.connectivity.continuous, true, requirement);
    assert.equal(plan.schematic.layout.connectivity.danglingEndpoints, 0, requirement);

    const components = plan.schematic.components.map((item,index)=>({...item,id:`${plan.kind}-c${index}`}));
    const wires = normalizeEditorWireEndpoints(bindEditorWireEndpoints(plan.schematic.wires,components),components);
    const componentById = new Map(components.map((item)=>[item.id,item]));
    wires.forEach((wireItem) => {
      for (const side of ['from','to']) {
        if (!wireItem[side]) continue;
        const componentItem=componentById.get(wireItem[side]);
        const terminal=componentTerminalPoints(componentItem).find((pin)=>pin.id===wireItem[`${side}Pin`]);
        assert.ok(terminal,`${requirement}: ${side} 使用了非真实引脚 ${wireItem[`${side}Pin`]}`);
        const resolved=resolveEditorWirePoints(wireItem,components);
        const endpoint=resolved[side==='from'?0:resolved.length-1];
        assert.deepEqual(endpoint,[terminal.x,terminal.y],`${requirement}: ${side} 未落在绑定引脚`);
      }
      assert.doesNotMatch(`${wireItem.fromPin || ''}${wireItem.toPin || ''}`,/BODY/);
    });
    assert.equal(auditEditorConnectivity({components,wires}).continuous,true,`${requirement}: 工作室导入后不连续`);
  });
});

test('多引脚模板使用监管指定的真实端点坐标', () => {
  const expectations = [
    ['12V 输入 5V 1A Buck 降压电源','U1','L1',[113,100]],
    ['12V 输入 5V 1A Buck 降压电源','U1','R1',[227,100]],
    ['12V 输入 5V 1A Buck 降压电源','U1','FEEDBACK',[194,154]],
    ['5V 输入 12V 0.5A Boost 升压电源','U1','POWER_TOP',[222,178]],
    ['5V 输入 12V 0.5A Boost 升压电源','U1','POWER_BOTTOM',[222,262]],
    ['5V 转 3.3V LDO','U1','L1',[183,118]],
    ['5V 转 3.3V LDO','U1','R1',[297,118]],
    ['5V 转 3.3V LDO','U1','POWER_BOTTOM',[240,172]],
    ['增益 11 倍运放','U1','IN_PLUS',[172,145]],
    ['增益 11 倍运放','U1','IN_MINUS',[172,185]],
    ['增益 11 倍运放','U1','OUT',[290,165]],
    ['1kHz 555 方波振荡器','U1','OUT',[360,210]],
    ['1kHz 555 方波振荡器','U1','VCC',[290,148]],
    ['1kHz 555 方波振荡器','U1','RESET',[220,180]],
    ['1kHz 555 方波振荡器','U1','DISCH',[220,230]],
    ['1kHz 555 方波振荡器','U1','THR',[220,260]],
    ['1kHz 555 方波振荡器','U1','TRIG',[220,280]],
    ['1kHz 555 方波振荡器','U1','CTRL',[360,270]],
    ['1kHz 555 方波振荡器','U1','GND',[290,312]],
    ['MCU 最小供电系统','J2','L1',[416,338]],
  ];
  for (const [requirement,ref,pinId,expected] of expectations) {
    const plan=generateCircuit(requirement,advancedKnowledge);
    const componentItem=plan.schematic.components.find((item)=>item.ref===ref);
    const pin=componentTerminalPoints(componentItem).find((item)=>item.id===pinId);
    assert.deepEqual([pin.x,pin.y],expected,`${requirement}: ${ref}.${pinId}`);
    assert.ok(plan.schematic.wires.some((wireItem)=>[wireItem.points[0],wireItem.points.at(-1)]
      .some((point)=>point[0]===pin.x&&point[1]===pin.y)),`${requirement}: ${ref}.${pinId} 没有线路端点`);
  }
});

test('小车需求会按语义区分电机电压和 MCU 电平', () => {
  const spec = parseRequirement('3.3V 单片机控制 12V 双电机小车，堵转电流 2.5A');
  assert.equal(spec.kind, 'motor-driver');
  assert.equal(spec.motorVoltage, 12);
  assert.equal(spec.controlVoltage, 3.3);
  assert.equal(spec.stallCurrent, 2.5);
});

test('小车参数修订不会误切换为低边驱动或 MCU 供电', () => {
  const first = generateCircuit('生成一个能够驱动小车的电路', advancedKnowledge);
  const withCurrent = reviseCircuit(first, '单个电机堵转电流为 2.5A', advancedKnowledge);
  const withLogic = reviseCircuit(withCurrent, '改用 5V MCU，并设置 20kHz PWM', advancedKnowledge);
  assert.equal(withCurrent.kind, 'motor-driver');
  assert.equal(withCurrent.designParameters.stallCurrent, 2.5);
  assert.equal(withLogic.kind, 'motor-driver');
  assert.equal(withLogic.designParameters.logicVoltage, 5);
  assert.equal(withLogic.specs.frequency, 20_000);
});

test('生成链路会应用带来源的结构化知识规则', () => {
  const plan = generateCircuit('6V 双电机小车，3.3V MCU PWM 调速', advancedKnowledge);
  assert.ok(plan.knowledgeEvidence.length >= 3);
  assert.ok(plan.knowledgeEvidence.every((item) => /^https:\/\//.test(item.url)));
  assert.ok(plan.engineeringChecks.some((item) => item.includes('堵转')));
  assert.ok(plan.engineeringChecks.some((item) => item.includes('VRWM')));
  assert.ok(plan.verificationPlan.some((item) => item.includes('堵转')));
});

test('中文整句知识检索可匹配小车 H 桥专题', () => {
  const hits = knowledgeSearch(advancedKnowledge, '帮我设计能够驱动双电机小车并且可以正反转的电路');
  assert.equal(hits[0].id, 'expert-motor-hbridge-gate-drive');
});

test('工程校验把缺失堵转电流标记为未决参数', () => {
  const plan = generateCircuit('生成一个能够驱动小车的电路', advancedKnowledge);
  const audit = supervisePlan(plan);
  assert.equal(audit.decision, '补全后复核');
  assert.ok(audit.checks.some((item) => item.title === '堵转电流依据' && item.status === 'warn'));
  assert.ok(audit.checks.some((item) => item.title === '可追溯依据' && item.status === 'pass'));
});

test('Agent界面不虚构训练或智能体编队，保留工程校验', () => {
  const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /学习智能体|监督智能体|智能体编队|学习中|规则引擎|Agent 架构/);
  assert.match(html, /专家知识增强/);
  assert.match(html, /工程校验/);
});

test('元件拖动期间连续跟手并在松开时吸附网格', () => {
  const position = calculateEditorDragPosition({
    originX:100,
    originY:120,
    startX:20,
    startY:30,
    currentX:27.4,
    currentY:42.6,
  });
  assert.equal(position.x,107.4);
  assert.equal(position.y,132.6);
  assert.equal(position.snappedX,110);
  assert.equal(position.snappedY,130);
});

test('元件拖动计算器仍可按调用方指定边界约束', () => {
  const position = calculateEditorDragPosition({
    originX:950,
    originY:640,
    currentX:200,
    currentY:200,
  });
  assert.equal(position.x,970);
  assert.equal(position.y,645);
  const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  assert.match(html, /左键拖动元件/);
  assert.match(html, /id="grid-status"/);
});

test('工作室使用可无限平移的网格和无边界元件坐标', () => {
  const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
  assert.match(html, /可平移缩放的无限电路绘图画布/);
  assert.match(html, /editor-grid-background/);
  assert.match(html, /无限网格/);
  assert.match(app, /function syncEditorViewport/);
  assert.match(app, /Number\.NEGATIVE_INFINITY/);
  assert.match(app, /function onEditorWheel/);
  assert.match(app, /spacePressed/);
  assert.match(app, /viewport:\{zoom:state\.editor\.zoom,viewBox/);
  const main = readFileSync(new URL('../src/main/main.cjs', import.meta.url), 'utf8');
  assert.match(main, /--infinite-canvas-demo/);
});

test('工作室连线提供拖拽、点击和端点磁性吸附', () => {
  const html = readFileSync(new URL('../src/renderer/index.html', import.meta.url), 'utf8');
  const app = readFileSync(new URL('../src/renderer/app.js', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../src/main/main.cjs', import.meta.url), 'utf8');
  assert.match(html, /绿色端点/);
  assert.match(html, /wire-crossing-dialog/);
  assert.match(app, /wireDrag/);
  assert.match(app, /wire-preview-end/);
  assert.match(app, /pendingCrossings/);
  assert.match(app, /请先点击一个元件的绿色标记点/);
  assert.match(app, /wireTargetAtClientPoint/);
  assert.match(app, /WIRE_PIN_SNAP_RADIUS_PX/);
  assert.match(app, /distancePx>WIRE_PIN_SNAP_RADIUS_PX/);
  assert.match(app, /target\?completionPointsForTarget\(target\.pin\)/);
  assert.match(app, /commitWireDraftPoint/);
  assert.match(app, /wireDraftPreviewEnd/);
  assert.match(app, /toggleWireDraftAxis/);
  assert.match(app, /靠近绿色端点自动吸附/);
  assert.doesNotMatch(app, /const midX = Math\.round\(\(pin\.x\+endX\)\/20\)\*10/);
  assert.match(app, /editor-wire-segment-handle/);
  assert.match(app, /updateWireSegmentEdit/);
  assert.doesNotMatch(app, /magnetRadius/);
  assert.match(app, /canConnectEditorPins/);
  assert.match(app, /normalizeEditorWireEndpoints/);
  assert.match(main, /--wire-drag-demo/);
  assert.match(main, /--wire-crossing-demo/);
  assert.match(main, /--wire-multipin-demo/);
  assert.match(main, /--wire-edit-demo/);
});

test('主进程忽略已关闭诊断管道的 EPIPE', () => {
  const main = readFileSync(new URL('../src/main/main.cjs', import.meta.url), 'utf8');
  assert.match(main, /guardDiagnosticStream\(process\.stdout\)/);
  assert.match(main, /guardDiagnosticStream\(process\.stderr\)/);
  assert.match(main, /error\?\.code !== 'EPIPE'/);
  assert.doesNotMatch(main, /console\.log\(`Screenshot saved:/);
});
