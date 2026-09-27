import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLibraryStore } from '../electron/library-store.js';

test('library store persists JSON and recovers from a damaged primary file', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'novel-reader-'));
  try {
    const store = createLibraryStore(directory);
    const first = { version: 1, settings: { theme: 'warm' }, books: [] };
    await store.save(first);
    assert.deepEqual(JSON.parse(await readFile(store.filePath, 'utf8')), first);

    await store.save({ ...first, settings: { theme: 'night' } });
    await rm(store.filePath);
    const recovered = await store.load();
    assert.equal(recovered.settings.theme, 'warm');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
