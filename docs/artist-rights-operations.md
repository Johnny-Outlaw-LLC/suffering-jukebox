# Artist Rights and Copyright Operations

This runbook separates private personal uploads from artist-authorized public mobile background play. Discovery and normal playback always use YouTube.

## Non-negotiable boundary

- `jukebox.track_audio` and the `jukebox-audio` bucket are owner-private.
- Uploading a file never publishes it.
- Public mobile background play requires an approved `artist_rights_agreements` row and an approved `artist_catalog_tracks` row.
- Public mobile background play uses a server-created expiring URL. The storage bucket remains private.
- The artist can withdraw an active application; withdrawal disables new public background-play URLs.

## Artist application review

Open `/artist-rights-admin` with an administrator account.

1. Confirm the authenticated account and legal identity are plausible.
2. Confirm the applicant can bind both the master recording owner and every required composition owner.
3. Compare the submitted stage name, website, ownership details, writers, publishers, and catalog tracks with independent evidence.
4. Identify any label, publisher, administrator, performing-rights organization, collective, co-writer, sample, beat license, cover, featured artist, or disputed band interest.
5. Reject or request separate written review if the self-service representations are incomplete or questionable.
6. Record the evidence and reasoning in the review note. Approval requires the independent-authority confirmation.

Do not approve Early Lines, Climate, or any other catalog merely because it exists in the database. The uploader must submit the versioned agreement and the reviewer must verify authority.

## Copyright notice workflow

Public intake is at `/dmca`; the restricted queue is in `/artist-rights-admin`.

1. Check that a notice identifies the protected work, the challenged location, claimant contact information, required statements, and signature.
2. Link the catalog track and account. Record every decision in the review note.
3. Disable access promptly when a complete, credible notice requires it. Record when the subscriber is notified.
4. Accept a valid counter-notice only when linked to the original reference. Record when it is forwarded to the claimant.
5. The console calculates a conservative fourteen-business-day restoration date. Do not restore when court action has been recorded.
6. Record strikes consistently. Termination immediately blocks private-audio reads/writes, suspends public background-play catalogs, and applies a long Supabase Auth ban. Preserve owner deletion/data-erasure handling.

Do not create fake notices in production to test the workflow. Use invalid requests that cannot be stored, or test in a non-production project.

## External items the application cannot complete

- Register and maintain the service provider's designated DMCA agent with the U.S. Copyright Office, then publish the registered agent's exact legal name, postal address, phone number, and email on `/dmca`.
- Have qualified counsel review the Terms, Artist Catalog License, privacy disclosures, direct-license/reporting obligations, repeat-infringer implementation, and the facts of the service.
- Establish a documented reviewer identity-verification standard and evidence-retention period.
- Add transactional email delivery for notices, counter-notices, review decisions, and account actions. Until then, sending is manual and the console records when it occurred.

## Release checks

- TypeScript and production build pass.
- New rights tables have RLS enabled and no direct `anon` or `authenticated` table privileges.
- The private bucket is still private.
- Unauthenticated rights/admin endpoints return `401`.
- `/api/sj-artist-audio` returns only approved tracks under an approved agreement.
- With no approved agreements, public licensed-audio results are empty.
