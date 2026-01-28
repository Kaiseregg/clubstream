import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = (url && anon)
  ? createClient(url, anon, { auth: { persistSession: true, autoRefreshToken: true } })
  : null;

export function assertSupabase(){
  if(!supabase){
    throw new Error("Supabase ENV fehlt: VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY");
  }
}
