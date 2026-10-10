/** Reusable widgets: modal dialogs, context menus, number scrubbers, toasts. */

import { h, type Child } from './dom';

// ---------------------------------------------------------------- dialogs

export interface DialogButton {
  label: string;
  value: string;
  primary?: boolean;
  danger?: boolean;
}

export interface DialogOptions {
  title: string;
  body: Child;
  buttons?: DialogButton[];
  width?: number;
  /** Return false to keep the dialog open. */
  onButton?: (value: string) => boolean | void;
  onOpen?: (root: HTMLElement) => void;
}

export function openDialog(opts: DialogOptions): Promise<string | null> {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const close = (value: string | null) => {
      if (value !== null && opts.onButton?.(value) === false) return;
      overlay.remove();
      document.removeEventListener('keydown', onKey, true);
      prevFocus?.focus?.();
      resolve(value);
    };
    const buttons = (opts.buttons ?? [{ label: 'OK', value: 'ok', primary: true }]).map((b) =>
      h('button', { class: `btn${b.primary ? ' primary' : ''}${b.danger ? ' danger' : ''}`, onclick: () => close(b.value) }, b.label),
    );
    const dialog = h(
      'div',
      { class: 'dialog', role: 'dialog', 'aria-modal': 'true', style: { width: `${opts.width ?? 440}px` } },
      h('div', { class: 'dialog-title' }, opts.title, h('button', { class: 'icon-btn', title: 'Close', onclick: () => close(null) }, '✕')),
      h('div', { class: 'dialog-body' }, opts.body),
      h('div', { class: 'dialog-buttons' }, buttons),
    );
    const overlay = h('div', { class: 'overlay', onmousedown: (e: MouseEvent) => e.target === overlay && close(null) }, dialog);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close(null);
      } else if (e.key === 'Enter' && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLButtonElement)) {
        const primary = (opts.buttons ?? [{ value: 'ok', primary: true }]).find((b) => b.primary);
        if (primary) {
          e.preventDefault();
          e.stopPropagation();
          close(primary.value);
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
    opts.onOpen?.(dialog);
    const first = dialog.querySelector<HTMLElement>('input, select, textarea') ?? buttons.find((b) => b.classList.contains('primary'));
    first?.focus();
    if (first instanceof HTMLInputElement) first.select();
  });
}

export async function promptText(title: string, label: string, initial = ''): Promise<string | null> {
  const input = h('input', { type: 'text', value: initial, class: 'wide' });
  const r = await openDialog({
    title,
    body: h('label', { class: 'field-col' }, label, input),
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: 'OK', value: 'ok', primary: true },
    ],
  });
  return r === 'ok' ? input.value : null;
}

export async function confirmDialog(title: string, message: Child, okLabel = 'OK', danger = false): Promise<boolean> {
  const r = await openDialog({
    title,
    body: h('div', { class: 'dialog-text' }, message),
    buttons: [
      { label: 'Cancel', value: 'cancel' },
      { label: okLabel, value: 'ok', primary: true, danger },
    ],
  });
  return r === 'ok';
}

export function alertDialog(title: string, message: Child): Promise<string | null> {
  return openDialog({ title, body: h('div', { class: 'dialog-text' }, message) });
}

// ---------------------------------------------------------------- menus

export interface MenuItem {
  label?: string;
  shortcut?: string;
  action?: () => void;
  disabled?: boolean;
  checked?: boolean;
  separator?: boolean;
  submenu?: MenuItem[];
}

let openMenuEl: HTMLElement | null = null;
let closeHandler: ((e: Event) => void) | null = null;

export function closeMenus(): void {
  openMenuEl?.remove();
  openMenuEl = null;
  if (closeHandler) {
    document.removeEventListener('mousedown', closeHandler, true);
    document.removeEventListener('keydown', closeHandler, true);
    window.removeEventListener('blur', closeHandler);
    closeHandler = null;
  }
}

function buildMenu(items: MenuItem[], root: HTMLElement): HTMLElement {
  const menu = h('div', { class: 'menu', role: 'menu' });
  for (const item of items) {
    if (item.separator) {
      menu.appendChild(h('div', { class: 'menu-sep' }));
      continue;
    }
    const row = h(
      'div',
      { class: `menu-item${item.disabled ? ' disabled' : ''}${item.submenu ? ' has-sub' : ''}`, role: 'menuitem' },
      h('span', { class: 'menu-check' }, item.checked ? '✓' : ''),
      h('span', { class: 'menu-label' }, item.label ?? ''),
      h('span', { class: 'menu-shortcut' }, item.submenu ? '▸' : (item.shortcut ?? '')),
    );
    if (item.submenu && !item.disabled) {
      let sub: HTMLElement | null = null;
      row.addEventListener('mouseenter', () => {
        root.querySelectorAll('.menu.sub').forEach((m) => {
          if (!m.contains(row)) m.remove();
        });
        sub = buildMenu(item.submenu!, root);
        sub.classList.add('sub');
        root.appendChild(sub);
        const r = row.getBoundingClientRect();
        positionMenu(sub, r.right - 2, r.top - 4, r.left);
      });
    } else {
      row.addEventListener('mouseenter', () => root.querySelectorAll('.menu.sub').forEach((m) => !m.contains(row) && m.remove()));
    }
    if (!item.disabled && item.action) {
      row.addEventListener('click', (e) => {
        e.stopPropagation();
        closeMenus();
        item.action!();
      });
    }
    menu.appendChild(row);
  }
  return menu;
}

function positionMenu(menu: HTMLElement, x: number, y: number, flipX?: number) {
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth - 4) menu.style.left = `${Math.max(4, (flipX ?? window.innerWidth) - r.width)}px`;
  if (r.bottom > window.innerHeight - 4) menu.style.top = `${Math.max(4, window.innerHeight - r.height - 4)}px`;
}

export function showMenu(items: MenuItem[], x: number, y: number): void {
  closeMenus();
  const root = h('div', { class: 'menu-root' });
  const menu = buildMenu(items, root);
  root.appendChild(menu);
  document.body.appendChild(root);
  positionMenu(menu, x, y);
  openMenuEl = root;
  closeHandler = (e: Event) => {
    if (e instanceof KeyboardEvent) {
      if (e.key === 'Escape') closeMenus();
      return;
    }
    if (e.type === 'blur' || !root.contains(e.target as Node)) closeMenus();
  };
  setTimeout(() => {
    if (!closeHandler) return;
    document.addEventListener('mousedown', closeHandler, true);
    document.addEventListener('keydown', closeHandler, true);
    window.addEventListener('blur', closeHandler);
  });
}

// ---------------------------------------------------------------- number field

export interface NumberFieldOptions {
  label: string;
  value: number;
  step?: number;
  precision?: number;
  min?: number;
  max?: number;
  title?: string;
  /** Called once before a change gesture (for undo checkpoints). */
  onBegin?: () => void;
  onChange: (value: number, final: boolean) => void;
}

export interface NumberField {
  el: HTMLElement;
  input: HTMLInputElement;
  set(value: number): void;
}

export function numberField(o: NumberFieldOptions): NumberField {
  const precision = o.precision ?? 2;
  const step = o.step ?? 1;
  const clampV = (v: number) => Math.min(o.max ?? Infinity, Math.max(o.min ?? -Infinity, v));
  const show = (v: number) => {
    const s = v.toFixed(precision);
    return s.indexOf('.') >= 0 ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
  };
  let value = o.value;
  const input = h('input', { type: 'text', class: 'num-input', value: show(value), spellcheck: false, inputMode: 'decimal' });
  const label = h('span', { class: 'num-label', title: (o.title ? o.title + '\n' : '') + 'Drag to scrub, Shift = ×10, Alt = ×0.1' }, o.label);

  const commit = () => {
    const expr = input.value.trim();
    let v: number;
    try {
      // Allow simple arithmetic like "12+4" or "90*2" (the character whitelist keeps this safe).
      if (!/^[-+*/().\d\se]+$/i.test(expr)) throw new Error('bad');
      v = Function(`"use strict"; return (${expr});`)() as number;
    } catch {
      v = NaN;
    }
    if (!Number.isFinite(v)) {
      input.value = show(value);
      return;
    }
    v = clampV(v);
    if (v === value) {
      input.value = show(value);
      return;
    }
    value = v;
    input.value = show(v);
    o.onBegin?.();
    o.onChange(v, true);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      commit();
      input.blur();
    } else if (e.key === 'Escape') {
      input.value = show(value);
      input.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const mult = e.shiftKey ? 10 : e.altKey ? 0.1 : 1;
      value = clampV(value + (e.key === 'ArrowUp' ? 1 : -1) * step * mult);
      input.value = show(value);
      o.onBegin?.();
      o.onChange(value, true);
    }
    e.stopPropagation();
  });

  label.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    label.setPointerCapture(e.pointerId);
    const startX = e.clientX;
    const startV = value;
    let began = false;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      if (!began && Math.abs(dx) < 2) return;
      if (!began) {
        began = true;
        o.onBegin?.();
      }
      const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
      value = clampV(startV + Math.round(dx) * step * mult * 0.5);
      value = parseFloat(value.toFixed(precision + 1));
      input.value = show(value);
      o.onChange(value, false);
    };
    const up = () => {
      label.removeEventListener('pointermove', move);
      label.removeEventListener('pointerup', up);
      label.removeEventListener('pointercancel', up);
      if (began) o.onChange(value, true);
    };
    label.addEventListener('pointermove', move);
    label.addEventListener('pointerup', up);
    label.addEventListener('pointercancel', up);
  });

  const el = h('div', { class: 'num-field' }, label, input);
  return {
    el,
    input,
    set(v: number) {
      value = v;
      if (document.activeElement !== input) input.value = show(v);
    },
  };
}

// ---------------------------------------------------------------- misc

export function checkbox(label: string, checked: boolean, onChange: (v: boolean) => void, title?: string): HTMLLabelElement {
  const input = h('input', { type: 'checkbox', checked, onchange: () => onChange(input.checked) });
  return h('label', { class: 'check', title }, input, h('span', null, label));
}

export function select<T extends string>(options: { value: T; label: string }[], value: T, onChange: (v: T) => void, title?: string): HTMLSelectElement {
  const el = h(
    'select',
    { title, onchange: () => onChange(el.value as T) },
    options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)),
  );
  return el;
}

let toastHost: HTMLElement | null = null;

export function toast(message: string, level: 'info' | 'error' | 'success' = 'info', ms = 3500): void {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts' });
    document.body.appendChild(toastHost);
  }
  const t = h('div', { class: `toast ${level}` }, message);
  toastHost.appendChild(t);
  setTimeout(() => t.classList.add('hide'), ms);
  setTimeout(() => t.remove(), ms + 400);
}
