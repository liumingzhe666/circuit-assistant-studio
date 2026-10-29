# T002 执行记录

## 已完成

- 2026-09-14：审查 T001 剩余限制、任务板、前端与测试，确定 0.8.7 以恢复能力和发布闭环为范围。
- Agent 运行记录写入 `agent-session.json`，保留最近 8 次与累计次数；每次保存方案或优化报告快照。
- 未完成任务在重启时转为失败/中断，运行中步骤标记失败，未开始步骤标记跳过，不自动重新请求模型。
- 压缩 Agent 首屏，历史记录可点击恢复；元件物品栏支持点击及键盘添加；项目名编辑即时同步到 SVG；1120 px 下属性栏默认收起。
- 最终回归：77 项单元测试通过；源码与打包后 Electron smoke 各 25 项通过，覆盖持久化、重载、旧快照恢复、1120 x 720 和窄屏抽屉。
- 新增 `test:packaged` 与 `verify:release`，打包 smoke 失败时会写 `ui-smoke-error.log`。修复 Windows 隐藏窗口导致 `capturePage` 抛出 `UnknownVizError`，并为偶发未应用的窗口尺寸加入状态复位与重试。
- 已生成 `release-0.8.7`；单文件便携版 102,979,225 字节，SHA-256 为 `B3733C9F832677B939623855909F3887FDB9707E91FAE2D94E78C895994168DE`，签名状态为 `NotSigned`。
- 最终证据见 [TAP](files/unit-tests.tap)、[打包 UI JSON](files/packaged-ui-smoke.json) 与同目录截图；发布边界见 [0.8.7 发布说明](../../docs/RELEASE-0.8.7.md)。

## 剩余限制

- 未联调真实外部模型，任务不可主动取消，只能在重启后标记中断。
- JSON 原子写与队列仍限单个主进程；没有跨进程锁和断电恢复保证。
- 未加入 KiCad/ERC/DRC、SPICE、热分析或硬件实测；便携版未做 Windows 代码签名。
