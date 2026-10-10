import './styles.css';
import { Workspace } from './editor/workspace';
import { App } from './ui/app';

const ws = new Workspace();
const app = new App(ws);
document.getElementById('app')!.replaceWith(app.root);

// Handy for debugging from the console.
(window as unknown as { pvz: unknown }).pvz = { ws, app };
