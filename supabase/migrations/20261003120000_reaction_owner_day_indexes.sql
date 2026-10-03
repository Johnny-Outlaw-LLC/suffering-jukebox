-- CarPlay can remove one listener's hearts for a song either for the local
-- calendar day or for all time. These partial indexes keep both deletion and
-- the "my hearts" refresh bounded as the event table grows.

create index if not exists track_reactions_user_track_heart_created_idx
  on jukebox.track_reactions (user_id, track_id, created_at desc)
  where reaction = 'heart' and user_id is not null;

create index if not exists track_reactions_device_track_heart_created_idx
  on jukebox.track_reactions (device_id, track_id, created_at desc)
  where reaction = 'heart';

-- The stream signer checks a listener's newest upload of one track for every
-- song start. Keep that authorization lookup indexed independently of library
-- size; the audio bytes themselves go directly from B2 to the phone.
create index if not exists track_audio_owner_track_created_idx
  on jukebox.track_audio (uploaded_by, track_id, created_at desc)
  where storage_path is not null;
