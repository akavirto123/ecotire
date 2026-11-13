import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
const configured = !!url && !!anonKey && !url.includes('SEU-PROJETO') && !anonKey.includes('COLE_A_CHAVE');

/** null quando o .env ainda não foi preenchido: o app roda em modo demonstração (dados só no navegador). */
export const supabase: SupabaseClient | null = configured ? createClient(url!, anonKey!) : null;

export type Trip = {
  id: string;
  user_id: string;
  mode: 'gps' | 'sim' | 'plan' | 'passenger';
  vehicle_model: string;
  gross_weight_kg: number;
  distance_km: number;
  duration_s: number;
  avg_speed_kmh: number;
  max_speed_kmh: number;
  peak_accel_g: number;
  pm25_emitted_mg: number;
  pm25_avoided_mg: number;
  pm10_emitted_mg: number;
  pm10_avoided_mg: number;
  pm25_in_zones_mg: number;
  smooth_score: number;
  sensitive_zones_hit: number;
  zones_respected: number;
  origin_name: string | null;
  origin_lat: number | null;
  origin_lng: number | null;
  destination_name: string | null;
  destination_lat: number | null;
  destination_lng: number | null;
  passengers: number | null;
  trunk_fill_pct: number | null;
  started_at: string;
  created_at: string;
};

export type NewTrip = Omit<Trip, 'id' | 'user_id' | 'created_at'>;
