import { servePublicHtml } from "@/lib/serve-html";

export async function GET() {
  return servePublicHtml("help", "index.html");
}
