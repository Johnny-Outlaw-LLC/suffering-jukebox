// Share Song links - /s/<artist-title>-<track uuid>
//
// The words in front are only there so the link reads like a song in a chat.
// The uuid at the end is the whole address: a rename never breaks a link that
// is already out there. `songSharePath()` in public/index.html is the client's
// copy of `songSlug()` - keep the two in step.

const UUID_TAIL = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

export function songIdFromParam(raw: string): string | null {
  const m = String(raw || "").match(UUID_TAIL);
  return m ? m[1].toLowerCase() : null;
}

export function songSlug(artist: string | null | undefined, title: string | null | undefined): string {
  return [artist, title]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
}

export function songPath(artist: string | null | undefined, title: string | null | undefined, id: string): string {
  const s = songSlug(artist, title);
  return `/s/${s ? s + "-" : ""}${id}`;
}

/** `?t=95` - whole seconds, or null when absent or nonsense. */
export function songStartSeconds(raw: string | null | undefined): number | null {
  if (raw == null || raw === "") return null;
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n > 0 && n < 6 * 3600 ? n : null;
}
