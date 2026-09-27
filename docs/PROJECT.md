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
| 版本 | v1.0.0（初始版本） |
| 可运行性 | **可用**。`npm run dev` 可启动，导入、阅读、设置、进度恢复全流程已验证 |
| 技术栈 | Electron 32.3.3 + Vite 5.4 + 原生 JavaScript / CSS |
| 测试（单元） | `npm test` → 12 项全部通过 |
| 测试（界面） | `npm run test:ui` → 7 项全部通过（真实 Electron 窗口驱动 `dist/`） |
| 应用打包 | 仅完成前端构建（`npm run build` → `dist/`）。**尚未配置 Electron 打包分发** |
| Git | 本地仓库，分支 `master`，初始提交 `e67e742` |
| 远程仓库 | `origin` → `https://github.com/taxman2333/novel-reader`（Private） |
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
- 工具栏包含：返回书架、书名、阅读进度、阅读设置入口。
- 底部有细进度条。
- 正文按段落渲染为 `<p data-paragraph-index="n">`。

### 4.5 阅读进度

- 滚动停止后 500ms 防抖保存，返回书架与关闭窗口前也会保存。
- 保存内容：段落索引、字符偏移、阅读比例、附近文本（前 240 字）、时间戳。
- 恢复顺序：**附近文本匹配 → 段落索引 → 阅读比例**。
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

---

## 5. 当前架构（真实）

### 5.1 进程与模块

| 文件 | 职责 |
|---|---|
| `electron/main.js` | 窗口生命周期、中文菜单、IPC 处理器注册、退出前落盘 |
| `electron/preload.mjs` | 通过 `contextBridge` 暴露最小 `novelApi` 接口 |
| `electron/library-store.js` | `library.json` 读写：临时文件 + 原子替换 + `.bak` 备份恢复 |
| `electron/book-service.js` | 文件校验、编码解码、文本规范化、指纹、文件变化检测 |
| `src/main.js` | 书架与阅读页渲染、事件绑定、设置与进度保存编排 |
| `src/store.js` | 默认设置、主题表、设置归一化、书架数据结构归一化 |
| `src/reader.js` | 段落解析、滚动位置计算、恢复索引决策 |
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

### 单元测试 `npm test`（`node --test`），共 12 项

| 文件 | 覆盖内容 |
|---|---|
| `tests/book-service.test.js` | UTF-8 BOM 解码与换行规范化、GB18030 回退、段落拆分与偏移、指纹稳定性 |
| `tests/library-store.test.js` | 写入与主文件损坏后的备份恢复 |
| `tests/store-reader.test.js` | 设置范围钳制、按书覆盖全局、书架归一化、按附近文本恢复、索引边界、设置跨保存重载、`normalizeLibrary` 会重建对象这一关键不变量 |

### 界面回归测试 `npm run test:ui`，共 7 项

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

**尚未建立**：Electron 集成测试（直接启动 `electron/main.js`、走真实文件系统与 IPC）。界面测试替换掉了 `novelApi`，因此 `electron/main.js`、`electron/book-service.js`、`electron/library-store.js` 自身的接线不在覆盖范围内。

---

## 9. 已知技术债与文档/代码不一致

以下为核实过的真实情况，**尚未修复**：

1. `src/index.html` 是项目根 `index.html` 的副本，**未被任何构建或代码引用**，属于冗余文件。
2. `electron/book-service.js` 导出的 `splitParagraphs`、`createFingerprint`、`ENCODINGS` **在生产代码中未被使用**，仅被测试引用。段落解析逻辑在 `src/reader.js` 中另有一份实现，两者重复。
3. `src/main.js` 的 `activeContent` 变量被赋值但**从未被读取**。
4. `src/store.js` 的 `createBookRecord(file, content, now)` 中 `content` 参数**未被使用**，调用处却传入了整个正文。
5. `escapeAttribute` 只是 `escapeHtml` 的别名。

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
4. 运行方式：`npm run dev` 开发启动；`npm run build` 前端构建；`npm test` 单元测试。**不要用浏览器打开 `127.0.0.1:5173`**，那是 Vite 资源服务，不是应用入口。
