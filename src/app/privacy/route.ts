import type { NextRequest } from "next/server";
import { serveSurfacePage } from "@/lib/serve-html";

export async function GET(req: NextRequest) {
  return serveSurfacePage(req.headers.get("host"), "privacy");
}
