import { componentTerminalPoints } from './layout-agent.mjs';

const EPS = 0.01;
const close = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < EPS;
const finitePoint = p => Array.isArray(p) && p.length >= 2 && p.every(Number.isFinite);
function onSegment(p, a, b) {
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (length < EPS) return close(p, a);
  return Math.abs((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) / length < EPS
    && p[0] >= Math.min(a[0], b[0]) - EPS && p[0] <= Math.max(a[0], b[0]) + EPS
    && p[1] >= Math.min(a[1], b[1]) - EPS && p[1] <= Math.max(a[1], b[1]) + EPS;
}
const touches = (p, wire) => wire.points.slice(1).some((end, i) => onSegment(p, wire.points[i], end));
const bridged = (p, a, b) => [...(a.bridges || []), ...(b.bridges || [])].some(q => close(p, q));

// Reconstruct conductor nets, never using a plan's natural-language connection list.
// T contacts / overlaps / explicit junctions connect. Unmarked X crossings do not.
export function extractSchematicNetlist(schematic = {}) {
  const wires = (schematic.wires || []).filter(w => w.points?.length >= 2 && w.points.every(finitePoint));
  const components = schematic.components || [];
  const pins = components.flatMap((component, componentIndex) => componentTerminalPoints(component)
    .map(pin => ({ ...pin, componentIndex, ref: component.ref, type: component.type })));
  const parent = Array.from({ length: wires.length + pins.length }, (_, i) => i);
  const root = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  const join = (a, b) => { parent[root(a)] = root(b); };
  for (let i = 0; i < wires.length; i++) for (let j = i + 1; j < wires.length; j++) {
    const a = wires[i], b = wires[j];
    const contacts = [...a.points, ...(a.junctions || [])].filter(p => touches(p, b))
      .concat([...b.points, ...(b.junctions || [])].filter(p => touches(p, a)));
    if (contacts.some(p => !bridged(p, a, b))) join(i, j);
  }
  const grounds = new Map();
  pins.forEach((pin, i) => {
    const index = wires.length + i;
    const point = [pin.x, pin.y];
    const attached = wires.map((wire, wi) => touches(point, wire) ? wi : -1).filter(wi => wi >= 0);
    pin.connected = attached.length > 0;
    attached.forEach(wi => join(index, wi));
    // Two pins can touch directly without an intervening wire.
    for (let j = 0; j < i; j++) if (close(point, [pins[j].x, pins[j].y])) {
      join(index, wires.length + j); pin.connected = true; pins[j].connected = true;
    }
    if (pin.type === 'ground') {
      const name = components[pin.componentIndex].net || 'GND';
      if (grounds.has(name)) join(index, grounds.get(name)); else grounds.set(name, index);
    }
  });
  const netIds = new Map();
  pins.forEach((pin, i) => {
    const representative = root(wires.length + i);
    if (!netIds.has(representative)) netIds.set(representative, `N${netIds.size + 1}`);
    pin.net = netIds.get(representative);
  });
  const devices = components.map((component, i) => ({
    index: i, ref: component.ref, type: component.type, value: component.value,
    pins: Object.fromEntries(pins.filter(pin => pin.componentIndex === i).map(pin => [pin.id, { net: pin.net, connected: pin.connected, x: pin.x, y: pin.y }])),
  }));
  const twoTerminalTypes = new Set(['resistor', 'capacitor', 'electrolytic', 'tantalum', 'diode', 'schottky', 'zener', 'led', 'inductor', 'fuse']);
  const shortedDevices = devices.filter(device => twoTerminalTypes.has(device.type)
    && Object.keys(device.pins).length === 2 && new Set(Object.values(device.pins).map(p => p.net)).size === 1)
    .map(device => ({ ref: device.ref, type: device.type, net: Object.values(device.pins)[0].net }));
  return { devices, nets: [...netIds.values()].map(id => ({ id, pins: pins.filter(p => p.net === id).map(p => `${p.componentIndex}:${p.ref}.${p.id}`) })), shortedDevices };
}

export function reviewSchematicElectrical(plan) {
  const netlist = extractSchematicNetlist(plan.schematic);
  const checks = [];
  const add = (pass, title, detail) => checks.push({ status: pass ? 'pass' : 'fail', title, detail });
  const net = (ref, pin) => netlist.devices.find(d => d.ref === ref)?.pins[pin]?.net;
  const same = (...pairs) => pairs.every(([ref, pin]) => net(ref, pin) != null)
    && new Set(pairs.map(([ref, pin]) => net(ref, pin))).size === 1;
  add(netlist.shortedDevices.length === 0, '器件两端旁路短接', netlist.shortedDevices.length
    ? netlist.shortedDevices.map(d => `${d.ref} 两端被导线连接到 ${d.net}`).join('；')
    : '未发现二端无源/二极管器件两端被导线旁路短接；这不代表完整 ERC。');
  if (plan.kind === 'low-side-driver') {
    const ok = same(['D1', 'A'], ['Q1', 'D'], ['J2', 'P'])
      && same(['D1', 'K'], ['J3', 'P']) && net('D1', 'A') !== net('D1', 'K');
    add(ok, '续流极性与电源端', ok ? '续流二极管阳极接开关节点，阴极接负载正电源。' : '续流支路缺少独立负载正电源，或二极管极性/网络错误。');
  }
  if (plan.kind === 'rectifier') {
    const ac1 = net('F1', 'B'), ac2 = net('J2', 'P'), plus = net('J3', 'P'), minus = net('GND', 'GND');
    const ok = [ac1, ac2, plus, minus].every(Boolean) && new Set([ac1, ac2, plus, minus]).size === 4
      && same(['J1', 'P'], ['F1', 'A'])
      && same(['D1', 'A'], ['F1', 'B'], ['D3', 'K'])
      && same(['D2', 'A'], ['J2', 'P'], ['D4', 'K'])
      && same(['D1', 'K'], ['D2', 'K'], ['J3', 'P'], ['C1', 'TOP'])
      && same(['D3', 'A'], ['D4', 'A'], ['GND', 'GND'], ['C1', 'BOTTOM']);
    add(ok, '全桥整流四节点', ok ? '四只二极管形成两交流端、直流正端和直流负端，极性正确。' : '四只二极管未形成正确全桥，不能用连续导线检查替代整流拓扑检查。');
  }
  if (plan.kind === 'timer555') {
    const ok = same(['J1', 'P'], ['U1', 'VCC'], ['U1', 'RESET'], ['RA', 'A'])
      && same(['RA', 'B'], ['RB', 'A'], ['U1', 'DISCH'])
      && same(['RB', 'B'], ['C1', 'TOP'], ['U1', 'THR'], ['U1', 'TRIG'])
      && same(['U1', 'GND'], ['C1', 'BOTTOM'], ['GND', 'GND'])
      && same(['U1', 'OUT'], ['J2', 'P'])
      && same(['U1', 'CTRL'], ['C2', 'TOP'])
      && same(['C2', 'BOTTOM'], ['C3', 'BOTTOM'], ['GND', 'GND'])
      && same(['C3', 'TOP'], ['J1', 'P'])
      && new Set([net('J1', 'P'), net('RA', 'B'), net('C1', 'TOP'), net('GND', 'GND')]).size === 4;
    add(ok, '555 供电与定时引脚', ok ? 'VCC/RESET 直接接电源，DISCH 接 RA/RB 中点，THR/TRIG 接定时电容。' : '555 缺少可审计的真实功能引脚或供电/定时网络连接不符。');
  }
  return { checks, netlist };
}
