import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import App from './App'

vi.mock('./lib/api', () => {
  const today = new Date().toISOString().slice(0, 10)
  const eventRows = [
    {
      event_uid: '1',
      source: 'iceb',
      title: 'High Quality Event',
      description: 'Detailed event description',
      date: today,
      start_time: '19:00',
      end_time: '',
      location_name: 'ICEB',
      address: 'Address',
      city: 'East Brunswick',
      state: 'NJ',
      zip: '08816',
      category: '',
      audience: '',
      organizer: 'ICEB',
      rsvp_link: '',
      source_url: 'https://example.com/1',
      image_urls: ['https://example.com/a.jpg'],
      speaker: '',
      confidence: 0.95,
    },
    {
      event_uid: '2',
      source: 'iceb',
      title: 'Low Quality Event',
      description: 'Check the event page for final details and any updates.',
      date: today,
      start_time: 'After Isha',
      end_time: '',
      location_name: 'ICEB',
      address: 'Address',
      city: 'East Brunswick',
      state: 'NJ',
      zip: '08816',
      category: '',
      audience: '',
      organizer: 'ICEB',
      rsvp_link: '',
      source_url: 'https://example.com/2',
      image_urls: [],
      speaker: '',
      confidence: 0.7,
    },
  ]
  return {
    getMeta: vi.fn(async () => ({ sources: ['iceb'] })),
    listEvents: vi.fn(async () => ({ events: eventRows })),
    listPastEvents: vi.fn(async () => ({ events: [] })),
    getSourceHealth: vi.fn(async () => ({ stats: [] })),
    chatWithEvents: vi.fn(async () => ({ answer: 'Test response', matches: [] })),
    getCalendarDownloadUrl: vi.fn((uid) => `/api/events/${uid}/ics`),
    getMe: vi.fn(async () => ({ authenticated: false })),
    getProfile: vi.fn(async () => ({ profile: {} })),
    getNotificationsPreview: vi.fn(async () => ({ previews: [] })),
    login: vi.fn(async () => ({ token: 'test', user: { id: 1, email: 'test@example.com' } })),
    logout: vi.fn(async () => ({ ok: true })),
    register: vi.fn(async () => ({ token: 'test', user: { id: 1, email: 'test@example.com' } })),
    reportIssue: vi.fn(async () => ({ ok: true })),
    updateProfile: vi.fn(async () => ({ ok: true })),
  }
})

describe('App quality filtering', () => {
  it(
    'defaults to showing all quality and can filter to high only',
    async () => {
    render(<App />)

    await waitFor(() => expect(screen.getByText('High Quality Event')).toBeInTheDocument(), { timeout: 15000 })
    await waitFor(() => expect(screen.getByText('Low Quality Event')).toBeInTheDocument(), { timeout: 15000 })

    const exploreTab = screen.getByRole('button', { name: 'Explore' })
    fireEvent.click(exploreTab)

    const highOnlyBtn = await screen.findByRole('button', { name: 'High confidence only' })
    fireEvent.click(highOnlyBtn)

    await waitFor(() => expect(screen.queryByText('Low Quality Event')).not.toBeInTheDocument())

    const showAllBtn = screen.getByRole('button', { name: 'Show all' })
    fireEvent.click(showAllBtn)

    await waitFor(() => expect(screen.getByText('Low Quality Event')).toBeInTheDocument(), { timeout: 15000 })
    },
    20000,
  )
})
