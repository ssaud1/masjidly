export function clean(value) {
  return String(value ?? '').trim()
}

export function toDisplayTime(raw) {
  const text = clean(raw)
  if (!text) return ''
  if (/^after\s+/i.test(text)) return text

  const lower = text.toLowerCase()
  const ampmMatch = lower.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i)
  if (ampmMatch) {
    const h = ampmMatch[1].padStart(2, '0')
    const m = (ampmMatch[2] || '00').padStart(2, '0')
    return `${h}:${m} ${ampmMatch[3].toUpperCase()}`
  }

  const hhmmMatch = lower.match(/^(\d{1,2}):(\d{2})$/)
  if (hhmmMatch) {
    let h = Number(hhmmMatch[1])
    const m = hhmmMatch[2]
    const suffix = h >= 12 ? 'PM' : 'AM'
    h = h % 12 || 12
    return `${String(h).padStart(2, '0')}:${m} ${suffix}`
  }

  return text
}

export function isExactClockTime(raw) {
  const text = clean(raw).toLowerCase()
  if (!text) return false
  return /^(\d{1,2})(?::\d{2})?\s*(am|pm)$/.test(text) || /^(\d{1,2}):(\d{2})$/.test(text)
}

export function normalizeEventTimes(eventItem) {
  return {
    ...eventItem,
    start_time: toDisplayTime(eventItem.start_time),
    end_time: toDisplayTime(eventItem.end_time),
  }
}

export function getQualityFlag(eventItem) {
  const confidence = Number(eventItem.confidence || 0)
  const description = clean(eventItem.description).toLowerCase()
  const inferredDesc = description.includes('check the event page for final details')
  const exactTime = isExactClockTime(eventItem.start_time)
  const prayerSlot = /^after\s+(fajr|dhuhr|zuhr|asr|maghrib|isha|one of the daily prayers)/i.test(
    clean(eventItem.start_time),
  )
  // "High" is a soft badge: clock time OR common masjid slot + decent confidence, not generic filler text.
  if (!inferredDesc && confidence >= 0.72 && (exactTime || prayerSlot)) return 'high'
  if (confidence >= 0.85 && !inferredDesc) return 'high'
  return 'low'
}

const MEDIUM_ORDER = ['website', 'email', 'instagram', 'instagram_recurring']

/**
 * Which channels contributed to this event row (for UI badges).
 */
export function getEventMediumTags(eventItem) {
  const merged = Array.isArray(eventItem.merged_source_types)
    ? eventItem.merged_source_types.map((x) => clean(x).toLowerCase()).filter(Boolean)
    : []
  const primary = clean(eventItem.source_type).toLowerCase()
  const tags = new Set()
  if (primary) tags.add(primary)
  merged.forEach((m) => tags.add(m))
  if (!tags.size) {
    const url = clean(eventItem.source_url).toLowerCase()
    if (url.includes('instagram.com')) tags.add('instagram')
    else if (url.startsWith('mailto:') || url.startsWith('email://')) tags.add('email')
    else if (url.startsWith('http')) tags.add('website')
  }
  if (!tags.size) tags.add('website')
  const rank = (x) => {
    const i = MEDIUM_ORDER.indexOf(x)
    return i === -1 ? 99 : i
  }
  return [...tags].sort((a, b) => rank(a) - rank(b))
}

export function mediumLabel(id) {
  switch (clean(id).toLowerCase()) {
    case 'email':
      return 'Email'
    case 'instagram':
      return 'Instagram'
    case 'instagram_recurring':
      return 'Instagram'
    case 'website':
      return 'Website'
    default:
      return 'Web'
  }
}

export function timeSortKey(raw) {
  const text = clean(raw).toLowerCase()
  if (!text) return '99:99'
  if (/^after\s+fajr/.test(text)) return '05:30'
  if (/^after\s+(dhuhr|zuhr)/.test(text)) return '13:30'
  if (/^after\s+asr/.test(text)) return '16:30'
  if (/^after\s+maghrib/.test(text)) return '19:30'
  if (/^after\s+isha/.test(text)) return '21:30'
  if (/^after\s+one of the daily prayers/.test(text)) return '20:00'

  const ampmMatch = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/)
  if (ampmMatch) {
    let h = Number(ampmMatch[1]) % 12
    if (ampmMatch[3] === 'pm') h += 12
    const m = Number(ampmMatch[2] || '0')
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  }
  const hhmmMatch = text.match(/^(\d{1,2}):(\d{2})$/)
  if (hhmmMatch) {
    return `${hhmmMatch[1].padStart(2, '0')}:${hhmmMatch[2]}`
  }
  return '99:99'
}
