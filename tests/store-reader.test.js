import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, normalizeLibrary, normalizeProgress, normalizeSettings, resolveBookSettings } from '../src/store.js';
import { findRestoreIndex } from '../src/reader.js';

test('normalizes out-of-range reading settings', () => {
  const settings = normalizeSettings({ fontSize: 100, lineHeight: 0, theme: 'unknown' });
  assert.equal(settings.fontSize, 32);
  assert.equal(settings.lineHeight, 1.4);
  assert.equal(settings.theme, DEFAULT_SETTINGS.theme);
});

test('book settings override global settings without losing defaults', () => {
  const settings = resolveBookSettings({ ...DEFAULT_SETTINGS, fontSize: 20 }, { theme: 'night' });
  assert.equal(settings.fontSize, 20);
  assert.equal(settings.theme, 'night');
  assert.equal(settings.indent, true);
});

test('normalizes library records and progress', () => {
  const library = normalizeLibrary({ settings: { fontSize: 16 }, books: [{ path: 'x.txt', name: 'X', progress: { ratio: 2 } }] });
  assert.equal(library.version, 1);
  assert.equal(library.books[0].id, 'x.txt');
  assert.equal(library.books[0].progress.ratio, 1);
});

test('restores from nearby text context before index', () => {
  const paragraphs = [{ text: '开头' }, { text: '目标段落内容' }, { text: '结尾' }];
  assert.equal(findRestoreIndex(paragraphs, { paragraphIndex: 0, context: '目标段落' }), 1);
});

test('falls back to bounded paragraph index', () => {
  const paragraphs = [{ text: '一' }, { text: '二' }];
  assert.equal(findRestoreIndex(paragraphs, { paragraphIndex: 99 }), 1);
  assert.equal(findRestoreIndex(paragraphs, { paragraphIndex: -1 }), 0);
});

test('per-book settings survive a save and reload', () => {
  const saved = {
    settings: { fontSize: 20 },
    books: [{ path: 'a.txt', name: 'A', settings: { fontSize: 28, theme: 'night' } }],
  };
  const reloaded = normalizeLibrary(JSON.parse(JSON.stringify(saved)));
  assert.equal(reloaded.books[0].settings.fontSize, 28);
  assert.equal(reloaded.books[0].settings.theme, 'night');
});

test('normalizeLibrary rebuilds book objects, so saves must not re-normalize', () => {
  // persistLibrary() in the renderer relies on this being NOT done on every save:
  // the active book must stay the same object as library.books[i], otherwise
  // settings and reading progress written to it never reach disk.
  const library = { settings: {}, books: [{ path: 'a.txt', name: 'A', settings: { fontSize: 26 } }] };
  const normalized = normalizeLibrary(library);
  assert.notEqual(normalized.books[0], library.books[0]);
  assert.equal(normalized.books[0].settings.fontSize, 26);
});
