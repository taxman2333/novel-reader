export function parseParagraphs(text) {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized) return [];
  const paragraphs = [];
  let cursor = 0;
  for (const rawParagraph of normalized.split(/\n\s*\n+/)) {
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
