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

export function parseParagraphs(text) {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  const paragraphs = [];
  let cursor = 0;
  for (const rawParagraph of splitIntoBlocks(normalized)) {
    const paragraph = rawParagraph.replace(/\n+/g, '').trim();
    if (!paragraph) continue;
    const charOffset = normalized.indexOf(rawParagraph, cursor);
    paragraphs.push({
      index: paragraphs.length,
      text: paragraph,
      charOffset: Math.max(0, charOffset),
    });
    cursor = Math.max(cursor, charOffset + rawParagraph.length);
  }
  return paragraphs;
}

export function getProgressFromScroll(element, paragraphs) {
  const maxScroll = Math.max(1, element.scrollHeight - element.clientHeight);
  const ratio = Math.min(1, Math.max(0, element.scrollTop / maxScroll));
  const paragraphIndex = paragraphs.length
    ? Math.min(paragraphs.length - 1, Math.max(0, Math.floor(ratio * Math.max(0, paragraphs.length - 1))))
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

export function restoreScroll(element, paragraphs, progress) {
  if (!paragraphs.length) return;
  const index = findRestoreIndex(paragraphs, progress);
  requestAnimationFrame(() => {
    const target = element.querySelector(`[data-paragraph-index="${index}"]`);
    if (target) target.scrollIntoView({ block: 'start' });
    else element.scrollTop = (progress.ratio || 0) * Math.max(0, element.scrollHeight - element.clientHeight);
  });
}

// ── 章节识别 ──────────────────────────────────────────────────────────────
//
// 目录只在打开书籍时从内存中的段落现算，不写入 library.json：
// 章节标题是小说正文的片段，落盘就违反了「正文不复制到应用内部」的核心约束。

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
