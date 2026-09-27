# PROJECT.md — 当前项目真实状态

> 本文档只描述**当前真实状态**，不代表历史方案或未来计划。
>
> - 未来计划 → `docs/ROADMAP.md`
> - 历史变更 → `docs/CHANGELOG.md`
> - 需求方案与实施记录 → `docs/changes/`
> - 历史版本快照 → `docs/archive/`
> - 代码历史 → Git

**当前版本**：v1.0.0
**最后更新**：2026-09-27

---

## 1. 项目定位

一款**服务于个人使用的本地 TXT 小说阅读器**。用户从电脑中选择 `.txt` 小说文件导入，应用记录原文件位置和必要元数据；以后打开应用时，根据记录的路径读取原文件并继续阅读。

界面使用网页技术构建，以本地桌面应用形式运行。不依赖服务器、账号或云服务，小说正文不复制到应用内部。

---

## 2. 当前状态摘要

| 项目 | 状态 |
|---|---|
| 版本 | v1.0.0（`package.json` 与 `docs/CHANGELOG.md` 已对齐；此前 `package.json` 停在 `0.1.0`） |
| 可运行性 | **可用**。`npm run dev` 可启动，导入、阅读、设置、进度恢复全流程已验证 |
| 技术栈 | Electron 32.3.3 + Vite 5.4 + 原生 JavaScript / CSS |
| 测试（单元） | `npm test` → 24 项全部通过 |
| 测试（界面） | `npm run test:ui` → 10 项全部通过（真实 Electron 窗口驱动 `dist/`） |
| 应用打包 | **已配置**。`npm run dist` → `release/novel-reader-1.0.0-win-x64.zip`（Windows x64 免安装版，约 105MB）。详见第 5.4 节 |
| Git | 本地仓库，分支 `master`，初始提交 `e67e742` |
| 远程仓库 | `origin` → `https://github.com/taxman2333/novel-reader`（Private）。**已发布 `v1.0.0` Release**（tag `v1.0.0`，附件 `novel-reader-1.0.0-win-x64.zip`） |
| 数据存储 | `library.json`，位于 Electron userData 目录。仅存路径与元数据 |

---

## 3. 核心约束（已确定，未经明确决策不得更改）

以下来自 v1.0.0 方案，属于**已确定的项目要求**，不是可随意调整的实现细节：

1. 小说正文**不复制**到应用内部，不保存到 IndexedDB，不落入应用数据库或专用目录。
2. 应用保存**原始文件绝对路径**与必要元数据，小说始终由用户自己保管。
3. **删除书架记录与删除原始文件必须是两个独立动作**。第一版不提供删除原始文件的功能。
4. 项目**默认优先保持本地运行**：不接入服务器、账号、云同步、远程数据库。
5. 文件系统能力必须与渲染界面分离，由受控的桌面端接口提供；页面脚本不得直接获得系统权限。
6. 应用**不上传文件内容、不启动网络服务、不发送使用数据**。
7. 不得擅自增加第一版没有要求的功能（账号、在线书库、云同步、社交、广告等）。
8. 读取失败必须给出**具体原因**，而不是通用错误提示。

---

## 4. 已实现功能（真实状态）

### 4.1 文件导入

- 通过系统文件选择器（`dialog.showOpenDialog`）导入，过滤器限定 `txt`。
- 只接受 `.txt`，非 `.txt` 会返回明确错误。
- 空文件会返回「这个 TXT 文件没有可阅读的内容」。
- 导入只建立文件引用，不移动、不复制、不修改原文件。
- 重复导入同一路径时，直接打开已有记录，不产生重复条目。

### 4.2 编码处理（真实实现）

`electron/book-service.js` 的 `decodeText()` 按以下顺序判定：

1. `FF FE` 开头 → UTF-16LE
2. `EF BB BF` 开头 → UTF-8（含 BOM）
3. 按 UTF-8 解码后统计替换字符 `�` 数量，为 0 则判定 UTF-8
4. 否则回退 GB18030

### 4.3 书架

- 展示书名、上次阅读时间、阅读进度百分比。
- 按最近打开时间倒序排列。
- 显示原文件不可用状态，并提供「重新定位」。
- 支持从书架移除记录（`window.confirm` 明确说明不会删除原文件）。
- 无小说时显示空状态引导。

### 4.4 阅读器

- 工具栏固定在顶部，**不随正文滚动**（正文区独立滚动）。
- 工具栏为三栏布局，从左到右：**左导航区**（返回书架 `←`、目录按钮「目录」）、**中部书名与阅读进度**、**右操作区**（阅读设置 `Aa`）。
- 底部有细进度条。
- 正文按段落渲染为 `<p data-paragraph-index="n">`。
- **段落分隔自动适配两种 TXT 格式**：先统计空行占比，≥ 0.15 时按空行分段，否则按单个换行分段。只按空行切会把「一行一段、没有空行」的文件（网文抓取版常见）解析成一整个段落，整本渲染成单块文字；只按换行切会把空行分段文件里本来就有软换行的段落切碎。

### 4.5 阅读进度

- 滚动停止后 500ms 防抖保存，返回书架与关闭窗口前也会保存。
- 保存内容：段落索引、字符偏移、阅读比例、附近文本（前 240 字）、时间戳。
- 恢复顺序：**附近文本匹配 → 段落索引 → 阅读比例**。
  - ⚠️ 第三个分支实际不可达，见第 9 节。
- 原文件内容变化时通过文件指纹检测，并提示已尽量恢复位置。

### 4.6 阅读设置

- 字号、行距、段落间距、版心宽度、字体（宋体/黑体风格）、段首缩进开关。
- 调整即时预览并自动保存。
- 支持「恢复默认设置」。
- **按书记忆**：每本小说可保存独立设置，未单独设置时继承全局默认。

### 4.7 阅读主题

四套主题，默认**日间暖色**，均需同步作用于阅读区、应用背景、工具栏、设置面板与控件：

| 键 | 名称 |
|---|---|
| `white` | 日间白色 |
| `warm` | 日间暖色（默认） |
| `green` | 日间护眼浅绿色 |
| `night` | 夜间深灰色（明确非纯黑） |

主题保存在设置中，启动时恢复上次选择。

### 4.8 文件失效与重新定位

- 启动加载书架时用 `stat` 比对文件大小与修改时间，标记不可用状态（不读取正文）。
- 重新定位时若内容指纹不同，要求用户确认后才替换绑定。
- 重新定位保留原有阅读设置与可用进度。

### 4.9 应用菜单

原生中文菜单：文件（退出）、编辑、视图、窗口、帮助（关于书页之间）。
菜单使用 Electron `role`，保留系统标准快捷键。

### 4.10 章节目录与章节跳转

工具栏左端的「目录」按钮打开目录侧栏（**从界面左侧滑入**，与阅读设置面板的右侧滑出相对），列出识别出的章节，点击即跳转到该章开头。章节条目字号 15px。

目录按钮为圆角矩形文字按钮（`.toolbar-label-button`，「目录」两字在 `.icon-button` 的 36px 圆形里装不下），返回键与 `Aa` 仍是圆形按钮。面板打开时该按钮被面板遮住，关闭靠面板的 × 或点击遮罩。

**当前章节高亮**取「视口顶部所在段落的**真实**索引」与章节表比对：`src/main.js` 的 `topParagraphIndex()` 在段落上做二分查找（段落是正常流块级元素，`bottom` 单调递增），数千段约 12 次 `getBoundingClientRect`；滚动期间的重算由 `scheduleActiveChapterRefresh()` 收敛进 `requestAnimationFrame`，每帧最多测量一次几何。

⚠️ **不能用「滚动比例 × 段落数」估算当前段落**。那个估算假定段落等高，而真实小说的段落长短悬殊（对话密集段与长描写段可以差好几倍），误差沿全书累积。实测一本段落长度递增的合成书跳到第 5 章时，估算落在第 3 章——表现为跳转本身没错、但目录高亮的是另一章。滚动期间只在章节变化时改 DOM。

识别在**打开书籍时**对内存中的段落执行（`src/reader.js` 的 `detectChapters`）：

- 只认**整段即标题**的段落，段首锚定且尾部限长 24 字，正文里提到「第一章」的长句不会命中。
- 支持阿拉伯数字、全角数字与中文数字（`十一` = 11、`一百零五` = 105），量词支持 章节回卷部篇集，可带 `【】（）《》` 等包裹符号，也认 序章/序言/楔子/引子/前言/后记/尾声/终章/番外/附录 等特殊标题。
- 命中段落少于 2 个，或数字序列不满足大体递增（阈值 0.6）时，**整本放弃识别**——宁可漏判，也不把正文句子塞进目录。

**识别失败时不显示空目录**：面板改为说明未识别到章节标题，并降级为按百分比跳转的滑块（同时显示滚动时同步更新的百分比）。识别成功时，面板顶部显示章节总数。

目录**不写入 `library.json`**：章节标题是小说正文的片段，落盘即违反核心约束 1。因此每次打开书籍重新计算，不缓存。

---

## 5. 当前架构（真实）

### 5.1 进程与模块

| 文件 | 职责 |
|---|---|
| `electron/main.js` | 窗口生命周期、中文菜单、IPC 处理器注册、退出前落盘 |
| `electron/preload.mjs` | 通过 `contextBridge` 暴露最小 `novelApi` 接口 |
| `electron/library-store.js` | `library.json` 读写：临时文件 + 原子替换 + `.bak` 备份恢复 |
| `electron/book-service.js` | 文件校验、编码解码、文本规范化、指纹、文件变化检测 |
| `src/main.js` | 书架与阅读页渲染、事件绑定、设置与进度保存编排、目录面板与当前章节高亮 |
| `src/store.js` | 默认设置、主题表、设置归一化、书架数据结构归一化 |
| `src/reader.js` | 段落解析（按空行占比自动选择分隔策略）、章节识别、滚动位置计算、恢复索引决策 |
| `src/styles.css` | 阅读排版、四套主题变量、响应式与设置面板样式 |
| `index.html` | Vite 入口（项目根目录） |

### 5.2 安全配置（真实）

```js
webPreferences: {
  preload: .../preload.mjs,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false,
}
```

⚠️ `preload` **必须是 `.mjs`**：项目 `package.json` 声明了 `"type": "module"`，Electron 要求 ESM preload 使用 `.mjs` 扩展名，否则 preload 加载失败、`window.novelApi` 为 `undefined`，界面退化为「请在桌面应用中打开」。

### 5.3 IPC 接口（真实）

| 通道 | 方向 | 作用 |
|---|---|---|
| `library:load` | invoke | 读取书架数据 |
| `library:save` | invoke | 保存书架数据 |
| `library:save-on-exit` | send | 窗口关闭前同步落盘 |
| `library:remove` | invoke | 移除某条书架记录 |
| `book:choose` | invoke | 打开文件选择器并读取 |
| `book:read` | invoke | 按路径读取小说 |
| `book:inspect` | invoke | 检查文件是否可用/变化 |

### 5.4 打包与分发（真实）

配置写在 `package.json` 的 `build` 字段。**不新建独立配置文件**——项目是 `"type": "module"`，独立配置需要处理 ESM 导出，写进 `package.json` 没有这个问题，也少一个文件。

| 项 | 值 |
|---|---|
| `productName` | `书页之间`（exe 名、窗口与任务栏显示名） |
| 目标 | `zip`，Windows x64 免安装目录版 |
| 产物 | `release/novel-reader-<version>-win-x64.zip`（约 105MB）；中间产物 `release/win-unpacked/` |
| `files` | `dist/**`、`electron/**`、`package.json` |
| `asar` | `true` |
| 命令 | `npm run dist`（= `npm run build && electron-builder --win`） |

**为什么是 `zip` 而不是安装程序或单文件 exe**：解压双击即用、零依赖；不写注册表、不装进 `Program Files`，卸载等于删文件夹。`portable` 单文件每次启动都要把约 200MB 解压到 `%TEMP%`，启动明显更慢；NSIS 安装程序对一个自用工具过重。取舍过程见 `docs/changes/2026-09-27-打包与发布Release.md`。

产物只作为 GitHub Release 附件上传，**不进 Git**（`.gitignore` 的 `/release/` 已覆盖，含 electron-builder 生成的 `builder-debug.yml`）。

**压缩包文件名用 ASCII，包内 exe 仍是中文名**：含中文的压缩包名在部分解压工具与下载链路上有编码风险，ASCII 避开该问题，同时不影响用户实际使用的 exe 名称。

⚠️ **`files` 是白名单，`node_modules` 不在其中。** 当前主进程只用 Node 内置模块（`node:path`、`node:fs` 等），编码解码用内置 `TextDecoder`，**不需要任何运行时依赖**，所以安全。若将来引入运行时依赖（非 devDependency），必须把 `node_modules/**` 加回 `files`，否则打包后启动即报模块找不到。

⚠️ **`electron` 必须在 `devDependencies`。** electron-builder 直接拒绝 `electron` 出现在 `dependencies` 中（报 `Package "electron" is only allowed in "devDependencies"`）——打包产物自带 Electron 运行时，不依赖 npm 装的那个包。本项目原先把它放在 `dependencies`，打包时才发现。

⚠️ **数据目录与产品显示名刻意解耦。** `electron/main.js` 在 `app ready` 之前显式执行 `app.setPath('userData', <appData>/local-novel-reader)`。原因：`app.getPath('userData')` 默认跟随 `app.getName()`，而 `app.getName()` 跟随 `build.productName`。若不显式固定，引入 `productName` 会让数据目录从 `%APPDATA%\local-novel-reader\` 变成 `%APPDATA%\书页之间\`，**老用户的书架会凭空变空**（文件没丢，但应用看不到）。显式 `setPath` 让开发态与打包态共用同一个目录，零迁移。

**未做**：自定义图标（沿用 Electron 默认图标）、安装程序、跨平台打包、自动更新。均属独立需求，不在本次范围内。

> 将来做自定义图标时注意：electron-builder 的默认图标查找路径是 `build/icon.ico`，而本仓库 `.gitignore` 有根锚定的 `/build/` 规则，**需同时调整该规则**，否则图标文件会被静默排除在 Git 之外。

---

## 6. 数据结构（真实）

`library.json`：

```jsonc
{
  "version": 1,
  "settings": {              // 全局默认设置（新导入小说继承）
    "fontSize": 18,
    "lineHeight": 1.9,
    "paragraphSpacing": 0.9,
    "contentWidth": 720,
    "fontFamily": "serif",   // serif | sans
    "theme": "warm",         // white | warm | green | night
    "indent": true
  },
  "books": [
    {
      "id": "<文件绝对路径>",
      "path": "<文件绝对路径>",
      "name": "<去掉 .txt 的显示名>",
      "fileName": "<原始文件名>",
      "size": 123456,
      "modifiedAt": "<ISO 时间>",
      "fingerprint": "<sha256 前 24 位>",
      "encoding": "utf-8",
      "importedAt": "<ISO 时间>",
      "lastOpenedAt": "<ISO 时间>",
      "unavailable": false,
      "progress": {
        "paragraphIndex": 0,
        "charOffset": 0,
        "ratio": 0,
        "context": "<附近文本前 240 字>",
        "updatedAt": "<ISO 时间>"
      },
      "settings": null         // null = 继承全局；否则为完整设置对象
    }
  ]
}
```

**关键不变量**：`books[i].id` 等于文件绝对路径。重新定位文件时会同时更新 `id` 与 `path`。

---

## 7. 异常处理（当前实现程度）

| 异常 | 状态 |
|---|---|
| 选择的不是 TXT | ✅ 明确错误 |
| 文件为空 | ✅ 明确错误 |
| 文件路径不存在 | ✅ 标记不可用 + 可重新定位 |
| 文件被移动或重命名 | ✅ 标记不可用 + 可重新定位 |
| 文件在上次阅读后被修改 | ✅ 指纹检测 + 位置回退 + 提示 |
| 文件所在磁盘不可用 | ✅ 表现为不可用状态 |
| 保存配置失败 | ⚠️ 未做显式处理 |
| 配置损坏 | ✅ 回退 `.bak`；两者都坏则重置为空书架 |
| 文件被其他程序锁定 | ⚠️ 错误会冒泡为通用提示，未单独识别 |
| 大文本解析/渲染缓慢 | ⚠️ 有加载态，但**未做分块或虚拟滚动** |
| 用户删除记录后重新选择同一文件 | ✅ 视为新导入 |
| 没有读取权限 | ⚠️ 冒泡为通用错误 |

---

## 8. 测试现状

### 单元测试 `npm test`（`node --test`），共 24 项

| 文件 | 覆盖内容 |
|---|---|
| `tests/book-service.test.js` | UTF-8 BOM 解码与换行规范化、GB18030 回退、段落拆分与偏移、指纹稳定性 |
| `tests/library-store.test.js` | 写入与主文件损坏后的备份恢复 |
| `tests/store-reader.test.js` | 设置范围钳制、按书覆盖全局、书架归一化、按附近文本恢复、索引边界、设置跨保存重载、`normalizeLibrary` 会重建对象这一关键不变量 |
| `tests/reader-chapters.test.js` | 中文/全角/阿拉伯数字解析（`十一`、`一百零五`、`万` 返回 null）、章节识别（带包裹符号、特殊标题、正文长句不误判、序列散乱则整体放弃、候选不足则不识别）、两种空行格式的段落切分、无空行文本的端到端识别 |

### 界面回归测试 `npm run test:ui`，共 10 项

以真实 Electron 窗口驱动构建产物 `dist/`。入口是 `tests/ui/entry.mjs`，通过 `electron tests/ui/entry.mjs` 绕过 `package.json` 的 `main` 字段启动，**生产代码一行未改**。替换点是 `electron/preload.mjs` 暴露的 `novelApi`（`tests/ui/mock-preload.mjs`），渲染层分辨不出替身与真身，因此 `src/main.js`、`src/reader.js`、`src/styles.css` 的真实逻辑全部被保留。详见 `tests/ui/README.md`。

| 用例 | 断言 |
|---|---|
| `api-surface` | `novelApi` 方法集合与 `electron/preload.mjs` 一致（检测 mock 漂移） |
| `shelf-empty` | 空书架引导按钮确实绑定了导入事件 |
| `import` | 导入后进入阅读页、正文非空、书架 1 条记录并显示书名 |
| `toolbar-fixed` | 正文滚动 4000px 后工具栏 `top` 仍为 0 |
| `theme-switch` | 四套主题的 `data-theme`、`--reader-bg` 计算值与选中态正确且互不相同 |
| `settings-persist` | 保存载荷中 `books[0].settings.fontSize === 26`；reload 后字号与滑块仍为 26 |
| `progress-persist` | 防抖保存 `paragraphIndex > 0`；返回书架再打开，视口顶部段落索引与保存值一致 |
| `toc-jump` | 工具栏三栏结构与按钮文案/位置（目录在返回键右侧且位于左半屏、文案不溢出、书名仍居中）；目录面板关闭时整体在视口左侧之外、打开时左边缘贴齐视口；章节条目字号 15px；识别出 10 个「第N章 …」标题；点击第 6 章后目录关闭，视口顶部正是该章标题；阅读设置面板仍从右侧滑出 |
| `toc-active` | 用**段落长度不均**的夹具：跳转到第 5 章后目录高亮的必须是第 5 章（修复前高亮第 3 章）；再由滚动路径把第 7 章标题滚到顶部，高亮须跟随（覆盖 rAF 那一步） |
| `toc-fallback` | 无空行文本被切分为 200 段（改动前会解析成 1 段）；识别不到章节时不出列表、改出进度滑块，滑块 60% 对应约 60% 滚动位置 |

**尚未建立**：Electron 集成测试（直接启动 `electron/main.js`、走真实文件系统与 IPC）。界面测试替换掉了 `novelApi`，因此 `electron/main.js`、`electron/book-service.js`、`electron/library-store.js` 自身的接线不在覆盖范围内。

---

## 9. 已知技术债与文档/代码不一致

以下为核实过的真实情况，**尚未修复**：

1. `src/index.html` 是项目根 `index.html` 的副本，**未被任何构建或代码引用**，属于冗余文件。
2. `electron/book-service.js` 导出的 `splitParagraphs`、`createFingerprint`、`ENCODINGS` **在生产代码中未被使用**，仅被测试引用。段落解析逻辑在 `src/reader.js` 中另有一份实现，两者重复。**两份的段落分隔策略已在 2026-09-27 同步为同一套「按空行占比自动选择」逻辑**（两处都有注释要求保持同步），但实现重复本身未消除，去重仍是独立技术债。
3. `src/main.js` 的 `activeContent` 变量被赋值但**从未被读取**。
4. `src/store.js` 的 `createBookRecord(file, content, now)` 中 `content` 参数**未被使用**，调用处却传入了整个正文。
5. `escapeAttribute` 只是 `escapeHtml` 的别名。
6. `src/reader.js` 的 `findRestoreIndex` 中「阅读比例」分支实际不可达。进入该函数的 `progress` 都经过 `src/store.js: normalizeProgress`，而它把 `paragraphIndex` 强制转换为非负整数，`Number.isFinite` 检查必然为真，第二个分支总会提前返回。第 4.5 节描述的「附近文本匹配 → 段落索引 → 阅读比例」三级恢复，现实中只有前两级生效。
7. **保存下来的阅读进度里 `paragraphIndex` 仍是「比例 × 段落数」的估算值**，带有与第 4.10 节同一个偏差来源（段落长度不均时可能偏离实际所在段十几章）。目前影响有限：`findRestoreIndex` 首先按附近文本精确匹配，只要文件内容没变就能落回正确段落。但一旦上下文匹配失效（例如文件被重新排版、正文被替换），就会退到这条有偏差的索引上。**未改为按真实几何位置保存**——那会改变 `library.json` 里进度字段的含义，属于需要单独评估的变更。

**方案中尚未落地**（详见 ROADMAP）：

- 编码无法识别时的**手动编码选择入口**（方案 5.1 要求提供）。
- **Electron 打包分发**（方案阶段五要求完成打包运行）。
- 大文本的**分块或虚拟滚动**（方案 5.3 的建议）。

---

## 10. 需求分级说明（重要）

阅读 v1.0.0 方案时必须区分三类内容，**不要把推荐方案当成不可修改的硬性要求**：

### 10.1 已确定的项目要求（不可随意更改）

第 3 节列出的 8 条核心约束，以及：核心用户流程（导入、再次打开、阅读与自动保存、重新定位、删除记录）、需要保存的字段范围、异常必须给出可执行下一步、四种阅读主题及其「夜间非纯黑」要求。

### 10.2 推荐性技术方案（允许重新评估后调整）

- **Electron 作为桌面运行环境**：方案原文为「推荐第一版使用 Electron」。当前实现采用 Electron，但这是可评估调整的选型，不是硬约束。约束的本质是「必须能稳定保存并复用本地文件路径」，凡满足该约束的方案均可讨论。
- **Vite + 原生 JavaScript**：方案为「建议」。当前采用原生 JS + 原生 CSS，未引入 React 或 UI 组件库。
- **SQLite 保存元数据**：方案推荐 SQLite，同时明确「第一版也可以先采用 JSON 配置文件」。**当前实现采用 JSON**（含原子写入与备份），属于方案允许的选项。
- **字号、行高、段距等具体数值**：方案原文为「建议初始值……实际数值在开发和试读后微调」。

### 10.3 暂时性实现建议（可随时替换）

- 工具栏与设置面板的具体布局形式（方案允许侧边面板、弹出面板或独立区域）。
- 书架采用文字书卡列表（方案明确「不需要伪造封面」）。
- 段落以 `index` + `charOffset` 定位的实现细节。
- 进度防抖 500ms 的具体数值。

---

## 11. 环境注意事项

1. **本机 `github.com:443` 被阻断**，`api.github.com` 可直连。因此 `gh` 命令正常，但 `git push` 需要走本机代理。当前已在 `.git/config`（仅本仓库）设置 `http.proxy = http://127.0.0.1:7890`。代理未开启时推送会失败。
2. **Electron 二进制安装在 Node 24 下可能失败**：其自带的 `extract-zip`/`yauzl` 会静默中断，导致 `dist/` 里只剩部分文件、`electron.exe` 缺失。可用 PowerShell 对已下载且校验通过的压缩包重新解压修复。
3. 全局 Git 身份未配置（`user.name`/`user.email` 均为空）。本仓库已设置仓库级身份，**未修改全局配置**。
4. 运行方式：`npm run dev` 开发启动；`npm run build` 前端构建；`npm test` 单元测试；`npm run test:ui` 界面回归测试；`npm run dist` 打包 Windows 应用。**不要用浏览器打开 `127.0.0.1:5173`**，那是 Vite 资源服务，不是应用入口。
5. **打包必须走镜像**：electron-builder 默认从 github.com 拉取 Electron 运行时与工具链，本机该域名被阻断。仓库级 `.npmrc` 已设 `electron_mirror` 与 `electron_builder_binaries_mirror` 指向 npmmirror，`build.electronDownload.mirror` 作为第二道保险。**首次打包需下载约 200MB**，缓存在 `%LOCALAPPDATA%\electron-builder\Cache`，第二次起显著加快。
6. **npm 会告警 `.npmrc` 里的镜像键**（`Unknown project config "electron_mirror"`）。**这不是错误**：这两个键是 `@electron/get` 的约定，由 npm 透传成 `npm_config_*` 环境变量供其读取，镜像实际生效（已实测打包成功）。npm 提示未来大版本可能不再透传，届时改用环境变量。
7. **`gh release create` 不需要代理**：它走 `api.github.com` 与 `uploads.github.com`，两者均已实测可达。这与 `git push` 必须走本机代理的情况不同。
