// 一次性设计工具：把 concepts/*.svg 栅格化成各尺寸 PNG。
//
// 为什么用 Electron：本机没有 ImageMagick（`convert` 是 Windows 自带的文件系统工具，
// 不是 ImageMagick），也没有 Inkscape / rsvg-convert，python 侧没有 Pillow。
// 项目本来就装了 Electron，复用它渲染可以做到零新增依赖。
//
// 为什么在渲染进程里用 Canvas 而不是 capturePage()：capturePage() 对 show:false 的
// 窗口会挂住不返回（实测渲染到第 5 个尺寸就停住）。Canvas 的 drawImage 是确定性的，
// 一次调用拿到精确像素，也顺带解决了窗口尺寸受屏幕缩放影响的问题。
//
// 用法：npx electron design/app-icon/tools/render.mjs
import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..'); // design/app-icon

// 概念稿与定稿一起渲染。定稿的 PNG 写到 final/png/，ICO 由 build-ico.mjs 从那里打包。
const SOURCES = [
  { svgDir: path.join(ROOT, 'concepts'), pngDir: path.join(ROOT, 'png') },
  { svgDir: path.join(ROOT, 'final'), pngDir: path.join(ROOT, 'final', 'png') },
];

const SIZES = [16, 24, 32, 48, 64, 128, 256];
const SS = 4; // 超采样倍数：先画 4 倍大再降采样，小尺寸边缘更干净

// 渲染只是画图，不要把 Chromium 的 profile 写进应用的数据目录
app.setPath('userData', path.join(os.tmpdir(), 'novel-reader-icon-render'));

const WORKER = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
  // 在页面里把 SVG 画到 canvas 上，返回 PNG 的 base64（不含 data: 前缀）
  window.rasterize = async function (svgText, targets) {
    const src = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svgText)));
    const img = new Image();
    img.src = src;
    await img.decode();
    const out = {};
    for (const size of targets) {
      const big = document.createElement('canvas');
      big.width = big.height = size * ${SS};
      const bctx = big.getContext('2d');
      bctx.imageSmoothingEnabled = true;
      bctx.imageSmoothingQuality = 'high';
      bctx.drawImage(img, 0, 0, big.width, big.height);

      const small = document.createElement('canvas');
      small.width = small.height = size;
      const sctx = small.getContext('2d');
      sctx.imageSmoothingEnabled = true;
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(big, 0, 0, size, size);

      out[size] = small.toDataURL('image/png').split(',')[1];
    }
    return out;
  };
</script></body></html>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 400, height: 300 });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(WORKER));

  for (const { svgDir, pngDir } of SOURCES) {
    const files = readdirSync(svgDir).filter((f) => f.endsWith('.svg'));
    if (files.length === 0) throw new Error(`${svgDir} 下没有 .svg`);
    mkdirSync(pngDir, { recursive: true });

    for (const file of files) {
      const name = path.basename(file, '.svg');
      const outDir = path.join(pngDir, name);
      mkdirSync(outDir, { recursive: true });
      const svgSource = readFileSync(path.join(svgDir, file), 'utf8');

      const encoded = await win.webContents.executeJavaScript(
        `window.rasterize(${JSON.stringify(svgSource)}, ${JSON.stringify(SIZES)})`,
      );

      const report = [];
      for (const size of SIZES) {
        const buf = Buffer.from(encoded[size], 'base64');
        writeFileSync(path.join(outDir, `${size}.png`), buf);
        report.push(`${size}:${buf.length}B`);
      }
      console.log(`[ok] ${path.relative(ROOT, outDir)} -> ${report.join(' ')}`);
    }
  }

  console.log('渲染完成：' + ROOT);
  win.destroy();
  app.quit();
});
