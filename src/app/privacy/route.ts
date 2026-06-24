import { servePublicHtml } from "@/lib/serve-html";

export async function GET() {
  return servePublicHtml("privacy", "index.html");
}
