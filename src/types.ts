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
}

export interface InlineViewerOptions {
  url: string;
  title: string;
  anchorEl: HTMLElement;
}
