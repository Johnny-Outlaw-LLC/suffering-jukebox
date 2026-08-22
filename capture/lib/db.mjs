/**
 * Supabase access for the capture job. Reads artists with the anon key, writes
 * the share_images manifest with the service role (the table is read-only to
 * clients by design).
 */
const REST = (process.env.SUPABASE_URL || "https://ntyvtpimesfoesuykuyi.supabase.co") + "/rest/v1";

function anonKey() {
  const k = process.env.SUPABASE_ANON_KEY?.trim();
  if (!k) throw new Error("SUPABASE_ANON_KEY is not configured.");
  return k;
}

function serviceKey() {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!k) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured.");
  return k;
}

function headers(key, extra = {}) {
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Accept-Profile": "jukebox",
    "Content-Profile": "jukebox",
    ...extra,
  };
}

/** Every artist that has a slug, i.e. every artist with a shareable page. */
export async function listArtists() {
  const res = await fetch(
    `${REST}/artists?select=id,name,slug,is_community&slug=not.is.null&order=name.asc&limit=1000`,
    { headers: headers(anonKey()) }
  );
  if (!res.ok) throw new Error(`artists query failed: ${await res.text()}`);
  return res.json();
}

/** Upsert one manifest row on the (slug, shot_id, format) key. */
export async function recordShareImage(row) {
  const res = await fetch(
    `${REST}/share_images?on_conflict=slug,shot_id,format`,
    {
      method: "POST",
      headers: headers(serviceKey(), {
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates,return=minimal",
      }),
      body: JSON.stringify(row),
    }
  );
  if (!res.ok) throw new Error(`share_images upsert failed: ${await res.text()}`);
}

/** Drop manifest rows for slugs that no longer exist or were not captured. */
export async function pruneMissing(keepSlugs) {
  if (!keepSlugs.length) return 0;
  const list = keepSlugs.map((s) => `"${s}"`).join(",");
  const res = await fetch(`${REST}/share_images?slug=not.in.(${encodeURIComponent(list)})`, {
    method: "DELETE",
    headers: headers(serviceKey(), { Prefer: "return=representation" }),
  });
  if (!res.ok) throw new Error(`share_images prune failed: ${await res.text()}`);
  return (await res.json()).length;
}
