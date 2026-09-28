// 空行分段的 TXT 里约有一半的行是空行；一行一段的无空行 TXT 该比例接近 0。
// 0.15 落在两者之间明显的空隙里，不依赖精确取值。
const BLANK_LINE_THRESHOLD = 0.15;

// 分隔策略按空行占比自动选择。
// 只按空行切：无空行 TXT 会被解析成一整个段落，整本渲染成单块文字，章节也无处可落。
// 只按换行切：空行分段文件里本来就有软换行的段落会被切碎。
function splitIntoBlocks(normalized) {
  const lines = normalized.split('\n');
  const blankRatio = lines.filter((line) => !line.trim()).length / lines.length;
  return normalized.split(blankRatio >= BLANK_LINE_THRESHOLD ? /\n\s*\n+/ : /\n+/);
}

// `normalized` 为 true 表示调用方已经跑过 electron/book-service.js 的 normalizeText
// （readTxtFile 就是这么返回的），此时可以跳过换行归一化那一次覆盖全文的正则替换。
// 默认 false 保持原有契约不变，测试与其它调用点无需改动。
export function parseParagraphs(text, { normalized = false } = {}) {
  const source = normalized ? text.trim() : text.replace(/\r\n?/g, '\n').trim();
  if (!source) return [];
  const paragraphs = [];
  let cursor = 0;
  for (const rawParagraph of splitIntoBlocks(source)) {
    const paragraph = rawParagraph.replace(/\n+/g, '').trim();
    if (!paragraph) continue;
    const charOffset = source.indexOf(rawParagraph, cursor);
    paragraphs.push({
      index: paragraphs.length,
      text: paragraph,
      charOffset: Math.max(0, charOffset),
    });
    cursor = Math.max(cursor, charOffset + rawParagraph.length);
  }
  return paragraphs;
}

// `offsets` 是 createParagraphWindow() 维护的段落偏移表（段落序号 → 文档坐标，
// 见下）。给了它就直接查表定位：真实小说的段落长度差异很大，
// 「比例 × 段落数」的估算会沿全书累积误差，而查表是准的。
export function getProgressFromScroll(element, paragraphs, offsets = null) {
  const maxScroll = Math.max(1, element.scrollHeight - element.clientHeight);
  const ratio = Math.min(1, Math.max(0, element.scrollTop / maxScroll));
  const paragraphIndex = paragraphs.length
    ? (offsets
      ? findParagraphAtOffset(offsets, element.scrollTop)
      : Math.min(paragraphs.length - 1, Math.max(0, Math.floor(ratio * Math.max(0, paragraphs.length - 1)))))
    : 0;
  const paragraph = paragraphs[paragraphIndex] || { text: '', charOffset: 0 };
  return {
    paragraphIndex,
    charOffset: paragraph.charOffset,
    ratio,
    context: paragraph.text.slice(0, 240),
    updatedAt: new Date().toISOString(),
  };
}

export function findRestoreIndex(paragraphs, progress = {}) {
  if (!paragraphs.length) return 0;
  if (progress.context) {
    const contextIndex = paragraphs.findIndex(({ text }) => text.includes(progress.context.slice(0, 80)));
    if (contextIndex >= 0) return contextIndex;
  }
  if (Number.isFinite(progress.paragraphIndex)) {
    return Math.min(paragraphs.length - 1, Math.max(0, progress.paragraphIndex));
  }
  return Math.min(paragraphs.length - 1, Math.floor((progress.ratio || 0) * paragraphs.length));
}

// ── 段落窗口化渲染 ────────────────────────────────────────────────────────
//
// 整本书一次性物化成 DOM 时（实测 13.3 万段、文档高 1130 万 px），任何触及全篇几何的
// 操作都要 0.5～1.0 s：改一次字号就是一次整篇重排，滑条根本没法跟手。
//
// 这里只渲染视口附近的段落：DOM 里始终只有约 2×WINDOW_MARGIN+1 段，屏幕外的部分由
// 上下两块垫片撑出高度。屏幕外段落的高度先按字数估算，渲染出来之后用实测值替换。
//
// 不用 content-visibility: auto（一段 CSS 就能消掉全篇重排）的原因见
// docs/changes/2026-09-28-阅读性能优化.md：那种做法下屏幕外的段落只有估算高度，
// scrollIntoView 会落在估算位置，而「记住你读到哪」正是这个应用的核心功能。
// 改用偏移表换算 scrollTop 之后，滚动到的位置由表决定，与元素是否已渲染无关。

// 视口顶部所在段落前后各保留的段落数。窗口大小为 2×200+1 段。
const WINDOW_MARGIN = 200;
// 可见范围距窗口边缘不足这么多段就提前重建，避免贴着边缘滚动时每帧都重建。
const REBUILD_PAD = 50;

// 与 src/styles.css 的 .reader-content p 保持一致：字号/行高走 font 简写，
// letter-spacing .015em，段首缩进 2em，段间距是 margin-bottom。
const LETTER_SPACING_EM = 0.015;
const INDENT_EM = 2;

const SPACER_TOP = '<div class="reader-spacer" data-spacer="top" aria-hidden="true"></div>';
const SPACER_BOTTOM = '<div class="reader-spacer" data-spacer="bottom" aria-hidden="true"></div>';

export function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' })[char]);
}

// 段落高度估算。段落是等宽流式块，占几行只取决于「一行放得下几个字」，
// 乘行高再加段间距就是整段高度。真实排版里还有标点压缩、中英文混排等差异，
// 所以这只是估值——渲染出来后会被实测值替换，偏差不会累积。
export function estimateParagraphHeight(text, layout) {
  const { fontSize, lineHeight, paragraphSpacing, contentWidth, indent } = layout;
  const perLine = Math.max(1, Math.floor(contentWidth / (fontSize * (1 + LETTER_SPACING_EM))));
  // 段首缩进占掉首行开头的一小块，等价于少放两个汉字。
  const firstLine = Math.max(1, perLine - (indent ? INDENT_EM : 0));
  const length = text.length;
  const lines = length <= firstLine ? 1 : 1 + Math.ceil((length - firstLine) / perLine);
  return lines * fontSize * lineHeight + paragraphSpacing * fontSize;
}

// 段落序号 → 文档坐标的前缀和。`base` 是第 0 段的文档 y（正文内容盒顶，
// 含 .reader-content 的 padding-top），把它算进去之后 offsets[i] 就是可以直接
// 和 scrollTop 比较的文档坐标，不必在每处调用点再补一次基准。
export function buildOffsetTable(heights, base = 0) {
  const offsets = new Float64Array(heights.length + 1);
  let sum = base;
  for (let i = 0; i < heights.length; i += 1) {
    offsets[i] = sum;
    sum += Math.max(0, heights[i]);
  }
  offsets[heights.length] = sum;
  return offsets;
}

// 段落顶边与滚动位置都取整到设备像素，而偏移表里是浮点数（屏幕外的段落只有
// 按字数算出来的估算高度，带小数）。半像素的容差用来吸收这点误差：顶边落在
// 视口上方不到半像素的段落，肉眼已经看不见了，把它算作「视口顶部那一段」
// 会平白让落点往前漂一段——实测过一次，改字号后整本书往回跳了一段。
const OFFSET_EPSILON = 0.5;

// 文档坐标 y 落在第几段：最后一个 offsets[i] <= y 的 i（含半像素容差）。
export function findParagraphAtOffset(offsets, y) {
  const count = offsets.length - 1;
  if (count <= 0) return 0;
  let low = 0;
  let high = count - 1;
  let found = 0;
  const limit = y + OFFSET_EPSILON;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (offsets[mid] <= limit) {
      found = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return found;
}

// 窗口管理器。只碰它自己那两块垫片和窗口内的段落，其余状态都在这里。
export function createParagraphWindow({ scroll, content, paragraphs }) {
  const count = paragraphs.length;
  const heights = new Float64Array(count);
  let layout = { fontSize: 18, lineHeight: 1.9, paragraphSpacing: 0.9, contentWidth: 720, indent: true };
  let offsets = buildOffsetTable(heights);
  let start = 0;
  let end = 0;
  let rendered = false;
  // 视口顶部那一段，以及它当时相对视口顶部的像素偏移。重建窗口会改变垫片高度、
  // 也可能把若干估算高度换成实测值，靠这两个值把落点钉回原处，否则每次重建都会跳。
  let anchorIndex = 0;
  let anchorViewportOffset = 0;

  // 正文内容盒顶的文档坐标。刻意不写死 padding 值：那是样式表的事，
  // 读一次实测值比维护一个和 CSS 同步的常量可靠。
  function contentBase() {
    const padTop = parseFloat(getComputedStyle(content).paddingTop) || 0;
    return content.getBoundingClientRect().top - scroll.getBoundingClientRect().top + scroll.scrollTop + padTop;
  }

  // 全书重估。屏幕外的段落没有实测高度，只能按字数和当前排版参数推算；
  // 改字号或版心宽度会让所有估算同时失效，因此每次排版参数变化都要重跑一遍。
  function reestimate() {
    layout.contentWidth = content.clientWidth;
    for (let i = 0; i < count; i += 1) heights[i] = estimateParagraphHeight(paragraphs[i].text, layout);
    offsets = buildOffsetTable(heights, contentBase());
  }

  // 采当前锚点：视口顶部那一段，以及它已经被卷上去的像素数（≤ 0，绝对值小于段高）。
  //
  // 位置全部由偏移表算出，不去读元素的实际位置：垫片高度和窗口内段落的实测高度
  // 都写在这张表里，DOM 与表本来就是一致的。反过来，改字号时样式早就被改掉了，
  // 那一刻读到的 DOM 位置反映的是「旧 scrollTop + 新字号」，量出来的锚点偏移
  // 会大得离谱——实测过一次：改完字号整本书往回跳了 101 段。
  function captureAnchor() {
    anchorIndex = findParagraphAtOffset(offsets, scroll.scrollTop);
    anchorViewportOffset = offsets[anchorIndex] - scroll.scrollTop;
  }

  // targetIndex 给定 → 该段对齐到视口顶部（打开书籍、跳章节、拖进度条）；
  // 省略 → 保持锚点当前的像素位置（调用方已经采好锚点）。
  function paint(targetIndex) {
    if (!count) {
      content.innerHTML = '';
      rendered = false;
      return;
    }
    if (Number.isFinite(targetIndex)) {
      anchorIndex = Math.min(count - 1, Math.max(0, Math.trunc(targetIndex)));
      anchorViewportOffset = 0;
    }

    start = Math.max(0, anchorIndex - WINDOW_MARGIN);
    end = Math.min(count, anchorIndex + WINDOW_MARGIN + 1);
    const parts = [];
    for (let i = start; i < end; i += 1) {
      parts.push(`<p data-paragraph-index="${i}">${escapeHtml(paragraphs[i].text)}</p>`);
    }
    content.innerHTML = `${SPACER_TOP}${parts.join('')}${SPACER_BOTTOM}`;

    // 相邻兄弟的 offsetTop 之差就是这一段的真实步距：行高、段间距、标点压缩、
    // 中英文混排的差异全都在里面，比自己按行数算准。第一次读取会强制一次布局，
    // 之后同一帧内的读取都用现成结果；窗口只有几百段，整轮下来是毫秒级。
    const nodes = content.children;
    for (let i = start; i < end; i += 1) {
      heights[i] = nodes[i - start + 2].offsetTop - nodes[i - start + 1].offsetTop;
    }
    offsets = buildOffsetTable(heights, offsets[0]);

    const base = offsets[0];
    nodes[0].style.height = `${Math.max(0, offsets[start] - base)}px`;
    nodes[nodes.length - 1].style.height = `${Math.max(0, offsets[count] - offsets[end])}px`;
    scroll.scrollTop = Math.max(0, offsets[anchorIndex] - anchorViewportOffset);
    rendered = true;
  }

  return {
    // 排版参数变化后调用：重估全书 → 重渲染窗口 → 保持锚点。窗口里只有几百段，
    // 所以改一次字号只重排几百段，而不是全篇。
    setLayout(next) {
      // 采锚点必须在重估之前：重估把整张表换成新字号下的位置，而 scrollTop 还是
      // 旧字号下的值，之后再采就采到别的段落上去了。
      if (rendered) captureAnchor();
      layout = { ...layout, ...next };
      reestimate();
      paint(rendered ? null : anchorIndex);
    },
    // 把第 index 段对齐到视口顶部。不再用 scrollIntoView：它要求那一段已经在
    // DOM 里，而窗口化之后屏幕外的段落按定义就是不在的。
    scrollToIndex(index) {
      paint(index);
    },
    // 滚动时调用。窗口还盖得住就什么都不做（绝大多数滚动事件都是这种情况）。
    syncViewport() {
      if (!rendered || !count) return;
      const first = findParagraphAtOffset(offsets, scroll.scrollTop);
      const last = findParagraphAtOffset(offsets, scroll.scrollTop + scroll.clientHeight);
      if (first - start >= REBUILD_PAD && end - 1 - last >= REBUILD_PAD) return;
      captureAnchor();
      paint(null);
    },
    // 视口顶部所在段落。查表即可，不必再对 DOM 做二分查找（那会强制布局）。
    topIndex() {
      return count ? findParagraphAtOffset(offsets, scroll.scrollTop) : -1;
    },
    // 只读的偏移表，交给 getProgressFromScroll 定位用。
    offsets: () => offsets,
  };
}

// ── 章节识别 ──────────────────────────────────────────────────────────────
//
// 目录只在打开书籍时从内存中的段落现算，不写入 library.json。
// 核心约束 1 于 2026-09-28 放宽后，章节标题已经允许落盘，这里仍然选择不落盘，
// 理由是收益不抵代价：识别占打开耗时的比例极小（瓶颈是段落解析与建树），
// 却要把上千条正文派生字符串写进 library.json。详见 docs/PROJECT.md 第 4 节。

const CN_DIGITS = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  壹: 1, 贰: 2, 叁: 3, 肆: 4, 伍: 5, 陆: 6, 柒: 7, 捌: 8, 玖: 9,
};
const CN_UNITS = { 十: 10, 拾: 10, 百: 100, 佰: 100, 千: 1000, 仟: 1000 };

// 「第一百二十三」→ 123，「十一」→ 11，「一百零五」→ 105。
// 无法解析（含「万」以上的组合、出现不认识的字符）时返回 null。
export function parseChineseNumber(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (/^[0-9０-９]+$/.test(text)) {
    return Number(text.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0)));
  }
  if (text.includes('万')) return null;
  let section = 0;
  let digit = null;
  for (const char of text) {
    if (char in CN_DIGITS) {
      digit = CN_DIGITS[char];
      continue;
    }
    const unit = CN_UNITS[char];
    if (unit === undefined) return null;
    // 「十一」这类省略了前导一，按 1 计。
    section += (digit === null ? 1 : digit) * unit;
    digit = null;
  }
  return section + (digit ?? 0);
}

// 锚定段首 + 尾部限长，正文里提到「第一章」的长句不会命中。
const NUMBERED_HEADING = /^[【\[（(《]?\s*(?:正文\s*)?第\s*([0-9０-９零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾佰仟]+)\s*[章节回卷部篇集]\s*[】\]）)》]?\s*(.{0,24})$/;
// 刻意不收单字「序」：它会让「序幕已经拉开……」这类正文短句混进目录。
// 宁可漏判，代价只是需要滚动定位。
const SPECIAL_HEADING = /^[【\[（(《]?\s*(序章|序言|楔子|引子|前言|后记|尾声|终章|番外篇|番外|附录|作者的话)\s*[】\]）)》]?\s*(.{0,24})$/;

// 数字型标题应当大体递增。散乱命中（正文里偶尔出现的短句「第三部分」之类）
// 往往不满足这一点，据此判定「不像目录」并整本放弃识别。
// 宁可漏判：漏判只是需要滚动定位，误判会在目录里塞进正文句子。
const SEQUENCE_THRESHOLD = 0.6;

function looksLikeChapterSequence(candidates) {
  const numbers = candidates.map((item) => item.number).filter((value) => Number.isFinite(value));
  if (numbers.length < 2) return true;
  let increasing = 0;
  for (let i = 1; i < numbers.length; i += 1) {
    if (numbers[i] >= numbers[i - 1]) increasing += 1;
  }
  return increasing / (numbers.length - 1) >= SEQUENCE_THRESHOLD;
}

// 扫段落而不是扫原始文本行：段落是滚动定位的最小单位，行号无法直接映射到 DOM。
// 两种分段格式下标题都恰好是独立段落，因此这里不需要额外的行号映射。
export function detectChapters(paragraphs) {
  if (!Array.isArray(paragraphs) || paragraphs.length < 2) return [];
  const candidates = [];
  for (const paragraph of paragraphs) {
    const text = paragraph.text.trim();
    if (!text) continue;
    const numbered = NUMBERED_HEADING.exec(text);
    const special = numbered ? null : SPECIAL_HEADING.exec(text);
    if (!numbered && !special) continue;
    candidates.push({
      index: candidates.length,
      paragraphIndex: paragraph.index,
      title: text,
      number: numbered ? parseChineseNumber(numbered[1]) : null,
    });
  }
  if (candidates.length < 2) return [];
  if (!looksLikeChapterSequence(candidates)) return [];
  return candidates;
}
