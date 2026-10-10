import './styles.css';
import { Workspace } from './editor/workspace';
import { App } from './ui/app';

/** Replace the loading message with the error, so a failed start is never a blank page. */
function showStartupError(error: unknown): void {
  const host = document.getElementById('app') ?? document.body;
  const box = document.createElement('div');
  box.className = 'boot';
  const title = document.createElement('h1');
  title.textContent = '❀ PvZ Animator could not start';
  const hint = document.createElement('p');
  hint.textContent = 'Your browser reported this error. A current Chrome, Edge or Firefox is recommended.';
  const details = document.createElement('pre');
  details.className = 'boot-error';
  details.textContent = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error);
  box.append(title, hint, details);
  host.replaceChildren(box);
}

try {
  const ws = new Workspace();
  const app = new App(ws);
  document.getElementById('app')!.replaceWith(app.root);
  // Handy for debugging from the console.
  (window as unknown as { pvz: unknown }).pvz = { ws, app };
} catch (e) {
  console.error(e);
  showStartupError(e);
}
