/**
 * Pure helpers for merging one album into another.
 * The route executes the plan; this file decides what to keep.
 */

export function albumNameKey(s: string | null | undefined): string {
  return (s || '')
    .toLowerCase()
    .replace(/[&\uff06]/g, ' and ')
    .replace(/[^a-z0-9]+/g, '');
}

export type MergeTrack = {
  id: string;
  name: string | null;
  track_number: number | null;
  created_at: string;
};

export type MergePlan =
  | { kind: 'delete_drop'; dropId: string }
  | { kind: 'move_drop_delete_keep'; keepId: string; dropId: string; trackNumber: number | null }
  | { kind: 'move_drop'; dropId: string; trackNumber: number };

/**
 * Matching songs: keep the older row (play history), discard the newer.
 * Unmatched drop songs move onto the keep album after its highest track number.
 */
export function planAlbumMerge(keepTracks: MergeTrack[], dropTracks: MergeTrack[]): MergePlan[] {
  const keepByName = new Map<string, MergeTrack>();
  for (const t of keepTracks) {
    const k = albumNameKey(t.name);
    if (!k) continue;
    const prev = keepByName.get(k);
    if (!prev || new Date(t.created_at).getTime() < new Date(prev.created_at).getTime()) {
      keepByName.set(k, t);
    }
  }

  let nextNum =
    keepTracks.reduce((m, t) => Math.max(m, t.track_number || 0), 0) + 1;
  const plans: MergePlan[] = [];
  const claimedKeep = new Set<string>();

  for (const drop of dropTracks) {
    const k = albumNameKey(drop.name);
    const keep = k ? keepByName.get(k) : undefined;
    if (keep && !claimedKeep.has(keep.id)) {
      claimedKeep.add(keep.id);
      const keepOlder =
        new Date(keep.created_at).getTime() <= new Date(drop.created_at).getTime();
      if (keepOlder) {
        plans.push({ kind: 'delete_drop', dropId: drop.id });
      } else {
        plans.push({
          kind: 'move_drop_delete_keep',
          keepId: keep.id,
          dropId: drop.id,
          trackNumber: keep.track_number,
        });
      }
      continue;
    }
    plans.push({ kind: 'move_drop', dropId: drop.id, trackNumber: nextNum++ });
  }
  return plans;
}
