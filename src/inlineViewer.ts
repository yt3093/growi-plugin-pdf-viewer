import { getDocument, TextLayer } from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import type { InlineViewerHandle, InlineViewerOptions } from './types';

const ZOOM_STEPS = [0.6, 0.8, 1.0, 1.25, 1.5, 2.0];
const DEFAULT_ZOOM_INDEX = 2;
const CURRENT_PAGE_THRESHOLD = 0.5;
const SVG_NS = 'http://www.w3.org/2000/svg';
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

export function createInlineViewer({ url, title, anchorEl, onRequestClose }: InlineViewerOptions): InlineViewerHandle {
  let container: HTMLDivElement | null = null;
  let loadingTask: PDFDocumentLoadingTask | null = null;
  let pdfDoc: PDFDocumentProxy | null = null;
  let observer: IntersectionObserver | null = null;
  let resizeHandler: (() => void) | null = null;
  let baseUnscaledWidth = 0;
  let baseUnscaledHeight = 0;
  let zoomIndex = DEFAULT_ZOOM_INDEX;

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

  function jumpToPage(target: number): void {
    if (!pdfDoc || !Number.isFinite(target)) return;
    const clamped = Math.min(Math.max(Math.trunc(target), 1), pdfDoc.numPages);
    pages.get(clamped)?.placeholder.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  function showFallback(status: HTMLDivElement): void {
    if (!container) return;
    status.remove();

    container.querySelectorAll<HTMLElement>('.gpv-pdfjs-only').forEach((el) => {
      el.style.display = 'none';
    });

    const notice = document.createElement('div');
    notice.className = 'gpv-fallback-notice';
    notice.textContent =
      'この環境では簡易表示のみ利用できます（ズーム・ページ移動・テキスト選択は使用できません）。';
    container.appendChild(notice);

    const iframe = document.createElement('iframe');
    iframe.className = 'gpv-fallback-iframe';
    iframe.src = url;
    iframe.title = title;
    container.appendChild(iframe);
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

    try {
      loadingTask = getDocument({ url });
      pdfDoc = await loadingTask.promise;
      const firstPage = await pdfDoc.getPage(1);
      const unscaledViewport = firstPage.getViewport({ scale: 1 });
      baseUnscaledWidth = unscaledViewport.width;
      baseUnscaledHeight = unscaledViewport.height;

      status.remove();
      const pagesEl = document.createElement('div');
      pagesEl.className = 'gpv-pages';
      container.appendChild(pagesEl);

      for (let n = 1; n <= pdfDoc.numPages; n += 1) {
        const placeholder = document.createElement('div');
        placeholder.className = 'gpv-page-placeholder';
        placeholder.dataset.gpvPage = String(n);
        placeholder.setAttribute('aria-label', `ページ ${n}`);
        // Shown until renderPage() clears it and inserts the canvas, so a
        // page waiting for IntersectionObserver to reach it doesn't read as
        // a blank/broken area while scrolling.
        const spinner = document.createElement('div');
        spinner.className = 'gpv-page-spinner';
        placeholder.appendChild(spinner);
        pagesEl.appendChild(placeholder);
        pages.set(n, { placeholder, canvas: null, textLayerEl: null, renderTask: null, rendered: false });
      }

      layoutPlaceholders(pagesEl);
      updatePageIndicator(1, pdfDoc.numPages);

      observer = new IntersectionObserver(handleIntersect, {
        root: null,
        rootMargin: '400px 0px',
        threshold: [0, CURRENT_PAGE_THRESHOLD],
      });
      pages.forEach((entry) => observer?.observe(entry.placeholder));

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
    } catch {
      showFallback(status);
    }
  }

  function collapse(): void {
    observer?.disconnect();
    observer = null;

    if (resizeHandler) {
      window.removeEventListener('resize', resizeHandler);
      resizeHandler = null;
    }

    pages.forEach((entry) => entry.renderTask?.cancel());
    pages.clear();

    pdfDoc = null;
    void loadingTask?.destroy();
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

  return { expand, collapse };
}
