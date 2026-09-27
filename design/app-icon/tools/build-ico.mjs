// 一次性设计工具：把 final/png/ 下各尺寸 PNG 打包成 Windows 多尺寸 .ico。
//
// 纯 Node 实现，不引入依赖。ICO 用的是 Vista 之后支持的「PNG 内嵌」写法：
// 每个目录项直接指向一段完整的 PNG 数据，不做 BMP/DIB 转换。
// Windows 10 的 shell 对各尺寸的 PNG 项都能正常渲染。
//
// 用法：node design/app-icon/tools/build-ico.mjs
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FINAL_DIR = path.resolve(__dirname, '..', 'final');
// render.mjs 按 SVG 文件名建子目录，定稿是 final/icon.svg，所以落在 final/png/icon/
const PNG_DIR = path.join(FINAL_DIR, 'png', 'icon');
const OUT = path.join(FINAL_DIR, 'icon.ico');

// ICO 目录里每个尺寸一项；256 以 0 表示（字段只有一个字节）
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const images = SIZES.map((size) => {
  const file = path.join(PNG_DIR, `${size}.png`);
  if (!existsSync(file)) throw new Error(`缺少 ${file}，先跑 tools/render.mjs`);
  const data = readFileSync(file);
  // PNG magic，顺便确认拿到的确实是 PNG 而不是空文件
  if (data.length < 8 || data.readUInt32BE(0) !== 0x89504e47) {
    throw new Error(`${file} 不是合法 PNG`);
  }
  return { size, data };
});

const HEADER = 6;
const ENTRY = 16;

const header = Buffer.alloc(HEADER);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: 1 = icon
header.writeUInt16LE(images.length, 4);

let offset = HEADER + ENTRY * images.length;
const entries = [];
for (const { size, data } of images) {
  const e = Buffer.alloc(ENTRY);
  e.writeUInt8(size >= 256 ? 0 : size, 0); // width，256 记作 0
  e.writeUInt8(size >= 256 ? 0 : size, 1); // height，同上
  e.writeUInt8(0, 2); // 调色板颜色数，真彩色填 0
  e.writeUInt8(0, 3); // reserved
  e.writeUInt16LE(1, 4); // color planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(data.length, 8); // 该图像字节数
  e.writeUInt32LE(offset, 12); // 该图像在文件中的偏移
  entries.push(e);
  offset += data.length;
}

const ico = Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
writeFileSync(OUT, ico);

// 回读校验：把刚写出的文件按 ICO 结构重新解析一遍，确认目录项与实际数据对得上
const check = readFileSync(OUT);
const count = check.readUInt16LE(4);
const listed = [];
for (let i = 0; i < count; i += 1) {
  const base = HEADER + i * ENTRY;
  const w = check.readUInt8(base) || 256;
  const bytes = check.readUInt32LE(base + 8);
  const at = check.readUInt32LE(base + 12);
  const isPng = check.readUInt32BE(at) === 0x89504e47;
  if (!isPng) throw new Error(`第 ${i} 项偏移 ${at} 处不是 PNG`);
  if (at + bytes > check.length) throw new Error(`第 ${i} 项数据越界`);
  listed.push(`${w}(${bytes}B)`);
}

console.log(`[ok] ${path.basename(OUT)}  ${check.length} 字节`);
console.log(`     目录 ${count} 项：${listed.join(' ')}`);
