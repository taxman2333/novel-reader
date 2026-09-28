// 阅读性能基准。把 docs/changes/2026-09-28-阅读性能优化.md 里的测量固化成可重跑的脚本，
// 用来验证优化是否真的生效，也用来判断「阶段 2」还有没有必要做。
//
//   npm run bench                  # 用书架里已有的书（只读路径，不读正文以外的任何东西）
//   npm run bench -- <TXT 路径>     # 用指定的 TXT
//
// 这个脚本刻意不写入任何用户数据：userData 全程指向临时目录，书架路径只在读取时从
// appData 下现取，正文只留在内存里。仓库里也不留任何本机个人路径。
//
// 分两段测：
//   1. 文本流水线（主进程）—— 读文件、解码、规范化、分段、章节识别、拼 HTML 字符串。
//   2. 排版（渲染进程）—— 用真实 styles.css、按真实段落数与平均段长合成段落，测建树、
//      首次布局、重排，以及滚动帧间隔。
//
// 第二段刻意把两种 DOM 形态都测一遍：
//   · 「整本一次性物化」是阶段 2 之前的形态，留作对照基线；
//   · 「窗口 + 上下垫片」是现在 src/reader.js 实际用的形态。
//   两组数字放在一起，才能看出窗口化到底省掉了多少。
//
// 第二段用合成段落而不是真实正文：把上百万字符的正文通过 IPC 送进渲染进程本身就要
// 花掉可观的时间，会污染待测的那几个数。段落数与平均长度取自真实书籍，量级不失真。

import { app, BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeText, normalizeText } from '../electron/book-service.js';
import { detectChapters, escapeHtml, estimateParagraphHeight, parseParagraphs } from '../src/reader.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const WORK_DIR = path.join(os.tmpdir(), 'novel-reader-bench');

// 与 electron/main.js 的 USER_DATA_DIR_NAME 保持一致。这里只读。
const USER_DATA_DIR_NAME = 'local-novel-reader';

// 必须在 ready 之前调用：绝不能让基准脚本碰到用户真实的 library.json 与缓存。
app.setPath('userData', path.join(WORK_DIR, 'userdata'));

// 覆盖 Electron 的默认行为：没有这个监听器时，最后一个窗口一关闭应用就会自己退出。
// 这个脚本每测完一本书就销毁窗口，不拦一下会在中途静默结束（退出码仍是 0）。
app.on('window-all-closed', () => {});

const f = (value) => `${value.toFixed(1).padStart(9)} ms`;
const log = (line = '') => process.stdout.write(`${line}\n`);

function resolveBookPaths() {
  const args = process.argv.slice(2)
    .filter((arg) => !arg.startsWith('-') && /\.txt$/i.test(arg) && fs.existsSync(arg));
  if (args.length) return args;
  try {
    const file = path.join(app.getPath('appData'), USER_DATA_DIR_NAME, 'library.json');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (data.books || []).map((book) => book.path).filter((p) => p && fs.existsSync(p));
  } catch {
    return [];
  }
}

// 界面拼 HTML 用的就是 src/reader.js 的 escapeHtml——基准脚本要测的是同一份实现，
// 自己留一份副本反而会把差异藏起来（src/reader.js 不在模块层碰 document，
// 这里 import 它是安全的）。

function benchTextPipeline(filePath) {
  const buffer = fs.readFileSync(filePath);
  const steps = [];
  const step = (label, fn) => {
    const start = performance.now();
    const out = fn();
    steps.push([label, performance.now() - start]);
    return out;
  };

  const { text, encoding } = step('解码（按 BOM/替换字符判别编码）', () => decodeText(buffer));
  const normalized = step('规范化（换行 + 行尾空白）', () => normalizeText(text));
  // 两个分段变体各先热身一次再计时：首次调用含 JIT 预热，直接一前一后计时会把
  // 先跑的那个算贵，得出的差值不可信。
  parseParagraphs(normalized, { normalized: true });
  parseParagraphs(normalized);
  const paragraphs = step('分段（normalized: true）', () => parseParagraphs(normalized, { normalized: true }));
  step('分段（不传 normalized，多一次全文正则）', () => parseParagraphs(normalized));
  const chapters = step('章节识别', () => detectChapters(paragraphs));
  const html = step('拼 HTML 字符串', () => paragraphs
    .map(({ text: paragraph, index }) => `<p data-paragraph-index="${index}">${escapeHtml(paragraph)}</p>`)
    .join(''));

  let total = 0;
  for (const [, value] of steps) total += value;

  return { steps, total, size: buffer.length, encoding, paragraphs, chapters, html };
}

// 渲染进程里的测量工具。注入后由主进程调用。
const HARNESS = () => {
  const shell = document.querySelector('#shell');
  const scroll = document.querySelector('#reader-scroll');
  const content = document.querySelector('#reader-content');
  const CHUNK = '这是一段用于测量排版开销的正文段落它包含标点符号和足够多的汉字以逼近真实小说段落长度';

  // 复刻 src/main.js 的 applyReaderSettings()。真实样式表里的段落用
  // `font: var(--reader-font-size)/var(--reader-line-height) ...` 简写，
  // 这几个变量缺一个就会让整条 font 声明失效，测出来的数会偏小。
  const apply = (settings) => {
    shell.dataset.theme = settings.theme;
    shell.style.setProperty('--reader-font-size', `${settings.fontSize}px`);
    shell.style.setProperty('--reader-line-height', settings.lineHeight);
    shell.style.setProperty('--paragraph-gap', `${settings.paragraphSpacing}em`);
    shell.style.setProperty('--content-width', `${settings.contentWidth}px`);
    shell.dataset.font = settings.fontFamily;
    shell.dataset.indent = settings.indent ? 'true' : 'false';
  };

  const paragraphMarkup = (index, avgLength) => `<p data-paragraph-index="${index}">${CHUNK.repeat(4).slice(0, avgLength)}</p>`;

  // 阶段 2 之前的形态：整本一次性物化。
  window.__build = (count, avgLength, settings) => {
    apply(settings);
    const parts = [];
    for (let i = 0; i < count; i += 1) parts.push(paragraphMarkup(i, avgLength));
    const html = parts.join('');

    let start = performance.now();
    content.innerHTML = html;
    const build = performance.now() - start;

    start = performance.now();
    void scroll.scrollHeight;
    const layout = performance.now() - start;

    return { build, layout, height: scroll.scrollHeight, nodes: content.childElementCount };
  };

  // 阶段 2 之后的形态：上下垫片 + 窗口内 2×margin+1 段。复刻 src/reader.js 的做法，
  // 连「相邻兄弟 offsetTop 之差 = 该段真实步距」这一步也照做，否则测不到回填的开销。
  // 垫片把窗口摆在全书正中：这样后面测滚动时是在窗口内滚，而不是在空白垫片上滑。
  window.__window = (count, avgLength, settings, margin) => {
    apply(settings);
    const width = margin * 2 + 1;
    const parts = [];
    for (let i = 0; i < width; i += 1) parts.push(paragraphMarkup(i, avgLength));

    // 先清空：上一步测「整本物化」时留下十几万个节点，不清掉的话拆树的开销会被
    // 算进这次建树里（实测过，401 段量出 68ms，比真实值大一个数量级）。
    content.innerHTML = '';
    let start = performance.now();
    content.innerHTML = `<div class="reader-spacer" data-spacer="top"></div>${parts.join('')}<div class="reader-spacer" data-spacer="bottom"></div>`;
    const build = performance.now() - start;

    const nodes = content.children;
    start = performance.now();
    let sum = 0;
    for (let i = 0; i + 2 < nodes.length; i += 1) sum += nodes[i + 2].offsetTop - nodes[i + 1].offsetTop;
    const measure = performance.now() - start;

    const hidden = Math.max(0, count - width) * (sum / width);
    nodes[0].style.height = `${Math.round(hidden / 2)}px`;
    nodes[nodes.length - 1].style.height = `${Math.round(hidden / 2)}px`;
    scroll.scrollTop = nodes[0].offsetHeight;

    return { build, measure, nodes: content.childElementCount, height: scroll.scrollHeight };
  };

  // 改一次设置 = 一次强制整篇重排。返回同步等待布局花掉的时间，
  // 也就是滑条拖动时每一帧真正被卡住的时间。
  window.__tick = (settings) => {
    apply(settings);
    const start = performance.now();
    void scroll.scrollHeight;
    return performance.now() - start;
  };

  // 滚动帧间隔：确认「滚动卡顿」这项没有回归。
  // 从当前位置起滚，不是从 0：窗口形态下正文只存在于窗口内，从 0 起滚会先穿过
  // 一大段空白垫片，量到的不是排版开销。因此调用前必须先把窗口摆好。
  window.__scroll = (ticks, step) => new Promise((resolve) => {
    const frames = [];
    let last = performance.now();
    let handlerMs = 0;
    scroll.addEventListener('scroll', () => {
      const start = performance.now();
      scroll.getBoundingClientRect();
      handlerMs += performance.now() - start;
    }, { passive: true });

    let done = 0;
    const tick = () => {
      const now = performance.now();
      frames.push(now - last);
      last = now;
      scroll.scrollTop += step;
      done += 1;
      if (done < ticks) requestAnimationFrame(tick);
      else resolve({ frames: frames.slice(1), handlerMs });
    };
    requestAnimationFrame(tick);
  });
};

// 与 src/reader.js 的 WINDOW_MARGIN 保持一致。
const WINDOW_MARGIN = 200;
// 窗口形态下滚动这么久：120 帧 × 700px 会一路滚出窗口（401 段约合 4.8 万 px），
// 之后的帧只是在空白垫片上滑。帧间隔是逐帧统计量，帧数与整本形态不同不影响可比性。
const WINDOW_SCROLL_TICKS = 60;
const SCROLL_STEP = 700;

// 改一次设置要付出的、与渲染无关的那部分：全书高度重估（纯 JS，主进程侧同样适格）。
// 热身一次再计时，否则会把 JIT 预热算进去。
function benchEstimate(paragraphs, layout) {
  const run = () => {
    let sum = 0;
    for (const paragraph of paragraphs) sum += estimateParagraphHeight(paragraph.text, layout);
    return sum;
  };
  run();
  const start = performance.now();
  const sum = run();
  return { ms: performance.now() - start, sum };
}

async function benchLayout({ paragraphCount, avgLength, settings }) {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'styles.css'), 'utf8');
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const pagePath = path.join(WORK_DIR, 'page.html');
  // 内联真实的 styles.css 而不是外链：file:// 页面加载 file:// 子资源的行为在不同
  // Chromium 版本上不一致，内联之后测到的排版规则和界面完全一致，也没有加载失败的风险。
  fs.writeFileSync(pagePath, `<!doctype html><meta charset="utf-8"><style>${css}</style>
<body><main class="reader-shell" id="shell" data-theme="warm" data-font="serif" data-indent="true">
<header class="reader-toolbar" style="height:68px"></header>
<section class="reader-scroll" id="reader-scroll"><article class="reader-content" id="reader-content"></article></section>
</main></body>`, 'utf8');

  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    backgroundColor: '#f1ede4',
    webPreferences: { sandbox: false, backgroundThrottling: false },
  });
  await win.loadFile(pagePath);
  await win.webContents.executeJavaScript(`(${HARNESS.toString()})()`);

  // 布局类指标（建树、强制布局、重排）是同步测量，与窗口是否可见无关，可以用隐藏窗口测。
  // 先测「整本一次性物化」——阶段 2 之前的形态，作为对照基线。
  const built = await win.webContents.executeJavaScript(`window.__build(${paragraphCount}, ${avgLength}, ${JSON.stringify(settings)})`);
  const wholeFont = await win.webContents.executeJavaScript(`window.__tick(${JSON.stringify({ ...settings, fontSize: settings.fontSize + 1 })})`);
  const wholeWidth = await win.webContents.executeJavaScript(`window.__tick(${JSON.stringify({ ...settings, contentWidth: settings.contentWidth + 20 })})`);

  // 再换成阶段 2 实际用的形态。__window 自带建树与回填的计时。
  const windowed = await win.webContents.executeJavaScript(`window.__window(${paragraphCount}, ${avgLength}, ${JSON.stringify(settings)}, ${WINDOW_MARGIN})`);
  const windowFont = await win.webContents.executeJavaScript(`window.__tick(${JSON.stringify({ ...settings, fontSize: settings.fontSize + 2 })})`);
  const windowWidth = await win.webContents.executeJavaScript(`window.__tick(${JSON.stringify({ ...settings, contentWidth: settings.contentWidth + 40 })})`);

  // 滚动帧间隔必须先让窗口真正可见：从未显示过的窗口不参与合成，Chromium 会把它的
  // requestAnimationFrame 压到约 1 帧/秒（实测帧间隔 1001.9 ms），测出来的不是性能。
  // 因此这里短暂显示窗口，测完立刻隐藏。
  win.show();
  const scrolled = await win.webContents.executeJavaScript(`window.__scroll(${WINDOW_SCROLL_TICKS}, ${SCROLL_STEP})`);
  win.hide();

  win.destroy();
  // 让渲染进程先退干净再测下一本：连续开关窗口时 Electron 偶发
  // `crashpad_client_win.cc: not connected`，出现在第二本书开始处。
  await new Promise((resolve) => setTimeout(resolve, 400));

  const sorted = [...scrolled.frames].sort((a, b) => a - b);
  const percentile = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 0;

  return {
    built,
    wholeFont,
    wholeWidth,
    windowed,
    windowFont,
    windowWidth,
    frameMedian: percentile(0.5),
    frameP90: percentile(0.9),
    frameMax: sorted[sorted.length - 1] || 0,
    handlerMs: scrolled.handlerMs,
  };
}

const SETTINGS = {
  fontSize: 18,
  lineHeight: 1.9,
  paragraphSpacing: 0.9,
  contentWidth: 720,
  fontFamily: 'serif',
  theme: 'warm',
  indent: true,
};

app.whenReady().then(async () => {
  const books = resolveBookPaths();
  if (!books.length) {
    log('没有可测量的书。用法：npm run bench -- <TXT 路径>');
    app.exit(1);
    return;
  }

  for (const bookPath of books) {
    log('');
    log('='.repeat(72));
    log(path.basename(bookPath));
    log('='.repeat(72));

    const result = benchTextPipeline(bookPath);
    const avgLength = Math.round(
      result.paragraphs.reduce((sum, paragraph) => sum + paragraph.text.length, 0) / Math.max(1, result.paragraphs.length),
    );

    log(`  文件 ${(result.size / 1024 / 1024).toFixed(2)} MB · 编码 ${result.encoding} · `
      + `段落 ${result.paragraphs.length} · 平均段长 ${avgLength} 字 · 章节 ${result.chapters.length}`);
    log(`  HTML 字符串 ${(result.html.length / 1024 / 1024).toFixed(2)} MB`);
    log('');
    log('  — 文本流水线（主进程，全部在内存中）');
    for (const [label, value] of result.steps) log(`    ${label.padEnd(34)}${f(value)}`);
    log(`    ${'合计'.padEnd(34)}${f(result.total)}`);

    const layout = await benchLayout({
      paragraphCount: result.paragraphs.length,
      avgLength,
      settings: SETTINGS,
    });
    const estimate = benchEstimate(result.paragraphs, { ...SETTINGS, contentWidth: 720 });

    log('');
    log('  — 排版（渲染进程，合成段落）');
    log('');
    log('    ▸ 阶段 2 之前的形态：整本一次性物化为 DOM');
    log(`    ${'建树 innerHTML'.padEnd(36)}${f(layout.built.build)}`);
    log(`    ${'首次强制布局'.padEnd(36)}${f(layout.built.layout)}   （文档高 ${(layout.built.height / 1000).toFixed(0)} 千 px，${layout.built.nodes} 个 <p>）`);
    log(`    ${'改一次字号（整篇重排）'.padEnd(36)}${f(layout.wholeFont)}`);
    log(`    ${'改一次版心宽度（整篇重排）'.padEnd(36)}${f(layout.wholeWidth)}`);
    log('');
    log(`    ▸ 阶段 2 之后的形态：窗口内 ${WINDOW_MARGIN * 2 + 1} 段 + 上下垫片`);
    log(`    ${'建树 innerHTML'.padEnd(36)}${f(layout.windowed.build)}   （DOM 中 ${layout.windowed.nodes} 个节点）`);
    log(`    ${'实测回填（读 offsetTop）'.padEnd(36)}${f(layout.windowed.measure)}`);
    log(`    ${'改一次字号（重排窗口）'.padEnd(36)}${f(layout.windowFont)}`);
    log(`    ${'改一次版心宽度（重排窗口）'.padEnd(36)}${f(layout.windowWidth)}`);
    log(`    ${'重估全书（主进程 JS，改设置时同批）'.padEnd(36)}${f(estimate.ms)}`);
    log('');
    log(`    ▸ 滚动（窗口形态，每帧 ${SCROLL_STEP}px，从窗口顶部起滚）`);
    log(`    ${`帧间隔中位数（${WINDOW_SCROLL_TICKS} 帧）`.padEnd(36)}${f(layout.frameMedian)}`);
    log(`    ${'帧间隔 P90'.padEnd(36)}${f(layout.frameP90)}`);
    log(`    ${'帧间隔最大'.padEnd(36)}${f(layout.frameMax)}`);
    log(`    ${'滚动处理器累计'.padEnd(36)}${f(layout.handlerMs)}`);
  }

  log('');
  app.exit(0);
});
