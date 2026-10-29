import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { solveCircuitProblem } from '../src/shared/core.mjs';

const require = createRequire(import.meta.url);
const ai = require('../src/main/ai-provider.cjs');
const entries = [{ title: '测试资料', content: 'PRIVATE_PASSAGE_测试片段', pageStart: 3 }];

test('完整解题链路保留 M/m/k/meg 及中文欧姆前缀', () => {
  for (const [question, answer] of [
    ['R1=2MΩ、R2=3MΩ 串联', '等效电阻 Req = 5 MΩ'],
    ['R1=2mΩ、R2=3mΩ 串联', '等效电阻 Req = 0.005 Ω'],
    ['R1=2M欧姆、R2=3M欧 串联', '等效电阻 Req = 5 MΩ'],
    ['R1=2MEGohm、R2=3megOHM 串联', '等效电阻 Req = 5 MΩ'],
    ['R1=2KΩ、R2=3kΩ 串联', '等效电阻 Req = 5 kΩ'],
    ['R1=2MΩ、R2=2MΩ 并联', '等效电阻 Req = 1 MΩ'],
    ['V=5V，R=1MΩ，求电流', '电流 I = 5 µA'],
    ['V=5V，R=1mΩ，求电流', '电流 I = 5 kA'],
    ['VIN=12V，R1=1MΩ、R2=1kΩ 分压求 VOUT', '输出电压 Vout = 11.988 mV'],
    ['RC 低通 R=1MΩ、C=1μF 求截止频率', '截止频率 fc ≈ 159.1549 mHz'],
    ['V=5V，I=2mA，求功率', '功率 P = 10 mW'],
  ]) assert.equal(solveCircuitProblem(question).answer, answer, question);
});

test('端点判定覆盖 IPv4 回环、IPv6 回环、远程和伪装主机', () => {
  for (const url of ['http://127.0.0.1:11434', 'http://127.20.30.40', 'http://localhost', 'http://LOCALHOST:8080', 'http://[::1]:11434', 'https://[0:0:0:0:0:0:0:1]']) {
    assert.equal(ai.isLoopbackEndpoint(url), true, url);
    assert.doesNotThrow(() => ai.validateEndpoint(url));
  }
  for (const url of ['https://models.example.com', 'https://192.168.1.5', 'https://[2001:db8::1]', 'https://localhost.example.com', 'https://localhost@models.example.com', 'https://[::ffff:192.168.1.5]', 'file://localhost/a', 'invalid', '']) {
    assert.equal(ai.isLoopbackEndpoint(url), false, url);
  }
  assert.throws(() => ai.validateEndpoint('http://192.168.1.5:11434'), /仅允许 HTTPS/);
});

test('本地知识默认按选中供应商的实际端点判断，缺失端点拒绝附带', () => {
  assert.equal(ai.localKnowledgePrompt({ provider: 'ollama' }, entries), '');
  assert.equal(ai.localKnowledgePrompt({ provider: 'ollama', ollamaBaseUrl: 'https://models.example.com', remoteBaseUrl: 'http://localhost' }, entries), '');
  assert.equal(ai.localKnowledgePrompt({ provider: 'openai-compatible', remoteBaseUrl: 'https://models.example.com', ollamaBaseUrl: 'http://localhost' }, entries), '');
  assert.equal(ai.localKnowledgePrompt({ provider: 'local-rules', ollamaBaseUrl: 'http://localhost' }, entries), '');
});

test('真实请求构造在远程 Ollama/兼容接口中不含片段，所有请求禁止重定向（fetch mock）', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => ({ message: { content: '{}' }, choices: [{ message: { content: '{}' } }], models: [] }) };
  });
  for (const provider of ['ollama', 'openai-compatible']) {
    for (const [endpoint, local] of [['http://127.0.0.1:11434', true], ['http://[::1]:11434', true], ['http://localhost:11434', true], ['https://models.example.com', false]]) {
      const settings = { provider, ollamaBaseUrl: endpoint, remoteBaseUrl: `${endpoint}/v1`, ollamaModel: 'test', remoteModel: 'test' };
      await ai.enhancePlan(settings, { requirement: '测试需求', plan: {}, knowledgeContext: entries });
      const { url, options } = calls.at(-1);
      assert.equal(options.redirect, 'error');
      assert.equal(options.method, 'POST');
      assert.ok(url.startsWith(endpoint));
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'test');
      assert.equal(body.messages.some((message) => message.content.includes(entries[0].content)), local);
      await ai.getStatus(settings);
      assert.equal(calls.at(-1).options.redirect, 'error');
      await ai.solveProblem(settings, { question: '测试', localResult: {} });
      assert.equal(calls.at(-1).options.redirect, 'error');
      await ai.analyzeImage(settings, { imageDataUrl: 'data:image/png;base64,dGVzdA==' });
      assert.equal(calls.at(-1).options.redirect, 'error');
    }
  }
  assert.equal(calls.length, 32);
});

test('重定向错误向上传播，且不执行第二次请求（fetch mock）', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    calls += 1;
    assert.equal(options.redirect, 'error');
    throw new TypeError('redirect rejected');
  });
  await assert.rejects(ai.enhancePlan({ provider: 'ollama', ollamaBaseUrl: 'http://[::1]:11434' }, { plan: {}, knowledgeContext: entries }), /redirect rejected/);
  assert.equal(calls, 1);
});
