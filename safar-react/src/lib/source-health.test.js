import { describe, expect, it } from 'vitest'
import { computeSourceHealth } from './source-health'

describe('computeSourceHealth', () => {
  it('computes percentages and duplicate counts per source', () => {
    const rows = [
      {
        source: 'iceb',
        title: 'Event A',
        date: '2026-04-20',
        start_time: '7:00 pm',
        description: 'Regular event',
        image_urls: ['https://img.example/a.jpg'],
        confidence: 0.9,
      },
      {
        source: 'iceb',
        title: 'Event A',
        date: '2026-04-20',
        start_time: '7:00 pm',
        description: 'Regular event duplicate',
        image_urls: [],
        confidence: 0.7,
      },
      {
        source: 'nbic',
        title: 'Event B',
        date: '2026-04-21',
        start_time: 'After Isha',
        description: 'Check the event page for final details and any updates.',
        image_urls: [],
        confidence: 0.6,
      },
    ]
    const stats = computeSourceHealth(rows)
    const iceb = stats.find((s) => s.source === 'iceb')
    const nbic = stats.find((s) => s.source === 'nbic')

    expect(iceb.total).toBe(2)
    expect(iceb.posterPct).toBe(50)
    expect(iceb.duplicateRows).toBe(1)

    expect(nbic.total).toBe(1)
    expect(nbic.exactTimePct).toBe(0)
    expect(nbic.inferredDescPct).toBe(100)
  })
})
