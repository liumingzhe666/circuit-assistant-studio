import test from 'node:test';
import assert from 'node:assert/strict';
import { generateCircuit, parseRequirement, supervisePlan } from '../src/shared/core.mjs';
import { componentTerminalPoints } from '../src/shared/layout-agent.mjs';
import { extractSchematicNetlist, reviewSchematicElectrical } from '../src/shared/schematic-netlist.mjs';
import { structuralFingerprint } from '../scripts/test-schematic-100.mjs';
import { schematicDataset } from '../evaluation/schematic-100-v1.mjs';

test('100 项测试按独立拓扑命名，覆盖20类，排除仅数值变化的重复需求', () => {
  assert.equal(schematicDataset.cases.length, 100);
  assert.equal(new Set(schematicDataset.cases.map(c => c.topologyId)).size, 100);
  assert.equal(new Set(schematicDataset.cases.map(c => c.family)).size, 20);
  assert.equal(new Set(schematicDataset.cases.map(c => c.requirement.replace(/[\d.]+/g, '#'))).size, 100);
});

test('独立网表区分 T 接、无连接点交叉与显式跨线', () => {
  const build = (junctions = [], bridges = [], points = [[50,-50],[50,50]]) => ({
    components: [{type:'terminal',ref:'A',x:0,y:0},{type:'terminal',ref:'B',x:50,y:50}],
    wires:[{points:[[0,0],[100,0]],junctions},{points,bridges}],
  });
  const connected = drawing => {
    const graph=extractSchematicNetlist(drawing);
    return graph.devices[0].pins.P.net===graph.devices[1].pins.P.net;
  };
  assert.equal(connected(build()), false);
  assert.equal(connected(build([[50,0]])), true);
  assert.equal(connected(build([], [], [[50,0],[50,50]])), true);
  assert.equal(connected(build([[50,0]], [[50,0]])), false);
});

test('图结构指纹不受数值、位号、顺序、位置影响，能区分不同连接', () => {
  const original=generateCircuit('1kHz RC 低通').schematic;
  const moved=structuredClone(original);
  moved.components.reverse().forEach((c,i)=>{c.ref=`NEW${i}`;c.value='changed';c.x+=90;c.y+=70;});
  moved.wires.reverse().forEach(w=>{w.points=w.points.map(([x,y])=>[x+90,y+70]);w.junctions=w.junctions?.map(([x,y])=>[x+90,y+70]);});
  assert.equal(structuralFingerprint(original).fingerprint,structuralFingerprint(moved).fingerprint);
  assert.notEqual(structuralFingerprint(original).fingerprint,structuralFingerprint(generateCircuit('1kHz RC 高通').schematic).fingerprint);
});

test('反相目标不被同相输入端说明覆盖，低边开关不误判为降压', () => {
  assert.equal(parseRequirement('反相运放增益3倍，同相端接参考地').opampMode,'inverting');
  assert.equal(parseRequirement('同相运放增益3倍，反相端接反馈分压').opampMode,'noninverting');
  const plan=generateCircuit('12V、0.2A 感性负载，3.3V 控制 N-MOS 低边开关');
  assert.equal(plan.kind,'low-side-driver');
  assert.match(plan.title,/12 V/);
});

for (const [name,requirement,kind] of [
  ['低边续流','12V、0.2A 感性负载，3.3V 控制 N-MOS 低边开关','low-side-driver'],
  ['桥式整流','隔离12V AC、0.2A，全桥整流和电容滤波','rectifier'],
  ['555 定时','555 无稳态1kHz，占空比70%','timer555'],
]) test(`${name}：实际引脚网络符合拓扑`,()=>{
  const plan=generateCircuit(requirement);
  assert.equal(plan.kind,kind);
  const review=reviewSchematicElectrical(plan);
  assert.ok(review.checks.every(c=>c.status==='pass'),JSON.stringify(review.checks));
  if(plan.kind==='timer555') {
    const pins=componentTerminalPoints(plan.schematic.components.find(c=>c.ref==='U1'));
    assert.equal(pins.length,8);
    for(const pin of pins)assert.ok(review.netlist.devices.find(c=>c.ref==='U1').pins[pin.id].connected,pin.id);
  }
});

test('整流电容公式的微法单位与图纸/BOM 一致',()=>{
  const plan=generateCircuit('隔离12V AC、0.2A，全桥整流');
  assert.match(plan.components.find(c=>c.ref==='C1').value,/2000\s*µF/);
  assert.equal(plan.designParameters.filterCapacitance,0.002);
});

test('工程审查能检出人为旁路短接的续流二极管',()=>{
  const plan=generateCircuit('12V 继电器驱动，0.2A');
  const diode=plan.schematic.components.find(c=>c.ref==='D1');
  const [a,k]=componentTerminalPoints(diode);
  plan.schematic.wires.push({points:[[a.x,a.y],[k.x,k.y]]});
  const audit=supervisePlan(plan);
  assert.ok(audit.checks.some(c=>c.title==='器件两端旁路短接'&&c.status==='fail'));
  assert.equal(audit.decision,'阻断投板');
});
