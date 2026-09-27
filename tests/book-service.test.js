import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeText, normalizeText, splitParagraphs, createFingerprint } from '../electron/book-service.js';

 test('decodes UTF-8 BOM and normalizes line endings', () => {
  const buffer = Buffer.from('﻿第一段\r\n\r\n第二段', 'utf8');
  const decoded = decodeText(buffer);
  assert.equal(decoded.encoding, 'utf-8');
  assert.equal(normalizeText(decoded.text), '第一段\n\n第二段');
});

test('falls back to GB18030 for common Chinese TXT content', () => {
  const buffer = Buffer.from([0xb5, 0xda, 0xd2, 0xbb, 0xd5, 0xc2, 0x0d, 0x0a, 0xc4, 0xda, 0xc8, 0xdd]);
  const decoded = decodeText(buffer);
  assert.equal(decoded.encoding, 'gb18030');
  assert.equal(decoded.text, '第一章\r\n内容');
});

test('splits paragraphs while preserving readable text and offsets', () => {
  assert.deepEqual(splitParagraphs('甲\n乙\n\n丙\n\n\n丁').map(({ text }) => text), ['甲乙', '丙', '丁']);
});

test('creates a stable short fingerprint', () => {
  const first = createFingerprint(Buffer.from('same'));
  const second = createFingerprint(Buffer.from('same'));
  assert.equal(first, second);
  assert.notEqual(first, createFingerprint(Buffer.from('different')));
});
