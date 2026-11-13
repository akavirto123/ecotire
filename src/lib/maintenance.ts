/** Lembretes de calibragem e rodízio. Pneu murcho ou gasto de forma desigual desgasta mais rápido e emite mais. */
export type Maintenance = {
  /** data (ISO) da última calibragem informada */
  calibratedAt: string | null;
  /** km monitorados pelo app no momento do último rodízio informado */
  rotationAtKm: number;
};

export const DEFAULT_MAINTENANCE: Maintenance = { calibratedAt: null, rotationAtKm: 0 };
/** Intervalos usuais de referência; o manual do veículo é quem manda. */
export const CALIBRATION_DAYS = 30;
export const ROTATION_KM = 10000;

export type MaintenanceStatus = {
  calibrationDue: boolean;
  /** dias desde a última calibragem (null = nunca informada) */
  daysSinceCalibration: number | null;
  rotationDue: boolean;
  kmSinceRotation: number;
  kmToRotation: number;
};

export function maintenanceStatus(m: Maintenance, drivenKm: number, now: Date = new Date()): MaintenanceStatus {
  const days = m.calibratedAt ? Math.floor((now.getTime() - new Date(m.calibratedAt).getTime()) / 86400000) : null;
  const kmSince = Math.max(0, drivenKm - m.rotationAtKm);
  return {
    calibrationDue: days == null || days >= CALIBRATION_DAYS,
    daysSinceCalibration: days,
    rotationDue: kmSince >= ROTATION_KM,
    kmSinceRotation: kmSince,
    kmToRotation: Math.max(0, ROTATION_KM - kmSince),
  };
}

/** Reduz uma foto para um quadrado pequeno (data URL JPEG), para caber no perfil sem precisar de armazenamento de arquivos. */
export async function fileToAvatar(file: File, size = 96): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Escolha um arquivo de imagem.');
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Não foi possível processar a imagem.');
  ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.82);
}
