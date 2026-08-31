/** Playlist capability grants — pure helpers for the share API and tests. */

export type PlaylistVisibility = "private" | "shared" | "public";

export type PlaylistGrant = {
  principal: string; // "public" | lowercased email
  canView: boolean;
  canAdd: boolean;
  canReorder: boolean;
};

export type PlaylistCaps = {
  canView: boolean;
  canAdd: boolean;
  canReorder: boolean;
  isOwner: boolean;
};

export const PUBLIC_PRINCIPAL = "public";

export function cleanEmail(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

export function normalizeGrantFlags(input: {
  canView?: boolean;
  canAdd?: boolean;
  canReorder?: boolean;
}): { canView: boolean; canAdd: boolean; canReorder: boolean } {
  const canReorder = !!input.canReorder;
  const canAdd = !!input.canAdd || canReorder;
  const canView = !!input.canView || canAdd;
  return { canView, canAdd, canReorder };
}

/** Public Explore presets — only set the Public principal row. */
export function publicPresetGrant(
  preset: "listen" | "add" | "reorder"
): PlaylistGrant {
  if (preset === "reorder") {
    return { principal: PUBLIC_PRINCIPAL, canView: true, canAdd: true, canReorder: true };
  }
  if (preset === "add") {
    return { principal: PUBLIC_PRINCIPAL, canView: true, canAdd: true, canReorder: false };
  }
  return { principal: PUBLIC_PRINCIPAL, canView: true, canAdd: false, canReorder: false };
}

export function presetFromPublicGrant(g: PlaylistGrant | null | undefined): "listen" | "add" | "reorder" {
  if (!g?.canView) return "listen";
  if (g.canReorder) return "reorder";
  if (g.canAdd) return "add";
  return "listen";
}

export function visibilityFromGrants(grants: PlaylistGrant[]): PlaylistVisibility {
  const hasPublic = grants.some(g => g.principal === PUBLIC_PRINCIPAL && g.canView);
  if (hasPublic) return "public";
  const hasNamed = grants.some(g => g.principal !== PUBLIC_PRINCIPAL && g.canView);
  if (hasNamed) return "shared";
  return "private";
}

export function effectiveCaps(opts: {
  ownerEmail: string;
  viewerEmail: string | null | undefined;
  grants: PlaylistGrant[];
  /** When true and no public grant row exists, treat as full write (legacy). */
  legacyPublic?: boolean;
}): PlaylistCaps {
  const owner = cleanEmail(opts.ownerEmail);
  const viewer = cleanEmail(opts.viewerEmail);
  const isOwner = !!viewer && viewer === owner;
  if (isOwner) {
    return { canView: true, canAdd: true, canReorder: true, isOwner: true };
  }

  const named = viewer
    ? opts.grants.find(g => g.principal === viewer)
    : undefined;
  const pub = opts.grants.find(g => g.principal === PUBLIC_PRINCIPAL);

  let canView = !!(named?.canView || pub?.canView);
  let canAdd = !!(named?.canAdd || pub?.canAdd);
  let canReorder = !!(named?.canReorder || pub?.canReorder);

  if (!canView && opts.legacyPublic) canView = true;
  if (viewer && opts.legacyPublic && !pub) {
    canAdd = true;
    canReorder = true;
    canView = true;
  }

  if (!viewer) {
    canAdd = false;
    canReorder = false;
  }

  return { canView, canAdd, canReorder, isOwner: false };
}

export function capsBannerText(caps: PlaylistCaps): string {
  if (caps.isOwner) return "You own this playlist.";
  if (!caps.canView) return "You cannot open this playlist.";
  const bits: string[] = ["You can listen"];
  if (caps.canReorder) bits.push("add songs", "and reorder");
  else if (caps.canAdd) bits.push("and add songs");
  let line = bits[0];
  if (bits.length === 2) line = `${bits[0]} ${bits[1]}`;
  else if (bits.length === 3) line = `${bits[0]}, ${bits[1]}, ${bits[2]}`;
  if (caps.canAdd || caps.isOwner) {
    line += ". Songs you add, you can remove.";
  } else {
    line += ".";
  }
  return line;
}

export function shapeGrantRow(row: {
  principal: string;
  can_view?: boolean;
  can_add?: boolean;
  can_reorder?: boolean;
  canView?: boolean;
  canAdd?: boolean;
  canReorder?: boolean;
}): PlaylistGrant {
  const flags = normalizeGrantFlags({
    canView: row.canView ?? row.can_view,
    canAdd: row.canAdd ?? row.can_add,
    canReorder: row.canReorder ?? row.can_reorder,
  });
  const principal = row.principal === PUBLIC_PRINCIPAL
    ? PUBLIC_PRINCIPAL
    : cleanEmail(row.principal);
  return { principal, ...flags };
}
