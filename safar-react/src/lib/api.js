function toQuery(params) {
  const q = new URLSearchParams()
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value === undefined || value === null) return
    if (Array.isArray(value)) {
      q.set(key, value.join(','))
      return
    }
    q.set(key, String(value))
  })
  return q.toString()
}

const AUTH_STORAGE_KEY = 'masjidly_auth_token'

async function readJson(response) {
  if (!response.ok) {
    const text = await response.text()
    throw new Error(text || `Request failed (${response.status})`)
  }
  return response.json()
}

export function getAuthToken() {
  return window.localStorage.getItem(AUTH_STORAGE_KEY) || ''
}

export function setAuthToken(token) {
  if (!token) {
    window.localStorage.removeItem(AUTH_STORAGE_KEY)
    return
  }
  window.localStorage.setItem(AUTH_STORAGE_KEY, token)
}

async function apiFetch(path, options = {}) {
  const token = getAuthToken()
  const headers = {
    ...(options.headers || {}),
  }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(path, { ...options, headers })
  return readJson(res)
}

export async function getMeta() {
  return apiFetch('/api/meta')
}

export async function listEvents(filters) {
  return apiFetch(`/api/events?${toQuery(filters)}`)
}

export async function listPastEvents(filters) {
  return apiFetch(`/api/events/past?${toQuery(filters)}`)
}

export async function getSourceHealth() {
  return apiFetch('/api/source-health')
}

export async function chatWithEvents(payload) {
  return apiFetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  })
}

export async function register(payload) {
  const data = await apiFetch('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  })
  if (data?.token) setAuthToken(data.token)
  return data
}

export async function login(payload) {
  const data = await apiFetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  })
  if (data?.token) setAuthToken(data.token)
  return data
}

export async function logout() {
  const data = await apiFetch('/api/auth/logout', { method: 'POST' })
  setAuthToken('')
  return data
}

export async function getMe() {
  return apiFetch('/api/auth/me')
}

export async function getProfile() {
  return apiFetch('/api/profile')
}

export async function updateProfile(payload) {
  return apiFetch('/api/profile', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  })
}

export async function getNotificationsPreview() {
  return apiFetch('/api/notifications/preview')
}

export async function reportIssue(payload) {
  return apiFetch('/api/moderation/report', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  })
}

export function getCalendarDownloadUrl(eventUid) {
  return `/api/events/${encodeURIComponent(eventUid)}/ics`
}
