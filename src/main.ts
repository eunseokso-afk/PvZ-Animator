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
  if (error instanceof Error) {
    // Chrome's stack already starts with "Name: message"; Firefox's does not.
    const head = `${error.name}: ${error.message}`;
    const stack = error.stack ?? '';
    details.textContent = stack.startsWith(head) ? stack : `${head}\n${stack}`;
  } else {
    details.textContent = String(error);
  }
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
