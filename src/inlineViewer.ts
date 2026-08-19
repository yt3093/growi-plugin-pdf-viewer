import { getDocument, TextLayer } from 'pdfjs-dist';
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import type { InlineViewerHandle, InlineViewerOptions } from './types';

const ZOOM_STEPS = [0.6, 0.8, 1.0, 1.25, 1.5, 2.0];
const DEFAULT_ZOOM_INDEX = 2;
const CURRENT_PAGE_THRESHOLD = 0.5;

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

export function createInlineViewer({ url, title, anchorEl }: InlineViewerOptions): InlineViewerHandle {
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
    jumpBtn.textContent = '移動';
    jumpBtn.addEventListener('click', () => jumpToPage(Number(pageInputEl?.value)));
    toolbar.appendChild(jumpBtn);

    zoomOutBtn = document.createElement('button');
    zoomOutBtn.type = 'button';
    zoomOutBtn.className = 'gpv-btn gpv-pdfjs-only';
    zoomOutBtn.textContent = '−';
    zoomOutBtn.setAttribute('aria-label', '縮小');
    zoomOutBtn.addEventListener('click', () => changeZoom(-1));
    toolbar.appendChild(zoomOutBtn);

    zoomIndicatorEl = document.createElement('span');
    zoomIndicatorEl.className = 'gpv-zoom-indicator gpv-pdfjs-only';
    toolbar.appendChild(zoomIndicatorEl);

    zoomInBtn = document.createElement('button');
    zoomInBtn.type = 'button';
    zoomInBtn.className = 'gpv-btn gpv-pdfjs-only';
    zoomInBtn.textContent = '+';
    zoomInBtn.setAttribute('aria-label', '拡大');
    zoomInBtn.addEventListener('click', () => changeZoom(1));
    toolbar.appendChild(zoomInBtn);

    const downloadLink = document.createElement('a');
    downloadLink.className = 'gpv-btn gpv-download-btn';
    downloadLink.textContent = 'ダウンロード';
    downloadLink.href = url;
    downloadLink.download = title || '';
    toolbar.appendChild(downloadLink);

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

    container?.remove();
    container = null;
  }

  return { expand, collapse };
}
