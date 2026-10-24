import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { currentSurface } from "@/lib/surface";
import UploadApp from "./upload-app";

export async function generateMetadata(): Promise<Metadata> {
  const surface = currentSurface((await headers()).get("host"));
  return {
    title: `Upload Your Music | ${surface.name}`,
    description: `Upload albums, singles and unreleased original music to ${surface.name}. Files upload while you check the details, and nothing is public until you go public and the rights are confirmed.`,
    alternates: { canonical: `${surface.url.replace(/\/$/, "")}/artist-upload` },
  };
}

/** Also rendered at /artist-upload, which is the address every link uses. */
export default async function ArtistUploadPage() {
  const surface = currentSurface((await headers()).get("host"));
  // A brand without artist licensing sends the visitor to its own front door
  // rather than to a license it does not offer.
  if (!surface.features.artistUpload) redirect(`${surface.url}/`);
  return <UploadApp brand={{ name: surface.name }} />;
}
