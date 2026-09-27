import { promises as fs } from 'node:fs';
import path from 'node:path';

export function createLibraryStore(userDataPath) {
  const filePath = path.join(userDataPath, 'library.json');
  const backupPath = `${filePath}.bak`;

  return {
    async load() {
      try {
        return JSON.parse(await fs.readFile(filePath, 'utf8'));
      } catch {
        try {
          return JSON.parse(await fs.readFile(backupPath, 'utf8'));
        } catch {
          return null;
        }
      }
    },
    async save(data) {
      await fs.mkdir(userDataPath, { recursive: true });
      const temporaryPath = `${filePath}.tmp`;
      await fs.writeFile(temporaryPath, JSON.stringify(data, null, 2), 'utf8');
      try {
        await fs.copyFile(filePath, backupPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      await fs.rename(temporaryPath, filePath);
      return data;
    },
    filePath,
  };
}
