import { createHash } from "crypto";
import type { NextRequest } from "next/server";

export const ARTIST_AGREEMENT_VERSION = "2026-08-16.1";
export const ARTIST_OPERATOR = "Johnny Outlaw, LLC";
export const ARTIST_RIGHTS_EMAIL = "support@outlawapps.online";

export const ARTIST_AGREEMENT_SECTIONS = [
  {
    title: "Who may submit",
    body: "You must be at least 18 and either own the artist catalog or have written authority to bind every owner whose rights are needed. The self-service program is limited to original recordings and compositions; covers, uncleared samples, remixes, leased beats with incompatible terms, and recordings controlled by a label or publisher require separate written review.",
  },
  {
    title: "Rights you confirm",
    body: "You represent that you control the sound recording and the underlying music and lyrics, including the authority to directly license the digital performances, reproductions, and displays described here. You have disclosed and cleared every label, publisher, administrator, performing-rights organization, collective, performer, producer, writer, featured artist, artwork owner, and other contributor whose rights or agreement could affect this grant. You will promptly tell Suffering Jukebox if that changes.",
  },
  {
    title: "Nonexclusive mobile background-play license",
    body: "You grant Suffering Jukebox and its hosting and delivery vendors a worldwide, nonexclusive license to host, reproduce, encode, transcode, cache, publicly perform by digital audio transmission, and make incidental delivery copies of the submitted recordings solely when a listener deliberately uses mobile background play. Music discovery and normal playback continue to use the artist's YouTube links, not these uploaded audio files.",
  },
  {
    title: "No ownership transfer",
    body: "You keep ownership of your work. The license does not prevent you from distributing or licensing the same work elsewhere. Suffering Jukebox may not sell the recordings as downloads or license them into advertising, film, television, merchandise, training data, or a third-party catalog without a separate written agreement.",
  },
  {
    title: "Current compensation",
    body: "As between you and Suffering Jukebox, this license is royalty-free and neither party owes the other a fee for current mobile background-play streams unless both parties enter a separate written payment program. This does not waive, transfer, or excuse any payment, reporting, or consent obligation owed to a publisher, performing-rights organization, collective, label, contributor, or other third party. You may submit only if those obligations have been disclosed and do not prevent this direct grant.",
  },
  {
    title: "Review, removal, and termination",
    body: "Nothing is available for public mobile background play until Suffering Jukebox approves it. Either party may end the license for future use. Your withdrawal disables new public background-play access promptly; reasonable time may be needed to clear temporary caches and backups. Suffering Jukebox may suspend or remove material immediately for a rights dispute, legal request, security issue, policy violation, or risk to the service.",
  },
  {
    title: "Notices and cooperation",
    body: "You will cooperate with good-faith ownership questions and copyright notices. Knowingly false information may result in rejection, removal, account restriction, or termination. The repeat-infringer policy and DMCA process in the Terms apply to this submission.",
  },
  {
    title: "Responsibility",
    body: "You are responsible for claims caused by material you submitted without sufficient rights and agree to indemnify and hold harmless Suffering Jukebox, its operator, and service providers from resulting third-party claims, losses, and reasonable costs, to the extent permitted by law. This clause does not create rights you do not actually possess.",
  },
] as const;

export const ARTIST_AGREEMENT_TEXT = [
  `Suffering Jukebox Artist Catalog License — version ${ARTIST_AGREEMENT_VERSION}`,
  `Operator: ${ARTIST_OPERATOR}`,
  ...ARTIST_AGREEMENT_SECTIONS.map((section, index) =>
    `${index + 1}. ${section.title}\n${section.body}`,
  ),
].join("\n\n");

export const ARTIST_AGREEMENT_SHA256 = createHash("sha256")
  .update(ARTIST_AGREEMENT_TEXT, "utf8")
  .digest("hex");

export function artistAgreementPayload() {
  return {
    version: ARTIST_AGREEMENT_VERSION,
    sha256: ARTIST_AGREEMENT_SHA256,
    operator: ARTIST_OPERATOR,
    contact: ARTIST_RIGHTS_EMAIL,
    sections: ARTIST_AGREEMENT_SECTIONS,
    text: ARTIST_AGREEMENT_TEXT,
  };
}

export function requestAuditMeta(req: NextRequest) {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const real = req.headers.get("x-real-ip")?.trim();
  const candidate = forwarded || real || null;
  const ip = candidate && /^[0-9a-f:.]+$/i.test(candidate) ? candidate : null;
  return {
    ip,
    userAgent: req.headers.get("user-agent")?.slice(0, 1000) || null,
  };
}

export function cleanText(value: unknown, max: number, required = false) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ").slice(0, max);
  if (required && !text) throw new Error("A required field is missing.");
  return text || null;
}

export function isUuid(value: unknown): value is string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || ""),
  );
}
