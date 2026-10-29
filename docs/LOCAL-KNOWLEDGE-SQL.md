# 本地书籍知识库（SQLite + RAG）

## 实现边界

应用把用户明确选择、且有权使用的本地资料，以及项目维护者整理的公开网页摘要，写入 SQLite，并在电路需求生成前进行全文检索。这属于本地 RAG（检索增强生成），不会修改 Ollama 模型权重，也不会自动下载、破解或分发书籍。

仓库和安装包不附带《集成电路版图设计项目式教程》《电路与电子技术》或电子工业出版社其他图书的正文。若要使用这些内容，请在“知识中枢”中选择自己合法持有的 PDF、Markdown、TXT 或 JSON 副本。

`knowledge/public-web-sources.json` 是一份可审计的公开来源清单，只保存自行撰写的知识摘要、原网页 URL、访问时间和版权备注，不镜像网页或图书正文。它包含两本指定教材的公开书目信息/目录知识图谱，以及开放 PDK、EDA 官方文档和芯片厂商技术资料。

## 数据位置与隐私

- Windows 开发版默认数据库：`%APPDATA%\circuit-assistant\circuit-knowledge.sqlite3`
- 数据库由 Electron 首次启动时自动创建。
- 原始文件不会复制进应用目录；数据库保存来源路径、SHA-256、元数据和提取后的检索文本。
- 公开网页条目保存 `source_url` 和 `accessed_at`，便于核对原始页面及复查时效。
- Ollama 或回环地址上的 OpenAI 兼容服务可以接收检索片段。
- 默认不向外部模型发送本地片段；用户在设置中明确开启 `allowRemoteKnowledge` 后，远程接口才可接收检索片段。

## 导入流程

1. 打开“知识中枢”，选择资料文件，或选择一个资料文件夹批量导入。
2. 文件选择支持多选；文件夹会递归扫描最多 200 个 PDF、Markdown、TXT 或 JSON 文件。
3. 应用计算文件 SHA-256，跳过重复副本。
4. PDF 按页提取文本，其他文件作为单页文本处理。
5. 文本以约 1400 字、180 字重叠切块，并写入 FTS5 全文索引。
6. 导入记录默认标记为 `user-provided`，表示内容和使用权限由用户提供。

PDF 必须含可选择的文字。扫描版或文字提取量异常少时会标记为 `needs-ocr`，应先用有权使用的 OCR 工具生成可检索文本，再重新导入。

应用会从文件名、PDF 元数据和正文前部识别书名、作者、ISBN 与出版社。文件名包含“电子工业出版社”，或识别到指定教材标题时，会记录出版社为“电子工业出版社”。

## 导入公开网页摘要

在项目目录执行：

```powershell
npm.cmd run knowledge:seed-public
```

该命令把 `knowledge/public-web-sources.json` 中的摘要幂等写入实际数据库；正文及元数据都相同才跳过。相同 URL 的正文、标题、作者、权威等级、版权备注或访问日期改变时会更新并重建索引，同时保留来源 ID 和导入日志关联；更新失败会回滚。开放许可资料标记为 `licensed`，其他可公开阅读但版权保留的网页标记为 `unknown`，且仅收录摘要。

2026-10-19 的清单含 46 个公开来源；内置基础与进阶知识分别为 33、51 条。执行 `npm.cmd run knowledge:audit` 可在内存数据库中检查数据结构、整库幂等导入及 13 组查询的内置/SQLite 前三结果，不修改日常数据库。该检查不等于自动验证网页内容；来源核对和纠错记录见 [本轮报告](KNOWLEDGE-EXPANSION-2026-10-19.md)。

## 权威性与交叉比对

新增公开来源在 `metadata_json` 中记录 `authorityTier`、`comparison` 和适用主题：

- `A+`：大学公开课程、标准/开放 PDK、官方数据手册或官方应用报告。基础定律优先采用 MIT OpenCourseWare；器件引脚、额定值、时序、补偿和布局数字优先采用目标厂商的最新版数据手册。
- `A`：厂商技术文章、培训和支持页面。用于补充推导、测量方法和工程经验，不能覆盖目标器件手册中的限制条件。
- 没有等级的旧条目仍可检索，但只能作为知识地图或背景线索，不应单独支撑器件选型。

对同一主题出现冲突时，先比较对象范围（通用理论、器件家族还是具体型号），再按 `A+` 优先、版本更新优先、适用条件更具体优先的顺序取舍。摘要只保存自撰结论和原始 URL，不复制网页或受版权保护的正文。

## SQL 结构

完整建表语句位于 [`database/schema.sql`](../database/schema.sql)。主要对象如下：

- `library_sources`：书名、出版社、作者、ISBN、文件哈希、来源 URL、访问时间、权利依据、页数和导入状态。
- `knowledge_chunks`：页码、标题、字符位置、正文块及正文哈希。
- `knowledge_fts`：SQLite FTS5 全文索引；额外保存中文双字检索词。
- `import_log`：成功、重复、需 OCR 和失败的审计日志。
- `library_catalog`：便于查看本地文献目录的只读视图。

示例查询：

```sql
-- 查看电子工业出版社的本地书目
SELECT title, authors, isbn, page_count, chunk_count, status
FROM library_catalog
WHERE publisher = '电子工业出版社'
ORDER BY imported_at DESC;

-- 查看某本书的具体文本块及页码
SELECT s.title, c.page_start, c.heading, c.content
FROM knowledge_chunks AS c
JOIN library_sources AS s ON s.id = c.source_id
WHERE s.title LIKE '%电路与电子技术%'
ORDER BY c.chunk_index;

-- 查看导入失败或需要 OCR 的文件
SELECT file_name, status, message, created_at
FROM import_log
WHERE status IN ('needs-ocr', 'error')
ORDER BY created_at DESC;

-- 查看公开网页来源及版权边界
SELECT title, publisher, source_url, accessed_at, rights_status, rights_note
FROM library_catalog
WHERE source_type = 'web'
ORDER BY imported_at DESC;
```

## 如何进入生成链路

用户提交需求或修订要求后，渲染进程调用主进程中的 SQLite 多路检索。标准、深度、穷尽档默认最多返回 8、12、18 个片段，并有逐源上限；模型注入还受 `knowledgeMaxEntries` 限制（默认 12，可设 4–20）。结果作为 `knowledgeContext` 按上述隐私设置提供给模型。模型若采用片段中的判断，输出必须注明标题、页码（若有）及其支持的结论。网页摘要不伪造原文 PDF 页码。

内置结构化规则会先按电路类型筛选，再排序截取最多 7 条，避免不适用的高分条目挤掉正确规则。新增知识并不意味着生成器新增了 I²C、RS-485 或 USB-C 器件级原理图模板；这些资料用于检索、解释和适用的工程检查。

检索在全文相关度相同或接近时优先返回 `authorityTier = A+` 的课程、数据手册和官方应用报告，其次返回 `A` 级厂商技术文章，未标等级的本地资料仍可作为补充但不会压过权威来源。返回结果同时带有 `authorityTier`、`authorityRank` 与 `sourceComparison`，便于生成链路继续审计来源取舍。

书籍知识不覆盖确定性计算结果，也不能替代具体器件数据手册、ERC/DRC、仿真、样机测试和安全评审。
