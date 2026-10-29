import test from 'node:test';
import assert from 'node:assert/strict';
import { COMPONENT_LIBRARY, MARKET_PARTS_LIBRARY } from '../src/shared/core.mjs';
import { componentTerminalPoints, resolveEditorWirePoints, optimizeSchematicLayout } from '../src/shared/layout-agent.mjs';

test('每种元件符号都有可连线的真实引脚且引脚 ID 唯一', () => {
  assert.ok(COMPONENT_LIBRARY.length >= 60, `元件库应有 60 种以上，实际 ${COMPONENT_LIBRARY.length}`);
  for (const definition of COMPONENT_LIBRARY) {
    const pins = componentTerminalPoints({ type: definition.type, x: 100, y: 100 });
    assert.ok(pins.length >= 1, `${definition.type} 至少要有一个引脚`);
    const ids = new Set(pins.map((pin) => pin.id));
    assert.equal(ids.size, pins.length, `${definition.type} 引脚 ID 重复`);
    for (const pin of pins) {
      assert.ok(Number.isFinite(pin.x) && Number.isFinite(pin.y), `${definition.type} 引脚 ${pin.id} 坐标必须是有限数`);
      assert.ok(Array.isArray(pin.normal) && pin.normal.length === 2, `${definition.type} 引脚 ${pin.id} 缺少法向量`);
    }
  }
});

test('旋转后的元件引脚坐标随旋转更新（连线绑定的前提）', () => {
  const base = componentTerminalPoints({ type: 'mosfet', x: 100, y: 100, rotate: 0 });
  const rotated = componentTerminalPoints({ type: 'mosfet', x: 100, y: 100, rotate: 90 });
  const moved = rotated.some((pin) => Math.hypot(pin.x - 100, pin.y - 100) > 10);
  assert.ok(moved, '旋转 90° 后引脚应显著移动');
  assert.equal(base.length, rotated.length);
});

test('带连线的元件旋转后导线端点仍精确绑定到新引脚位置', () => {
  const resistor = { id: 'cmp-r', type: 'resistor', ref: 'R1', value: '10k', x: 100, y: 100, rotate: 0 };
  const led = { id: 'cmp-led', type: 'led', ref: 'D1', value: 'LED', x: 300, y: 100, rotate: 0 };
  const wire = {
    id: 'wire-1', from: 'cmp-r', fromPin: 'B', to: 'cmp-led', toPin: 'A',
    points: [[139, 100], [263, 100]],
  };
  const before = resolveEditorWirePoints(wire, [resistor, led]);
  assert.equal(before.at(-1)[0], 263);
  assert.equal(before.at(-1)[1], 100);
  resistor.rotate = 90;
  const after = resolveEditorWirePoints(wire, [resistor, led]);
  const endPin = componentTerminalPoints(resistor).find((pin) => pin.id === 'B');
  assert.equal(after.at(0)[0], endPin.x, '旋转后起点应吸附到新引脚位置');
  assert.equal(after.at(0)[1], endPin.y, '旋转后起点应吸附到新引脚位置');
});

test('市场元件库条目完整：型号存在、符号类型可解析、封装齐全', () => {
  assert.ok(MARKET_PARTS_LIBRARY.length >= 45, `市场元件应不少于 45 件，实际 ${MARKET_PARTS_LIBRARY.length}`);
  const symbolTypes = new Set(COMPONENT_LIBRARY.map((item) => item.type));
  const ids = new Set();
  const groups = new Set();
  for (const part of MARKET_PARTS_LIBRARY) {
    assert.ok(!ids.has(part.id), `市场元件 id 重复：${part.id}`);
    ids.add(part.id);
    assert.ok(part.part && part.part.length >= 2, `${part.id} 缺少型号`);
    assert.ok(symbolTypes.has(part.symbolType), `${part.part} 引用的符号类型 ${part.symbolType} 不在元件库中`);
    assert.ok(part.footprint && part.footprint.length >= 2, `${part.part} 缺少封装`);
    assert.ok(part.description && part.description.length >= 6, `${part.part} 缺少说明`);
    assert.ok(part.group, `${part.part} 缺少分组`);
    groups.add(part.group);
  }
  assert.ok(groups.size >= 6, `分组应不少于 6 个，实际 ${groups.size}`);
});

test('市场元件放置后可以通过位号前缀与真实引脚正常连线', () => {
  const part = MARKET_PARTS_LIBRARY.find((item) => item.part === 'AMS1117-3.3');
  assert.ok(part, '缺少 AMS1117-3.3 预设');
  const definition = COMPONENT_LIBRARY.find((item) => item.type === part.symbolType);
  assert.equal(definition.prefix, 'U');
  const placed = { type: part.symbolType, x: 200, y: 200 };
  const pins = componentTerminalPoints(placed);
  assert.ok(pins.length >= 3, '稳压器应有 IN/OUT/GND 等至少 3 个引脚');
  // 与旁边的电容自动布线应成功（端点落在引脚上）。
  const cap = { id: 'cmp-c', type: 'capacitor', x: 320, y: 200 };
  const route = resolveEditorWirePoints({ from: 'u1', fromPin: 'OUT', to: 'cmp-c', toPin: 'TOP' }, [{ id: 'u1', ...placed }, cap]);
  assert.ok(route.length >= 2);
  assert.deepEqual(route.at(-1), [320, 170]);
});

test('包含新元件类型的整图仍能通过布线校验并优化排版', () => {
  const schematic = {
    components: [
      { type: 'terminal', ref: 'J1', value: 'VIN', x: 40, y: 120 },
      { type: 'voltage-regulator', ref: 'U1', value: 'AMS1117-3.3', x: 180, y: 120 },
      { type: 'tantalum', ref: 'C1', value: '10µF', x: 320, y: 180 },
      { type: 'ground', ref: 'GND', value: '', x: 180, y: 240 },
    ],
    wires: [
      { points: [[40, 120], [123, 120]] },
      { points: [[237, 120], [320, 120], [320, 150]] },
      { points: [[320, 210], [320, 235], [180, 235], [180, 162]] },
    ],
  };
  const optimized = optimizeSchematicLayout(schematic, {});
  assert.ok(optimized.layout.connectivity.continuous, '布线校验应连续无悬空');
});
