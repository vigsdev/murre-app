/**
 * Friendly names for hex colours, from the "best of" list of meodai/color-names
 * (MIT licence, see THIRD-PARTY.md). The list is loaded the first time it is needed.
 */
interface Entry {
  name: string
  l: number
  a: number
  b: number
}

let table: Promise<Entry[]> | null = null

function srgbToOklab(hex: string): [number, number, number] {
  const n = parseInt(hex.replace("#", "").slice(0, 6), 16)
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  const r = lin(((n >> 16) & 255) / 255)
  const g = lin(((n >> 8) & 255) / 255)
  const bl = lin((n & 255) / 255)
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * bl)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * bl)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * bl)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function load(): Promise<Entry[]> {
  return (table ??= import("color-name-list/bestof").then((m) =>
    m.colornames.map(({ name, hex }) => {
      const [l, a, b] = srgbToOklab(hex)
      return { name, l, a, b }
    }),
  ))
}

/** Squared OKLab distance below which a name is shown without "~" (practically the same colour). */
const EXACT = 0.0004

/** The closest name in the list; `approximate` is true when no entry is (nearly) the same colour. */
export async function nameColor(hex: string): Promise<{ name: string; approximate: boolean } | null> {
  if (!/^#[0-9a-f]{6}/i.test(hex)) return null
  try {
    const list = await load()
    const [l, a, b] = srgbToOklab(hex)
    let best = list[0]
    let bestD = Infinity
    for (const e of list) {
      const d = (e.l - l) ** 2 + (e.a - a) ** 2 + (e.b - b) ** 2
      if (d < bestD) {
        bestD = d
        best = e
      }
    }
    return { name: best.name, approximate: bestD > EXACT }
  } catch {
    return null // names are a nicety; the hex is always shown
  }
}
