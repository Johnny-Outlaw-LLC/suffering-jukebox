// /j/<code> — what a guest lands on after scanning the jukebox code.
//
// The first real React page in this app. Everything else under src/app is a
// route.ts that serves the static dashboard; this is deliberately its own
// small client app instead, because a phone on bar wifi should not download
// the whole dashboard to queue one song.

import type { Metadata, Viewport } from "next";
import { normalizeCode } from "@/lib/jukebox";
import { getJukeboxByCode, sjb } from "@/lib/jukebox-db";
import GuestApp from "./GuestApp";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ code: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { code: raw } = await params;
  const code = normalizeCode(raw ?? "");
  let name = "Jukebox";
  if (code) {
    try {
      const room = await getJukeboxByCode(sjb(), code);
      if (room) name = room.name;
    } catch {
      // A missing title is not worth failing the page render over.
    }
  }
  return {
    title: `${name} — Suffering Jukebox`,
    description: "Add a song to the jukebox.",
    // A room code is not something we want turning up in search results.
    robots: { index: false, follow: false },
  };
}

// Next wants these separately from metadata. viewport-fit=cover is what lets
// the fixed identity bar sit under the home indicator on an iPhone.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0a0a0a",
};

export default async function JukeboxGuestPage({ params }: Props) {
  const { code: raw } = await params;
  const code = normalizeCode(raw ?? "");
  if (!code) {
    return (
      <div style={{ minHeight: "100dvh", display: "grid", placeItems: "center", background: "#0a0a0a", color: "#888", fontFamily: "Inter, sans-serif", padding: "2rem", textAlign: "center" }}>
        That jukebox code does not look right. Check the card and try again.
      </div>
    );
  }
  return <GuestApp code={code} />;
}
