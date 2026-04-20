import { describe, expect, it } from 'vitest'
import { getEventMediumTags, getQualityFlag, isExactClockTime, timeSortKey, toDisplayTime } from './event-utils'

describe('event-utils', () => {
  it('normalizes 24-hour time to HH:MM AM/PM', () => {
    expect(toDisplayTime('20:30')).toBe('08:30 PM')
    expect(toDisplayTime('06:05')).toBe('06:05 AM')
  })

  it('detects exact clock time correctly', () => {
    expect(isExactClockTime('6:45 pm')).toBe(true)
    expect(isExactClockTime('18:45')).toBe(true)
    expect(isExactClockTime('After Isha')).toBe(false)
  })

  it('sorts prayer-hint times predictably', () => {
    expect(timeSortKey('After Maghrib')).toBe('19:30')
    expect(timeSortKey('After Fajr')).toBe('05:30')
  })

  it('returns high quality for confident exact event', () => {
    const quality = getQualityFlag({
      confidence: 0.9,
      start_time: '06:30 PM',
      description: 'Weekly halaqa for families.',
    })
    expect(quality).toBe('high')
  })

  it('derives medium tags from merged_source_types', () => {
    expect(
      getEventMediumTags({
        source_type: 'website',
        merged_source_types: ['email', 'instagram'],
        source_url: 'https://example.com/e',
      }),
    ).toEqual(['website', 'email', 'instagram'])
  })

  it('infers instagram from source_url when source_type missing', () => {
    expect(
      getEventMediumTags({
        source_type: '',
        merged_source_types: [],
        source_url: 'https://www.instagram.com/p/abc/',
      }),
    ).toEqual(['instagram'])
  })

  it('returns high for prayer-slot time with typical confidence', () => {
    expect(
      getQualityFlag({
        confidence: 0.77,
        start_time: 'After Maghrib',
        description: 'Community iftar and short reminder.',
      }),
    ).toBe('high')
  })

  it('returns low quality for inferred fallback description', () => {
    const quality = getQualityFlag({
      confidence: 0.99,
      start_time: 'After one of the daily prayers',
      description: 'Check the event page for final details and any updates.',
    })
    expect(quality).toBe('low')
  })
})
