import './src/styles/pdfViewer.css';
import { createPdfViewer } from './src/pdfViewer';

const pdfViewer = createPdfViewer();

const activate = (): void => {
  pdfViewer.mount();
};

const deactivate = (): void => {
  pdfViewer.unmount();
};

window.pluginActivators = window.pluginActivators ?? {};
window.pluginActivators['growi-plugin-pdf-viewer'] = { activate, deactivate };
