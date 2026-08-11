import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Paid unlock is paused — uploads are free (500 MB) for signed-in users. */
export async function POST() {
  return NextResponse.json(
    {
      ok: false,
      error: "Paid unlock is not available. Sign in to upload audio (500 MB limit).",
    },
    { status: 410 },
  );
}
