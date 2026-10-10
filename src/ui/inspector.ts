/** Right-hand property panel for reanim documents. */

import { basename } from '../engine/vfs';
import { isRangeTrack, type ReanimTransform } from '../formats/reanim';
import { EASES, type ReanimDocument } from '../editor/reanimDoc';
import type { Workspace } from '../editor/workspace';
import { h, rafThrottle } from './dom';
import { pickAsset, pickImage, previewSound, thumbnail } from './pickers';
import { checkbox, numberField, select, type NumberField } from './widgets';

const hasClipboard = (ws: Workspace) => !!ws.clipboard;

export class ReanimInspector {
  readonly el: HTMLElement;
  private lastSig = '';
  private fields = new Map<string, NumberField>();
  linkRotation = true;
  linkScale = false;

  constructor(private ws: Workspace) {
    this.el = h('div', { class: 'inspector' });
    const refresh = rafThrottle(() => this.refresh());
    ws.on('change', refresh);
    ws.on('docs', refresh);
    ws.on('frame', refresh);
    ws.on('assets', () => {
      this.lastSig = '';
      refresh();
    });
  }

  /** Rebuild the panel only when its structure changes; otherwise update values in place. */
  refresh(): void {
    const doc = this.ws.reanim;
    if (!doc) return;
    const track = doc.selectedTrack;
    const frame = this.ws.frameTime(doc).before;
    const cue = doc.ui.cue;
    const t = track?.transforms[frame];
    const sig = [doc.id, this.ws.playing ? 'playing' : frame, doc.ui.track, track?.uid, track?.name, cue?.kind, cue?.uid, t?.i, t?.text, t?.font, track?.keys[frame], track?.ease[frame], t ? t.f >= 0 : '', this.linkRotation, this.linkScale, doc.frameCount, doc.fps, doc.path, doc.state.tracks.length, doc.ui.track >= 0 && hasClipboard(this.ws)].join('|');
    if (sig === this.lastSig) {
      this.updateValues(doc);
      return;
    }
    this.lastSig = sig;
    this.fields.clear();
    this.el.replaceChildren(this.docSection(doc), cue ? this.cueSection(doc) : track ? this.trackSection(doc) : this.hint());
  }

  private updateValues(doc: ReanimDocument) {
    const track = doc.selectedTrack;
    if (!track) return;
    const t = track.transforms[this.ws.frameTime(doc).before];
    if (!t) return;
    for (const [k, f] of this.fields) f.set(t[k as keyof ReanimTransform] as number);
  }

  private hint() {
    return h(
      'div',
      { class: 'insp-hint' },
      h('p', null, 'Select a part by clicking it in the viewport or its row in the timeline.'),
      h('p', null, 'Drag an image from the asset browser onto the stage to add a new part. Drag sounds or particles onto the timeline to add cues.'),
      h('p', { class: 'dim' }, 'Space play · ←/→ frame · K key · Alt+arrows nudge · Ctrl+Z undo'),
    );
  }

  private docSection(doc: ReanimDocument) {
    const pathInput = h('input', {
      type: 'text',
      value: doc.path,
      class: 'wide mono',
      title: 'Path inside the game folder / main.pak where this reanim is saved',
      onchange: () => {
        doc.path = pathInput.value.trim().replace(/\\/g, '/');
        doc.name = basename(doc.path).replace(/\.reanim(\.compiled)?$/i, '');
        doc.savedVersion = -1;
        this.ws.emit('docs');
      },
    });
    return h(
      'section',
      { class: 'insp-section' },
      h('h3', null, 'Reanim'),
      h('label', { class: 'field-col' }, 'Saved as', pathInput),
      h('div', { class: 'insp-stats' }, `${doc.state.tracks.filter((t) => !isRangeTrack(t)).length} parts · ${doc.animRanges().length} animations · ${doc.frameCount} frames · ${doc.fps} fps`),
    );
  }

  private trackSection(doc: ReanimDocument) {
    const ws = this.ws;
    const ti = doc.ui.track;
    const track = doc.state.tracks[ti];
    const frame = ws.frameTime(doc).before;
    const t = track.transforms[frame];
    const isKey = track.keys[frame];
    const keyFrame = doc.keyAtOrBefore(track, frame);
    /** The live transform (the track object is replaced on edit). */
    const cur = () => doc.state.tracks[ti]?.transforms[doc.ui.frame] ?? t;
    const set = (patch: Partial<ReanimTransform>, label: string, final: boolean, begin: boolean) => {
      if (ws.playing) ws.pause();
      doc.setFields(ti, doc.ui.frame, patch, begin ? label : undefined);
      if (final) ws.emit('change');
      else ws.emit('frame');
    };
    const num = (key: keyof ReanimTransform, label: string, step: number, precision: number, title: string, patchFn?: (v: number) => Partial<ReanimTransform>) => {
      let begun = false;
      const f = numberField({
        label,
        value: t[key] as number,
        step,
        precision,
        title,
        onBegin: () => {
          begun = true;
        },
        onChange: (v, final) => {
          set(patchFn ? patchFn(v) : { [key]: v }, `Change ${label}`, final, begun);
          begun = false;
        },
      });
      this.fields.set(key, f);
      return f.el;
    };

    const nameInput = h('input', {
      type: 'text',
      value: track.name,
      class: 'wide',
      onchange: () => {
        doc.renameTrack(ti, nameInput.value);
        ws.emit('change');
      },
    });
    const imageRow = h(
      'div',
      { class: 'insp-image' },
      t.i ? thumbnail(ws, ws.assets.resolveImage(t.i)?.file.path ?? t.i, 48) : h('div', { class: 'thumb empty' }, '—'),
      h(
        'div',
        { class: 'insp-image-info' },
        h('div', { class: 'mono small', title: t.i }, t.i || '(no image)'),
        t.i && !ws.assets.resolveImage(t.i) ? h('div', { class: 'warn small' }, 'Image not found in loaded files') : null,
        h(
          'button',
          {
            class: 'btn small',
            onclick: async () => {
              const r = await pickImage(ws, `Image for "${track.name}" from frame ${frame}`, 'reanim', t.i);
              if (r) {
                doc.setFields(ti, frame, { i: r.id }, 'Change image');
                ws.emit('change');
              }
            },
          },
          'Change image…',
        ),
      ),
    );

    const visible = checkbox('Visible from this frame', t.f >= 0, (v) => set({ f: v ? 0 : -1 }, v ? 'Show part' : 'Hide part', true, true), 'Sets f = 0 / -1 on a key at this frame');

    const keyRow = h(
      'div',
      { class: 'insp-key' },
      h('span', { class: `key-badge${isKey ? ' on' : ''}` }, isKey ? `◆ Key @ ${frame}` : `Tween (key @ ${keyFrame})`),
      h(
        'button',
        {
          class: 'btn small',
          disabled: frame === 0,
          onclick: () => {
            doc.toggleKey(ti, frame);
            ws.emit('change');
          },
        },
        isKey ? 'Remove key' : 'Make key',
      ),
      select(
        EASES.map((e) => ({ value: e.id, label: e.label })),
        track.ease[keyFrame],
        (v) => {
          doc.setEase(ti, frame, v);
          ws.emit('change');
        },
        `Easing from key ${keyFrame} to the next key`,
      ),
    );

    const rotation = this.linkRotation
      ? [num('kx', 'Rotation', 1, 2, 'Rotation in degrees (sets kx and ky together)', (v) => ({ kx: v, ky: v + (cur().ky - cur().kx) }))]
      : [num('kx', 'Skew X', 1, 2, 'kx: rotation of the x axis (deg)'), num('ky', 'Skew Y', 1, 2, 'ky: rotation of the y axis (deg)')];
    const scale = this.linkScale
      ? [num('sx', 'Scale', 0.01, 3, 'Uniform scale', (v) => ({ sx: v, sy: cur().sx !== 0 ? (cur().sy * v) / cur().sx : v }))]
      : [num('sx', 'Scale X', 0.01, 3, 'sx'), num('sy', 'Scale Y', 0.01, 3, 'sy')];

    let sliderBegun = false;
    const alphaSlider = h('input', {
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01,
      value: t.a,
      class: 'alpha-slider',
      onpointerdown: () => (sliderBegun = false),
      oninput: () => {
        set({ a: parseFloat(alphaSlider.value) }, 'Change alpha', false, !sliderBegun);
        sliderBegun = true;
      },
      onchange: () => {
        sliderBegun = false;
        ws.emit('change');
      },
    });

    const textFields =
      t.text || t.font
        ? h(
            'div',
            { class: 'insp-grid1' },
            h('label', { class: 'field-col' }, 'Text', this.textInput(t.text, (v) => set({ text: v }, 'Change text', true, true))),
            h('label', { class: 'field-col' }, 'Font', this.textInput(t.font, (v) => set({ font: v }, 'Change font', true, true))),
          )
        : null;

    return h(
      'section',
      { class: 'insp-section' },
      h('h3', null, 'Part', h('span', { class: 'dim small' }, ` #${ti}`)),
      h('label', { class: 'field-col' }, 'Track name', nameInput),
      isRangeTrack(track) ? h('div', { class: 'dim small' }, 'anim_ tracks without images mark animation ranges (f = 0 inside, -1 outside).') : null,
      track.name.toLowerCase().startsWith('attacher__')
        ? h('div', { class: 'dim small' }, 'Attacher: the text holds "attacher__Reanim__anim_name[fps][once|hold]"; that animation is drawn at this part.')
        : t.text && !t.font
          ? h('div', { class: 'dim small' }, 'Text is only drawn when a font is set, as in the game.')
          : null,
      imageRow,
      keyRow,
      visible,
      h('div', { class: 'insp-grid2' }, num('x', 'X', 1, 2, 'Translation X (px)'), num('y', 'Y', 1, 2, 'Translation Y (px)')),
      h('div', { class: 'insp-grid2' }, ...rotation),
      checkbox('Link skew (rotation)', this.linkRotation, (v) => {
        this.linkRotation = v;
        this.refresh();
      }),
      h('div', { class: 'insp-grid2' }, ...scale),
      checkbox('Uniform scale', this.linkScale, (v) => {
        this.linkScale = v;
        this.refresh();
      }),
      h('div', { class: 'insp-alpha' }, num('a', 'Alpha', 0.01, 3, 'Opacity 0..1'), alphaSlider),
      textFields,
      h(
        'div',
        { class: 'insp-buttons' },
        h('button', { class: 'btn small', title: 'Copy this frame\'s transform (Ctrl+C)', onclick: () => (ws.clipboard = { ...t }) }, 'Copy pose'),
        h(
          'button',
          {
            class: 'btn small',
            title: 'Paste transform onto this frame (Ctrl+V)',
            disabled: !ws.clipboard,
            onclick: () => {
              if (!ws.clipboard) return;
              const { x, y, kx, ky, sx, sy, a } = ws.clipboard;
              doc.setFields(ti, frame, { x, y, kx, ky, sx, sy, a }, 'Paste pose');
              ws.emit('change');
            },
          },
          'Paste pose',
        ),
        h(
          'button',
          {
            class: 'btn small',
            title: 'Detect tweens and remove redundant keys on this track',
            onclick: () => {
              doc.checkpoint('Simplify keys');
              doc.simplifyTrack(ti);
              ws.emit('change');
            },
          },
          'Simplify keys',
        ),
      ),
    );
  }

  private textInput(value: string, onChange: (v: string) => void) {
    const input = h('input', { type: 'text', value, class: 'wide', onchange: () => onChange(input.value) });
    return input;
  }

  private cueSection(doc: ReanimDocument) {
    const ws = this.ws;
    const ref = doc.ui.cue!;
    const frameField = (frame: number, onChange: (v: number) => void) =>
      numberField({ label: 'Frame', value: frame, precision: 0, min: 0, max: doc.frameCount - 1, onChange: (v, final) => final && onChange(Math.round(v)) }).el;
    const del = h(
      'button',
      {
        class: 'btn small danger',
        onclick: () => {
          doc.removeCue(ref.kind, ref.uid);
          ws.emit('change');
        },
      },
      'Delete cue',
    );
    if (ref.kind === 'sound') {
      const cue = doc.state.soundCues.find((c) => c.uid === ref.uid);
      if (!cue) return this.hint();
      const file = ws.assets.resolveSound(cue.sound);
      return h(
        'section',
        { class: 'insp-section' },
        h('h3', null, '♪ Sound cue'),
        h('div', { class: 'mono small' }, cue.sound),
        file ? null : h('div', { class: 'warn small' }, 'Sound not found in loaded files'),
        h(
          'div',
          { class: 'insp-buttons' },
          h('button', { class: 'btn small', onclick: () => void previewSound(ws, cue.sound, cue.volume) }, '▶ Preview'),
          h(
            'button',
            {
              class: 'btn small',
              onclick: async () => {
                const p = await pickAsset(ws, 'sound', 'Choose sound');
                if (p) {
                  doc.updateSoundCue(cue.uid, { sound: p });
                  ws.emit('change');
                }
              },
            },
            'Change sound…',
          ),
        ),
        h(
          'div',
          { class: 'insp-grid2' },
          frameField(cue.frame, (v) => {
            doc.updateSoundCue(cue.uid, { frame: v }, 'Move sound cue');
            ws.emit('change');
          }),
          numberField({
            label: 'Volume',
            value: cue.volume,
            step: 0.05,
            precision: 2,
            min: 0,
            max: 4,
            onChange: (v, final) => {
              if (!final) return;
              doc.updateSoundCue(cue.uid, { volume: v }, 'Change volume');
              ws.emit('change');
            },
          }).el,
        ),
        h('p', { class: 'dim small' }, 'Cues play during preview and are embedded in exported reanims as a hidden "_pvzanim_cues" track that the game ignores.'),
        del,
      );
    }
    const cue = doc.state.particleCues.find((c) => c.uid === ref.uid);
    if (!cue) return this.hint();
    const trackOptions = [{ value: '', label: '(fixed position)' }, ...doc.state.tracks.filter((t) => !isRangeTrack(t)).map((t) => ({ value: t.name, label: t.name }))];
    return h(
      'section',
      { class: 'insp-section' },
      h('h3', null, '✦ Particle cue'),
      h('div', { class: 'mono small' }, cue.particle),
      h(
        'div',
        { class: 'insp-buttons' },
        h(
          'button',
          {
            class: 'btn small',
            onclick: async () => {
              const p = await pickAsset(ws, 'particle', 'Choose particle effect');
              if (p) {
                doc.updateParticleCue(cue.uid, { particle: p });
                ws.invalidatePreviews();
                ws.emit('change');
              }
            },
          },
          'Change effect…',
        ),
        h('button', { class: 'btn small', onclick: () => void ws.openAsset(cue.particle) }, 'Edit effect'),
      ),
      h(
        'label',
        { class: 'field-col' },
        'Follow track',
        select(trackOptions, cue.track, (v) => {
          doc.updateParticleCue(cue.uid, { track: v });
          ws.invalidatePreviews();
          ws.emit('change');
        }),
      ),
      h(
        'div',
        { class: 'insp-grid2' },
        frameField(cue.frame, (v) => {
          doc.updateParticleCue(cue.uid, { frame: v }, 'Move particle cue');
          ws.invalidatePreviews();
          ws.emit('change');
        }),
      ),
      h(
        'div',
        { class: 'insp-grid2' },
        ...(['x', 'y'] as const).map(
          (k) =>
            numberField({
              label: k.toUpperCase(),
              value: cue[k],
              precision: 2,
              title: cue.track ? 'Offset in the followed track\'s local space' : 'Position in reanim space',
              onChange: (v, final) => {
                if (!final) return;
                doc.updateParticleCue(cue.uid, { [k]: v });
                ws.invalidatePreviews();
                ws.emit('change');
              },
            }).el,
        ),
      ),
      h('p', { class: 'dim small' }, 'Drag the ✦ marker in the viewport to reposition the effect.'),
      del,
    );
  }
}
