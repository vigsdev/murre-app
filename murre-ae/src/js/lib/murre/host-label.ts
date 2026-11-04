/**
 * A name for the After Effects this panel runs in, shown in the app when two are open at once:
 * "After Effects 2026", "After Effects 2026 Beta". `appPath` is the application path CEP gives
 * (for example "/Applications/Adobe After Effects (Beta)/Adobe After Effects (Beta).app"), `appVersion` its version ("26.0.1").
 */
export function hostLabelOf(appPath: string | null | undefined, appVersion: string | null | undefined): string {
  const major = Number.parseInt(String(appVersion ?? "").split(".")[0] ?? "", 10);
  // After Effects 2024 is version 24, 2025 is 25, and so on.
  const year = Number.isFinite(major) && major >= 20 && major < 100 ? 2000 + major : null;
  const beta = /beta/i.test(String(appPath ?? ""));
  const base = year ? `After Effects ${year}` : "After Effects";
  return beta ? `${base} Beta` : base;
}
