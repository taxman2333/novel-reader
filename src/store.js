export const DEFAULT_SETTINGS = Object.freeze({
  fontSize: 18,
  lineHeight: 1.9,
  paragraphSpacing: 0.9,
  contentWidth: 720,
  fontFamily: 'serif',
  theme: 'warm',
  indent: true,
});

export const THEMES = Object.freeze({
  white: '日间白色',
  warm: '日间暖色',
  green: '日间浅绿色',
  night: '夜间深灰',
});

export function normalizeSettings(settings = {}) {
  const merged = { ...DEFAULT_SETTINGS, ...settings };
  return {
    fontSize: clamp(Number(merged.fontSize), 14, 32),
    lineHeight: clamp(Number(merged.lineHeight), 1.4, 2.6),
    paragraphSpacing: clamp(Number(merged.paragraphSpacing), 0, 2),
    contentWidth: clamp(Number(merged.contentWidth), 560, 920),
    fontFamily: ['serif', 'sans'].includes(merged.fontFamily) ? merged.fontFamily : 'serif',
    theme: Object.hasOwn(THEMES, merged.theme) ? merged.theme : DEFAULT_SETTINGS.theme,
    indent: Boolean(merged.indent),
  };
}

export function resolveBookSettings(globalSettings, bookSettings) {
  return normalizeSettings({ ...globalSettings, ...bookSettings });
}

export function createBookRecord(file, content, now = new Date().toISOString()) {
  return {
    id: file.path,
    path: file.path,
    name: file.name.replace(/\.txt$/i, ''),
    fileName: file.name,
    size: file.size,
    modifiedAt: file.modifiedAt,
    fingerprint: file.fingerprint,
    encoding: file.encoding,
    importedAt: now,
    lastOpenedAt: now,
    unavailable: false,
    progress: {
      paragraphIndex: 0,
      charOffset: 0,
      ratio: 0,
      context: '',
      updatedAt: now,
    },
    settings: null,
  };
}

export function normalizeLibrary(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { version: 1, settings: normalizeSettings(), books: [] };
  }
  const books = Array.isArray(data.books)
    ? data.books.filter((book) => book && typeof book.path === 'string' && typeof book.name === 'string')
      .map((book) => ({
        ...book,
        id: book.id || book.path,
        progress: normalizeProgress(book.progress),
        settings: book.settings ? normalizeSettings(book.settings) : null,
        unavailable: Boolean(book.unavailable),
      }))
    : [];
  return { version: 1, settings: normalizeSettings(data.settings), books };
}

export function normalizeProgress(progress = {}) {
  return {
    paragraphIndex: Math.max(0, Math.floor(Number(progress.paragraphIndex) || 0)),
    charOffset: Math.max(0, Math.floor(Number(progress.charOffset) || 0)),
    ratio: clamp(Number(progress.ratio) || 0, 0, 1),
    context: typeof progress.context === 'string' ? progress.context.slice(0, 240) : '',
    updatedAt: progress.updatedAt || new Date().toISOString(),
  };
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
