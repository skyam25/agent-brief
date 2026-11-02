import '../renderer/assetPath';
import '@excalidraw/excalidraw/index.css';
import '../renderer/styles.css';
import './ipad.css';
import { createRoot } from 'react-dom/client';
import { IpadApp } from './IpadApp';
import { toNative } from './host';

window.addEventListener('error', (e) => toNative({ type: 'log', level: 'error', text: e.message }));
window.addEventListener('unhandledrejection', (e) => toNative({ type: 'log', level: 'error', text: String(e.reason) }));

createRoot(document.getElementById('root')!).render(<IpadApp />);
