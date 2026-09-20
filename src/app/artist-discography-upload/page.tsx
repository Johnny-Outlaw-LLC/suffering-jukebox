import UploadApp from "./upload-app";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Upload Your Discography | Suffering Jukebox",
  description: "Upload albums, singles, and unreleased music as private drafts for artist rights review.",
};

export default function ArtistDiscographyUploadPage() {
  return <UploadApp />;
}
