const POLICY_VERSION = '2026.08.24-5';

const MOTOR_DRIVER_REQUIRED_PINS = Object.freeze([
  ['J1', 35, 90], ['F1.IN', 65, 90], ['F1.OUT', 135, 90],
  ['QREV1.IN', 159, 90], ['QREV1.OUT', 241, 90],
  ['U1.VM', 430, 148], ['U1.PGND', 430, 232], ['U1.CTRL', 450, 232],
  ['U1.AOUT', 487, 178], ['U1.BOUT', 487, 202],
  ['J3', 520, 160], ['J4', 520, 245],
  ['J2', 45, 405], ['RIN.IN', 106, 405], ['RIN.OUT', 184, 405],
  ['TVS.TOP', 255, 183], ['TVS.BOTTOM', 255, 257],
  ['CBULK.TOP', 305, 195], ['CBULK.BOTTOM', 305, 255],
  ['CIN.TOP', 360, 195], ['CIN.BOTTOM', 360, 255], ['PGND', 330, 355],
]);

export const LAYOUT_POLICY = Object.freeze({
  version: POLICY_VERSION,
  learnedAt: '2026-08-24',
  sources: [
    'https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html',
    'https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-alg-libavoid.html',
    'https://docs.kicad.org/10.0/cn/eeschema/eeschema.pdf',
    'https://graphviz.org/docs/attrs/splines/',
  ],
  rules: [
    '主信号流从左到右，输入在左、输出在右、电源在上、地在下。',
    '器件按输入保护、控制、核心、输出和供电去耦分区。',
    '连线使用网格化正交段，优先减少交叉、折点、共享歧义和长跨区线。',
    '标签参加碰撞检查；简洁视图只显示理解和复核电路所需的字段。',
    '布局只能改变位置和显示字段，不得改变工程数据中的电气连接或 BOM。',
  ],
});

const REDUNDANT_VALUES = new Set(['input', 'rev', 'clamp', 'filter', 'flyback', '设定']);

const clone = (value) => structuredClone(value || {});
const samePoint = (a, b) => a?.[0] === b?.[0] && a?.[1] === b?.[1];
const pointKey = ([x, y]) => `${Number(x)},${Number(y)}`;
const CONNECTION_TOLERANCE = 1.5;

function rotateOffset([x, y], degrees = 0) {
  const radians = (Number(degrees) || 0) * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return [
    Math.round((x * cosine - y * sine) * 1000) / 1000,
    Math.round((x * sine + y * cosine) * 1000) / 1000,
  ];
}

function componentPinDefinitions(component = {}) {
  if (Array.isArray(component.pinDefinitions)) return component.pinDefinitions;
  if (component.pinProfile === 'timer555') return [
    { id: 'VCC', offset: [0, -82], normal: [0, -1] },
    { id: 'GND', offset: [0, 82], normal: [0, 1] },
    { id: 'RESET', offset: [-70, -50], normal: [-1, 0] },
    { id: 'DISCH', offset: [-70, 0], normal: [-1, 0] },
    { id: 'THR', offset: [-70, 30], normal: [-1, 0] },
    { id: 'TRIG', offset: [-70, 50], normal: [-1, 0] },
    { id: 'OUT', offset: [70, -20], normal: [1, 0] },
    { id: 'CTRL', offset: [70, 40], normal: [1, 0] },
  ];
  const pair = (left = -39, right = 39) => [
    { id: 'A', offset: [left, 0], normal: [-1, 0] },
    { id: 'B', offset: [right, 0], normal: [1, 0] },
  ];
  if (component.type === 'terminal' || component.type === 'net-label') return [{ id: 'P', offset: [0, 0], normal: [0, 0] }];
  if (component.type === 'resistor') return pair();
  if (component.type === 'fuse') return pair(-35, 35);
  if (component.type === 'switch') return pair(-38, 38);
  if (component.type === 'capacitor' || component.type === 'electrolytic') return [
    { id: 'TOP', offset: [0, -30], normal: [0, -1] },
    { id: 'BOTTOM', offset: [0, 30], normal: [0, 1] },
  ];
  if (component.type === 'inductor') return pair();
  if (component.type === 'potentiometer') return [
    { id: 'A', offset: [-39, 0], normal: [-1, 0] },
    { id: 'W', offset: [0, -30], normal: [0, -1] },
    { id: 'B', offset: [39, 0], normal: [1, 0] },
  ];
  if (component.type === 'crystal') return pair();
  if (component.type === 'transformer') return [
    { id: 'P1', offset: [-55, -18], normal: [-1, 0] },
    { id: 'P2', offset: [-55, 18], normal: [-1, 0] },
    { id: 'S1', offset: [55, -18], normal: [1, 0] },
    { id: 'S2', offset: [55, 18], normal: [1, 0] },
  ];
  if (['diode', 'led', 'zener', 'schottky', 'tvs-diode', 'photodiode'].includes(component.type)) return [
    { id: 'A', offset: [-37, 0], normal: [-1, 0] },
    { id: 'K', offset: [37, 0], normal: [1, 0] },
  ];
  if (['thermistor', 'varistor', 'photoresistor', 'ferrite-bead'].includes(component.type)) return pair();
  if (component.type === 'tantalum') return [
    { id: 'TOP', offset: [0, -30], normal: [0, -1] },
    { id: 'BOTTOM', offset: [0, 30], normal: [0, 1] },
  ];
  if (component.type === 'scr') return [
    { id: 'G', offset: [-35, 0], normal: [-1, 0] },
    { id: 'A', offset: [8, -41], normal: [0, -1] },
    { id: 'K', offset: [8, 41], normal: [0, 1] },
  ];
  if (component.type === 'triac') return [
    { id: 'G', offset: [-35, 0], normal: [-1, 0] },
    { id: 'MT2', offset: [8, -41], normal: [0, -1] },
    { id: 'MT1', offset: [8, 41], normal: [0, 1] },
  ];
  if (component.type === 'igbt') return [
    { id: 'G', offset: [-35, 0], normal: [-1, 0] },
    { id: 'C', offset: [8, -41], normal: [0, -1] },
    { id: 'E', offset: [8, 41], normal: [0, 1] },
  ];
  if (['push-button', 'speaker', 'mic', 'battery-holder', 'solenoid', 'fan'].includes(component.type)) return pair(-38, 38);
  if (component.type === 'jumper') return pair(-20, 20);
  if (component.type === 'dip-switch') return [
    { id: 'L1', offset: [-39, -12], normal: [-1, 0] },
    { id: 'L2', offset: [-39, 12], normal: [-1, 0] },
    { id: 'R1', offset: [39, -12], normal: [1, 0] },
    { id: 'R2', offset: [39, 12], normal: [1, 0] },
  ];
  if (component.type === 'usb-port') return [
    { id: 'VBUS', offset: [-45, -18], normal: [-1, 0] },
    { id: 'DM', offset: [-45, -6], normal: [-1, 0] },
    { id: 'DP', offset: [-45, 6], normal: [-1, 0] },
    { id: 'GND', offset: [-45, 18], normal: [-1, 0] },
  ];
  if (component.type === 'dc-jack') return [
    { id: 'VPLUS', offset: [-40, -14], normal: [-1, 0] },
    { id: 'GND', offset: [-40, 0], normal: [-1, 0] },
    { id: 'SWITCH', offset: [-40, 14], normal: [-1, 0] },
  ];
  if (component.type === 'header') return [
    { id: 'P1', offset: [39, -18], normal: [1, 0] },
    { id: 'P2', offset: [39, -6], normal: [1, 0] },
    { id: 'P3', offset: [39, 6], normal: [1, 0] },
    { id: 'P4', offset: [39, 18], normal: [1, 0] },
  ];
  if (component.type === 'antenna') return [{ id: 'FEED', offset: [0, 26], normal: [0, 1] }];
  if (component.type === 'stepper') return [
    { id: 'A', offset: [-39, -12], normal: [-1, 0] },
    { id: 'B', offset: [-39, 12], normal: [-1, 0] },
    { id: 'C', offset: [39, -12], normal: [1, 0] },
    { id: 'D', offset: [39, 12], normal: [1, 0] },
  ];
  if (component.type === 'servo') return [
    { id: 'VCC', offset: [-45, -15], normal: [-1, 0] },
    { id: 'SIG', offset: [-45, 0], normal: [-1, 0] },
    { id: 'GND', offset: [-45, 15], normal: [-1, 0] },
  ];
  if (component.type === 'sensor3') return [
    { id: 'VCC', offset: [-39, -12], normal: [-1, 0] },
    { id: 'DATA', offset: [-39, 0], normal: [-1, 0] },
    { id: 'GND', offset: [-39, 12], normal: [-1, 0] },
  ];
  if (component.type === 'ir-receiver') return [
    { id: 'OUT', offset: [-39, -12], normal: [-1, 0] },
    { id: 'GND', offset: [-39, 0], normal: [-1, 0] },
    { id: 'VCC', offset: [-39, 12], normal: [-1, 0] },
  ];
  if (component.type === 'sensor4') return [
    { id: 'VCC', offset: [-45, -18], normal: [-1, 0] },
    { id: 'GND', offset: [-45, -6], normal: [-1, 0] },
    { id: 'SCL', offset: [-45, 6], normal: [-1, 0] },
    { id: 'SDA', offset: [-45, 18], normal: [-1, 0] },
  ];
  if (component.type === 'lcd') return [
    { id: 'VCC', offset: [-52, -18], normal: [-1, 0] },
    { id: 'GND', offset: [-52, -6], normal: [-1, 0] },
    { id: 'SCL', offset: [-52, 6], normal: [-1, 0] },
    { id: 'SDA', offset: [-52, 18], normal: [-1, 0] },
  ];
  if (component.type === 'wireless-module') return [
    { id: 'VCC', offset: [-52, -18], normal: [-1, 0] },
    { id: 'GND', offset: [-52, -6], normal: [-1, 0] },
    { id: 'TX', offset: [-52, 6], normal: [-1, 0] },
    { id: 'RX', offset: [-52, 18], normal: [-1, 0] },
    { id: 'ANT', offset: [0, -44], normal: [0, -1] },
  ];
  if (component.type === 'sonar') return [
    { id: 'VCC', offset: [-52, -18], normal: [-1, 0] },
    { id: 'TRIG', offset: [-52, -6], normal: [-1, 0] },
    { id: 'ECHO', offset: [-52, 6], normal: [-1, 0] },
    { id: 'GND', offset: [-52, 18], normal: [-1, 0] },
  ];
  if (component.type === 'opamp') return [
    { id: 'IN_PLUS', offset: [-73, -20], normal: [-1, 0] },
    { id: 'IN_MINUS', offset: [-73, 20], normal: [-1, 0] },
    { id: 'OUT', offset: [45, 0], normal: [1, 0] },
  ];
  if (component.type === 'source') return pair(-38, 38);
  if (component.type === 'ground') return [{ id: 'GND', offset: [0, -10], normal: [0, -1] }];
  if (component.type === 'mosfet') return [
    { id: 'G', offset: [-35, 0], normal: [-1, 0] },
    { id: 'D', offset: [8, -41], normal: [0, -1] },
    { id: 'S', offset: [8, 41], normal: [0, 1] },
  ];
  if (component.type === 'pmosfet') return [
    { id: 'G', offset: [-35, 0], normal: [-1, 0] },
    { id: 'S', offset: [8, -41], normal: [0, -1] },
    { id: 'D', offset: [8, 41], normal: [0, 1] },
  ];
  if (component.type === 'bjt') return [
    { id: 'B', offset: [-35, 0], normal: [-1, 0] },
    { id: 'C', offset: [16, -34], normal: [0, -1] },
    { id: 'E', offset: [16, 34], normal: [0, 1] },
  ];
  if (component.type === 'voltage-regulator') return [
    { id: 'IN', offset: [-57, 0], normal: [-1, 0] },
    { id: 'OUT', offset: [57, 0], normal: [1, 0] },
    { id: 'GND', offset: [0, 42], normal: [0, 1] },
    { id: 'EN', offset: [-20, 42], normal: [0, 1] },
  ];
  if (component.type === 'comparator') return [
    { id: 'IN_PLUS', offset: [-73, -20], normal: [-1, 0] },
    { id: 'IN_MINUS', offset: [-73, 20], normal: [-1, 0] },
    { id: 'OUT', offset: [45, 0], normal: [1, 0] },
    { id: 'POWER_TOP', offset: [0, -52], normal: [0, -1] },
    { id: 'POWER_BOTTOM', offset: [0, 52], normal: [0, 1] },
  ];
  if (component.type === 'logic-gate') return [
    { id: 'A', offset: [-57, -12], normal: [-1, 0] },
    { id: 'B', offset: [-57, 12], normal: [-1, 0] },
    { id: 'Y', offset: [57, 0], normal: [1, 0] },
    { id: 'POWER_TOP', offset: [0, -42], normal: [0, -1] },
    { id: 'POWER_BOTTOM', offset: [0, 42], normal: [0, 1] },
  ];
  if (component.type === 'relay') return [
    { id: 'COIL_A', offset: [-62, -18], normal: [-1, 0] },
    { id: 'COIL_B', offset: [-62, 18], normal: [-1, 0] },
    { id: 'COM', offset: [62, 0], normal: [1, 0] },
    { id: 'NO', offset: [62, -18], normal: [1, 0] },
    { id: 'NC', offset: [62, 18], normal: [1, 0] },
  ];
  if (component.type === 'battery' || component.type === 'motor' || component.type === 'buzzer') return pair();
  if (component.type === 'testpoint') return [{ id: 'P', offset: [0, -22], normal: [0, -1] }];
  if (component.type === 'opto') return [
    { id: 'A', offset: [-57, -18], normal: [-1, 0] },
    { id: 'K', offset: [-57, 18], normal: [-1, 0] },
    { id: 'C', offset: [57, -18], normal: [1, 0] },
    { id: 'E', offset: [57, 18], normal: [1, 0] },
  ];

  const width = component.type === 'connector' ? 64 : 90;
  const height = 60;
  const pins = [
    { id: 'L1', offset: [-width / 2 - 12, -12], normal: [-1, 0] },
    { id: 'L2', offset: [-width / 2 - 12, 12], normal: [-1, 0] },
    { id: 'R1', offset: [width / 2 + 12, -12], normal: [1, 0] },
    { id: 'R2', offset: [width / 2 + 12, 12], normal: [1, 0] },
  ];
  if (component.powerPins) {
    pins.push(
      { id: 'POWER_TOP', offset: [0, -height / 2 - 12], normal: [0, -1] },
      { id: 'POWER_BOTTOM', offset: [0, height / 2 + 12], normal: [0, 1] },
    );
  }
  if (component.controlPin) pins.push({ id: 'CONTROL', offset: [20, height / 2 + 12], normal: [0, 1] });
  if (component.feedbackPin) pins.push({ id: 'FEEDBACK', offset: [24, height / 2 + 12], normal: [0, 1] });
  return pins;
}

function legacyDiagramAnchorDefinitions(component = {}) {
  if (component.type === 'opamp') return [
    { id: 'IN_PLUS_BODY', offset: [-55, -20], normal: [-1, 0] },
    { id: 'IN_MINUS_BODY', offset: [-55, 20], normal: [-1, 0] },
  ];
  if (!['ic', 'connector', 'block', 'mcu', 'timer', 'sensor'].includes(component.type)) return [];
  const width = component.type === 'connector' ? 64 : 90;
  const height = 60;
  return [
    { id: 'BODY_LEFT', offset: [-width / 2, 0], normal: [-1, 0] },
    { id: 'BODY_RIGHT', offset: [width / 2, 0], normal: [1, 0] },
    { id: 'BODY_TOP', offset: [0, -height / 2], normal: [0, -1] },
    { id: 'BODY_BOTTOM', offset: [0, height / 2], normal: [0, 1] },
  ];
}

function connectionPointsFromDefinitions(component, definitions) {
  const x = Number(component.x) || 0;
  const y = Number(component.y) || 0;
  const rotation = Number(component.rotate) || 0;
  return definitions.map((pin) => {
    const offset = rotateOffset(pin.offset, rotation);
    const normal = rotateOffset(pin.normal, rotation);
    return { id: pin.id, x: x + offset[0], y: y + offset[1], normal };
  });
}

export function componentTerminalPoints(component = {}) {
  return connectionPointsFromDefinitions(component, componentPinDefinitions(component));
}

// Kept as a compatibility API. Connection points are now exclusively real terminals.
export function componentConnectionPoints(component = {}) {
  return componentTerminalPoints(component);
}

export function nearestComponentConnection(component, point = {}) {
  const pins = componentTerminalPoints(component);
  return pins.reduce((best, pin) => {
    const distance = Math.hypot(pin.x - Number(point.x), pin.y - Number(point.y));
    return !best || distance < best.distance ? { ...pin, distance } : best;
  }, null);
}

function prunePoints(points) {
  const unique = [];
  for (const point of points || []) {
    const normalized = [Number(point?.[0]) || 0, Number(point?.[1]) || 0];
    if (!samePoint(unique.at(-1), normalized)) unique.push(normalized);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (let index = 1; index < unique.length - 1; index += 1) {
      const [ax, ay] = unique[index - 1];
      const [bx, by] = unique[index];
      const [cx, cy] = unique[index + 1];
      if ((ax === bx && bx === cx) || (ay === by && by === cy)) {
        unique.splice(index, 1);
        changed = true;
        break;
      }
    }
  }
  return unique;
}

function orthogonalize(points) {
  const result = [];
  const input = prunePoints(points);
  input.forEach((point, index) => {
    if (!index) {
      result.push(point);
      return;
    }
    const previous = result.at(-1);
    if (previous[0] !== point[0] && previous[1] !== point[1]) result.push([point[0], previous[1]]);
    result.push(point);
  });
  return prunePoints(result);
}

function segments(wires) {
  const result = [];
  (wires || []).forEach((wire, wireIndex) => {
    const points = wire.points || [];
    for (let index = 1; index < points.length; index += 1) {
      const a = points[index - 1];
      const b = points[index];
      result.push({ wireIndex, a, b, horizontal: a[1] === b[1], vertical: a[0] === b[0] });
    }
  });
  return result;
}

function between(value, a, b, strict = false) {
  const min = Math.min(a, b);
  const max = Math.max(a, b);
  return strict ? value > min && value < max : value >= min && value <= max;
}

function segmentMetrics(wires) {
  const list = segments(wires);
  const isBridged = (left, right, x, y) => [left, right].some((segment) => (
    wires[segment.wireIndex]?.bridges || []
  ).some((point) => point[0] === x && point[1] === y));
  let diagonalSegments = 0;
  let crossings = 0;
  let sharedSegments = 0;
  let shortDoglegs = 0;
  list.forEach((segment) => {
    if (!segment.horizontal && !segment.vertical) diagonalSegments += 1;
    const length = Math.abs(segment.a[0] - segment.b[0]) + Math.abs(segment.a[1] - segment.b[1]);
    if (length > 0 && length < 10) shortDoglegs += 1;
  });
  for (let left = 0; left < list.length; left += 1) {
    for (let right = left + 1; right < list.length; right += 1) {
      const a = list[left];
      const b = list[right];
      if (a.wireIndex === b.wireIndex) continue;
      if (a.horizontal && b.vertical) {
        const x = b.a[0];
        const y = a.a[1];
        if (between(x, a.a[0], a.b[0], true) && between(y, b.a[1], b.b[1], true) && !isBridged(a, b, x, y)) crossings += 1;
      } else if (a.vertical && b.horizontal) {
        const x = a.a[0];
        const y = b.a[1];
        if (between(x, b.a[0], b.b[0], true) && between(y, a.a[1], a.b[1], true) && !isBridged(a, b, x, y)) crossings += 1;
      } else if (a.horizontal && b.horizontal && a.a[1] === b.a[1]) {
        const overlap = Math.min(Math.max(a.a[0], a.b[0]), Math.max(b.a[0], b.b[0])) - Math.max(Math.min(a.a[0], a.b[0]), Math.min(b.a[0], b.b[0]));
        if (overlap > 0) sharedSegments += 1;
      } else if (a.vertical && b.vertical && a.a[0] === b.a[0]) {
        const overlap = Math.min(Math.max(a.a[1], a.b[1]), Math.max(b.a[1], b.b[1])) - Math.max(Math.min(a.a[1], a.b[1]), Math.min(b.a[1], b.b[1]));
        if (overlap > 0) sharedSegments += 1;
      }
    }
  }
  const bends = (wires || []).reduce((count, wire) => count + Math.max(0, prunePoints(wire.points).length - 2), 0);
  return { diagonalSegments, crossings, sharedSegments, shortDoglegs, bends };
}

export function scoreSchematicLayout(schematic) {
  const metrics = segmentMetrics(schematic?.wires || []);
  const penalty = metrics.diagonalSegments * 12
    + metrics.crossings * 16
    + metrics.sharedSegments * 6
    + metrics.shortDoglegs * 4
    + Math.max(0, metrics.bends - (schematic?.wires?.length || 0)) * 2;
  return { score: Math.max(0, Math.round(100 - penalty)), ...metrics };
}

function compactLabels(component) {
  const item = { ...component };
  if (REDUNDANT_VALUES.has(String(item.value || '').trim().toLowerCase())) item.hideValue = true;
  if (item.type === 'terminal') item.hideRef = true;
  return item;
}

function genericLayout(schematic) {
  return {
    ...schematic,
    components: (schematic.components || []).map(compactLabels),
    wires: (schematic.wires || []).map((wire) => ({ ...wire, points: orthogonalize(wire.points) })),
  };
}

function isFinitePoint(point) {
  return Array.isArray(point) && point.length >= 2 && Number.isFinite(Number(point[0])) && Number.isFinite(Number(point[1]));
}

function pointDistanceToSegment(point, a, b) {
  const px = Number(point[0]);
  const py = Number(point[1]);
  const ax = Number(a[0]);
  const ay = Number(a[1]);
  const bx = Number(b[0]);
  const by = Number(b[1]);
  const dx = bx - ax;
  const dy = by - ay;
  if (!dx && !dy) return Math.hypot(px - ax, py - ay);
  const ratio = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + ratio * dx), py - (ay + ratio * dy));
}

function pointTouchesComponent(point, components) {
  return (components || []).some((component) => componentTerminalPoints(component).some((pin) => (
    Math.hypot(Number(point[0]) - pin.x, Number(point[1]) - pin.y) <= CONNECTION_TOLERANCE
  )));
}

function pointTouchesOtherWire(point, wires, ownWireIndex) {
  return (wires || []).some((wire, wireIndex) => {
    if (wireIndex === ownWireIndex) return false;
    const points = wire.points || [];
    for (let index = 1; index < points.length; index += 1) {
      if (isFinitePoint(points[index - 1]) && isFinitePoint(points[index])
        && pointDistanceToSegment(point, points[index - 1], points[index]) <= CONNECTION_TOLERANCE) return true;
    }
    return false;
  });
}

export function auditSchematicConnectivity(schematic, context = {}) {
  const wires = schematic?.wires || [];
  const components = schematic?.components || [];
  const invalidWires = [];
  const openEndpoints = [];
  let zeroLengthSegments = 0;
  wires.forEach((wire, wireIndex) => {
    const points = wire.points || [];
    if (points.length < 2 || points.some((point) => !isFinitePoint(point))) {
      invalidWires.push(wireIndex);
      return;
    }
    for (let index = 1; index < points.length; index += 1) {
      if (samePoint(points[index - 1], points[index])) zeroLengthSegments += 1;
    }
    [0, points.length - 1].forEach((pointIndex, endpointIndex) => {
      const point = points[pointIndex];
      if (!pointTouchesComponent(point, components) && !pointTouchesOtherWire(point, wires, wireIndex)) {
        openEndpoints.push({ wireIndex, end: endpointIndex ? 'to' : 'from', point: [Number(point[0]), Number(point[1])] });
      }
    });
  });

  const endpoints = new Set(wires.flatMap((wire) => {
    const points = wire.points || [];
    return points.length ? [points[0], points.at(-1)] : [];
  }).filter(isFinitePoint).map(pointKey));
  const missingPins = context.kind === 'motor-driver'
    ? MOTOR_DRIVER_REQUIRED_PINS.filter(([, x, y]) => !endpoints.has(`${x},${y}`)).map(([name]) => name)
    : [];
  const requiredPins = context.kind === 'motor-driver' ? MOTOR_DRIVER_REQUIRED_PINS.length : endpoints.size;
  const connectedPins = context.kind === 'motor-driver'
    ? MOTOR_DRIVER_REQUIRED_PINS.length - missingPins.length
    : Math.max(0, requiredPins - openEndpoints.length);
  const danglingEndpoints = missingPins.length + openEndpoints.length + invalidWires.length + zeroLengthSegments;
  return {
    checked: true,
    requiredPins,
    connectedPins,
    danglingEndpoints,
    missingPins,
    openEndpoints,
    invalidWires,
    zeroLengthSegments,
    continuous: danglingEndpoints === 0,
  };
}

function pinById(component, pinId) {
  return componentTerminalPoints(component).find((pin) => pin.id === pinId);
}

function chooseConnectionPair(from, to, wire = {}) {
  const fromPins = componentTerminalPoints(from);
  const toPins = componentTerminalPoints(to);
  const fixedFrom = pinById(from, wire.fromPin);
  const fixedTo = pinById(to, wire.toPin);
  let best = null;
  for (const fromPin of fixedFrom ? [fixedFrom] : fromPins) {
    for (const toPin of fixedTo ? [fixedTo] : toPins) {
      const distance = Math.abs(fromPin.x - toPin.x) + Math.abs(fromPin.y - toPin.y);
      const facingPenalty = Math.max(0, fromPin.normal[0] * (fromPin.x - toPin.x) + fromPin.normal[1] * (fromPin.y - toPin.y)) * 2
        + Math.max(0, toPin.normal[0] * (toPin.x - fromPin.x) + toPin.normal[1] * (toPin.y - fromPin.y)) * 2;
      const score = distance + facingPenalty;
      if (!best || score < best.score) best = { fromPin, toPin, score };
    }
  }
  return best;
}

const LEGACY_PIN_MIGRATION = Object.freeze({
  BODY_LEFT: 'L1',
  BODY_RIGHT: 'R1',
  BODY_TOP: 'POWER_TOP',
  BODY_BOTTOM: 'POWER_BOTTOM',
  IN_PLUS_BODY: 'IN_PLUS',
  IN_MINUS_BODY: 'IN_MINUS',
});
const LEGACY_PIN_IDS = new Set(Object.keys(LEGACY_PIN_MIGRATION));
const LEGACY_ANCHOR_TOLERANCE = 0.01;

function pointDistance(point, target) {
  return Math.hypot(Number(point?.[0]) - target.x, Number(point?.[1]) - target.y);
}

function canonicalPinAtPoint(component, point) {
  return componentTerminalPoints(component).reduce((best, pin) => {
    const distance = pointDistance(point, pin);
    if (distance > CONNECTION_TOLERANCE || (best && best.distance <= distance)) return best;
    return { ...pin, distance };
  }, null);
}

function legacyAnchors(component) {
  return connectionPointsFromDefinitions(component, legacyDiagramAnchorDefinitions(component));
}

function chooseLegacyReplacement(component, legacyAnchor, point, neighbor) {
  if (!legacyAnchor || pointDistance(point, legacyAnchor) > LEGACY_ANCHOR_TOLERANCE) return null;
  const mapped = pinById(component, LEGACY_PIN_MIGRATION[legacyAnchor.id]);
  if (mapped) return mapped;
  const dx = Number(neighbor?.[0]) - legacyAnchor.x;
  const dy = Number(neighbor?.[1]) - legacyAnchor.y;
  const magnitude = Math.hypot(dx, dy) || 1;
  const direction = [dx / magnitude, dy / magnitude];
  return componentTerminalPoints(component).reduce((best, pin) => {
    const outwardPenalty = (1 - (pin.normal[0] * direction[0] + pin.normal[1] * direction[1])) * 100;
    const distancePenalty = Math.hypot(pin.x - legacyAnchor.x, pin.y - legacyAnchor.y);
    const continuationPenalty = Math.min(Math.abs(pin.x - Number(neighbor?.[0])), Math.abs(pin.y - Number(neighbor?.[1])));
    const score = outwardPenalty + distancePenalty + continuationPenalty;
    return !best || score < best.score ? { ...pin, score } : best;
  }, null);
}

function migratedEndpointBinding(component, pinId, point, neighbor) {
  const canonical = pinById(component, pinId);
  if (canonical) return canonical;
  if (LEGACY_PIN_IDS.has(pinId)) {
    const mapped = pinById(component, LEGACY_PIN_MIGRATION[pinId]);
    if (mapped) return mapped;
    const anchor = legacyAnchors(component).find((item) => item.id === pinId);
    return chooseLegacyReplacement(component, anchor, point, neighbor);
  }
  const exactTerminal = canonicalPinAtPoint(component, point);
  if (exactTerminal) return exactTerminal;
  const anchor = legacyAnchors(component).find((item) => pointDistance(point, item) <= LEGACY_ANCHOR_TOLERANCE);
  return chooseLegacyReplacement(component, anchor, point, neighbor);
}

function locateMigratedEndpoint(components, point, neighbor) {
  let best = locateCanonicalEndpoint(components, point);
  if (best) return best;
  for (const component of components || []) {
    for (const anchor of legacyAnchors(component)) {
      const distance = pointDistance(point, anchor);
      if (distance > LEGACY_ANCHOR_TOLERANCE) continue;
      const pin = chooseLegacyReplacement(component, anchor, point, neighbor);
      if (pin && (!best || distance < best.distance)) best = { component, pin, distance };
    }
  }
  return best;
}

function locateCanonicalEndpoint(components, point) {
  let best = null;
  for (const component of components || []) {
    const canonical = canonicalPinAtPoint(component, point);
    if (canonical && (!best || canonical.distance < best.distance)) best = { component, pin: canonical, distance: canonical.distance };
  }
  return best;
}

export function canConnectEditorPins(from, to, toComponentId, toPinId) {
  const start = typeof from === 'object' ? from : { componentId: from, pinId: to };
  const end = typeof from === 'object' ? to : { componentId: toComponentId, pinId: toPinId };
  return Boolean(start?.componentId && start?.pinId && end?.componentId && end?.pinId
    && start.componentId !== end.componentId);
}

export function normalizeEditorWireEndpoints(wires = [], components = []) {
  const byId = new Map((components || []).map((component) => [component.id, component]));
  return (wires || []).map((wire) => {
    const item = clone(wire);
    const points = Array.isArray(item.points) ? item.points : [];
    for (const endpoint of ['from', 'to']) {
      const atStart = endpoint === 'from';
      const point = points[atStart ? 0 : points.length - 1];
      const neighbor = points[atStart ? 1 : points.length - 2];
      const pinField = `${endpoint}Pin`;
      const component = byId.get(item[endpoint]);
      const migratedPin = component && point
        ? migratedEndpointBinding(component, item[pinField], point, neighbor)
        : component && LEGACY_PIN_IDS.has(item[pinField])
          ? pinById(component, LEGACY_PIN_MIGRATION[item[pinField]])
          : component
            ? pinById(component, item[pinField])
            : null;
      const located = migratedPin ? { component, pin: migratedPin } : point ? locateMigratedEndpoint(components, point, neighbor) : null;
      if (located) {
        item[endpoint] = located.component.id;
        item[pinField] = located.pin.id;
      } else {
        delete item[endpoint];
        delete item[pinField];
      }
    }
    return item;
  });
}

export const migrateLegacyEditorWireEndpoints = normalizeEditorWireEndpoints;

function orthogonalRoute(fromPin, toPin) {
  const start = [fromPin.x, fromPin.y];
  const end = [toPin.x, toPin.y];
  if (start[0] === end[0] || start[1] === end[1]) return [start, end];
  const verticalPreference = Math.abs(fromPin.normal[1]) + Math.abs(toPin.normal[1]);
  const horizontalPreference = Math.abs(fromPin.normal[0]) + Math.abs(toPin.normal[0]);
  if (verticalPreference > horizontalPreference) {
    const midY = Math.round((start[1] + end[1]) / 20) * 10;
    return prunePoints([start, [start[0], midY], [end[0], midY], end]);
  }
  const midX = Math.round((start[0] + end[0]) / 20) * 10;
  return prunePoints([start, [midX, start[1]], [midX, end[1]], end]);
}

// Symbol bodies are kept separate from their terminal offsets so a connected
// wire can be checked while a component is being dragged.  These bounds are
// deliberately conservative around the drawn shape, but do not include the
// lead area between the body and a real pin.
function componentBodyRect(component = {}, padding = 1) {
  const bounds = (() => {
    switch (component.type) {
      case 'terminal': return { x: -5, y: -5, width: 10, height: 10 };
      case 'resistor': return { x: -27, y: -18, width: 54, height: 36 };
      case 'potentiometer': return { x: -27, y: -18, width: 54, height: 36 };
      case 'fuse': return { x: -25, y: -8, width: 50, height: 16 };
      case 'switch': return { x: -22, y: -17, width: 44, height: 17 };
      case 'capacitor': return { x: -16, y: -11, width: 32, height: 22 };
      case 'electrolytic': return { x: -16, y: -11, width: 32, height: 22 };
      case 'inductor': return { x: -31, y: -15, width: 62, height: 30 };
      case 'crystal': return { x: -19, y: -15, width: 38, height: 30 };
      case 'transformer': return { x: -36, y: -30, width: 72, height: 60 };
      case 'diode':
      case 'led':
      case 'zener':
      case 'schottky':
      case 'tvs-diode':
      case 'photodiode': return { x: -25, y: -15, width: 31, height: 30 };
      case 'thermistor':
      case 'varistor':
      case 'photoresistor': return { x: -27, y: -22, width: 54, height: 44 };
      case 'ferrite-bead': return { x: -31, y: -15, width: 62, height: 30 };
      case 'tantalum': return { x: -16, y: -11, width: 32, height: 22 };
      case 'scr':
      case 'triac':
      case 'igbt': return { x: -35, y: -41, width: 43, height: 82 };
      case 'push-button': return { x: -22, y: -26, width: 44, height: 44 };
      case 'dip-switch': return { x: -34, y: -24, width: 68, height: 48 };
      case 'speaker': return { x: -18, y: -22, width: 40, height: 44 };
      case 'mic': return { x: -16, y: -16, width: 32, height: 32 };
      case 'usb-port': return { x: -38, y: -26, width: 76, height: 52 };
      case 'dc-jack': return { x: -34, y: -22, width: 68, height: 44 };
      case 'battery-holder': return { x: -14, y: -22, width: 28, height: 44 };
      case 'jumper': return { x: -14, y: -12, width: 28, height: 24 };
      // 排针引脚在 x=39；体矩形必须止于 38，否则到达引脚的导线会被判为穿体而触发绕线。
      case 'header': return { x: -8, y: -28, width: 46, height: 56 };
      case 'antenna': return { x: -14, y: -40, width: 28, height: 66 };
      case 'stepper': return { x: -22, y: -22, width: 44, height: 44 };
      case 'servo': return { x: -40, y: -26, width: 80, height: 52 };
      case 'fan': return { x: -22, y: -22, width: 44, height: 44 };
      case 'solenoid': return { x: -24, y: -16, width: 48, height: 32 };
      case 'ir-receiver': return { x: -26, y: -20, width: 52, height: 40 };
      case 'sensor3': return { x: -28, y: -20, width: 56, height: 40 };
      case 'sensor4': return { x: -36, y: -24, width: 72, height: 48 };
      case 'lcd': return { x: -45, y: -32, width: 90, height: 64 };
      case 'wireless-module': return { x: -45, y: -36, width: 90, height: 72 };
      case 'sonar': return { x: -45, y: -32, width: 90, height: 64 };
      case 'opamp': return { x: -55, y: -40, width: 75, height: 80 };
      case 'comparator': return { x: -55, y: -40, width: 75, height: 80 };
      case 'source': return { x: -22, y: -22, width: 44, height: 44 };
      case 'battery': return { x: -6, y: -19, width: 12, height: 38 };
      case 'motor': return { x: -22, y: -22, width: 44, height: 44 };
      case 'buzzer': return { x: -20, y: -28, width: 42, height: 56 };
      case 'testpoint': return { x: -11, y: -11, width: 22, height: 22 };
      case 'ground': return { x: -17, y: 0, width: 34, height: 12 };
      case 'mosfet': return { x: -35, y: -41, width: 43, height: 82 };
      case 'pmosfet': return { x: -35, y: -41, width: 43, height: 82 };
      case 'bjt': return { x: -5, y: -34, width: 32, height: 68 };
      case 'voltage-regulator': return { x: -45, y: -30, width: 90, height: 60 };
      case 'logic-gate': return { x: -45, y: -30, width: 65, height: 60 };
      case 'relay': return { x: -45, y: -30, width: 90, height: 60 };
      case 'opto': return { x: -45, y: -30, width: 90, height: 60 };
      default: {
        const width = component.type === 'connector' ? 64 : 90;
        return { x: -width / 2, y: -30, width, height: 60 };
      }
    }
  })();
  const rotation = ((Number(component.rotate) || 0) % 360 + 360) % 360;
  const corners = [
    [bounds.x, bounds.y],
    [bounds.x + bounds.width, bounds.y],
    [bounds.x + bounds.width, bounds.y + bounds.height],
    [bounds.x, bounds.y + bounds.height],
  ].map((point) => rotateOffset(point, rotation));
  const x = Number(component.x) || 0;
  const y = Number(component.y) || 0;
  const minX = Math.min(...corners.map(([cx]) => cx)) + x - padding;
  const maxX = Math.max(...corners.map(([cx]) => cx)) + x + padding;
  const minY = Math.min(...corners.map(([, cy]) => cy)) + y - padding;
  const maxY = Math.max(...corners.map(([, cy]) => cy)) + y + padding;
  return { minX, maxX, minY, maxY };
}

function pointInRect(point, rect) {
  return Number(point?.[0]) >= rect.minX && Number(point?.[0]) <= rect.maxX
    && Number(point?.[1]) >= rect.minY && Number(point?.[1]) <= rect.maxY;
}

function segmentIntersectsRect(start, end, rect) {
  const ax = Number(start?.[0]);
  const ay = Number(start?.[1]);
  const bx = Number(end?.[0]);
  const by = Number(end?.[1]);
  if (![ax, ay, bx, by].every(Number.isFinite)) return false;
  if (ax === bx) return ax >= rect.minX && ax <= rect.maxX
    && Math.max(Math.min(ay, by), rect.minY) <= Math.min(Math.max(ay, by), rect.maxY);
  if (ay === by) return ay >= rect.minY && ay <= rect.maxY
    && Math.max(Math.min(ax, bx), rect.minX) <= Math.min(Math.max(ax, bx), rect.maxX);
  // Routes are orthogonalized before this check. Keep a conservative fallback
  // for imported data that still contains a diagonal segment.
  const steps = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) / 4));
  for (let index = 0; index <= steps; index += 1) {
    const ratio = index / steps;
    if (pointInRect([ax + (bx - ax) * ratio, ay + (by - ay) * ratio], rect)) return true;
  }
  return false;
}

function segmentEntersRectInterior(start, end, rect) {
  const ax = Number(start?.[0]);
  const ay = Number(start?.[1]);
  const bx = Number(end?.[0]);
  const by = Number(end?.[1]);
  if (![ax, ay, bx, by].every(Number.isFinite)) return false;
  if (ax === bx) return ax > rect.minX && ax < rect.maxX
    && Math.max(Math.min(ay, by), rect.minY) < Math.min(Math.max(ay, by), rect.maxY);
  if (ay === by) return ay > rect.minY && ay < rect.maxY
    && Math.max(Math.min(ax, bx), rect.minX) < Math.min(Math.max(ax, bx), rect.maxX);
  const steps = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) / 4));
  for (let index = 1; index < steps; index += 1) {
    const ratio = index / steps;
    const x = ax + (bx - ax) * ratio;
    const y = ay + (by - ay) * ratio;
    if (x > rect.minX && x < rect.maxX && y > rect.minY && y < rect.maxY) return true;
  }
  return false;
}

function endpointPinFor(points, endpoint, component, pinId) {
  if (!component) return null;
  const bound = pinById(component, pinId);
  if (bound) return bound;
  const point = endpoint === 'from' ? points[0] : points.at(-1);
  return point ? canonicalPinAtPoint(component, point) : null;
}

function pathIntersectsComponentBody(points, components, fromComponent, toComponent, fromPin, toPin) {
  if (!Array.isArray(points) || points.length < 2) return false;
  const fromId = fromComponent?.id;
  const toId = toComponent?.id;
  return points.slice(0, -1).some((start, segmentIndex) => {
    const end = points[segmentIndex + 1];
    return (components || []).some((component) => {
      const rect = componentBodyRect(component);
      const isFromLead = component.id && component.id === fromId && segmentIndex === 0;
      const isToLead = component.id && component.id === toId && segmentIndex === points.length - 2;
      if (isFromLead || isToLead) {
        const pin = isFromLead ? fromPin : toPin;
        // A terminal's connection point is inside its small graphic; the lead
        // is allowed to leave it. For real edge pins, entering the body is not.
        if (pin && component.type === 'terminal' && pointInRect([pin.x, pin.y], rect)) return false;
        return segmentEntersRectInterior(start, end, componentBodyRect(component, 0));
      }
      return segmentIntersectsRect(start, end, rect);
    });
  });
}

function routeEscape(pin, other, fromTarget = false) {
  const nx = Number(pin?.normal?.[0]) || 0;
  const ny = Number(pin?.normal?.[1]) || 0;
  if (Math.abs(nx) > .1 || Math.abs(ny) > .1) return [Math.sign(nx), Math.sign(ny)];
  const dx = Number(other?.x) - Number(pin?.x);
  const dy = Number(other?.y) - Number(pin?.y);
  if (Math.abs(dx) >= Math.abs(dy)) return [Math.sign(dx) * (fromTarget ? -1 : 1) || 1, 0];
  return [0, Math.sign(dy) * (fromTarget ? -1 : 1) || 1];
}

function safeOrthogonalRoute(fromPin, toPin, components = [], endpoint = {}) {
  const start = [Number(fromPin.x), Number(fromPin.y)];
  const end = [Number(toPin.x), Number(toPin.y)];
  const startEscapeDirection = routeEscape(fromPin, toPin);
  const endEscapeDirection = routeEscape(toPin, fromPin, true);
  const escapeDistance = 12;
  const startEscape = [start[0] + startEscapeDirection[0] * escapeDistance, start[1] + startEscapeDirection[1] * escapeDistance];
  const endEscape = [end[0] + endEscapeDirection[0] * escapeDistance, end[1] + endEscapeDirection[1] * escapeDistance];
  const obstacles = (components || []).map((component) => componentBodyRect(component, 2));
  const obstacleExtents = obstacles.reduce((result, rect) => ({
    minX: Math.min(result.minX, rect.minX), maxX: Math.max(result.maxX, rect.maxX),
    minY: Math.min(result.minY, rect.minY), maxY: Math.max(result.maxY, rect.maxY),
  }), { minX: Math.min(start[0], end[0]), maxX: Math.max(start[0], end[0]), minY: Math.min(start[1], end[1]), maxY: Math.max(start[1], end[1]) });
  const xDetours = [
    startEscape[0], endEscape[0],
    ...obstacles.flatMap((rect) => [rect.minX - escapeDistance, rect.maxX + escapeDistance]),
    obstacleExtents.minX - escapeDistance * 2, obstacleExtents.maxX + escapeDistance * 2,
  ];
  const yDetours = [
    startEscape[1], endEscape[1],
    ...obstacles.flatMap((rect) => [rect.minY - escapeDistance, rect.maxY + escapeDistance]),
    obstacleExtents.minY - escapeDistance * 2, obstacleExtents.maxY + escapeDistance * 2,
  ];
  const candidates = [];
  const addCandidate = (middle) => {
    const route = orthogonalize([start, startEscape, ...middle, endEscape, end]);
    if (!route.length || pathIntersectsComponentBody(route, components, endpoint.fromComponent, endpoint.toComponent, fromPin, toPin)) return;
    const length = route.slice(1).reduce((sum, point, index) => sum + Math.abs(point[0] - route[index][0]) + Math.abs(point[1] - route[index][1]), 0);
    candidates.push({ route, length });
  };
  for (const x of xDetours) addCandidate([[x, startEscape[1]], [x, endEscape[1]]]);
  for (const y of yDetours) addCandidate([[startEscape[0], y], [endEscape[0], y]]);
  if (!candidates.length) return orthogonalRoute(fromPin, toPin);
  candidates.sort((left, right) => left.length - right.length);
  return candidates[0].route;
}

function replaceBoundEndpoint(points, endpoint, anchor) {
  if (!points.length || !anchor) return points;
  const atStart = endpoint === 'from';
  const pointIndex = atStart ? 0 : points.length - 1;
  const neighborIndex = atStart ? 1 : points.length - 2;
  const previousEndpoint = points[pointIndex];
  const neighbor = points[neighborIndex];
  points[pointIndex] = [anchor.x, anchor.y];
  if (!neighbor || points[pointIndex][0] === neighbor[0] || points[pointIndex][1] === neighbor[1]) return points;
  const bend = previousEndpoint?.[1] === neighbor[1]
    ? [neighbor[0], anchor.y]
    : previousEndpoint?.[0] === neighbor[0]
      ? [anchor.x, neighbor[1]]
      : [neighbor[0], anchor.y];
  points.splice(atStart ? 1 : points.length - 1, 0, bend);
  return points;
}

export function resolveEditorWirePoints(wire = {}, components = []) {
  const byId = new Map((components || []).map((component) => [component.id, component]));
  const from = byId.get(wire.from);
  const to = byId.get(wire.to);
  const hasFromPin = Object.prototype.hasOwnProperty.call(wire, 'fromPin');
  const hasToPin = Object.prototype.hasOwnProperty.call(wire, 'toPin');
  if ((hasFromPin && (!from || !pinById(from, wire.fromPin)))
    || (hasToPin && (!to || !pinById(to, wire.toPin)))) return [];
  if (Array.isArray(wire.points) && wire.points.length > 1) {
    const points = wire.points.map((point) => [Number(point[0]), Number(point[1])]);
    let fromPin = null;
    let toPin = null;
    if (from) {
      fromPin = endpointPinFor(points, 'from', from, wire.fromPin);
      replaceBoundEndpoint(points, 'from', fromPin);
    }
    if (to) {
      toPin = endpointPinFor(points, 'to', to, wire.toPin);
      replaceBoundEndpoint(points, 'to', toPin);
    }
    const resolved = orthogonalize(points);
    const routeFrom = fromPin || (resolved[0] ? { x: resolved[0][0], y: resolved[0][1], normal: [0, 0] } : null);
    const routeTo = toPin || (resolved.at(-1) ? { x: resolved.at(-1)[0], y: resolved.at(-1)[1], normal: [0, 0] } : null);
    if (routeFrom && routeTo && (fromPin || toPin)
      && pathIntersectsComponentBody(resolved, components, from, to, fromPin, toPin)) {
      return safeOrthogonalRoute(routeFrom, routeTo, components, { fromComponent: from, toComponent: to });
    }
    return resolved;
  }
  if (!from || !to) return [];
  const pair = chooseConnectionPair(from, to, wire);
  return pair ? safeOrthogonalRoute(pair.fromPin, pair.toPin, components, { fromComponent: from, toComponent: to }) : [];
}

export function bindEditorWireEndpoints(wires = [], components = []) {
  return (wires || []).map((wire) => {
    const item = clone(wire);
    const points = item.points || [];
    const bindings = [
      ['from', 'fromPin', points[0]],
      ['to', 'toPin', points.at(-1)],
    ];
    for (const [componentField, pinField, point] of bindings) {
      const located = point ? locateCanonicalEndpoint(components, point) : null;
      if (located) Object.assign(item, { [componentField]: located.component.id, [pinField]: located.pin.id });
      else {
        delete item[componentField];
        delete item[pinField];
      }
    }
    return item;
  });
}

export function auditEditorConnectivity(editor = {}) {
  const schematic = {
    components: editor.components || [],
    wires: (editor.wires || []).map((wire) => ({ ...wire, points: resolveEditorWirePoints(wire, editor.components || []) })),
  };
  return auditSchematicConnectivity(schematic);
}

function motorDriverLayout(schematic) {
  const byRef = new Map((schematic.components || []).map((item) => [item.ref, item]));
  const place = (ref, x, y, extra = {}) => compactLabels({ ...(byRef.get(ref) || {}), x, y, ...extra });
  const components = [
    place('J1', 35, 90, { hideRef: true }),
    place('F1', 100, 90, { hideValue: true }),
    // A rotated MOSFET's two current-path pins sit at y + 8. Moving the
    // symbol up by 8 keeps both pins exactly on the y=90 power rail.
    place('QREV1', 200, 82, { rotate: 90, hideRef: true, hideValue: true }),
    place('U1', 430, 190, { powerPins: true, controlPin: true }),
    place('J3', 520, 160, { hideRef: true }),
    place('J4', 520, 245, { hideRef: true }),
    place('TVS', 255, 220, { rotate: 90, hideRef: true, hideValue: true }),
    place('CBULK', 305, 225, { hideRef: true, labelSide: 'right', labelX: 16, labelY: -15 }),
    place('CIN', 360, 225, { hideRef: true, labelSide: 'right', labelY: 20 }),
    place('J2', 45, 405, { hideRef: true }),
    place('RIN', 145, 405, { hideRef: true }),
    place('PGND', 330, 365),
  ].filter((item) => item.type);

  const wires = [
    { points: [[35, 90], [65, 90]] },
    { points: [[135, 90], [159, 90]] },
    { points: [[241, 90], [430, 90], [430, 148]], junctions: [[255, 90], [305, 90], [360, 90], [430, 90]] },
    { points: [[487, 178], [500, 178], [500, 160], [520, 160]] },
    { points: [[487, 202], [487, 245], [520, 245]] },
    { points: [[45, 405], [106, 405]] },
    // Route control below the power/ground network and enter through a
    // dedicated U1 bottom pin, so no crossing or intentional visual gap is
    // needed anywhere on the control wire.
    { points: [[184, 405], [450, 405], [450, 232]], net: 'CTRL' },
    { points: [[255, 90], [255, 183]], label: 'TVS', labelX: 264, labelY: 158 },
    { points: [[255, 257], [255, 345]] },
    { points: [[305, 90], [305, 195]] },
    { points: [[305, 255], [305, 345]] },
    { points: [[360, 90], [360, 195]] },
    { points: [[360, 255], [360, 345]] },
    { points: [[430, 232], [430, 345]] },
    { points: [[255, 345], [430, 345]], junctions: [[255, 345], [305, 345], [330, 345], [360, 345], [430, 345]] },
    { points: [[330, 345], [330, 355]] },
  ];
  return { components, wires };
}

export function optimizeSchematicLayout(schematic, context = {}) {
  const original = clone(schematic);
  const before = scoreSchematicLayout(original);
  const optimized = context.kind === 'motor-driver' ? motorDriverLayout(original) : genericLayout(original);
  const after = scoreSchematicLayout(optimized);
  const connectivity = auditSchematicConnectivity(optimized, context);
  if (connectivity.danglingEndpoints > 0) {
    const open = connectivity.openEndpoints.map((item) => `wire ${item.wireIndex} ${item.end}@${item.point.join(',')}`);
    const details = [...connectivity.missingPins, ...open, ...connectivity.invalidWires.map((index) => `invalid wire ${index}`)];
    throw new Error(`Schematic connectivity check failed: ${details.join('; ') || `${connectivity.danglingEndpoints} continuity errors`}`);
  }
  optimized.layout = {
    agent: 'SchematicLayoutAgent',
    policyVersion: POLICY_VERSION,
    mode: 'concise',
    direction: 'RIGHT',
    routing: 'ORTHOGONAL',
    score: after.score,
    beforeScore: before.score,
    metrics: after,
    connectivity,
    hiddenLabels: optimized.components.filter((item) => item.hideRef || item.hideValue).length,
    learnedFrom: [...LAYOUT_POLICY.sources],
  };
  return optimized;
}
