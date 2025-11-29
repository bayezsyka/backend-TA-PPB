// src/supabaseClient.ts
import "dotenv/config";
import { createClient } from "@supabase/supabase-js";

// Baca dari berbagai kemungkinan nama env
const supabaseUrl =
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || "";

const supabaseKey =
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";

// Validasi biar error-nya manusiawi, bukan "supabaseUrl is required"
if (!supabaseUrl) {
  throw new Error(
    [
      "SUPABASE_URL belum di-set.",
      "Set env ini dengan langkah berikut:",
      "",
      "• LOCAL  : buat file .env di folder backend, isi:",
      "    SUPABASE_URL=https://xxxx.supabase.co",
      "    SUPABASE_SERVICE_ROLE_KEY=xxxxx",
      "",
      "• VERCEL : di Project -> Settings -> Environment Variables,",
      "    tambah SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY.",
    ].join("\n")
  );
}

if (!supabaseKey) {
  throw new Error(
    [
      "SUPABASE_SERVICE_ROLE_KEY / SUPABASE_ANON_KEY belum di-set.",
      "",
      "• LOCAL  : di file .env backend, isi salah satu:",
      "    SUPABASE_SERVICE_ROLE_KEY=xxxxx   (disarankan untuk backend)",
      "    atau",
      "    SUPABASE_ANON_KEY=xxxxx",
      "",
      "• VERCEL : tambah env SUPABASE_SERVICE_ROLE_KEY (atau SUPABASE_ANON_KEY).",
    ].join("\n")
  );
}

// Client Supabase yang dipakai di seluruh aplikasi
export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: false,
  },
});
