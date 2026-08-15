import { servePublicHtml } from "@/lib/serve-html";

export async function GET() {
  return servePublicHtml("terms", "index.html");
}

