import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const ENCODINGS = [
  { name: 'utf-8', label: 'UTF-8' },
  { name: 'gb18030', label: 'GB18030' },
];

export async function inspectFile(filePath) {
  const stats = await fs.stat(filePath);
  if (!stats.isFile()) throw new Error('选择的路径不是文件。');
  if (path.extname(filePath).toLowerCase() !== '.txt') throw new Error('目前只支持 .txt 文件。');
  return {
    path: filePath,
    name: path.basename(filePath),
    size: stats.size,
    modifiedAt: stats.mtime.toISOString(),
  };
}

export async function readTxtFile(filePath) {
  const file = await inspectFile(filePath);
  const buffer = await fs.readFile(filePath);
  const { text, encoding } = decodeText(buffer);
  if (!text.trim()) throw new Error('这个 TXT 文件没有可阅读的内容。');
  return {
    ...file,
    text: normalizeText(text),
    encoding,
    fingerprint: createHash('sha256').update(buffer).digest('hex').slice(0, 24),
  };
}

export function decodeText(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: new TextDecoder('utf-16le').decode(buffer), encoding: 'utf-16le' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(buffer), encoding: 'utf-8' };
  }
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  const replacementCount = (utf8.match(/�/g) || []).length;
  if (replacementCount === 0) return { text: utf8, encoding: 'utf-8' };
  return { text: new TextDecoder('gb18030').decode(buffer), encoding: 'gb18030' };
}

export function normalizeText(text) {
  return text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim();
}

export function splitParagraphs(text) {
  const normalized = normalizeText(text);
  const paragraphs = [];
  let cursor = 0;
  for (const rawParagraph of normalized.split(/\n\s*\n+/)) {
    const paragraph = rawParagraph.replace(/\n+/g, '').trim();
    if (!paragraph) continue;
    const charOffset = normalized.indexOf(rawParagraph, cursor);
    paragraphs.push({ text: paragraph, charOffset: Math.max(0, charOffset) });
    cursor = Math.max(cursor, charOffset + rawParagraph.length);
  }
  return paragraphs;
}

export async function fileStillMatches(book) {
  try {
    const stats = await fs.stat(book.path);
    const available = stats.isFile() && path.extname(book.path).toLowerCase() === '.txt';
    return {
      path: book.path,
      size: stats.size,
      modifiedAt: stats.mtime.toISOString(),
      matches: available && stats.size === book.size && stats.mtime.toISOString() === book.modifiedAt,
      changed: available && (stats.size !== book.size || stats.mtime.toISOString() !== book.modifiedAt),
      unavailable: !available,
    };
  } catch {
    return { path: book.path, unavailable: true, matches: false, changed: false };
  }
}

export function createFingerprint(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 24);
}

export { ENCODINGS };
