import { GlobalWorkerOptions } from 'pdfjs-dist';
import PdfjsWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker&inline';
import { createInlineViewer } from './inlineViewer';
import type { InlineViewerHandle, PdfViewerHandle } from './types';

GlobalWorkerOptions.workerPort = new PdfjsWorker();

const ENHANCED_ATTR = 'data-gpv-enhanced';
const NAV_EVENT = 'gpv-navigate';
const SVG_NS = 'http://www.w3.org/2000/svg';
const ATTACHMENT_LINK_SELECTOR = 'a[href^="/attachment/"]';

interface EnhancedLink {
  link: HTMLAnchorElement;
  // Captured before the icon (which now embeds its own "PDF" text label) is
  // inserted into the link, so re-deriving the filename later never picks
  // up that label alongside the real text.
  title: string;
  // From a #page=N hash on the link, e.g. /attachment/xxx#page=5, so authors
  // can cite a specific page ("see page 5 of this doc") and have it open
  // straight there. null when absent/invalid.
  initialPage: number | null;
  icon: SVGSVGElement;
  toggleBtn: HTMLButtonElement;
  clickHandler: (event: MouseEvent) => void;
  viewer: InlineViewerHandle | null;
}

// link → enhancement state, so we can fully restore the original <a> on unmount
const enhancedLinks = new Map<HTMLAnchorElement, EnhancedLink>();

// ---- context guards ----

function isHiddenContext(): boolean {
  const { pathname, hash } = location;
  if (/^\/admin(\/|$)/.test(pathname)) return true;
  if (/[#/]edit$/.test(hash + pathname)) return true;
  const cl = document.body.classList;
  if (cl.contains('editing') || cl.contains('grw-editor-mode') || cl.contains('modal-open')) return true;
  return false;
}

function isInEditorDOM(el: Element): boolean {
  return el.closest('.CodeMirror, .cm-editor, [contenteditable="true"]') !== null;
}

// ---- icon ----

// Adapted from the well-known Wikimedia Commons "PDF icon.svg"
// (https://upload.wikimedia.org/wikipedia/commons/6/6c/PDF_icon.svg):
// a page silhouette with a folded top-right corner, banded by a red
// ribbon carrying the "PDF" label. The original renders that label as
// traced letter paths at a large native size; reproducing that path data
// isn't necessary (and wouldn't stay legible at our ~16px usage size), so
// the label is a plain <text> here — same visual language, far less
// markup. Page fill/stroke use theme variables (not fixed white) so the
// icon doesn't read as a stark white square against a dark background;
// the red band stays a fixed color since white-on-red needs no theming.
function createPdfIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('gpv-pdf-icon');

  const page = document.createElementNS(SVG_NS, 'path');
  page.setAttribute('d', 'M4 1h5l3 3v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1z');
  page.setAttribute('fill', 'var(--gpv-bg)');
  page.setAttribute('stroke', 'var(--gpv-border)');
  page.setAttribute('stroke-width', '1');
  svg.appendChild(page);

  const fold = document.createElementNS(SVG_NS, 'path');
  fold.setAttribute('d', 'M9 1v3h3z');
  fold.setAttribute('fill', 'var(--gpv-toolbar-bg)');
  fold.setAttribute('stroke', 'var(--gpv-border)');
  fold.setAttribute('stroke-width', '0.6');
  svg.appendChild(fold);

  const band = document.createElementNS(SVG_NS, 'rect');
  band.setAttribute('x', '2.3');
  band.setAttribute('y', '8.7');
  band.setAttribute('width', '11.4');
  band.setAttribute('height', '3.5');
  band.setAttribute('fill', 'var(--gpv-pdf-badge)');
  svg.appendChild(band);

  const label = document.createElementNS(SVG_NS, 'text');
  label.setAttribute('x', '8');
  label.setAttribute('y', '11.35');
  label.setAttribute('text-anchor', 'middle');
  label.setAttribute('font-family', 'Arial, Helvetica, sans-serif');
  label.setAttribute('font-size', '3.3');
  label.setAttribute('font-weight', '800');
  label.setAttribute('letter-spacing', '-0.1');
  label.setAttribute('fill', '#fff');
  label.textContent = 'PDF';
  svg.appendChild(label);

  return svg;
}

// ---- eligibility ----

function isEligibleLink(link: HTMLAnchorElement): boolean {
  if (link.hasAttribute(ENHANCED_ATTR)) return false;
  if (!/^\/attachment\//.test(link.getAttribute('href') ?? '')) return false;
  if (!/\.pdf$/i.test(link.textContent?.trim() ?? '')) return false;
  if (isInEditorDOM(link)) return false;
  return true;
}

// `link.hash` is resolved by the browser's URL parsing regardless of the
// href being relative, so this works for both /attachment/xxx#page=5 and
// full absolute URLs.
function parseInitialPage(link: HTMLAnchorElement): number | null {
  const match = link.hash.match(/^#page=(\d+)$/i);
  if (!match) return null;
  const page = Number(match[1]);
  return Number.isInteger(page) && page > 0 ? page : null;
}

// ---- enhance / restore ----

function setToggleLabel(toggleBtn: HTMLButtonElement, label: string): void {
  const labelEl = toggleBtn.querySelector('.gpv-toggle-label');
  if (labelEl) labelEl.textContent = label;
}

function closeViewer(state: EnhancedLink): void {
  if (!state.viewer) return;
  state.viewer.collapse();
  state.viewer = null;
  setToggleLabel(state.toggleBtn, 'View PDF');
  state.toggleBtn.setAttribute('aria-expanded', 'false');
}

function toggleViewer(state: EnhancedLink): void {
  if (state.viewer) {
    closeViewer(state);
    return;
  }

  // The viewer's own toolbar also has a close button (visible even after
  // scrolling past this toggle), so it needs a way to trigger the same
  // close path and keep this button's label/aria-expanded in sync.
  const viewer = createInlineViewer({
    url: state.link.href,
    title: state.title,
    anchorEl: state.toggleBtn,
    onRequestClose: () => closeViewer(state),
    initialPage: state.initialPage,
  });
  state.viewer = viewer;
  setToggleLabel(state.toggleBtn, 'Close PDF');
  state.toggleBtn.setAttribute('aria-expanded', 'true');
  void viewer.expand();
}

// The block-level element the link's text visually belongs to (its
// paragraph/list item/table cell/...), so the toggle button can be placed
// below that whole block instead of squeezed inline right after the link.
function findBlockContainer(link: HTMLAnchorElement): Element {
  return link.closest('p, li, td, th, dd, dt, blockquote') ?? link.parentElement ?? link;
}

function enhanceLink(link: HTMLAnchorElement): void {
  const title = link.textContent?.trim() ?? '';
  const initialPage = parseInitialPage(link);

  link.setAttribute(ENHANCED_ATTR, 'true');
  link.classList.add('gpv-pdf-link');

  const icon = createPdfIcon();
  link.insertBefore(icon, link.firstChild);

  const toggleBtn = document.createElement('button');
  toggleBtn.type = 'button';
  toggleBtn.className = 'gpv-toggle-btn';
  toggleBtn.setAttribute('aria-expanded', 'false');

  const toggleIcon = createPdfIcon();
  toggleIcon.classList.add('gpv-toggle-icon');
  toggleBtn.appendChild(toggleIcon);

  const toggleLabel = document.createElement('span');
  toggleLabel.className = 'gpv-toggle-label';
  toggleLabel.textContent = 'View PDF';
  toggleBtn.appendChild(toggleLabel);

  findBlockContainer(link).insertAdjacentElement('afterend', toggleBtn);

  const state: EnhancedLink = {
    link,
    title,
    initialPage,
    icon,
    toggleBtn,
    clickHandler: () => {},
    viewer: null,
  };

  const clickHandler = (event: MouseEvent): void => {
    event.preventDefault();
    toggleBtn.click();
  };
  state.clickHandler = clickHandler;
  link.addEventListener('click', clickHandler);

  toggleBtn.addEventListener('click', () => toggleViewer(state));

  enhancedLinks.set(link, state);
}

function restoreLink(state: EnhancedLink): void {
  if (state.viewer) {
    state.viewer.collapse();
    state.viewer = null;
  }
  state.link.removeEventListener('click', state.clickHandler);
  state.icon.remove();
  state.toggleBtn.remove();
  state.link.classList.remove('gpv-pdf-link');
  if (state.link.classList.length === 0) state.link.removeAttribute('class');
  state.link.removeAttribute(ENHANCED_ATTR);
}

function cleanupAll(): void {
  for (const state of enhancedLinks.values()) {
    restoreLink(state);
  }
  enhancedLinks.clear();
}

// ---- scanner ----

function scanAndTransform(root: ParentNode = document): void {
  if (isHiddenContext()) return;

  const links =
    root instanceof Element && root.matches(ATTACHMENT_LINK_SELECTOR)
      ? [root as HTMLAnchorElement, ...Array.from(root.querySelectorAll<HTMLAnchorElement>(ATTACHMENT_LINK_SELECTOR))]
      : Array.from(root.querySelectorAll<HTMLAnchorElement>(ATTACHMENT_LINK_SELECTOR));

  for (const link of links) {
    if (!isEligibleLink(link)) continue;
    enhanceLink(link);
  }
}

// ---- public API ----

export function createPdfViewer(): PdfViewerHandle {
  let observer: MutationObserver | null = null;
  let scanTimer: ReturnType<typeof setTimeout> | null = null;

  const origPushState = history.pushState.bind(history);
  const origReplaceState = history.replaceState.bind(history);

  let fullScanPending = false;
  const pendingScanRoots = new Set<ParentNode>();

  function scheduleScan(roots?: ParentNode[]): void {
    if (roots && roots.length > 0) {
      if (!fullScanPending) {
        for (const r of roots) pendingScanRoots.add(r);
      }
    } else {
      fullScanPending = true;
      pendingScanRoots.clear();
    }

    if (scanTimer !== null) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = null;
      if (fullScanPending) {
        scanAndTransform();
      } else {
        for (const root of pendingScanRoots) scanAndTransform(root);
      }
      fullScanPending = false;
      pendingScanRoots.clear();
    }, 0);
  }

  function onNavigate(): void {
    requestAnimationFrame(() => requestAnimationFrame(() => scheduleScan()));
  }

  function onBodyClassChange(): void {
    if (isHiddenContext()) {
      cleanupAll();
    } else {
      scheduleScan();
    }
  }

  function isPluginNode(el: Element): boolean {
    return el.closest('.gpv-pdf-link, .gpv-toggle-btn, .gpv-inline-viewer') !== null;
  }

  // Best-effort only: `beforeprint` doesn't let a script delay printing for
  // async work, and page rendering is async, so a print triggered the
  // instant a viewer opens can still catch some pages mid-render. This at
  // least covers the common case of printing after the page has been open
  // for a moment, and never makes things worse.
  function onBeforePrint(): void {
    for (const state of enhancedLinks.values()) {
      state.viewer?.prepareForPrint();
    }
  }

  return {
    mount(): void {
      history.pushState = function pushState(...args) {
        origPushState(...args);
        window.dispatchEvent(new Event(NAV_EVENT));
      };
      history.replaceState = function replaceState(...args) {
        origReplaceState(...args);
        window.dispatchEvent(new Event(NAV_EVENT));
      };

      window.addEventListener('popstate', onNavigate);
      window.addEventListener('hashchange', onNavigate);
      window.addEventListener(NAV_EVENT, onNavigate);
      window.addEventListener('beforeprint', onBeforePrint);

      observer = new MutationObserver((mutations) => {
        const scanRoots: Element[] = [];
        let bodyClassChanged = false;

        for (const mut of mutations) {
          if (mut.type === 'attributes' && mut.target === document.body) {
            bodyClassChanged = true;
            continue;
          }
          for (const node of mut.addedNodes) {
            if (!(node instanceof Element)) continue;
            if (isPluginNode(node)) continue;
            if (node.matches(ATTACHMENT_LINK_SELECTOR) || node.querySelector(ATTACHMENT_LINK_SELECTOR)) {
              scanRoots.push(node);
            }
          }
        }

        if (bodyClassChanged) onBodyClassChange();
        if (scanRoots.length > 0) scheduleScan(scanRoots);
      });

      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class'],
      });

      scanAndTransform();
    },

    unmount(): void {
      window.removeEventListener('popstate', onNavigate);
      window.removeEventListener('hashchange', onNavigate);
      window.removeEventListener(NAV_EVENT, onNavigate);
      window.removeEventListener('beforeprint', onBeforePrint);

      history.pushState = origPushState;
      history.replaceState = origReplaceState;

      observer?.disconnect();
      observer = null;

      if (scanTimer !== null) {
        clearTimeout(scanTimer);
        scanTimer = null;
      }

      cleanupAll();
    },
  };
}
