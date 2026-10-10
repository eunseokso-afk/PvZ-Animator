/** Particle editor panels: emitter list / preview controls and the emitter inspector. */

import { evaluateFloatTrack, tryParseFloatTrack } from '../formats/floatTrack';
import {
  EMITTER_TYPES,
  FIELD_HELP,
  FIELD_TYPES,
  PARTICLE_FLAGS,
  TRACK_DEFAULTS,
  TRACK_HELP,
  type EmitterDefinition,
  type FieldType,
  type ParticleField,
  type TrackName,
} from '../formats/particles';
import type { ParticleDocument } from '../editor/particleDoc';
import type { Workspace } from '../editor/workspace';
import { h, rafThrottle } from './dom';
import { pickImage, thumbnail } from './pickers';
import { checkbox, numberField, select } from './widgets';
import type { Viewport } from './viewport';

const FLAG_HELP: Record<string, string> = {
  RandomLaunchSpin: 'Start each particle at a random rotation.',
  AlignLaunchSpin: 'Rotate particles to face their launch direction.',
  AlignToPixel: 'Snap particles to whole pixels.',
  SystemLoops: 'Restart the emitter when SystemDuration ends.',
  ParticleLoops: 'Restart each particle when its duration ends.',
  ParticlesDontFollow: 'Particles stay put when the emitter moves.',
  RandomStartTime: 'Particles start at a random point of their lifetime.',
  DieIfOverloaded: 'Skip this emitter when too many particles are alive.',
  Additive: 'Additive (glow) blending.',
  FullScreen: 'Tint the whole screen with the particle color.',
  SoftwareOnly: 'Only used without 3D acceleration (hidden in preview).',
  HardwareOnly: 'Only used with 3D acceleration.',
};

const GROUPS: { title: string; tracks: TrackName[] }[] = [
  { title: 'Emitter timing', tracks: ['SystemDuration', 'CrossFadeDuration', 'SpawnRate', 'SpawnMinActive', 'SpawnMaxActive', 'SpawnMaxLaunched'] },
  { title: 'Emitter shape', tracks: ['EmitterRadius', 'EmitterOffsetX', 'EmitterOffsetY', 'EmitterBoxX', 'EmitterBoxY', 'EmitterSkewX', 'EmitterSkewY', 'EmitterPath'] },
  { title: 'Launch', tracks: ['ParticleDuration', 'LaunchSpeed', 'LaunchAngle'] },
  { title: 'Particle look', tracks: ['ParticleRed', 'ParticleGreen', 'ParticleBlue', 'ParticleAlpha', 'ParticleBrightness', 'ParticleScale', 'ParticleStretch', 'ParticleSpinAngle', 'ParticleSpinSpeed', 'AnimationRate'] },
  { title: 'System color', tracks: ['SystemRed', 'SystemGreen', 'SystemBlue', 'SystemAlpha', 'SystemBrightness'] },
  { title: 'Collision & clipping', tracks: ['CollisionReflect', 'CollisionSpin', 'ClipTop', 'ClipBottom', 'ClipLeft', 'ClipRight'] },
];

/** Draw a float track's low/high envelope over normalized time. */
function drawTrackGraph(canvas: HTMLCanvasElement, src: string | undefined, fallback: number) {
  const ctx = canvas.getContext('2d')!;
  const w = canvas.width;
  const hh = canvas.height;
  ctx.clearRect(0, 0, w, hh);
  const text = src?.trim() ? src : String(fallback);
  const { track, error } = tryParseFloatTrack(text);
  if (error || track.nodes.length === 0) return;
  const N = 48;
  const lo: number[] = [];
  const hi: number[] = [];
  for (let i = 0; i <= N; i++) {
    lo.push(evaluateFloatTrack(track, i / N, 0));
    hi.push(evaluateFloatTrack(track, i / N, 1));
  }
  let min = Math.min(...lo, ...hi);
  let max = Math.max(...lo, ...hi);
  if (max - min < 1e-6) {
    min -= 1;
    max += 1;
  }
  const yOf = (v: number) => hh - 3 - ((v - min) / (max - min)) * (hh - 6);
  ctx.fillStyle = 'rgba(79,157,222,0.25)';
  ctx.beginPath();
  for (let i = 0; i <= N; i++) ctx.lineTo((i / N) * w, yOf(hi[i]));
  for (let i = N; i >= 0; i--) ctx.lineTo((i / N) * w, yOf(lo[i]));
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = src?.trim() ? '#7cc0ff' : 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 1.5;
  for (const arr of [lo, hi]) {
    ctx.beginPath();
    arr.forEach((v, i) => (i ? ctx.lineTo((i / N) * w, yOf(v)) : ctx.moveTo(0, yOf(v))));
    ctx.stroke();
  }
}

function trackRow(label: string, help: string, value: string | undefined, fallback: number, onCommit: (v: string | undefined) => void): HTMLElement {
  const graph = h('canvas', { width: 120, height: 40, class: 'track-graph', title: 'Low (interp 0) and high (interp 1) values over the lifetime' });
  const input = h('input', {
    type: 'text',
    class: 'track-input mono',
    value: value ?? '',
    placeholder: String(fallback),
    spellcheck: false,
  });
  const validate = () => {
    const v = input.value.trim();
    const err = v ? tryParseFloatTrack(v).error : undefined;
    input.classList.toggle('invalid', !!err);
    input.title = err ?? `${help}\nSyntax: 5 · [lo hi] · 1,80 0 · EaseOut 0 1`;
    drawTrackGraph(graph, v || undefined, fallback);
    return !err;
  };
  let timer = 0;
  input.addEventListener('input', () => {
    validate();
    clearTimeout(timer);
    timer = window.setTimeout(() => {
      if (validate() && (input.value.trim() || undefined) !== (value?.trim() || undefined)) {
        value = input.value.trim() || undefined;
        onCommit(value);
      }
    }, 350);
  });
  input.addEventListener('keydown', (e) => e.stopPropagation());
  validate();
  const reset = h(
    'button',
    {
      class: 'icon-btn',
      title: 'Reset to default',
      onclick: () => {
        input.value = '';
        validate();
        value = undefined;
        onCommit(undefined);
      },
    },
    '↺',
  );
  return h('div', { class: 'track-row' }, h('span', { class: 'track-label', title: help }, label), input, graph, reset);
}

export class ParticleInspector {
  readonly el: HTMLElement;
  private sig = '';

  constructor(private ws: Workspace) {
    this.el = h('div', { class: 'inspector' });
    const refresh = rafThrottle(() => this.refresh());
    ws.on('change', refresh);
    ws.on('docs', refresh);
    ws.on('assets', () => {
      this.sig = '';
      refresh();
    });
  }

  refresh(force = false): void {
    const doc = this.ws.particle;
    if (!doc) return;
    const sig = `${doc.id}|${doc.ui.emitter}|${doc.revision}`;
    if (sig === this.sig && !force) return;
    this.sig = sig;
    const em = doc.emitter;
    const scrollTop = this.el.scrollTop;
    this.el.replaceChildren(this.docSection(doc), em ? this.emitterSections(doc, em) : h('div', { class: 'insp-hint' }, 'No emitter selected.'));
    this.el.scrollTop = scrollTop;
  }

  private docSection(doc: ParticleDocument) {
    const pathInput = h('input', {
      type: 'text',
      value: doc.path,
      class: 'wide mono',
      title: 'Path inside the game folder / main.pak where this effect is saved',
      onchange: () => {
        doc.path = pathInput.value.trim().replace(/\\/g, '/');
        doc.name = doc.path.split('/').pop()!.replace(/\.xml$/i, '');
        doc.savedVersion = -1;
        this.ws.emit('docs');
      },
    });
    return h('section', { class: 'insp-section' }, h('h3', null, 'Particle effect'), h('label', { class: 'field-col' }, 'Saved as', pathInput));
  }

  /** Apply an edit. In-place edits (text fields) skip the rebuild so focus is kept. */
  private edit(doc: ParticleDocument, label: string, fn: (e: EmitterDefinition) => void, rebuild = true) {
    doc.editEmitter(label, fn);
    if (!rebuild) this.sig = `${doc.id}|${doc.ui.emitter}|${doc.revision}`;
    this.ws.emit('change');
  }

  private emitterSections(doc: ParticleDocument, em: EmitterDefinition): HTMLElement {
    const ws = this.ws;
    const nameInput = h('input', { type: 'text', value: em.name, class: 'wide', onchange: () => this.edit(doc, 'Rename emitter', (e) => (e.name = nameInput.value), false) });
    const intField = (label: string, key: 'imageCol' | 'imageRow' | 'imageFrames' | 'animated', title: string, min = 0) =>
      numberField({ label, value: em[key], precision: 0, min, title, onChange: (v, final) => final && this.edit(doc, `Change ${label}`, (e) => (e[key] = Math.round(v))) }).el;
    const imgPath = em.image ? ws.assets.resolveImage(em.image)?.file.path : undefined;
    const basics = h(
      'details',
      { class: 'insp-section', open: true },
      h('summary', null, 'Emitter'),
      h('label', { class: 'field-col' }, 'Name', nameInput),
      h(
        'div',
        { class: 'insp-image' },
        imgPath ? thumbnail(ws, imgPath, 48) : h('div', { class: 'thumb empty' }, '—'),
        h(
          'div',
          { class: 'insp-image-info' },
          h('div', { class: 'mono small' }, em.image || '(no image)'),
          em.image && !imgPath ? h('div', { class: 'warn small' }, 'Image not found in loaded files') : null,
          h(
            'div',
            { class: 'insp-buttons' },
            h(
              'button',
              {
                class: 'btn small',
                onclick: async () => {
                  const r = await pickImage(ws, 'Particle image', 'particles', em.image);
                  if (r) this.edit(doc, 'Change image', (e) => (e.image = r.id));
                },
              },
              'Change…',
            ),
            em.image ? h('button', { class: 'btn small', onclick: () => this.edit(doc, 'Clear image', (e) => (e.image = '')) }, 'Clear') : null,
          ),
        ),
      ),
      h(
        'div',
        { class: 'insp-grid2' },
        intField('Frames', 'imageFrames', 'Number of animation frames in the image strip', 1),
        intField('Animated', 'animated', '1 = play frames over the lifetime, 0 = random frame'),
        intField('Col', 'imageCol', 'Image column (for sprite sheets)'),
        intField('Row', 'imageRow', 'Image row (for sprite sheets)'),
      ),
      h(
        'label',
        { class: 'field-col' },
        'Emitter type',
        select(
          EMITTER_TYPES.map((t) => ({ value: t, label: t })),
          em.emitterType,
          (v) => this.edit(doc, 'Change emitter type', (e) => (e.emitterType = v)),
        ),
      ),
      h(
        'label',
        { class: 'field-col', title: 'Name of an emitter in this file to cross-fade into when this one ends' },
        'On duration',
        (() => {
          const inp = h('input', { type: 'text', value: em.onDuration, class: 'wide', onchange: () => this.edit(doc, 'Change OnDuration', (e) => (e.onDuration = inp.value.trim()), false) });
          return inp;
        })(),
      ),
    );
    const flags = h(
      'details',
      { class: 'insp-section', open: true },
      h('summary', null, 'Flags'),
      h(
        'div',
        { class: 'flag-grid' },
        PARTICLE_FLAGS.map((f) => checkbox(f, !!em.flags[f], (v) => this.edit(doc, `Toggle ${f}`, (e) => (e.flags[f] = v || undefined)), FLAG_HELP[f])),
      ),
    );
    const groups = GROUPS.map((g, gi) =>
      h(
        'details',
        { class: 'insp-section', open: gi < 4 },
        h('summary', null, g.title),
        g.tracks.map((t) =>
          trackRow(t, TRACK_HELP[t], em.tracks[t], TRACK_DEFAULTS[t], (v) =>
            this.edit(
              doc,
              `Change ${t}`,
              (e) => {
                if (v === undefined) delete e.tracks[t];
                else e.tracks[t] = v;
              },
              false,
            ),
          ),
        ),
      ),
    );
    const fields = this.fieldSection(doc, 'Particle fields', 'fields', em.fields);
    const sysFields = this.fieldSection(doc, 'System fields', 'systemFields', em.systemFields);
    const extra = em.extra.length
      ? h(
          'details',
          { class: 'insp-section' },
          h('summary', null, `Other tags (${em.extra.length})`),
          h('p', { class: 'dim small' }, 'Unrecognized elements are kept as-is when saving.'),
          em.extra.map((x, i) =>
            h(
              'div',
              { class: 'extra-row' },
              h('span', { class: 'mono small' }, `<${x.tag}> ${x.value}`),
              h('button', { class: 'icon-btn', title: 'Remove', onclick: () => this.edit(doc, 'Remove tag', (e) => e.extra.splice(i, 1)) }, '✕'),
            ),
          ),
        )
      : null;
    return h('div', null, basics, flags, groups, fields, sysFields, extra, h('p', { class: 'dim small insp-foot' }, 'Durations are in centiseconds (100 = 1 s). Speeds are px/s. Angles: 0 = down, 90 = right, 180 = up.'));
  }

  private fieldSection(doc: ParticleDocument, title: string, key: 'fields' | 'systemFields', list: ParticleField[]) {
    let newType: FieldType = key === 'fields' ? 'Acceleration' : 'SystemPosition';
    return h(
      'details',
      { class: 'insp-section', open: list.length > 0 },
      h('summary', null, `${title} (${list.length})`),
      list.map((f, i) =>
        h(
          'div',
          { class: 'field-block' },
          h(
            'div',
            { class: 'field-head' },
            select(
              FIELD_TYPES.map((t) => ({ value: t, label: t })),
              f.type,
              (v) => this.edit(doc, 'Change field type', (e) => (e[key][i].type = v)),
              FIELD_HELP[f.type],
            ),
            h('span', { class: 'dim small field-help' }, FIELD_HELP[f.type]),
            h('button', { class: 'icon-btn', title: 'Remove field', onclick: () => this.edit(doc, 'Remove field', (e) => e[key].splice(i, 1)) }, '✕'),
          ),
          trackRow('X', 'Field X value', f.x || undefined, 0, (v) => this.edit(doc, 'Change field X', (e) => (e[key][i].x = v ?? ''), false)),
          trackRow('Y', 'Field Y value', f.y || undefined, 0, (v) => this.edit(doc, 'Change field Y', (e) => (e[key][i].y = v ?? ''), false)),
        ),
      ),
      h(
        'div',
        { class: 'insp-buttons' },
        select(
          FIELD_TYPES.map((t) => ({ value: t, label: t })),
          newType,
          (v) => (newType = v),
        ),
        h('button', { class: 'btn small', onclick: () => this.edit(doc, 'Add field', (e) => e[key].push({ type: newType, x: '', y: newType === 'Acceleration' ? '300' : '' })) }, '+ Add field'),
      ),
    );
  }
}

/** Bottom panel for particle documents. */
export class ParticlePanel {
  readonly el: HTMLElement;
  private list: HTMLElement;
  private controls: HTMLElement;
  private stats: HTMLElement;
  private sig = '';

  constructor(
    private ws: Workspace,
    private viewport: Viewport,
  ) {
    this.list = h('div', { class: 'emitter-list' });
    this.stats = h('span', { class: 'dim' });
    this.controls = h('div', { class: 'particle-controls' });
    this.el = h('div', { class: 'particle-panel' }, h('div', { class: 'emitter-col' }, this.list), this.controls);
    const refresh = rafThrottle(() => this.refresh());
    ws.on('change', refresh);
    ws.on('docs', refresh);
    setInterval(() => {
      if (this.ws.particle) this.stats.textContent = `${this.viewport.particleCount} live particles`;
    }, 250);
  }

  refresh(): void {
    const doc = this.ws.particle;
    if (!doc) return;
    const sig = `${doc.id}|${doc.revision}|${doc.ui.emitter}|${doc.ui.playing}|${doc.ui.speed}|${doc.ui.autoRestart}|${doc.ui.showGuides}`;
    if (sig === this.sig) return;
    this.sig = sig;
    const ws = this.ws;
    const btn = (label: string, title: string, fn: () => void, disabled = false) => h('button', { class: 'tool-btn', title, onclick: fn, disabled }, label);
    const i = doc.ui.emitter;
    this.list.replaceChildren(
      h(
        'div',
        { class: 'emitter-toolbar' },
        h('span', { class: 'panel-title' }, 'Emitters'),
        btn('＋', 'Add emitter', () => (doc.addEmitter(), ws.emit('change'))),
        btn('⧉', 'Duplicate emitter', () => (doc.duplicateEmitter(i), ws.emit('change'))),
        btn('↑', 'Move up (drawn earlier)', () => (doc.moveEmitter(i, i - 1), ws.emit('change')), i === 0),
        btn('↓', 'Move down (drawn later)', () => (doc.moveEmitter(i, i + 1), ws.emit('change')), i >= doc.def.emitters.length - 1),
        btn('🗑', 'Delete emitter', () => (doc.removeEmitter(i), ws.emit('change')), doc.def.emitters.length <= 1),
      ),
      h(
        'div',
        { class: 'emitter-rows' },
        doc.def.emitters.map((em, idx) => {
          const tags = [em.emitterType, em.flags.Additive ? 'additive' : '', em.flags.SystemLoops ? 'loops' : '', `${em.fields.length} fields`].filter(Boolean).join(' · ');
          return h(
            'div',
            {
              class: `emitter-row${idx === i ? ' sel' : ''}`,
              onclick: () => {
                doc.ui.emitter = idx;
                ws.emit('change');
              },
            },
            h('span', { class: 'emitter-idx' }, String(idx)),
            h('span', { class: 'emitter-name' }, em.name || '(unnamed)'),
            h('span', { class: 'emitter-tags dim small' }, tags),
          );
        }),
      ),
    );
    this.controls.replaceChildren(
      h('div', { class: 'panel-title' }, 'Preview'),
      h(
        'div',
        { class: 'tl-group' },
        btn(doc.ui.playing ? '❚❚' : '▶', 'Play / pause (Space)', () => {
          doc.ui.playing = !doc.ui.playing;
          ws.emit('change');
        }),
        btn('⟲', 'Restart (R)', () => this.viewport.restartParticles()),
        select(
          ['0.1', '0.25', '0.5', '1', '2'].map((s) => ({ value: s, label: `${s}×` })),
          String(doc.ui.speed),
          (v) => {
            doc.ui.speed = parseFloat(v);
            ws.emit('change');
          },
          'Simulation speed',
        ),
      ),
      checkbox('Auto-restart when finished', doc.ui.autoRestart, (v) => {
        doc.ui.autoRestart = v;
        ws.emit('change');
      }),
      checkbox('Show emitter shapes', doc.ui.showGuides, (v) => {
        doc.ui.showGuides = v;
        ws.emit('change');
      }),
      h(
        'div',
        { class: 'tl-group' },
        btn('Center emitter', 'Move the preview emitter back to the origin', () => {
          doc.ui.x = 0;
          doc.ui.y = 0;
          ws.emit('change');
        }),
        this.stats,
      ),
      h('p', { class: 'dim small' }, 'Drag the yellow crosshair in the viewport to move the emitter (tests ParticlesDontFollow). Add the effect to a reanim with a particle cue to preview it with an animation.'),
    );
  }
}
