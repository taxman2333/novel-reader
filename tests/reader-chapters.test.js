import test from 'node:test';
import assert from 'node:assert/strict';
import { detectChapters, parseChineseNumber, parseParagraphs } from '../src/reader.js';

// 便于构造段落：detectChapters 只读 text 与 index。
function toParagraphs(lines) {
  return lines.map((text, index) => ({ index, text, charOffset: 0 }));
}

function titles(lines) {
  return detectChapters(toParagraphs(lines)).map((chapter) => chapter.title);
}

test('parses Arabic, full-width and Chinese chapter numbers', () => {
  assert.equal(parseChineseNumber('1'), 1);
  assert.equal(parseChineseNumber('12'), 12);
  assert.equal(parseChineseNumber('１２'), 12);
  assert.equal(parseChineseNumber('一'), 1);
  assert.equal(parseChineseNumber('十'), 10);
  assert.equal(parseChineseNumber('十一'), 11);
  assert.equal(parseChineseNumber('二十'), 20);
  assert.equal(parseChineseNumber('一百二十三'), 123);
  assert.equal(parseChineseNumber('一百零五'), 105);
  assert.equal(parseChineseNumber('两千'), 2000);
});

test('gives up on numbers it cannot parse instead of guessing', () => {
  assert.equal(parseChineseNumber('一万'), null);
  assert.equal(parseChineseNumber('三只'), null);
  assert.equal(parseChineseNumber(''), null);
});

test('detects numbered chapters written in Chinese numerals', () => {
  const chapters = detectChapters(toParagraphs([
    '第一章 初入江湖',
    '正文内容。',
    '第二章 风起',
    '正文内容。',
    '第三章 落幕',
  ]));
  assert.equal(chapters.length, 3);
  assert.deepEqual(chapters.map((chapter) => chapter.title), ['第一章 初入江湖', '第二章 风起', '第三章 落幕']);
  assert.deepEqual(chapters.map((chapter) => chapter.paragraphIndex), [0, 2, 4]);
  assert.deepEqual(chapters.map((chapter) => chapter.number), [1, 2, 3]);
});

test('detects Arabic, bracketed and decorated headings', () => {
  assert.deepEqual(titles([
    '第1章 起点',
    '正文。',
    '第 12 回 归途',
    '正文。',
    '【第13节】',
  ]), ['第1章 起点', '第 12 回 归途', '【第13节】']);
});

test('detects special headings and mixes them with numbered ones', () => {
  const chapters = detectChapters(toParagraphs([
    '序章 引子',
    '正文。',
    '第一章 开始',
    '正文。',
    '番外 后日谈',
  ]));
  assert.equal(chapters.length, 3);
  assert.deepEqual(chapters.map((chapter) => chapter.number), [null, 1, null]);
});

test('ignores chapter words buried inside prose', () => {
  // 段首锚定 + 尾部限长共同作用。同时放入两个合法标题，确保断言失效时
  // 真的是限长在起作用，而不是「候选太少直接放弃」这类别的原因。
  assert.deepEqual(titles([
    '第一章 起点',
    '正文内容。',
    '第二章 归途',
    '正文内容。',
    '第一章的内容我读过了，接下来要说的是别的事情，这一段相当长，超出了标题应有的长度。',
    '他翻开第三章，发现里面夹着一张纸条，于是合上书，转身走向门口，天已经黑了。',
    '第三部分的内容如下，我们需要在这里展开说明，因此这一段同样很长很长很长。',
  ]), ['第一章 起点', '第二章 归途']);
});

test('rejects scattered matches that do not form a sequence', () => {
  // 命中数量足够，但编号杂乱无序，判定为「不像目录」而整本放弃。
  assert.deepEqual(titles([
    '第五十章 甲',
    '第一章 乙',
    '第九十章 丙',
    '第二章 丁',
    '第七十章 戊',
  ]), []);
});

test('returns nothing for a single candidate', () => {
  assert.deepEqual(titles(['第一章 唯一', '正文内容。', '正文内容。']), []);
});

test('splits blank-line separated text', () => {
  const paragraphs = parseParagraphs('第一段。\n\n第二段。\n\n第三段。');
  assert.equal(paragraphs.length, 3);
  assert.deepEqual(paragraphs.map((paragraph) => paragraph.text), ['第一段。', '第二段。', '第三段。']);
});

test('splits one-line-per-paragraph text that has no blank lines', () => {
  // 改动前这里会得到 1 个段落，整本书渲染成一整块文字，章节也无处可落。
  const paragraphs = parseParagraphs('第一段。\n第二段。\n第三段。');
  assert.equal(paragraphs.length, 3);
  assert.deepEqual(paragraphs.map((paragraph) => paragraph.text), ['第一段。', '第二段。', '第三段。']);
});

test('keeps blank-line separated text with soft-wrapped paragraphs intact', () => {
  // 空行分段文件里段内本来就有换行，不能被切碎。
  const paragraphs = parseParagraphs('第一段第一行\n第一段第二行\n\n第二段。');
  assert.equal(paragraphs.length, 2);
  assert.equal(paragraphs[0].text, '第一段第一行第一段第二行');
});

test('detects chapters in a no-blank-line novel end to end', () => {
  const text = ['第一章 起点', '正文一。', '正文二。', '第二章 归途', '正文三。'].join('\n');
  const chapters = detectChapters(parseParagraphs(text));
  assert.deepEqual(chapters.map((chapter) => chapter.title), ['第一章 起点', '第二章 归途']);
  assert.deepEqual(chapters.map((chapter) => chapter.paragraphIndex), [0, 3]);
});
