# PvZ Animator

A browser-based animation studio for **Plants vs. Zombies**. Open the game's `main.pak`, edit
PopCap **reanim** animations and **TodParticle** effects, sync them with sounds, and write the result
back as `.reanim` / particle `.xml` files or a rebuilt `main.pak`.

Everything runs locally in your browser. Game files are never uploaded anywhere, and none are
included in this repository.

## Features

**Game data**
- Opens `main.pak` directly (PopCap PAK, XOR `0xF7`) without extracting it, or an extracted game folder.
- Resolves image ids the way the game does: `properties/resources.xml` entries,
  `IMAGE_REANIM_*` → `reanim/`, `IMAGE_*` → `particles/` / `images/`, JPEG alpha masks (`_name.png`).
- Reads reanim XML and compiled reanims (`compiled/reanim/*.reanim.compiled`).
- Plays `.ogg`, `.wav`, `.mp3` and the game's `.au` sounds (custom decoder).
- Asset browser with thumbnails, search, sound preview and drag-and-drop.

**Reanim editor**
- WebGL preview that matches the game's transform math (`x`, `y`, `kx`/`ky` skew, `sx`/`sy`, alpha,
  `f` visibility) and loop modes, including `attacher__` tracks.
- Direct manipulation: click a part to select it, drag to move, corner handles to scale, top handle to
  rotate (Shift snaps to 15°), Alt+arrows to nudge.
- Keyframes on top of the game's baked per-frame data: tweens between keys with linear / ease-in /
  ease-out / ease-in-out / hold. Opening a file detects existing tweens, and keys always stay at
  animation-range edges so edits never leak into another animation.
- Timeline with animation ranges (`anim_*` tracks) you can create, rename and resize by dragging,
  onion skinning, frame insert/delete, key moving, copy/paste pose, and undo/redo.
- **Sound cues**: place sounds on the timeline (with waveforms) and hear them during playback.
- **Particle cues**: attach particle effects to a frame and optionally to a part so they follow it.

**Particle editor**
- Edits every emitter property: float tracks (`5`, `[min max]`, `1,80 0`, `EaseIn 0 1` …) with live
  validation and curve previews, flags, emitter shapes, image strips, particle and system fields.
- Live simulation at the game's 100 ticks/s, emitter-shape overlay and a draggable emitter.

**Export**
- `.reanim` (PopCap delta-encoded XML) and particle `.xml`.
- **Build main.pak**: merges your edited documents and imported files into a copy of `main.pak`, and
  drops stale compiled caches so the game recompiles your XML.
- WebM video with sound, PNG frame sequence (ZIP) or sprite sheet.
- Project files (`.pvzanim.json`) holding open documents, keyframes, cues and imported assets.

## Getting started

```bash
npm install
npm run dev        # http://localhost:5173
```

Then click **Open main.pak** and pick the file from your PvZ install folder (for example
`C:\Program Files (x86)\Steam\steamapps\common\Plants vs. Zombies\main.pak`). No game handy?
**Try demo assets** loads a small procedurally drawn plant, a particle effect and two sounds.

Build a static site (deployable to any static host, e.g. GitHub Pages):

```bash
npm run build      # outputs dist/
npm run preview
```

Other scripts: `npm test` (unit tests), `npm run typecheck`.

## Workflow

1. **Load** `main.pak` (or drop it, a game folder, images or sounds onto the window).
2. **Open** a reanim (e.g. `PeaShooterSingle.reanim`) or a particle file from the asset browser.
3. **Animate**: pick an animation range at the top of the timeline, select a part, move to a frame and
   drag the part. Changing a frame makes it a key; frames between keys are tweened.
4. **Add sound**: import sounds with **♪ Sounds** (or use the game's), then drag one onto the
   *Sound cues* lane. Particle effects go onto the *Particle cues* lane, or onto a part on the stage to
   follow it.
5. **Export**: `Ctrl+E` for the single file, **Build main.pak** for a ready-to-use archive (back up the
   original first), or File → Export video for a preview with sound.

### Keyboard shortcuts

| Keys | Action |
| --- | --- |
| Space | Play / pause |
| ← → or , . | Previous / next frame |
| Home / End | First / last frame of the animation |
| ↑ ↓ | Select part above / below |
| Alt + arrows | Nudge part 1 px (Shift: 10 px) |
| K | Toggle key |
| Shift+I / Shift+Del | Insert / delete frame |
| Del | Delete selected part or cue |
| [ / ] | Send backward / bring forward |
| Ctrl+C / Ctrl+V | Copy / paste pose |
| Ctrl+Z / Ctrl+Y | Undo / redo |
| Ctrl+S / Ctrl+Shift+S | Save project / save document to library |
| Ctrl+E / Ctrl+Shift+E | Export document / build main.pak |
| F, 0, +, − | Fit, 100 %, zoom in, zoom out |
| O, G, B, L | Onion skin, grid, outlines, lawn-cell guide |

## File formats

**main.pak** — every byte XOR-ed with `0xF7`. Header `u32 0xBAC04AC0`, `u32 0`; then directory
records `u8 flags (0x80 = end)`, `u8 nameLength`, name, `u32 size`, `u64 FILETIME`; then the file data in
directory order. Paths are case-insensitive.

**Reanim** — a root-less list of `<fps>` and `<track>` elements. Each `<track>` has a `<name>` and one
`<t>` per frame; a `<t>` only lists fields that changed since the previous frame (`x`, `y`, `kx`, `ky`,
`sx`, `sy`, `f`, `a`, `i`, `font`, `text`). Tracks named `anim_*` mark animation ranges with `f = 0`.
The image is drawn with its top-left corner at the transform origin.

**Compiled reanim** — `u32 0xDEADFED4`, `u32 uncompressedSize`, then zlib data holding the game's
in-memory structs (schema hash, definition, tracks, transforms and length-prefixed strings).

**Particles** — a root-less list of `<Emitter>` elements. Most values are float tracks in centiseconds
and px/s. Launch angles follow the convention 0° = down, 90° = right, 180° = up.

**Cues** — the game triggers sounds and effects from code, so cues are an editor feature. They are kept
in project files and, unless disabled in the Edit menu, in a hidden `_pvzanim_cues` track of exported
reanims (all frames `f = -1`, so the game never draws it) so the editor can restore them.

## Project layout

```
src/
  formats/   PAK, XML, reanim (+ compiled), float tracks, particles, resources.xml, .au, ZIP
  engine/    virtual file system, asset resolution, WebGL renderer, reanim runtime, particle simulator, audio
  editor/    documents (keyframes, undo, cues) and workspace state/playback
  ui/        viewport, timeline, inspectors, asset browser, dialogs, exporters
tests/       unit tests (vitest)
```

## Notes

- Behaviour that is not documented by PopCap (curve-keyword placement in float tracks, some particle
  field units) follows the community's understanding of the decompiled game and may differ slightly from
  the game in edge cases.
- Plants vs. Zombies is a trademark of Electronic Arts / PopCap Games. This project is a fan-made tool
  and is not affiliated with them. Use it with a copy of the game you own.
