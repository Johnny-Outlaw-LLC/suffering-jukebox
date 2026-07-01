import { servePublicHtml } from "@/lib/serve-html";

export async function GET() {
  return servePublicHtml("about", "index.html");
}
