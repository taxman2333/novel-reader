// 阅读页右侧的自绘滚动条。
//
// 为什么不用原生滚动条：整本小说在文档里是一比一铺开的，一本 600 万 px 的书，
// 滑块按比例只有 0.1px，浏览器只能按最小长度画一小截（实测约 10px）贴在轨道顶端。
// 于是拖动 1px 就跨过十屏，按到空白轨道还会朝按下的方向一直翻页——这条滚动条在长书上
// 根本抓不住，而且和窗口化无关：优化前整本物化成 DOM 时文档高 1130 万 px，比现在更长。
//
// 这里把它接管成「位置指示 + 粗调」：
//   · 滑块固定最短 24px，永远抓得住；
//   · 拖动按全书比例定位（文档是一比一的，scrollTop/max 就是全书进度）；
//   · 点空白轨道翻一屏（一比一，正好一屏正文），点滑块上方往上、下方往下。
// 滚轮、PageUp/Down、空格、Home/End 仍然走原生滚动，手感完全不变——这也是这里不
// 「压缩文档高度」的原因：压缩后 scrollTop 的 1px 要分摊几百 px 正文，滚轮一格得动
// 不到 1px 才等价，等于为了滚动条把滚轮一起废掉。

// 滑块最短长度。低于这个值指针抓不住（原生滚动条在这个尺度上就是这么失效的）。
const MIN_THUMB = 24;

export function createReaderScrollbar({ scroll, track, thumb, onJump = () => {} }) {
  let dragging = false;
  // 抓在滑块上的位置：拖动全程保持它不变，滑块才跟手，而不是跳到指针下面。
  let grabOffset = 0;
  // 上一帧写进样式的值。滚动事件一帧可以来好几次，滑块长度多数时候没变，
  // 没必要每次都写一遍样式（写 height 会触发一次布局）。
  let lastLength = -1;
  let lastOffset = -1;
  let lastHidden = null;

  const maxScroll = () => Math.max(0, scroll.scrollHeight - scroll.clientHeight);

  // 滑块长度按视口占全书的比例，再兜一个最小长度。轨道高度随窗口变化，每次现算。
  function geometry() {
    const trackHeight = track.clientHeight;
    const visible = scroll.scrollHeight > 0 ? scroll.clientHeight / scroll.scrollHeight : 1;
    const length = Math.min(trackHeight, Math.max(MIN_THUMB, Math.round(trackHeight * visible)));
    return { length, span: Math.max(0, trackHeight - length) };
  }

  // 位置与长度都从 scrollTop/scrollHeight 现算，不额外记账：拖动、滚轮、跳章节、
  // 窗口重建微调 scrollTop 之后，跟着重算一次就回到一致状态。
  function sync() {
    const max = maxScroll();
    const { length, span } = geometry();
    // 整本装得下视口（或没有内容）：没有可滚动的部分，整条滚动条都不该出现。
    const hidden = !max || !span;
    if (hidden !== lastHidden) {
      track.hidden = hidden;
      lastHidden = hidden;
    }
    if (hidden) return;
    const ratio = Math.min(1, Math.max(0, scroll.scrollTop / max));
    const offset = Math.round(span * ratio);
    if (length !== lastLength) {
      thumb.style.height = `${length}px`;
      lastLength = length;
    }
    if (offset !== lastOffset) {
      thumb.style.transform = `translateY(${offset}px)`;
      lastOffset = offset;
    }
    track.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  }

  // 按全书比例定位。写完立刻重建窗口（onJump）：滚动事件要等下一个任务才到，
  // 而窗口化渲染下那一帧还没有新位置的段落——与目录面板的进度滑条同一套做法。
  function jumpTo(ratio) {
    scroll.scrollTop = Math.min(1, Math.max(0, ratio)) * maxScroll();
    onJump();
    sync();
  }

  // 翻一屏。文档是一比一的，一屏正文正好是一个视口高度，所以这里不需要换算。
  function pageBy(direction) {
    scroll.scrollTop = Math.min(maxScroll(), Math.max(0, scroll.scrollTop + direction * scroll.clientHeight));
    onJump();
    sync();
  }

  function onPointerMove(event) {
    const { span } = geometry();
    const trackTop = track.getBoundingClientRect().top;
    const offset = Math.min(span, Math.max(0, event.clientY - trackTop - grabOffset));
    if (span) jumpTo(offset / span);
  }

  function stopDragging() {
    if (!dragging) return;
    dragging = false;
    track.classList.remove('is-dragging');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', stopDragging);
    window.removeEventListener('pointercancel', stopDragging);
    window.removeEventListener('blur', stopDragging);
  }

  // 用过滚动条之后键盘翻页还应该有用：滚动区是 tabindex=0 的滚动容器，
  // 焦点不在它上面时 PageDown/空格是不起作用的。所以这里把焦点交给滚动区。
  //
  // 代价是 Chromium 把程序化聚焦也算作「键盘焦点」（实测：即使刚发生过真实鼠标点击，
  // focus() 之后 :focus-visible 依旧成立），默认轮廓会把整块正文框起来。
  // 因此指针路径挂一个类压掉轮廓，用户一旦按键盘就摘掉——键盘焦点仍要有可见轮廓。
  function focusReader() {
    scroll.classList.add('is-pointer-focus');
    window.addEventListener('keydown', () => scroll.classList.remove('is-pointer-focus'), { once: true, capture: true });
    scroll.focus({ preventScroll: true });
  }

  // 用 window 上的 pointermove/pointerup 而不是 setPointerCapture 跟踪拖动：
  // 指针拖到正文上、拖出轨道都还要继续跟。
  function onPointerDown(event) {
    if (event.button !== 0 || track.hidden) return;
    event.preventDefault();
    focusReader();
    if (event.target !== thumb) {
      pageBy(event.clientY < thumb.getBoundingClientRect().top ? -1 : 1);
      return;
    }
    dragging = true;
    grabOffset = event.clientY - thumb.getBoundingClientRect().top;
    track.classList.add('is-dragging');
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', stopDragging);
    window.addEventListener('pointercancel', stopDragging);
    // 拖到窗口外松手时收不到 pointerup，窗口失焦兜住它，否则会一直跟着指针。
    window.addEventListener('blur', stopDragging);
  }

  // 轨道压在正文右侧那一条上，滚轮落在这里也得滚正文，否则右边会有一条死区。
  // 这里不调 onJump：一个滚轮格只挪几段，原生 scroll 事件那条路径会照常重建窗口。
  function onWheel(event) {
    event.preventDefault();
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroll.clientHeight : 1;
    scroll.scrollTop = Math.min(maxScroll(), Math.max(0, scroll.scrollTop + event.deltaY * unit));
    sync();
  }

  track.addEventListener('pointerdown', onPointerDown);
  track.addEventListener('wheel', onWheel, { passive: false });

  return { sync };
}
