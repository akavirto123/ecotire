export type Vehicle = {
  id: string;
  name: string;
  description: string;
  category: string;
  curbWeightKg: number;
  trunkCapacityKg: number;
  maxPassengers: number;
  /** true quando foi cadastrado pelo usuário */
  custom?: boolean;
};

/** Categorias genéricas (sem marca). Pesos são valores típicos de cada categoria. */
export const VEHICLE_CATEGORIES: Vehicle[] = [
  { id: 'ev-compact', name: 'Elétrico compacto', description: 'Hatch 100% elétrico urbano', category: 'BEV', curbWeightKg: 1450, trunkCapacityKg: 140, maxPassengers: 5 },
  { id: 'ev-sedan', name: 'Sedã elétrico', description: '100% elétrico de médio porte', category: 'BEV', curbWeightKg: 1850, trunkCapacityKg: 170, maxPassengers: 5 },
  { id: 'ev-suv', name: 'SUV elétrico', description: 'SUV 100% elétrico com bateria grande', category: 'BEV', curbWeightKg: 2150, trunkCapacityKg: 200, maxPassengers: 5 },
  { id: 'hev', name: 'Híbrido', description: 'Híbrido convencional (HEV)', category: 'HEV', curbWeightKg: 1450, trunkCapacityKg: 160, maxPassengers: 5 },
  { id: 'phev', name: 'Híbrido plug-in', description: 'SUV híbrido plug-in (PHEV)', category: 'PHEV', curbWeightKg: 1900, trunkCapacityKg: 190, maxPassengers: 5 },
  { id: 'pickup', name: 'Picape eletrificada', description: 'Picape média híbrida ou elétrica', category: 'Utilitário', curbWeightKg: 2400, trunkCapacityKg: 450, maxPassengers: 5 },
  { id: 'ice-compact', name: 'Combustão compacto', description: 'Referência: hatch a combustão', category: 'Combustão', curbWeightKg: 1100, trunkCapacityKg: 130, maxPassengers: 5 },
];

export const PASSENGER_AVG_WEIGHT_KG = 75;

export type GeoPlace = { name: string; lat: number; lng: number };

export type TripConfig = {
  passengers: number;
  trunkFillPct: number;
  origin: GeoPlace | null;
  destination: GeoPlace | null;
};

export const defaultTripConfig = (): TripConfig => ({ passengers: 1, trunkFillPct: 0, origin: null, destination: null });

export function payloadKg(v: Vehicle, cfg: Pick<TripConfig, 'passengers' | 'trunkFillPct'>): number {
  return cfg.passengers * PASSENGER_AVG_WEIGHT_KG + (v.trunkCapacityKg * cfg.trunkFillPct) / 100;
}

export function grossWeightKg(v: Vehicle, cfg: Pick<TripConfig, 'passengers' | 'trunkFillPct'>): number {
  return v.curbWeightKg + payloadKg(v, cfg);
}
