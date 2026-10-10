/** Editable particle-effect document (snapshot-based undo; definitions are small). */

import { createEmitter, type EmitterDefinition, type ParticleDefinition } from '../formats/particles';
import { DocumentBase } from './reanimDoc';

export interface ParticleUiState {
  emitter: number;
  /** Preview emitter position in world space. */
  x: number;
  y: number;
  playing: boolean;
  speed: number;
  autoRestart: boolean;
  showGuides: boolean;
}

export function cloneDefinition(def: ParticleDefinition): ParticleDefinition {
  return {
    emitters: def.emitters.map((e) => ({
      ...e,
      flags: { ...e.flags },
      tracks: { ...e.tracks },
      fields: e.fields.map((f) => ({ ...f })),
      systemFields: e.systemFields.map((f) => ({ ...f })),
      extra: e.extra.map((x) => ({ ...x })),
    })),
  };
}

export class ParticleDocument extends DocumentBase<ParticleDefinition> {
  readonly kind = 'particle' as const;
  ui: ParticleUiState = { emitter: 0, x: 0, y: 0, playing: true, speed: 1, autoRestart: true, showGuides: true };
  /** Bumped whenever the definition changes, so previews can restart. */
  revision = 0;

  static create(name: string, path: string): ParticleDocument {
    const em = createEmitter(name);
    em.tracks.SpawnRate = '40';
    em.tracks.SystemDuration = '200';
    em.tracks.ParticleDuration = '[60 100]';
    em.tracks.LaunchSpeed = '[60 140]';
    em.tracks.LaunchAngle = '[150 210]';
    em.tracks.ParticleAlpha = '1,70 0';
    em.tracks.ParticleScale = '[.6 1]';
    em.flags.SystemLoops = true;
    em.fields.push({ type: 'Acceleration', x: '', y: '200' });
    return new ParticleDocument(name, path, { emitters: [em] }, true);
  }

  static fromDefinition(def: ParticleDefinition, name: string, path: string): ParticleDocument {
    return new ParticleDocument(name, path, def, false);
  }

  get def(): ParticleDefinition {
    return this.state;
  }

  get emitter(): EmitterDefinition | undefined {
    return this.state.emitters[this.ui.emitter];
  }

  protected snapshot(): ParticleDefinition {
    return cloneDefinition(this.state);
  }

  protected afterRestore(): void {
    this.revision++;
    if (this.ui.emitter >= this.state.emitters.length) this.ui.emitter = Math.max(0, this.state.emitters.length - 1);
  }

  /** Apply a change to the selected emitter with an undo step. */
  editEmitter(label: string, fn: (e: EmitterDefinition) => void, index = this.ui.emitter): void {
    const e = this.state.emitters[index];
    if (!e) return;
    this.checkpoint(label);
    fn(this.state.emitters[index]);
    this.revision++;
  }

  addEmitter(): void {
    this.checkpoint('Add emitter');
    const e = createEmitter(`Emitter${this.state.emitters.length + 1}`);
    e.tracks.SpawnRate = '20';
    e.tracks.ParticleDuration = '100';
    e.tracks.LaunchSpeed = '[40 80]';
    e.tracks.ParticleAlpha = '1,70 0';
    e.flags.SystemLoops = true;
    e.tracks.SystemDuration = '200';
    this.state.emitters.push(e);
    this.ui.emitter = this.state.emitters.length - 1;
    this.revision++;
  }

  duplicateEmitter(index: number): void {
    const src = this.state.emitters[index];
    if (!src) return;
    this.checkpoint('Duplicate emitter');
    const copy = cloneDefinition({ emitters: [src] }).emitters[0];
    copy.name = src.name + ' copy';
    this.state.emitters.splice(index + 1, 0, copy);
    this.ui.emitter = index + 1;
    this.revision++;
  }

  removeEmitter(index: number): void {
    if (this.state.emitters.length <= 1 || !this.state.emitters[index]) return;
    this.checkpoint('Delete emitter');
    this.state.emitters.splice(index, 1);
    this.ui.emitter = Math.min(this.ui.emitter, this.state.emitters.length - 1);
    this.revision++;
  }

  moveEmitter(from: number, to: number): void {
    const list = this.state.emitters;
    if (from === to || !list[from] || to < 0 || to >= list.length) return;
    this.checkpoint('Reorder emitters');
    const [e] = list.splice(from, 1);
    list.splice(to, 0, e);
    this.ui.emitter = to;
    this.revision++;
  }
}
