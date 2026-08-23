import { NextRequest, NextResponse } from "next/server";
import { bad, clientIp, rateLimited, tooMany } from "@/lib/jukebox-request";
import { getPublicMyJukebox, logMyJukeboxPlay } from "@/lib/my-jukebox";
import { sjb } from "@/lib/jukebox-db";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ slug: string }> };
const uuid = (value: unknown): string | null =>
  typeof value === "string" && /^[0-9a-f-]{36}$/i.test(value) ? value : null;

export async function GET(_req: NextRequest, { params }: Props) {
  try {
    const { slug } = await params;
    const jukebox = await getPublicMyJukebox(slug);
    if (!jukebox) return bad("That public jukebox does not exist.", 404);
    return NextResponse.json({ ok: true, jukebox });
  } catch (error) {
    console.error("[my-jukebox:public:get]", error);
    return bad("Could not load that public jukebox.", 500);
  }
}

export async function POST(req: NextRequest, { params }: Props) {
  try {
    if (rateLimited(`public-my-jukebox-play:${clientIp(req)}`, 60)) return tooMany();
    const { slug } = await params;
    const jukebox = await getPublicMyJukebox(slug);
    if (!jukebox) return bad("That public jukebox does not exist.", 404);
    const body = await req.json().catch(() => ({}));
    const itemId = uuid(body.itemId);
    if (!itemId || !jukebox.items.some((item) => item.id === itemId)) return bad("That song is not in this jukebox.");
    const { data, error } = await sjb()
      .schema("jukebox")
      .from("jukeboxes")
      .select("id")
      .eq("is_public", true)
      .ilike("public_slug", jukebox.slug)
      .maybeSingle();
    if (error || !data) return bad("That public jukebox is unavailable.", 404);
    await logMyJukeboxPlay(sjb(), data.id, itemId, null);
    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[my-jukebox:public:post]", error);
    return bad("Could not record that play.", 500);
  }
}
