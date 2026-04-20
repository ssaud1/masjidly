import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'
import {
  clean,
  getEventMediumTags,
  getQualityFlag,
  mediumLabel,
  normalizeEventTimes,
  timeSortKey,
} from './lib/event-utils'
import {
  chatWithEvents,
  getCalendarDownloadUrl,
  getMe,
  getMeta,
  getNotificationsPreview,
  getProfile,
  getSourceHealth,
  listEvents,
  listPastEvents,
  login,
  logout,
  register,
  reportIssue,
  updateProfile,
} from './lib/api'

const DEFAULT_RANGE_DAYS = 45

const audienceChoices = [
  ['all', 'All'],
  ['brothers', 'Brothers'],
  ['sisters', 'Sisters'],
  ['family', 'Family'],
  ['general', 'General'],
]

const todayIso = new Date().toISOString().slice(0, 10)
const defaultEnd = (() => {
  const d = new Date()
  d.setDate(d.getDate() + DEFAULT_RANGE_DAYS)
  return d.toISOString().slice(0, 10)
})()

function parseSourcesParam(raw) {
  return clean(raw)
    .split(',')
    .map((item) => clean(item).toLowerCase())
    .filter(Boolean)
}

function WebsiteGlyph() {
  return (
    <svg className="mediumSvg" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        d="M3 12h18M12 3a14 14 0 0 0 0 18M12 3a14 14 0 0 1 0 18"
      />
    </svg>
  )
}

function EmailGlyph() {
  return (
    <svg className="mediumSvg" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path fill="none" stroke="currentColor" strokeWidth="1.6" d="M3 7l9 6 9-6" />
    </svg>
  )
}

function InstagramGlyph() {
  return (
    <svg className="mediumSvg" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <circle cx="17" cy="7" r="1.3" fill="currentColor" />
    </svg>
  )
}

function EventMediumTags({ eventItem }) {
  const tags = getEventMediumTags(eventItem)
  const glyph = (id) => {
    if (id === 'instagram' || id === 'instagram_recurring') return <InstagramGlyph />
    if (id === 'email') return <EmailGlyph />
    return <WebsiteGlyph />
  }
  return (
    <span className="mediumTags" title={tags.map(mediumLabel).join(' · ')}>
      {tags.map((id) => (
        <span key={id} className={`mediumTag mediumTag--${id.replace(/[^a-z0-9-]/gi, '-')}`} aria-label={mediumLabel(id)}>
          {glyph(id)}
        </span>
      ))}
    </span>
  )
}

function dedupeEvents(rows) {
  const unique = new Map()
  for (const item of rows || []) {
    const key =
      clean(item.event_uid) ||
      [
        clean(item.source).toLowerCase(),
        clean(item.title).toLowerCase(),
        clean(item.date),
        clean(item.start_time).toLowerCase(),
        clean(item.source_url).toLowerCase(),
      ].join('|')
    if (!key) continue
    const existing = unique.get(key)
    if (!existing || Number(item.confidence || 0) > Number(existing.confidence || 0)) {
      unique.set(key, item)
    }
  }
  return [...unique.values()]
}

function eventSortKey(e) {
  return `${e.date || '9999-12-31'} ${timeSortKey(e.start_time)} ${e.title || ''}`.toLowerCase()
}

function inferAudience(eventItem) {
  const blob = [
    eventItem.audience,
    eventItem.category,
    eventItem.title,
    eventItem.description,
    eventItem.raw_text,
  ]
    .map((x) => String(x || ''))
    .join(' ')
    .toLowerCase()
  if (/\b(sister|sisters|women|womens|girls|female|hijabi)\b/.test(blob)) return 'sisters'
  if (/\b(brother|brothers|men|mens|boys|male|ikhwan)\b/.test(blob)) return 'brothers'
  if (/\b(family|families|parents|children|kids|youth)\b/.test(blob)) return 'family'
  return 'general'
}

function buildQueryParams(state) {
  const params = new URLSearchParams()
  params.set('screen', state.screen)
  params.set('view', state.viewMode)
  params.set('start', state.startDate)
  params.set('end', state.endDate)
  params.set('q', state.query)
  params.set('audience', state.audienceFilter)
  params.set('ref', state.reference)
  params.set('radius', String(state.radius))
  params.set('sources', state.selectedSources.join(','))
  if (state.lat && state.lon) {
    params.set('lat', String(state.lat))
    params.set('lon', String(state.lon))
  }
  return params
}

function getInitialUrlState() {
  const params = new URLSearchParams(window.location.search)
  const urlScreen = clean(params.get('screen')) === 'explore' ? 'explore' : 'home'
  const urlView = clean(params.get('view')) === 'list' ? 'list' : 'cards'
  const startDate = clean(params.get('start')) || todayIso
  const endDate = clean(params.get('end')) || defaultEnd
  const query = clean(params.get('q'))
  const audienceFilter = clean(params.get('audience')) || 'all'
  const reference = clean(params.get('ref')).toLowerCase()
  const radius = Number(params.get('radius') || 35)
  const selectedFromUrl = parseSourcesParam(params.get('sources'))
  const lat = Number(params.get('lat') || '')
  const lon = Number(params.get('lon') || '')
  return {
    screen: urlScreen,
    viewMode: urlView,
    startDate,
    endDate,
    query,
    audienceFilter,
    reference,
    radius: Number.isFinite(radius) ? Math.max(5, Math.min(100, radius)) : 35,
    selectedFromUrl,
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
  }
}

function App() {
  const initial = useMemo(() => getInitialUrlState(), [])
  const [sources, setSources] = useState([])
  const [sourcesReady, setSourcesReady] = useState(false)
  const [events, setEvents] = useState([])
  const [pastEvents, setPastEvents] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [screen, setScreen] = useState(initial.screen)
  const [viewMode, setViewMode] = useState(initial.viewMode)
  const [selectedSources, setSelectedSources] = useState([])
  const [reference, setReference] = useState(initial.reference)
  const [radius, setRadius] = useState(initial.radius)
  const [query, setQuery] = useState(initial.query)
  const [startDate, setStartDate] = useState(initial.startDate)
  const [endDate, setEndDate] = useState(initial.endDate)
  const [audienceFilter, setAudienceFilter] = useState(initial.audienceFilter)
  const [copied, setCopied] = useState(false)
  const [mobileFiltersOpen, setMobileFiltersOpen] = useState(false)
  // Default show all: "high only" hides most real rows (prayer-slot times, mid confidence).
  const [showAllQuality, setShowAllQuality] = useState(true)
  const [healthStats, setHealthStats] = useState([])
  const [isMobileViewport, setIsMobileViewport] = useState(
    typeof window !== 'undefined' ? window.innerWidth <= 860 : false
  )
  const [chatOpen, setChatOpen] = useState(false)
  const [chatInput, setChatInput] = useState('')
  const [chatLoading, setChatLoading] = useState(false)
  const [chatMessages, setChatMessages] = useState([
    {
      role: 'assistant',
      text: 'Ask me about upcoming events, timings, masjids, or RSVP links.',
    },
  ])
  const [currentUser, setCurrentUser] = useState(null)
  const [profileLoaded, setProfileLoaded] = useState(false)
  const [notificationsPreview, setNotificationsPreview] = useState([])
  const [authBusy, setAuthBusy] = useState(false)
  const [geoPoint, setGeoPoint] = useState(
    initial.lat && initial.lon ? { lat: initial.lat, lon: initial.lon } : null
  )

  const quickRanges = useMemo(
    () => [
      { id: 'today', label: 'Today', days: 0 },
      { id: '7d', label: '7 Days', days: 7 },
      { id: '30d', label: '30 Days', days: 30 },
      { id: '45d', label: '45 Days', days: 45 },
    ],
    []
  )

  const fetchEvents = useCallback(async () => {
    if (!sourcesReady || !startDate || !endDate) return
    if (!startDate || !endDate) return
    setLoading(true)
    setError('')
    try {
      const { events: data } = await listEvents({
        start: startDate,
        end: endDate,
        q: query,
        ref: reference,
        radius,
        lat: geoPoint?.lat,
        lon: geoPoint?.lon,
        sources: selectedSources.length > 0 && selectedSources.length < sources.length ? selectedSources : [],
      })

      let rows = dedupeEvents(data || [])
        .map((row) => normalizeEventTimes(row))
        .sort((a, b) => eventSortKey(a).localeCompare(eventSortKey(b)))
      rows = rows.filter((row) => (row.date || '') >= todayIso)
      if (audienceFilter !== 'all') {
        rows = rows.filter((row) => inferAudience(row) === audienceFilter)
      }
      if (!showAllQuality) {
        rows = rows.filter((row) => getQualityFlag(row) === 'high')
      }
      setEvents(rows)
    } catch (e) {
      setError(clean(e.message) || 'Could not load events from backend API.')
      setEvents([])
    } finally {
      setLoading(false)
    }
  }, [audienceFilter, endDate, geoPoint?.lat, geoPoint?.lon, query, radius, reference, selectedSources, showAllQuality, sources, sourcesReady, startDate])

  const fetchPastEvents = useCallback(async () => {
    if (!sourcesReady) return
    try {
      const { events: data } = await listPastEvents({
        q: query,
        sources: selectedSources.length > 0 && selectedSources.length < sources.length ? selectedSources : [],
        limit: 60,
      })
      let rows = dedupeEvents(data || []).sort((a, b) => eventSortKey(b).localeCompare(eventSortKey(a)))
      rows = rows.map((row) => normalizeEventTimes(row))
      if (audienceFilter !== 'all') {
        rows = rows.filter((row) => inferAudience(row) === audienceFilter)
      }
      if (!showAllQuality) {
        rows = rows.filter((row) => getQualityFlag(row) === 'high')
      }
      setPastEvents(rows)
    } catch {
      setPastEvents([])
    }
  }, [audienceFilter, query, selectedSources, showAllQuality, sources, sourcesReady])

  const fetchSourceHealth = useCallback(async () => {
    try {
      const { stats } = await getSourceHealth()
      setHealthStats(stats || [])
    } catch {
      setHealthStats([])
    }
  }, [])

  const loadAuthContext = useCallback(async () => {
    try {
      const me = await getMe()
      if (!me?.authenticated) {
        setCurrentUser(null)
        setProfileLoaded(true)
        return
      }
      setCurrentUser(me.user || null)
      const profileRes = await getProfile()
      const profile = profileRes?.profile || {}
      if (Array.isArray(profile.favorite_sources) && profile.favorite_sources.length) {
        setSelectedSources((prev) => (prev.length ? prev : profile.favorite_sources))
      }
      if (profile.audience_filter) setAudienceFilter(clean(profile.audience_filter))
      if (Number.isFinite(Number(profile.radius))) setRadius(Number(profile.radius))
      if (profile.home_lat && profile.home_lon) {
        setGeoPoint({ lat: Number(profile.home_lat), lon: Number(profile.home_lon) })
      }
      try {
        const previews = await getNotificationsPreview()
        setNotificationsPreview(previews?.previews || [])
      } catch {
        setNotificationsPreview([])
      }
    } catch {
      setCurrentUser(null)
      setNotificationsPreview([])
    } finally {
      setProfileLoaded(true)
    }
  }, [])

  const savePreferences = useCallback(async () => {
    if (!currentUser) return
    try {
      await updateProfile({
        favorite_sources: selectedSources,
        audience_filter: audienceFilter,
        radius,
        onboarding_done: true,
        home_lat: geoPoint?.lat || null,
        home_lon: geoPoint?.lon || null,
      })
    } catch {
      // keep UX smooth; preferences can be retried
    }
  }, [audienceFilter, currentUser, geoPoint?.lat, geoPoint?.lon, radius, selectedSources])

  const authFlow = useCallback(
    async (mode) => {
      if (authBusy) return
      const email = clean(window.prompt('Email address') || '').toLowerCase()
      if (!email) return
      const password = window.prompt('Password (6+ chars)') || ''
      if (!password) return
      setAuthBusy(true)
      try {
        if (mode === 'register') {
          await register({ email, password })
        } else {
          await login({ email, password })
        }
        await loadAuthContext()
      } catch (e) {
        window.alert(clean(e.message) || 'Authentication failed.')
      } finally {
        setAuthBusy(false)
      }
    },
    [authBusy, loadAuthContext]
  )

  const signOut = useCallback(async () => {
    await logout()
    setCurrentUser(null)
    setNotificationsPreview([])
  }, [])

  const useNearMe = useCallback(() => {
    if (!navigator.geolocation) {
      window.alert('Geolocation is not supported on this device.')
      return
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeoPoint({ lat: pos.coords.latitude, lon: pos.coords.longitude })
        setReference('')
      },
      () => window.alert('Could not access your location. Please enable location permission.')
    )
  }, [])

  const submitIssueReport = useCallback(
    async (eventItem) => {
      const issueType = clean(window.prompt('Issue type (title/speaker/poster/link/general)') || 'general')
      const details = clean(window.prompt('Optional details') || '')
      try {
        await reportIssue({
          event_uid: clean(eventItem.event_uid),
          issue_type: issueType || 'general',
          details,
        })
        window.alert('Issue submitted for moderation review.')
      } catch (e) {
        window.alert(clean(e.message) || 'Could not submit issue.')
      }
    },
    []
  )

  useEffect(() => {
    loadAuthContext()
  }, [loadAuthContext])

  useEffect(() => {
    const run = async () => {
      setLoading(true)
      setError('')
      try {
        const meta = await getMeta()
        const deduped = [...new Set((meta.sources || []).map((src) => clean(src).toLowerCase()).filter(Boolean))].sort()
        setSources(deduped)
        const requested = initial.selectedFromUrl.filter((src) => deduped.includes(src))
        setSelectedSources(requested.length ? requested : deduped)
        // Extend default range when the dataset runs past the UI window so list + calendar exports see all rows.
        if (meta?.max_date) {
          setEndDate((prev) => (meta.max_date > prev ? meta.max_date : prev))
        }
        setSourcesReady(true)
      } catch (e) {
        setError(clean(e.message) || 'Could not load sources from backend API.')
      } finally {
        setLoading(false)
      }
    }
    run()
  }, [initial.selectedFromUrl])

  useEffect(() => {
    if (!sourcesReady) return
    fetchEvents()
    fetchPastEvents()
    fetchSourceHealth()
  }, [fetchEvents, fetchPastEvents, fetchSourceHealth, sourcesReady])

  useEffect(() => {
    if (!profileLoaded || !currentUser) return
    savePreferences()
  }, [currentUser, profileLoaded, savePreferences])

  useEffect(() => {
    if (!sourcesReady) return
    const params = buildQueryParams({
      screen,
      viewMode,
      startDate,
      endDate,
      query,
      audienceFilter,
      reference,
      radius,
      selectedSources,
      lat: geoPoint?.lat,
      lon: geoPoint?.lon,
    })
    window.history.replaceState({}, '', `${window.location.pathname}?${params.toString()}`)
  }, [audienceFilter, endDate, geoPoint?.lat, geoPoint?.lon, query, radius, reference, screen, selectedSources, sourcesReady, startDate, viewMode])

  useEffect(() => {
    if (screen !== 'explore') {
      setMobileFiltersOpen(false)
    }
  }, [screen])

  useEffect(() => {
    const onResize = () => setIsMobileViewport(window.innerWidth <= 860)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  useEffect(() => {
    if (!isMobileViewport) setMobileFiltersOpen(false)
  }, [isMobileViewport])

  const upcomingHighlights = useMemo(() => {
    return events
      .filter((e) => (e.date || '') >= todayIso)
      .sort((a, b) => `${a.date || ''} ${a.start_time || ''}`.localeCompare(`${b.date || ''} ${b.start_time || ''}`))
      .slice(0, 8)
  }, [events])

  const toggleSource = (src) => {
    setSelectedSources((prev) => {
      if (prev.includes(src)) return prev.filter((item) => item !== src)
      return [...prev, src]
    })
  }
  const selectAllSources = () => setSelectedSources(sources)
  const clearSources = () => setSelectedSources([])

  const applyQuickRange = (days) => {
    const start = new Date()
    const end = new Date()
    end.setDate(end.getDate() + days)
    setStartDate(start.toISOString().slice(0, 10))
    setEndDate(end.toISOString().slice(0, 10))
  }

  const formatDay = (iso) => {
    if (!iso) return 'Date TBD'
    const d = new Date(`${iso}T00:00:00`)
    return d.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    })
  }

  const eventTime = (e) => {
    if (e.start_time && e.end_time) return `${e.start_time} - ${e.end_time}`
    if (e.start_time) return e.start_time
    return 'Time TBD'
  }

  const isBadPosterUrl = useCallback((url) => {
    if (!url) return true
    const low = url.toLowerCase()
    const blocked = ['logo', 'icon', 'favicon', 'avatar', 'facebook-negative', 'instagram-negative', 'youtube-negative', 'tribe-loading', 'loading.gif', 'blank.gif', 'pixel']
    return blocked.some((k) => low.includes(k))
  }, [])

  const posterFromEvent = useCallback((e) => {
    const urls = Array.isArray(e.image_urls) ? e.image_urls : []
    if (!urls.length) return ''
    const preferred = urls.find((u) => {
      const low = String(u || '').toLowerCase()
      if (isBadPosterUrl(low)) return false
      return low.includes('/uploads/') || low.includes('/media/') || low.endsWith('.jpg') || low.endsWith('.jpeg') || low.endsWith('.png') || low.endsWith('.webp') || low.includes('fill/w_') || low.includes('v1/fill/')
    })
    if (preferred) return preferred
    return urls.find((u) => !isBadPosterUrl(String(u || '').toLowerCase())) || ''
  }, [isBadPosterUrl])

  const orderedFilteredEvents = useMemo(
    () => [...events].sort((a, b) => eventSortKey(a).localeCompare(eventSortKey(b))),
    [events]
  )

  const grouped = useMemo(() => {
    const map = new Map()
    orderedFilteredEvents.forEach((e) => {
      if (!map.has(e.date)) map.set(e.date, [])
      map.get(e.date).push(e)
    })
    return map
  }, [orderedFilteredEvents])

  const [showPastEvents, setShowPastEvents] = useState(false)

  const pastGrouped = useMemo(() => {
    const map = new Map()
    pastEvents.forEach((e) => {
      if (!map.has(e.date)) map.set(e.date, [])
      map.get(e.date).push(e)
    })
    return map
  }, [pastEvents])

  const shareCurrentFilters = async () => {
    const shareUrl = window.location.href
    try {
      await navigator.clipboard.writeText(shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 1800)
    } catch {
      setCopied(false)
      window.prompt('Copy this link:', shareUrl)
    }
  }

  const sourceOptions = useMemo(() => [...sources].sort(), [sources])
  const activeFilterCount = useMemo(() => {
    let count = 0
    if (query) count += 1
    if (audienceFilter !== 'all') count += 1
    if (reference) count += 1
    if (selectedSources.length && selectedSources.length < sourceOptions.length) count += 1
    return count
  }, [audienceFilter, query, reference, selectedSources.length, sourceOptions.length])

  const sendChat = async () => {
    const message = clean(chatInput)
    if (!message || chatLoading) return
    setChatInput('')
    setChatLoading(true)
    setChatMessages((prev) => [...prev, { role: 'user', text: message }])
    try {
      const res = await chatWithEvents({
        message,
        filters: {
          start: startDate,
          end: endDate,
          query,
          reference,
          radius,
          lat: geoPoint?.lat,
          lon: geoPoint?.lon,
          sources: selectedSources,
        },
      })
      setChatMessages((prev) => [...prev, { role: 'assistant', text: clean(res.answer) || 'No answer available.' }])
    } catch (e) {
      setChatMessages((prev) => [
        ...prev,
        { role: 'assistant', text: `I could not answer right now. ${clean(e.message)}` },
      ])
    } finally {
      setChatLoading(false)
    }
  }

  const renderEventCard = (e, i, compact = false, isPast = false) => (
    <article className={`card ${compact ? 'compact' : ''}`} key={`${e.source}-${e.title}-${e.date}-${i}`}>
      {posterFromEvent(e) ? (
        <img className={`poster ${compact ? 'compactPoster' : ''}`} src={posterFromEvent(e)} alt={e.title} />
      ) : (
        <div className={`posterFallback ${compact ? 'compactPoster' : ''}`}>No poster</div>
      )}
      <div className="body">
        <div className="cardTop">
          <div className="cardTopLeft">
            <span className="sourcePill">{e.source.toUpperCase()}</span>
            <EventMediumTags eventItem={e} />
          </div>
          <div className="timeWrap">
            {isPast ? <span className="pastPill">Passed</span> : null}
            {getQualityFlag(e) === 'low' ? <span className="qualityPill">Needs review</span> : null}
            <span className="timePill">{eventTime(e)}</span>
          </div>
        </div>
        <h3>{e.title}</h3>
        <p className="meta">{e.date || 'Date TBD'}</p>
        {Number.isFinite(Number(e.distance_miles)) ? (
          <p className="meta">Distance: {Number(e.distance_miles).toFixed(1)} miles</p>
        ) : null}
        <p className="audienceTag">Audience: {inferAudience(e)}</p>
        {e.speaker ? <p className="speaker"><strong>Speaker:</strong> {e.speaker}</p> : null}
        {e.description ? <p className="desc">{e.description}</p> : null}
        <p className="where">
          <span className="emoji" aria-hidden="true">
            📍
          </span>{' '}
          {[e.location_name, e.address].filter(Boolean).join(' - ')}
        </p>
        <div className="links">
          {e.rsvp_link ? (
            <a href={e.rsvp_link} target="_blank" rel="noreferrer" className="actionBtn">
              RSVP
            </a>
          ) : null}
          {e.source_url ? (
            <a href={e.source_url} target="_blank" rel="noreferrer" className="actionBtn primary">
              Event Page
            </a>
          ) : null}
          {e.map_link ? (
            <a href={e.map_link} target="_blank" rel="noreferrer" className="actionBtn">
              Map
            </a>
          ) : null}
          <button type="button" className="actionBtn subtle" onClick={() => submitIssueReport(e)}>
            Report issue
          </button>
          <a href={getCalendarDownloadUrl(e.event_uid)} className="actionBtn subtle">
            Add to calendar
          </a>
          {e.deep_link?.web ? (
            <a href={e.deep_link.web} target="_blank" rel="noreferrer" className="actionBtn subtle">
              Deep link
            </a>
          ) : null}
        </div>
      </div>
    </article>
  )

  return (
    <div className="app">
      <header className="hero">
        <div className="heroTop">
          <div className="brandWrap">
            <img src="/masjidly.png" alt="Masjidly logo" className="logo" />
            <div>
              <h1>Masjidly</h1>
              <p>Discover trusted local masjid events in one clean place.</p>
              <div className="heroHighlights">
                <span>Trusted local sources</span>
                <span>Fast filters</span>
                <span>Mobile-friendly</span>
              </div>
            </div>
          </div>
          <div className="homeTabs">
            <button className={`vbtn ${screen === 'home' ? 'active' : ''}`} onClick={() => setScreen('home')}>
              Home
            </button>
            <button className={`vbtn ${screen === 'explore' ? 'active' : ''}`} onClick={() => setScreen('explore')}>
              Explore
            </button>
            <button className="vbtn" onClick={shareCurrentFilters}>
              {copied ? 'Copied!' : 'Share'}
            </button>
            {!currentUser ? (
              <>
                <button className="vbtn" onClick={() => authFlow('login')} disabled={authBusy}>
                  {authBusy ? 'Please wait...' : 'Sign in'}
                </button>
                <button className="vbtn" onClick={() => authFlow('register')} disabled={authBusy}>
                  Register
                </button>
              </>
            ) : (
              <button className="vbtn" onClick={signOut}>
                Sign out
              </button>
            )}
          </div>
        </div>
      </header>

      {screen === 'home' && (
        <>
          <section className="homeCard">
            <h2>Today in the Community</h2>
            <p>Browse upcoming programs, halaqas, classes, and family events in one place.</p>
            <div className="homeActions">
              <button className="apply" onClick={() => setScreen('explore')}>
                Browse Events
              </button>
              <button className="quickBtn" onClick={() => { applyQuickRange(7); setScreen('explore') }}>
                This Week
              </button>
            </div>
            <div className="badges">
              {sourceOptions.map((s) => (
                <span key={s} className="badge">
                  {s.toUpperCase()}
                </span>
              ))}
            </div>
          </section>

          <section className="homeCard">
            <h3 className="homeSectionTitle">What is Masjidly?</h3>
            <p className="explainLead">
              Masjidly helps you find upcoming events from trusted local masjids in one clean feed, with
              dates, times, location details, and links to official event pages.
            </p>
            <div className="explainGrid">
              <article className="explainItem">
                <h4>1. Discover events fast</h4>
                <p>
                  See classes, khutbah reminders, youth programs, sisters programs, and community events
                  without checking multiple websites.
                </p>
              </article>
              <article className="explainItem">
                <h4>2. Filter by what matters</h4>
                <p>
                  Filter by masjid source, audience, date range, and search terms so you can quickly find
                  the events relevant to you and your family.
                </p>
              </article>
              <article className="explainItem">
                <h4>3. Verify and act</h4>
                <p>
                  Open the official event page, use RSVP links when available, and report incorrect details
                  so the feed stays accurate for everyone.
                </p>
              </article>
            </div>
          </section>

          <section className="stats">
            <div className="pill">Events: <strong>{events.length}</strong></div>
            <div className="pill">Masjids: <strong>{new Set(events.map((e) => e.source)).size}</strong></div>
            <div className="pill">Upcoming: <strong>{upcomingHighlights.length}</strong></div>
            <div className="pill">Quality mode: <strong>{showAllQuality ? 'all' : 'high only'}</strong></div>
            <div className="pill">
              Account: <strong>{currentUser ? currentUser.email : 'Guest'}</strong>
            </div>
          </section>

          {currentUser && notificationsPreview.length ? (
            <section className="homeCard">
              <h3 className="homeSectionTitle">Notification Preview</h3>
              <div className="listCards">
                {notificationsPreview.slice(0, 4).map((item, idx) => (
                  <article key={`${item.type}-${idx}`} className="miniNotice">
                    <strong>{clean(item.type).replaceAll('_', ' ')}</strong>
                    <p>{item.text}</p>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          <section className="homeCard">
            <h3 className="homeSectionTitle">Upcoming Highlights</h3>
            {!upcomingHighlights.length && !loading && <div className="empty">No upcoming events yet.</div>}
            <div className="listCards">
              {upcomingHighlights.map((e, i) => renderEventCard(e, i, true))}
            </div>
          </section>
        </>
      )}

      {screen === 'explore' && (
        <>
          <section className="resultsHeader">
            <h2>Explore Events</h2>
            <p>
              Showing <strong>{events.length}</strong> events from <strong>{startDate}</strong> to <strong>{endDate}</strong>.
            </p>
            {isMobileViewport ? (
              <button className="mobileFilterToggle" onClick={() => setMobileFiltersOpen(true)}>
                Filters {activeFilterCount ? `(${activeFilterCount})` : ''}
              </button>
            ) : null}
          </section>

          {isMobileViewport && mobileFiltersOpen ? <button className="mobileBackdrop" aria-label="Close filters" onClick={() => setMobileFiltersOpen(false)} /> : null}
          <section className={`controls ${isMobileViewport ? 'mobileMode' : ''} ${mobileFiltersOpen ? 'open' : ''}`}>
            <div className="controlsTop">
              <h3>Refine events</h3>
              <button className="closeFilters" type="button" onClick={() => setMobileFiltersOpen(false)}>
                Done
              </button>
            </div>
            <div className="field">
              <label>From</label>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div className="field">
              <label>To</label>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
            </div>
            <div className="field">
              <label>Reference Masjid</label>
              <select value={reference} onChange={(e) => setReference(e.target.value)}>
                <option value="">All (no radius filter)</option>
                {sourceOptions.map((s) => (
                  <option value={s} key={s}>
                    {s.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Radius (miles)</label>
              <input type="number" min="5" max="100" step="5" value={radius} onChange={(e) => setRadius(Number(e.target.value || 35))} />
            </div>
            <div className="field search">
              <label>Search</label>
              <input
                type="text"
                placeholder="Title, details, speaker..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') fetchEvents()
                }}
              />
            </div>
            <button className="apply" onClick={() => { fetchEvents(); setMobileFiltersOpen(false) }} disabled={loading}>
              {loading ? 'Loading...' : 'Apply Filters'}
            </button>

            <div className="quickRow">
              {quickRanges.map((r) => (
                <button key={r.id} className="quickBtn" onClick={() => applyQuickRange(r.days)}>
                  {r.label}
                </button>
              ))}
              <div className="viewSwitch">
                <button className={`vbtn ${viewMode === 'cards' ? 'active' : ''}`} onClick={() => setViewMode('cards')}>
                  Cards
                </button>
                <button className={`vbtn ${viewMode === 'list' ? 'active' : ''}`} onClick={() => setViewMode('list')}>
                  List
                </button>
              </div>
              <button className="quickBtn" type="button" onClick={useNearMe}>
                Near me
              </button>
              {geoPoint ? (
                <button className="quickBtn" type="button" onClick={() => setGeoPoint(null)}>
                  Clear location
                </button>
              ) : null}
            </div>

            <div className="sourceActions">
              <button className="tinyBtn" onClick={selectAllSources}>Select all</button>
              <button className="tinyBtn" onClick={clearSources}>Clear</button>
            </div>
            <div className="audienceRow">
              {audienceChoices.map(([id, label]) => (
                <button key={id} className={`chip ${audienceFilter === id ? 'active' : ''}`} onClick={() => setAudienceFilter(id)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="sourceRow">
              {sourceOptions.map((src) => (
                <button className={`chip ${selectedSources.includes(src) ? 'active' : ''}`} key={src} onClick={() => toggleSource(src)}>
                  {src.toUpperCase()}
                </button>
              ))}
            </div>
          </section>

          <section className="stats">
            <div className="pill">Events: <strong>{events.length}</strong></div>
            <div className="pill">Masjids: <strong>{new Set(events.map((e) => e.source)).size}</strong></div>
            <div className="pill">Dedupe guard: <strong>on</strong></div>
            <div className="pill">Past archive: <strong>{pastEvents.length}</strong></div>
            <div className="pill">Quality mode: <strong>{showAllQuality ? 'all' : 'high only'}</strong></div>
            <div className="pill">Near me: <strong>{geoPoint ? 'on' : 'off'}</strong></div>
          </section>

          <section className="qualityBar">
            <button
              className={`chip ${showAllQuality ? '' : 'active'}`}
              onClick={() => setShowAllQuality(false)}
            >
              High confidence only
            </button>
            <button
              className={`chip ${showAllQuality ? 'active' : ''}`}
              onClick={() => setShowAllQuality(true)}
            >
              Show all
            </button>
          </section>

          {error && <div className="error">{error}</div>}
          {loading ? (
            <section className="skeletonGrid" aria-hidden="true">
              {Array.from({ length: 6 }).map((_, idx) => (
                <div className="skeletonCard" key={`s-${idx}`} />
              ))}
            </section>
          ) : null}
          {!loading && !events.length && !error && <div className="empty">No events found for this filter set.</div>}

          {[...grouped.entries()].map(([day, rows]) => (
            <section key={day} className="dayGroup">
              <h2>{formatDay(day)}</h2>
              <div className={viewMode === 'cards' ? 'cards' : 'listCards'}>
                {rows.map((e, i) => renderEventCard(e, i))}
              </div>
            </section>
          ))}

          <section className="pastSection">
            <div className="pastHeader">
              <h3>Past Events Archive</h3>
              <button className="quickBtn" onClick={() => setShowPastEvents((prev) => !prev)}>
                {showPastEvents ? 'Hide' : 'Show'} passed events
              </button>
            </div>
            <p className="pastNote">
              Upcoming feed stays clean. This section is only for events that already passed.
            </p>
            {showPastEvents ? (
              <>
                {!pastEvents.length ? <div className="empty">No past events found for this filter set.</div> : null}
                {[...pastGrouped.entries()].map(([day, rows]) => (
                  <section key={`past-${day}`} className="dayGroup">
                    <h2>{formatDay(day)}</h2>
                    <div className={viewMode === 'cards' ? 'cards pastCards' : 'listCards pastCards'}>
                      {rows.map((e, i) => renderEventCard(e, i, false, true))}
                    </div>
                  </section>
                ))}
              </>
            ) : null}
          </section>

          {healthStats.length ? (
            <section className="healthSection">
              <h3>Source Health</h3>
              <div className="healthGrid">
                {healthStats.map((row) => (
                  <article key={row.source} className="healthCard">
                    <h4>{row.source.toUpperCase()}</h4>
                    <p>Total rows: {row.total}</p>
                    <p>With poster: {row.posterPct}%</p>
                    <p>Exact time: {row.exactTimePct}%</p>
                    <p>Inferred description: {row.inferredDescPct}%</p>
                    <p>Low quality: {row.lowQualityPct}%</p>
                    <p>Duplicates: {row.duplicateRows}</p>
                    <p>Latest date: {row.latestDate || 'N/A'}</p>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}

      <button
        type="button"
        className="chatFab"
        onClick={() => setChatOpen((prev) => !prev)}
        aria-label="Toggle event assistant"
      >
        {chatOpen ? 'Close assistant' : 'Ask Masjidly'}
      </button>
      {chatOpen ? (
        <section className="chatPanel" aria-label="Masjidly chat assistant">
          <header className="chatHead">
            <h3>Masjidly Assistant</h3>
            <p>Ask about events, dates, times, and RSVP links.</p>
          </header>
          <div className="chatBody">
            {chatMessages.map((msg, idx) => (
              <article key={`${msg.role}-${idx}`} className={`chatMsg ${msg.role}`}>
                <strong>{msg.role === 'assistant' ? 'Assistant' : 'You'}</strong>
                <p>{msg.text}</p>
              </article>
            ))}
            {chatLoading ? <div className="chatLoading">Thinking...</div> : null}
          </div>
          <div className="chatInputRow">
            <input
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') sendChat()
              }}
              placeholder="e.g. What events are after Maghrib this week?"
            />
            <button type="button" className="apply" onClick={sendChat} disabled={chatLoading}>
              Send
            </button>
          </div>
        </section>
      ) : null}
    </div>
  )
}

export default App
