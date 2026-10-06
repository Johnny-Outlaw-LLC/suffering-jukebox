import { NextRequest, NextResponse } from "next/server";
import {
  createSjServiceClient,
  getAuthUser,
  isSjAdmin,
  isSjMod,
  JUKEBOX_SCHEMA,
  SJ_PROTECTED_ADMIN_EMAIL,
} from "@/lib/sj-admin-auth";
import { parseLrcStrict } from "@/lib/lrc";

export const dynamic = "force-dynamic";

// Cleanup edits: lyrics, lyric timing, artist / album / song names.
//
// Who may edit: an admin, a Mod, or whoever added the artist (artists.added_by
// or a content_access row from importing into it). Mods are NOT admins - they
// get these edits and nothing else (no deletes, no visibility, no admin pages).
// These actions used to live in the community-import edge function, which only
// knew about admins; the rules are here so a Mod needs no edge redeploy.

type Sb = ReturnType<typeof createSjServiceClient>;

const OFFICIAL_MANAGE_SLUGS = new Set(["silver-jews", "purple-mountains"]);

function err(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

async function canEditArtist(sb: Sb, artistId: string, email: string, staff: boolean): Promise<boolean> {
  if (staff) return true;
  const emailLc = email.toLowerCase();
  const { data: a } = await sb
    .schema(JUKEBOX_SCHEMA)
    .from("artists")
    .select("id,slug,is_community,added_by")
    .eq("id", artistId)
    .maybeSingle();
  if (!a) return false;
  if (a.is_community) {
    if (String(a.added_by || "").toLowerCase() === emailLc) return true;
    const { data: access } = await sb
      .schema(JUKEBOX_SCHEMA)
      .from("content_access")
      .select("artist_id")
      .eq("artist_id", artistId)
      .eq("user_email", emailLc)
      .limit(1);
    return !!access?.length;
  }
  return OFFICIAL_MANAGE_SLUGS.has(a.slug || "") && emailLc === SJ_PROTECTED_ADMIN_EMAIL;
}

async function artistIdForTrack(sb: Sb, trackId: string): Promise<string | null> {
  const { data: t } = await sb.schema(JUKEBOX_SCHEMA).from("tracks").select("album_id").eq("id", trackId).maybeSingle();
  if (!t) return null;
  const { data: alb } = await sb.schema(JUKEBOX_SCHEMA).from("albums").select("artist_id").eq("id", t.album_id).maybeSingle();
  return alb?.artist_id ?? null;
}

export async function POST(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user?.email) return err("Sign in required.", 401);
  const email = user.email.toLowerCase();
  const name = String(user.user_metadata?.full_name || email.split("@")[0]);
  const sb = createSjServiceClient();
  const staff = (await isSjAdmin(email)) || (await isSjMod(email));

  const body = await req.json().catch(() => ({}));
  const action = String(body.action || "");
  const db = () => sb.schema(JUKEBOX_SCHEMA);

  if (action === "rename_artist") {
    const newName = String(body.name || "").trim().slice(0, 80);
    if (!body.artist_id || !newName) return err("artist_id and name required");
    if (!(await canEditArtist(sb, body.artist_id, email, staff))) return err("You can only rename artists you added.", 403);
    const { error } = await db().from("artists").update({ name: newName }).eq("id", body.artist_id);
    if (error) return err(error.message, 500);
    return NextResponse.json({ success: true, name: newName });
  }

  if (action === "rename_album") {
    const newName = String(body.name || "").trim().slice(0, 120);
    if (!body.album_id || !newName) return err("album_id and name required");
    const { data: alb } = await db().from("albums").select("id,artist_id").eq("id", body.album_id).maybeSingle();
    if (!alb) return err("Album not found", 404);
    if (!(await canEditArtist(sb, alb.artist_id, email, staff))) return err("You can only rename albums on artists you added.", 403);
    const { error } = await db().from("albums").update({ name: newName }).eq("id", body.album_id);
    if (error) return err(error.message, 500);
    return NextResponse.json({ success: true, name: newName });
  }

  if (action === "rename_track") {
    const newName = String(body.name || "").trim().slice(0, 200);
    if (!body.track_id || !newName) return err("track_id and name required");
    const artistId = await artistIdForTrack(sb, body.track_id);
    if (!artistId) return err("Track not found", 404);
    if (!(await canEditArtist(sb, artistId, email, staff))) return err("You can only rename tracks on artists you added.", 403);
    const { error } = await db().from("tracks").update({ name: newName }).eq("id", body.track_id);
    if (error) return err(error.message, 500);
    return NextResponse.json({ success: true, name: newName });
  }

  if (action === "save_lyrics") {
    const newLyrics = typeof body.lyrics === "string" ? body.lyrics.trim() : "";
    if (!body.track_id || !newLyrics) return err("track_id and lyrics required");
    const artistId = await artistIdForTrack(sb, body.track_id);
    if (!artistId) return err("Track not found", 404);
    if (!(await canEditArtist(sb, artistId, email, staff))) return err("You can only edit lyrics on artists you added.", 403);
    const { data: existing } = await db().from("lyrics").select("id,lyrics").eq("track_id", body.track_id).maybeSingle();
    const stamp = { lyrics: newLyrics, lyrics_source: "user-edit", lyrics_saved_at: new Date().toISOString() };
    const w = existing
      ? await db().from("lyrics").update(stamp).eq("track_id", body.track_id)
      : await db().from("lyrics").insert({ track_id: body.track_id, ...stamp });
    if (w.error) return err(w.error.message, 500);
    // History is best-effort, as it was in the edge function.
    await db().from("lyrics_edits").insert({
      track_id: body.track_id,
      old_lyrics: existing?.lyrics || null,
      new_lyrics: newLyrics,
      editor_email: email,
      editor_name: name,
    });
    return NextResponse.json({ success: true });
  }

  // Timed lyrics saved by hand. Stored in the same column LRCLIB fills, flagged
  // 'manual' so nothing automatic replaces them.
  if (action === "save_synced_lyrics") {
    if (!body.track_id) return err("track_id required");
    const artistId = await artistIdForTrack(sb, body.track_id);
    if (!artistId) return err("Track not found", 404);
    if (!(await canEditArtist(sb, artistId, email, staff))) return err("You can only sync lyrics on artists you added.", 403);
    const lrc = typeof body.lrc === "string" ? body.lrc : "";
    if (!lrc.trim()) {
      const { error } = await db()
        .from("tracks")
        .update({ lyrics_synced: null, lyrics_synced_source: null, lyrics_synced_by: null, lyrics_synced_at: null })
        .eq("id", body.track_id);
      if (error) return err(error.message, 500);
      return NextResponse.json({ success: true, cleared: true });
    }
    const parsed = parseLrcStrict(lrc);
    if (!parsed.ok) return err(parsed.error);
    const { error } = await db()
      .from("tracks")
      .update({
        lyrics_synced: parsed.lrc,
        lyrics_synced_source: "manual",
        lyrics_synced_by: email,
        lyrics_synced_at: new Date().toISOString(),
      })
      .eq("id", body.track_id);
    if (error) return err(error.message, 500);
    return NextResponse.json({ success: true, lines: parsed.lines });
  }

  return err("Unknown action.");
}
