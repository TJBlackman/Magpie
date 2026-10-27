/**
 * Text the parsers and the engine both put in labels and notes. No imports, so
 * the engine can use it without pulling in the UI (src/ui/format.ts holds what
 * only the popup needs).
 */

/** A length in seconds as "1h 5m", "3m 20s" or "20s". */
export function fmtDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m`;
  return m ? `${m}m ${s}s` : `${s}s`;
}

let names: Intl.DisplayNames | undefined;

/**
 * The English name of a BCP 47 language code: "en" and "eng" give "English",
 * "pt-BR" gives "Brazilian Portuguese". Manifests carry codes, and a label
 * reading "+ en" means little to most people. Falls back to the code when the
 * runtime does not know it or the code is malformed.
 */
export function languageName(code: string): string {
  try {
    names ??= new Intl.DisplayNames(['en'], { type: 'language' });
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}
