import test from 'node:test';
import assert from 'node:assert/strict';
import { buildOffsetTable, estimateParagraphHeight, findParagraphAtOffset } from '../src/reader.js';

// 与 src/styles.css 的默认排版一致（见 src/store.js 的 DEFAULT_SETTINGS）。
const LAYOUT = {
  fontSize: 18,
  lineHeight: 1.9,
  paragraphSpacing: 0.9,
  contentWidth: 720,
  indent: true,
};

// 一行行高 + 段间距。所有断言都用它当标尺，避免把魔数散在各处。
const LINE = LAYOUT.fontSize * LAYOUT.lineHeight;
const GAP = LAYOUT.paragraphSpacing * LAYOUT.fontSize;

function heightFor(text, layout = LAYOUT) {
  return estimateParagraphHeight(text, layout);
}

test('estimates a single line for a short paragraph', () => {
  assert.equal(heightFor('短'), LINE + GAP);
});

test('breaks lines at the estimated characters-per-line boundary', () => {
  // 720px 版心、18px 字号、letter-spacing .015em → 一行 39 字；
  // 段首缩进占两个汉字，首行 37 字。这一组边界值就是估算公式的可见契约。
  const perLine = 39;
  const firstLine = 37;
  assert.equal(heightFor('字'.repeat(firstLine)), LINE + GAP, '首行装得下就是一行');
  assert.equal(heightFor('字'.repeat(firstLine + 1)), 2 * LINE + GAP, '多一个字就要换行');
  assert.equal(heightFor('字'.repeat(firstLine + perLine)), 2 * LINE + GAP, '第二行装满仍是两行');
  assert.equal(heightFor('字'.repeat(firstLine + perLine + 1)), 3 * LINE + GAP);
});

test('a wider column fits more characters per line', () => {
  const text = '字'.repeat(200);
  assert.ok(
    heightFor(text, { ...LAYOUT, contentWidth: 920 }) < heightFor(text, { ...LAYOUT, contentWidth: 560 }),
    '版心更宽时同一段落占的行数应更少',
  );
});

test('first-line indent costs room on the first line only', () => {
  const text = '字'.repeat(80);
  const indented = heightFor(text, { ...LAYOUT, indent: true });
  const flush = heightFor(text, { ...LAYOUT, indent: false });
  assert.ok(indented >= flush, '段首缩进不会让段落变矮');
  // 只影响首行：最多差一行。
  assert.ok(indented - flush <= LINE + 1e-9, '缩进的影响不应超过一行');
});

test('never estimates less than one line', () => {
  assert.equal(heightFor(''), LINE + GAP);
  assert.equal(heightFor('', { ...LAYOUT, paragraphSpacing: 0 }), LINE);
});

test('describes a paragraph that needs an empty offset table', () => {
  assert.equal(buildOffsetTable(new Float64Array(0)).length, 1);
  assert.equal(findParagraphAtOffset(buildOffsetTable(new Float64Array(0)), 100), 0);
});

test('builds cumulative offsets with an optional base', () => {
  const offsets = buildOffsetTable(Float64Array.from([100, 200, 300]));
  assert.deepEqual([...offsets], [0, 100, 300, 600]);
  // base 就是第 0 段的文档坐标（正文内容盒顶），算进去以后 offsets[i] 可以直接
  // 和 scrollTop 比较。
  assert.deepEqual([...buildOffsetTable(Float64Array.from([100, 200]), 78)], [78, 178, 378]);
});

test('finds the paragraph containing a document offset', () => {
  const offsets = buildOffsetTable(Float64Array.from([100, 200, 300]), 78);
  assert.equal(findParagraphAtOffset(offsets, 0), 0, '内容盒之上的位置属于第 0 段');
  assert.equal(findParagraphAtOffset(offsets, 78), 0, '段落顶边属于该段');
  assert.equal(findParagraphAtOffset(offsets, 177), 0, '段内位置属于该段');
  assert.equal(findParagraphAtOffset(offsets, 178), 1, '下一段顶边属于下一段');
  assert.equal(findParagraphAtOffset(offsets, 500), 2);
  assert.equal(findParagraphAtOffset(offsets, 99999), 2, '超出末尾时停在最后一段');
});

test('absorbs sub-pixel rounding at a paragraph boundary', () => {
  const offsets = buildOffsetTable(Float64Array.from([100, 200, 300]), 78);
  // 段落顶边在 178，而 scrollTop 读回来是 177.75（浏览器按设备像素取整）。
  // 差不到半个像素的段落肉眼看不见，不能算作视口顶部那一段，
  // 否则每次重排都会把落点往前推一整段。
  assert.equal(findParagraphAtOffset(offsets, 177.75), 1, '顶边在视口上方不到半像素时应算作下一段');
  assert.equal(findParagraphAtOffset(offsets, 177), 0, '差得多一些就仍属于上一段');
});

test('offset lookup stays consistent with restore', () => {
  // 恢复阅读位置 = 把第 i 段对齐到视口顶部 = scrollTop 取 offsets[i]；
  // 反查必须回到同一个 i，否则每次重开都会往前后漂一段。
  const heights = Float64Array.from([120, 340, 90, 210, 500]);
  const offsets = buildOffsetTable(heights, 78);
  for (let i = 0; i < heights.length; i += 1) {
    assert.equal(findParagraphAtOffset(offsets, offsets[i]), i, `第 ${i} 段反查应回到自身`);
  }
});

test('measured heights replace estimates without disturbing earlier paragraphs', () => {
  const estimates = Float64Array.from([100, 100, 100, 100]);
  const before = buildOffsetTable(estimates);
  // 只有第 2 段被实测替换（实际比估算高 40px）。
  const measured = Float64Array.from([100, 100, 140, 100]);
  const after = buildOffsetTable(measured);
  assert.equal(after[2], before[2], '改动点之前的段落偏移不变');
  assert.equal(after[3] - after[2], 140);
  assert.equal(before[3] - before[2], 100);
});
