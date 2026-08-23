import { NextResponse } from "next/server";
import { explorePublicMyJukeboxes } from "@/lib/my-jukebox";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ ok: true, jukeboxes: await explorePublicMyJukeboxes() });
  } catch (error) {
    console.error("[my-jukebox:explore]", error);
    return NextResponse.json({ ok: false, error: "Could not load public jukeboxes." }, { status: 500 });
  }
}
