declare global {
  interface Window {
    pluginActivators?: Record<string, { activate(): void; deactivate(): void }>;
  }
}

export interface PdfViewerHandle {
  mount: () => void;
  unmount: () => void;
}

export interface InlineViewerHandle {
  expand: () => Promise<void>;
  collapse: () => void;
  // Force-renders any pages the IntersectionObserver hasn't reached yet, so
  // a print triggered before the user has scrolled through the whole
  // document doesn't leave later pages blank.
  prepareForPrint: () => void;
}

export interface InlineViewerOptions {
  url: string;
  title: string;
  anchorEl: HTMLElement;
  onRequestClose: () => void;
  // Parsed from the link's #page=N hash (see parseInitialPage in
  // pdfViewer.ts), so a link like /attachment/xxx#page=5 opens straight to
  // that page instead of page 1.
  initialPage: number | null;
}
