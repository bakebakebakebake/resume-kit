/**
 * 排版尺寸探针。
 *
 * .sheet 是固定高度 + overflow:hidden，内容超了会被静默裁掉 —— 屏幕上看不出来，
 * PDF 里也不会多一页，只是最后几行凭空消失。所以要主动量。
 *
 * 只比 scrollHeight 和 clientHeight 不够用：那个差值把"内容真被裁了"和
 * "内容压进了底部留白但一个字没丢"混成同一个数，实测正常排版下也能超 0.5mm，
 * 天天误报就没人看了。所以这里量到最深那个元素的底边，分成两个结论：
 *
 *   clipMm   > 0  纸面外了，真丢字，必须改
 *   intoPadMm> 0  压进了底部留白，没丢字，但页脚变紧，值得知道
 *
 * 另外中日韩字体体积大、加载晚，必须等 document.fonts.ready 之后再量，
 * 否则量到的是 fallback 字体的行高，结论不可信。
 *
 * 结果写两处：window.__resumeFit 给 devtools 看，
 * <body data-fit> 给 headless Chrome 的 --dump-dom 抓。
 */
(() => {
  const PX_PER_MM = 96 / 25.4;
  const mm = (px) => +(px / PX_PER_MM).toFixed(1);

  function measure() {
    const sheet = document.querySelector('.sheet');
    if (!sheet) return null;

    const box = sheet.getBoundingClientRect();
    const padBottom = parseFloat(getComputedStyle(sheet).paddingBottom) || 0;
    // 正常情况下内容不该越过这条线
    const contentLimit = box.bottom - padBottom;

    let deepest = box.top;
    let culprit = null;
    for (const el of sheet.querySelectorAll('*')) {
      const r = el.getBoundingClientRect();
      if (r.height === 0 && r.width === 0) continue; // 空容器不算
      if (r.bottom > deepest) {
        deepest = r.bottom;
        culprit = el;
      }
    }

    const clipPx = deepest - box.bottom;
    const intoPadPx = deepest - contentLimit;

    return {
      // 纸面外：真丢内容
      clipMm: mm(clipPx),
      clipped: clipPx > 0.5,
      // 压进底部留白：没丢内容，但排版偏紧
      intoPadMm: mm(intoPadPx),
      tight: intoPadPx > 0.5,
      // 还剩多少可用高度（负数 = 已经超了）
      freeMm: mm(contentLimit - deepest),
      // 最靠底的元素，方便定位是哪一段撑爆的
      last: culprit
        ? `${culprit.tagName.toLowerCase()}${culprit.className ? '.' + String(culprit.className).trim().split(/\s+/).join('.') : ''}`
        : null,
      // 备查：整体内容高 vs 纸张高
      contentMm: mm(sheet.scrollHeight),
      pageMm: mm(box.height),
    };
  }

  // 等字体，但不无限等：字体走 CDN 又断网时 fonts.ready 会挂很久，
  // 那种情况下也得把数量出来，只是标记一下"字体没就位，数字仅供参考"。
  let fontsReady = false;
  const ready = document.fonts
    ? Promise.race([
        document.fonts.ready.then(() => (fontsReady = true)),
        new Promise((r) => setTimeout(r, 5000)),
      ])
    : Promise.resolve();

  /** 量一次并发布结果。工作台每次改动后都会调，所以不能只在 load 时跑。 */
  function publish(quiet) {
    const fit = measure();
    if (!fit) return null;
    fit.fontsReady = fontsReady;
    window.__resumeFit = fit;
    document.body.dataset.fit = JSON.stringify(fit);
    document.documentElement.classList.toggle('is-overflowing', fit.clipped);

    if (quiet) return fit;
    if (!fontsReady) {
      console.warn('[resume-kit] 字体没加载完就量了，尺寸不准；跑 `npm run fonts` 把字体本地化');
    }
    if (fit.clipped) {
      console.warn(`[resume-kit] 内容超出纸面 ${fit.clipMm}mm，末尾会被裁掉（最底部：${fit.last}）`);
    } else if (fit.tight) {
      console.warn(`[resume-kit] 内容压进底部留白 ${fit.intoPadMm}mm，没丢内容但页脚偏紧`);
    } else {
      console.info(`[resume-kit] 还剩 ${fit.freeMm}mm 可用`);
    }
    return fit;
  }

  // 工作台按需重量用的入口。加个 fontsReady 的 promise 出去，
  // 免得外面刚 srcdoc 完就量到 fallback 字体的高度。
  window.__measureFit = () => publish(true);
  window.__fitReady = ready;

  ready.then(() => requestAnimationFrame(() => publish(false)));
})();
