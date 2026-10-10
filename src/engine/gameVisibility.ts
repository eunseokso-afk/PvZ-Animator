/**
 * Parts the game hides from its C++ code (render groups) rather than in the reanim
 * files, so a raw reanim shows more than the game does. Applied when View ▸ In-game
 * part visibility is on; the files themselves are never changed.
 */

/**
 * CreditScreen::TurnOffTongues: a Zombie_credits_dance attached by a track whose index
 * in its parent is not 1 mod 4 has its tongue hidden (so about one dancer in four keeps it).
 */
export function creditsHidesTongue(attachedReanim: string, attacherTrackIndex: number): boolean {
  return attachedReanim.toLowerCase() === 'zombie_credits_dance' && attacherTrackIndex % 4 !== 1;
}

/** Track prefixes that mark the basic zombie rig (Zombie.reanim and copies of it). */
const ZOMBIE_RIG = ['anim_cone', 'anim_bucket', 'anim_screendoor', 'zombie_flaghand'];

/** What Zombie::SetupReanimLayers hides on a plain zombie (prefix matches, like AssignRenderGroupToPrefix). */
const ZOMBIE_HIDDEN = ['anim_cone', 'anim_bucket', 'anim_screendoor', 'zombie_flaghand', 'zombie_duckytube', 'anim_tongue', 'zombie_mustache'];

/**
 * Indices of the tracks a plain zombie hides: the other zombie types' accessories. The
 * rig is recognised by its track names, so renamed or modded copies work too.
 */
export function gameHiddenTracks(tracks: readonly { name: string }[]): Set<number> {
  const out = new Set<number>();
  const names = tracks.map((t) => t.name.toLowerCase());
  const rig = ZOMBIE_RIG.filter((p) => names.some((n) => n.startsWith(p))).length;
  if (rig < 2) return out;
  names.forEach((n, i) => {
    if (ZOMBIE_HIDDEN.some((p) => n.startsWith(p)) || /^zombie_(inner|outer)arm_screendoor/.test(n)) out.add(i);
  });
  return out;
}
