/** Right-hand panel for scenes: stage settings, the selected layer's keyframe properties, sound cues. */

import { getAnimRanges } from '../formats/reanim';
import { EASES } from '../editor/reanimDoc';
import { evalLayer, INSTANCE_LOOPS, keyIndexAt, type LayerKey, type SceneDocument } from '../editor/sceneDoc';
import type { Workspace } from '../editor/workspace';
import { h, rafThrottle } from './dom';
import { uniqueSceneName } from './exporters';
import { pickAsset, pickImage, previewSound, thumbnail } from './pickers';
import { checkbox, numberField, select, type NumberField } from './widgets';

function toHex(rgb: [number, number, number]): string {
  return '#' + rgb.map((c) => Math.round(Math.max(0, Math.min(1, c)) * 255).toString(16).padStart(2, '0')).join('');
}

function fromHex(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export class SceneInspector {
  readonly el: HTMLElement;
  private sig = '';
  private fields = new Map<string, NumberField>();
  private alphaSlider: HTMLInputElement | null = null;
  /** A scrub or slider drag is in progress: update values in place, never rebuild under the pointer. */
  private gesture = false;
  uniformScale = true;

  constructor(
    private ws: Workspace,
    private hooks: { flip(doc: SceneDocument, layerIndex: number, flipX: boolean): void },
  ) {
    this.el = h('div', { class: 'inspector' });
    const refresh = rafThrottle(() => this.refresh());
    // Safety net: a gesture always ends with the pointer going up somewhere.
    window.addEventListener('pointerup', () =>
      setTimeout(() => {
        if (!this.gesture) return;
        this.gesture = false;
        refresh();
      }, 0),
    );
    ws.on('change', refresh);
    ws.on('docs', refresh);
    ws.on('frame', refresh);
    ws.on('assets', () => {
      this.sig = '';
      refresh();
    });
  }

  refresh(force = false): void {
    const doc = this.ws.scene;
    if (!doc) return;
    const frame = doc.ui.frame;
    const layer = doc.selectedLayer;
    const ki = layer ? keyIndexAt(layer, frame) : -1;
    const key = layer?.keys[ki];
    const s = doc.state;
    const sig = [
      doc.id,
      this.ws.playing ? 'playing' : frame,
      doc.ui.layer,
      layer?.uid,
      layer?.name,
      layer?.source,
      layer?.keys.length,
      ki,
      key && JSON.stringify({ ...key, x: 0, y: 0, rotation: 0, scaleX: 0, scaleY: 0, alpha: 0 }),
      doc.ui.cue?.uid,
      s.width,
      s.height,
      s.background,
      s.backgroundImage,
      s.fps,
      s.length,
      doc.name,
      this.uniformScale,
      s.soundCues.find((c) => c.uid === doc.ui.cue?.uid)?.sound,
    ].join('|');
    if ((sig === this.sig && !force) || this.gesture) {
      this.updateValues(doc);
      return;
    }
    this.sig = sig;
    this.fields.clear();
    this.alphaSlider = null;
    const scroll = this.el.scrollTop;
    this.el.replaceChildren(this.sceneSection(doc), doc.ui.cue ? this.cueSection(doc) : layer ? this.layerSection(doc) : this.hint());
    this.el.scrollTop = scroll;
  }

  private updateValues(doc: SceneDocument) {
    const layer = doc.selectedLayer;
    if (!layer) return;
    const pose = evalLayer(layer, this.ws.sceneFrame(doc));
    if (!pose) return;
    for (const [k, f] of this.fields) f.set(pose[k as 'x'] as number);
    if (this.alphaSlider && !this.gesture) this.alphaSlider.value = String(pose.alpha);
  }

  private hint() {
    return h(
      'div',
      { class: 'insp-hint' },
      h('p', null, 'Drag a prefab (reanim), particle effect or image from the library onto the stage to add it as a layer.'),
      h('p', null, 'Select an instance to edit it. Moving, rotating or scaling sets a keyframe at the current frame; frames between keyframes are tweened.'),
      h('p', null, 'Double-click an instance to edit its prefab.'),
      h('p', { class: 'dim' }, 'Space play · ←/→ frame · F6 keyframe · F7 blank keyframe · F5 insert frame · Alt+arrows nudge'),
    );
  }

  private sceneSection(doc: SceneDocument) {
    const ws = this.ws;
    const s = doc.state;
    const nameInput = h('input', {
      type: 'text',
      value: doc.name,
      class: 'wide',
      onchange: () => {
        const name = nameInput.value.trim();
        if (!name) return;
        if (name === doc.name) return;
        doc.name = uniqueSceneName(ws, name, doc);
        nameInput.value = doc.name;
        doc.path = `scenes/${name}`;
        doc.touchVersion();
        ws.emit('docs');
      },
    });
    // Always edit the live state: undo/redo swap doc.state for a snapshot, so `s` may be stale.
    const edit = (label: string, fn: (st: typeof s) => void) => {
      doc.edit(label, fn);
      ws.emit('change');
    };
    const color = h('input', { type: 'color', value: s.background, onchange: () => edit('Change background', (st) => (st.background = color.value)) });
    const presets: [string, number, number][] = [
      ['800×600 (PvZ)', 800, 600],
      ['1280×720', 1280, 720],
      ['1920×1080', 1920, 1080],
      ['512×512', 512, 512],
    ];
    return h(
      'details',
      { class: 'insp-section', open: !doc.selectedLayer },
      h('summary', null, 'Scene'),
      h('label', { class: 'field-col' }, 'Name', nameInput),
      h(
        'div',
        { class: 'insp-grid2' },
        numberField({ label: 'W', value: s.width, precision: 0, min: 16, max: 8192, title: 'Stage width (px)', onChange: (v, final) => final && edit('Resize stage', (st) => (st.width = Math.round(v))) }).el,
        numberField({ label: 'H', value: s.height, precision: 0, min: 16, max: 8192, title: 'Stage height (px)', onChange: (v, final) => final && edit('Resize stage', (st) => (st.height = Math.round(v))) }).el,
      ),
      h(
        'div',
        { class: 'insp-buttons' },
        select(
          [{ value: '', label: 'Stage size preset…' }, ...presets.map(([l, w, hh]) => ({ value: `${w}x${hh}`, label: l }))],
          '',
          (v) => {
            if (!v) return;
            const [w, hh] = v.split('x').map(Number);
            edit('Resize stage', (st) => {
              st.width = w;
              st.height = hh;
            });
          },
        ),
      ),
      h('div', { class: 'insp-key' }, h('span', { class: 'dim small' }, 'Background'), color),
      h(
        'div',
        { class: 'insp-image' },
        s.backgroundImage ? thumbnail(ws, ws.assets.resolveImage(s.backgroundImage)?.file.path ?? s.backgroundImage, 48) : h('div', { class: 'thumb empty' }, '—'),
        h(
          'div',
          { class: 'insp-image-info' },
          h('div', { class: 'mono small' }, s.backgroundImage || 'No background image'),
          h(
            'div',
            { class: 'insp-buttons' },
            h(
              'button',
              {
                class: 'btn small',
                onclick: async () => {
                  const r = await pickImage(ws, 'Stage background image (stretched to the stage)', 'reanim', doc.state.backgroundImage);
                  if (r) edit('Change background image', (st) => (st.backgroundImage = r.id));
                },
              },
              'Choose…',
            ),
            s.backgroundImage ? h('button', { class: 'btn small', onclick: () => edit('Remove background image', (st) => (st.backgroundImage = '')) }, 'Clear') : null,
          ),
        ),
      ),
      h('div', { class: 'insp-stats' }, `${s.layers.length} layers · ${s.length} frames @ ${s.fps} fps (${(s.length / s.fps).toFixed(2)} s) · ${s.soundCues.length} sound cues`),
    );
  }

  private layerSection(doc: SceneDocument) {
    const ws = this.ws;
    const li = doc.ui.layer;
    const layer = doc.state.layers[li];
    const frame = doc.ui.frame;
    const pose = evalLayer(layer, frame);
    const ki = keyIndexAt(layer, frame);
    const key = layer.keys[ki];
    const isKey = key?.frame === frame;
    const locked = doc.isLocked(li);
    const set = (patch: Partial<LayerKey>, label: string, final = true, begin = true) => {
      if (locked) {
        ws.status(`Layer "${layer.name}" is locked. Unlock it in the timeline to edit it.`);
        this.refresh(true);
        return;
      }
      if (ws.playing) ws.pause();
      doc.setKey(li, doc.ui.frame, patch, begin ? label : undefined);
      ws.emit(final ? 'change' : 'frame');
    };
    const num = (prop: 'x' | 'y' | 'rotation' | 'scaleX' | 'scaleY' | 'alpha', label: string, step: number, precision: number, title: string, min?: number, max?: number) => {
      let begun = false;
      const f = numberField({
        label,
        value: pose ? (pose[prop] as number) : 0,
        step,
        precision,
        min,
        max,
        title,
        onBegin: () => {
          begun = true;
          this.gesture = true;
        },
        onChange: (v, final) => {
          if (final) this.gesture = false;
          const patch: Partial<LayerKey> = { [prop]: v };
          if (this.uniformScale && (prop === 'scaleX' || prop === 'scaleY')) {
            const cur = evalLayer(doc.state.layers[li], doc.ui.frame);
            if (cur) {
              const other = prop === 'scaleX' ? 'scaleY' : 'scaleX';
              const ratio = cur[prop] !== 0 ? cur[other] / cur[prop] : 1;
              patch[other] = Math.round(v * ratio * 1000) / 1000;
            }
          }
          set(patch, `Change ${label}`, final, begun);
          begun = false;
        },
      });
      this.fields.set(prop, f);
      return f.el;
    };
    const nameInput = h('input', {
      type: 'text',
      value: layer.name,
      class: 'wide',
      onchange: () => {
        const name = nameInput.value.trim();
        if (name) {
          doc.edit('Rename layer', (s) => (s.layers[li].name = name));
          ws.emit('change');
        }
      },
    });

    const sourceRow =
      layer.kind === 'image'
        ? h(
            'div',
            { class: 'insp-image' },
            thumbnail(ws, ws.assets.resolveImage(layer.source)?.file.path ?? layer.source, 48),
            h(
              'div',
              { class: 'insp-image-info' },
              h('div', { class: 'mono small' }, layer.source),
              h(
                'button',
                {
                  class: 'btn small',
                  onclick: async () => {
                    const r = await pickImage(ws, 'Layer image', 'reanim', layer.source);
                    if (r) {
                      doc.edit('Change image', (s) => (s.layers[li].source = r.id));
                      ws.emit('change');
                    }
                  },
                },
                'Change image…',
              ),
            ),
          )
        : h(
            'div',
            { class: 'insp-image-info' },
            h('div', { class: 'mono small' }, layer.source, ws.assets.vfs.has(layer.source) || ws.findDocFor(layer.source) ? null : h('span', { class: 'warn' }, '  (not found)')),
            h(
              'div',
              { class: 'insp-buttons' },
              h(
                'button',
                {
                  class: 'btn small',
                  onclick: async () => {
                    const p = await pickAsset(ws, layer.kind === 'reanim' ? 'reanim' : 'particle', layer.kind === 'reanim' ? 'Swap prefab' : 'Swap particle effect');
                    if (p) {
                      doc.edit('Swap source', (s) => (s.layers[li].source = p));
                      ws.invalidatePreviews();
                      ws.emit('change');
                    }
                  },
                },
                layer.kind === 'reanim' ? 'Swap prefab…' : 'Swap effect…',
              ),
              h(
                'button',
                { class: 'btn small primary', onclick: () => void ws.editPrefab(layer.source, doc, layer) },
                layer.kind === 'reanim' ? '✎ Edit prefab' : '✎ Edit effect',
              ),
            ),
          );

    const keyRow = h(
      'div',
      { class: 'insp-key' },
      h('span', { class: `key-badge${isKey ? ' on' : ''}` }, !pose ? `Starts at ${layer.keys[0].frame}` : isKey ? `◆ Key @ ${frame}` : `Tween (key @ ${key?.frame})`),
      h(
        'button',
        {
          class: 'btn small',
          // The first key is where the layer starts; it can be moved but not removed.
          disabled: locked || (isKey && ki === 0),
          title: isKey && ki === 0 ? 'The first keyframe is where the layer starts' : undefined,
          onclick: () => {
            // Act on the current frame, not the one this panel was built for.
            if (ws.playing) ws.pause();
            doc.toggleKey(li, doc.ui.frame);
            ws.emit('change');
          },
        },
        isKey ? 'Remove key' : 'Make key',
      ),
      key
        ? select(
            EASES.map((e) => ({ value: e.id, label: e.label })),
            key.ease,
            (v) => {
              if (locked) return set({}, 'Set easing');
              if (ws.playing) ws.pause();
              doc.setEase(li, doc.ui.frame, v);
              ws.emit('change');
            },
            `Tween from key ${key.frame} to the next key`,
          )
        : null,
    );

    if (!pose) {
      return h(
        'section',
        { class: 'insp-section' },
        h('h3', null, layer.name),
        sourceRow,
        h('p', { class: 'dim' }, `This layer appears at frame ${layer.keys[0].frame}. Move the playhead there, or add a key here.`),
        keyRow,
      );
    }

    const tint = h('input', { type: 'color', value: toHex(pose.tint), title: 'Tint (color multiply)', onchange: () => set({ tint: fromHex(tint.value) }, 'Change tint') });
    let alphaBegun = false;
    const alpha = h('input', {
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01,
      value: pose.alpha,
      class: 'alpha-slider',
      onpointerdown: () => {
        alphaBegun = false;
        this.gesture = true;
      },
      oninput: () => {
        set({ alpha: parseFloat(alpha.value) }, 'Change alpha', false, !alphaBegun);
        alphaBegun = true;
      },
      onchange: () => {
        this.gesture = false;
        ws.emit('change');
      },
    });
    this.alphaSlider = alpha;

    const sections: (HTMLElement | null)[] = [
      h(
        'section',
        { class: 'insp-section' },
        h('h3', null, layer.kind === 'reanim' ? '▶ Prefab instance' : layer.kind === 'particle' ? '✦ Particle effect' : '▣ Image', locked ? h('span', { class: 'dim small' }, '  🔒 locked') : null),
        h('label', { class: 'field-col' }, 'Layer name', nameInput),
        sourceRow,
        keyRow,
        h('div', { class: 'insp-grid2' }, num('x', 'X', 1, 1, 'Stage X (px)'), num('y', 'Y', 1, 1, 'Stage Y (px)')),
        h('div', { class: 'insp-grid2' }, num('rotation', 'Rotation', 1, 2, 'Degrees, clockwise'), checkbox('Flip horizontally', pose.flipX, (v) => {
            if (locked) return set({}, 'Flip');
            if (ws.playing) ws.pause();
            this.hooks.flip(doc, li, v);
            ws.emit('change');
          })),
        h('div', { class: 'insp-grid2' }, num('scaleX', 'Scale X', 0.01, 3, 'Horizontal scale'), num('scaleY', 'Scale Y', 0.01, 3, 'Vertical scale')),
        checkbox('Uniform scale', this.uniformScale, (v) => {
          this.uniformScale = v;
          this.refresh(true);
        }),
        h('div', { class: 'insp-alpha' }, num('alpha', 'Alpha', 0.01, 3, 'Opacity 0..1', 0, 1), alpha),
        h(
          'div',
          { class: 'insp-key' },
          h('span', { class: 'dim small' }, 'Tint'),
          tint,
          h('button', { class: 'btn small', onclick: () => set({ tint: [1, 1, 1] }, 'Reset tint') }, 'Reset'),
          checkbox('Visible', pose.visible, (v) => set({ visible: v }, v ? 'Show layer' : 'Hide layer')),
        ),
      ),
    ];

    if (layer.kind === 'reanim') {
      const prefab = ws.prefab(layer.source);
      const ranges = prefab ? getAnimRanges(prefab.tracks) : [];
      const animOptions = [{ value: '', label: '(all frames)' }, ...ranges.map((r) => ({ value: r.name, label: `${r.name} (${r.end - r.start + 1} frames)` }))];
      if (key && key.anim && !ranges.some((r) => r.name === key.anim)) animOptions.push({ value: key.anim, label: `${key.anim} (missing)` });
      sections.push(
        h(
          'section',
          { class: 'insp-section' },
          h('h3', null, 'Animation'),
          h('p', { class: 'dim small' }, 'Which of the prefab\'s animations plays from this key (like a graphic symbol\'s looping options).'),
          h('label', { class: 'field-col' }, 'Animation', select(animOptions, key?.anim ?? '', (v) => set({ anim: v, startFrame: 0 }, 'Change animation'))),
          h(
            'label',
            { class: 'field-col' },
            'Playback',
            select(
              INSTANCE_LOOPS.map((l) => ({ value: l.id, label: l.label })),
              key?.loop ?? 'loop',
              (v) => set({ loop: v }, 'Change playback'),
            ),
          ),
          h(
            'div',
            { class: 'insp-grid2' },
            numberField({ label: 'Speed', value: key?.speed ?? 1, step: 0.05, precision: 2, min: 0, max: 20, title: 'Playback speed multiplier', onChange: (v, final) => final && set({ speed: v }, 'Change speed') }).el,
            numberField({ label: 'First frame', value: key?.startFrame ?? 0, precision: 0, min: 0, max: 10000, title: 'Frame offset into the animation (the shown frame for Single frame)', onChange: (v, final) => final && set({ startFrame: Math.round(v) }, 'Change first frame') }).el,
          ),
          checkbox('Restart animation at this key', !!(isKey && key?.restart), (v) => set({ restart: v }, 'Toggle restart'), 'Restart even if the settings did not change'),
        ),
      );
    } else if (layer.kind === 'particle') {
      sections.push(
        h(
          'section',
          { class: 'insp-section' },
          h('h3', null, 'Effect'),
          h('p', { class: 'dim small' }, 'The effect starts when the layer appears (or is shown again) and is simulated in step with the timeline.'),
          checkbox('Restart effect at this key', !!(isKey && key?.restart), (v) => set({ restart: v }, 'Toggle restart')),
        ),
      );
    }
    return h('div', null, ...sections);
  }

  private cueSection(doc: SceneDocument) {
    const ws = this.ws;
    const cue = doc.state.soundCues.find((c) => c.uid === doc.ui.cue?.uid);
    if (!cue) return this.hint();
    return h(
      'section',
      { class: 'insp-section' },
      h('h3', null, '♪ Sound cue'),
      h('div', { class: 'mono small' }, cue.sound),
      ws.assets.resolveSound(cue.sound) ? null : h('div', { class: 'warn small' }, 'Sound not found in loaded files'),
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
        numberField({ label: 'Frame', value: cue.frame, precision: 0, min: 0, max: doc.state.length - 1, onChange: (v, final) => final && (doc.updateSoundCue(cue.uid, { frame: Math.round(v) }, 'Move sound cue'), ws.emit('change')) }).el,
        numberField({ label: 'Volume', value: cue.volume, step: 0.05, precision: 2, min: 0, max: 4, onChange: (v, final) => final && (doc.updateSoundCue(cue.uid, { volume: v }, 'Change volume'), ws.emit('change')) }).el,
      ),
      h('button', { class: 'btn small danger', onclick: () => (doc.removeSoundCue(cue.uid), ws.emit('change')) }, 'Delete cue'),
    );
  }
}
