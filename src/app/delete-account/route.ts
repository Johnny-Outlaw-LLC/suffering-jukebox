import { NextRequest, NextResponse } from "next/server";
import { currentSurface } from "@/lib/surface";

export function GET(req: NextRequest) {
  const surface = currentSurface(req.headers.get("host"));
  return new NextResponse(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Delete your ${surface.name} account data</title>
<meta name="description" content="How to delete your ${surface.name} account and associated music data, in the app or through customer support.">
<link rel="canonical" href="${surface.url}/delete-account">
<link rel="icon" href="${surface.assetBase}/favicon-32.png">
<style>*{box-sizing:border-box}body{margin:0;background:#171717;color:#f5f1e9;font:18px/1.65 system-ui,sans-serif}main{width:100%;padding:32px 5vw}h1{font-size:clamp(2rem,4vw,3.5rem);line-height:1.15}h2{line-height:1.3}a{color:#ff9b73}section{padding:16px 0;border-bottom:1px solid #45413b}img{width:210px;height:auto}ol{padding-left:24px}nav{display:flex;gap:20px;flex-wrap:wrap}</style>
</head><body><main><nav><a href="/">${surface.name}</a><a href="/privacy">Privacy policy</a><a href="/help">Help</a></nav>
<h1>Delete your ${surface.name} account data</h1>
<p>Johnny Outlaw, LLC provides two ways to request deletion of your music account and its associated data. You do not need to reinstall the app.</p>
<section><h2>Delete it in the app or website</h2><ol><li>Open <a href="${surface.url}/">${surface.name}</a> and sign in to the account you want to remove.</li><li>Open your account menu, then Settings and Account.</li><li>Choose <strong>Delete my account</strong> and confirm the deletion after reviewing what will be removed.</li></ol><p>The account screen confirms when deletion has completed. This action cannot be undone.</p></section>
<section><h2>Request deletion through support</h2><p>If you cannot sign in, or have already uninstalled the app, <a href="mailto:support@outlawapps.online?subject=${encodeURIComponent(surface.name + " account and data deletion request")}">email support@outlawapps.online to request account and data deletion</a>. Include the email address used for your music account and specify whether you want all music account data or a particular category removed. Do not send a password. Support verifies ownership before processing a request and confirms when it is completed.</p></section>
<section><h2>What deletion affects</h2><p>The music account is shared across Record Keeper, Listening Party, and Suffering Jukebox. Deletion removes your shared music playlists, hearts, listening history, uploaded personal audio, Online Jukeboxes, and settings from these services. Public music and lyric corrections may remain with your identity removed. Records required to document artist licenses, reports, or legal obligations may be retained; see the <a href="/privacy">privacy policy</a>.</p><p>The shared Outlaw Apps sign-in identity is kept so that deletion of your music account does not delete unrelated products such as ShutterField. To request deletion of that sign-in identity or data in other products as well, say so in your support request.</p></section>
<p>© 2026 Johnny Outlaw, LLC</p></main></body></html>`, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
}
