import { getDocument, TextLayer } from 'pdfjs-dist';
import type { OnProgressParameters, PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import type { InlineViewerHandle, InlineViewerOptions } from './types';

const ZOOM_STEPS = [0.6, 0.8, 1.0, 1.25, 1.5, 2.0];
const DEFAULT_ZOOM_INDEX = 2;
const CURRENT_PAGE_THRESHOLD = 0.5;
const SVG_NS = 'http://www.w3.org/2000/svg';
// How close a page needs to be before it's (re-)rendered.
const RENDER_ROOT_MARGIN_PX = 400;
// How far a page needs to be before its canvas/text-layer are torn down to
// free memory (deliberately much larger than the render margin — see the
// comment on the unload observer for why a single shared margin doesn't
// work).
const UNLOAD_ROOT_MARGIN_PX = 3000;
// Matches .gpv-inline-viewer's opacity/transform transition duration; used
// as a fallback removal timer in case transitionend doesn't fire.
const CLOSE_TRANSITION_MS = 260;

// ---- toolbar icons ----
// Small stroke-based icons (shared visual language: 16x16, currentColor,
// round joins) so the toolbar reads as icon-only instead of mixing symbols
// (−/+/✕) with Japanese labels.

interface IconShape {
  d?: string;
  cx?: number;
  cy?: number;
  r?: number;
}

function createStrokeIcon(shapes: IconShape[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.4');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');

  for (const shape of shapes) {
    if (shape.d) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', shape.d);
      svg.appendChild(path);
    } else if (shape.cx !== undefined && shape.cy !== undefined && shape.r !== undefined) {
      const circle = document.createElementNS(SVG_NS, 'circle');
      circle.setAttribute('cx', String(shape.cx));
      circle.setAttribute('cy', String(shape.cy));
      circle.setAttribute('r', String(shape.r));
      svg.appendChild(circle);
    }
  }
  return svg;
}

function createJumpIcon(): SVGSVGElement {
  return createStrokeIcon([{ d: 'M3 8h9M8 4l4 4-4 4' }]);
}

function createZoomOutIcon(): SVGSVGElement {
  return createStrokeIcon([{ cx: 6.5, cy: 6.5, r: 4.5 }, { d: 'M4.5 6.5h4M10 10l4 4' }]);
}

function createZoomInIcon(): SVGSVGElement {
  return createStrokeIcon([{ cx: 6.5, cy: 6.5, r: 4.5 }, { d: 'M6.5 4.5v4M4.5 6.5h4M10 10l4 4' }]);
}

function createDownloadIcon(): SVGSVGElement {
  return createStrokeIcon([{ d: 'M8 2v8m0 0l-3-3m3 3l3-3M3 13h10' }]);
}

function createCloseIcon(): SVGSVGElement {
  const svg = createStrokeIcon([{ d: 'M4 4l8 8M12 4l-8 8' }]);
  svg.setAttribute('stroke-width', '1.5');
  return svg;
}

function createToolbarSeparator(): HTMLSpanElement {
  const sep = document.createElement('span');
  sep.className = 'gpv-toolbar-sep gpv-pdfjs-only';
  sep.setAttribute('aria-hidden', 'true');
  return sep;
}

interface PageEntry {
  placeholder: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  textLayerEl: HTMLDivElement | null;
  renderTask: RenderTask | null;
  rendered: boolean;
}

function debounce(fn: () => void, wait: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(fn, wait);
  };
}

// Module-level (shared by every createInlineViewer() instance, not per
// instance): all viewers share one global PDFWorker (GlobalWorkerOptions
// .workerPort is set once in pdfViewer.ts), and calling getDocument() while
// a previous loadingTask's destroy() is still in flight throws "the worker
// is being destroyed" -- observed in practice when retrying a failed load,
// but the same race is reachable across two different viewer instances too
// (closing one PDF and immediately reopening it, or opening another PDF,
// before the close's destroy() has settled). Every destroy is queued here,
// and every new load waits for the queue to drain first, regardless of
// which viewer instance triggered which.
let workerTeardownChain: Promise<void> = Promise.resolve();

function destroyLoadingTaskAsync(task: PDFDocumentLoadingTask): void {
  workerTeardownChain = workerTeardownChain.then(() => task.destroy()).catch(() => {});
}

async function waitForPendingWorkerTeardown(): Promise<void> {
  await workerTeardownChain;
}

export function createInlineViewer({
  url,
  title,
  anchorEl,
  onRequestClose,
  initialPage,
}: InlineViewerOptions): InlineViewerHandle {
  let container: HTMLDivElement | null = null;
  let loadingTask: PDFDocumentLoadingTask | null = null;
  let pdfDoc: PDFDocumentProxy | null = null;
  let observer: IntersectionObserver | null = null;
  let unloadObserver: IntersectionObserver | null = null;
  let resizeHandler: (() => void) | null = null;
  let baseUnscaledWidth = 0;
  let baseUnscaledHeight = 0;
  let zoomIndex = DEFAULT_ZOOM_INDEX;
  // getDocument() failures are often indistinguishable from transient
  // network blips (fetch() surfaces CORS blocks and offline/DNS errors as
  // the same opaque error), so the first failure offers a retry instead of
  // immediately assuming it's unrecoverable; only a repeat failure falls
  // back to the iframe.
  let loadAttempts = 0;

  const pages = new Map<number, PageEntry>();

  let pageIndicatorEl: HTMLSpanElement | null = null;
  let pageInputEl: HTMLInputElement | null = null;
  let zoomIndicatorEl: HTMLSpanElement | null = null;
  let zoomOutBtn: HTMLButtonElement | null = null;
  let zoomInBtn: HTMLButtonElement | null = null;

  function currentScale(containerWidth: number): number {
    if (baseUnscaledWidth === 0) return 1;
    return (containerWidth / baseUnscaledWidth) * ZOOM_STEPS[zoomIndex];
  }

  function updatePageIndicator(current: number, total: number): void {
    if (pageIndicatorEl) pageIndicatorEl.textContent = `${current} / ${total}`;
  }

  function updateZoomIndicator(): void {
    if (zoomIndicatorEl) zoomIndicatorEl.textContent = `${Math.round(ZOOM_STEPS[zoomIndex] * 100)}%`;
    if (zoomOutBtn) zoomOutBtn.disabled = zoomIndex === 0;
    if (zoomInBtn) zoomInBtn.disabled = zoomIndex === ZOOM_STEPS.length - 1;
  }

  function buildToolbar(): HTMLDivElement {
    const toolbar = document.createElement('div');
    toolbar.className = 'gpv-toolbar';

    const titleEl = document.createElement('span');
    titleEl.className = 'gpv-title';
    titleEl.textContent = title;
    toolbar.appendChild(titleEl);

    pageIndicatorEl = document.createElement('span');
    pageIndicatorEl.className = 'gpv-page-indicator gpv-pdfjs-only';
    pageIndicatorEl.textContent = '- / -';
    toolbar.appendChild(pageIndicatorEl);

    pageInputEl = document.createElement('input');
    pageInputEl.type = 'number';
    pageInputEl.className = 'gpv-page-input gpv-pdfjs-only';
    pageInputEl.min = '1';
    pageInputEl.setAttribute('aria-label', 'ページ番号を指定して移動');
    pageInputEl.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      jumpToPage(Number(pageInputEl?.value));
    });
    toolbar.appendChild(pageInputEl);

    const jumpBtn = document.createElement('button');
    jumpBtn.type = 'button';
    jumpBtn.className = 'gpv-btn gpv-pdfjs-only';
    jumpBtn.title = '指定ページへ移動';
    jumpBtn.setAttribute('aria-label', '指定ページへ移動');
    jumpBtn.appendChild(createJumpIcon());
    jumpBtn.addEventListener('click', () => jumpToPage(Number(pageInputEl?.value)));
    toolbar.appendChild(jumpBtn);

    toolbar.appendChild(createToolbarSeparator());

    zoomOutBtn = document.createElement('button');
    zoomOutBtn.type = 'button';
    zoomOutBtn.className = 'gpv-btn gpv-pdfjs-only';
    zoomOutBtn.title = '縮小';
    zoomOutBtn.setAttribute('aria-label', '縮小');
    zoomOutBtn.appendChild(createZoomOutIcon());
    zoomOutBtn.addEventListener('click', () => changeZoom(-1));
    toolbar.appendChild(zoomOutBtn);

    zoomIndicatorEl = document.createElement('span');
    zoomIndicatorEl.className = 'gpv-zoom-indicator gpv-pdfjs-only';
    toolbar.appendChild(zoomIndicatorEl);

    zoomInBtn = document.createElement('button');
    zoomInBtn.type = 'button';
    zoomInBtn.className = 'gpv-btn gpv-pdfjs-only';
    zoomInBtn.title = '拡大';
    zoomInBtn.setAttribute('aria-label', '拡大');
    zoomInBtn.appendChild(createZoomInIcon());
    zoomInBtn.addEventListener('click', () => changeZoom(1));
    toolbar.appendChild(zoomInBtn);

    toolbar.appendChild(createToolbarSeparator());

    const downloadLink = document.createElement('a');
    downloadLink.className = 'gpv-btn gpv-download-btn';
    downloadLink.title = 'ダウンロード';
    downloadLink.setAttribute('aria-label', 'ダウンロード');
    downloadLink.href = url;
    downloadLink.download = title || '';
    downloadLink.appendChild(createDownloadIcon());
    toolbar.appendChild(downloadLink);

    // The toolbar is sticky, so this stays reachable even after scrolling
    // past the original toggle button that opened the viewer.
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'gpv-btn gpv-close-btn';
    closeBtn.title = 'PDFを閉じる';
    closeBtn.setAttribute('aria-label', 'PDFを閉じる');
    closeBtn.appendChild(createCloseIcon());
    closeBtn.addEventListener('click', () => onRequestClose());
    toolbar.appendChild(closeBtn);

    updateZoomIndicator();

    return toolbar;
  }

  function layoutPlaceholders(pagesEl: HTMLElement): void {
    const scale = currentScale(pagesEl.clientWidth);
    const height = baseUnscaledHeight * scale;
    pages.forEach((entry) => {
      entry.placeholder.style.height = `${height}px`;
    });
  }

  function createPageSpinner(): HTMLDivElement {
    // Shown whenever a page has no canvas yet (either never rendered, or
    // unloaded again after scrolling far away) so it doesn't read as a
    // blank/broken area while scrolling.
    const spinner = document.createElement('div');
    spinner.className = 'gpv-page-spinner';
    return spinner;
  }

  async function renderPage(pageNum: number): Promise<void> {
    const entry = pages.get(pageNum);
    if (!entry || !pdfDoc || !container) return;

    const pagesEl = container.querySelector('.gpv-pages');
    if (!(pagesEl instanceof HTMLElement)) return;
    const scale = currentScale(pagesEl.clientWidth);

    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale });

    if (entry.renderTask) {
      entry.renderTask.cancel();
    }
    if (!entry.canvas) {
      entry.canvas = document.createElement('canvas');
      entry.placeholder.textContent = '';
      entry.placeholder.appendChild(entry.canvas);
      entry.textLayerEl = document.createElement('div');
      entry.textLayerEl.className = 'gpv-text-layer';
      entry.placeholder.appendChild(entry.textLayerEl);
    }
    entry.canvas.width = viewport.width;
    entry.canvas.height = viewport.height;
    entry.placeholder.style.height = `${viewport.height}px`;

    const task = page.render({ canvas: entry.canvas, viewport });
    entry.renderTask = task;
    try {
      await task.promise;
      entry.rendered = true;
    } catch (err) {
      if (err instanceof Error && err.name === 'RenderingCancelledException') return;
      throw err;
    }

    if (entry.textLayerEl) {
      entry.textLayerEl.replaceChildren();
      entry.textLayerEl.style.width = `${viewport.width}px`;
      entry.textLayerEl.style.height = `${viewport.height}px`;
      const textLayer = new TextLayer({
        textContentSource: page.streamTextContent(),
        container: entry.textLayerEl,
        viewport,
      });
      await textLayer.render();
    }
  }

  function handleIntersect(entries: IntersectionObserverEntry[]): void {
    entries.forEach((intersectionEntry) => {
      const pageNum = Number((intersectionEntry.target as HTMLElement).dataset.gpvPage);
      if (!pageNum || !intersectionEntry.isIntersecting) return;

      const entry = pages.get(pageNum);
      if (entry && !entry.rendered) {
        void renderPage(pageNum);
      }
      if (pdfDoc && intersectionEntry.intersectionRatio >= CURRENT_PAGE_THRESHOLD) {
        updatePageIndicator(pageNum, pdfDoc.numPages);
      }
    });
  }

  // Frees a rendered page's canvas/text-layer once it's scrolled far away,
  // so opening a long document and reading through it doesn't accumulate
  // one full-resolution canvas per page for as long as the viewer stays
  // open (a 300-page document at default zoom is on the order of a
  // gigabyte of canvas backing store if nothing is ever freed). The
  // placeholder keeps its already-measured height, so nothing shifts; the
  // render observer keeps watching it and re-renders on its own the next
  // time it scrolls back into range, exactly like a page that was never
  // rendered in the first place.
  function unloadPage(pageNum: number): void {
    const entry = pages.get(pageNum);
    if (!entry || !entry.rendered) return;

    entry.renderTask?.cancel();
    entry.renderTask = null;
    entry.canvas?.remove();
    entry.canvas = null;
    entry.textLayerEl?.remove();
    entry.textLayerEl = null;
    entry.rendered = false;

    entry.placeholder.replaceChildren(createPageSpinner());
  }

  function handleUnloadIntersect(entries: IntersectionObserverEntry[]): void {
    entries.forEach((intersectionEntry) => {
      // Still within the (much larger) unload margin — leave it loaded.
      if (intersectionEntry.isIntersecting) return;
      const pageNum = Number((intersectionEntry.target as HTMLElement).dataset.gpvPage);
      if (!pageNum) return;
      unloadPage(pageNum);
    });
  }

  function jumpToPage(target: number, behavior: ScrollBehavior = 'smooth'): void {
    if (!pdfDoc || !Number.isFinite(target)) return;
    const clamped = Math.min(Math.max(Math.trunc(target), 1), pdfDoc.numPages);
    pages.get(clamped)?.placeholder.scrollIntoView({ behavior, block: 'start' });
  }

  function changeZoom(delta: number): void {
    const next = zoomIndex + delta;
    if (next < 0 || next >= ZOOM_STEPS.length || !container) return;
    zoomIndex = next;
    updateZoomIndicator();

    const pagesEl = container.querySelector('.gpv-pages');
    if (pagesEl instanceof HTMLElement) layoutPlaceholders(pagesEl);

    pages.forEach((entry, n) => {
      if (entry.rendered) void renderPage(n);
    });
  }

  // pdf.js reads the response body via fetch, which is blocked when the
  // storage backend (e.g. GCS/S3 redirect mode) doesn't send CORS headers
  // for the wiki origin. An <iframe> only needs the browser to *display*
  // the resource, which isn't subject to that restriction, so it still
  // works when the pdf.js fetch path doesn't.
  //
  // Before committing to the iframe, probe reachability with a *no-cors*
  // fetch. This was originally done by listening for the iframe's `load`
  // event with a timeout instead, but that doesn't work: `load` fires even
  // when the browser shows its own internal "can't reach this page" error
  // inside the iframe (there's essentially no reliable `error` event for
  // iframes), so it can't distinguish a real load from total
  // unreachability. A `mode: 'no-cors'` fetch can't be read (opaque
  // response, status always 0) but unlike a normal fetch it still tells us
  // whether *something* answered: it resolves as soon as any HTTP response
  // comes back — including a redirect chain like GCS's, and regardless of
  // status code — and only rejects on a genuine network-level failure (DNS,
  // connection refused, offline). That's the reachable/unreachable signal
  // the iframe events can't give us, without needing to read the body.
  async function showFallback(status: HTMLDivElement): Promise<void> {
    if (!container) return;

    let reachable = true;
    try {
      await fetch(url, { mode: 'no-cors' });
    } catch {
      reachable = false;
    }
    if (!container) return; // may have been collapsed while the probe ran

    status.remove();
    container.querySelectorAll<HTMLElement>('.gpv-pdfjs-only').forEach((el) => {
      el.style.display = 'none';
    });

    if (!reachable) {
      const failureNotice = document.createElement('div');
      failureNotice.className = 'gpv-fallback-notice';
      failureNotice.textContent = 'PDFを表示できませんでした。ダウンロードしてご確認ください。';
      container.appendChild(failureNotice);
      return;
    }

    const notice = document.createElement('div');
    notice.className = 'gpv-fallback-notice';
    notice.textContent =
      'この環境では簡易表示のみ利用できます（ズーム・ページ移動・テキスト選択は使用できません）。' +
      '表示されない場合は、ツールバーのダウンロードボタンからファイルを取得してください。';
    container.appendChild(notice);

    const iframe = document.createElement('iframe');
    iframe.className = 'gpv-fallback-iframe';
    iframe.title = title;
    iframe.src = url;
    container.appendChild(iframe);
  }

  async function attemptLoad(status: HTMLDivElement): Promise<void> {
    if (loadingTask) {
      destroyLoadingTaskAsync(loadingTask);
      loadingTask = null;
    }
    await waitForPendingWorkerTeardown();

    try {
      loadingTask = getDocument({ url });
      loadingTask.onProgress = ({ loaded, total }: OnProgressParameters) => {
        if (!total) {
          status.textContent = '読み込み中…';
          return;
        }
        const percent = Math.min(100, Math.round((loaded / total) * 100));
        status.textContent = `読み込み中… ${percent}%`;
      };
      pdfDoc = await loadingTask.promise;
      const firstPage = await pdfDoc.getPage(1);
      const unscaledViewport = firstPage.getViewport({ scale: 1 });
      baseUnscaledWidth = unscaledViewport.width;
      baseUnscaledHeight = unscaledViewport.height;

      status.remove();
      const pagesEl = document.createElement('div');
      pagesEl.className = 'gpv-pages';
      container?.appendChild(pagesEl);

      for (let n = 1; n <= pdfDoc.numPages; n += 1) {
        const placeholder = document.createElement('div');
        placeholder.className = 'gpv-page-placeholder';
        placeholder.dataset.gpvPage = String(n);
        placeholder.setAttribute('aria-label', `ページ ${n}`);
        placeholder.appendChild(createPageSpinner());
        pagesEl.appendChild(placeholder);
        pages.set(n, { placeholder, canvas: null, textLayerEl: null, renderTask: null, rendered: false });
      }

      layoutPlaceholders(pagesEl);
      const startPage = initialPage && initialPage <= pdfDoc.numPages ? initialPage : 1;
      updatePageIndicator(startPage, pdfDoc.numPages);

      observer = new IntersectionObserver(handleIntersect, {
        root: null,
        rootMargin: `${RENDER_ROOT_MARGIN_PX}px 0px`,
        threshold: [0, CURRENT_PAGE_THRESHOLD],
      });
      pages.forEach((entry) => observer?.observe(entry.placeholder));

      // Separate observer with a much larger margin (rather than reusing
      // the render observer's own "not intersecting" transitions): sharing
      // one margin for both render and unload would unload a page the
      // instant it left the 400px render zone, and scrolling back and
      // forth near that boundary would thrash render/unload/render on
      // every crossing. The large gap between the two margins is a dead
      // zone where scrolling doesn't trigger either action.
      unloadObserver = new IntersectionObserver(handleUnloadIntersect, {
        root: null,
        rootMargin: `${UNLOAD_ROOT_MARGIN_PX}px 0px`,
      });
      pages.forEach((entry) => unloadObserver?.observe(entry.placeholder));

      resizeHandler = debounce(() => {
        if (!container) return;
        const el = container.querySelector('.gpv-pages');
        if (!(el instanceof HTMLElement)) return;
        layoutPlaceholders(el);
        pages.forEach((entry, n) => {
          if (entry.rendered) void renderPage(n);
        });
      }, 200);
      window.addEventListener('resize', resizeHandler);

      // Instant rather than smooth: this runs as part of the initial open,
      // so animating the scroll here would fight the fade/slide-in
      // transition instead of just landing on the right page already.
      if (startPage !== 1) jumpToPage(startPage, 'auto');
    } catch {
      loadAttempts += 1;
      if (loadAttempts >= 2) {
        void showFallback(status);
      } else {
        // Retried silently rather than surfacing a "failed, click to
        // retry" prompt: on a host with a persistent block (e.g. GROWI
        // Cloud's CORS issue), every single open would otherwise show a
        // scary failure message before an extra click reaches the working
        // fallback. A transient blip is fixed without the user noticing
        // anything went wrong; a persistent failure just takes one extra
        // silent attempt before falling back.
        void attemptLoad(status);
      }
    }
  }

  async function expand(): Promise<void> {
    container = document.createElement('div');
    container.className = 'gpv-inline-viewer';
    container.appendChild(buildToolbar());

    const status = document.createElement('div');
    status.className = 'gpv-status';
    status.textContent = '読み込み中…';
    container.appendChild(status);

    anchorEl.insertAdjacentElement('afterend', container);

    // Added with the base (closed) class first so the initial frame paints
    // invisible/offset, then .gpv-open is added a couple of frames later to
    // actually trigger the CSS transition (adding it in the same tick risks
    // the browser coalescing both states into one, skipping the animation).
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        container?.classList.add('gpv-open');
      });
    });

    await attemptLoad(status);
  }

  function collapse(): void {
    observer?.disconnect();
    observer = null;
    unloadObserver?.disconnect();
    unloadObserver = null;

    if (resizeHandler) {
      window.removeEventListener('resize', resizeHandler);
      resizeHandler = null;
    }

    pages.forEach((entry) => entry.renderTask?.cancel());
    pages.clear();

    pdfDoc = null;
    if (loadingTask) destroyLoadingTaskAsync(loadingTask);
    loadingTask = null;

    if (container) {
      const el = container;
      el.classList.remove('gpv-open');
      // Whichever fires first wins; remove() on an already-detached node is
      // a no-op, so the redundant call is harmless.
      el.addEventListener('transitionend', () => el.remove(), { once: true });
      setTimeout(() => el.remove(), CLOSE_TRANSITION_MS);
    }
    container = null;
  }

  function prepareForPrint(): void {
    pages.forEach((entry, n) => {
      if (!entry.rendered) void renderPage(n);
    });
  }

  return { expand, collapse, prepareForPrint };
}
