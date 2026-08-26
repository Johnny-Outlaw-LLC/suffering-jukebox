import { createClient } from "@supabase/supabase-js";

// These are the public browser credentials already used by the main Jukebox.
// Service-role access remains server-only in sj-admin-auth.ts.
export const SJ_SUPABASE_URL = "https://ntyvtpimesfoesuykuyi.supabase.co";
export const SJ_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpYXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im50eXZ0cGltZXNmb2VzdXlrdXlpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMTc0NjIsImV4cCI6MjA4OTU5MzQ2Mn0.S6hw0xc4PVKZy_OBj7eu8eRpGHEqZMJ6_6p_Lut1BpQ";

export const sjBrowserAuth = createClient(SJ_SUPABASE_URL, SJ_SUPABASE_ANON_KEY, {
  auth: { detectSessionInUrl: true, persistSession: true, flowType: "pkce" },
});
