const pad = (n: number) => String(n).padStart(2, "0")

/** Local calendar date as `YYYY-MM-DD` (never goes through UTC). */
export function toIso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function parseIso(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number)
  return new Date(y, m - 1, d)
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1)
}

export interface DayCell {
  iso: string
  day: number
  inMonth: boolean
}

/** Six Monday-first weeks covering the month, so the grid never changes height. */
export function monthGrid(month: Date): DayCell[] {
  const first = startOfMonth(month)
  const offset = (first.getDay() + 6) % 7 // Monday = 0
  const cells: DayCell[] = []
  for (let i = 0; i < 42; i++) {
    const d = new Date(first.getFullYear(), first.getMonth(), 1 - offset + i)
    cells.push({ iso: toIso(d), day: d.getDate(), inMonth: d.getMonth() === first.getMonth() })
  }
  return cells
}

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
