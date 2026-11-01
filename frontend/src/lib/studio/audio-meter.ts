/** Show a linear audio peak on a readable -60 to 0 dBFS meter. */
export function audioMeterPercent(peak: number | undefined): number {
  if (!peak || !Number.isFinite(peak) || peak <= 0) return 0;
  const decibels = 20 * Math.log10(Math.min(1, peak));
  return Math.round(Math.max(0, Math.min(100, (decibels + 60) * 100 / 60)));
}
