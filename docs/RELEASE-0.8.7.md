# 电路助手 Studio 0.8.7 发布说明

## 本次重点

0.8.7 把 Agent 工作台从单次内存会话升级为可恢复的本机工作记录，并完成一轮最小窗口与便携版发布验证。

- 最近 8 次运行自动写入 Electron 用户数据目录下的 `agent-session.json`，累计运行次数同步保留。
- 方案生成、连续修订和优化审查分别保存独立结果快照。点击旧记录时恢复该次结果，不会误开最新方案。
- 应用异常关闭后，遗留的运行中任务会明确标记为中断；运行中步骤变为失败，未执行步骤变为跳过，不会自动重放外部模型请求。
- 会话输入和文件限制为 2 MiB，每次最多 32 个阶段；损坏、非法或超限原文件会保留并拒绝覆盖。
- 移除 Agent 工作台占据首屏的大 Hero，任务、执行和历史入口在 1120 x 720 最小窗口内形成可见闭环。
- 工作室元件支持拖放、点击和键盘添加；窄屏属性栏默认收起，展开后点击画布关闭。
- 项目名输入即时同步到编辑器状态，未保存改名后导出的 SVG 页脚不再使用旧名称。

## 获取与运行

- 解压运行版：`release-0.8.7/win-unpacked/电路助手 Studio.exe`
- 单文件便携版：`release-0.8.7/电路助手-0.8.7-x64.exe`
- 校验文件：`release-0.8.7/SHA256SUMS.txt`

便携版大小为 102,979,225 字节（98.21 MiB），SHA-256：

```text
B3733C9F832677B939623855909F3887FDB9707E91FAE2D94E78C895994168DE
```

旧的 `release-0.8.6` 目录没有被覆盖。0.8.7 首次启动时历史为空；后续运行记录只保存在当前 Windows 用户的数据目录中。

## 验证结果

- `npm.cmd run verify`：77 项单元/回归测试全部通过，源码 Electron smoke 全部通过。
- `npm.cmd run test:packaged`：打包后 25 项 smoke 全部通过；直接从 `win-unpacked` 启动，使用独立临时 `userData`，没有读取或修改日常用户项目。
- 后续发布可用 `npm.cmd run verify:release` 串联单元测试、构建和打包后 smoke；失败时会在证据目录写入 `ui-smoke-error.log`。
- 覆盖场景：会话写入、渲染进程重载、旧 v1/新 v2 快照隔离、生成到工作室、元件点击添加、优化审查、单位解析、1440 x 920、1120 x 720、窄屏属性栏与未捕获异常。

证据：

- [单元测试 TAP](../04_Tasks/T002_release_087/files/unit-tests.tap)
- [打包后 UI 检查](../04_Tasks/T002_release_087/files/packaged-ui-smoke.json)
- [1120 x 720 Agent 工作台](../04_Tasks/T002_release_087/files/agent-1120.png)
- [1440 x 920 Agent 工作台](../04_Tasks/T002_release_087/files/agent-1440.png)
- [打包后完成状态](../04_Tasks/T002_release_087/files/agent-completed.png)
- [1120 x 720 电路工作室](../04_Tasks/T002_release_087/files/studio-1120.png)

## 已知限制

- 便携版尚未做 Windows 代码签名，系统显示 `NotSigned`；不应作为正式商用安装包分发。
- 本轮没有连接真实 Ollama 或远程兼容模型；自动化验收使用本地规则模式。
- 任务尚不支持主动取消；恢复只标记中断，不会从中间步骤继续执行。
- JSON 修改队列只保护单个主进程，没有跨进程文件锁和断电恢复保证。
- 软件仍输出概念级/参数化草案，不包含真实 KiCad 工程、ERC/DRC、SPICE、热分析或硬件验证。
