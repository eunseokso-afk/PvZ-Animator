/** Right-hand panel for scenes: stage settings, the selected layer's keyframe properties, sound cues. */

import { getAnimRanges } from '../formats/reanim';
import { CURVE_PRESETS, curveForEase, reverseCurve, type EaseCurve } from '../editor/easeCurve';
import { CAMERA_PRESETS, cameraLayer, evalLayer, INSTANCE_LOOPS, keyIndexAt, SCENE_EASES, type KeyRef, type LayerKey, type LayerPose, type SceneDocument, type SceneEase } from '../editor/sceneDoc';
import type { Workspace } from '../editor/workspace';
import { h, rafThrottle } from './dom';
import { uniqueSceneName } from './exporters';
import { fontInput, pickAsset, pickImage, previewSound, thumbnail } from './pickers';
import { CurveEditor } from './curveEditor';
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
  /** Number fields showing the selected layer's tweened values, updated in place as the playhead moves. */
  private fields = new Map<string, { field: NumberField; get(p: LayerPose): number }>();
  private alphaSlider: { el: HTMLInputElement; get(p: LayerPose): number } | null = null;
  /** A scrub or slider drag is in progress: update values in place, never rebuild under the pointer. */
  private gesture = false;
  /** A tween preview is playing (requestAnimationFrame id). */
  private previewing = 0;
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
    const targets = this.easeTargets(doc);
    const sig = [
      doc.id,
      this.ws.playing || this.previewing ? 'playing' : frame,
      doc.ui.layer,
      [...doc.ui.extra].join(),
      // The easing section shows the tweens it edits.
      targets.map((t) => {
        const l = doc.state.layers[t.layer];
        const k = l?.keys[keyIndexAt(l, t.frame)];
        const n = l?.keys[keyIndexAt(l, t.frame) + 1];
        return `${l?.uid}:${k?.frame}:${k?.ease}:${n?.frame}:${n?.visible}:${k?.ease === 'custom' ? JSON.stringify(k.curve) : ''}:${l && doc.ui.locked.has(l.uid)}`;
      }).join(),
      layer?.uid,
      layer?.name,
      layer?.source,
      layer?.keys.length,
      ki,
      layer && doc.ui.locked.has(layer.uid),
      key && JSON.stringify({ ...key, x: 0, y: 0, rotation: 0, scaleX: 0, scaleY: 0, alpha: 0, shake: 0 }),
      // The camera's follow list names the other layers.
      layer?.kind === 'camera' ? doc.state.layers.map((l) => `${l.uid}:${l.name}`).join() : '',
      doc.ui.cameraView,
      !!cameraLayer(s),
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
    this.el.replaceChildren(
      this.sceneSection(doc),
      doc.ui.cue ? this.cueSection(doc) : doc.selectedLayers().length > 1 ? this.multiSection(doc) : layer ? this.layerSection(doc) : this.hint(),
    );
    this.el.scrollTop = scroll;
  }

  private updateValues(doc: SceneDocument) {
    const layer = doc.selectedLayer;
    if (!layer) return;
    const pose = evalLayer(layer, this.ws.sceneFrame(doc), doc.state);
    if (!pose) return;
    for (const f of this.fields.values()) f.field.set(f.get(pose));
    if (this.alphaSlider && !this.gesture) this.alphaSlider.el.value = String(this.alphaSlider.get(pose));
  }

  private hint() {
    return h(
      'div',
      { class: 'insp-hint' },
      h('p', null, 'Drag a prefab (reanim), particle effect or image from the library onto the stage to add it as a layer.'),
      h('p', null, 'Select an instance to edit it. Moving, rotating or scaling sets a keyframe at the current frame; frames between keyframes are tweened.'),
      h('p', null, 'Double-click an instance to edit its prefab. Shift-click or drag a rectangle to select several layers; drag across the timeline to select keyframes and ease them together.'),
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
      h(
        'div',
        { class: 'insp-buttons' },
        h(
          'button',
          {
            class: 'btn small',
            title: 'A camera pans, zooms and turns the view; exports and bakes see what it sees',
            onclick: () => {
              doc.selectOnly(doc.addCamera());
              ws.emit('change');
            },
          },
          cameraLayer(s) ? '🎥 Select camera' : '🎥 Add camera',
        ),
        cameraLayer(s) ? checkbox('Look through camera (C)', doc.ui.cameraView, (v) => ((doc.ui.cameraView = v), ws.emit('change'))) : null,
      ),
      h('div', { class: 'insp-stats' }, `${s.layers.length} layers · ${s.length} frames @ ${s.fps} fps (${(s.length / s.fps).toFixed(2)} s) · ${s.soundCues.length} sound cues`),
    );
  }

  private layerSection(doc: SceneDocument) {
    const ws = this.ws;
    const li = doc.ui.layer;
    const layer = doc.state.layers[li];
    const frame = doc.ui.frame;
    const pose = evalLayer(layer, frame, doc.state);
    const isCamera = layer.kind === 'camera';
    const ki = keyIndexAt(layer, frame);
    const key = layer.keys[ki];
    const isKey = key?.frame === frame;
    const locked = doc.isLocked(li);
    const set = (patch: Partial<LayerKey>, label: string, final = true, begin = true) => {
      // Check the lock now, not when the panel was built.
      if (doc.isLocked(li)) {
        ws.status(`Layer "${layer.name}" is locked. Unlock it in the timeline to edit it.`);
        this.refresh(true);
        return;
      }
      if (ws.playing) ws.pause();
      doc.setKey(li, doc.ui.frame, patch, begin ? label : undefined);
      ws.emit(final ? 'change' : 'frame');
    };
    /** A live number field; `toKey`/`fromPose` convert between what it shows and what keys hold. */
    const field = (
      name: string,
      label: string,
      step: number,
      precision: number,
      title: string,
      fromPose: (p: LayerPose) => number,
      toKey: (v: number) => Partial<LayerKey>,
      min?: number,
      max?: number,
    ) => {
      let begun = false;
      const f = numberField({
        label,
        value: pose ? fromPose(pose) : 0,
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
          set(toKey(v), `Change ${label}`, final, begun);
          begun = false;
        },
      });
      this.fields.set(name, { field: f, get: fromPose });
      f.input.disabled = locked;
      return f.el;
    };
    const num = (prop: 'x' | 'y' | 'rotation' | 'scaleX' | 'scaleY' | 'alpha' | 'shake', label: string, step: number, precision: number, title: string, min?: number, max?: number) => {
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
      this.fields.set(prop, { field: f, get: (p) => p[prop] });
      f.input.disabled = locked;
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

    const textInput =
      layer.kind === 'text'
        ? h('input', {
            type: 'text',
            class: 'wide',
            value: pose?.key.text ?? '',
            disabled: locked,
            placeholder: 'Type the words…',
            onchange: (e: Event) => set({ text: (e.target as HTMLInputElement).value }, 'Change text'),
          })
        : null;
    const sourceRow = isCamera
      ? h(
          'div',
          { class: 'form-col' },
          checkbox('Look through the camera (C)', doc.ui.cameraView, (v) => ((doc.ui.cameraView = v), ws.emit('change')), 'Off: see the whole world with the camera’s frame, to place and size it'),
          h('p', { class: 'dim small' }, 'The frame is what the stage shows: move it to pan, size it to zoom, turn it to rotate. Exports and bakes see what the camera sees.'),
        )
      : layer.kind === 'text'
        ? h(
            'div',
            { class: 'form-col' },
            h('label', { class: 'field-col' }, 'Text (changes at keys)', textInput),
            h(
              'label',
              { class: 'field-col' },
              'Font',
              fontInput(ws, layer.source, (font) => {
                if (!font || font === layer.source) return;
                if (doc.isLocked(li)) return set({}, 'Change font');
                doc.edit('Change font', (s) => (s.layers[li].source = font));
                ws.emit('change');
              }),
            ),
          )
        : layer.kind === 'image'
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
                  disabled: locked,
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
                  disabled: locked,
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
      h('span', { class: `key-badge${isKey && !ws.playing ? ' on' : ''}` }, ws.playing ? 'Playing…' : !pose ? `Starts at ${layer.keys[0].frame}` : isKey ? `◆ Key @ ${frame}` : `Tween (key @ ${key?.frame})`),
      h(
        'button',
        {
          class: 'btn small',
          // The first key is where the layer starts; it can be moved but not removed.
          // (Disabled while playing: the panel is not rebuilt every frame, so the label would be stale.)
          disabled: ws.playing || locked || (isKey && ki === 0),
          title: isKey && ki === 0 ? 'The first keyframe is where the layer starts' : undefined,
          onclick: () => {
            // Act on the current frame, not the one this panel was built for.
            if (doc.isLocked(li)) return set({}, 'Toggle key');
            if (ws.playing) ws.pause();
            doc.toggleKey(li, doc.ui.frame);
            ws.emit('change');
          },
        },
        isKey ? 'Remove key' : 'Make key',
      ),
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

    const tint = h('input', {
      type: 'color',
      value: toHex(pose.tint),
      title: isCamera ? 'Colour filter: multiplies everything the camera sees' : 'Tint (color multiply)',
      onchange: () => set({ tint: fromHex(tint.value) }, isCamera ? 'Change colour filter' : 'Change tint'),
    });
    // A camera's alpha is how much of the scene shows: the slider is its fade to black.
    const sliderOf = (p: LayerPose) => (isCamera ? 1 - p.alpha : p.alpha);
    let alphaBegun = false;
    const alpha = h('input', {
      type: 'range',
      min: 0,
      max: 1,
      step: 0.01,
      value: sliderOf(pose),
      class: 'alpha-slider',
      title: isCamera ? 'Fade to black' : 'Opacity',
      onpointerdown: () => {
        alphaBegun = false;
        this.gesture = true;
      },
      oninput: () => {
        const v = parseFloat(alpha.value);
        set({ alpha: isCamera ? 1 - v : v }, isCamera ? 'Change fade' : 'Change alpha', false, !alphaBegun);
        alphaBegun = true;
      },
      onchange: () => {
        this.gesture = false;
        ws.emit('change');
      },
    });
    this.alphaSlider = { el: alpha, get: sliderOf };
    const following = isCamera && !!key?.follow;

    const sections: (HTMLElement | null)[] = [
      h(
        'section',
        { class: 'insp-section' },
        h('h3', null, layer.kind === 'reanim' ? '▶ Prefab instance' : layer.kind === 'particle' ? '✦ Particle effect' : layer.kind === 'text' ? 'T Text' : isCamera ? '🎥 Camera' : '▣ Image', locked ? h('span', { class: 'dim small' }, '  🔒 locked') : null),
        h('label', { class: 'field-col' }, 'Layer name', nameInput),
        sourceRow,
        keyRow,
        h(
          'div',
          { class: 'insp-grid2' },
          num('x', following ? 'Offset X' : 'X', 1, 1, following ? 'Offset from the followed layer (px)' : isCamera ? 'Centre of the view, stage X (px)' : 'Stage X (px)'),
          num('y', following ? 'Offset Y' : 'Y', 1, 1, following ? 'Offset from the followed layer (px)' : isCamera ? 'Centre of the view, stage Y (px)' : 'Stage Y (px)'),
        ),
        isCamera
          ? h(
              'div',
              { class: 'insp-grid2' },
              field('zoom', 'Zoom', 0.01, 3, '2 = everything twice as big', (p) => 1 / Math.max(1e-3, Math.abs(p.scaleX)), (v) => ({ scaleX: 1 / v, scaleY: 1 / v }), 0.05, 20),
              num('rotation', 'Rotation', 1, 2, 'Degrees the camera turns, clockwise (the world turns the other way)'),
            )
          : h('div', { class: 'insp-grid2' }, num('rotation', 'Rotation', 1, 2, 'Degrees, clockwise'), checkbox('Flip horizontally', pose.flipX, (v) => {
              if (doc.isLocked(li)) return set({}, 'Flip');
              if (ws.playing) ws.pause();
              this.hooks.flip(doc, li, v);
              ws.emit('change');
            })),
        isCamera ? null : h('div', { class: 'insp-grid2' }, num('scaleX', 'Scale X', 0.01, 3, 'Horizontal scale'), num('scaleY', 'Scale Y', 0.01, 3, 'Vertical scale')),
        isCamera
          ? null
          : checkbox('Uniform scale', this.uniformScale, (v) => {
              this.uniformScale = v;
              this.refresh(true);
            }),
        h(
          'div',
          { class: 'insp-alpha' },
          isCamera ? field('fade', 'Fade', 0.01, 3, 'Fade to black: 0 clear, 1 black', (p) => 1 - p.alpha, (v) => ({ alpha: 1 - v }), 0, 1) : num('alpha', 'Alpha', 0.01, 3, 'Opacity 0..1', 0, 1),
          alpha,
        ),
        h(
          'div',
          { class: 'insp-key' },
          h('span', { class: 'dim small' }, layer.kind === 'text' ? 'Color' : isCamera ? 'Colour filter' : 'Tint'),
          tint,
          h('button', { class: 'btn small', onclick: () => set({ tint: [1, 1, 1] }, isCamera ? 'Reset colour filter' : 'Reset tint') }, 'Reset'),
          isCamera
            ? checkbox('Camera on', pose.visible, (v) => set({ visible: v }, v ? 'Camera on' : 'Camera off'), 'Off (a blank keyframe): the stage shows the world without the camera')
            : checkbox('Visible', pose.visible, (v) => set({ visible: v }, v ? 'Show layer' : 'Hide layer')),
        ),
      ),
    ];

    sections.push(this.easingSection(doc, this.easeTargets(doc)));

    if (isCamera) {
      const others = doc.state.layers.filter((l) => l.kind !== 'camera');
      const followOptions = [{ value: '0', label: 'Nothing (free camera)' }, ...others.map((l) => ({ value: String(l.uid), label: l.name }))];
      if (key?.follow && !others.some((l) => l.uid === key.follow)) followOptions.push({ value: String(key.follow), label: '(deleted layer)' });
      const followSelect = select(followOptions, String(key?.follow ?? 0), (v) => {
        if (doc.isLocked(li)) return set({}, 'Follow layer');
        if (ws.playing) ws.pause();
        doc.setCameraFollow(li, doc.ui.frame, Number(v));
        ws.emit('change');
      }, 'Keep a layer in view from this key on (its position is added to the camera’s)');
      followSelect.disabled = locked;
      sections.push(
        h(
          'section',
          { class: 'insp-section' },
          h('h3', null, 'Camera moves'),
          h('div', { class: 'insp-grid2' }, num('shake', 'Shake', 1, 1, 'Shake strength in stage px (tweens, so a key with 0 settles it)', 0, 200), h('span')),
          h('label', { class: 'field-col' }, 'Follow', followSelect),
          h('p', { class: 'dim small' }, 'Presets start from the camera at the playhead (Static holds it still until the next key).'),
          h(
            'div',
            { class: 'insp-buttons' },
            CAMERA_PRESETS.map((p) =>
              h(
                'button',
                {
                  class: 'btn small',
                  title: p.title,
                  disabled: locked,
                  onclick: () => {
                    if (doc.isLocked(li)) return set({}, p.label);
                    if (ws.playing) ws.pause();
                    if (doc.cameraPreset(li, doc.ui.frame, p.id)) ws.status(`Camera: ${p.label}`);
                    ws.emit('change');
                  },
                },
                p.label,
              ),
            ),
          ),
        ),
      );
    }

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

  /** The tweens the easing controls edit: the selected keys, or the selected layers' tweens at the playhead. */
  private easeTargets(doc: SceneDocument): KeyRef[] {
    const keys = doc.selectedKeys();
    if (keys.length) return keys;
    return doc.selectedLayers().map((layer) => ({ layer, frame: doc.ui.frame }));
  }

  /** Easing of the tweens in `targets`: a built-in ease, a preset or a hand-drawn curve. */
  private easingSection(doc: SceneDocument, all: KeyRef[]) {
    const ws = this.ws;
    const targets = all.filter((t) => !doc.isLocked(t.layer));
    // The curve shown is the main layer's (or the first target's).
    const ref = targets.find((t) => t.layer === doc.ui.layer) ?? targets[0] ?? all[0];
    const layer = ref && doc.state.layers[ref.layer];
    const ki = layer ? keyIndexAt(layer, ref.frame) : -1;
    const key = layer?.keys[ki];
    const next = layer?.keys[ki + 1];
    const tweens = (t: KeyRef) => {
      const l = doc.state.layers[t.layer];
      const i = keyIndexAt(l, t.frame);
      const n = l.keys[i + 1];
      return i >= 0 && !!n && n.visible;
    };
    const live = targets.filter(tweens);
    const section = h('section', { class: 'insp-section insp-easing' });
    const title = h('h3', null, 'Easing');
    section.append(title);
    if (!key || !layer) {
      section.append(h('p', { class: 'dim small' }, 'Nothing here yet.'));
      return section;
    }
    const isCamera = layer.kind === 'camera';
    const many = targets.length > 1;
    title.append(
      h('span', { class: 'dim small' }, many ? `  ${live.length} tween${live.length === 1 ? '' : 's'}` : next ? `  key ${key.frame} → ${next.frame}` : `  from key ${key.frame}`),
    );
    const locked = !targets.length;
    const curveOf = (k: LayerKey): EaseCurve => (k.ease === 'custom' && k.curve ? k.curve : curveForEase(k.ease));
    let begun = false;
    const apply = (ease: SceneEase, curve: EaseCurve | null, label: string, final: boolean) => {
      if (ws.playing) ws.pause();
      doc.setEases(targets, ease, curve, begun ? null : label);
      begun = !final;
      ws.emit(final ? 'change' : 'frame');
    };
    const editor = new CurveEditor(curveOf(key), {
      height: 170,
      onBegin: () => {
        begun = false;
        this.gesture = true;
      },
      onChange: (c, final) => {
        if (final) this.gesture = false;
        apply('custom', c, 'Edit easing curve', final);
      },
    });
    editor.set(curveOf(key), key.ease === 'hold');
    editor.setDisabled(locked || !live.length);

    const easeSelect = select(
      SCENE_EASES.map((e) => ({ value: e.id, label: e.id === 'hold' && isCamera ? 'Static (hold until next key)' : e.id === 'custom' ? 'Custom curve' : e.label })),
      key.ease,
      (v) => {
        begun = false;
        apply(v, null, 'Set easing', true);
      },
      many ? 'Easing of every selected tween' : `Tween from key ${key.frame} to the next key`,
    );
    easeSelect.disabled = locked;
    const presetSelect = select(
      [{ value: '', label: 'Curve preset…' }, ...CURVE_PRESETS.map((p) => ({ value: p.id, label: p.label }))],
      '',
      (v) => {
        const p = CURVE_PRESETS.find((x) => x.id === v);
        presetSelect.value = '';
        if (!p) return;
        begun = false;
        apply('custom', p.curve, `Easing: ${p.label}`, true);
      },
      'Start from a ready-made curve',
    );
    presetSelect.disabled = locked;
    section.append(
      h('div', { class: 'insp-grid2' }, easeSelect, presetSelect),
      editor.el,
      h(
        'div',
        { class: 'insp-buttons' },
        h(
          'button',
          {
            class: 'btn small',
            disabled: locked,
            title: 'Play the curve backwards (an ease-in becomes an ease-out)',
            onclick: () => {
              begun = false;
              apply('custom', reverseCurve(editor.value), 'Reverse easing', true);
            },
          },
          '⇄ Reverse',
        ),
        h(
          'button',
          {
            class: 'btn small',
            disabled: !live.length,
            title: 'Play this tween on the stage',
            onclick: () => this.previewTween(doc, ref, editor),
          },
          '▶ Preview',
        ),
      ),
      h(
        'p',
        { class: 'dim small' },
        !live.length
          ? 'No tween from this key yet: add a key further along the layer to ease into it.'
          : `${many ? 'Applies to every selected tween. ' : ''}Drag points and handles; double-click the curve to add a point, a point to remove it. Alt breaks a point’s handles.`,
      ),
    );
    return section;
  }

  /** Play one tween on the stage, with a marker running along its curve. */
  private previewTween(doc: SceneDocument, ref: KeyRef, editor: CurveEditor) {
    const ws = this.ws;
    const layer = doc.state.layers[ref.layer];
    const i = layer ? keyIndexAt(layer, ref.frame) : -1;
    const a = layer?.keys[i];
    const b = layer?.keys[i + 1];
    if (!a || !b) return;
    if (ws.playing) ws.pause();
    cancelAnimationFrame(this.previewing);
    const from = a.frame;
    const span = b.frame - a.frame;
    const ms = (span / doc.state.fps) * 1000;
    const start = performance.now();
    const stop = () => {
      cancelAnimationFrame(this.previewing);
      this.previewing = 0;
      window.removeEventListener('pointerdown', stop, true);
      editor.setMarker(null);
      ws.emit('change');
    };
    window.addEventListener('pointerdown', stop, true);
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      ws.setFrame(Math.round(from + t * span));
      editor.setMarker(t);
      if (t < 1 && ws.scene === doc) this.previewing = requestAnimationFrame(step);
      else setTimeout(stop, 250);
    };
    this.previewing = requestAnimationFrame(step);
  }

  /** Several layers are selected: what applies to all of them. */
  private multiSection(doc: SceneDocument) {
    const ws = this.ws;
    const sel = doc.selectedLayers();
    const names = sel.map((i) =>
      h(
        'button',
        {
          class: `chip${i === doc.ui.layer ? ' on' : ''}`,
          title: 'Edit only this layer',
          onclick: () => {
            doc.selectOnly(i);
            ws.emit('change');
          },
        },
        doc.state.layers[i].name,
      ),
    );
    const anyLocked = sel.some((i) => doc.isLocked(i));
    return h(
      'div',
      null,
      h(
        'section',
        { class: 'insp-section' },
        h('h3', null, `${sel.length} layers selected`),
        h('div', { class: 'chip-row' }, names),
        h(
          'div',
          { class: 'insp-buttons' },
          h('button', { class: 'btn small', title: 'Keyframe every selected layer at the playhead (F6)', onclick: () => this.multiAction('key') }, '◆ Key all'),
          h('button', { class: 'btn small', title: 'Duplicate the selected layers (Ctrl+D)', onclick: () => this.multiAction('duplicate') }, 'Duplicate'),
          h('button', { class: 'btn small danger', disabled: anyLocked, title: 'Delete the selected layers (Del)', onclick: () => this.multiAction('delete') }, 'Delete'),
        ),
        h('p', { class: 'dim small' }, 'Drag any of them on the stage to move them together; Alt+arrows nudge them all. Shift-click (stage or timeline) adds or removes a layer.'),
      ),
      this.easingSection(doc, this.easeTargets(doc)),
    );
  }

  /** Multi-selection actions are the app's (they share the keyboard shortcuts' code). */
  multiAction: (action: 'key' | 'duplicate' | 'delete') => void = () => {};

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
