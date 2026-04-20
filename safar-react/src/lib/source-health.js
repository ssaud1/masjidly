import { clean, getQualityFlag, isExactClockTime } from './event-utils'

export function computeSourceHealth(events) {
  const bySource = new Map()

  for (const row of events || []) {
    const source = clean(row.source).toLowerCase()
    if (!source) continue
    if (!bySource.has(source)) {
      bySource.set(source, {
        source,
        total: 0,
        withPoster: 0,
        exactTime: 0,
        inferredDescription: 0,
        lowQuality: 0,
        latestDate: '',
        duplicateRows: 0,
      })
    }
    const stat = bySource.get(source)
    stat.total += 1
    if ((row.image_urls || []).length > 0) stat.withPoster += 1
    if (isExactClockTime(row.start_time)) stat.exactTime += 1
    if (clean(row.description).toLowerCase().includes('check the event page for final details')) {
      stat.inferredDescription += 1
    }
    if (getQualityFlag(row) !== 'high') stat.lowQuality += 1
    const date = clean(row.date)
    if (date && (!stat.latestDate || date > stat.latestDate)) stat.latestDate = date
  }

  const seen = new Set()
  for (const row of events || []) {
    const source = clean(row.source).toLowerCase()
    if (!source || !bySource.has(source)) continue
    const key = [
      source,
      clean(row.title).toLowerCase(),
      clean(row.date),
      clean(row.start_time).toLowerCase(),
    ].join('|')
    if (seen.has(key)) {
      bySource.get(source).duplicateRows += 1
    } else {
      seen.add(key)
    }
  }

  return [...bySource.values()]
    .map((s) => ({
      ...s,
      posterPct: s.total ? Math.round((s.withPoster / s.total) * 100) : 0,
      exactTimePct: s.total ? Math.round((s.exactTime / s.total) * 100) : 0,
      inferredDescPct: s.total ? Math.round((s.inferredDescription / s.total) * 100) : 0,
      lowQualityPct: s.total ? Math.round((s.lowQuality / s.total) * 100) : 0,
      duplicateRows: s.duplicateRows,
    }))
    .sort((a, b) => a.source.localeCompare(b.source))
}
