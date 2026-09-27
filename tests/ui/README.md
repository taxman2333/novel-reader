# tests/ui — 界面回归测试

用真实 Electron 窗口驱动构建产物 `dist/`，断言那些单元测试覆盖不到的界面行为：滚动后的固定工具栏、主题切换、设置持久化、阅读进度往返。

```bash
npm run test:ui    # = npm run build && electron tests/ui/entry.mjs
```

全部通过时退出码为 `0`，任一断言失败为 `1`，超过 60s 未结束判定为卡死（`2`）。

---

## 为什么需要它

`npm test` 的 12 项单元测试只覆盖纯逻辑。此前调试中，工具栏布局、设置保存、进度恢复这三类问题都只能靠人工点开应用确认，并且已经因此产生过误判。这里的断言对应的正是真实发生过的回归。

---

## 结构

| 文件 | 职责 |
|---|---|
| `entry.mjs` | 测试专用的 Electron 主进程入口。注册 mock IPC、持有假数据、跑完整流程并打印结果 |
| `harness.mjs` | 驱动与断言工具：建窗口、求值、轮询、滚动、取快照 |
| `mock-preload.mjs` | `window.novelApi` 的替身，形状必须与 `electron/preload.mjs` 一致 |
| `specs.mjs` | 10 条用例 |

### 关键设计

**不改动生产代码。** 以 `electron tests/ui/entry.mjs` 启动，绕过 `package.json` 的 `main` 字段，`electron/main.js` 一行都不需要改。替换点是 `contextBridge` 暴露的 `novelApi`——渲染层分辨不出替身与真身，因此 `src/main.js`、`src/reader.js`、`src/styles.css` 的全部真实逻辑都被保留。

**跑构建产物而不是开发服务器。** 结果确定，不必与 Vite 的启动时序竞争，顺带验证了生产构建能正常启动。

**假数据放在主进程。** preload 模块的内存会在每个窗口实例化时重置。状态若放在那里，reload 之后会读到初始值而非上次保存的值，「重启应用后设置还在吗」就无法被真实验证。

**不触碰真实文件系统。** 书籍路径是伪路径 `mock://测试小说.txt`，`readBook` 由 mock 直接返回合成文本，全程不会读到任何用户小说。

---

## 窗口必须"可见"

窗口被移出屏幕（`x/y = -4000`）但调用 `showInactive()`，**不能**用 `show: false`。

隐藏窗口下 Chromium 会节流 `requestAnimationFrame`，而 `src/reader.js` 的 `restoreScroll()` 正是靠 rAF 做延迟滚动。实测中它被推迟约 500ms 才执行，会在测试已经手动滚动之后突然把位置覆盖回恢复点，导致进度断言以极难理解的方式失败。同时 `backgroundThrottling: false` 也必须保留，否则 500ms 的防抖保存不会按时触发。

建窗后会检查 `clientHeight > 0`，环境无法产生布局时直接报错，而不是让几何断言以空转的方式通过。

---

## 用例

| 用例 | 断言 |
|---|---|
| `api-surface` | `window.novelApi` 的方法集合与 `electron/preload.mjs` 完全一致（检测 mock 漂移） |
| `shelf-empty` | 空书架的引导按钮确实绑定了导入事件 |
| `import` | 导入后自动进入阅读页且正文非空；返回书架后有 1 条记录并显示书名 |
| `toolbar-fixed` | 正文滚动 4000px 后工具栏 `top` 仍为 0 |
| `theme-switch` | 四套主题的 `data-theme`、`--reader-bg` 计算值、选中态；四种背景色互不相同 |
| `settings-persist` | **保存载荷**中 `books[0].settings.fontSize === 26`；reload 后字号与滑块仍是 26 |
| `progress-persist` | 防抖保存了 `paragraphIndex > 0`；返回书架再打开，视口顶部段落索引与保存值相同 |
| `toc-jump` | 识别出 10 个「第N章 …」标题；点击第 6 章后目录关闭，视口顶部**正是该章标题**；工具栏结构与几何（见该用例内的断言） |
| `toc-active` | 用 `uneven` 夹具：跳转到第 5 章后目录高亮的必须是第 5 章；再由滚动路径把第 7 章标题滚到顶部，高亮须跟随 |
| `toc-fallback` | 无空行文本被切分为 200 段；识别不到章节时不出列表、改出进度滑块，滑块 60% 对应约 60% 滚动位置 |

### 两个容易写错的地方

**`settings-persist` 必须检查保存载荷，不能只看"返回书架再打开"。** 渲染进程的 `library` 变量一直在内存里，即使 `saveLibrary` 完全失效，重新打开也照样显示 26px。

**`progress-persist` 必须比较语义位置，不能比较像素。** `restoreScroll()` 用 `scrollIntoView({ block: 'start' })` 对齐段落顶部，恢复后的 `scrollTop` 天然不等于保存前的 `scrollTop`。

---

## 用例隔离

每个用例开始前 `mock.reset(library, variant)` + `reload`（`library` 由 `spec.seed` 决定，`variant` 由 `spec.text` 决定）。**顺序很关键**：`reload` 会让上一个用例的页面触发 `beforeunload`，而 `src/main.js` 在那里调用 `saveLibraryOnExit(library)`，把整份旧数据写回来。

如果这次写入生效，下一个用例就会带着上一个用例的阅读进度和主题启动——恢复位置不再是 0，期望值也来自上一个用例，失败现场极难理解（这正是实现过程中真实踩到过的坑）。

因此 `reset()` 之后进入"未武装"状态：退出时的保存被丢弃，直到新页面真正读取过当前这份数据（`loadLibrary`）为止。`state.calls.droppedSaveOnExit` 记录了被丢弃的次数。

---

## 合成文本的约束

`FIXTURE_TEXT` 的每一段前 80 个字必须唯一。

`src/reader.js` 的 `findRestoreIndex()` 优先按上下文匹配：

```js
paragraphs.findIndex(text => text.includes(progress.context.slice(0, 80)))
```

段落开头若重复，恢复位置会命中错误的段落，测试将以难以理解的方式失败。

### 三个变体

`buildFixture()` 生成三份文本，由 `mock.reset(library, variant)` 选择：

- `'chapters'`（默认）：每 20 段插入一个编号递增的「第N章 …」标题，分隔符 `\n\n`（空行分段）。
- `'plain'`：无标题，分隔符 `\n`（一行一段、无空行）。
- `'uneven'`：同 `'chapters'`，但每段末尾追加随编号增长的填充文字，**段落长度长短不一**。

用例通过 `spec.text` 指定用哪一份。

`'plain'` 同时覆盖两件事：段落切分必须兼容无空行格式（改动前整本会被解析成 1 个段落），以及章节识别失败时降级为百分比滑块。

`'uneven'` 是为「目录高亮错章」这个 bug 加的，理由值得记住：**段落等长时，「滚动比例 × 段落数」这个估算恰好准确**，用它算当前章节永远不会错——也就是说，默认夹具会让这类缺陷完全隐形。真实小说的段落长短悬殊，误差沿全书累积，实测可偏十几章。凡是涉及「像素位置 ↔ 段落序号」换算的断言，都必须用 `'uneven'` 才有效。

---

## 修改 `electron/preload.mjs` 时

必须同步 `mock-preload.mjs`。不同步时 `api-surface` 会失败——这是刻意的：mock 漂移意味着测试通过但真实应用已经坏掉。

---

## 已知的测量口径

`scrollReaderTo()` 会同时设置 `scrollTop` 并派发一个 `scroll` 事件。`getProgressFromScroll()` 在事件触发时读取当前的 `scrollTop` 与 `scrollHeight`，因此断言依赖的是同一帧内的布局。若将来在滚动区域上引入会改变内容高度的异步样式（如网络字体），这些断言需要重新校准。

平滑滚动会让 `scrollTop` 的读取立刻返回旧值，`disableSmoothScroll()` 与 `entry.mjs` 里的 `force-prefers-reduced-motion` 都是为此，与产品在 `prefers-reduced-motion` 下的行为一致，不是绕过测试。

---

## 不包含

**Electron 集成测试**：直接启动 `electron/main.js`、走真实文件系统与 IPC 的测试仍未建立。这里替换掉了 `novelApi`，因此 `electron/main.js`、`electron/book-service.js`、`electron/library-store.js` 自身的接线不在覆盖范围内。
