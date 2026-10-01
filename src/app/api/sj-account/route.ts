import { NextRequest, NextResponse } from "next/server";
import { createSjServiceClient, getAuthUser, JUKEBOX_SCHEMA, SJ_PROTECTED_ADMIN_EMAIL } from "@/lib/sj-admin-auth";
import { bad, rateLimited, tooMany } from "@/lib/jukebox-request";
import { deleteB2AudioObject, isSafeAudioKey } from "@/lib/b2-audio";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/* Delete the signed-in person's Listening Party / Suffering Jukebox account.

   The sign-in itself is shared by every Outlaw Apps product, so it is left in
   place: deleting it would also delete the person's accounts on other sites.
   jukebox.delete_account_data removes everything this app holds about them
   (see its migration for what is deleted, what is anonymised and what is kept
   as a legal record), and the page signs out afterwards. */
export async function DELETE(req: NextRequest) {
  const user = await getAuthUser(req);
  if (!user?.email) return bad("Sign in to delete your account.", 401);
  if (rateLimited(`sj-account-delete:${user.id}`, 3, 60_000)) return tooMany();
  if (user.email.toLowerCase() === SJ_PROTECTED_ADMIN_EMAIL) {
    return bad("The site owner's account cannot be deleted from the app.", 403);
  }

  const sb = createSjServiceClient();
  const { data, error } = await sb.schema(JUKEBOX_SCHEMA).rpc("delete_account_data", {
    p_user_id: user.id,
    p_email: user.email,
  });
  if (error) {
    console.error("[sj-account:delete]", error.message);
    return bad("Your account could not be deleted. Nothing was removed; please try again.", 502);
  }

  // The rows are gone; the files they pointed at go next. A file that fails to
  // delete is logged rather than failing the request, because nothing can
  // reach it any more without its row.
  const paths: string[] = Array.isArray(data?.audio_paths) ? data.audio_paths : [];
  const results = await Promise.allSettled(
    paths.filter(isSafeAudioKey).map(path => deleteB2AudioObject(path)),
  );
  const failed = results.filter(r => r.status === "rejected").length;
  if (failed) console.error(`[sj-account:delete] ${failed} of ${paths.length} audio files were not removed for ${user.id}`);

  return NextResponse.json({ ok: true, deletedAudioFiles: paths.length - failed });
}
