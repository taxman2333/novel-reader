// 一次性设计工具：把三个概念稿与定稿拼成一张对比图。
// 每个图标排两行 —— 浅色底与深色底 —— 用来确认在 Windows 两种背景下都立得住。
//
// 用法：node design/app-icon/tools/contact-sheet.mjs   （需先跑 tools/render.mjs）
import { app, BrowserWindow } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'preview', 'contact-sheet.png');

const SIZES = [256, 128, 64, 48, 32, 24, 16];

const PANELS = [
  { title: '方案 A · 极简书脊型', dir: path.join(ROOT, 'png', 'a-spine') },
  { title: '方案 B · 打开的书型 ★ 采用', dir: path.join(ROOT, 'png', 'b-open') },
  { title: '方案 C · 书签型', dir: path.join(ROOT, 'png', 'c-ribbon') },
  { title: '定稿 icon.svg', dir: path.join(ROOT, 'final', 'png', 'icon') },
];

app.setPath('userData', path.join(os.tmpdir(), 'novel-reader-icon-render'));

const payload = PANELS.map((p) => ({
  title: p.title,
  images: Object.fromEntries(
    SIZES.map((s) => [s, readFileSync(path.join(p.dir, `${s}.png`)).toString('base64')]),
  ),
}));

const PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
window.sheet = async function (panels, sizes) {
  const PAD = 32, GAP = 26, STRIP = 256 + 44, LABEL = 34, PANEL_GAP = 30;
  const rowW = sizes.reduce((a, s, i) => a + s + (i ? GAP : 0), 0);
  const W = PAD * 2 + rowW;
  const H = PAD * 2 + panels.length * (LABEL + STRIP * 2 + PANEL_GAP);

  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#dedcd7';
  ctx.fillRect(0, 0, W, H);

  const load = (b64) => new Promise((res) => {
    const im = new Image();
    im.onload = () => res(im);
    im.src = 'data:image/png;base64,' + b64;
  });

  ctx.font = '600 17px "Segoe UI","Microsoft YaHei",sans-serif';
  ctx.textBaseline = 'middle';

  let y = PAD;
  for (const panel of panels) {
    ctx.fillStyle = '#2f332f';
    ctx.fillText(panel.title, PAD, y + LABEL / 2);
    y += LABEL;

    // 每行一条：先浅色底再深色底，图标底部对齐，方便比较小尺寸的可读性
    for (const bg of ['#ffffff', '#2b2d2b']) {
      ctx.fillStyle = bg;
      ctx.fillRect(PAD, y, rowW, STRIP);
      let x = PAD;
      for (const s of sizes) {
        const im = await load(panel.images[s]);
        ctx.drawImage(im, x, y + (STRIP - s) / 2, s, s);
        x += s + GAP;
      }
      y += STRIP;
    }
    y += PANEL_GAP;
  }

  return cv.toDataURL('image/png').split(',')[1];
};
</script></body></html>`;

app.whenReady().then(async () => {
  mkdirSync(path.dirname(OUT), { recursive: true });
  const win = new BrowserWindow({ show: false, width: 400, height: 300 });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
  const b64 = await win.webContents.executeJavaScript(
    `window.sheet(${JSON.stringify(payload)}, ${JSON.stringify(SIZES)})`,
  );
  const buf = Buffer.from(b64, 'base64');
  writeFileSync(OUT, buf);
  console.log(`[ok] ${OUT}  ${buf.length} 字节`);
  win.destroy();
  app.quit();
});
