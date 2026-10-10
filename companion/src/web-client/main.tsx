import '../renderer/assetPath';
import '@excalidraw/excalidraw/index.css';
import '../renderer/styles.css';
import './web.css';
import { createRoot } from 'react-dom/client';
import { WebHost } from './host';
import { WebApp } from './WebApp';

createRoot(document.getElementById('root')!).render(<WebApp host={new WebHost()} />);
