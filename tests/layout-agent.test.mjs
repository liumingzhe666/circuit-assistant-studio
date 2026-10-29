import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYOUT_POLICY,
  auditEditorConnectivity,
  auditSchematicConnectivity,
  bindEditorWireEndpoints,
  canConnectEditorPins,
  componentConnectionPoints,
  componentTerminalPoints,
  normalizeEditorWireEndpoints,
  optimizeSchematicLayout,
  resolveEditorWirePoints,
  scoreSchematicLayout,
} from '../src/shared/layout-agent.mjs';

test('工作室只在元件真实端点提供连接点', () => {
  const opampPins=componentTerminalPoints(component('opamp','U1','LM358',200,200)).map((pin)=>pin.id);
  const icPins=componentTerminalPoints(component('ic','U2','DRV',400,200)).map((pin)=>pin.id);
  const publicConnectionPins=componentConnectionPoints(component('ic','U2','DRV',400,200)).map((pin)=>pin.id);
  assert.deepEqual(opampPins,['IN_PLUS','IN_MINUS','OUT']);
  assert.deepEqual(icPins,['L1','L2','R1','R2']);
  assert.deepEqual(publicConnectionPins,icPins);
  assert.ok(![...opampPins,...icPins,...publicConnectionPins].some((pin)=>/BODY/.test(pin)));
});

test('新增常用器件提供与符号匹配的真实引脚', () => {
  const expected = {
    potentiometer: ['A', 'W', 'B'],
    electrolytic: ['TOP', 'BOTTOM'],
    crystal: ['A', 'B'],
    transformer: ['P1', 'P2', 'S1', 'S2'],
    bjt: ['B', 'C', 'E'],
    pmosfet: ['G', 'S', 'D'],
    zener: ['A', 'K'],
    schottky: ['A', 'K'],
    opto: ['A', 'K', 'C', 'E'],
    comparator: ['IN_PLUS', 'IN_MINUS', 'OUT', 'POWER_TOP', 'POWER_BOTTOM'],
    'voltage-regulator': ['IN', 'OUT', 'GND', 'EN'],
    'logic-gate': ['A', 'B', 'Y', 'POWER_TOP', 'POWER_BOTTOM'],
    battery: ['A', 'B'],
    testpoint: ['P'],
    relay: ['COIL_A', 'COIL_B', 'COM', 'NO', 'NC'],
    motor: ['A', 'B'],
    buzzer: ['A', 'B'],
  };
  Object.entries(expected).forEach(([type, pins]) => {
    assert.deepEqual(componentTerminalPoints(component(type, 'X1', 'TEST', 200, 200)).map((pin) => pin.id), pins, type);
  });
});

test('普通绑定不接受旧外壳锚点，迁移器只迁移明确旧数据', () => {
  const components = [
    {...component('ic','U1','IC',200,200),id:'u1',powerPins:true},
    {...component('terminal','J1','IN',80,200),id:'j1'},
    {...component('terminal','J2','OUT',320,200),id:'j2'},
    {...component('opamp','U2','OP',500,200),id:'u2'},
  ];
  const [ordinary] = bindEditorWireEndpoints([{
    id:'ordinary',from:'u1',fromPin:'BODY_LEFT',to:'j1',toPin:'P',points:[[155,200],[80,200]],
  }],components);
  assert.equal(ordinary.from,undefined);
  assert.equal(ordinary.fromPin,undefined);
  assert.equal(ordinary.to,'j1');
  assert.equal(ordinary.toPin,'P');

  const migrated = normalizeEditorWireEndpoints([
    {id:'explicit-left',from:'u1',fromPin:'BODY_LEFT',to:'j1',toPin:'P',points:[[155,200],[80,200]]},
    {id:'coordinate-right',points:[[245,200],[320,200]]},
    {id:'op-plus',from:'u2',fromPin:'IN_PLUS_BODY',to:'j2',toPin:'P',points:[[445,180],[320,200]]},
  ],components);
  assert.equal(migrated[0].fromPin,'L1');
  assert.equal(migrated[1].fromPin,'R1');
  assert.equal(migrated[2].fromPin,'IN_PLUS');
  assert.ok(migrated.every((wire)=>!/BODY/.test(`${wire.fromPin || ''}${wire.toPin || ''}`)));
  assert.deepEqual(resolveEditorWirePoints(migrated[0],components)[0],[143,188]);
  assert.deepEqual(resolveEditorWirePoints(migrated[1],components)[0],[257,188]);
  assert.deepEqual(resolveEditorWirePoints(migrated[2],components)[0],[427,180]);
});

test('无坐标旧 pin 只有显式迁移后才能路由和通过审计', () => {
  const components = [
    {...component('ic','U1','IC',200,200),id:'u1'},
    {...component('opamp','U2','OP',500,200),id:'u2'},
  ];
  const legacyWire = {
    id:'legacy-no-points',from:'u1',fromPin:'BODY_LEFT',to:'u2',toPin:'IN_PLUS_BODY',
  };
  assert.deepEqual(resolveEditorWirePoints(legacyWire,components),[]);
  assert.equal(auditEditorConnectivity({components,wires:[legacyWire]}).continuous,false);

  const [normalized] = normalizeEditorWireEndpoints([legacyWire],components);
  assert.equal(normalized.fromPin,'L1');
  assert.equal(normalized.toPin,'IN_PLUS');
  assert.doesNotMatch(`${normalized.fromPin}${normalized.toPin}`,/BODY/);
  assert.ok(resolveEditorWirePoints(normalized,components).length>=2);
  assert.equal(auditEditorConnectivity({components,wires:[normalized]}).continuous,true);
});

test('跨元件连接校验拒绝同一元件的不同引脚', () => {
  assert.equal(canConnectEditorPins({componentId:'u1',pinId:'L1'},{componentId:'u1',pinId:'L2'}),false);
  assert.equal(canConnectEditorPins({componentId:'u1',pinId:'L1'},{componentId:'u2',pinId:'IN_PLUS'}),true);
  assert.equal(canConnectEditorPins({componentId:'u1',pinId:''},{componentId:'u2',pinId:'IN_PLUS'}),false);
});

const component = (type, ref, value, x, y, rotate = 0) => ({ type, ref, value, x, y, rotate });

function rawMotorSchematic() {
  return {
    components: [
      component('terminal', 'J1', 'BAT+', 35, 100),
      component('fuse', 'F1', 'INPUT', 100, 100),
      component('mosfet', 'QREV1', 'REV', 195, 100),
      component('ic', 'U1', 'DUAL H-BRIDGE', 330, 190),
      component('terminal', 'J3', 'MOTOR-A', 500, 135),
      component('terminal', 'J4', 'MOTOR-B', 500, 245),
      component('capacitor', 'CBULK', '470µF', 245, 285),
      component('capacitor', 'CIN', '10µ+100n', 315, 285),
      component('terminal', 'J2', 'MCU CTRL', 55, 245),
      component('resistor', 'RIN', '4×33Ω', 150, 245),
      component('diode', 'TVS', 'CLAMP', 190, 330),
      component('ground', 'PGND', '', 245, 390),
      component('ground', 'GND', '', 315, 390),
    ],
    wires: [
      { points: [[35,100],[65,100]] }, { points: [[135,100],[160,100]] },
      { points: [[230,100],[330,100],[330,150]] },
      { points: [[375,170],[500,135]] }, { points: [[375,220],[500,245]] },
      { points: [[55,245],[111,245]] }, { points: [[189,245],[285,245]] },
    ],
  };
}

test('排版智能体将小车驱动图变为正交简洁布局', () => {
  const raw = rawMotorSchematic();
  const before = scoreSchematicLayout(raw);
  const result = optimizeSchematicLayout(raw, { kind: 'motor-driver' });
  assert.ok(result.layout.score > before.score);
  assert.equal(result.layout.routing, 'ORTHOGONAL');
  assert.ok(result.wires.every((wire) => wire.points.slice(1).every((point, index) => {
    const previous = wire.points[index];
    return previous[0] === point[0] || previous[1] === point[1];
  })));
  assert.equal(result.components.filter((item) => item.type === 'ground').length, 1);
  assert.ok(result.components.find((item) => item.ref === 'QREV1').hideRef);
  assert.ok(result.components.find((item) => item.ref === 'CBULK').hideRef);
  assert.ok(result.wires.some((item) => item.net === 'CTRL'));
  assert.equal(result.components.find((item) => item.ref === 'QREV1').y, 82);
  assert.equal(result.components.find((item) => item.ref === 'U1').powerPins, true);

  const endpoints = result.wires.flatMap((wire) => [wire.points[0], wire.points.at(-1)]);
  const hasEndpoint = (x, y) => endpoints.some((point) => point[0] === x && point[1] === y);
  for (const [x, y] of [
    [65,90], [135,90], [159,90], [241,90], // fuse and QREV1
    [430,148], [430,232],                   // U1 power and ground
    [450,232], [487,178], [487,202],       // U1 control/output pins
    [106,405], [184,405],                  // RIN pins
    [255,183], [255,257],                  // rotated TVS pins
    [305,195], [305,255], [360,195], [360,255], // capacitor pins
    [330,355],                              // PGND pin
  ]) assert.ok(hasEndpoint(x, y), `missing wire endpoint at ${x},${y}`);

  const controlWire = result.wires.find((wire) => wire.net === 'CTRL');
  assert.deepEqual(controlWire.points, [[184,405],[450,405],[450,232]]);
  assert.equal(controlWire.bridges, undefined);
  assert.equal(result.components.find((item) => item.ref === 'U1').controlPin, true);
  assert.equal(result.components.find((item) => item.ref === 'J4').y, 245);
  assert.deepEqual(result.wires.find((wire) => wire.points.at(-1)?.[0] === 520 && wire.points.at(-1)?.[1] === 245).points, [[487,202],[487,245],[520,245]]);
  assert.equal(result.components.find((item) => item.ref === 'CBULK').labelX, 16);
  assert.equal(result.components.find((item) => item.ref === 'CBULK').labelY, -15);
  assert.equal(result.components.find((item) => item.ref === 'CBULK').labelSide, 'right');
  assert.equal(result.components.find((item) => item.ref === 'CIN').labelSide, 'right');
  assert.equal(result.layout.connectivity.checked, true);
  assert.equal(result.layout.connectivity.requiredPins, 22);
  assert.equal(result.layout.connectivity.connectedPins, 22);
  assert.equal(result.layout.connectivity.danglingEndpoints, 0);
  assert.equal(result.layout.connectivity.continuous, true);
  assert.deepEqual(result.layout.connectivity.openEndpoints, []);
  assert.deepEqual(result.layout.connectivity.invalidWires, []);
  assert.equal(auditSchematicConnectivity(result, { kind: 'motor-driver' }).danglingEndpoints, 0);
});

test('排版策略可追溯到公开官方资料', () => {
  assert.match(LAYOUT_POLICY.version, /^2026\.08\.24-5/);
  assert.ok(LAYOUT_POLICY.sources.some((url) => url.includes('eclipse.dev/elk')));
  assert.ok(LAYOUT_POLICY.sources.some((url) => url.includes('docs.kicad.org')));
});

test('连通审计能发现未落在器件引脚或网络上的断点', () => {
  const schematic = {
    components: [component('terminal','J1','IN',40,100), component('resistor','R1','1k',120,100)],
    wires: [{ points: [[40,100],[78,100]] }],
  };
  const audit = auditSchematicConnectivity(schematic);
  assert.equal(audit.continuous, false);
  assert.equal(audit.danglingEndpoints, 1);
  assert.deepEqual(audit.openEndpoints[0].point, [78,100]);
});

test('工作室导线绑定具体引脚并在元件移动后保持连续', () => {
  const components = [
    { ...component('resistor','R1','1k',120,100), id:'r1' },
    { ...component('led','D1','LED',260,160), id:'d1' },
  ];
  const [wire] = bindEditorWireEndpoints([{ id:'w1', points:[[159,100],[223,100],[223,160]] }], components);
  assert.equal(wire.from, 'r1');
  assert.equal(wire.fromPin, 'B');
  assert.equal(wire.to, 'd1');
  assert.equal(wire.toPin, 'A');
  components[1].x = 300;
  components[1].y = 200;
  const points = resolveEditorWirePoints(wire, components);
  assert.deepEqual(points[0], [159,100]);
  assert.deepEqual(points.at(-1), [263,200]);
  assert.ok(points.slice(1).every((point,index) => point[0] === points[index][0] || point[1] === points[index][1]));
  assert.equal(auditEditorConnectivity({ components, wires:[wire] }).continuous, true);
});

test('移动已连线运放时导线会绕开符号本体', () => {
  const components = [
    { ...component('opamp', 'U1', 'OP', 200, 200), id: 'u1' },
    { ...component('terminal', 'J1', 'OUT', 127, 300), id: 'j1' },
  ];
  const [wire] = bindEditorWireEndpoints([{ id:'w1', points:[[127,180],[127,300]] }], components);
  components[0].x = 100;
  const points = resolveEditorWirePoints(wire, components);
  assert.deepEqual(points[0], [27, 180]);
  assert.deepEqual(points.at(-1), [127, 300]);
  assert.ok(points.slice(1).every((point, index) => point[0] === points[index][0] || point[1] === points[index][1]));
  const crossesBody = points.slice(0, -1).some((start, index) => {
    const end = points[index + 1];
    return start[1] >= 160 && start[1] <= 240 && end[1] === start[1]
      && Math.max(Math.min(start[0], end[0]), 45) <= Math.min(Math.max(start[0], end[0]), 120);
  });
  assert.equal(crossesBody, false);
});

test('生成的小车原理图导入工作室后移动驱动器不会拉断网络', () => {
  const optimized = optimizeSchematicLayout(rawMotorSchematic(), { kind:'motor-driver' });
  const components = optimized.components.map((item,index) => ({ ...item, id:`c${index}` }));
  const wires = bindEditorWireEndpoints(optimized.wires, components);
  const driver = components.find((item) => item.ref === 'U1');
  driver.x += 20;
  driver.y += 10;
  const audit = auditEditorConnectivity({ components, wires });
  assert.equal(audit.continuous, true);
  assert.equal(audit.danglingEndpoints, 0);
});
