import { NextRequest, NextResponse } from "next/server";
import { createB2DownloadUrl, createB2UploadUrl } from "@/lib/b2-audio";
import { bad, clientIp, rateLimited, tooMany } from "@/lib/jukebox-request";
import {
  RESEARCH_ITEM_SELECT,
  RESEARCH_MEDIA_LABELS,
  enrichYouTubeCandidate,
  fetchYouTubeTranscript,
  guessMediaTypeFromUrl,
  isResearchMediaType,
  looksPaywalled,
  parseYouTubeId,
  runArtistResearch,
  shapeResearchItem,
  type ResearchCandidate,
  type ResearchMediaType,
} from "@/lib/research";
import { kickDeepgramForItem } from "@/lib/research-deepgram";
import {
  createSjServiceClient,
  fetchYouTubeVideoInfo,
  getAuthUser,
  JUKEBOX_SCHEMA,
} from "@/lib/sj-admin-auth";
import { isUuid } from "@/lib/artist-rights";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const T = (sb: ReturnType<typeof createSjServiceClient>, table: string) =>
  sb.schema(JUKEBOX_SCHEMA).from(table);

async function authEmail(req: NextRequest): Promise<{
  email: string;
  name: string | null;
  userId: string;
} | null> {
  const user = await getAuthUser(req).catch(() => null);
  if (!user?.email) return null;
  return {
    email: user.email,
    name:
      (user.user_metadata?.full_name as string | undefined) ??
      (user.user_metadata?.name as string | undefined) ??
      null,
    userId: user.id,
  };
}

async function loadArtist(sb: ReturnType<typeof createSjServiceClient>, artistId: string) {
  const { data, error } = await T(sb, "artists").select("id,name").eq("id", artistId).maybeSingle();
  if (error) throw error;
  return data as { id: string; name: string } | null;
}

async function listItems(sb: ReturnType<typeof createSjServiceClient>, artistId: string) {
  const { data, error } = await T(sb, "research_items")
    .select(RESEARCH_ITEM_SELECT)
    .eq("artist_id", artistId)
    .eq("is_supplemental", true)
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(500);
  if (error) throw error;
  return enrichItemsFromYouTube(sb, (data ?? []).map(shapeResearchItem));
}

/** Backfill YouTube publish dates and view counts for rows saved before we stored them. */
async function enrichItemsFromYouTube(
  sb: ReturnType<typeof createSjServiceClient>,
  items: ReturnType<typeof shapeResearchItem>[],
) {
  const needs = items.filter((i) => !i.publishedAt && i.externalId);
  if (!needs.length) return items;
  const ids = [...new Set(needs.map((i) => i.externalId!).filter(Boolean))];
  const info = await fetchYouTubeVideoInfo(ids);
  const updated = new Map<string, ReturnType<typeof shapeResearchItem>>();
  for (const item of needs) {
    const detail = info[item.externalId!];
    if (!detail) continue;
    const patch: Record<string, unknown> = {};
    if (detail.publishedAt) patch.published_at = detail.publishedAt;
    if (detail.views != null && (item.viewCount == null || item.viewCount === 0)) {
      patch.view_count = detail.views;
    }
    if (detail.thumbnail && !item.thumbnailUrl) patch.thumbnail_url = detail.thumbnail;
    if (!Object.keys(patch).length) continue;
    const { data, error } = await T(sb, "research_items")
      .update(patch)
      .eq("id", item.id)
      .select(RESEARCH_ITEM_SELECT)
      .maybeSingle();
    if (!error && data) updated.set(item.id, shapeResearchItem(data));
  }
  return items.map((i) => updated.get(i.id) || i);
}

function markAlreadyAdded(
  candidates: ResearchCandidate[],
  existing: Array<{ externalId: string | null; sourceUrl: string | null }>,
): ResearchCandidate[] {
  const ext = new Set(existing.map((e) => e.externalId).filter(Boolean) as string[]);
  const urls = new Set(existing.map((e) => e.sourceUrl).filter(Boolean) as string[]);
  return candidates.map((c) => ({
    ...c,
    alreadyAdded: !!(
      (c.externalId && ext.has(c.externalId)) ||
      (c.sourceUrl && urls.has(c.sourceUrl))
    ),
  }));
}

async function insertItem(
  sb: ReturnType<typeof createSjServiceClient>,
  row: Record<string, unknown>,
) {
  const { data, error } = await T(sb, "research_items")
    .insert(row)
    .select(RESEARCH_ITEM_SELECT)
    .single();
  if (error) {
    if ((error as any).code === "23505") {
      const e = new Error("That item is already in this artist’s Research Library.");
      (e as any).status = 409;
      throw e;
    }
    throw error;
  }
  return shapeResearchItem(data);
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const artistId = url.searchParams.get("artistId")?.trim() || "";
    if (!isUuid(artistId)) return bad("artistId is required.");
    const sb = createSjServiceClient();
    const artist = await loadArtist(sb, artistId);
    if (!artist) return bad("Artist not found.", 404);
    const items = await listItems(sb, artistId);
    return NextResponse.json({
      ok: true,
      artist: { id: artist.id, name: artist.name },
      items,
      mediaTypes: RESEARCH_MEDIA_LABELS,
    });
  } catch (error) {
    console.error("[research:GET]", error);
    return bad((error as Error)?.message || "Could not load research items.", 502);
  }
}

export async function POST(req: NextRequest) {
  try {
    if (rateLimited(`research:${clientIp(req)}`, 30)) return tooMany();
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || "").trim();
    const sb = createSjServiceClient();

    if (action === "list") {
      const artistId = String(body.artistId || "").trim();
      if (!isUuid(artistId)) return bad("artistId is required.");
      const artist = await loadArtist(sb, artistId);
      if (!artist) return bad("Artist not found.", 404);
      return NextResponse.json({
        ok: true,
        artist: { id: artist.id, name: artist.name },
        items: await listItems(sb, artistId),
        mediaTypes: RESEARCH_MEDIA_LABELS,
      });
    }

    if (action === "research") {
      const user = await authEmail(req);
      if (!user) return bad("Sign in to run research.", 401);
      if (rateLimited(`research-run:${user.email}`, 6)) return tooMany();
      const artistId = String(body.artistId || "").trim();
      if (!isUuid(artistId)) return bad("artistId is required.");
      const artist = await loadArtist(sb, artistId);
      if (!artist) return bad("Artist not found.", 404);
      const existing = await listItems(sb, artistId);
      const candidates = markAlreadyAdded(
        await runArtistResearch(artist.name),
        existing.map((i) => ({ externalId: i.externalId, sourceUrl: i.sourceUrl })),
      );
      return NextResponse.json({
        ok: true,
        artist: { id: artist.id, name: artist.name },
        candidates,
        existingCount: existing.length,
      });
    }

    if (action === "add") {
      const user = await authEmail(req);
      if (!user) return bad("Sign in to add research items.", 401);
      const artistId = String(body.artistId || "").trim();
      if (!isUuid(artistId)) return bad("artistId is required.");
      const artist = await loadArtist(sb, artistId);
      if (!artist) return bad("Artist not found.", 404);

      let mediaType: ResearchMediaType = isResearchMediaType(body.mediaType)
        ? body.mediaType
        : "other";
      let title = String(body.title || "").trim();
      let description = body.description != null ? String(body.description).trim() || null : null;
      let sourceUrl = body.sourceUrl != null ? String(body.sourceUrl).trim() || null : null;
      let sourceName = body.sourceName != null ? String(body.sourceName).trim() || null : null;
      let creatorName = body.creatorName != null ? String(body.creatorName).trim() || null : null;
      let creatorUrl = body.creatorUrl != null ? String(body.creatorUrl).trim() || null : null;
      let channelId = body.channelId != null ? String(body.channelId).trim() || null : null;
      let externalId = body.externalId != null ? String(body.externalId).trim() || null : null;
      let thumbnailUrl = body.thumbnailUrl != null ? String(body.thumbnailUrl).trim() || null : null;
      let embedUrl = body.embedUrl != null ? String(body.embedUrl).trim() || null : null;
      let audioUrl = body.audioUrl != null ? String(body.audioUrl).trim() || null : null;
      let durationMs =
        body.durationMs != null && Number.isFinite(Number(body.durationMs))
          ? Math.max(0, Math.round(Number(body.durationMs)))
          : null;
      let viewCount =
        body.viewCount != null && Number.isFinite(Number(body.viewCount))
          ? Math.max(0, Math.round(Number(body.viewCount)))
          : null;
      let publishedAt = body.publishedAt ? String(body.publishedAt) : null;
      let transcript = body.transcript != null ? String(body.transcript).trim() || null : null;
      let transcriptSource = body.transcriptSource != null
        ? String(body.transcriptSource).trim() || null
        : null;
      const addedVia = ["research", "upload", "manual", "import"].includes(String(body.addedVia))
        ? String(body.addedVia)
        : "manual";
      const visibility = body.visibility === "private" ? "private" : "public";

      // Enrich from a YouTube URL when the client only sent a link.
      const ytId = parseYouTubeId(sourceUrl) || parseYouTubeId(externalId);
      if (ytId && (!title || !thumbnailUrl || !embedUrl || !publishedAt)) {
        const enriched = await enrichYouTubeCandidate(ytId);
        if (enriched) {
          title = title || enriched.title;
          description = description || enriched.description;
          sourceUrl = sourceUrl || enriched.sourceUrl;
          sourceName = sourceName || enriched.sourceName;
          creatorName = creatorName || enriched.creatorName;
          externalId = externalId || enriched.externalId;
          thumbnailUrl = thumbnailUrl || enriched.thumbnailUrl;
          embedUrl = embedUrl || enriched.embedUrl;
          durationMs = durationMs ?? enriched.durationMs;
          viewCount = viewCount ?? enriched.viewCount;
          publishedAt = publishedAt || enriched.publishedAt;
          if (!isResearchMediaType(body.mediaType)) mediaType = enriched.mediaType;
        }
      }

      if (sourceUrl && looksPaywalled(sourceUrl)) {
        return bad("That link looks like it sits behind a paywall. Pick an open YouTube upload instead.");
      }

      if (!title) {
        if (sourceUrl) {
          mediaType = isResearchMediaType(body.mediaType) ? mediaType : guessMediaTypeFromUrl(sourceUrl);
          title = sourceUrl;
        } else {
          return bad("A title is required.");
        }
      }

      // Auto-pull a YouTube transcript when adding a video and none was pasted.
      if (ytId && !transcript) {
        const cap = await fetchYouTubeTranscript(ytId);
        if (cap) {
          transcript = cap.text;
          transcriptSource = cap.source;
        }
      }

      let item = await insertItem(sb, {
        artist_id: artistId,
        is_supplemental: true,
        media_type: mediaType,
        title: title.slice(0, 500),
        description: description?.slice(0, 4000) ?? null,
        source_url: sourceUrl,
        source_name: sourceName || (ytId ? "YouTube" : null),
        creator_name: creatorName,
        creator_url: creatorUrl,
        channel_id: channelId,
        external_id: externalId || ytId,
        thumbnail_url: thumbnailUrl,
        embed_url: embedUrl || (ytId ? `https://www.youtube.com/embed/${ytId}` : null),
        audio_url: audioUrl,
        duration_ms: durationMs,
        view_count: viewCount,
        published_at: publishedAt,
        transcript,
        transcript_source: transcriptSource,
        added_by: user.email,
        added_by_name: user.name,
        added_via: addedVia,
        visibility,
        metadata: body.metadata && typeof body.metadata === "object" ? body.metadata : {},
      });

      let deepgram: string | undefined;
      if (!item.transcript && (item.audioUrl || mediaType === "audio_podcast") && !ytId) {
        const dg = await kickDeepgramForItem(item.id, { durationMs: item.durationMs });
        deepgram = dg.status;
        const { data: refreshed } = await T(sb, "research_items")
          .select(RESEARCH_ITEM_SELECT)
          .eq("id", item.id)
          .maybeSingle();
        if (refreshed) item = shapeResearchItem(refreshed);
      }
      return NextResponse.json({ ok: true, item, deepgram });
    }

    if (action === "add_many") {
      const user = await authEmail(req);
      if (!user) return bad("Sign in to add research items.", 401);
      const artistId = String(body.artistId || "").trim();
      if (!isUuid(artistId)) return bad("artistId is required.");
      const artist = await loadArtist(sb, artistId);
      if (!artist) return bad("Artist not found.", 404);
      const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0, 40) : [];
      const added = [];
      const skipped = [];
      for (const c of candidates) {
        try {
          const ytId = parseYouTubeId(c.sourceUrl) || parseYouTubeId(c.externalId);
          let transcript: string | null = null;
          let transcriptSource: string | null = null;
          if (ytId) {
            const cap = await fetchYouTubeTranscript(ytId);
            if (cap) {
              transcript = cap.text;
              transcriptSource = cap.source;
            }
          }
          if (c.sourceUrl && looksPaywalled(String(c.sourceUrl))) {
            skipped.push({ key: c.key, reason: "paywall" });
            continue;
          }
          if (c.mediaType === "article" || String(c.externalId || "").startsWith("wiki:")) {
            skipped.push({ key: c.key, reason: "unsupported" });
            continue;
          }
          const item = await insertItem(sb, {
            artist_id: artistId,
            is_supplemental: true,
            media_type: isResearchMediaType(c.mediaType) ? c.mediaType : "other",
            title: String(c.title || "Untitled").slice(0, 500),
            description: c.description != null ? String(c.description).slice(0, 4000) : null,
            source_url: c.sourceUrl || null,
            source_name: c.sourceName || null,
            creator_name: c.creatorName || null,
            creator_url: c.creatorUrl || null,
            channel_id: c.channelId || null,
            external_id: c.externalId || ytId || null,
            thumbnail_url: c.thumbnailUrl || null,
            embed_url: c.embedUrl || (ytId ? `https://www.youtube.com/embed/${ytId}` : null),
            audio_url: c.audioUrl || null,
            duration_ms: c.durationMs != null ? Number(c.durationMs) : null,
            view_count: c.viewCount != null ? Number(c.viewCount) : null,
            published_at: c.publishedAt || null,
            transcript,
            transcript_source: transcriptSource,
            added_by: user.email,
            added_by_name: user.name,
            added_via: "research",
            visibility: "public",
            metadata: {},
          });
          added.push(item);
        } catch (e: any) {
          if (e?.status === 409 || e?.code === "23505") {
            skipped.push({ key: c.key, reason: "duplicate" });
          } else {
            skipped.push({ key: c.key, reason: e?.message || "failed" });
          }
        }
      }
      return NextResponse.json({ ok: true, added, skipped });
    }

    if (action === "update") {
      const user = await authEmail(req);
      if (!user) return bad("Sign in to edit research items.", 401);
      const id = String(body.id || "").trim();
      if (!isUuid(id)) return bad("id is required.");
      const { data: row } = await T(sb, "research_items").select("id").eq("id", id).maybeSingle();
      if (!row) return bad("Item not found.", 404);
      const { data: existing } = await T(sb, "research_items")
        .select("metadata")
        .eq("id", id)
        .maybeSingle();
      const meta =
        existing?.metadata && typeof existing.metadata === "object"
          ? { ...(existing.metadata as Record<string, unknown>) }
          : {};
      const patch: Record<string, unknown> = {};
      if (body.publishedAt !== undefined) {
        patch.published_at = body.publishedAt ? String(body.publishedAt) : null;
        if (body.publishedAt) meta.published_at_manual = true;
        else delete meta.published_at_manual;
        patch.metadata = meta;
      }
      if (body.title !== undefined) {
        const t = String(body.title || "").trim();
        if (t) patch.title = t.slice(0, 500);
      }
      if (!Object.keys(patch).length) return bad("Nothing to update.");
      const { data, error } = await T(sb, "research_items")
        .update(patch)
        .eq("id", id)
        .select(RESEARCH_ITEM_SELECT)
        .single();
      if (error) throw error;
      return NextResponse.json({ ok: true, item: shapeResearchItem(data) });
    }

    if (action === "refresh_meta") {
      const user = await authEmail(req);
      if (!user) return bad("Sign in to refresh metadata.", 401);
      const id = String(body.id || "").trim();
      if (!isUuid(id)) return bad("id is required.");
      const { data: row, error: loadErr } = await T(sb, "research_items")
        .select(RESEARCH_ITEM_SELECT)
        .eq("id", id)
        .maybeSingle();
      if (loadErr) throw loadErr;
      if (!row) return bad("Item not found.", 404);
      const shaped = shapeResearchItem(row);
      if (!shaped.externalId) return bad("This item has no YouTube id to refresh.");
      const info = await fetchYouTubeVideoInfo([shaped.externalId]);
      const detail = info[shaped.externalId];
      if (!detail) return bad("Could not read YouTube metadata.");
      const manualYear = !!(shaped.metadata as Record<string, unknown>)?.published_at_manual;
      const patch: Record<string, unknown> = {
        view_count: detail.views,
      };
      if (!manualYear) patch.published_at = detail.publishedAt;
      if (detail.thumbnail) patch.thumbnail_url = detail.thumbnail;
      if (detail.title) patch.title = detail.title.slice(0, 500);
      const cap = await fetchYouTubeTranscript(shaped.externalId);
      if (cap) {
        patch.transcript = cap.text;
        patch.transcript_source = cap.source;
      }
      const { data, error } = await T(sb, "research_items")
        .update(patch)
        .eq("id", id)
        .select(RESEARCH_ITEM_SELECT)
        .single();
      if (error) throw error;
      return NextResponse.json({ ok: true, item: shapeResearchItem(data) });
    }

    if (action === "remove") {
      const user = await authEmail(req);
      if (!user) return bad("Sign in to remove research items.", 401);
      const id = String(body.id || "").trim();
      if (!isUuid(id)) return bad("id is required.");
      const { data: row } = await T(sb, "research_items")
        .select("id,added_by,storage_path")
        .eq("id", id)
        .maybeSingle();
      if (!row) return bad("Item not found.", 404);
      // Anyone signed in can remove for now (same spirit as community catalogue
      // edits); tighten to adder/admin later if needed.
      const { error } = await T(sb, "research_items").delete().eq("id", id);
      if (error) throw error;
      return NextResponse.json({ ok: true });
    }

    if (action === "transcript") {
      const id = String(body.id || "").trim();
      const videoId = String(body.videoId || "").trim();
      const forceDeepgram = body.forceDeepgram === true;
      if (id && isUuid(id)) {
        const { data: row, error } = await T(sb, "research_items")
          .select(RESEARCH_ITEM_SELECT)
          .eq("id", id)
          .maybeSingle();
        if (error) throw error;
        if (!row) return bad("Item not found.", 404);
        let shaped = shapeResearchItem(row);

        if (shaped.transcript && !forceDeepgram) {
          return NextResponse.json({
            ok: true,
            transcript: shaped.transcript,
            transcriptSource: shaped.transcriptSource,
            item: shaped,
            deepgram: shaped.transcriptSource === "deepgram_pending" ? "pending" : undefined,
          });
        }

        // 1) Free YouTube captions when we have a video id.
        if (!forceDeepgram && (shaped.externalId || shaped.sourceUrl)) {
          const cap = await fetchYouTubeTranscript(shaped.externalId || shaped.sourceUrl || "");
          if (cap) {
            await T(sb, "research_items")
              .update({ transcript: cap.text, transcript_source: cap.source })
              .eq("id", id);
            shaped = { ...shaped, transcript: cap.text, transcriptSource: cap.source };
            return NextResponse.json({
              ok: true,
              transcript: cap.text,
              transcriptSource: cap.source,
              item: shaped,
            });
          }
        }

        // 2) Deepgram for uploaded / direct audio (same Nova-3 path as 69.studio).
        if (
          forceDeepgram ||
          shaped.storagePath ||
          shaped.audioUrl ||
          shaped.transcriptSource === "deepgram_pending" ||
          shaped.transcriptSource === "deepgram_failed"
        ) {
          const dg = await kickDeepgramForItem(id, {
            durationMs: shaped.durationMs,
            forceSync: forceDeepgram && body.sync === true,
          });
          const { data: refreshed } = await T(sb, "research_items")
            .select(RESEARCH_ITEM_SELECT)
            .eq("id", id)
            .maybeSingle();
          shaped = refreshed ? shapeResearchItem(refreshed) : shaped;
          return NextResponse.json({
            ok: true,
            transcript: shaped.transcript,
            transcriptSource: shaped.transcriptSource,
            item: shaped,
            deepgram: dg.status,
            deepgramReason: "reason" in dg ? dg.reason : undefined,
          });
        }

        return NextResponse.json({
          ok: true,
          transcript: null,
          transcriptSource: null,
          item: shaped,
        });
      }
      if (videoId) {
        const cap = await fetchYouTubeTranscript(videoId);
        return NextResponse.json({
          ok: true,
          transcript: cap?.text ?? null,
          transcriptSource: cap?.source ?? null,
        });
      }
      return bad("id or videoId is required.");
    }

    if (action === "upload-url") {
      const user = await authEmail(req);
      if (!user) return bad("Sign in to upload.", 401);
      const artistId = String(body.artistId || "").trim();
      if (!isUuid(artistId)) return bad("artistId is required.");
      const fileName = String(body.fileName || "audio.mp3");
      const contentType = String(body.contentType || "audio/mpeg");
      if (!/^audio\//i.test(contentType)) return bad("Only audio uploads are supported here.");
      const ext = (fileName.match(/\.([a-z0-9]{1,8})$/i)?.[1] || "mp3").toLowerCase();
      const key = `research/${user.userId}/${artistId}/${crypto.randomUUID()}.${ext}`;
      const uploadUrl = await createB2UploadUrl(key, contentType);
      return NextResponse.json({ ok: true, uploadUrl, storagePath: key });
    }

    if (action === "complete-upload") {
      const user = await authEmail(req);
      if (!user) return bad("Sign in to finish upload.", 401);
      const artistId = String(body.artistId || "").trim();
      const storagePath = String(body.storagePath || "").trim();
      if (!isUuid(artistId)) return bad("artistId is required.");
      if (!storagePath.startsWith(`research/${user.userId}/${artistId}/`)) {
        return bad("Invalid storage path.");
      }
      const title = String(body.title || fileNameFromPath(storagePath)).trim();
      const audioUrl = await createB2DownloadUrl(storagePath);
      const pasted = body.transcript != null ? String(body.transcript).trim() || null : null;
      let item = await insertItem(sb, {
        artist_id: artistId,
        is_supplemental: true,
        media_type: "audio_podcast",
        title: title.slice(0, 500),
        description: body.description != null ? String(body.description).slice(0, 4000) : null,
        source_url: null,
        source_name: "Uploaded",
        creator_name: body.creatorName != null ? String(body.creatorName).trim() : user.name,
        creator_url: null,
        channel_id: null,
        external_id: null,
        thumbnail_url: body.thumbnailUrl != null ? String(body.thumbnailUrl).trim() : null,
        embed_url: null,
        audio_url: audioUrl,
        storage_path: storagePath,
        duration_ms: body.durationMs != null ? Number(body.durationMs) : null,
        view_count: null,
        published_at: body.publishedAt || null,
        transcript: pasted,
        transcript_source: pasted ? "uploaded" : null,
        added_by: user.email,
        added_by_name: user.name,
        added_via: "upload",
        visibility: body.visibility === "private" ? "private" : "public",
        metadata: {},
      });

      // No pasted transcript → Deepgram (Nova-3), same stack as 69.studio / Life Story.
      let deepgram: string | undefined;
      if (!pasted) {
        const dg = await kickDeepgramForItem(item.id, {
          durationMs: item.durationMs,
        });
        deepgram = dg.status;
        const { data: refreshed } = await T(sb, "research_items")
          .select(RESEARCH_ITEM_SELECT)
          .eq("id", item.id)
          .maybeSingle();
        if (refreshed) item = shapeResearchItem(refreshed);
      }
      return NextResponse.json({ ok: true, item, deepgram });
    }

    return bad("Unknown action.");
  } catch (error: any) {
    console.error("[research:POST]", error);
    return bad(error?.message || "Research request failed.", error?.status || 502);
  }
}

function fileNameFromPath(path: string): string {
  const base = path.split("/").pop() || "audio";
  return base.replace(/\.[a-z0-9]+$/i, "") || "Uploaded audio";
}
