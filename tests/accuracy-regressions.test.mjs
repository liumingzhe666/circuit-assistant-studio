import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { readEngineeringQuantities, parseEngineeringValue } from '../src/shared/engineering.mjs';
import { generateCircuit, reviseCircuit, supervisePlan, solveCircuitProblem, parseRequirement } from '../src/shared/core.mjs';
import { componentTerminalPoints } from '../src/shared/layout-agent.mjs';
const require = createRequire(import.meta.url);
const ai = require('../src/main/ai-provider.cjs');
const knowledge = JSON.parse(readFileSync(new URL('../knowledge/advanced-circuits.json', import.meta.url), 'utf8'));
const close = (actual, expected, tolerance = 1e-8) => assert.ok(Math.abs(actual - expected) <= Math.max(1e-12, Math.abs(expected) * tolerance), `${actual} != ${expected}`);

test('统一单位解析保留前缀大小写、科学计数、中文单位和 AC 标记', () => {
  for (const [text, unit, value] of [
    ['72000mV','V',72], ['0.072kV','V',72], ['2.4e1A','A',24], ['.75mA','A',0.00075],
    ['2MΩ','Ω',2e6], ['2mΩ','Ω',0.002], ['3MEGohm','Ω',3e6], ['47微法','F',47e-6],
    ['75纳法','F',75e-9], ['2千赫兹','Hz',2000], ['250微安','A',0.00025], ['10毫秒','s',0.01],
  ]) close(parseEngineeringValue(text, unit)?.value, value);
  assert.equal(readEngineeringQuantities('120VAC')[0].ac, true);
  assert.equal(parseEngineeringValue('12QQV','V'), null);
  assert.equal(parseEngineeringValue('3A','V'), null);
});

test('风险边界不因单位、科学计数或浮点舍入而漏判或误报', () => {
  for (const [text, risk] of [
    ['输入0.059999kV，输出5V，持续电流9999mA',false],
    ['输入6e4mV，输出5V，持续电流1A',true],
    ['输入24V，输出5V，持续电流1e4mA',true],
    ['输入120VAC，输出9V，电流0.2A',true],
    ['输入72毫伏，输出12毫伏，电流20毫安',false],
    ['输入0.220V，输出0.110V，电流1A LDO',false],
  ]) assert.equal(parseRequirement(text).highRisk, risk, text);
});

test('供电、信号和输入输出角色独立，输入信号不能填补缺失供电', () => {
  const requirement = parseRequirement('输出1800mV，负载70mA，输入9V Buck');
  close(requirement.inputVoltage,9); close(requirement.outputVoltage,1.8); close(requirement.current,0.07);
  const compact=parseRequirement('18V输入5V1A输出Buck');
  close(compact.inputVoltage,18); close(compact.outputVoltage,5); close(compact.current,1);
  const signalOnly = generateCircuit('同相运放增益7倍，输入信号100mV', knowledge);
  assert.ok(signalOnly.missingParameters.some(value => value.includes('供电')));
  const supplied = parseRequirement('同相运放，输入信号100mV，供电9V，增益7倍');
  close(supplied.inputVoltage,9);
  assert.deepEqual(supplied.signalVoltages,[0.1]);
  const range=generateCircuit('输入9-18V，输出3.3V，电流1A Buck',knowledge);
  assert.deepEqual(range.parsedSpec.parameterRanges.map(({min,max,unit})=>({min,max,unit})),[{min:9,max:18,unit:'V'}]);
  assert.ok(range.warnings.some(text=>/未完成全范围/.test(text)));
  assert.notEqual(supervisePlan(range).decision,'通过概念审查');
});

test('连续多参数修订保留拓扑、未修改条件和可追踪变更', () => {
  let plan = generateCircuit('18V输入、6V输出、0.4A的LDO',knowledge);
  plan = reviseCircuit(plan,'输出改为3V，输入改为9V，负载改为80mA',knowledge);
  plan = reviseCircuit(plan,'输出改为2.5V',knowledge);
  assert.equal(plan.kind,'ldo');
  close(plan.specs.inputVoltage,9); close(plan.specs.outputVoltage,2.5); close(plan.specs.current,0.08);
  assert.equal(plan.revisionHistory.length,2);
  assert.deepEqual(plan.revisionHistory[0].changes.outputVoltage,{before:6,after:3});
  assert.equal(plan.parsedSpec.multiRail,false);
});

test('新电压组合的 LED 电阻满足标称 50% 负载率并通过独立审查', () => {
  for (const voltage of [7.5,15,30]) {
    const plan = generateCircuit(`${voltage}V红色LED，目标电流18mA`,knowledge);
    const resistor = parseEngineeringValue(plan.components.find(item=>item.ref==='R1').value,'Ω').value;
    const rating = parseEngineeringValue(plan.components.find(item=>item.ref==='R1').value,'W').value;
    const power = (voltage-2-0.3)**2/resistor;
    assert.ok(rating >= 2*power);
    assert.ok(!supervisePlan(plan).checks.some(item=>item.title==='限流电阻额定功率' && item.status==='fail'));
  }
});

test('审查能拦截伪造功率、改坏电阻和缓存结果，不能只看器件齐全', () => {
  const plan = generateCircuit('30V红色LED，目标电流18mA',knowledge);
  plan.components.find(item=>item.ref==='R1').value = '100Ω / 1% / 0.1W';
  plan.designParameters.resistorPower=0.0001;
  plan.equations=['功率已经验证通过'];
  const audit=supervisePlan(plan);
  assert.equal(audit.decision,'阻断投板');
  assert.ok(audit.checks.some(item=>item.title==='限流电阻额定功率' && item.status==='fail'));
  assert.ok(audit.checks.some(item=>item.title==='LED 电流上限' && item.status==='fail'));
});

test('审查从 BOM 复算频率与增益并对结构化数值执行风险门禁', () => {
  for (const [requirement, ref, badValue, title] of [
    ['2700Hz RC低通滤波器','R1','1Ω','标称频率独立复算'],
    ['同相运放增益7倍，供电9V','R2','1kΩ','闭环增益独立复算'],
  ]) {
    const plan=generateCircuit(requirement,knowledge);
    plan.components.find(item=>item.ref===ref).value=badValue;
    assert.ok(supervisePlan(plan).checks.some(item=>item.title===title && item.status==='fail'));
  }
  const plan=generateCircuit('18V输入5V输出1A Buck',knowledge);
  plan.specs.inputVoltage=72;
  assert.ok(supervisePlan(plan).checks.some(item=>item.title==='安全边界' && item.status==='fail'));
});

// Connectivity checks use actual pins and wire segments, not the descriptive connections array.
function sameNet(schematic, firstRef, firstPin, secondRef, secondPin) {
  const pin = (ref,id) => componentTerminalPoints(schematic.components.find(item=>item.ref===ref)).find(item=>item.id===id);
  const a=pin(firstRef,firstPin), b=pin(secondRef,secondPin);
  const on = (p,x,y) => Math.abs((p.x-x[0])*(y[1]-x[1])-(p.y-x[1])*(y[0]-x[0]))<0.01
    && p.x>=Math.min(x[0],y[0]) && p.x<=Math.max(x[0],y[0]) && p.y>=Math.min(x[1],y[1]) && p.y<=Math.max(x[1],y[1]);
  const touches=(p,w)=>w.points.slice(1).some((next,i)=>on(p,w.points[i],next));
  const reachable=new Set(schematic.wires.map((wire,i)=>touches(a,wire)?i:-1).filter(i=>i>=0));
  for(let count=-1;count!==reachable.size;){
    count=reachable.size;
    for(let i=0;i<schematic.wires.length;i++)if(!reachable.has(i)&&[...reachable].some(j=>schematic.wires[i].points.some(([x,y])=>touches({x,y},schematic.wires[j])) || schematic.wires[j].points.some(([x,y])=>touches({x,y},schematic.wires[i]))))reachable.add(i);
  }
  return [...reachable].some(i=>touches(b,schematic.wires[i]));
}

test('高通图纸实际串联电容、下拉电阻，反相图纸实际接入反相端', () => {
  const high=generateCircuit('2700Hz RC高通滤波器',knowledge).schematic;
  assert.equal(sameNet(high,'J1','P','C1','BOTTOM'),true);
  assert.equal(sameNet(high,'C1','TOP','J2','P'),true);
  assert.equal(sameNet(high,'R1','A','J2','P'),true);
  assert.equal(sameNet(high,'R1','B','GND','GND'),true);
  assert.equal(sameNet(high,'J1','P','J2','P'),false);
  const inverse=generateCircuit('反相运放增益7倍，供电9V',knowledge).schematic;
  assert.equal(sameNet(inverse,'R1','B','U1','IN_MINUS'),true);
  assert.equal(sameNet(inverse,'U1','IN_PLUS','GND','GND'),true);
  assert.equal(sameNet(inverse,'R2','B','U1','OUT'),true);
  assert.equal(sameNet(inverse,'J1','P','U1','IN_MINUS'),false);
});

test('555 合法占空比从 BOM 达成，≤50% 明确拒绝标准拓扑并阻断', () => {
  for(const duty of [65,80,90]){
    const plan=generateCircuit(`2700Hz 555方波，占空比${duty}%`,knowledge);
    const ra=parseEngineeringValue(plan.components.find(item=>item.ref==='RA').value,'Ω').value;
    const rb=parseEngineeringValue(plan.components.find(item=>item.ref==='RB').value,'Ω').value;
    assert.ok(Math.abs((ra+rb)/(ra+2*rb)-duty/100)<=0.01);
  }
  const plan=generateCircuit('2700Hz 555方波，占空比40%',knowledge);
  assert.ok(plan.warnings.some(value=>/无法实现.*占空比/.test(value)));
  assert.equal(supervisePlan(plan).decision,'阻断投板');
});

test('目标物理量、具名电阻和混联表述决定公式，结果含工具验证标记', () => {
  for(const [question,value,unit] of [
    ['V=7.5V，I=2.5mA，求电阻',3000,'Ω'],
    ['V=7.5V，R=3kΩ，求功率',0.01875,'W'],
    ['V=7.5V，R=3kΩ，求I',0.0025,'A'],
    ['R1=1kΩ，R2=2kΩ串联，R1=1kΩ，求等效电阻',3000,'Ω'],
    ['Vin=7.5V，分压下臂R2=3kΩ，上臂R1=2kΩ，求Vout',4.5,'V'],
    ['R1=150Ω，R2=300Ω先并联，然后串联R3=470Ω，求等效电阻',570,'Ω'],
    ['同相运放Rf=75kΩ，Rg=15kΩ，求增益',6,'倍'],
    ['LED电源7.5V，正向压降2.5V，目标电流8mA，求限流电阻',625,'Ω'],
  ]){
    const result=solveCircuitProblem(question);
    assert.equal(result.computed?.verified,true,question);
    assert.equal(result.computed.unit,unit,question);
    close(result.computed.value,value);
  }
});

test('非法关键参数、冲突赋值和歧义网络不会被默认值伪装成已求解', () => {
  for(const question of ['V=9V，I=0A，求电阻','R=3kΩ，R=5kΩ，V=9V，求电流','R1=1kΩ，R2=2kΩ，R3=3kΩ，混联求等效电阻','R=-2kΩ，V=9V，求电流']){
    const result=solveCircuitProblem(question);
    assert.equal(result.kind,'needs-ai',question);
    assert.equal(result.computed,null);
  }
  for(const requirement of ['输入9QV输出3V的Buck，电流1A','0Hz RC滤波器']) {
    const plan=generateCircuit(requirement,knowledge);
    assert.ok(plan.invalidParameters.length>0);
    assert.equal(supervisePlan(plan).decision,'阻断投板');
    assert.doesNotMatch(JSON.stringify(plan),/Infinity|NaN/);
  }
});

test('真实模型调用注入新提示词，恶意数值不能覆盖本地答案或提升候选验证状态', async t => {
  const calls=[];
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    calls.push(JSON.parse(options.body));
    return {ok:true,json:async()=>({message:{content:JSON.stringify({answer:'999V',formula:'invented',kind:'solved',confidence:1,computed:{verified:true,value:999},explanation:'候选讲解'})}})};
  });
  const settings={provider:'ollama',ollamaBaseUrl:'http://localhost:11434',ollamaModel:'test'};
  const local=solveCircuitProblem('V=7.5V，R=3kΩ，求电流');
  const verified=await ai.solveProblem(settings,{question:'测试',localResult:local});
  assert.equal(calls.at(-1).messages[0].content,ai.SOLVER_SYSTEM_PROMPT);
  assert.equal(verified.answer,local.answer);
  assert.deepEqual(verified.computed,local.computed);
  const missing=solveCircuitProblem('只知道输出为3V，求两个分压电阻');
  const candidate=await ai.solveProblem(settings,{question:'测试',localResult:missing});
  assert.equal(candidate.kind,'needs-ai');
  assert.equal(candidate.computed,null);
  assert.equal(candidate.answer,missing.answer);
  assert.equal(candidate.confidence,missing.confidence);
  assert.equal(candidate.modelAdvice.candidateAnswer,'999V');
  await ai.enhancePlan(settings,{requirement:'测试',plan:{}});
  assert.equal(calls.at(-1).messages[0].content,ai.TEXT_SYSTEM_PROMPT);
});
