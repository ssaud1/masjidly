import { NotoColorEmoji_400Regular, useFonts } from "@expo-google-fonts/noto-color-emoji";
import { StatusBar } from "expo-status-bar";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Device from "expo-device";
import * as Linking from "expo-linking";
import { LinearGradient } from "expo-linear-gradient";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import MapView, { Callout, Marker, type Region } from "react-native-maps";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import {
  AppState,
  Alert,
  ActivityIndicator,
  Animated,
  Easing,
  Image,
  InteractionManager,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  SectionList,
  Share,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";

type FreshnessInfo = {
  label: string;
  color: "green" | "yellow" | "orange" | "blue" | "gray" | string;
  source_type: string;
  posted_at?: string;
  days_old?: number | null;
};

type CorrectionInfo = {
  score: number;
  votes: number;
  open_reports: number;
  flagged: boolean;
  verified: boolean;
};

type EventItem = {
  event_uid?: string;
  source: string;
  title: string;
  description: string;
  raw_text?: string;
  poster_ocr_text?: string;
  audience?: string;
  category?: string;
  date: string;
  start_time: string;
  end_time: string;
  location_name: string;
  address: string;
  speaker: string;
  rsvp_link: string;
  source_url: string;
  source_type?: string;
  posted_at_utc?: string;
  image_urls: string[];
  deep_link?: { app?: string; web?: string };
  map_link?: string;
  distance_miles?: number;
  freshness?: FreshnessInfo;
  topics?: string[];
  correction?: CorrectionInfo;
  attendees?: { going?: number; interested?: number };
};

type EventSeries = {
  series_id: string;
  source: string;
  title: string;
  count: number;
  upcoming_count: number;
  image_url?: string;
  next_date: string;
  event_uids: string[];
};

type Speaker = {
  slug: string;
  name: string;
  total_events: number;
  upcoming_events: number;
  sources: string[];
  next_date?: string | null;
  next_title?: string;
  image_url?: string;
};

type MetaResponse = {
  sources: string[];
  default_reference: string;
  min_date: string;
  max_date: string;
  today: string;
  total_events: number;
  data_version?: string;
};

const EVENTS_CACHE_KEY = "masjidly_events_cache_v1";
const META_CACHE_KEY = "masjidly_meta_cache_v1";

type EventsCachePayload = {
  events: EventItem[];
  data_version: string;
  cached_at: number;
};

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL || "http://127.0.0.1:5060";
const TOKEN_KEY = "masjidly_auth_token";
const SAVED_EVENTS_KEY = "masjidly_saved_events_v1";
const PERSONALIZATION_KEY = "masjidly_personalization_v1";
const WELCOME_FLOW_DONE_KEY = "masjidly_welcome_flow_done_v1";
const THEME_KEY = "masjidly_theme_v1";
const FOLLOWED_MASJIDS_KEY = "masjidly_followed_masjids_v1";
const RSVP_STATUSES_KEY = "masjidly_rsvp_statuses_v1";
const FILTER_PRESETS_KEY = "masjidly_filter_presets_v1";
const FEEDBACK_RESPONSES_KEY = "masjidly_feedback_responses_v1";
const STREAK_TRACKER_KEY = "masjidly_streak_tracker_v1";
const REFERRAL_CODE_KEY = "masjidly_referral_code_v1";
const OFFICIAL_LOGO = require("./assets/masjidly-logo.png");
const TOPBAR_WORDMARK = require("./assets/masjidly-8-cropped.png");
const WELCOME_LOGO = require("./assets/masjidly-6.png");
const WELCOME_TOAST_TEXT = "Welcome!";
const CALENDAR_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MASJID_COORDS: Record<string, { latitude: number; longitude: number }> = {
  iceb: { latitude: 40.4308, longitude: -74.4122 },
  mcmc: { latitude: 40.5509, longitude: -74.4746 },
  iscj: { latitude: 40.3938, longitude: -74.546 },
  icpc: { latitude: 40.9061, longitude: -74.1637 },
  mcgp: { latitude: 40.2937, longitude: -74.6435 },
  darul_islah: { latitude: 40.8895, longitude: -74.0148 },
  nbic: { latitude: 40.4711, longitude: -74.457 },
  alfalah: { latitude: 40.5589, longitude: -74.6267 },
  masjid_al_wali: { latitude: 40.5944, longitude: -74.3547 },
  icsj: { latitude: 39.8516, longitude: -74.9746 },
  masjid_muhammad_newark: { latitude: 40.738, longitude: -74.2142 },
  icuc: { latitude: 40.6955, longitude: -74.2892 },
  ismc: { latitude: 40.3895, longitude: -74.1375 },
  mcnj: { latitude: 40.5412, longitude: -74.316 },
  icna_nj: { latitude: 40.4845, longitude: -74.528 },
  jmic: { latitude: 40.9042, longitude: -74.411 },
  icmc: { latitude: 40.8945, longitude: -74.5128 },
  icoc: { latitude: 39.9872, longitude: -74.2215 },
  bayonne_mc: { latitude: 40.6583, longitude: -74.1118 },
  hudson_ic: { latitude: 40.728, longitude: -74.042 },
  clifton_ic: { latitude: 40.8756, longitude: -74.1554 },
  isbc: { latitude: 40.6411, longitude: -74.5486 },
  mcjc: { latitude: 40.7252, longitude: -74.0692 },
  waarith: { latitude: 40.741, longitude: -74.214 },
};
const DEFAULT_MAP_REGION: Region = {
  latitude: 40.52,
  longitude: -74.43,
  latitudeDelta: 0.42,
  longitudeDelta: 0.42,
};
const MINERA_FONT_REGULAR = Platform.select({ ios: "Avenir Next", android: "sans-serif", default: "System" });
const MINERA_FONT_MEDIUM = Platform.select({ ios: "Avenir Next", android: "sans-serif-medium", default: "System" });
const MINERA_FONT_BOLD = Platform.select({ ios: "Avenir Next Demi Bold", android: "sans-serif-medium", default: "System" });

type UserAuth = {
  id: number;
  email: string;
};

type ProfilePayload = {
  favorite_sources: string[];
  audience_filter: string;
  radius: number;
  onboarding_done: boolean;
  home_lat?: number | null;
  home_lon?: number | null;
  expo_push_token?: string;
  notifications?: {
    new_event_followed: boolean;
    tonight_after_maghrib: boolean;
    rsvp_reminders: boolean;
  };
};

type PersonalizationPrefs = {
  name: string;
  heardFrom: string;
  gender: "brother" | "sister" | "prefer_not_to_say" | "";
  preferredAudience: "all" | "brothers" | "sisters";
  interests: string[];
  completed: boolean;
};

type ThemeMode = "minera" | "midnight" | "neo" | "vitaria" | "inferno" | "emerald";
type SortMode = "soonest" | "nearest" | "relevant" | "recent";
type ExploreMode = "list" | "map";
type RsvpStatus = "going" | "interested";
type QuickFilterId = "women" | "youth" | "family" | "after_maghrib" | "free" | "registration_required";

type SavedFilterPreset = {
  id: string;
  label: string;
  audienceFilter: "all" | "brothers" | "sisters" | "family";
  quickFilters: QuickFilterId[];
  sortMode: SortMode;
};

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function plusDaysIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatHumanDate(iso: string): string {
  if (!iso) return "Date TBD";
  const d = new Date(`${iso}T00:00:00`);
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function eventTime(e: EventItem): string {
  if (e.start_time && e.end_time) return `${e.start_time} - ${e.end_time}`;
  if (e.start_time) return e.start_time;
  return "Time TBD";
}

function parseClockForCalendar(raw: string): { hh: number; mm: number } | null {
  const text = normalizeText(raw).toLowerCase();
  if (!text) return null;
  const m = text.match(/^(\d{1,2}):(\d{2})(?:\s*(am|pm))?$/);
  if (!m) return null;
  let hh = Number(m[1]);
  const mm = Number(m[2]);
  const ampm = m[3];
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || mm < 0 || mm > 59) return null;
  if (ampm === "pm" && hh < 12) hh += 12;
  if (ampm === "am" && hh === 12) hh = 0;
  if (hh < 0 || hh > 23) return null;
  return { hh, mm };
}

function buildGoogleCalendarDates(e: EventItem): string {
  const day = normalizeText(e.date).replace(/-/g, "");
  if (!day) return "";
  const start = parseClockForCalendar(e.start_time || "");
  const end = parseClockForCalendar(e.end_time || "");
  if (start && end) {
    const startClock = `${String(start.hh).padStart(2, "0")}${String(start.mm).padStart(2, "0")}00`;
    const endClock = `${String(end.hh).padStart(2, "0")}${String(end.mm).padStart(2, "0")}00`;
    return `${day}T${startClock}/${day}T${endClock}`;
  }
  const base = new Date(`${e.date}T00:00:00`);
  if (!Number.isFinite(base.getTime())) return "";
  const next = new Date(base);
  next.setDate(base.getDate() + 1);
  const nextDay = next.toISOString().slice(0, 10).replace(/-/g, "");
  return `${day}/${nextDay}`;
}

function buildGoogleCalendarUrl(e: EventItem): string {
  const params = new URLSearchParams();
  params.set("action", "TEMPLATE");
  params.set("text", normalizeText(e.title || "Masjidly Event"));
  const details = normalizeText(e.description || e.raw_text || "");
  if (details) params.set("details", details);
  const location = normalizeText([e.location_name, e.address].filter(Boolean).join(" - "));
  if (location) params.set("location", location);
  const dates = buildGoogleCalendarDates(e);
  if (dates) params.set("dates", dates);
  params.set("ctz", "America/New_York");
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

function buildOutlookCalendarUrl(e: EventItem): string {
  const params = new URLSearchParams();
  params.set("path", "/calendar/action/compose");
  params.set("rru", "addevent");
  params.set("subject", normalizeText(e.title || "Masjidly Event"));
  const details = normalizeText(e.description || e.raw_text || "");
  if (details) params.set("body", details);
  const location = normalizeText([e.location_name, e.address].filter(Boolean).join(" - "));
  if (location) params.set("location", location);
  const start = parseClockForCalendar(e.start_time || "");
  const end = parseClockForCalendar(e.end_time || "");
  if (start) {
    params.set("startdt", `${e.date}T${String(start.hh).padStart(2, "0")}:${String(start.mm).padStart(2, "0")}:00`);
  } else {
    params.set("startdt", e.date);
  }
  if (end) {
    params.set("enddt", `${e.date}T${String(end.hh).padStart(2, "0")}:${String(end.mm).padStart(2, "0")}:00`);
  } else {
    const base = new Date(`${e.date}T00:00:00`);
    if (Number.isFinite(base.getTime())) {
      const next = new Date(base);
      next.setDate(base.getDate() + 1);
      params.set("enddt", next.toISOString().slice(0, 10));
    }
  }
  return `https://outlook.live.com/calendar/0/deeplink/compose?${params.toString()}`;
}

function normalizeText(s: string): string {
  return (s || "").replace(/\s+/g, " ").trim();
}

function formatSourceLabel(source: string): string {
  return normalizeText(source).replace(/_/g, " ").toUpperCase();
}

/**
 * Build 1–3 letter initials for a masjid source key (e.g. "icnanj" → "ICN",
 * "masjid_al_wali" → "MAW"). Skips filler words like "masjid", "center", "of".
 */
function masjidInitials(source: string): string {
  const raw = normalizeText(source).replace(/_/g, " ").trim();
  if (!raw) return "M";
  const filler = new Set([
    "masjid",
    "center",
    "centre",
    "islamic",
    "community",
    "of",
    "the",
    "and",
    "nj",
    "society",
    "association",
  ]);
  const words = raw
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/gi, ""))
    .filter(Boolean);
  const meaningful = words.filter((w) => !filler.has(w.toLowerCase()));
  const pick = meaningful.length ? meaningful : words;
  if (pick.length === 1) {
    const w = pick[0];
    return w.length >= 3 ? w.slice(0, 3).toUpperCase() : w.toUpperCase();
  }
  return pick
    .slice(0, 3)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/** Stable color per source key so each masjid pin/chip has a consistent identity. */
const MASJID_PALETTE = [
  "#1c4f82",
  "#2a6f4b",
  "#8a4a1f",
  "#5a3a8a",
  "#1f5c7a",
  "#7a1f4c",
  "#3e6e2a",
  "#c4572b",
  "#2c4f91",
  "#6a3aa8",
  "#3a7a6e",
  "#9a4a2a",
];
function masjidBrandColor(source: string): string {
  const key = normalizeText(source).toLowerCase();
  if (!key) return MASJID_PALETTE[0];
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return MASJID_PALETTE[hash % MASJID_PALETTE.length];
}

function isBoilerplateDescription(s: string): boolean {
  const low = normalizeText(s).toLowerCase();
  if (!low) return true;
  const boilerplateHints = [
    "was established",
    "for the purpose of upholding",
    "preserving and propagating",
    "our mission",
    "about us",
    "donate",
    "prayer times",
  ];
  return boilerplateHints.some((h) => low.includes(h));
}

/** Short topic / theme line for list cards (category, trimmed description, or excerpt). */
function eventTopicSummary(e: EventItem): string {
  const cat = normalizeText(e.category || "");
  if (cat) return cat.length > 130 ? `${cat.slice(0, 127)}…` : cat;
  const desc = normalizeText((e.description || "").replace(/<[^>]+>/g, " "));
  if (desc && !isBoilerplateDescription(desc)) {
    return desc.length > 150 ? `${desc.slice(0, 147)}…` : desc;
  }
  const raw = normalizeText(e.raw_text || e.poster_ocr_text || "");
  if (raw) return raw.length > 150 ? `${raw.slice(0, 147)}…` : raw;
  return "";
}

function inferSpeakerFromText(text: string): string {
  const t = normalizeText(text || "");
  if (!t) return "";
  const rx = /\b(?:imam|shaykh|sheikh|ustadh|dr\.?|qari)\s+[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,3}/i;
  const m = t.match(rx);
  return m ? normalizeText(m[0]) : "";
}

function pickPoster(urls: string[] = []): string {
  const bad = [
    "logo",
    "icon",
    "favicon",
    "avatar",
    "facebook-negative",
    "instagram-negative",
    "youtube-negative",
    "tribe-loading",
    "loading.gif",
    "blank.gif",
  ];
  const cleaned = urls.filter((u) => typeof u === "string" && u.startsWith("http"));
  const good = cleaned.find((u) => !bad.some((k) => u.toLowerCase().includes(k)));
  return good || "";
}

function isWeakPosterUrl(url: string): boolean {
  const low = (url || "").toLowerCase();
  const weak = [
    "logo",
    "brand",
    "header",
    "placeholder",
    "default",
    "avatar",
    "icon",
  ];
  return weak.some((w) => low.includes(w));
}

// --- Freshness pill (#41) ---
function freshnessColor(color?: string): { bg: string; text: string; dot: string } {
  switch ((color || "").toLowerCase()) {
    case "green":
      return { bg: "rgba(48,168,96,0.14)", text: "#1f7a42", dot: "#2fa15c" };
    case "yellow":
      return { bg: "rgba(214,158,46,0.16)", text: "#8a6a13", dot: "#d29a2a" };
    case "orange":
      return { bg: "rgba(214,99,46,0.16)", text: "#9a4311", dot: "#dd6b3a" };
    case "blue":
      return { bg: "rgba(59,110,217,0.16)", text: "#1b408c", dot: "#3b6ed9" };
    default:
      return { bg: "rgba(110,120,140,0.16)", text: "#4a556a", dot: "#6f7a90" };
  }
}

function freshnessLabelFor(e: EventItem): { label: string; color: string } {
  if (e.freshness) return { label: e.freshness.label, color: e.freshness.color };
  const st = (e.source_type || "").toLowerCase();
  if (st === "synthetic_jummah") return { label: "Weekly Jumu'ah", color: "blue" };
  if (st === "website") return { label: "Website", color: "gray" };
  if (st === "email") return { label: "Email", color: "yellow" };
  if (st === "instagram" || st === "instagram_recurring") return { label: "Instagram", color: "green" };
  return { label: "Source", color: "gray" };
}

const TOPIC_LABELS: Record<string, string> = {
  seerah: "Seerah",
  tafsir: "Tafsir",
  tajweed: "Tajweed",
  fiqh: "Fiqh",
  aqeedah: "Aqeedah",
  arabic: "Arabic",
  youth: "Youth",
  sisters: "Sisters",
  brothers: "Brothers",
  family: "Family",
  kids: "Kids",
  jumuah: "Jumu'ah",
  fundraiser: "Fundraiser",
  lecture: "Lecture",
};

const HALAQA_FILTER_TOPICS = ["seerah", "tafsir", "tajweed", "fiqh", "aqeedah", "arabic", "youth", "kids", "lecture"] as const;

// --- Personal event score (#16) ---
function buildPersonalScoreChip(
  e: EventItem,
  opts: { followedSources: Set<string>; rsvpStatuses: Record<string, RsvpStatus>; preferredAudience: string }
): { label: string; score: number } | null {
  const reasons: string[] = [];
  let score = 0;
  if (opts.followedSources.has(e.source)) {
    score += 40;
    reasons.push(`you follow ${formatSourceLabel(e.source)}`);
  }
  const aud = (e.audience || "").toLowerCase();
  if (opts.preferredAudience && opts.preferredAudience !== "all" && aud.includes(opts.preferredAudience)) {
    score += 25;
    reasons.push(`matches ${opts.preferredAudience}`);
  }
  if (e.speaker && opts.rsvpStatuses) {
    score += 10;
  }
  const topics = e.topics || [];
  if (topics.includes("has-speaker")) score += 5;
  if (topics.includes("lecture") || topics.includes("seerah") || topics.includes("tafsir")) score += 10;
  if (score <= 15) return null;
  const label = reasons.length ? `For you · ${reasons[0]}` : "Matches your interests";
  return { label, score };
}

// --- Drive time estimate (#14) ---
function haversineMiles(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 3958.8;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

function estimateDriveMinutes(miles: number): number {
  // Rough NJ suburban avg 35 mph, min 5 minutes to account for parking.
  return Math.max(5, Math.round((miles / 35) * 60));
}

async function getToken(): Promise<string> {
  return (await SecureStore.getItemAsync(TOKEN_KEY)) || "";
}

async function setToken(token: string): Promise<void> {
  if (!token) {
    await SecureStore.deleteItemAsync(TOKEN_KEY);
    return;
  }
  await SecureStore.setItemAsync(TOKEN_KEY, token);
}

async function apiJson(path: string, init?: RequestInit): Promise<any> {
  const token = await getToken();
  const headers: Record<string, string> = {
    ...(init?.headers ? (init.headers as Record<string, string>) : {}),
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Request failed (${res.status})`);
  }
  return res.json();
}

function readEventUidFromUrl(url: string): string {
  const cleaned = normalizeText(url);
  if (!cleaned) return "";
  const appMatch = cleaned.match(/masjidly:\/\/event\/([^/?#]+)/i);
  if (appMatch?.[1]) return appMatch[1];
  const webMatch = cleaned.match(/\/event\/([^/?#]+)/i);
  return webMatch?.[1] || "";
}

function eventStorageKey(e: EventItem): string {
  const fallback = `${e.source}|${e.title}|${e.date}|${e.start_time}`;
  return normalizeText(e.event_uid || fallback).toLowerCase();
}

function AppInner() {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [reference, setReference] = useState("");
  const [radius, setRadius] = useState("35");
  const [query, setQuery] = useState("");
  const [startDate, setStartDate] = useState(todayIso());
  const [endDate, setEndDate] = useState(plusDaysIso(45));
  const [audienceFilter, setAudienceFilter] = useState<"all" | "brothers" | "sisters" | "family">("all");
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<"home" | "explore" | "calendar" | "saved" | "settings">("home");
  const [mountedTabs, setMountedTabs] = useState<Set<"home" | "explore" | "calendar" | "saved" | "settings">>(
    () => new Set(["home"]) as Set<"home" | "explore" | "calendar" | "saved" | "settings">
  );
  const exploreScrollRef = useRef<ScrollView | null>(null);
  const calendarScrollRef = useRef<ScrollView | null>(null);
  const savedScrollRef = useRef<ScrollView | null>(null);
  const switchTab = useCallback((next: "home" | "explore" | "calendar" | "saved" | "settings") => {
    setMountedTabs((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
    setTab(next);
    // Snap each scene to the top when the user taps its tab so they always
    // land on the most relevant content (e.g. today's events on Explore).
    requestAnimationFrame(() => {
      if (next === "explore") exploreScrollRef.current?.scrollTo({ y: 0, animated: false });
      if (next === "calendar") calendarScrollRef.current?.scrollTo({ y: 0, animated: false });
      if (next === "saved") savedScrollRef.current?.scrollTo({ y: 0, animated: false });
    });
  }, []);
  useEffect(() => {
    // Pre-mount every tab scene once the app is idle. This makes subsequent
    // tab taps instant (no first-time MapView / JSX build cost on tap).
    const task = InteractionManager.runAfterInteractions(() => {
      setMountedTabs(
        new Set(["home", "explore", "calendar", "saved", "settings"]) as Set<
          "home" | "explore" | "calendar" | "saved" | "settings"
        >
      );
    });
    return () => task.cancel();
  }, []);
  const [entryScreen, setEntryScreen] = useState<"welcome" | "onboarding" | "launch" | "app">("welcome");
  const [selectedEvent, setSelectedEvent] = useState<EventItem | null>(null);
  const [currentUser, setCurrentUser] = useState<UserAuth | null>(null);
  const [deepLinkEventUid, setDeepLinkEventUid] = useState("");
  const [profileDraft, setProfileDraft] = useState<ProfilePayload>({
    favorite_sources: [],
    audience_filter: "all",
    radius: 35,
    onboarding_done: false,
    notifications: {
      new_event_followed: true,
      tonight_after_maghrib: true,
      rsvp_reminders: true,
    },
  });
  const [pushToken, setPushToken] = useState("");
  const [savedEventsMap, setSavedEventsMap] = useState<Record<string, EventItem>>({});
  const [themeMode, setThemeMode] = useState<ThemeMode>("minera");
  const [welcomeTypedText, setWelcomeTypedText] = useState("");
  const [onboardingError, setOnboardingError] = useState("");
  const [pendingWelcomeSlide, setPendingWelcomeSlide] = useState<number | null>(null);
  const [calendarView, setCalendarView] = useState<"month" | "list">("month");
  const [selectedCalendarDate, setSelectedCalendarDate] = useState("");
  const [selectedCalendarModalDate, setSelectedCalendarModalDate] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("relevant");
  const [exploreMode, setExploreMode] = useState<ExploreMode>("list");
  const [selectedMasjidSheet, setSelectedMasjidSheet] = useState("");
  const [showExploreFilters, setShowExploreFilters] = useState(false);
  const [quickFilters, setQuickFilters] = useState<QuickFilterId[]>([]);
  const [savedFilterPresets, setSavedFilterPresets] = useState<SavedFilterPreset[]>([]);
  const [presetDraftLabel, setPresetDraftLabel] = useState("");
  const [editingPresetId, setEditingPresetId] = useState("");
  const [mapRegion, setMapRegion] = useState<Region>(DEFAULT_MAP_REGION);
  const [followedMasjids, setFollowedMasjids] = useState<string[]>([]);
  const [rsvpStatuses, setRsvpStatuses] = useState<Record<string, RsvpStatus>>({});
  const [feedbackResponses, setFeedbackResponses] = useState<Record<string, "helpful" | "off" | "attended">>({});
  const [showModerationQueue, setShowModerationQueue] = useState(false);
  const [moderationReports, setModerationReports] = useState<any[]>([]);
  const [selectedMasjidProfile, setSelectedMasjidProfile] = useState("");
  const [reportIssueType, setReportIssueType] = useState("time");
  const [reportDetails, setReportDetails] = useState("");
  const [showReportSection, setShowReportSection] = useState(false);
  const [showFullDescription, setShowFullDescription] = useState(false);
  const [reflectionState, setReflectionState] = useState<{ event?: EventItem; rating: number; text: string } | null>(null);
  const [eventSeries, setEventSeries] = useState<EventSeries[]>([]);
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [scholarScreenOpen, setScholarScreenOpen] = useState(false);
  const [selectedSpeaker, setSelectedSpeaker] = useState<string | null>(null);
  const [halaqaFilter, setHalaqaFilter] = useState<string | null>(null);
  const [passportStamps, setPassportStamps] = useState<{ source: string; stamped_at: string }[]>([]);
  const [passportOpen, setPassportOpen] = useState(false);
  const [qrEntryBuffer, setQrEntryBuffer] = useState("");
  const [iqamaBySource, setIqamaBySource] = useState<Record<string, Record<string, { iqama: string; jumuah_times: string[] }>>>({});
  const [streakCount, setStreakCount] = useState(0);
  const [streakMonth, setStreakMonth] = useState(todayIso().slice(0, 7));
  const [goalCount] = useState(2);
  const [referralCode, setReferralCode] = useState("");
  const [lastSyncedAt, setLastSyncedAt] = useState<number>(Date.now());
  const [personalization, setPersonalization] = useState<PersonalizationPrefs>({
    name: "",
    heardFrom: "",
    gender: "",
    preferredAudience: "all",
    interests: [],
    completed: false,
  });
  const heroOpacity = useRef(new Animated.Value(0)).current;
  const heroTranslate = useRef(new Animated.Value(18)).current;
  const stepsOpacity = useRef(new Animated.Value(0)).current;
  const stepsTranslate = useRef(new Animated.Value(20)).current;
  const footerOpacity = useRef(new Animated.Value(0)).current;
  const footerTranslate = useRef(new Animated.Value(24)).current;
  const badgeScale = useRef(new Animated.Value(1)).current;
  const buttonScale = useRef(new Animated.Value(1)).current;
  const bubbleDrift = useRef(new Animated.Value(0)).current;
  const welcomeToastOpacity = useRef(new Animated.Value(0)).current;
  const welcomeToastTranslateY = useRef(new Animated.Value(-18)).current;
  const welcomeScrollX = useRef(new Animated.Value(0)).current;
  const onboardingCardOpacity = useRef(new Animated.Value(0)).current;
  const onboardingCardTranslateY = useRef(new Animated.Value(48)).current;
  const finishExitProgress = useRef(new Animated.Value(0)).current;
  const launchOpacity = useRef(new Animated.Value(0)).current;
  const launchScale = useRef(new Animated.Value(0.9)).current;
  const launchTranslateY = useRef(new Animated.Value(18)).current;
  const launchMessageOpacity = useRef(new Animated.Value(0)).current;
  const launchMessageTranslateY = useRef(new Animated.Value(20)).current;
  const launchPulse = useRef(new Animated.Value(0)).current;
  const launchGlowDrift = useRef(new Animated.Value(0)).current;
  const homeHeroGlowDrift = useRef(new Animated.Value(0)).current;
  const homeHeroGlowLoopRef = useRef<Animated.CompositeAnimation | null>(null);
  // (legacy explore intro-motion removed; tabs now stay mounted and switch instantly)
  const welcomeSlidesRef = useRef<ScrollView | null>(null);
  const [welcomeSlideIndex, setWelcomeSlideIndex] = useState(0);
  const { width: screenWidth, height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const eventModalPosterHeight = Math.min(240, Math.round(windowHeight * 0.26));
  const modalChromeTopPad = Math.max(insets.top, 12);
  const [notoEmojiLoaded] = useFonts({ NotoColorEmoji_400Regular });
  const emojiFontStyle = notoEmojiLoaded ? { fontFamily: "NotoColorEmoji_400Regular" as const } : {};
  const isMidnight = themeMode === "midnight";
  const isNeo = themeMode === "neo";
  const isVitaria = themeMode === "vitaria";
  const isInferno = themeMode === "inferno";
  const isMinera = themeMode === "minera";
  const isEmerald = themeMode === "emerald";
  const isDarkTheme = isMidnight || isVitaria || isInferno;
  const themeBadgeLabel = isInferno
    ? "INFERNO"
    : isEmerald
      ? "EMERALD"
    : isVitaria
      ? "VITARIA"
      : isNeo
        ? "NEO"
        : isMidnight
          ? "MIDNIGHT"
          : "MINERA";
  const inputPlaceholderColor = isDarkTheme ? "#d4c0b5" : isNeo ? "#646464" : isEmerald ? "#4f7a5d" : "#8fa0bf";

  useEffect(() => {
    const loadMeta = async () => {
      try {
        const data = (await apiJson("/api/meta")) as MetaResponse;
        remoteDataVersionRef.current = data.data_version || "";
        setMeta(data);
        setReference("");
        const start = data.today || todayIso();
        const endGuess = plusDaysIso(90);
        // Load through the last event in the dataset when it extends beyond the default window,
        // so Calendar / export see every upcoming row the API holds.
        const end =
          data.max_date && data.max_date > endGuess
            ? data.max_date
            : data.max_date && data.max_date < endGuess
              ? data.max_date
              : endGuess;
        setStartDate(start);
        setEndDate(end);
        setSelectedSources((prev) => (prev.size ? prev : new Set(data.sources || [])));
        AsyncStorage.setItem(META_CACHE_KEY, JSON.stringify(data)).catch(() => {});
      } catch (e) {
        setError((e as Error).message || "Could not connect to backend API");
      }
    };
    loadMeta();
  }, []);

  useEffect(() => {
    const loadSaved = async () => {
      try {
        const raw = await SecureStore.getItemAsync(SAVED_EVENTS_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as Record<string, EventItem>;
        if (parsed && typeof parsed === "object") setSavedEventsMap(parsed);
      } catch {
        // ignore invalid saved cache
      }
    };
    loadSaved();
  }, []);

  useEffect(() => {
    const loadPersonalization = async () => {
      try {
        const raw = await SecureStore.getItemAsync(PERSONALIZATION_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as PersonalizationPrefs;
        if (!parsed || typeof parsed !== "object") return;
        setPersonalization({
          name: normalizeText(parsed.name || ""),
          heardFrom: normalizeText((parsed as any).heardFrom || ""),
          gender:
            (parsed as any).gender === "brother" || (parsed as any).gender === "sister" || (parsed as any).gender === "prefer_not_to_say"
              ? (parsed as any).gender
              : "",
          preferredAudience:
            parsed.preferredAudience === "brothers" || parsed.preferredAudience === "sisters"
              ? parsed.preferredAudience
              : "all",
          interests: Array.isArray(parsed.interests)
            ? parsed.interests.map((x) => normalizeText(String(x))).filter(Boolean)
            : [],
          completed: !!parsed.completed,
        });
      } catch {
        // ignore invalid cached personalization
      }
    };
    loadPersonalization();
  }, []);

  useEffect(() => {
    const loadTheme = async () => {
      try {
        const raw = await SecureStore.getItemAsync(THEME_KEY);
        if (raw === "midnight" || raw === "minera" || raw === "neo" || raw === "vitaria" || raw === "inferno" || raw === "emerald") {
          setThemeMode(raw);
        }
      } catch {
        // keep default theme
      }
    };
    loadTheme();
  }, []);

  useEffect(() => {
    const loadLocalBehavior = async () => {
      try {
        const [followedRaw, rsvpRaw, presetsRaw, feedbackRaw, streakRaw, referralRaw] = await Promise.all([
          SecureStore.getItemAsync(FOLLOWED_MASJIDS_KEY),
          SecureStore.getItemAsync(RSVP_STATUSES_KEY),
          SecureStore.getItemAsync(FILTER_PRESETS_KEY),
          SecureStore.getItemAsync(FEEDBACK_RESPONSES_KEY),
          SecureStore.getItemAsync(STREAK_TRACKER_KEY),
          SecureStore.getItemAsync(REFERRAL_CODE_KEY),
        ]);
        if (followedRaw) {
          const parsed = JSON.parse(followedRaw);
          if (Array.isArray(parsed)) setFollowedMasjids(parsed.map((x) => normalizeText(String(x))).filter(Boolean));
        }
        if (rsvpRaw) {
          const parsed = JSON.parse(rsvpRaw);
          if (parsed && typeof parsed === "object") setRsvpStatuses(parsed as Record<string, RsvpStatus>);
        }
        if (presetsRaw) {
          const parsed = JSON.parse(presetsRaw);
          if (Array.isArray(parsed)) setSavedFilterPresets(parsed as SavedFilterPreset[]);
        } else {
          setSavedFilterPresets([
            { id: "weekend-family", label: "Weekend family", audienceFilter: "family", quickFilters: ["family"], sortMode: "soonest" },
            { id: "brothers-nightly", label: "Brothers nightly", audienceFilter: "brothers", quickFilters: ["after_maghrib"], sortMode: "relevant" },
            { id: "sisters-weekly", label: "Sisters weekly", audienceFilter: "sisters", quickFilters: ["women"], sortMode: "soonest" },
          ]);
        }
        if (feedbackRaw) {
          const parsed = JSON.parse(feedbackRaw);
          if (parsed && typeof parsed === "object") setFeedbackResponses(parsed as Record<string, "helpful" | "off" | "attended">);
        }
        if (streakRaw) {
          const parsed = JSON.parse(streakRaw);
          if (parsed && typeof parsed === "object") {
            const month = normalizeText(String((parsed as any).month || ""));
            const count = Number((parsed as any).count || 0);
            if (month) setStreakMonth(month);
            if (Number.isFinite(count) && count >= 0) setStreakCount(count);
          }
        }
        if (referralRaw) {
          setReferralCode(referralRaw);
        } else {
          const generated = `M-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
          setReferralCode(generated);
          await SecureStore.setItemAsync(REFERRAL_CODE_KEY, generated);
        }
      } catch {
        // ignore non-blocking local behavior cache errors
      }
    };
    loadLocalBehavior();
  }, []);

  useEffect(() => {
    loadProfile();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!savedFilterPresets.length) return;
    SecureStore.setItemAsync(FILTER_PRESETS_KEY, JSON.stringify(savedFilterPresets)).catch(() => {
      // ignore preset cache write failures
    });
  }, [savedFilterPresets]);


  useEffect(() => {
    registerPush();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentUser]);

  useEffect(() => {
    if (entryScreen !== "welcome") return;
    const startSlide = pendingWelcomeSlide === 1 || pendingWelcomeSlide === 2 ? pendingWelcomeSlide : 0;
    setWelcomeSlideIndex(startSlide);
    welcomeSlidesRef.current?.scrollTo({ x: startSlide * screenWidth, y: 0, animated: false });
    welcomeScrollX.setValue(startSlide * screenWidth);
    finishExitProgress.setValue(0);
    if (pendingWelcomeSlide !== null) setPendingWelcomeSlide(null);
    heroOpacity.setValue(0);
    heroTranslate.setValue(18);
    stepsOpacity.setValue(0);
    stepsTranslate.setValue(20);
    footerOpacity.setValue(0);
    footerTranslate.setValue(24);
    bubbleDrift.setValue(0);
    welcomeToastOpacity.setValue(0);
    welcomeToastTranslateY.setValue(-18);
    setWelcomeTypedText("");

    Animated.sequence([
      Animated.parallel([
        Animated.timing(heroOpacity, {
          toValue: 1,
          duration: 420,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(heroTranslate, {
          toValue: 0,
          duration: 460,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
      Animated.parallel([
        Animated.timing(stepsOpacity, {
          toValue: 1,
          duration: 380,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(stepsTranslate, {
          toValue: 0,
          duration: 420,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
      Animated.parallel([
        Animated.timing(footerOpacity, {
          toValue: 1,
          duration: 360,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(footerTranslate, {
          toValue: 0,
          duration: 400,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
    ]).start();

    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(badgeScale, {
          toValue: 1.06,
          duration: 1600,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(badgeScale, {
          toValue: 1,
          duration: 1600,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );
    const bubbleFloat = Animated.loop(
      Animated.sequence([
        Animated.timing(bubbleDrift, {
          toValue: 1,
          duration: 2800,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(bubbleDrift, {
          toValue: 0,
          duration: 2800,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );
    const welcomeToast = Animated.sequence([
      Animated.delay(450),
      Animated.parallel([
        Animated.timing(welcomeToastOpacity, {
          toValue: 1,
          duration: 300,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(welcomeToastTranslateY, {
          toValue: 0,
          duration: 340,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
      Animated.delay(1700),
      Animated.parallel([
        Animated.timing(welcomeToastOpacity, {
          toValue: 0,
          duration: 280,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(welcomeToastTranslateY, {
          toValue: -16,
          duration: 280,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
    ]);
    let typingInterval: ReturnType<typeof setInterval> | null = null;
    const typingStart = setTimeout(() => {
      let nextLength = 0;
      setWelcomeTypedText("");
      typingInterval = setInterval(() => {
        nextLength += 1;
        setWelcomeTypedText(WELCOME_TOAST_TEXT.slice(0, nextLength));
        if (nextLength >= WELCOME_TOAST_TEXT.length && typingInterval) {
          clearInterval(typingInterval);
          typingInterval = null;
        }
      }, 120);
    }, 560);
    pulse.start();
    bubbleFloat.start();
    welcomeToast.start();
    return () => {
      clearTimeout(typingStart);
      if (typingInterval) clearInterval(typingInterval);
      pulse.stop();
      bubbleFloat.stop();
      welcomeToast.stop();
    };
  }, [
    bubbleDrift,
    badgeScale,
    entryScreen,
    footerOpacity,
    footerTranslate,
    finishExitProgress,
    heroOpacity,
    heroTranslate,
    pendingWelcomeSlide,
    screenWidth,
    stepsOpacity,
    stepsTranslate,
    welcomeToastOpacity,
    welcomeToastTranslateY,
    welcomeScrollX,
    welcomeSlidesRef,
  ]);

  useEffect(() => {
    if (entryScreen !== "onboarding") return;
    onboardingCardOpacity.setValue(0);
    onboardingCardTranslateY.setValue(56);
    Animated.parallel([
      Animated.timing(onboardingCardOpacity, {
        toValue: 1,
        duration: 320,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(onboardingCardTranslateY, {
        toValue: 0,
        duration: 360,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [entryScreen, onboardingCardOpacity, onboardingCardTranslateY]);

  useEffect(() => {
    if (entryScreen !== "launch") return;
    launchOpacity.setValue(0);
    launchScale.setValue(0.9);
    launchTranslateY.setValue(18);
    launchMessageOpacity.setValue(0);
    launchMessageTranslateY.setValue(20);
    launchPulse.setValue(0);
    launchGlowDrift.setValue(0);
    const intro = Animated.sequence([
      Animated.parallel([
        Animated.timing(launchMessageOpacity, {
          toValue: 1,
          duration: 700,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(launchMessageTranslateY, {
          toValue: 0,
          duration: 700,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
      Animated.delay(140),
      Animated.parallel([
        Animated.timing(launchOpacity, {
          toValue: 1,
          duration: 760,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.spring(launchScale, {
          toValue: 1,
          friction: 8,
          tension: 62,
          useNativeDriver: true,
        }),
        Animated.timing(launchTranslateY, {
          toValue: 0,
          duration: 820,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
      Animated.delay(1300),
      Animated.parallel([
        Animated.timing(launchOpacity, {
          toValue: 0,
          duration: 520,
          easing: Easing.inOut(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(launchTranslateY, {
          toValue: -68,
          duration: 520,
          easing: Easing.inOut(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(launchScale, {
          toValue: 1.04,
          duration: 520,
          easing: Easing.inOut(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(launchMessageOpacity, {
          toValue: 0.72,
          duration: 420,
          easing: Easing.inOut(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(launchMessageTranslateY, {
          toValue: -18,
          duration: 420,
          easing: Easing.inOut(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
    ]);
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(launchPulse, {
          toValue: 1,
          duration: 950,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(launchPulse, {
          toValue: 0,
          duration: 950,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );
    const glowFloat = Animated.loop(
      Animated.sequence([
        Animated.timing(launchGlowDrift, {
          toValue: 1,
          duration: 1400,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(launchGlowDrift, {
          toValue: 0,
          duration: 1400,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );
    const pulseStart = setTimeout(() => {
      pulse.start();
      glowFloat.start();
    }, 950);
    intro.start(({ finished }) => {
      if (finished) setEntryScreen("app");
    });
    return () => {
      clearTimeout(pulseStart);
      pulse.stop();
      glowFloat.stop();
    };
  }, [entryScreen, launchGlowDrift, launchMessageOpacity, launchMessageTranslateY, launchOpacity, launchPulse, launchScale, launchTranslateY]);

  useEffect(() => {
    const startHomeBreathing = () => {
      homeHeroGlowLoopRef.current?.stop();
      homeHeroGlowLoopRef.current = Animated.loop(
        Animated.sequence([
          Animated.timing(homeHeroGlowDrift, {
            toValue: 1,
            duration: 6200,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
          Animated.timing(homeHeroGlowDrift, {
            toValue: 0,
            duration: 6200,
            easing: Easing.inOut(Easing.sin),
            useNativeDriver: true,
          }),
        ])
      );
      homeHeroGlowLoopRef.current.start();
    };

    startHomeBreathing();
    const appStateSub = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") startHomeBreathing();
    });

    return () => {
      appStateSub.remove();
      homeHeroGlowLoopRef.current?.stop();
      homeHeroGlowLoopRef.current = null;
    };
  }, [homeHeroGlowDrift]);

  const sourceArray = useMemo(() => Array.from(selectedSources), [selectedSources]);

  const loadProfile = async () => {
    try {
      const localWelcomeDone = (await SecureStore.getItemAsync(WELCOME_FLOW_DONE_KEY)) === "1";
      const me = await apiJson("/api/auth/me");
      if (!me?.authenticated) {
        setCurrentUser(null);
        if (localWelcomeDone) setEntryScreen("app");
        return;
      }
      setCurrentUser(me.user as UserAuth);
      const profileRes = await apiJson("/api/profile");
      const p = profileRes?.profile || {};
      const favorites = Array.isArray(p.favorite_sources) ? p.favorite_sources : [];
      setProfileDraft({
        favorite_sources: favorites,
        audience_filter: p.audience_filter || "all",
        radius: Number(p.radius || 35),
        onboarding_done: !!p.onboarding_done,
        home_lat: p.home_lat ?? null,
        home_lon: p.home_lon ?? null,
        expo_push_token: p.expo_push_token || "",
        notifications: {
          new_event_followed: !!p.notifications?.new_event_followed,
          tonight_after_maghrib: !!p.notifications?.tonight_after_maghrib,
          rsvp_reminders: !!p.notifications?.rsvp_reminders,
        },
      });
      if (favorites.length) setSelectedSources(new Set(favorites));
      if (favorites.length) setFollowedMasjids(favorites);
      if (p.audience_filter) setAudienceFilter(p.audience_filter);
      if (Number.isFinite(Number(p.radius))) setRadius(String(Math.max(5, Math.min(200, Number(p.radius)))));
      if (localWelcomeDone) {
        setEntryScreen("app");
      } else {
        setEntryScreen("welcome");
      }
    } catch {
      setCurrentUser(null);
    }
  };

  const saveOnboarding = async () => {
    try {
      setOnboardingError("");
      const cleanedName = normalizeText(personalization.name);
      const cleanedHeardFrom = normalizeText(personalization.heardFrom);
      if (!cleanedName) {
        setOnboardingError("Please enter your name.");
        return;
      }
      if (!cleanedHeardFrom) {
        setOnboardingError("Please share how you heard about Masjidly.");
        return;
      }
      if (!personalization.gender) {
        setOnboardingError("Please select your gender.");
        return;
      }
      const nextPersonalization: PersonalizationPrefs = {
        ...personalization,
        name: cleanedName,
        heardFrom: cleanedHeardFrom,
        completed: true,
      };
      setPersonalization(nextPersonalization);
      await SecureStore.setItemAsync(PERSONALIZATION_KEY, JSON.stringify(nextPersonalization));
      await SecureStore.setItemAsync(WELCOME_FLOW_DONE_KEY, "1");
      try {
      await apiJson("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...profileDraft,
          onboarding_done: true,
          radius: Number(radius || profileDraft.radius || 35),
          favorite_sources: Array.from(selectedSources),
          audience_filter: audienceFilter,
          expo_push_token: pushToken || profileDraft.expo_push_token || "",
        }),
      });
      } catch {
        // local onboarding completion is sufficient for welcome gating
      }
      finishExitProgress.setValue(0);
      await new Promise<void>((resolve) => {
        Animated.timing(finishExitProgress, {
          toValue: 1,
          duration: 620,
          easing: Easing.inOut(Easing.cubic),
          useNativeDriver: true,
        }).start(() => resolve());
      });
      setEntryScreen("launch");
    } catch (e) {
      setOnboardingError((e as Error).message || "Could not save onboarding.");
    }
  };

  const toggleInterest = (interest: string) => {
    setPersonalization((prev) => {
      const has = prev.interests.includes(interest);
      return {
        ...prev,
        interests: has ? prev.interests.filter((x) => x !== interest) : [...prev.interests, interest],
      };
    });
  };

  const applyThemeMode = async (mode: ThemeMode) => {
    setThemeMode(mode);
    try {
      await SecureStore.setItemAsync(THEME_KEY, mode);
    } catch {
      // non-blocking persistence
    }
  };

  const openExploreWithIntroMotion = () => {
    // Tabs are now kept mounted; just switch instantly (no blocking animation).
    switchTab("explore");
  };

  const registerPush = async () => {
    if (!Device.isDevice) return;
    try {
      const settings = await Notifications.getPermissionsAsync();
      let finalStatus = settings.status;
      if (finalStatus !== "granted") {
        const req = await Notifications.requestPermissionsAsync();
        finalStatus = req.status;
      }
      if (finalStatus !== "granted") return;
      const token = await Notifications.getExpoPushTokenAsync();
      const expoToken = token.data || "";
      if (!expoToken) return;
      setPushToken(expoToken);
      if (currentUser) {
        await apiJson("/api/profile", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...profileDraft,
            onboarding_done: profileDraft.onboarding_done,
            radius: Number(radius || profileDraft.radius || 35),
            favorite_sources: Array.from(selectedSources),
            audience_filter: audienceFilter,
            expo_push_token: expoToken,
          }),
        });
      }
    } catch {
      // ignore local push registration failures
    }
  };

  const openCalendarExportPicker = async (e: EventItem) => {
    const uid = normalizeText(e.event_uid || "");
    const icsUrl = uid ? `${API_BASE_URL}/api/events/${encodeURIComponent(uid)}/ics` : "";
    const webcalUrl = icsUrl.startsWith("http://")
      ? `webcal://${icsUrl.slice("http://".length)}`
      : icsUrl.startsWith("https://")
        ? `webcals://${icsUrl.slice("https://".length)}`
        : "";
    Alert.alert("Export to calendar", "Choose where to add this event.", [
      ...(webcalUrl
        ? [
            {
              text: "Apple Calendar",
              onPress: () => {
                Linking.openURL(webcalUrl);
              },
            } as const,
          ]
        : []),
      {
        text: "Google Calendar",
        onPress: () => {
          Linking.openURL(buildGoogleCalendarUrl(e));
        },
      },
      {
        text: "Outlook",
        onPress: () => {
          Linking.openURL(buildOutlookCalendarUrl(e));
        },
      },
      ...(icsUrl
        ? [
            {
              text: "More apps",
              onPress: () => {
                Share.share({
                  title: `${normalizeText(e.title || "Event")} calendar file`,
                  message: `Add this event to your calendar: ${icsUrl}`,
                  url: icsUrl,
                });
              },
            } as const,
          ]
        : []),
      { text: "Cancel", style: "cancel" },
    ]);
  };

  const remoteDataVersionRef = useRef<string>("");
  const didInitialCacheHydrateRef = useRef(false);

  const loadEvents = async (opts?: { force?: boolean }) => {
    const force = !!opts?.force;
    setError("");
    try {
      const q = new URLSearchParams();
      q.set("start", startDate);
      q.set("end", endDate);
      q.set("ref", reference);
      q.set("radius", radius || "35");
      q.set("q", query);
      q.set("sources", sourceArray.join(","));
      if (profileDraft.home_lat && profileDraft.home_lon) {
        q.set("lat", String(profileDraft.home_lat));
        q.set("lon", String(profileDraft.home_lon));
      }

      // Skip the fetch entirely if the server's pipeline output version hasn't
      // changed since our last successful sync. Events remain stable between
      // pipeline runs so we don't need to hit the network on every tab/render.
      const cachedRaw = await AsyncStorage.getItem(EVENTS_CACHE_KEY);
      const cached: EventsCachePayload | null = cachedRaw ? JSON.parse(cachedRaw) : null;
      if (
        !force &&
        cached &&
        cached.data_version &&
        remoteDataVersionRef.current &&
        cached.data_version === remoteDataVersionRef.current &&
        Array.isArray(cached.events) &&
        cached.events.length
      ) {
        if (!events.length) setEvents(cached.events as EventItem[]);
        setLastSyncedAt(cached.cached_at || Date.now());
        return;
      }

      setLoading(true);
      const payload = await apiJson(`/api/events?${q.toString()}`);
      const fetched = (payload.events || []) as EventItem[];
      setEvents(fetched);
      setLastSyncedAt(Date.now());
      // Persist this snapshot so next launch is instant and offline-tolerant.
      const toCache: EventsCachePayload = {
        events: fetched,
        data_version: remoteDataVersionRef.current || "unknown",
        cached_at: Date.now(),
      };
      AsyncStorage.setItem(EVENTS_CACHE_KEY, JSON.stringify(toCache)).catch(() => {});
    } catch (e) {
      setError((e as Error).message || "Failed to load events");
      // Don't nuke events if we already have a valid cached snapshot onscreen.
      if (!events.length) setEvents([]);
    } finally {
      setLoading(false);
    }
  };

  // On cold start, hydrate events & meta from local cache IMMEDIATELY so the
  // app feels instant — no blank state while the network call is in flight.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [eventsRaw, metaRaw] = await Promise.all([
          AsyncStorage.getItem(EVENTS_CACHE_KEY),
          AsyncStorage.getItem(META_CACHE_KEY),
        ]);
        if (cancelled) return;
        if (metaRaw) {
          try {
            const parsedMeta = JSON.parse(metaRaw) as MetaResponse;
            if (parsedMeta && Array.isArray(parsedMeta.sources)) {
              setMeta((prev) => prev || parsedMeta);
            }
          } catch {
            // ignore malformed cache
          }
        }
        if (eventsRaw) {
          try {
            const parsed = JSON.parse(eventsRaw) as EventsCachePayload;
            if (parsed?.events?.length && !events.length) {
              setEvents(parsed.events);
              setLastSyncedAt(parsed.cached_at || Date.now());
            }
          } catch {
            // ignore malformed cache
          }
        }
      } finally {
        didInitialCacheHydrateRef.current = true;
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (meta) {
      loadEvents();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta]);

  useEffect(() => {
    const handleIncoming = (url: string) => {
      const uid = readEventUidFromUrl(url);
      if (!uid) return;
      setEntryScreen("app");
      switchTab("explore");
      setDeepLinkEventUid(uid);
    };
    const sub = Linking.addEventListener("url", ({ url }) => handleIncoming(url));
    Linking.getInitialURL().then((url) => {
      if (url) handleIncoming(url);
    });
    return () => {
      sub.remove();
    };
  }, []);

  useEffect(() => {
    if (!deepLinkEventUid) return;
    const local = events.find((e) => normalizeText(e.event_uid || "") === deepLinkEventUid);
    if (local) {
      setSelectedEvent(local);
      setDeepLinkEventUid("");
      return;
    }
    const loadDetail = async () => {
      try {
        const detail = await apiJson(`/api/events/${encodeURIComponent(deepLinkEventUid)}`);
        if (detail?.event) setSelectedEvent(detail.event as EventItem);
      } catch {
        // ignore if event not found
      } finally {
        setDeepLinkEventUid("");
      }
    };
    loadDetail();
  }, [deepLinkEventUid, events]);

  const inferAudience = (e: EventItem): "brothers" | "sisters" | "family" | "general" => {
    const blob = `${e.audience || ""} ${e.category || ""} ${e.title || ""} ${e.description || ""}`.toLowerCase();
    if (/\b(sister|sisters|women|womens|hijabista|girls)\b/.test(blob)) return "sisters";
    if (/\b(brother|brothers|men|mens|ikhwan|boys)\b/.test(blob)) return "brothers";
    if (/\b(family|families|parents|kids|children)\b/.test(blob)) return "family";
    return "general";
  };

  const scoreEventForPersonalization = (e: EventItem): number => {
    let score = 0;
    const eventAudience = inferAudience(e);
    if (personalization.preferredAudience !== "all" && eventAudience === personalization.preferredAudience) {
      score += 12;
    } else if (personalization.preferredAudience !== "all" && eventAudience === "family") {
      score += 5;
    }

    const blob = `${e.title || ""} ${e.description || ""} ${e.category || ""}`.toLowerCase();
    for (const interest of personalization.interests) {
      const low = interest.toLowerCase();
      if (low === "halaqas" && /\bhalaq|tafsir|khatira|quran\b/.test(blob)) score += 7;
      if (low === "classes" && /\bclass|course|lesson|workshop\b/.test(blob)) score += 7;
      if (low === "youth" && /\byouth|teen|junior|kids|children\b/.test(blob)) score += 7;
      if (low === "family" && /\bfamily|parent|children|kids\b/.test(blob)) score += 7;
      if (low === "community" && /\bcommunity|social|night|fundraiser|gathering\b/.test(blob)) score += 7;
    }

    const distance = Number(e.distance_miles ?? 999);
    if (Number.isFinite(distance)) {
      if (distance <= 5) score += 12;
      else if (distance <= 12) score += 8;
      else if (distance <= 25) score += 4;
    }

    const now = new Date();
    const when = new Date(`${e.date || ""}T${e.start_time || "23:59"}`);
    if (Number.isFinite(when.getTime())) {
      const deltaDays = (when.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
      if (deltaDays >= 0 && deltaDays <= 2) score += 8;
      else if (deltaDays > 2 && deltaDays <= 7) score += 5;
      else if (deltaDays > 7) score += 2;
    }

    if (savedEventsMap[eventStorageKey(e)]) score += 10;
    if (followedMasjids.includes(e.source)) score += 9;
    const rsvp = rsvpStatuses[eventStorageKey(e)];
    if (rsvp === "going") score += 10;
    if (rsvp === "interested") score += 6;
    return score;
  };

  const getEventConfidence = (e: EventItem): { score: number; label: string } => {
    let confidence = 35;
    if (normalizeText(e.start_time)) confidence += 20;
    if (normalizeText(e.end_time)) confidence += 8;
    if (normalizeText(e.source_url)) confidence += 10;
    if (pickPoster(e.image_urls)) confidence += 8;
    if (normalizeText(e.description).length > 45) confidence += 8;
    if (normalizeText(e.event_uid || "")) confidence += 6;

    const similar = events.filter(
      (x) =>
        normalizeText(x.source).toLowerCase() === normalizeText(e.source).toLowerCase() &&
        normalizeText(x.title).toLowerCase() === normalizeText(e.title).toLowerCase() &&
        normalizeText(x.date) === normalizeText(e.date)
    ).length;
    if (similar > 1) confidence += 5;
    const score = Math.max(1, Math.min(100, confidence));
    const label = score >= 80 ? "High confidence" : score >= 60 ? "Medium confidence" : "Low confidence";
    return { score, label };
  };

  const recurringProgramLabel = (e: EventItem): string => {
    const titleNorm = normalizeText(e.title).toLowerCase();
    if (!titleNorm) return "";
    const matches = events.filter((row) => {
      if (normalizeText(row.title).toLowerCase() !== titleNorm) return false;
      if (normalizeText(row.source).toLowerCase() !== normalizeText(e.source).toLowerCase()) return false;
      const d = new Date(`${row.date}T00:00:00`);
      const target = new Date(`${e.date}T00:00:00`);
      if (!Number.isFinite(d.getTime()) || !Number.isFinite(target.getTime())) return false;
      return d.getDay() === target.getDay();
    });
    return matches.length >= 3 ? "Repeats weekly" : "";
  };

  const isLikelyStaleEvent = (e: EventItem): boolean => {
    const d = new Date(`${e.date}T00:00:00`);
    if (!Number.isFinite(d.getTime())) return true;
    const ageDays = (Date.now() - d.getTime()) / (1000 * 60 * 60 * 24);
    return ageDays > 30;
  };

  const transparencyLabel = (e: EventItem): string => {
    const mins = Math.max(1, Math.round((Date.now() - lastSyncedAt) / 60000));
    return `Last checked ${mins} mins ago • Synced from ${formatSourceLabel(e.source)}`;
  };

  const audienceChipStyle = (id: string, active: boolean) => {
    if (!active) return styles.sourceChip;
    if (id === "sisters") return [styles.sourceChip, styles.sistersChipActive];
    if (id === "brothers") return [styles.sourceChip, styles.brothersChipActive];
    if (id === "family") return [styles.sourceChip, styles.familyChipActive];
    return [styles.sourceChip, styles.generalChipActive];
  };

  const audienceChipTextStyle = (id: string, active: boolean) => {
    if (!active) return styles.sourceChipText;
    if (id === "sisters") return [styles.sourceChipText, styles.sistersChipTextActive];
    if (id === "brothers") return [styles.sourceChipText, styles.brothersChipTextActive];
    if (id === "family") return [styles.sourceChipText, styles.familyChipTextActive];
    return [styles.sourceChipText, styles.generalChipTextActive];
  };

  const buildEventExplanation = (e: EventItem): string => {
    const aud = inferAudience(e);
    const audienceText =
      aud === "sisters"
        ? "for sisters/girls"
        : aud === "brothers"
        ? "for brothers/boys"
        : aud === "family"
        ? "for families"
        : "for the community";

    const blob = `${e.title || ""} ${e.description || ""} ${e.raw_text || ""} ${e.poster_ocr_text || ""}`.toLowerCase();
    let eventType = "community event";
    if (/halaq|halaka/.test(blob)) eventType = "halaqa";
    else if (/workshop/.test(blob)) eventType = "workshop";
    else if (/class|course|lesson/.test(blob)) eventType = "class";
    else if (/lecture|talk|seminar|khutbah/.test(blob)) eventType = "lecture";
    else if (/fundraiser|charity/.test(blob)) eventType = "fundraiser";
    else if (/iftar|ramadan/.test(blob)) eventType = "Ramadan program";
    else if (/eid/.test(blob)) eventType = "Eid program";
    else if (/youth|junior|teens?/.test(blob)) eventType = "youth program";

    const when = `${formatHumanDate(e.date)}${eventTime(e) !== "Time TBD" ? ` at ${eventTime(e)}` : ""}`;
    const where = [e.location_name, e.address].filter(Boolean).join(" - ") || "the masjid";
    const base = `${e.title} is a ${eventType} ${audienceText}. It is scheduled for ${when} at ${where}.`;

    const detailSource = !isBoilerplateDescription(e.poster_ocr_text || "")
      ? normalizeText(e.poster_ocr_text || "")
      : !isBoilerplateDescription(e.description || "")
      ? normalizeText(e.description || "")
      : normalizeText(e.raw_text || "");
    const detail = detailSource
      .replace(/https?:\/\/\S+/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();

    if (detail && detail.length > 20) {
      const clipped = detail.length > 220 ? `${detail.slice(0, 217)}...` : detail;
      return `${base} Based on the event text: ${clipped}`;
    }
    return base;
  };

  const matchesQuickFilter = (e: EventItem, filter: QuickFilterId): boolean => {
    const blob = `${e.title || ""} ${e.description || ""} ${e.category || ""} ${e.audience || ""}`.toLowerCase();
    if (filter === "women") return /\bwomen|sisters|girls?\b/.test(blob);
    if (filter === "youth") return /\byouth|teen|junior|kids?|children|students?\b/.test(blob);
    if (filter === "family") return /\bfamily|families|parents?|children|kids?\b/.test(blob);
    if (filter === "after_maghrib") return /\bmaghrib\b/.test(blob) || /\b(6|7|8):\d{2}\s?(pm)?\b/.test(blob);
    if (filter === "free") return /\bfree\b/.test(blob) && !/\$\d+|ticket|paid|fee/.test(blob);
    if (filter === "registration_required") return /\bregister|registration|ticket|rsvp\b/.test(blob);
    return true;
  };

  const visibleEvents = useMemo(() => {
    return events.filter((e) => {
      if (audienceFilter !== "all" && inferAudience(e) !== audienceFilter) return false;
      if (quickFilters.length && !quickFilters.every((f) => matchesQuickFilter(e, f))) return false;
      return true;
    });
  }, [events, audienceFilter, quickFilters]);

  const orderedVisibleEvents = useMemo(() => {
    return [...visibleEvents].sort((a, b) => {
      if (sortMode === "nearest") {
        const distA = Number(a.distance_miles ?? 9999);
        const distB = Number(b.distance_miles ?? 9999);
        if (distA !== distB) return distA - distB;
      } else if (sortMode === "recent") {
        const createdA = Number(new Date(`${a.date || "1970-01-01"}T${a.start_time || "00:00"}`).getTime());
        const createdB = Number(new Date(`${b.date || "1970-01-01"}T${b.start_time || "00:00"}`).getTime());
        if (createdA !== createdB) return createdB - createdA;
      } else if (sortMode === "relevant") {
      const scoreDelta = scoreEventForPersonalization(b) - scoreEventForPersonalization(a);
      if (scoreDelta !== 0) return scoreDelta;
      }
      return `${a.date || "9999-12-31"} ${a.start_time || "99:99"}`.localeCompare(
        `${b.date || "9999-12-31"} ${b.start_time || "99:99"}`
    );
    });
  }, [personalization.interests, personalization.preferredAudience, rsvpStatuses, followedMasjids, savedEventsMap, sortMode, visibleEvents]);

  const grouped = useMemo(() => {
    const map = new Map<string, EventItem[]>();
    for (const e of orderedVisibleEvents) {
      if (!map.has(e.date)) map.set(e.date, []);
      map.get(e.date)!.push(e);
    }
    return map;
  }, [orderedVisibleEvents]);

  const exploreSections = useMemo(
    () =>
      Array.from(grouped.entries())
        .map(([day, rows]) => ({
          title: day,
          data: halaqaFilter
            ? rows.filter((r) => (r.topics || []).includes(halaqaFilter))
            : rows,
        }))
        .filter((s) => s.data.length > 0),
    [grouped, halaqaFilter]
  );

  const savedEvents = useMemo(
    () =>
      Object.values(savedEventsMap).sort((a, b) =>
        `${a.date || "9999-12-31"} ${a.start_time || "99:99"}`.localeCompare(
          `${b.date || "9999-12-31"} ${b.start_time || "99:99"}`
        )
      ),
    [savedEventsMap]
  );

  const upcoming = useMemo(() => {
    const today = todayIso();
    return events
      .filter((e) => (e.date || "") >= today)
      .sort((a, b) => {
        const scoreDelta = scoreEventForPersonalization(b) - scoreEventForPersonalization(a);
        if (scoreDelta !== 0) return scoreDelta;
        return `${a.date || ""} ${a.start_time || ""}`.localeCompare(
          `${b.date || ""} ${b.start_time || ""}`
        );
      })
      .slice(0, 16);
  }, [events, personalization.interests, personalization.preferredAudience, rsvpStatuses, followedMasjids, savedEventsMap]);

  /** All upcoming visible events (same filters as Explore), for Calendar month grid + export list — not the home-card `upcoming` slice. */
  const calendarScheduleEvents = useMemo(() => {
    const today = todayIso();
    return orderedVisibleEvents
      .filter((e) => normalizeText(e.date) && (e.date || "") >= today)
      .sort((a, b) =>
        `${a.date || ""} ${a.start_time || "99:99"}`.localeCompare(`${b.date || ""} ${b.start_time || "99:99"}`)
      );
  }, [orderedVisibleEvents]);

  const futureVisibleCount = useMemo(() => {
    const today = todayIso();
    return visibleEvents.filter((e) => (e.date || "") >= today).length;
  }, [visibleEvents]);
  const featuredEvent = useMemo(() => {
    if (!upcoming.length) return null;
    const brothersUpcoming = upcoming.filter((e) => inferAudience(e) === "brothers");
    const pool = brothersUpcoming.length ? brothersUpcoming : upcoming;
    const strong = upcoming.find((e) => {
      const p = pickPoster(e.image_urls);
      return !!p && !isWeakPosterUrl(p) && ((e.description || "").length > 40 || (e.raw_text || "").length > 80);
    });
    if (strong && pool.includes(strong)) return strong;
    return pool.find((e) => pickPoster(e.image_urls) && !isWeakPosterUrl(pickPoster(e.image_urls))) || pool.find((e) => pickPoster(e.image_urls)) || pool[0];
  }, [upcoming]);

  const calendarModalEvents = useMemo(
    () => orderedVisibleEvents.filter((e) => normalizeText(e.date) === normalizeText(selectedCalendarModalDate)),
    [orderedVisibleEvents, selectedCalendarModalDate]
  );

  const masjidProfileEvents = useMemo(
    () => orderedVisibleEvents.filter((e) => normalizeText(e.source).toLowerCase() === normalizeText(selectedMasjidProfile).toLowerCase()),
    [orderedVisibleEvents, selectedMasjidProfile]
  );

  /** One map pin per NJ masjid (fixed coords); count = events after Explore filters. */
  const masjidPinsForExplore = useMemo(() => {
    const rawSources =
      meta?.sources && meta.sources.length > 0 ? meta.sources : Object.keys(MASJID_COORDS);
    const keys = Array.from(
      new Set(rawSources.map((s) => normalizeText(s).toLowerCase()).filter(Boolean))
    );
    const pins: Array<{ sourceKey: string; latitude: number; longitude: number; count: number }> = [];
    for (const sourceKey of keys) {
      const coord = MASJID_COORDS[sourceKey];
      if (!coord) continue;
      const count = orderedVisibleEvents.filter(
        (ev) => normalizeText(ev.source).toLowerCase() === sourceKey
      ).length;
      pins.push({ sourceKey, latitude: coord.latitude, longitude: coord.longitude, count });
    }
    return pins;
  }, [meta?.sources, orderedVisibleEvents]);

  useEffect(() => {
    if (exploreMode !== "map" || !masjidPinsForExplore.length) return;
    const withEvents = masjidPinsForExplore.filter((p) => p.count > 0);
    const pool = withEvents.length ? withEvents : masjidPinsForExplore;
    const latitude = pool.reduce((sum, p) => sum + p.latitude, 0) / pool.length;
    const longitude = pool.reduce((sum, p) => sum + p.longitude, 0) / pool.length;
    setMapRegion((prev) => ({ ...prev, latitude, longitude }));
  }, [exploreMode, masjidPinsForExplore]);

  const toggleSource = (src: string) => {
    setSelectedSources((prev) => {
      const next = new Set(prev);
      if (next.has(src)) next.delete(src);
      else next.add(src);
      return next;
    });
  };

  const isSavedEvent = (e: EventItem): boolean => {
    return !!savedEventsMap[eventStorageKey(e)];
  };

  const toggleSavedEvent = async (e: EventItem) => {
    const key = eventStorageKey(e);
    const next = { ...savedEventsMap };
    if (next[key]) delete next[key];
    else next[key] = e;
    setSavedEventsMap(next);
    try {
      await SecureStore.setItemAsync(SAVED_EVENTS_KEY, JSON.stringify(next));
    } catch {
      // non-blocking local cache write
    }
  };

  const clearSavedEvents = async () => {
    setSavedEventsMap({});
    try {
      await SecureStore.deleteItemAsync(SAVED_EVENTS_KEY);
    } catch {
      // ignore cache clear failures
    }
  };

  const toggleFollowMasjid = async (source: string) => {
    const src = normalizeText(source);
    if (!src) return;
    const next = followedMasjids.includes(src) ? followedMasjids.filter((s) => s !== src) : [...followedMasjids, src];
    setFollowedMasjids(next);
    try {
      await SecureStore.setItemAsync(FOLLOWED_MASJIDS_KEY, JSON.stringify(next));
    } catch {
      // non-blocking follow cache write
    }
    if (currentUser) {
      try {
        await apiJson("/api/profile", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...profileDraft,
            onboarding_done: profileDraft.onboarding_done,
            radius: Number(radius || profileDraft.radius || 35),
            favorite_sources: next,
            audience_filter: audienceFilter,
            expo_push_token: pushToken,
          }),
        });
      } catch {
        // local follow can continue even if profile sync fails
      }
    }
  };

  const setRsvpStatus = async (e: EventItem, status: RsvpStatus) => {
    const key = eventStorageKey(e);
    const next = { ...rsvpStatuses, [key]: status };
    setRsvpStatuses(next);
    try {
      await SecureStore.setItemAsync(RSVP_STATUSES_KEY, JSON.stringify(next));
    } catch {
      // ignore local rsvp write failure
    }
  };

  const toggleRsvp = async (e: EventItem, status: RsvpStatus) => {
    const key = eventStorageKey(e);
    const current = rsvpStatuses[key];
    const next = { ...rsvpStatuses };
    if (current === status) {
      delete next[key];
    } else {
      next[key] = status;
    }
    setRsvpStatuses(next);
    try {
      await SecureStore.setItemAsync(RSVP_STATUSES_KEY, JSON.stringify(next));
    } catch {
      // ignore local rsvp write failure
    }
  };

  const shareEvent = (e: EventItem) => {
    const when = `${formatHumanDate(e.date)} · ${eventTime(e)}`;
    const link = e.deep_link?.web || e.source_url || "";
    const masjid = formatSourceLabel(e.source);
    const msg = link
      ? `${e.title} at ${masjid}\n${when}\n${link}`
      : `${e.title} at ${masjid}\n${when}`;
    Share.share({ title: e.title, message: msg, ...(link ? { url: link } : {}) });
  };

  // #12 Bring-a-friend invite — pre-filled invite with poster + deep link + "save my seat" CTA
  const inviteFriendsToEvent = (e: EventItem) => {
    const when = `${formatHumanDate(e.date)} · ${eventTime(e)}`;
    const masjid = formatSourceLabel(e.source);
    const link = e.deep_link?.web || `https://masjidly.app/event/${e.event_uid || ""}`;
    const poster = pickPoster(e.image_urls || []);
    const speakerLine = normalizeText(e.speaker || "") ? `Speaker: ${e.speaker}\n` : "";
    const body = [
      `Assalamu alaikum! Thinking of you for this:`,
      ``,
      `${e.title}`,
      `${masjid} · ${when}`,
      speakerLine,
      `Save your seat: ${link}`,
      poster ? `(poster: ${poster})` : "",
      ``,
      `— via Masjidly`,
    ]
      .filter(Boolean)
      .join("\n");
    Share.share({ title: `Come with me: ${e.title}`, message: body, ...(link ? { url: link } : {}) });
  };

  // #21 Reflection prompt
  const openReflectionPrompt = (ev: EventItem) => {
    setReflectionState({ event: ev, rating: 5, text: "" });
  };
  const submitReflection = async () => {
    if (!reflectionState?.event?.event_uid) {
      setReflectionState(null);
      return;
    }
    try {
      await apiJson(`/api/events/${reflectionState.event.event_uid}/reflection`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rating: reflectionState.rating,
          text: reflectionState.text,
          visibility: "public",
        }),
      });
      Alert.alert("Thanks", "Your reflection is live on the masjid's page.");
    } catch {
      Alert.alert("Reflection", "Couldn't save your reflection. Try later.");
    } finally {
      setReflectionState(null);
    }
  };

  // #40 Corrections voting
  const voteCorrection = async (ev: EventItem, weight: 1 | -1) => {
    if (!ev.event_uid) return;
    try {
      await apiJson(`/api/events/${ev.event_uid}/correction-vote`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ weight }),
      });
      Alert.alert(weight > 0 ? "Thanks" : "Noted", weight > 0 ? "You verified this event." : "We've logged your correction.");
    } catch {
      Alert.alert("Vote", "Couldn't record your vote.");
    }
  };

  // #13 Series
  const loadEventSeries = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/series`);
      if (!res.ok) return;
      const d = await res.json();
      setEventSeries(d.series || []);
    } catch {
      // ignore
    }
  }, []);

  // #24 Speakers
  const loadSpeakers = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/speakers`);
      if (!res.ok) return;
      const d = await res.json();
      setSpeakers(d.speakers || []);
    } catch {
      // ignore
    }
  }, []);

  // #2 Iqama
  const loadIqamaFor = useCallback(async (source: string) => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/iqama/${encodeURIComponent(source)}`);
      if (!res.ok) return;
      const d = await res.json();
      setIqamaBySource((prev) => ({ ...prev, [source]: d.iqama || {} }));
    } catch {
      // ignore
    }
  }, []);

  // #31 Passport
  const loadPassport = useCallback(async () => {
    if (!currentUser) {
      setPassportStamps([]);
      return;
    }
    try {
      const d = await apiJson("/api/passport/me");
      setPassportStamps(d.stamps || []);
    } catch {
      // ignore
    }
  }, [currentUser]);

  const stampPassport = async (source: string) => {
    if (!currentUser) {
      Alert.alert("Passport", "Sign in first to collect masjid stamps.");
      return;
    }
    try {
      const d = await apiJson("/api/passport/stamp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
      });
      if (d && d.ok) {
        setPassportStamps(d.stamps || []);
        Alert.alert("Stamped", `${formatSourceLabel(source)} added to your passport. (${d.total}/24)`);
      } else {
        Alert.alert("Passport", "Couldn't stamp this masjid.");
      }
    } catch {
      Alert.alert("Passport", "Network issue. Try again shortly.");
    }
  };

  useEffect(() => {
    loadEventSeries();
    loadSpeakers();
  }, [loadEventSeries, loadSpeakers]);

  useEffect(() => {
    loadPassport();
  }, [loadPassport]);

  useEffect(() => {
    if (selectedMasjidSheet) {
      loadIqamaFor(selectedMasjidSheet);
    }
  }, [selectedMasjidSheet, loadIqamaFor]);

  useEffect(() => {
    if (selectedMasjidProfile) {
      loadIqamaFor(selectedMasjidProfile);
    }
  }, [selectedMasjidProfile, loadIqamaFor]);

  // #17 Bulk ICS: download all upcoming events from user's followed masjids
  const exportBulkCalendar = async () => {
    try {
      const srcs = followedMasjids.length ? followedMasjids.join(",") : "";
      const start = todayIso();
      const until = plusDaysIso(30);
      const url = `${API_BASE_URL}/api/events/bulk.ics?start=${start}&until=${until}${srcs ? `&sources=${encodeURIComponent(srcs)}` : ""}`;
      const canOpen = await Linking.canOpenURL(url);
      if (canOpen) {
        await Linking.openURL(url);
      } else {
        Alert.alert("Calendar", "Could not open the calendar file. Try again in a moment.");
      }
    } catch (err) {
      console.warn("bulk ics", err);
      Alert.alert("Calendar", "Couldn't export your calendar right now.");
    }
  };

  const submitFeedback = async (e: EventItem, value: "helpful" | "off" | "attended") => {
    const key = eventStorageKey(e);
    const next = { ...feedbackResponses, [key]: value };
    setFeedbackResponses(next);
    try {
      await SecureStore.setItemAsync(FEEDBACK_RESPONSES_KEY, JSON.stringify(next));
    } catch {
      // ignore feedback cache error
    }
    if (value === "attended") {
      const month = todayIso().slice(0, 7);
      const nextCount = streakMonth === month ? streakCount + 1 : 1;
      setStreakMonth(month);
      setStreakCount(nextCount);
      try {
        await SecureStore.setItemAsync(STREAK_TRACKER_KEY, JSON.stringify({ month, count: nextCount }));
      } catch {
        // ignore streak cache error
      }
    }
  };

  const applyPreset = (preset: SavedFilterPreset) => {
    setAudienceFilter(preset.audienceFilter);
    setQuickFilters(preset.quickFilters);
    setSortMode(preset.sortMode);
  };

  const beginEditPreset = (preset: SavedFilterPreset) => {
    applyPreset(preset);
    setPresetDraftLabel(preset.label);
    setEditingPresetId(preset.id);
  };

  const saveCurrentPreset = () => {
    const label = normalizeText(presetDraftLabel);
    if (!label) {
      Alert.alert("Preset name needed", "Enter a preset name to save this filter set.");
      return;
    }
    const nextPreset: SavedFilterPreset = {
      id: editingPresetId || `preset-${Date.now()}`,
      label,
      audienceFilter,
      quickFilters,
      sortMode,
    };
    setSavedFilterPresets((prev) => {
      if (editingPresetId) return prev.map((item) => (item.id === editingPresetId ? nextPreset : item));
      return [...prev, nextPreset];
    });
    setPresetDraftLabel("");
    setEditingPresetId("");
  };

  const deletePreset = (presetId: string) => {
    setSavedFilterPresets((prev) => prev.filter((item) => item.id !== presetId));
    if (editingPresetId === presetId) {
      setEditingPresetId("");
      setPresetDraftLabel("");
    }
  };

  const submitCommunityCorrection = async () => {
    if (!selectedEvent?.event_uid) return;
    try {
      await apiJson("/api/moderation/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_uid: selectedEvent.event_uid,
          issue_type: reportIssueType,
          details: reportDetails,
        }),
      });
      setReportDetails("");
      setShowReportSection(false);
      Alert.alert("Thanks", "Your correction report was sent to moderation.");
    } catch (err) {
      Alert.alert("Could not submit", (err as Error).message || "Try again shortly.");
    }
  };

  useEffect(() => {
    if (!selectedEvent) {
      setShowReportSection(false);
      setShowFullDescription(false);
      setReportDetails("");
    }
  }, [selectedEvent]);

  const loadModerationQueue = async () => {
    try {
      const payload = await apiJson("/api/moderation/reports");
      setModerationReports(Array.isArray(payload?.reports) ? payload.reports : []);
      setShowModerationQueue(true);
    } catch (err) {
      Alert.alert("Admin access needed", (err as Error).message || "Only admins can open moderation queue.");
    }
  };

  const updateModerationReportStatus = async (reportId: number, status: "open" | "in_review" | "resolved" | "dismissed") => {
    try {
      await apiJson(`/api/moderation/reports/${reportId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      await loadModerationQueue();
    } catch (err) {
      Alert.alert("Update failed", (err as Error).message || "Could not update moderation status.");
    }
  };

  const tutorialSteps = [
    "Use Home to see a quick summary and a featured event.",
    "Tap Explore to filter by date, masjid, audience, and search text.",
    "Tap any event poster/card to open full details and full flyer.",
    "Use Quick Picks for Brothers, Sisters, or Family events.",
  ];

  const goToWelcomeSlide = (nextSlide: number) => {
    const clamped = Math.max(0, Math.min(2, nextSlide));
    setWelcomeSlideIndex(clamped);
    welcomeSlidesRef.current?.scrollTo({ x: clamped * screenWidth, y: 0, animated: true });
  };

  const renderWelcomeScreen = () => {
    const pagerWidth = Math.max(screenWidth, 1);
    const welcomeLogoSize = Math.min(380, Math.round(Math.max(200, pagerWidth - 32)));
    const welcomeLogoMarginBottom = -Math.round(welcomeLogoSize * 0.21);
    const cardFlipRotate = (index: number) =>
      welcomeScrollX.interpolate({
        inputRange: [(index - 1) * pagerWidth, index * pagerWidth, (index + 1) * pagerWidth],
        outputRange: ["68deg", "0deg", "-68deg"],
        extrapolate: "clamp",
      });
    const cardFlipTranslateX = (index: number) =>
      welcomeScrollX.interpolate({
        inputRange: [(index - 1) * pagerWidth, index * pagerWidth, (index + 1) * pagerWidth],
        outputRange: [58, 0, -58],
        extrapolate: "clamp",
      });
    const cardFlipScale = (index: number) =>
      welcomeScrollX.interpolate({
        inputRange: [(index - 1) * pagerWidth, index * pagerWidth, (index + 1) * pagerWidth],
        outputRange: [0.88, 1, 0.88],
        extrapolate: "clamp",
      });
    const cardFlipOpacity = (index: number) =>
      welcomeScrollX.interpolate({
        inputRange: [(index - 1) * pagerWidth, index * pagerWidth, (index + 1) * pagerWidth],
        outputRange: [0.58, 1, 0.58],
        extrapolate: "clamp",
      });
    const finishExitOpacity = finishExitProgress.interpolate({
      inputRange: [0, 1],
      outputRange: [1, 0],
    });
    const finishExitTranslateY = finishExitProgress.interpolate({
      inputRange: [0, 1],
      outputRange: [0, 110],
    });
    const finishExitTranslateX = finishExitProgress.interpolate({
      inputRange: [0, 1],
      outputRange: [0, 36],
    });
    const finishExitRotate = finishExitProgress.interpolate({
      inputRange: [0, 1],
      outputRange: ["0deg", "10deg"],
    });
    const finishExitScale = finishExitProgress.interpolate({
      inputRange: [0, 1],
      outputRange: [1, 0.94],
    });
    return (
    <SafeAreaView style={[styles.welcomeContainer, isMidnight && styles.containerMidnight, isNeo && styles.containerNeo, isVitaria && styles.containerVitaria, isInferno && styles.containerInferno, isEmerald && styles.containerEmerald]}>
        <View style={styles.welcomePagerWrap}>
          <Animated.ScrollView
            ref={welcomeSlidesRef}
            horizontal
            pagingEnabled
            bounces={false}
            showsHorizontalScrollIndicator={false}
            scrollEventThrottle={16}
            onScroll={Animated.event(
              [{ nativeEvent: { contentOffset: { x: welcomeScrollX } } }],
              { useNativeDriver: true }
            )}
            onMomentumScrollEnd={(event) => {
              const x = event.nativeEvent.contentOffset.x;
              const next = Math.round(x / pagerWidth);
              setWelcomeSlideIndex(Math.max(0, Math.min(2, next)));
            }}
          >
            <View style={[styles.welcomeSlide, { width: pagerWidth }]}>
              <Pressable onPress={() => goToWelcomeSlide(1)} style={styles.welcomeSlideTapZone}>
        <Animated.View
          style={[
            styles.welcomeHeroCard,
            isMinera && styles.welcomeHeroCardMinera,
            isEmerald && styles.welcomeHeroCardEmerald,
            isMidnight && styles.welcomeHeroCardMidnight,
            isNeo && styles.welcomeHeroCardNeo,
            isVitaria && styles.welcomeHeroCardVitaria,
            isInferno && styles.welcomeHeroCardInferno,
                    styles.welcomeHeroOnlyCard,
                    {
                      opacity: Animated.multiply(heroOpacity, cardFlipOpacity(0)),
                      transform: [
                        { perspective: 1100 },
                        { translateY: heroTranslate },
                        { translateX: cardFlipTranslateX(0) },
                        { rotateY: cardFlipRotate(0) },
                        { scale: cardFlipScale(0) },
                      ],
                    },
                  ]}
                >
                  <Animated.View
                    style={[
                      styles.heroGlowOne,
                      isMinera && styles.heroGlowOneMinera,
                      isEmerald && styles.heroGlowOneEmerald,
                      isMidnight && styles.heroGlowOneMidnight,
                      isNeo && styles.heroGlowOneNeo,
                      isVitaria && styles.heroGlowOneVitaria,
                      isInferno && styles.heroGlowOneInferno,
                      {
                        transform: [
                          {
                            translateY: bubbleDrift.interpolate({
                              inputRange: [0, 1],
                              outputRange: [0, -16],
                            }),
                          },
                          {
                            translateX: bubbleDrift.interpolate({
                              inputRange: [0, 1],
                              outputRange: [0, -7],
                            }),
                          },
                        ],
                      },
                    ]}
                  />
                  <Animated.View
                    style={[
                      styles.heroGlowTwo,
                      isMinera && styles.heroGlowTwoMinera,
                      isEmerald && styles.heroGlowTwoEmerald,
                      isMidnight && styles.heroGlowTwoMidnight,
                      isNeo && styles.heroGlowTwoNeo,
                      isVitaria && styles.heroGlowTwoVitaria,
                      isInferno && styles.heroGlowTwoInferno,
                      {
                        transform: [
                          {
                            translateY: bubbleDrift.interpolate({
                              inputRange: [0, 1],
                              outputRange: [0, 12],
                            }),
                          },
                          {
                            translateX: bubbleDrift.interpolate({
                              inputRange: [0, 1],
                              outputRange: [0, 6],
                            }),
                          },
                        ],
                      },
                    ]}
                  />
                  <Animated.View
                    style={[
                      styles.welcomeChatToast,
                      isDarkTheme && styles.welcomeChatToastDark,
                      {
                        opacity: welcomeToastOpacity,
                        transform: [{ translateY: welcomeToastTranslateY }],
                      },
                    ]}
                  >
                    <Text style={[styles.welcomeChatToastText, isDarkTheme && styles.welcomeChatToastTextDark]}>{welcomeTypedText}</Text>
                  </Animated.View>
                  <View
                    style={[
                      styles.welcomeLogoWrap,
                      { width: welcomeLogoSize, height: welcomeLogoSize, marginBottom: welcomeLogoMarginBottom },
                    ]}
                  >
                    <Image source={WELCOME_LOGO} style={styles.welcomeLogoBase} resizeMode="contain" />
                  </View>
                  <Text style={[styles.welcomeBetaBadge, isNeo && styles.welcomeBetaBadgeNeo, isEmerald && styles.welcomeBetaBadgeEmerald]}>BETA</Text>
          <Text style={[styles.welcomeTitle, isMinera && styles.welcomeTitleMinera, isEmerald && styles.welcomeTitleEmerald, isNeo && styles.welcomeTitleNeo]}>Local masjid events, beautifully organized</Text>
          <Text style={[styles.welcomeSub, isMinera && styles.welcomeSubMinera, isEmerald && styles.welcomeSubEmerald, isNeo && styles.welcomeSubNeo]}>
            Discover upcoming programs, classes, and community nights from nearby masjids in one place.
          </Text>
          <View style={styles.heroTrustRow}>
            <Text style={[styles.heroTrustPill, isMinera && styles.heroTrustPillMinera, isEmerald && styles.heroTrustPillEmerald, isNeo && styles.heroTrustPillNeo]}>Trusted local sources</Text>
            <Text style={[styles.heroTrustPill, isMinera && styles.heroTrustPillMinera, isEmerald && styles.heroTrustPillEmerald, isNeo && styles.heroTrustPillNeo]}>Fast discovery</Text>
                    <Text style={[styles.heroTrustPill, isMinera && styles.heroTrustPillMinera, isEmerald && styles.heroTrustPillEmerald, isNeo && styles.heroTrustPillNeo]}>5+ masjids</Text>
        </View>
                  <Text style={[styles.welcomeSwipeHint, isDarkTheme && styles.welcomeSwipeHintDark]}>Tap anywhere to continue, or swipe left.</Text>
        </Animated.View>
              </Pressable>
            </View>

            <View style={[styles.welcomeSlide, { width: pagerWidth }]}>
        <Animated.View
          style={[
                  styles.welcomeHeroCard,
                  isMinera && styles.welcomeHeroCardMinera,
                  isEmerald && styles.welcomeHeroCardEmerald,
                  isMidnight && styles.welcomeHeroCardMidnight,
                  isNeo && styles.welcomeHeroCardNeo,
                  isVitaria && styles.welcomeHeroCardVitaria,
                  isInferno && styles.welcomeHeroCardInferno,
                  styles.welcomeInfoCard,
                  styles.welcomeSlideCard,
                  {
                    opacity: Animated.multiply(stepsOpacity, cardFlipOpacity(1)),
                    transform: [
                      { perspective: 1100 },
                      { translateY: stepsTranslate },
                      { translateX: cardFlipTranslateX(1) },
                      { rotateY: cardFlipRotate(1) },
                      { scale: cardFlipScale(1) },
                    ],
                  },
                ]}
              >
                <Animated.View
                  style={[
                    styles.heroGlowOne,
                    styles.welcomeInfoGlowOne,
                    isMinera && styles.heroGlowOneMinera,
                    isEmerald && styles.heroGlowOneEmerald,
                    isMidnight && styles.heroGlowOneMidnight,
                    isNeo && styles.heroGlowOneNeo,
                    isVitaria && styles.heroGlowOneVitaria,
                    isInferno && styles.heroGlowOneInferno,
                    {
                      transform: [
                        {
                          translateY: bubbleDrift.interpolate({
                            inputRange: [0, 1],
                            outputRange: [0, -14],
                          }),
                        },
                        {
                          translateX: bubbleDrift.interpolate({
                            inputRange: [0, 1],
                            outputRange: [0, 9],
                          }),
                        },
                      ],
                    },
                  ]}
                />
                <Animated.View
                  style={[
                    styles.heroGlowTwo,
                    styles.welcomeInfoGlowTwo,
                    isMinera && styles.heroGlowTwoMinera,
                    isEmerald && styles.heroGlowTwoEmerald,
                    isMidnight && styles.heroGlowTwoMidnight,
                    isNeo && styles.heroGlowTwoNeo,
                    isVitaria && styles.heroGlowTwoVitaria,
                    isInferno && styles.heroGlowTwoInferno,
                    {
                      transform: [
                        {
                          translateY: bubbleDrift.interpolate({
                            inputRange: [0, 1],
                            outputRange: [0, 12],
                          }),
                        },
                        {
                          translateX: bubbleDrift.interpolate({
                            inputRange: [0, 1],
                            outputRange: [0, -8],
                          }),
                        },
                      ],
                    },
                  ]}
                />
                <Text style={[styles.welcomeInfoEyebrow, isNeo && styles.welcomeInfoEyebrowNeo, isEmerald && styles.welcomeInfoEyebrowEmerald]}>DISCOVER FASTER</Text>
                <Text style={[styles.tutorialTitle, styles.welcomeInfoTitle, styles.welcomeInfoTitleCentered, isNeo && styles.welcomeInfoTitleNeo, isEmerald && styles.welcomeInfoTitleEmerald]}>
            How Masjidly works
          </Text>
                <Text style={[styles.welcomeInfoLead, isNeo && styles.welcomeInfoLeadNeo, isEmerald && styles.welcomeInfoLeadEmerald]}>
                  Find local masjid programs in seconds without juggling flyers, posts, and group chats.
                </Text>

                <Animated.View style={[styles.welcomeFeatureStack, { opacity: footerOpacity, transform: [{ translateY: footerTranslate }] }]}>
                  {tutorialSteps.slice(0, 3).map((step, idx) => (
                    <View
                      key={`feature-${idx}`}
          style={[
                        styles.welcomeFeatureRow,
                        isNeo && styles.welcomeFeatureRowNeo,
                        isEmerald && styles.welcomeFeatureRowEmerald,
                      ]}
                    >
                      <View style={[styles.welcomeFeatureBadge, isNeo && styles.welcomeFeatureBadgeNeo, isEmerald && styles.welcomeFeatureBadgeEmerald]}>
                        <Text style={[styles.welcomeFeatureBadgeText, isNeo && styles.welcomeFeatureBadgeTextNeo, isEmerald && styles.welcomeFeatureBadgeTextEmerald]}>{idx + 1}</Text>
                      </View>
                      <Text style={[styles.welcomeFeatureText, isNeo && styles.welcomeFeatureTextNeo, isEmerald && styles.welcomeFeatureTextEmerald]}>
                        {step}
          </Text>
                    </View>
                  ))}
                </Animated.View>

          <Animated.View style={{ transform: [{ scale: buttonScale }] }}>
            <Pressable
              style={[
                styles.welcomePrimaryBtn,
                      styles.welcomePrimaryBtnOnHero,
                isEmerald && styles.welcomePrimaryBtnEmerald,
                isMidnight && styles.welcomePrimaryBtnMidnight,
                isNeo && styles.welcomePrimaryBtnNeo,
                isVitaria && styles.welcomePrimaryBtnVitaria,
                isInferno && styles.welcomePrimaryBtnInferno,
                      styles.welcomePrimaryBtnInsideCard,
              ]}
              onPressIn={() =>
                Animated.spring(buttonScale, {
                  toValue: 0.97,
                  friction: 6,
                  tension: 120,
                  useNativeDriver: true,
                }).start()
              }
              onPressOut={() =>
                Animated.spring(buttonScale, {
                  toValue: 1,
                  friction: 6,
                  tension: 120,
                  useNativeDriver: true,
                }).start()
              }
                    onPress={() => goToWelcomeSlide(2)}
            >
              <Text
                style={[
                  styles.welcomePrimaryBtnText,
                  isMinera && styles.welcomePrimaryBtnTextMinera,
                  isEmerald && styles.welcomePrimaryBtnTextEmerald,
                  isNeo && styles.welcomePrimaryBtnTextNeo,
                  isInferno && styles.welcomePrimaryBtnTextInferno,
                        styles.welcomePrimaryBtnTextInsideCard,
                ]}
              >
                      Continue
              </Text>
          </Pressable>
          </Animated.View>
                <Text style={[styles.welcomeCardHint, styles.welcomeCardHintOnHero, isNeo && styles.welcomeCardHintNeo, isEmerald && styles.welcomeCardHintEmerald]}>
                  Swipe to continue.
                </Text>
              </Animated.View>
            </View>

            <View style={[styles.welcomeSlide, { width: pagerWidth }]}>
              <Animated.View
                style={[
                  styles.welcomeHeroCard,
                  styles.captureCard,
                  isMinera && styles.welcomeHeroCardMinera,
                  isEmerald && styles.welcomeHeroCardEmerald,
                  isMidnight && styles.welcomeHeroCardMidnight,
                  isNeo && styles.welcomeHeroCardNeo,
                  isVitaria && styles.welcomeHeroCardVitaria,
                  isInferno && styles.welcomeHeroCardInferno,
                  {
                    opacity: Animated.multiply(cardFlipOpacity(2), finishExitOpacity),
                    transform: [
                      { perspective: 1100 },
                      { translateX: cardFlipTranslateX(2) },
                      { rotateY: cardFlipRotate(2) },
                      { scale: cardFlipScale(2) },
                      { translateY: finishExitTranslateY },
                      { translateX: finishExitTranslateX },
                      { rotateZ: finishExitRotate },
                      { scale: finishExitScale },
                    ],
                  },
                ]}
              >
                <Animated.View
                  style={[
                    styles.heroGlowOne,
                    styles.captureGlowOne,
                    isMinera && styles.heroGlowOneMinera,
                    isEmerald && styles.heroGlowOneEmerald,
                    isMidnight && styles.heroGlowOneMidnight,
                    isNeo && styles.heroGlowOneNeo,
                    isVitaria && styles.heroGlowOneVitaria,
                    isInferno && styles.heroGlowOneInferno,
                    {
                      transform: [
                        {
                          translateY: bubbleDrift.interpolate({
                            inputRange: [0, 1],
                            outputRange: [0, -12],
                          }),
                        },
                        {
                          translateX: bubbleDrift.interpolate({
                            inputRange: [0, 1],
                            outputRange: [0, 6],
                          }),
                        },
                      ],
                    },
                  ]}
                />
                <Animated.View
                  style={[
                    styles.heroGlowTwo,
                    styles.captureGlowTwo,
                    isMinera && styles.heroGlowTwoMinera,
                    isEmerald && styles.heroGlowTwoEmerald,
                    isMidnight && styles.heroGlowTwoMidnight,
                    isNeo && styles.heroGlowTwoNeo,
                    isVitaria && styles.heroGlowTwoVitaria,
                    isInferno && styles.heroGlowTwoInferno,
                    {
                      transform: [
                        {
                          translateY: bubbleDrift.interpolate({
                            inputRange: [0, 1],
                            outputRange: [0, 10],
                          }),
                        },
                        {
                          translateX: bubbleDrift.interpolate({
                            inputRange: [0, 1],
                            outputRange: [0, -6],
                          }),
                        },
                      ],
                    },
                  ]}
                />
                <Text style={[styles.captureTitle, isNeo && styles.welcomeInfoTitleNeo, isEmerald && styles.welcomeInfoTitleEmerald]}>Tell us about yourself</Text>
                <Text style={[styles.captureSub, isNeo && styles.welcomeInfoSubNeo, isEmerald && styles.welcomeInfoSubEmerald]}>
                  Quick setup so we can personalize your Masjidly experience.
                </Text>

                <View style={styles.captureFieldGroup}>
                  <Text style={[styles.captureLabel, isNeo && styles.welcomeInfoStepTextNeo, isEmerald && styles.welcomeInfoStepTextEmerald]}>Name</Text>
                  <TextInput
                    style={[styles.captureInput, isNeo && styles.captureInputNeo, isEmerald && styles.captureInputEmerald]}
                    value={personalization.name}
                    onChangeText={(value) => setPersonalization((prev) => ({ ...prev, name: value }))}
                    placeholder="Your name"
                    placeholderTextColor={isNeo ? "#6b6b6b" : isEmerald ? "#4f7a5d" : "#ffdfc9"}
                  />
                </View>

                <View style={styles.captureFieldGroup}>
                  <Text style={[styles.captureLabel, isNeo && styles.welcomeInfoStepTextNeo, isEmerald && styles.welcomeInfoStepTextEmerald]}>How did you hear about the app?</Text>
                  <TextInput
                    style={[styles.captureInput, isNeo && styles.captureInputNeo, isEmerald && styles.captureInputEmerald]}
                    value={personalization.heardFrom}
                    onChangeText={(value) => setPersonalization((prev) => ({ ...prev, heardFrom: value }))}
                    placeholder="Friends, masjid, social media, Shaheer..."
                    placeholderTextColor={isNeo ? "#6b6b6b" : isEmerald ? "#4f7a5d" : "#ffdfc9"}
                  />
                </View>

                <View style={styles.captureFieldGroup}>
                  <Text style={[styles.captureLabel, isNeo && styles.welcomeInfoStepTextNeo, isEmerald && styles.welcomeInfoStepTextEmerald]}>Gender</Text>
                  <View style={styles.captureChoiceRow}>
                    {[
                      ["brother", "Brother"],
                      ["sister", "Sister"],
                      ["prefer_not_to_say", "Prefer not to say"],
                    ].map(([id, label]) => {
                      const active = personalization.gender === id;
                      return (
                        <Pressable
                          key={`gender-welcome-${id}`}
                          onPress={() => setPersonalization((prev) => ({ ...prev, gender: id as PersonalizationPrefs["gender"] }))}
                          style={[
                            styles.captureChoicePill,
                          styles.captureChoicePillOnWelcome,
                            isNeo && styles.captureChoicePillNeo,
                            isEmerald && styles.captureChoicePillEmerald,
                            active && styles.captureChoicePillActive,
                          active && styles.captureChoicePillActiveOnWelcome,
                          ]}
                        >
                          <Text
                            style={[
                              styles.captureChoiceText,
                            styles.captureChoiceTextOnWelcome,
                              isNeo && styles.captureChoiceTextNeo,
                              isEmerald && styles.captureChoiceTextEmerald,
                              active && styles.captureChoiceTextActive,
                            active && styles.captureChoiceTextActiveOnWelcome,
                            ]}
                          >
                            {label}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                <View style={styles.captureFieldGroup}>
                  <Text style={[styles.captureLabel, isNeo && styles.welcomeInfoStepTextNeo, isEmerald && styles.welcomeInfoStepTextEmerald]}>
                    What events do you want to see?
                  </Text>
                  <View style={styles.captureChoiceRow}>
                    {["Halaqas", "Classes", "Youth", "Family", "Community"].map((interest) => {
                      const active = personalization.interests.includes(interest);
                      return (
                        <Pressable
                          key={`interest-welcome-${interest}`}
                          onPress={() => toggleInterest(interest)}
                          style={[
                            styles.captureChoicePill,
                            styles.captureChoicePillOnWelcome,
                            isNeo && styles.captureChoicePillNeo,
                            isEmerald && styles.captureChoicePillEmerald,
                            active && styles.captureChoicePillActive,
                            active && styles.captureChoicePillActiveOnWelcome,
                          ]}
                        >
                          <Text
                            style={[
                              styles.captureChoiceText,
                              styles.captureChoiceTextOnWelcome,
                              isNeo && styles.captureChoiceTextNeo,
                              isEmerald && styles.captureChoiceTextEmerald,
                              active && styles.captureChoiceTextActive,
                              active && styles.captureChoiceTextActiveOnWelcome,
                            ]}
                          >
                            {interest}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                {onboardingError ? <Text style={styles.captureErrorText}>{onboardingError}</Text> : null}

                <Pressable
                  style={[
                    styles.welcomePrimaryBtn,
                    styles.welcomePrimaryBtnOnHero,
                  styles.welcomePrimaryBtnWhite,
                    isEmerald && styles.welcomePrimaryBtnEmerald,
                    isMidnight && styles.welcomePrimaryBtnMidnight,
                    isNeo && styles.welcomePrimaryBtnNeo,
                    isVitaria && styles.welcomePrimaryBtnVitaria,
                    isInferno && styles.welcomePrimaryBtnInferno,
                  ]}
                  onPress={saveOnboarding}
                >
                <Text style={[styles.welcomePrimaryBtnText, styles.welcomePrimaryBtnTextMinera, styles.welcomePrimaryBtnTextWhite, isEmerald && styles.welcomePrimaryBtnTextEmerald, isNeo && styles.welcomePrimaryBtnTextNeo, isInferno && styles.welcomePrimaryBtnTextInferno]}>
                    Finish Setup
                  </Text>
                </Pressable>
              </Animated.View>
            </View>
          </Animated.ScrollView>

          <View style={styles.welcomePagerDots}>
            {[0, 1, 2].map((dot) => (
              <View key={`welcome-dot-${dot}`} style={[styles.welcomePagerDot, welcomeSlideIndex === dot && styles.welcomePagerDotActive]} />
            ))}
          </View>
        </View>
      </SafeAreaView>
    );
  };

  const renderProfileCaptureScreen = () => (
    <SafeAreaView style={[styles.welcomeContainer, isMidnight && styles.containerMidnight, isNeo && styles.containerNeo, isVitaria && styles.containerVitaria, isInferno && styles.containerInferno, isEmerald && styles.containerEmerald]}>
      <ScrollView contentContainerStyle={[styles.welcomeBody, styles.captureBody, isMidnight && styles.scrollBodyMidnight, isNeo && styles.scrollBodyNeo, isVitaria && styles.scrollBodyVitaria, isInferno && styles.scrollBodyInferno, isEmerald && styles.scrollBodyEmerald]}>
        <Animated.View
          style={[
            styles.welcomeHeroCard,
            styles.captureCard,
            isMinera && styles.welcomeHeroCardMinera,
            isEmerald && styles.welcomeHeroCardEmerald,
            isMidnight && styles.welcomeHeroCardMidnight,
            isNeo && styles.welcomeHeroCardNeo,
            isVitaria && styles.welcomeHeroCardVitaria,
            isInferno && styles.welcomeHeroCardInferno,
            { opacity: onboardingCardOpacity, transform: [{ translateY: onboardingCardTranslateY }] },
          ]}
        >
          <Animated.View
            style={[
              styles.heroGlowOne,
              styles.captureGlowOne,
              isMinera && styles.heroGlowOneMinera,
              isEmerald && styles.heroGlowOneEmerald,
              isMidnight && styles.heroGlowOneMidnight,
              isNeo && styles.heroGlowOneNeo,
              isVitaria && styles.heroGlowOneVitaria,
              isInferno && styles.heroGlowOneInferno,
              {
                transform: [
                  {
                    translateY: bubbleDrift.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, -12],
                    }),
                  },
                  {
                    translateX: bubbleDrift.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, 6],
                    }),
                  },
                ],
              },
            ]}
          />
          <Animated.View
            style={[
              styles.heroGlowTwo,
              styles.captureGlowTwo,
              isMinera && styles.heroGlowTwoMinera,
              isEmerald && styles.heroGlowTwoEmerald,
              isMidnight && styles.heroGlowTwoMidnight,
              isNeo && styles.heroGlowTwoNeo,
              isVitaria && styles.heroGlowTwoVitaria,
              isInferno && styles.heroGlowTwoInferno,
              {
                transform: [
                  {
                    translateY: bubbleDrift.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, 10],
                    }),
                  },
                  {
                    translateX: bubbleDrift.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, -6],
                    }),
                  },
                ],
              },
            ]}
          />
          <Pressable
            onPress={() => {
              setPendingWelcomeSlide(1);
              setEntryScreen("welcome");
            }}
            style={styles.captureBackPill}
          >
            <Text style={styles.captureBackPillText}>Back</Text>
          </Pressable>
          <Text style={[styles.captureTitle, isNeo && styles.welcomeInfoTitleNeo, isEmerald && styles.welcomeInfoTitleEmerald]}>Tell us about you</Text>
          <Text style={[styles.captureSub, isNeo && styles.welcomeInfoSubNeo, isEmerald && styles.welcomeInfoSubEmerald]}>
            Quick setup so we can personalize your Masjidly experience.
          </Text>

          <View style={styles.captureFieldGroup}>
            <Text style={[styles.captureLabel, isNeo && styles.welcomeInfoStepTextNeo, isEmerald && styles.welcomeInfoStepTextEmerald]}>Name</Text>
            <TextInput
              style={[styles.captureInput, isNeo && styles.captureInputNeo, isEmerald && styles.captureInputEmerald]}
              value={personalization.name}
              onChangeText={(value) => setPersonalization((prev) => ({ ...prev, name: value }))}
              placeholder="Your name"
              placeholderTextColor={isNeo ? "#6b6b6b" : isEmerald ? "#4f7a5d" : "#ffdfc9"}
            />
          </View>

          <View style={styles.captureFieldGroup}>
            <Text style={[styles.captureLabel, isNeo && styles.welcomeInfoStepTextNeo, isEmerald && styles.welcomeInfoStepTextEmerald]}>How did you hear about the app?</Text>
            <TextInput
              style={[styles.captureInput, isNeo && styles.captureInputNeo, isEmerald && styles.captureInputEmerald]}
              value={personalization.heardFrom}
              onChangeText={(value) => setPersonalization((prev) => ({ ...prev, heardFrom: value }))}
              placeholder="Friends, masjid, social media, Shaheer..."
              placeholderTextColor={isNeo ? "#6b6b6b" : isEmerald ? "#4f7a5d" : "#ffdfc9"}
            />
          </View>

          <View style={styles.captureFieldGroup}>
            <Text style={[styles.captureLabel, isNeo && styles.welcomeInfoStepTextNeo, isEmerald && styles.welcomeInfoStepTextEmerald]}>Gender</Text>
            <View style={styles.captureChoiceRow}>
              {[
                ["brother", "Brother"],
                ["sister", "Sister"],
                ["prefer_not_to_say", "Prefer not to say"],
              ].map(([id, label]) => {
                const active = personalization.gender === id;
                return (
                  <Pressable
                    key={`gender-${id}`}
                    onPress={() => setPersonalization((prev) => ({ ...prev, gender: id as PersonalizationPrefs["gender"] }))}
                    style={[
                      styles.captureChoicePill,
                      isNeo && styles.captureChoicePillNeo,
                      isEmerald && styles.captureChoicePillEmerald,
                      active && styles.captureChoicePillActive,
                    ]}
                  >
                    <Text
                      style={[
                        styles.captureChoiceText,
                        isNeo && styles.captureChoiceTextNeo,
                        isEmerald && styles.captureChoiceTextEmerald,
                        active && styles.captureChoiceTextActive,
                      ]}
                    >
                      {label}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {onboardingError ? <Text style={styles.captureErrorText}>{onboardingError}</Text> : null}

          <Pressable
            style={[
              styles.welcomePrimaryBtn,
              styles.welcomePrimaryBtnOnHero,
              isEmerald && styles.welcomePrimaryBtnEmerald,
              isMidnight && styles.welcomePrimaryBtnMidnight,
              isNeo && styles.welcomePrimaryBtnNeo,
              isVitaria && styles.welcomePrimaryBtnVitaria,
              isInferno && styles.welcomePrimaryBtnInferno,
            ]}
            onPress={saveOnboarding}
          >
            <Text style={[styles.welcomePrimaryBtnText, styles.welcomePrimaryBtnTextMinera, isEmerald && styles.welcomePrimaryBtnTextEmerald, isNeo && styles.welcomePrimaryBtnTextNeo, isInferno && styles.welcomePrimaryBtnTextInferno]}>
              Finish Setup
            </Text>
          </Pressable>
        </Animated.View>
      </ScrollView>
    </SafeAreaView>
  );

  const renderLaunchScreen = () => (
    <SafeAreaView style={[styles.welcomeContainer, isMidnight && styles.containerMidnight, isNeo && styles.containerNeo, isVitaria && styles.containerVitaria, isInferno && styles.containerInferno, isEmerald && styles.containerEmerald]}>
      <View style={styles.launchWrap}>
        <Animated.View
          style={[
            styles.heroGlowOne,
            styles.launchGlowOne,
            isMinera && styles.heroGlowOneMinera,
            isEmerald && styles.heroGlowOneEmerald,
            isMidnight && styles.heroGlowOneMidnight,
            isNeo && styles.heroGlowOneNeo,
            isVitaria && styles.heroGlowOneVitaria,
            isInferno && styles.heroGlowOneInferno,
            {
              transform: [
                {
                  translateY: launchGlowDrift.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, -12],
                  }),
                },
                {
                  translateX: launchGlowDrift.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, 8],
                  }),
                },
              ],
            },
          ]}
        />
        <Animated.View
          style={[
            styles.heroGlowTwo,
            styles.launchGlowTwo,
            isMinera && styles.heroGlowTwoMinera,
            isEmerald && styles.heroGlowTwoEmerald,
            isMidnight && styles.heroGlowTwoMidnight,
            isNeo && styles.heroGlowTwoNeo,
            isVitaria && styles.heroGlowTwoVitaria,
            isInferno && styles.heroGlowTwoInferno,
            {
              transform: [
                {
                  translateY: launchGlowDrift.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, 10],
                  }),
                },
                {
                  translateX: launchGlowDrift.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0, -7],
                  }),
                },
              ],
            },
          ]}
        />
        <Animated.View
          style={[
            styles.launchCard,
            styles.launchCardSurface,
            isMidnight && styles.launchCardSurfaceDark,
            isNeo && styles.launchCardSurfaceNeo,
            isEmerald && styles.launchCardSurfaceEmerald,
            isInferno && styles.launchCardSurfaceInferno,
            isVitaria && styles.launchCardSurfaceVitaria,
            {
              opacity: launchOpacity,
              transform: [{ translateY: launchTranslateY }, { scale: launchScale }],
            },
          ]}
        >
          <Animated.Image
            source={WELCOME_LOGO}
            style={[
              styles.launchLogo,
              {
                transform: [
                  {
                    scale: launchPulse.interpolate({
                      inputRange: [0, 1],
                      outputRange: [1, 1.03],
                    }),
                  },
                  {
                    translateY: launchPulse.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, -5],
                    }),
                  },
                ],
              },
            ]}
            resizeMode="contain"
          />
          <Text style={[styles.launchTitle, isNeo && styles.launchTitleNeo, isEmerald && styles.launchTitleEmerald, isMidnight && styles.launchTitleDark]}>
            Welcome to Masjidly
          </Text>
          <Text style={[styles.launchSub, isNeo && styles.launchSubNeo, isEmerald && styles.launchSubEmerald, isMidnight && styles.launchSubDark]}>
            Preparing your home feed...
          </Text>
        </Animated.View>
        <Animated.Text
          style={[
            styles.launchGreeting,
            isNeo && styles.launchGreetingNeo,
            isEmerald && styles.launchGreetingEmerald,
            {
              opacity: launchMessageOpacity,
              transform: [{ translateY: launchMessageTranslateY }],
            },
          ]}
        >
          Welcome back, {personalization.name || "Friend"}
        </Animated.Text>
      </View>
    </SafeAreaView>
  );

  const renderOnboardingScreen = () => (
    <SafeAreaView style={[styles.welcomeContainer, isMidnight && styles.containerMidnight, isNeo && styles.containerNeo, isVitaria && styles.containerVitaria, isInferno && styles.containerInferno, isEmerald && styles.containerEmerald]}>
      <ScrollView contentContainerStyle={[styles.welcomeBody, isMidnight && styles.scrollBodyMidnight, isNeo && styles.scrollBodyNeo, isVitaria && styles.scrollBodyVitaria, isInferno && styles.scrollBodyInferno, isEmerald && styles.scrollBodyEmerald]}>
        <View style={[styles.tutorialCard, isMidnight && styles.controlsCardMidnight, isNeo && styles.controlsCardNeo, isVitaria && styles.controlsCardVitaria, isInferno && styles.controlsCardInferno, isEmerald && styles.controlsCardEmerald]}>
          <Text style={[styles.tutorialTitle, isMidnight && styles.sectionTitleMidnight, isNeo && styles.sectionTitleNeo, isVitaria && styles.sectionTitleVitaria, isInferno && styles.sectionTitleInferno, isEmerald && styles.sectionTitleEmerald]}>
            Personalize Masjidly
          </Text>
          <Text style={[styles.metaInfoLine, isMidnight && styles.metaInfoLineMidnight, isNeo && styles.metaInfoLineNeo, isVitaria && styles.metaInfoLineVitaria, isInferno && styles.metaInfoLineInferno, isEmerald && styles.metaInfoLineEmerald]}>
            Tell us a bit about you so we can push the most relevant events higher while still showing all events.
          </Text>
          <TextInput
            style={[styles.input, isMidnight && styles.inputMidnight, isNeo && styles.inputNeo, isVitaria && styles.inputVitaria, isInferno && styles.inputInferno, isEmerald && styles.inputEmerald]}
            value={personalization.name}
            onChangeText={(value) => setPersonalization((prev) => ({ ...prev, name: value }))}
            placeholder="Your name"
            placeholderTextColor={inputPlaceholderColor}
          />
          <Text style={[styles.smallWhyText, isMidnight && styles.metaInfoLineMidnight, isNeo && styles.metaInfoLineNeo, isVitaria && styles.metaInfoLineVitaria, isInferno && styles.metaInfoLineInferno, isEmerald && styles.metaInfoLineEmerald]}>
            Are you mainly looking for brothers or sisters events? We ask this only to rank relevant events higher.
          </Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.sourceStrip}>
            {[
              ["all", "All"],
              ["brothers", "Brothers"],
              ["sisters", "Sisters"],
            ].map(([id, label]) => {
              const active = personalization.preferredAudience === id;
              return (
                <Pressable
                  key={`pref-${id}`}
                  onPress={() =>
                    setPersonalization((prev) => ({
                      ...prev,
                      preferredAudience: id as PersonalizationPrefs["preferredAudience"],
                    }))
                  }
                  style={audienceChipStyle(id, active)}
                >
                  <Text style={audienceChipTextStyle(id, active)}>{label}</Text>
          </Pressable>
              );
            })}
          </ScrollView>
          <Text style={[styles.smallWhyText, isMidnight && styles.metaInfoLineMidnight, isNeo && styles.metaInfoLineNeo, isVitaria && styles.metaInfoLineVitaria, isInferno && styles.metaInfoLineInferno, isEmerald && styles.metaInfoLineEmerald]}>What events do you mainly want to see?</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.sourceStrip}>
            {["Halaqas", "Classes", "Youth", "Family", "Community"].map((interest) => {
              const active = personalization.interests.includes(interest);
              return (
          <Pressable
                  key={`interest-${interest}`}
                  onPress={() => toggleInterest(interest)}
                  style={[styles.sourceChip, active && styles.sourceChipActive]}
                >
                  <Text style={[styles.sourceChipText, active && styles.sourceChipTextActive]}>
                    {interest}
                  </Text>
          </Pressable>
              );
            })}
          </ScrollView>
          <Text style={[styles.smallWhyText, isMidnight && styles.metaInfoLineMidnight, isNeo && styles.metaInfoLineNeo, isVitaria && styles.metaInfoLineVitaria, isInferno && styles.metaInfoLineInferno, isEmerald && styles.metaInfoLineEmerald]}>Optional: nearby radius preference</Text>
          <View style={styles.row}>
            <TextInput
              style={[styles.input, styles.half, isMidnight && styles.inputMidnight, isNeo && styles.inputNeo, isVitaria && styles.inputVitaria, isInferno && styles.inputInferno, isEmerald && styles.inputEmerald]}
              value={radius}
              onChangeText={setRadius}
              keyboardType="number-pad"
              placeholder="Radius miles"
              placeholderTextColor={inputPlaceholderColor}
            />
        </View>
          <Text style={[styles.smallWhyText, isMidnight && styles.metaInfoLineMidnight, isNeo && styles.metaInfoLineNeo, isVitaria && styles.metaInfoLineVitaria, isInferno && styles.metaInfoLineInferno, isEmerald && styles.metaInfoLineEmerald]}>Choose your frequent masjids</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.sourceStrip}>
            {(meta?.sources || []).map((src) => {
              const active = selectedSources.has(src);
            return (
              <Pressable
                  key={src}
                  onPress={() => toggleSource(src)}
                style={[styles.sourceChip, active && styles.sourceChipActive]}
              >
                  <Text style={[styles.sourceChipText, active && styles.sourceChipTextActive]}>{formatSourceLabel(src)}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
          <Pressable style={styles.primaryBtn} onPress={saveOnboarding}>
            <Text style={styles.primaryBtnText}>Save Onboarding</Text>
          </Pressable>
      </View>
      </ScrollView>
    </SafeAreaView>
  );

  const renderHome = () => {
    const welcomeName = normalizeText(
      personalization.name || (currentUser?.email || "friend").split("@")[0] || "friend"
    );
    const today = todayIso();
    const todayEvents = orderedVisibleEvents.filter((e) => (e.date || "") === today);
    const thisWeekEvents = orderedVisibleEvents
      .filter((e) => (e.date || "") > today && (e.date || "") <= plusDaysIso(7))
      .slice(0, 5);
    const nearYouEvents = reference
      ? [...orderedVisibleEvents]
          .filter((e) => typeof e.distance_miles === "number" && e.date >= today)
          .sort((a, b) => Number(a.distance_miles ?? 9999) - Number(b.distance_miles ?? 9999))
          .slice(0, 3)
      : [];
    const followedWithNext: Array<{ source: string; next: EventItem | null }> = followedMasjids.map((src) => ({
      source: src,
      next:
        orderedVisibleEvents.find((e) => normalizeText(e.source).toLowerCase() === src.toLowerCase() && (e.date || "") >= today) || null,
    }));
    const nextDate = orderedVisibleEvents[0]?.date ? new Date(`${orderedVisibleEvents[0].date}T00:00:00`) : null;
    const daysUntil = nextDate
      ? Math.max(0, Math.ceil((nextDate.getTime() - new Date().setHours(0, 0, 0, 0)) / (1000 * 60 * 60 * 24)))
      : null;
    const nextEventText =
      daysUntil === null
        ? "No upcoming events yet"
        : daysUntil === 0
          ? "First event is today"
          : daysUntil === 1
            ? "First event tomorrow"
            : `First event in ${daysUntil} days`;
    const quickActions = [
      { label: "Browse", emoji: "◉", action: () => switchTab("explore") },
      { label: "Calendar", emoji: "◷", action: () => switchTab("calendar") },
      { label: "Saved", emoji: "♡", action: () => switchTab("saved") },
      { label: "Refresh", emoji: "↻", action: () => loadEvents({ force: true }) },
    ];

    const renderMiniEventRow = (e: EventItem, keyHint: string) => {
      const key = eventStorageKey(e);
      const rsvpState = rsvpStatuses[key];
      const saved = isSavedEvent(e);
      const poster = pickPoster(e.image_urls);
    return (
        <Pressable
          key={`home-row-${keyHint}`}
          style={[styles.homeEventRow, isDarkTheme && styles.homeEventRowDark]}
          onPress={() => setSelectedEvent(e)}
        >
          {poster ? (
            <Image source={{ uri: poster }} style={styles.homeEventRowPoster} />
          ) : (
            <View style={[styles.homeEventRowPoster, { alignItems: "center", justifyContent: "center" }]}>
              <Text style={[{ fontSize: 22, color: "#a3b0c8" }, emojiFontStyle]}>🕌</Text>
            </View>
          )}
          <View style={{ flex: 1 }}>
            <Text style={[styles.homeEventRowWhen, isDarkTheme && { color: "#c4cee8" }]}>
              {formatHumanDate(e.date)} · {eventTime(e)}
            </Text>
            <Text style={[styles.homeEventRowTitle, isDarkTheme && { color: "#f4f7ff" }]} numberOfLines={2}>
              {e.title}
            </Text>
            <Text style={[styles.homeEventRowMeta, isDarkTheme && { color: "#a6b4d4" }]} numberOfLines={1}>
              {formatSourceLabel(e.source)}
              {typeof e.distance_miles === "number" ? ` · ${e.distance_miles.toFixed(1)} mi` : ""}
            </Text>
            <View style={styles.cardActionRow}>
              <Pressable
                hitSlop={6}
                style={[styles.cardActionChip, rsvpState === "going" && styles.cardActionChipActive]}
                onPress={(ev) => { ev.stopPropagation?.(); toggleRsvp(e, "going"); }}
              >
                <Text style={[styles.cardActionChipText, rsvpState === "going" && styles.cardActionChipTextActive]}>
                  {rsvpState === "going" ? "Going ✓" : "Going"}
                </Text>
              </Pressable>
              <Pressable
                hitSlop={6}
                style={[styles.cardActionChip, rsvpState === "interested" && styles.cardActionChipActive]}
                onPress={(ev) => { ev.stopPropagation?.(); toggleRsvp(e, "interested"); }}
              >
                <Text style={[styles.cardActionChipText, rsvpState === "interested" && styles.cardActionChipTextActive]}>
                  {rsvpState === "interested" ? "Interested ✓" : "Interested"}
                </Text>
              </Pressable>
              <Pressable
                hitSlop={6}
                style={[styles.cardActionChip, saved && styles.cardActionChipActive]}
                onPress={(ev) => { ev.stopPropagation?.(); toggleSavedEvent(e); }}
              >
                <Text style={[styles.cardActionChipText, saved && styles.cardActionChipTextActive, emojiFontStyle]}>
                  {saved ? "♥" : "♡"}
                </Text>
              </Pressable>
              <Pressable
                hitSlop={6}
                style={styles.cardActionChip}
                onPress={(ev) => { ev.stopPropagation?.(); shareEvent(e); }}
              >
                <Text style={[styles.cardActionChipText, emojiFontStyle]}>↗</Text>
              </Pressable>
            </View>
          </View>
        </Pressable>
      );
    };

    return (
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={[
          { paddingBottom: 120 },
          isMidnight && styles.scrollBodyMidnight,
          isNeo && styles.scrollBodyNeo,
          isVitaria && styles.scrollBodyVitaria,
          isInferno && styles.scrollBodyInferno,
          isEmerald && styles.scrollBodyEmerald,
        ]}
        showsVerticalScrollIndicator={false}
      >
        <LinearGradient
          colors={
            isMidnight
              ? ["#06080f", "#11142a", "#1f2038"]
              : isNeo
                ? ["#d8d8d8", "#d2d2d2", "#cecece"]
                : isVitaria
                  ? ["#8f7680", "#b3949d", "#8a7589"]
                  : isInferno
                    ? ["#030304", "#150901", "#5a1802"]
                    : isEmerald
                      ? ["#0e2a1b", "#1f5b3a", "#3f8a56"]
                      : ["#ff9a6c", "#ff7d50", "#fca98a"]
          }
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.homeHero}
        >
          <Animated.View
            pointerEvents="none"
            style={[
              styles.homeHeroGlowA,
              {
                opacity: homeHeroGlowDrift.interpolate({ inputRange: [0, 1], outputRange: [0.38, 0.72] }),
                transform: [
                  { scale: homeHeroGlowDrift.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1.14] }) },
                  { translateX: homeHeroGlowDrift.interpolate({ inputRange: [0, 1], outputRange: [-18, 22] }) },
                  { translateY: homeHeroGlowDrift.interpolate({ inputRange: [0, 1], outputRange: [-14, 10] }) },
                ],
              },
            ]}
          />
          <Animated.View
            pointerEvents="none"
            style={[
              styles.homeHeroGlowB,
              {
                opacity: homeHeroGlowDrift.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0.28] }),
                transform: [
                  { scale: homeHeroGlowDrift.interpolate({ inputRange: [0, 1], outputRange: [1.08, 0.9] }) },
                  { translateX: homeHeroGlowDrift.interpolate({ inputRange: [0, 1], outputRange: [30, -10] }) },
                  { translateY: homeHeroGlowDrift.interpolate({ inputRange: [0, 1], outputRange: [20, -16] }) },
                ],
              },
            ]}
          />
          <Animated.View
            pointerEvents="none"
            style={[
              styles.homeHeroShimmer,
              {
                opacity: homeHeroGlowDrift.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0, 0.22, 0] }),
                transform: [
                  {
                    translateX: homeHeroGlowDrift.interpolate({ inputRange: [0, 1], outputRange: [-160, 340] }),
                  },
                  { rotate: "18deg" },
                ],
              },
            ]}
          />

          <Text style={[styles.homeHeroHi, isNeo && { color: "#2e2e2e" }]}>Assalamu alaikum, {welcomeName}</Text>
          <Text style={[styles.homeHeroCount, isNeo && { color: "#151515" }]}>
            {futureVisibleCount} upcoming events
            </Text>
          <Text style={[styles.homeHeroSub, isNeo && { color: "#3f3f3f" }]}>
            {nextEventText} · {new Set(events.map((e) => e.source)).size} masjids
          </Text>
          <Pressable style={styles.homeHeroCta} onPress={() => switchTab("explore")}>
            <Text style={styles.homeHeroCtaText}>Browse events  →</Text>
            </Pressable>
        </LinearGradient>

        <View style={styles.homeQuickRow}>
          {quickActions.map((a) => (
            <Pressable
              key={`qa-${a.label}`}
              style={[styles.homeQuickBtn, isDarkTheme && styles.homeQuickBtnDark]}
              onPress={a.action}
            >
              <Text style={[styles.homeQuickEmoji, emojiFontStyle, isDarkTheme && { color: "#f4f7ff" }]}>{a.emoji}</Text>
              <Text style={[styles.homeQuickLabel, isDarkTheme && { color: "#f4f7ff" }]}>{a.label}</Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.homeSection}>
          <View style={styles.homeSectionHeader}>
            <Text style={[styles.homeSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>Today</Text>
            <View style={styles.homeSectionHeaderRight}>
              {todayEvents.length ? (
                <Text style={[styles.homeSectionCount, isDarkTheme && { color: "#c4cee8" }]}>
                  {todayEvents.length}
          </Text>
              ) : null}
              <Pressable onPress={() => switchTab("explore")} hitSlop={8}>
                <Text style={[styles.homeSectionSeeAll, isDarkTheme && { color: "#9db0db" }]}>See all →</Text>
              </Pressable>
                </View>
            </View>
          {todayEvents.length ? (
            todayEvents.slice(0, 4).map((e, idx) => renderMiniEventRow(e, `today-${idx}`))
          ) : (
            <View style={[styles.homeEmpty, isDarkTheme && styles.homeEmptyDark]}>
              <Text style={[styles.homeEmptyText, isDarkTheme && { color: "#c4cee8" }]}>
                No events today. {nextEventText.toLowerCase()}.
              </Text>
              </View>
            )}
        </View>

        {thisWeekEvents.length ? (
          <View style={styles.homeSection}>
            <View style={styles.homeSectionHeader}>
              <Text style={[styles.homeSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>This week</Text>
              <Pressable onPress={() => switchTab("explore")} hitSlop={8}>
                <Text style={[styles.homeSectionSeeAll, isDarkTheme && { color: "#9db0db" }]}>See all</Text>
          </Pressable>
        </View>
            {thisWeekEvents.map((e, idx) => renderMiniEventRow(e, `week-${idx}`))}
        </View>
        ) : null}

        {nearYouEvents.length ? (
          <View style={styles.homeSection}>
            <View style={styles.homeSectionHeader}>
              <Text style={[styles.homeSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>Near you</Text>
              <Text style={[styles.homeSectionCount, isDarkTheme && { color: "#c4cee8" }]}>{reference}</Text>
            </View>
            {nearYouEvents.map((e, idx) => renderMiniEventRow(e, `near-${idx}`))}
          </View>
        ) : null}

        {followedWithNext.length ? (
          <View style={styles.homeSection}>
            <View style={styles.homeSectionHeader}>
              <Text style={[styles.homeSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>Masjids you follow</Text>
              <Text style={[styles.homeSectionCount, isDarkTheme && { color: "#c4cee8" }]}>
                {followedWithNext.length}
              </Text>
            </View>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 10, paddingVertical: 4 }}>
              {followedWithNext.map(({ source, next }) => (
            <Pressable
                  key={`follow-${source}`}
                  style={[styles.homeFollowChip, isDarkTheme && styles.homeFollowChipDark]}
                  onPress={() => setSelectedMasjidProfile(source)}
                >
                  <Text style={[styles.homeFollowName, isDarkTheme && { color: "#f4f7ff" }]} numberOfLines={1}>
                    {formatSourceLabel(source)}
                  </Text>
                  <Text style={[styles.homeFollowNext, isDarkTheme && { color: "#c4cee8" }]} numberOfLines={1}>
                    {next ? `${formatHumanDate(next.date)} · ${next.title}` : "No upcoming events"}
                </Text>
            </Pressable>
              ))}
          </ScrollView>
      </View>
        ) : null}

        <Pressable
          style={[styles.homeBrowseAllBtn, isDarkTheme && styles.homeBrowseAllBtnDark]}
          onPress={() => switchTab("explore")}
        >
          <Text style={[styles.homeBrowseAllTitle, isDarkTheme && { color: "#f4f7ff" }]}>
            Browse all {orderedVisibleEvents.length} upcoming event{orderedVisibleEvents.length === 1 ? "" : "s"}
          </Text>
          <Text style={[styles.homeBrowseAllSub, isDarkTheme && { color: "#c4cee8" }]}>
            Home shows today + this week. Explore has the full list on a map & feed.
          </Text>
        </Pressable>
    </ScrollView>
  );
  };

  const renderEventListCard = (e: EventItem, keyHint?: string) => {
    const key = eventStorageKey(e);
    const rsvpState = rsvpStatuses[key];
    const saved = isSavedEvent(e);
    const topic = eventTopicSummary(e);
    const fresh = freshnessLabelFor(e);
    const freshPalette = freshnessColor(fresh.color);
    const topicTags = (e.topics || []).filter((t) => TOPIC_LABELS[t]).slice(0, 3);
    const scoreChip = buildPersonalScoreChip(e, {
      followedSources: new Set(followedMasjids),
      rsvpStatuses,
      preferredAudience: audienceFilter,
    });
    const flagged = e.correction?.flagged;
    const verified = e.correction?.verified;
    return (
      <Pressable
        key={`event-card-${keyHint || key}`}
        style={styles.hospitalListCard}
        onPress={() => setSelectedEvent(e)}
      >
        {pickPoster(e.image_urls) ? (
          <Image source={{ uri: pickPoster(e.image_urls) }} style={styles.hospitalListPoster} />
        ) : (
          <View style={styles.hospitalListPoster} />
        )}
        <View style={{ flex: 1 }}>
          <View style={styles.eventBadgeRow}>
            <View style={[styles.freshnessPill, { backgroundColor: freshPalette.bg }]}>
              <View style={[styles.freshnessDot, { backgroundColor: freshPalette.dot }]} />
              <Text style={[styles.freshnessPillText, { color: freshPalette.text }]} numberOfLines={1}>
                {fresh.label}
              </Text>
            </View>
            {verified ? (
              <View style={[styles.freshnessPill, { backgroundColor: "rgba(48,168,96,0.14)" }]}>
                <Text style={[styles.freshnessPillText, { color: "#1f7a42" }]}>✓ Verified</Text>
              </View>
            ) : null}
            {flagged ? (
              <View style={[styles.freshnessPill, { backgroundColor: "rgba(214,99,46,0.16)" }]}>
                <Text style={[styles.freshnessPillText, { color: "#9a4311" }]}>⚠ Flagged</Text>
              </View>
            ) : null}
            {scoreChip ? (
              <View style={[styles.freshnessPill, { backgroundColor: "rgba(109,83,232,0.16)" }]}>
                <Text style={[styles.freshnessPillText, { color: "#4a3bb0" }]} numberOfLines={1}>
                  {scoreChip.label}
                </Text>
              </View>
            ) : null}
          </View>
          <Text style={[styles.exploreListWhen, isDarkTheme && styles.exploreListWhenDark, isNeo && styles.exploreListWhenNeo]}>
            {formatHumanDate(e.date)} · {eventTime(e)}
              </Text>
          <Text style={[styles.hospitalListTitle, isDarkTheme && styles.hospitalListTitleDark, isNeo && styles.hospitalListTitleNeo]} numberOfLines={2}>
            {e.title}
          </Text>
          {topic ? (
            <Text
              style={[styles.exploreListTopic, isDarkTheme && styles.exploreListTopicDark, isNeo && styles.exploreListTopicNeo]}
              numberOfLines={2}
            >
              {topic}
            </Text>
          ) : null}
          <View style={styles.cardTagsRow}>
            <Text style={styles.mapTag}>{inferAudience(e)}</Text>
            {topicTags.map((t) => (
              <Text key={`topic-${t}`} style={styles.topicTag}>
                {TOPIC_LABELS[t]}
              </Text>
            ))}
            {normalizeText(e.speaker || "") ? (
              <Text style={styles.cardSpeakerTag} numberOfLines={1}>
                Speaker: {e.speaker}
              </Text>
            ) : null}
          </View>
          <Text style={[styles.hospitalListMeta, isDarkTheme && styles.hospitalListMetaDark, isNeo && styles.hospitalListMetaNeo]} numberOfLines={1}>
            {formatSourceLabel(e.source)} · {[e.location_name, e.address].filter(Boolean).join(" · ")}
          </Text>
          {isLikelyStaleEvent(e) ? (
            <Text style={[styles.hospitalListMeta, { color: "#cc6f2f" }]}>Likely stale — verify details</Text>
          ) : null}
          {(e.attendees?.going || 0) > 0 ? (
            <Text style={[styles.hospitalListMeta, { color: "#4a3bb0", fontWeight: "600" }]}>
              {e.attendees?.going} going{(e.attendees?.interested || 0) > 0 ? ` · ${e.attendees?.interested} interested` : ""}
            </Text>
          ) : null}
          <View style={styles.cardActionRow}>
            <Pressable
              hitSlop={6}
              style={[styles.cardActionChip, rsvpState === "going" && styles.cardActionChipActive]}
              onPress={(ev) => {
                ev.stopPropagation?.();
                toggleRsvp(e, "going");
              }}
            >
              <Text style={[styles.cardActionChipText, rsvpState === "going" && styles.cardActionChipTextActive]}>
                {rsvpState === "going" ? "Going ✓" : "Going"}
              </Text>
                </Pressable>
            <Pressable
              hitSlop={6}
              style={[styles.cardActionChip, rsvpState === "interested" && styles.cardActionChipActive]}
              onPress={(ev) => {
                ev.stopPropagation?.();
                toggleRsvp(e, "interested");
              }}
            >
              <Text style={[styles.cardActionChipText, rsvpState === "interested" && styles.cardActionChipTextActive]}>
                {rsvpState === "interested" ? "Interested ✓" : "Interested"}
              </Text>
                </Pressable>
            <Pressable
              hitSlop={6}
              style={[styles.cardActionChip, saved && styles.cardActionChipActive]}
              onPress={(ev) => {
                ev.stopPropagation?.();
                toggleSavedEvent(e);
              }}
            >
              <Text style={[styles.cardActionChipText, saved && styles.cardActionChipTextActive, emojiFontStyle]}>
                {saved ? "♥" : "♡"}
              </Text>
            </Pressable>
            <Pressable
              hitSlop={6}
              style={styles.cardActionChip}
              onPress={(ev) => {
                ev.stopPropagation?.();
                shareEvent(e);
              }}
            >
              <Text style={[styles.cardActionChipText, emojiFontStyle]}>↗</Text>
                </Pressable>
              </View>
            </View>
      </Pressable>
    );
  };

  const exploreMapHeight = Math.round(windowHeight * 0.55);

  const renderExploreHeroMap = () => (
    <View style={[styles.exploreMapHero, { height: exploreMapHeight }]}>
      <MapView
        style={StyleSheet.absoluteFillObject}
        region={mapRegion}
        onRegionChangeComplete={setMapRegion}
      >
        {masjidPinsForExplore.map((pin) => (
          <Marker
            key={`masjid-${pin.sourceKey}`}
            coordinate={{ latitude: pin.latitude, longitude: pin.longitude }}
            onPress={() => setSelectedMasjidSheet(pin.sourceKey)}
            tracksViewChanges={false}
            anchor={{ x: 0.5, y: 1 }}
          >
            <View style={styles.mapMasjidPinWrap}>
              <View
                style={[
                  styles.mapMasjidLogo,
                  { backgroundColor: pin.count === 0 ? "#6b778c" : masjidBrandColor(pin.sourceKey) },
                ]}
              >
                <Text style={styles.mapMasjidLogoText} numberOfLines={1}>
                  {masjidInitials(pin.sourceKey)}
                </Text>
                {pin.count > 0 ? (
                  <View style={styles.mapMasjidBadge}>
                    <Text style={styles.mapMasjidBadgeText}>{pin.count > 99 ? "99+" : pin.count}</Text>
          </View>
        ) : null}
      </View>
              <View
                style={[
                  styles.mapMasjidPinTail,
                  { borderTopColor: pin.count === 0 ? "#6b778c" : masjidBrandColor(pin.sourceKey) },
                ]}
          />
        </View>
            <Callout onPress={() => setSelectedMasjidSheet(pin.sourceKey)}>
              <View style={styles.mapCallout}>
                <Text style={styles.mapCalloutTitle} numberOfLines={2}>
                  {formatSourceLabel(pin.sourceKey)}
                </Text>
                <Text style={styles.mapCalloutSub} numberOfLines={2}>
                  {pin.count
                    ? `${pin.count} event${pin.count === 1 ? "" : "s"} · tap for details`
                    : "No events match current filters"}
                </Text>
        </View>
            </Callout>
          </Marker>
        ))}
      </MapView>
      <View style={styles.exploreMapOverlayTop} pointerEvents="none">
        <Text style={styles.exploreMapOverlayTitle}>Masjids near you</Text>
        <Text style={styles.exploreMapOverlaySub}>
          {masjidPinsForExplore.reduce((s, p) => s + p.count, 0)} events across {masjidPinsForExplore.filter((p) => p.count > 0).length} masjids
        </Text>
        </View>
    </View>
  );

  const renderExplore = () => (
    <ScrollView
      ref={exploreScrollRef}
      style={{ flex: 1 }}
      contentContainerStyle={[
        { paddingBottom: 120 },
        isMidnight && styles.scrollBodyMidnight,
        isNeo && styles.scrollBodyNeo,
        isVitaria && styles.scrollBodyVitaria,
        isInferno && styles.scrollBodyInferno,
        isEmerald && styles.scrollBodyEmerald,
      ]}
      showsVerticalScrollIndicator={false}
    >
      {renderExploreHeroMap()}

      <View style={[styles.exploreFilterBar, isDarkTheme && styles.exploreFilterBarDark, isNeo && styles.exploreFilterBarNeo]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.exploreAudienceStrip}>
          {[
            ["all", "All"],
            ["brothers", "Brothers"],
            ["sisters", "Sisters"],
            ["family", "Family"],
          ].map(([id, label]) => {
            const active = audienceFilter === id;
            return (
              <Pressable
                key={`explore-aud-${id}`}
                onPress={() => setAudienceFilter(id as typeof audienceFilter)}
                style={audienceChipStyle(id, active)}
              >
                <Text style={audienceChipTextStyle(id, active)}>{label}</Text>
              </Pressable>
            );
          })}
          <Pressable
            key="explore-more-filters"
            onPress={() => setShowExploreFilters(true)}
            style={[styles.exploreMoreChip, isDarkTheme && styles.exploreMoreChipDark]}
          >
            <Text style={[styles.exploreMoreChipText, isDarkTheme && styles.exploreMoreChipTextDark]}>Filters ⌃</Text>
          </Pressable>
        </ScrollView>
      </View>

      {/* #23 Halaqa topic chips */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 12, gap: 8, paddingVertical: 8 }}
      >
        <Pressable
          key="topic-all"
          onPress={() => {
            setHalaqaFilter(null);
            setAudienceFilter("all");
            setQuickFilters([]);
          }}
          style={[
            styles.topicChip,
            halaqaFilter === null &&
              audienceFilter === "all" &&
              quickFilters.length === 0 &&
              styles.topicChipActive,
          ]}
        >
          <Text
            style={[
              styles.topicChipText,
              halaqaFilter === null &&
                audienceFilter === "all" &&
                quickFilters.length === 0 &&
                styles.topicChipTextActive,
            ]}
          >
            All topics
          </Text>
        </Pressable>
        {HALAQA_FILTER_TOPICS.map((t) => (
          <Pressable
            key={`topic-${t}`}
            onPress={() => setHalaqaFilter((prev) => (prev === t ? null : t))}
            style={[
              styles.topicChip,
              halaqaFilter === t && styles.topicChipActive,
            ]}
          >
            <Text style={[styles.topicChipText, halaqaFilter === t && styles.topicChipTextActive]}>
              {TOPIC_LABELS[t]}
            </Text>
          </Pressable>
        ))}
      </ScrollView>

      {/* #13 Event series strip */}
      {eventSeries.length > 0 ? (
        <View style={{ paddingHorizontal: 12, paddingVertical: 6 }}>
          <Text style={styles.seriesStripTitle}>Weekly & recurring series</Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 10, paddingVertical: 6 }}
          >
            {eventSeries.slice(0, 12).map((s) => (
              <Pressable
                key={`series-${s.series_id}`}
                style={styles.seriesCard}
                onPress={() => {
                  setSelectedMasjidSheet(s.source);
                }}
              >
                {s.image_url ? (
                  <Image source={{ uri: s.image_url }} style={styles.seriesPoster} />
                ) : (
                  <View style={[styles.seriesPoster, { backgroundColor: masjidBrandColor(s.source), alignItems: "center", justifyContent: "center" }]}>
                    <Text style={{ color: "#fff", fontWeight: "800" }}>{masjidInitials(s.source)}</Text>
                  </View>
                )}
                <Text style={styles.seriesTitle} numberOfLines={2}>{s.title}</Text>
                <Text style={styles.seriesSub} numberOfLines={1}>{formatSourceLabel(s.source)}</Text>
                <Text style={styles.seriesCount}>{s.upcoming_count} upcoming</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}

      <View style={styles.exploreListWrap}>
        {exploreSections.length === 0 ? (
          <View style={styles.exploreEmpty}>
            <Text style={[styles.exploreEmptyTitle, isDarkTheme && { color: "#f4f7ff" }]}>No events match</Text>
            <Text style={[styles.exploreEmptySub, isDarkTheme && { color: "#c4cee8" }]}>
              Try clearing filters or switching audience.
            </Text>
            <Pressable
              onPress={() => {
                setQuery("");
                setReference("");
                setRadius("35");
                setStartDate(todayIso());
                setEndDate(plusDaysIso(45));
                setAudienceFilter("all");
                setQuickFilters([]);
                setHalaqaFilter(null);
              }}
              style={styles.exploreEmptyBtn}
            >
              <Text style={styles.exploreEmptyBtnText}>Reset filters</Text>
            </Pressable>
          </View>
        ) : (
          exploreSections.map((section) => (
            <View key={`section-${section.title}`} style={styles.exploreDaySection}>
              <Text style={[styles.dayHeader, isDarkTheme && styles.dayHeaderDark, isNeo && styles.dayHeaderNeo]}>
                {formatHumanDate(section.title)}
                </Text>
              {section.data.map((e, idx) => renderEventListCard(e, `${section.title}-${idx}`))}
              </View>
          ))
        )}
      </View>
    </ScrollView>
  );

  const renderCalendar = () => {
    const datedUpcoming = calendarScheduleEvents;
    const eventsByDate = new Map<string, EventItem[]>();
    for (const e of datedUpcoming) {
      const key = normalizeText(e.date);
      const bucket = eventsByDate.get(key) || [];
      bucket.push(e);
      eventsByDate.set(key, bucket);
    }
    const dateKeys = Array.from(eventsByDate.keys()).sort((a, b) => a.localeCompare(b));
    const activeDate = selectedCalendarDate && eventsByDate.has(selectedCalendarDate) ? selectedCalendarDate : dateKeys[0] || "";
    const activeDateEvents = activeDate ? eventsByDate.get(activeDate) || [] : [];

    const monthKeys = Array.from(
      new Set(
        datedUpcoming
          .map((e) => {
            const d = new Date(`${e.date}T00:00:00`);
            if (!Number.isFinite(d.getTime())) return "";
            return `${d.getFullYear()}-${d.getMonth()}`;
          })
          .filter(Boolean)
      )
    ).sort((a, b) => a.localeCompare(b));
    const monthGridKeys = monthKeys.slice(0, 10);
    const monthGridOverflow = monthKeys.length > monthGridKeys.length;

    return (
    <ScrollView ref={calendarScrollRef} contentContainerStyle={[styles.scrollBody, isMidnight && styles.scrollBodyMidnight, isNeo && styles.scrollBodyNeo, isVitaria && styles.scrollBodyVitaria, isInferno && styles.scrollBodyInferno, isEmerald && styles.scrollBodyEmerald]}>
      <LinearGradient
        colors={isMidnight ? ["#0c0f19", "#151b2a"] : isNeo ? ["#d8d8d8", "#d2d2d2"] : isVitaria ? ["#8f7680", "#b3949d"] : isInferno ? ["#070607", "#1b0901"] : isEmerald ? ["#b8e5c9", "#8fd5ad"] : ["#f0f2f7", "#e8ebf3"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.premiumSectionHeader}
      >
          <Text style={[styles.premiumSectionTitle, isDarkTheme && styles.premiumSectionTitleDark, isNeo && styles.premiumSectionTitleNeo]}>Calendar</Text>
        <Text style={[styles.premiumSectionSub, isDarkTheme && styles.premiumSectionSubDark, isNeo && styles.premiumSectionSubNeo]}>
            See event days at a glance, then open Export List when ready.
        </Text>
      </LinearGradient>

        <View style={[styles.calendarViewSwitch, isDarkTheme && styles.calendarViewSwitchDark]}>
          <Pressable style={[styles.calendarViewChip, calendarView === "month" && styles.calendarViewChipActive]} onPress={() => setCalendarView("month")}>
            <Text style={[styles.calendarViewChipText, calendarView === "month" && styles.calendarViewChipTextActive]}>Calendar View</Text>
          </Pressable>
          <Pressable style={[styles.calendarViewChip, calendarView === "list" && styles.calendarViewChipActive]} onPress={() => setCalendarView("list")}>
            <Text style={[styles.calendarViewChipText, calendarView === "list" && styles.calendarViewChipTextActive]}>Export List</Text>
          </Pressable>
        </View>

        {calendarView === "month" ? (
          <>
            {!monthGridKeys.length ? (
        <View style={styles.emptyCard}>
                <Text style={[styles.emptyText, isDarkTheme && styles.emptyTextDark, isNeo && styles.emptyTextNeo]}>No upcoming events available yet.</Text>
        </View>
      ) : null}
            {monthGridOverflow ? (
              <Text style={[styles.metaInfoLine, isMidnight && styles.metaInfoLineMidnight, isNeo && styles.metaInfoLineNeo, isVitaria && styles.metaInfoLineVitaria, isInferno && styles.metaInfoLineInferno, isEmerald && styles.metaInfoLineEmerald]}>
                Showing the next {monthGridKeys.length} month grids — Export list includes every event.
              </Text>
      ) : null}

            {monthGridKeys.map((mk) => {
              const [yearRaw, monthRaw] = mk.split("-");
              const year = Number(yearRaw);
              const monthIndex = Number(monthRaw);
              const monthStart = new Date(year, monthIndex, 1);
              const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
              const leadingBlanks = monthStart.getDay();
              const monthLabel = monthStart.toLocaleDateString(undefined, { month: "long", year: "numeric" });
              const cells: Array<{ iso: string | null; day: number | null }> = [];
              for (let i = 0; i < leadingBlanks; i += 1) cells.push({ iso: null, day: null });
              for (let day = 1; day <= daysInMonth; day += 1) {
                const iso = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
                cells.push({ iso, day });
              }
              while (cells.length % 7 !== 0) cells.push({ iso: null, day: null });

              return (
                <View key={`month-${mk}`} style={[styles.controlsCard, isMidnight && styles.controlsCardMidnight, isNeo && styles.controlsCardNeo, isVitaria && styles.controlsCardVitaria, isInferno && styles.controlsCardInferno, isEmerald && styles.controlsCardEmerald]}>
                  <Text style={[styles.sectionTitle, isMinera && styles.sectionTitleMinera, isMidnight && styles.sectionTitleMidnight, isNeo && styles.sectionTitleNeo, isVitaria && styles.sectionTitleVitaria, isInferno && styles.sectionTitleInferno, isEmerald && styles.sectionTitleEmerald]}>
                    {monthLabel}
                  </Text>
                  <View style={styles.calendarWeekRow}>
                    {CALENDAR_WEEKDAYS.map((d) => (
                      <Text key={`${mk}-${d}`} style={[styles.calendarWeekday, isDarkTheme && styles.calendarWeekdayDark, isNeo && styles.calendarWeekdayNeo]}>
                        {d}
                      </Text>
                    ))}
                  </View>
                  <View style={styles.calendarGrid}>
                    {cells.map((cell, idx) => {
                      if (!cell.iso || !cell.day) return <View key={`blank-${mk}-${idx}`} style={styles.calendarDayEmpty} />;
                      const dayEvents = eventsByDate.get(cell.iso) || [];
                      const hasEvents = dayEvents.length > 0;
                      const active = activeDate === cell.iso;
                      return (
                        <Pressable
                          key={`day-${mk}-${cell.iso}`}
                          onPress={() => {
                            setSelectedCalendarDate(cell.iso || "");
                            if (hasEvents && cell.iso) setSelectedCalendarModalDate(cell.iso);
                          }}
                          style={[
                            styles.calendarDay,
                            hasEvents && styles.calendarDayHasEvents,
                            active && styles.calendarDayActive,
                            isDarkTheme && hasEvents && styles.calendarDayHasEventsDark,
                            isNeo && hasEvents && styles.calendarDayHasEventsNeo,
                            hasEvents
                              ? {
                                  backgroundColor:
                                    dayEvents.length >= 5
                                      ? "rgba(244, 135, 37, 0.28)"
                                      : dayEvents.length >= 3
                                        ? "rgba(244, 135, 37, 0.20)"
                                        : "rgba(244, 135, 37, 0.13)",
                                }
                              : null,
                          ]}
                        >
                          <Text style={[styles.calendarDayText, hasEvents && styles.calendarDayTextStrong, active && styles.calendarDayTextActive, isDarkTheme && styles.calendarDayTextDark]}>
                            {cell.day}
                          </Text>
                          {hasEvents ? <View style={[styles.calendarDayDot, active && styles.calendarDayDotActive]} /> : null}
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              );
            })}

            {activeDateEvents.length ? (
              <View style={[styles.controlsCard, isMidnight && styles.controlsCardMidnight, isNeo && styles.controlsCardNeo, isVitaria && styles.controlsCardVitaria, isInferno && styles.controlsCardInferno, isEmerald && styles.controlsCardEmerald]}>
                <Text style={[styles.sectionTitle, isMinera && styles.sectionTitleMinera, isMidnight && styles.sectionTitleMidnight, isNeo && styles.sectionTitleNeo, isVitaria && styles.sectionTitleVitaria, isInferno && styles.sectionTitleInferno, isEmerald && styles.sectionTitleEmerald]}>
                  {formatHumanDate(activeDate)}
                </Text>
                {activeDateEvents.slice(0, 4).map((e, idx) => (
                  <View key={`active-day-${eventStorageKey(e)}-${idx}`} style={styles.calendarMiniRow}>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.calendarMiniTitle, isDarkTheme && styles.modalEventTitleDark, isNeo && styles.modalEventTitleNeo]} numberOfLines={1}>
                        {e.title}
                      </Text>
                      <Text style={[styles.calendarMiniMeta, isDarkTheme && styles.hospitalListMetaDark, isNeo && styles.hospitalListMetaNeo]} numberOfLines={1}>
                        {eventTime(e)} • {formatSourceLabel(e.source)}
                      </Text>
                    </View>
                    {e.event_uid ? (
                      <Pressable style={styles.roundGhostBtn} onPress={() => openCalendarExportPicker(e)}>
                        <Text style={[styles.roundGhostText, emojiFontStyle]}>📅</Text>
                      </Pressable>
                    ) : null}
                  </View>
                ))}
              </View>
            ) : null}
          </>
        ) : (
          <>
            <View style={[styles.controlsCard, isMidnight && styles.controlsCardMidnight, isNeo && styles.controlsCardNeo, isVitaria && styles.controlsCardVitaria, isInferno && styles.controlsCardInferno, isEmerald && styles.controlsCardEmerald]}>
              <Text style={[styles.sectionTitle, isMinera && styles.sectionTitleMinera, isMidnight && styles.sectionTitleMidnight, isNeo && styles.sectionTitleNeo, isVitaria && styles.sectionTitleVitaria, isInferno && styles.sectionTitleInferno, isEmerald && styles.sectionTitleEmerald]}>
                Export destination
              </Text>
              <Text style={[styles.metaInfoLine, isMinera && styles.metaInfoLineMinera, isMidnight && styles.metaInfoLineMidnight, isNeo && styles.metaInfoLineNeo, isVitaria && styles.metaInfoLineVitaria, isInferno && styles.metaInfoLineInferno, isEmerald && styles.metaInfoLineEmerald]}>
                Tap Export Calendar, then choose Apple Calendar, Google Calendar, Outlook, or More apps.
              </Text>
            </View>
      {!calendarScheduleEvents.length ? (
        <View style={styles.emptyCard}>
          <Text style={[styles.emptyText, isDarkTheme && styles.emptyTextDark, isNeo && styles.emptyTextNeo]}>No upcoming events available for export yet.</Text>
        </View>
      ) : null}
      {calendarScheduleEvents.map((e, idx) => (
        <View key={`cal-${e.event_uid || e.title}-${idx}`} style={styles.hospitalListCard}>
          {pickPoster(e.image_urls) ? (
            <Image source={{ uri: pickPoster(e.image_urls) }} style={styles.hospitalListPoster} />
          ) : (
            <View style={styles.hospitalListPoster} />
          )}
          <View style={{ flex: 1 }}>
            <Text style={styles.mapTag}>Calendar</Text>
            <Text style={[styles.hospitalListTitle, isDarkTheme && styles.hospitalListTitleDark, isNeo && styles.hospitalListTitleNeo]} numberOfLines={1}>{e.title}</Text>
            <Text style={[styles.hospitalListMeta, isDarkTheme && styles.hospitalListMetaDark, isNeo && styles.hospitalListMetaNeo]} numberOfLines={1}>
                    {formatHumanDate(e.date)} • {eventTime(e)} • {formatSourceLabel(e.source)}
            </Text>
            <View style={styles.calendarActionRow}>
              {e.event_uid ? (
                      <Pressable style={styles.darkPillBtn} onPress={() => openCalendarExportPicker(e)}>
                        <Text style={styles.darkPillBtnText}>Export Calendar</Text>
                </Pressable>
              ) : null}
              {e.source_url ? (
                <Pressable style={styles.roundGhostBtn} onPress={() => Linking.openURL(e.source_url)}>
                  <Text style={styles.roundGhostText}>↗</Text>
                </Pressable>
              ) : null}
        </View>
      </View>
        </View>
      ))}
          </>
        )}
    </ScrollView>
  );
  };

  const renderSaved = () => (
    <ScrollView ref={savedScrollRef} contentContainerStyle={[styles.scrollBody, isMidnight && styles.scrollBodyMidnight, isNeo && styles.scrollBodyNeo, isVitaria && styles.scrollBodyVitaria, isInferno && styles.scrollBodyInferno, isEmerald && styles.scrollBodyEmerald]}>
      <LinearGradient
        colors={isMidnight ? ["#0c0f19", "#151b2a"] : isNeo ? ["#d8d8d8", "#d2d2d2"] : isVitaria ? ["#8f7680", "#b3949d"] : isInferno ? ["#070607", "#1b0901"] : isEmerald ? ["#b8e5c9", "#8fd5ad"] : ["#f0f2f7", "#e8ebf3"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.premiumSectionHeader}
      >
        <Text style={[styles.premiumSectionTitle, isDarkTheme && styles.premiumSectionTitleDark, isNeo && styles.premiumSectionTitleNeo]}>Saved Events</Text>
        <Text style={[styles.premiumSectionSub, isDarkTheme && styles.premiumSectionSubDark, isNeo && styles.premiumSectionSubNeo]}>
          Your shortlist for quick follow-up and reminders.
        </Text>
      </LinearGradient>
      {!savedEvents.length ? (
        <View style={styles.emptyCard}>
          <Text style={[styles.emptyText, isDarkTheme && styles.emptyTextDark, isNeo && styles.emptyTextNeo]}>No saved events yet. Open an event and tap Save.</Text>
        </View>
      ) : null}
      {savedEvents.map((e, idx) => renderEventListCard(e, `saved-${idx}`))}
    </ScrollView>
  );

  const renderSettings = () => (
    <ScrollView contentContainerStyle={[styles.scrollBody, isMidnight && styles.scrollBodyMidnight, isNeo && styles.scrollBodyNeo, isVitaria && styles.scrollBodyVitaria, isInferno && styles.scrollBodyInferno, isEmerald && styles.scrollBodyEmerald]}>
      <LinearGradient
        colors={isMidnight ? ["#0c0f19", "#151b2a"] : isNeo ? ["#d8d8d8", "#d2d2d2"] : isVitaria ? ["#8f7680", "#b3949d"] : isInferno ? ["#070607", "#1b0901"] : isEmerald ? ["#b8e5c9", "#8fd5ad"] : ["#f0f2f7", "#e8ebf3"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.premiumSectionHeader}
      >
        <Text style={[styles.premiumSectionTitle, isDarkTheme && styles.premiumSectionTitleDark, isNeo && styles.premiumSectionTitleNeo]}>Settings</Text>
        <Text style={[styles.premiumSectionSub, isDarkTheme && styles.premiumSectionSubDark, isNeo && styles.premiumSectionSubNeo]}>
          Tune defaults and keep your feed personalized.
        </Text>
      </LinearGradient>

      <View style={[styles.controlsCard, isMidnight && styles.controlsCardMidnight, isNeo && styles.controlsCardNeo, isVitaria && styles.controlsCardVitaria, isInferno && styles.controlsCardInferno, isEmerald && styles.controlsCardEmerald]}>
        <Text style={[styles.sectionTitle, isMidnight && styles.sectionTitleMidnight, isNeo && styles.sectionTitleNeo, isVitaria && styles.sectionTitleVitaria, isInferno && styles.sectionTitleInferno, isEmerald && styles.sectionTitleEmerald]}>Discover</Text>
        <View style={{ gap: 8 }}>
          <Pressable
            style={[styles.modalActionBtn, styles.modalActionBtnPrimary, { alignSelf: "stretch" }]}
            onPress={() => setScholarScreenOpen(true)}
          >
            <Text style={styles.modalActionBtnText}>🎤  Scholars & Speakers Directory</Text>
          </Pressable>
          <Pressable
            style={[styles.modalActionBtn, styles.modalActionBtnPrimary, { alignSelf: "stretch" }]}
            onPress={() => setPassportOpen(true)}
          >
            <Text style={styles.modalActionBtnText}>📘  Masjid Passport ({passportStamps.length}/24)</Text>
          </Pressable>
          <Pressable
            style={[styles.modalActionBtn, { alignSelf: "stretch" }]}
            onPress={exportBulkCalendar}
          >
            <Text style={styles.modalActionBtnText}>📅  Export next 30 days to calendar</Text>
          </Pressable>
        </View>
      </View>

      <View style={[styles.controlsCard, isMidnight && styles.controlsCardMidnight, isNeo && styles.controlsCardNeo, isVitaria && styles.controlsCardVitaria, isInferno && styles.controlsCardInferno, isEmerald && styles.controlsCardEmerald]}>
        <Text style={[styles.sectionTitle, isMidnight && styles.sectionTitleMidnight, isNeo && styles.sectionTitleNeo, isVitaria && styles.sectionTitleVitaria, isInferno && styles.sectionTitleInferno, isEmerald && styles.sectionTitleEmerald]}>Connection</Text>
        <Text style={[styles.metaInfoLine, isMidnight && styles.metaInfoLineMidnight, isNeo && styles.metaInfoLineNeo, isVitaria && styles.metaInfoLineVitaria, isInferno && styles.metaInfoLineInferno, isEmerald && styles.metaInfoLineEmerald]}>
          API Base: {API_BASE_URL}. Set EXPO_PUBLIC_API_BASE_URL for device testing.
        </Text>
        <Text style={[styles.metaInfoLine, isMidnight && styles.metaInfoLineMidnight, isNeo && styles.metaInfoLineNeo, isVitaria && styles.metaInfoLineVitaria, isInferno && styles.metaInfoLineInferno, isEmerald && styles.metaInfoLineEmerald]}>
          Push token: {pushToken ? `${pushToken.slice(0, 18)}...` : "Not registered"}
        </Text>
        <Text style={[styles.metaInfoLine, isMidnight && styles.metaInfoLineMidnight, isNeo && styles.metaInfoLineNeo, isVitaria && styles.metaInfoLineVitaria, isInferno && styles.metaInfoLineInferno, isEmerald && styles.metaInfoLineEmerald]}>
          Weekly goal: {streakCount}/{goalCount} attended this month
        </Text>
        <Text style={[styles.metaInfoLine, isMidnight && styles.metaInfoLineMidnight, isNeo && styles.metaInfoLineNeo, isVitaria && styles.metaInfoLineVitaria, isInferno && styles.metaInfoLineInferno, isEmerald && styles.metaInfoLineEmerald]}>
          Referral code: {referralCode || "Generating..."}
        </Text>
      </View>

      <View style={[styles.controlsCard, isMidnight && styles.controlsCardMidnight, isNeo && styles.controlsCardNeo, isVitaria && styles.controlsCardVitaria, isInferno && styles.controlsCardInferno, isEmerald && styles.controlsCardEmerald]}>
        <Text style={[styles.sectionTitle, isMidnight && styles.sectionTitleMidnight, isNeo && styles.sectionTitleNeo, isVitaria && styles.sectionTitleVitaria, isInferno && styles.sectionTitleInferno, isEmerald && styles.sectionTitleEmerald]}>Default Filters</Text>
        <View style={styles.row}>
          <TextInput
            style={[styles.input, styles.half, isMidnight && styles.inputMidnight, isNeo && styles.inputNeo, isVitaria && styles.inputVitaria, isInferno && styles.inputInferno, isEmerald && styles.inputEmerald]}
            value={radius}
            onChangeText={setRadius}
            keyboardType="number-pad"
            placeholder="Radius miles"
            placeholderTextColor={inputPlaceholderColor}
          />
          <Pressable style={[styles.darkPillBtn, styles.half]} onPress={() => loadEvents({ force: true })}>
            <Text style={styles.darkPillBtnText}>Refresh Events</Text>
          </Pressable>
        </View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.sourceStrip}>
        {[
          ["all", "All"],
          ["brothers", "Brothers"],
          ["sisters", "Sisters"],
          ["family", "Family"],
        ].map(([id, label]) => {
          const active = audienceFilter === id;
          return (
            <Pressable
                key={`settings-${id}`}
              onPress={() => setAudienceFilter(id as typeof audienceFilter)}
                style={audienceChipStyle(id, active)}
            >
                <Text style={audienceChipTextStyle(id, active)}>
                  {label}
                </Text>
            </Pressable>
          );
        })}
      </ScrollView>
      </View>

      <View style={[styles.controlsCard, isMidnight && styles.controlsCardMidnight, isNeo && styles.controlsCardNeo, isVitaria && styles.controlsCardVitaria, isInferno && styles.controlsCardInferno, isEmerald && styles.controlsCardEmerald]}>
        <Text style={[styles.sectionTitle, isMidnight && styles.sectionTitleMidnight, isNeo && styles.sectionTitleNeo, isVitaria && styles.sectionTitleVitaria, isInferno && styles.sectionTitleInferno, isEmerald && styles.sectionTitleEmerald]}>App Actions</Text>
        <Text style={[styles.metaInfoLine, isMidnight && styles.metaInfoLineMidnight, isNeo && styles.metaInfoLineNeo, isVitaria && styles.metaInfoLineVitaria, isInferno && styles.metaInfoLineInferno, isEmerald && styles.metaInfoLineEmerald]}>
          Themes
        </Text>
        <View style={styles.themeButtonGrid}>
          <Pressable
            style={[styles.themeSelectBtn, isDarkTheme && styles.themeSelectBtnDark, themeMode === "minera" && styles.themeSelectBtnActive]}
            onPress={() => applyThemeMode("minera")}
          >
            <Text style={[styles.themeSelectBtnText, isDarkTheme && styles.themeSelectBtnTextDark, themeMode === "minera" && styles.themeSelectBtnTextActive]}>Light Mode</Text>
          </Pressable>
          <Pressable
            style={[styles.themeSelectBtn, isDarkTheme && styles.themeSelectBtnDark, themeMode === "inferno" && styles.themeSelectBtnActive]}
            onPress={() => applyThemeMode("inferno")}
          >
            <Text style={[styles.themeSelectBtnText, isDarkTheme && styles.themeSelectBtnTextDark, themeMode === "inferno" && styles.themeSelectBtnTextActive]}>Dark Mode</Text>
          </Pressable>
        </View>
        <View style={styles.utilityActionsWrap}>
          <Pressable style={[styles.utilityActionBtn, isDarkTheme && styles.utilityActionBtnDark]} onPress={() => setEntryScreen("welcome")}>
            <Text style={[styles.utilityActionBtnText, isDarkTheme && styles.utilityActionBtnTextDark]}>View Intro Screen</Text>
                </Pressable>
          <Pressable style={[styles.utilityActionBtn, isDarkTheme && styles.utilityActionBtnDark]} onPress={() => switchTab("calendar")}>
            <Text style={[styles.utilityActionBtnText, isDarkTheme && styles.utilityActionBtnTextDark]}>Open Calendar Exports</Text>
          </Pressable>
          <Pressable style={[styles.utilityActionBtn, isDarkTheme && styles.utilityActionBtnDark]} onPress={clearSavedEvents}>
            <Text style={[styles.utilityActionBtnText, isDarkTheme && styles.utilityActionBtnTextDark]}>Clear Saved</Text>
          </Pressable>
          <Pressable
            style={[styles.utilityActionBtn, isDarkTheme && styles.utilityActionBtnDark]}
            onPress={() =>
              Share.share({
                title: "Invite to Masjidly",
                message: `Join me on Masjidly for local masjid events. Use my code ${referralCode}. https://masjidly.app/invite/${referralCode}`,
              })
            }
          >
            <Text style={[styles.utilityActionBtnText, isDarkTheme && styles.utilityActionBtnTextDark]}>Invite a Friend</Text>
          </Pressable>
          <Pressable
            style={[styles.utilityActionBtn, isDarkTheme && styles.utilityActionBtnDark]}
            onPress={loadModerationQueue}
          >
            <Text style={[styles.utilityActionBtnText, isDarkTheme && styles.utilityActionBtnTextDark]}>Open Moderation Queue</Text>
          </Pressable>
                </View>
              </View>
    </ScrollView>
  );

  const renderPlaceholder = (title: string, subtitle: string) => (
    <View style={styles.placeholderWrap}>
      <Text style={styles.placeholderTitle}>{title}</Text>
      <Text style={styles.placeholderSub}>{subtitle}</Text>
    </View>
  );

  // Cache the heavy scenes so tapping a tab doesn't force React to rebuild
  // the MapView + marker list or the month grid. They only rebuild when their
  // real inputs change (events, filters, theme, RSVP/save state, etc.).
  const exploreSceneNode = useMemo(
    () => renderExplore(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      exploreSections,
      masjidPinsForExplore,
      mapRegion,
      exploreMapHeight,
      audienceFilter,
      savedEventsMap,
      rsvpStatuses,
      themeMode,
      halaqaFilter,
      eventSeries,
      followedMasjids,
    ]
  );
  const calendarSceneNode = useMemo(
    () => renderCalendar(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      calendarScheduleEvents,
      calendarView,
      selectedCalendarDate,
      themeMode,
    ]
  );
  const savedSceneNode = useMemo(
    () => renderSaved(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [savedEvents, savedEventsMap, rsvpStatuses, themeMode]
  );

  const renderTabScene = (sceneTab: "home" | "explore" | "calendar" | "saved" | "settings") => {
    if (sceneTab === "home") return renderHome();
    if (sceneTab === "explore") return exploreSceneNode;
    if (sceneTab === "calendar") return calendarSceneNode;
    if (sceneTab === "saved") return savedSceneNode;
    return renderSettings();
  };

  if (entryScreen === "welcome") return renderWelcomeScreen();
  if (entryScreen === "onboarding") return renderProfileCaptureScreen();
  if (entryScreen === "launch") return renderLaunchScreen();

  return (
    <SafeAreaView style={[styles.container, isMidnight && styles.containerMidnight, isNeo && styles.containerNeo, isVitaria && styles.containerVitaria, isInferno && styles.containerInferno, isEmerald && styles.containerEmerald]}>
      <StatusBar style={isMidnight || isVitaria || isInferno ? "light" : "dark"} />
      {tab === "home" ? (
      <View style={[styles.topBar, isMidnight && styles.topBarMidnight, isNeo && styles.topBarNeo, isVitaria && styles.topBarVitaria, isInferno && styles.topBarInferno, isEmerald && styles.topBarEmerald]}>
        <View style={styles.topBarBrandRow}>
            <Image source={TOPBAR_WORDMARK} style={styles.topBarWordmark} resizeMode="cover" />
          </View>
        </View>
      ) : null}

      <View style={styles.tabSceneWrap}>
        {(["home", "explore", "calendar", "saved", "settings"] as const).map((id) => {
          if (!mountedTabs.has(id)) return null;
          const isActive = tab === id;
          return (
            <View
              key={`tab-scene-${id}`}
              style={[
                StyleSheet.absoluteFillObject,
                { display: isActive ? "flex" : "none" },
              ]}
              pointerEvents={isActive ? "auto" : "none"}
            >
              {renderTabScene(id)}
            </View>
          );
        })}
      </View>

      <View style={[styles.tabBar, isMidnight && styles.tabBarMidnight, isNeo && styles.tabBarNeo, isVitaria && styles.tabBarVitaria, isInferno && styles.tabBarInferno, isEmerald && styles.tabBarEmerald]}>
        {[
          ["home", "⌂", "Home"],
          ["explore", "◉", "Explore"],
          ["calendar", "◷", "Calendar"],
          ["saved", "♡", "Saved"],
          ["settings", "☰", "Settings"],
        ].map(([id, icon, label]) => (
          <Pressable
            key={id}
            hitSlop={4}
            style={({ pressed }) => [
              styles.tabBtn,
              tab === id && styles.tabBtnActive,
              isMidnight && tab === id && styles.tabBtnActiveMidnight,
              isNeo && tab === id && styles.tabBtnActiveNeo,
              isVitaria && tab === id && styles.tabBtnActiveVitaria,
              isInferno && tab === id && styles.tabBtnActiveInferno,
              isEmerald && tab === id && styles.tabBtnActiveEmerald,
              pressed && { opacity: 0.55 },
            ]}
            onPressIn={() => {
              if (tab !== id) switchTab(id as typeof tab);
            }}
          >
            <Text
              style={[
                styles.tabIcon,
                isMidnight && styles.tabIconMidnight,
                isNeo && styles.tabIconNeo,
                isVitaria && styles.tabIconVitaria,
                isInferno && styles.tabIconInferno,
                isEmerald && styles.tabIconEmerald,
                tab === id && styles.tabIconActive,
                isInferno && tab === id && styles.tabIconActiveInferno,
                isEmerald && tab === id && styles.tabIconActiveEmerald,
                id === "saved" && emojiFontStyle,
              ]}
            >
              {icon}
            </Text>
            <Text style={[styles.tabText, isMidnight && styles.tabTextMidnight, isNeo && styles.tabTextNeo, isVitaria && styles.tabTextVitaria, isInferno && styles.tabTextInferno, isEmerald && styles.tabTextEmerald, tab === id && styles.tabTextActive, isInferno && tab === id && styles.tabTextActiveInferno, isEmerald && tab === id && styles.tabTextActiveEmerald]}>{label}</Text>
          </Pressable>
        ))}
      </View>

      <Modal
        visible={!!selectedEvent}
        animationType="slide"
        presentationStyle="fullScreen"
        statusBarTranslucent={false}
        onRequestClose={() => setSelectedEvent(null)}
      >
        {selectedEvent ? (() => {
          const ev = selectedEvent;
          const rsvpKey = eventStorageKey(ev);
          const rsvpState = rsvpStatuses[rsvpKey];
          const saved = isSavedEvent(ev);
          const isFollowed = followedMasjids.includes(ev.source);
          const audience = inferAudience(ev);
          const poster = pickPoster(ev.image_urls);
          const speaker =
            ev.speaker ||
            inferSpeakerFromText(`${ev.poster_ocr_text || ""} ${ev.description || ""} ${ev.raw_text || ""}`);
          const locationParts = [ev.location_name, ev.address].filter(Boolean);
          const brandColor = masjidBrandColor(ev.source);
          const descRaw = normalizeText((ev.description || "").replace(/<[^>]+>/g, " "));
          const explanation = buildEventExplanation(ev);
          const descToShow = descRaw || explanation;
          const descIsLong = descToShow.length > 220;
          const descShown = !descIsLong || showFullDescription ? descToShow : `${descToShow.slice(0, 220).trim()}…`;
          const conf = getEventConfidence(ev);
          const transparency = transparencyLabel(ev);
          const recurring = recurringProgramLabel(ev);
          const shareEv = () =>
            Share.share({
              title: ev.title,
              message: `${ev.title} • ${formatHumanDate(ev.date)} ${ev.deep_link?.web || ev.source_url || ""}`,
            });
          const feedbackState = feedbackResponses[rsvpKey];
          return (
            <View style={[styles.eventModalContainer, isDarkTheme && styles.eventModalContainerDark]}>
              <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ paddingBottom: insets.bottom + 140 }}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
              >
                <View style={[styles.eventHero, { height: Math.min(windowHeight * 0.5, 420) }]}>
                  {poster ? (
                    <Image source={{ uri: poster }} style={StyleSheet.absoluteFillObject} resizeMode="cover" blurRadius={0} />
                  ) : (
                    <View style={[StyleSheet.absoluteFillObject, { backgroundColor: brandColor }]} />
                  )}
                  <LinearGradient
                    colors={["rgba(0,0,0,0.45)", "rgba(0,0,0,0)", "rgba(0,0,0,0.85)"]}
                    locations={[0, 0.35, 1]}
                    style={StyleSheet.absoluteFillObject}
                  />
                  <View style={[styles.eventHeroTopRow, { paddingTop: insets.top + 10 }]}>
                    <Pressable
                      style={styles.eventHeroIconBtn}
                      hitSlop={10}
                      onPress={() => setSelectedEvent(null)}
                    >
                      <Text style={styles.eventHeroIconText}>✕</Text>
                    </Pressable>
                    <View style={{ flex: 1 }} />
                    <Pressable
                      style={[styles.eventHeroIconBtn, saved && styles.eventHeroIconBtnActive]}
                      hitSlop={10}
                      onPress={() => toggleSavedEvent(ev)}
                    >
                      <Text style={styles.eventHeroIconText}>{saved ? "♥" : "♡"}</Text>
                    </Pressable>
                    <Pressable style={styles.eventHeroIconBtn} hitSlop={10} onPress={shareEv}>
                      <Text style={styles.eventHeroIconText}>↗</Text>
            </Pressable>
          </View>
                  <View style={styles.eventHeroBottom}>
                    <View style={styles.eventHeroChipRow}>
                      <View style={[styles.eventHeroSourceChip, { backgroundColor: brandColor }]}>
                        <Text style={styles.eventHeroSourceInitials}>{masjidInitials(ev.source)}</Text>
                </View>
                      <Text style={styles.eventHeroSourceLabel} numberOfLines={1}>
                        {formatSourceLabel(ev.source)}
              </Text>
                      {audience ? (
                        <View style={styles.eventHeroAudienceChip}>
                          <Text style={styles.eventHeroAudienceText}>{audience}</Text>
                        </View>
                      ) : null}
                    </View>
                    <Text style={styles.eventHeroTitle} numberOfLines={3}>{ev.title}</Text>
                  </View>
                </View>

                <View style={[styles.eventWhenCard, isDarkTheme && styles.eventWhenCardDark]}>
                  <View style={styles.eventWhenRow}>
                    <Text style={styles.eventWhenIcon}>📅</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.eventWhenPrimary, isDarkTheme && { color: "#f4f7ff" }]}>
                        {formatHumanDate(ev.date)}
                </Text>
                      <Text style={[styles.eventWhenSecondary, isDarkTheme && { color: "#c4cee8" }]}>
                        {eventTime(ev) || "Time TBA"}
                        {recurring ? ` · ${recurring}` : ""}
                      </Text>
                    </View>
                    {ev.event_uid ? (
                      <Pressable
                        style={[styles.eventWhenAddBtn, isDarkTheme && styles.eventWhenAddBtnDark]}
                        onPress={() => openCalendarExportPicker(ev)}
                      >
                        <Text style={[styles.eventWhenAddText, isDarkTheme && { color: "#f4f7ff" }]}>+ Calendar</Text>
                      </Pressable>
              ) : null}
                  </View>
                </View>

                <View style={styles.eventSection}>
                  <Text style={[styles.eventSectionLabel, isDarkTheme && { color: "#c4cee8" }]}>Will you attend?</Text>
                  <View style={styles.eventRsvpRow}>
                    <Pressable
                      style={[
                        styles.eventRsvpPill,
                        rsvpState === "going" && styles.eventRsvpPillGoing,
                        isDarkTheme && !rsvpState && styles.eventRsvpPillDark,
                      ]}
                      onPress={() => setRsvpStatus(ev, "going")}
                    >
                      <Text
                        style={[
                          styles.eventRsvpPillText,
                          rsvpState === "going" && styles.eventRsvpPillTextActive,
                          isDarkTheme && !rsvpState && { color: "#f4f7ff" },
                        ]}
                      >
                        {rsvpState === "going" ? "✓ Going" : "Going"}
              </Text>
                    </Pressable>
                <Pressable
                  style={[
                        styles.eventRsvpPill,
                        rsvpState === "interested" && styles.eventRsvpPillInterested,
                        isDarkTheme && !rsvpState && styles.eventRsvpPillDark,
                      ]}
                      onPress={() => setRsvpStatus(ev, "interested")}
                    >
                      <Text
                        style={[
                          styles.eventRsvpPillText,
                          rsvpState === "interested" && styles.eventRsvpPillTextActive,
                          isDarkTheme && !rsvpState && { color: "#f4f7ff" },
                        ]}
                      >
                        {rsvpState === "interested" ? "✓ Interested" : "Interested"}
                  </Text>
                </Pressable>
                  </View>
                  {ev.rsvp_link ? (
                  <Pressable
                      style={[styles.eventRsvpLinkBtn, isDarkTheme && styles.eventRsvpLinkBtnDark]}
                      onPress={() => Linking.openURL(ev.rsvp_link)}
                  >
                      <Text style={[styles.eventRsvpLinkText, isDarkTheme && { color: "#9fc6ff" }]}>Official RSVP →</Text>
                  </Pressable>
                ) : null}
                </View>

                {/* #18 Attendees + #12 Invite friends */}
                <View style={[styles.eventInfoCard, isDarkTheme && styles.eventInfoCardDark]}>
                  <Text style={styles.eventInfoIcon}>👥</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.eventInfoTitle, isDarkTheme && { color: "#f4f7ff" }]}>
                      {(ev.attendees?.going || 0) > 0
                        ? `${ev.attendees?.going} going${(ev.attendees?.interested || 0) > 0 ? ` · ${ev.attendees?.interested} interested` : ""}`
                        : "Be the first from your circle"}
                    </Text>
                    <Text style={[styles.eventInfoSub, isDarkTheme && { color: "#c4cee8" }]}>
                      Invite a friend — one tap sends them the poster & seat link.
                    </Text>
                  </View>
                  <Pressable
                    style={styles.eventInviteBtn}
                    hitSlop={8}
                    onPress={() => inviteFriendsToEvent(ev)}
                  >
                    <Text style={styles.eventInviteBtnText}>Bring a friend</Text>
                  </Pressable>
                </View>

                {locationParts.length ? (
                  <Pressable
                    style={[styles.eventInfoCard, isDarkTheme && styles.eventInfoCardDark]}
                    disabled={!ev.map_link}
                    onPress={() => ev.map_link && Linking.openURL(ev.map_link)}
                  >
                    <Text style={styles.eventInfoIcon}>📍</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.eventInfoTitle, isDarkTheme && { color: "#f4f7ff" }]} numberOfLines={1}>
                        {locationParts[0]}
                      </Text>
                      {locationParts[1] ? (
                        <Text style={[styles.eventInfoSub, isDarkTheme && { color: "#c4cee8" }]} numberOfLines={2}>
                          {locationParts[1]}
                        </Text>
                      ) : null}
                      {(() => {
                        const coords = MASJID_COORDS[ev.source];
                        const homeLat = profileDraft.home_lat ?? null;
                        const homeLon = profileDraft.home_lon ?? null;
                        if (coords && typeof homeLat === "number" && typeof homeLon === "number") {
                          const miles = haversineMiles(homeLat, homeLon, coords.latitude, coords.longitude);
                          const mins = estimateDriveMinutes(miles);
                          return (
                            <Text style={[styles.eventInfoSub, { color: "#4a3bb0", fontWeight: "700", marginTop: 2 }]}>
                              ≈ {mins} min drive · {miles.toFixed(1)} mi from home
                            </Text>
                          );
                        }
                        return null;
                      })()}
                    </View>
                    {ev.map_link ? <Text style={styles.eventInfoChevron}>›</Text> : null}
                  </Pressable>
                ) : null}

                {/* #40 Community corrections */}
                {(ev.correction?.flagged || ev.correction?.verified) ? (
                  <View
                    style={[
                      styles.eventInfoCard,
                      isDarkTheme && styles.eventInfoCardDark,
                      {
                        backgroundColor: ev.correction?.flagged ? "#fff3ea" : "#edf9f1",
                        borderColor: ev.correction?.flagged ? "#f2c6a8" : "#b8e1c6",
                        borderWidth: 1,
                      },
                    ]}
                  >
                    <Text style={styles.eventInfoIcon}>{ev.correction?.flagged ? "⚠" : "✓"}</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.eventInfoTitle, { color: ev.correction?.flagged ? "#9a4311" : "#1f7a42" }]}>
                        {ev.correction?.flagged ? "Community flagged" : "Community verified"}
                      </Text>
                      <Text style={[styles.eventInfoSub, { color: ev.correction?.flagged ? "#8a5e3a" : "#3a7a54" }]}>
                        {ev.correction?.flagged
                          ? `Reported by multiple users — details may be inaccurate. ${ev.correction?.open_reports || 0} open report(s).`
                          : `Confirmed by ${ev.correction?.score || 0} community members.`}
                      </Text>
                    </View>
                  </View>
                ) : null}

                {/* #21 Post-event reflection prompt */}
                {(() => {
                  const yest = new Date();
                  yest.setDate(yest.getDate() - 1);
                  const yestIso = yest.toISOString().slice(0, 10);
                  const evDate = ev.date || "";
                  const didRsvp = rsvpState === "going" || rsvpState === "interested";
                  if (!evDate || evDate > yestIso || !didRsvp) return null;
                  return (
                    <View style={[styles.eventInfoCard, { backgroundColor: "#f0eefb", borderWidth: 1, borderColor: "#d9d4f0" }]}>
                      <Text style={styles.eventInfoIcon}>💭</Text>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.eventInfoTitle, { color: "#3a2f7f" }]}>How was it?</Text>
                        <Text style={[styles.eventInfoSub, { color: "#5c4fa8" }]}>
                          Share one benefit so other attendees can see. 2–3 taps, private name.
                        </Text>
                      </View>
                      <Pressable
                        style={styles.eventInviteBtn}
                        onPress={() => openReflectionPrompt(ev)}
                      >
                        <Text style={styles.eventInviteBtnText}>Reflect</Text>
                      </Pressable>
                    </View>
                  );
                })()}

                {speaker ? (
                  <View style={[styles.eventInfoCard, isDarkTheme && styles.eventInfoCardDark]}>
                    <Text style={styles.eventInfoIcon}>🎤</Text>
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.eventInfoTitle, isDarkTheme && { color: "#f4f7ff" }]} numberOfLines={2}>{speaker}</Text>
                      <Text style={[styles.eventInfoSub, isDarkTheme && { color: "#c4cee8" }]}>Speaker</Text>
              </View>
                  </View>
                ) : null}

                {descToShow ? (
                  <View style={styles.eventSection}>
                    <Text style={[styles.eventSectionLabel, isDarkTheme && { color: "#c4cee8" }]}>About</Text>
                    <Text style={[styles.eventDescText, isDarkTheme && { color: "#e4ebf7" }]}>{descShown}</Text>
                    {descIsLong ? (
                      <Pressable onPress={() => setShowFullDescription((v) => !v)} hitSlop={6}>
                        <Text style={[styles.eventDescToggle, isDarkTheme && { color: "#9fc6ff" }]}>
                          {showFullDescription ? "Show less" : "Read more"}
                        </Text>
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}

                  <Pressable
                  style={[styles.eventMasjidCard, isDarkTheme && styles.eventMasjidCardDark]}
                  onPress={() => setSelectedMasjidProfile(ev.source)}
                >
                  <View style={[styles.eventMasjidLogo, { backgroundColor: brandColor }]}>
                    <Text style={styles.eventMasjidLogoText}>{masjidInitials(ev.source)}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.eventMasjidName, isDarkTheme && { color: "#f4f7ff" }]} numberOfLines={1}>
                      {formatSourceLabel(ev.source)}
                    </Text>
                    <Text style={[styles.eventMasjidSub, isDarkTheme && { color: "#c4cee8" }]}>Tap to view masjid profile</Text>
                  </View>
                  <Pressable
                    style={[styles.eventFollowBtn, isFollowed && styles.eventFollowBtnActive]}
                    hitSlop={8}
                    onPress={(e) => {
                      e.stopPropagation?.();
                      toggleFollowMasjid(ev.source);
                    }}
                  >
                    <Text style={[styles.eventFollowBtnText, isFollowed && styles.eventFollowBtnTextActive]}>
                      {isFollowed ? "Following" : "+ Follow"}
                    </Text>
                  </Pressable>
                </Pressable>

                {(ev.source_url || ev.deep_link?.web || ev.map_link) ? (
                  <View style={styles.eventLinksRow}>
                    {ev.source_url ? (
                      <Pressable
                        style={[styles.eventLinkTile, isDarkTheme && styles.eventLinkTileDark]}
                        onPress={() => Linking.openURL(ev.source_url)}
                      >
                        <Text style={styles.eventLinkIcon}>🌐</Text>
                        <Text style={[styles.eventLinkLabel, isDarkTheme && { color: "#f4f7ff" }]}>Event page</Text>
                  </Pressable>
                ) : null}
                    {ev.deep_link?.web ? (
                  <Pressable
                        style={[styles.eventLinkTile, isDarkTheme && styles.eventLinkTileDark]}
                        onPress={() => Linking.openURL(ev.deep_link?.web || "")}
                  >
                        <Text style={styles.eventLinkIcon}>🔗</Text>
                        <Text style={[styles.eventLinkLabel, isDarkTheme && { color: "#f4f7ff" }]}>Open link</Text>
                  </Pressable>
                ) : null}
                    {ev.map_link ? (
                  <Pressable
                        style={[styles.eventLinkTile, isDarkTheme && styles.eventLinkTileDark]}
                        onPress={() => Linking.openURL(ev.map_link || "")}
                  >
                        <Text style={styles.eventLinkIcon}>🗺️</Text>
                        <Text style={[styles.eventLinkLabel, isDarkTheme && { color: "#f4f7ff" }]}>Directions</Text>
                  </Pressable>
                ) : null}
              </View>
                ) : null}

                <View style={[styles.eventTrustCard, isDarkTheme && styles.eventTrustCardDark]}>
                  <Text style={[styles.eventTrustLabel, isDarkTheme && { color: "#c4cee8" }]}>Confidence</Text>
                  <View style={styles.eventTrustRow}>
                    <View style={styles.eventTrustBarWrap}>
                      <View style={[styles.eventTrustBarFill, { width: `${Math.max(8, Math.min(100, conf.score))}%` }]} />
                    </View>
                    <Text style={[styles.eventTrustValue, isDarkTheme && { color: "#f4f7ff" }]}>{conf.label}</Text>
                  </View>
                  {transparency ? (
                    <Text style={[styles.eventTrustNote, isDarkTheme && { color: "#bcc6df" }]} numberOfLines={2}>
                      {transparency}
                    </Text>
                  ) : null}
                  <View style={styles.eventTrustActions}>
                    <Pressable
                      style={[styles.eventTrustChip, feedbackState === "helpful" && styles.eventTrustChipActive]}
                      onPress={() => submitFeedback(ev, "helpful")}
                    >
                      <Text style={[styles.eventTrustChipText, feedbackState === "helpful" && styles.eventTrustChipTextActive]}>👍 Helpful</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.eventTrustChip, feedbackState === "attended" && styles.eventTrustChipActive]}
                      onPress={() => submitFeedback(ev, "attended")}
                    >
                      <Text style={[styles.eventTrustChipText, feedbackState === "attended" && styles.eventTrustChipTextActive]}>✓ Attended</Text>
                    </Pressable>
                    <Pressable
                      style={[styles.eventTrustChip, feedbackState === "off" && styles.eventTrustChipActive]}
                      onPress={() => submitFeedback(ev, "off")}
                    >
                      <Text style={[styles.eventTrustChipText, feedbackState === "off" && styles.eventTrustChipTextActive]}>⚠ Info off</Text>
                    </Pressable>
                  </View>
                </View>

                <Pressable
                  style={styles.eventReportToggle}
                  onPress={() => setShowReportSection((v) => !v)}
                  hitSlop={6}
                >
                  <Text style={[styles.eventReportToggleText, isDarkTheme && { color: "#9db0db" }]}>
                    {showReportSection ? "Hide report form" : "Something wrong with this event? Report it"}
                  </Text>
                </Pressable>

                {showReportSection ? (
                  <View style={[styles.eventReportCard, isDarkTheme && styles.eventReportCardDark]}>
                    <Text style={[styles.eventReportLabel, isDarkTheme && { color: "#c4cee8" }]}>What's incorrect?</Text>
                    <View style={styles.eventReportChipRow}>
                      {[["time", "Time"], ["location", "Location"], ["category", "Category"]].map(([id, label]) => (
                        <Pressable
                          key={`rep-${id}`}
                          style={[styles.eventReportChip, reportIssueType === id && styles.eventReportChipActive, isDarkTheme && !reportIssueType.startsWith(id) && styles.eventReportChipDark]}
                          onPress={() => setReportIssueType(id)}
                        >
                          <Text style={[styles.eventReportChipText, reportIssueType === id && styles.eventReportChipTextActive]}>{label}</Text>
                        </Pressable>
                      ))}
                    </View>
                    <TextInput
                      style={[styles.eventReportInput, isDarkTheme && styles.eventReportInputDark]}
                      value={reportDetails}
                      onChangeText={setReportDetails}
                      placeholder="Suggest a fix (optional)"
                      placeholderTextColor={isDarkTheme ? "#7c89a8" : "#8a95ac"}
                      multiline
                    />
                    <Pressable style={styles.eventReportSubmitBtn} onPress={submitCommunityCorrection}>
                      <Text style={styles.eventReportSubmitText}>Submit correction</Text>
                    </Pressable>
                  </View>
              ) : null}
            </ScrollView>

              <View style={[styles.eventStickyFooter, { paddingBottom: Math.max(insets.bottom, 10) }, isDarkTheme && styles.eventStickyFooterDark]}>
                <Pressable
                  style={[styles.eventStickySaveBtn, saved && styles.eventStickySaveBtnActive]}
                  onPress={() => toggleSavedEvent(ev)}
                >
                  <Text style={[styles.eventStickySaveText, saved && styles.eventStickySaveTextActive]}>
                    {saved ? "♥" : "♡"}
                  </Text>
                </Pressable>
                <Pressable
                  style={styles.eventStickyPrimaryBtn}
                  onPress={() => {
                    if (ev.rsvp_link) {
                      Linking.openURL(ev.rsvp_link);
                    } else {
                      setRsvpStatus(ev, rsvpState === "going" ? "interested" : "going");
                    }
                  }}
                >
                  <Text style={styles.eventStickyPrimaryText}>
                    {ev.rsvp_link ? "RSVP" : rsvpState === "going" ? "You're going ✓" : "I'm going"}
                  </Text>
                </Pressable>
                <Pressable style={styles.eventStickyShareBtn} onPress={shareEv}>
                  <Text style={styles.eventStickyShareText}>↗</Text>
                </Pressable>
              </View>
            </View>
          );
        })() : null}
      </Modal>
      <Modal
        visible={!!selectedCalendarModalDate}
        transparent
        animationType="slide"
        onRequestClose={() => setSelectedCalendarModalDate("")}
      >
        <View style={styles.bottomSheetBackdrop}>
          <Pressable style={StyleSheet.absoluteFillObject} onPress={() => setSelectedCalendarModalDate("")} />
          <View
            style={[
              styles.bottomSheetCard,
              { maxHeight: Math.round(windowHeight * 0.88), paddingBottom: insets.bottom + 16 },
              isDarkTheme && styles.bottomSheetCardDark,
              isNeo && styles.bottomSheetCardNeo,
            ]}
          >
            <View style={styles.bottomSheetHandle} />
            <View style={styles.bottomSheetHeader}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.bottomSheetTitle, isDarkTheme && styles.bottomSheetTitleDark]}>
                  {formatHumanDate(selectedCalendarModalDate || todayIso())}
                </Text>
                <Text style={[styles.bottomSheetSub, isDarkTheme && styles.bottomSheetSubDark]}>
                  {calendarModalEvents.length} event{calendarModalEvents.length === 1 ? "" : "s"}
                </Text>
              </View>
              <Pressable hitSlop={12} onPress={() => setSelectedCalendarModalDate("")} style={styles.bottomSheetCloseBtn}>
                <Text style={styles.bottomSheetCloseText}>✕</Text>
              </Pressable>
            </View>
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{ gap: 14, paddingTop: 12 }}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator
            >
              {calendarModalEvents.length === 0 ? (
                <View style={{ alignItems: "center", paddingVertical: 24, gap: 12 }}>
                  <Text style={[styles.bottomSheetTitle, isDarkTheme && styles.bottomSheetTitleDark]}>No events today</Text>
                  <Text style={[styles.bottomSheetSub, { textAlign: "center" }, isDarkTheme && styles.bottomSheetSubDark]}>
                    Check another day or explore upcoming events.
                  </Text>
                  <Pressable
                    style={styles.exploreEmptyBtn}
                    onPress={() => {
                      setSelectedCalendarModalDate("");
                      switchTab("explore");
                    }}
                  >
                    <Text style={styles.exploreEmptyBtnText}>Browse all events</Text>
                  </Pressable>
                </View>
              ) : (
                calendarModalEvents.map((e, idx) => {
                  const key = eventStorageKey(e);
                  const rsvpState = rsvpStatuses[key];
                  const saved = isSavedEvent(e);
                  const poster = pickPoster(e.image_urls);
                  return (
                    <Pressable
                      key={`day-modal-${key}-${idx}`}
                      style={[styles.calendarDayEventCard, isDarkTheme && styles.calendarDayEventCardDark]}
                      onPress={() => setSelectedEvent(e)}
                    >
                      {poster ? (
                        <Image source={{ uri: poster }} style={styles.calendarDayEventPoster} resizeMode="cover" />
                      ) : (
                        <View style={[styles.calendarDayEventPoster, styles.calendarDayEventPosterEmpty]}>
                          <Text style={[styles.calendarDayEventPosterEmptyText, emojiFontStyle]}>🕌</Text>
                        </View>
                      )}
                      <View style={{ padding: 12, gap: 6 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <Text style={styles.mapTag}>{inferAudience(e)}</Text>
                          <Text style={[styles.bottomSheetSub, isDarkTheme && styles.bottomSheetSubDark]}>
                            {eventTime(e)} · {formatSourceLabel(e.source)}
                          </Text>
                        </View>
                        <Text style={[styles.calendarDayEventTitle, isDarkTheme && { color: "#f4f7ff" }]} numberOfLines={2}>
                          {e.title}
                        </Text>
                        <View style={styles.cardActionRow}>
                          <Pressable
                            hitSlop={6}
                            style={[styles.cardActionChip, rsvpState === "going" && styles.cardActionChipActive]}
                            onPress={(ev) => { ev.stopPropagation?.(); toggleRsvp(e, "going"); }}
                          >
                            <Text style={[styles.cardActionChipText, rsvpState === "going" && styles.cardActionChipTextActive]}>
                              {rsvpState === "going" ? "Going ✓" : "Going"}
                            </Text>
                          </Pressable>
                          <Pressable
                            hitSlop={6}
                            style={[styles.cardActionChip, rsvpState === "interested" && styles.cardActionChipActive]}
                            onPress={(ev) => { ev.stopPropagation?.(); toggleRsvp(e, "interested"); }}
                          >
                            <Text style={[styles.cardActionChipText, rsvpState === "interested" && styles.cardActionChipTextActive]}>
                              {rsvpState === "interested" ? "Interested ✓" : "Interested"}
                            </Text>
                          </Pressable>
                          <Pressable
                            hitSlop={6}
                            style={[styles.cardActionChip, saved && styles.cardActionChipActive]}
                            onPress={(ev) => { ev.stopPropagation?.(); toggleSavedEvent(e); }}
                          >
                            <Text style={[styles.cardActionChipText, saved && styles.cardActionChipTextActive, emojiFontStyle]}>
                              {saved ? "♥" : "♡"}
                            </Text>
                          </Pressable>
                          <Pressable
                            hitSlop={6}
                            style={styles.cardActionChip}
                            onPress={(ev) => { ev.stopPropagation?.(); shareEvent(e); }}
                          >
                            <Text style={[styles.cardActionChipText, emojiFontStyle]}>↗</Text>
                          </Pressable>
                          {e.event_uid ? (
                            <Pressable
                              hitSlop={6}
                              style={styles.cardActionChip}
                              onPress={(ev) => { ev.stopPropagation?.(); openCalendarExportPicker(e); }}
                            >
                              <Text style={[styles.cardActionChipText, emojiFontStyle]}>📅</Text>
                            </Pressable>
          ) : null}
                        </View>
                      </View>
                    </Pressable>
                  );
                })
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>
      <Modal
        visible={!!selectedMasjidProfile}
        animationType="slide"
        presentationStyle="fullScreen"
        statusBarTranslucent={false}
        onRequestClose={() => setSelectedMasjidProfile("")}
      >
        <View
          style={[
            styles.modalContainer,
            isMidnight && styles.modalContainerMidnight,
            isNeo && styles.modalContainerNeo,
            isVitaria && styles.modalContainerVitaria,
            isInferno && styles.modalContainerInferno,
            isEmerald && styles.modalContainerEmerald,
            { flex: 1, paddingTop: modalChromeTopPad },
          ]}
        >
          <View style={[styles.modalTop, isMidnight && styles.modalTopMidnight, isNeo && styles.modalTopNeo, isVitaria && styles.modalTopVitaria, isInferno && styles.modalTopInferno, isEmerald && styles.modalTopEmerald]}>
            <Text
              style={[styles.modalTitle, isMidnight && styles.modalTitleMidnight, isNeo && styles.modalTitleNeo, isVitaria && styles.modalTitleVitaria, isInferno && styles.modalTitleInferno, isEmerald && styles.modalTitleEmerald]}
              numberOfLines={1}
            >
              {formatSourceLabel(selectedMasjidProfile)}
            </Text>
            <Pressable style={styles.modalCloseBtn} hitSlop={12} onPress={() => setSelectedMasjidProfile("")}>
              <Text style={styles.modalCloseText}>Close</Text>
            </Pressable>
          </View>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={[styles.modalBody, { paddingBottom: insets.bottom + 40 }]}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.modalActionsRow}>
              <Pressable style={[styles.modalActionBtn, styles.modalActionBtnPrimary]} onPress={() => toggleFollowMasjid(selectedMasjidProfile)}>
                <Text style={styles.modalActionBtnText}>
                  {followedMasjids.includes(selectedMasjidProfile) ? "Following masjid" : "Follow masjid"}
                </Text>
              </Pressable>
              {masjidProfileEvents[0]?.source_url ? (
                <Pressable style={styles.modalActionBtn} onPress={() => Linking.openURL(masjidProfileEvents[0].source_url)}>
                  <Text style={styles.modalActionBtnText}>Contact / website</Text>
                </Pressable>
              ) : null}
              {masjidProfileEvents[0]?.map_link ? (
                <Pressable style={styles.modalActionBtn} onPress={() => Linking.openURL(masjidProfileEvents[0].map_link || "")}>
                  <Text style={styles.modalActionBtnText}>Prayer schedule link</Text>
                </Pressable>
              ) : null}
              <Pressable style={[styles.modalActionBtn, { backgroundColor: "#eaf7ef" }]} onPress={() => stampPassport(selectedMasjidProfile)}>
                <Text style={[styles.modalActionBtnText, { color: "#1f7a42" }]}>+ Passport stamp</Text>
              </Pressable>
            </View>

            {(() => {
              const iq = iqamaBySource[selectedMasjidProfile];
              const prayers = ["fajr", "dhuhr", "asr", "maghrib", "isha"] as const;
              if (!iq) return null;
              const anySet = prayers.some((p) => iq[p]?.iqama);
              const jumuah = iq["jumuah"]?.jumuah_times || [];
              if (!anySet && !jumuah.length) return null;
              return (
                <View style={styles.iqamaCard}>
                  <Text style={styles.iqamaTitle}>Iqama times</Text>
                  <View style={styles.iqamaRow}>
                    {prayers.map((p) => (
                      <View key={p} style={styles.iqamaCell}>
                        <Text style={styles.iqamaPrayer}>{p[0].toUpperCase() + p.slice(1)}</Text>
                        <Text style={styles.iqamaTime}>{iq[p]?.iqama || "—"}</Text>
                      </View>
                    ))}
                  </View>
                  {jumuah.length ? (
                    <Text style={styles.iqamaJumuah}>Jumu'ah: {jumuah.join("  ·  ")}</Text>
                  ) : null}
                </View>
              );
            })()}
            {masjidProfileEvents.slice(0, 15).map((e, idx) => renderEventListCard(e, `masjid-profile-${idx}`))}
          </ScrollView>
        </View>
      </Modal>
      <Modal
        visible={showModerationQueue}
        animationType="slide"
        presentationStyle="fullScreen"
        statusBarTranslucent={false}
        onRequestClose={() => setShowModerationQueue(false)}
      >
        <View
          style={[
            styles.modalContainer,
            isMidnight && styles.modalContainerMidnight,
            isNeo && styles.modalContainerNeo,
            isVitaria && styles.modalContainerVitaria,
            isInferno && styles.modalContainerInferno,
            isEmerald && styles.modalContainerEmerald,
            { flex: 1, paddingTop: modalChromeTopPad },
          ]}
        >
          <View style={[styles.modalTop, isMidnight && styles.modalTopMidnight, isNeo && styles.modalTopNeo, isVitaria && styles.modalTopVitaria, isInferno && styles.modalTopInferno, isEmerald && styles.modalTopEmerald]}>
            <Text
              style={[styles.modalTitle, isMidnight && styles.modalTitleMidnight, isNeo && styles.modalTitleNeo, isVitaria && styles.modalTitleVitaria, isInferno && styles.modalTitleInferno, isEmerald && styles.modalTitleEmerald]}
              numberOfLines={1}
            >
              Moderation Queue
            </Text>
            <Pressable style={styles.modalCloseBtn} hitSlop={12} onPress={() => setShowModerationQueue(false)}>
              <Text style={styles.modalCloseText}>Close</Text>
            </Pressable>
          </View>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={[styles.modalBody, { paddingBottom: insets.bottom + 40 }]}
            keyboardShouldPersistTaps="handled"
          >
            {moderationReports.map((r) => (
              <View key={`report-${r.id}`} style={styles.hospitalListCard}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.hospitalListTitle, isDarkTheme && styles.hospitalListTitleDark, isNeo && styles.hospitalListTitleNeo]}>
                    {r.issue_type} • {r.status}
                  </Text>
                  <Text style={[styles.hospitalListMeta, isDarkTheme && styles.hospitalListMetaDark, isNeo && styles.hospitalListMetaNeo]}>
                    Event: {r.event_uid}
                  </Text>
                  {r.details ? (
                    <Text style={[styles.hospitalListMeta, isDarkTheme && styles.hospitalListMetaDark, isNeo && styles.hospitalListMetaNeo]}>
                      {r.details}
                    </Text>
                  ) : null}
                </View>
                <View style={styles.modalActionsRow}>
                  <Pressable style={styles.roundGhostBtn} onPress={() => updateModerationReportStatus(Number(r.id), "in_review")}>
                    <Text style={styles.roundGhostText}>Review</Text>
                  </Pressable>
                  <Pressable style={styles.roundGhostBtn} onPress={() => updateModerationReportStatus(Number(r.id), "resolved")}>
                    <Text style={styles.roundGhostText}>Resolve</Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </ScrollView>
        </View>
      </Modal>

      {/* Masjid quick sheet (from Explore map pin) */}
      <Modal
        visible={!!selectedMasjidSheet}
        animationType="slide"
        transparent
        onRequestClose={() => setSelectedMasjidSheet("")}
      >
        <View style={styles.bottomSheetBackdrop}>
          <Pressable style={StyleSheet.absoluteFillObject} onPress={() => setSelectedMasjidSheet("")} />
          <View
            style={[
              styles.bottomSheetCard,
              { maxHeight: Math.round(windowHeight * 0.78), paddingBottom: insets.bottom + 16 },
              isDarkTheme && styles.bottomSheetCardDark,
              isNeo && styles.bottomSheetCardNeo,
            ]}
          >
            <View style={styles.bottomSheetHandle} />
            <View style={styles.bottomSheetHeader}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.bottomSheetTitle, isDarkTheme && styles.bottomSheetTitleDark]} numberOfLines={2}>
                  {formatSourceLabel(selectedMasjidSheet)}
                </Text>
                <Text style={[styles.bottomSheetSub, isDarkTheme && styles.bottomSheetSubDark]}>
                  {orderedVisibleEvents.filter((ev) => normalizeText(ev.source).toLowerCase() === selectedMasjidSheet.toLowerCase()).length} upcoming event(s)
                </Text>
              </View>
              <Pressable
                onPress={() => toggleFollowMasjid(selectedMasjidSheet)}
                hitSlop={8}
                style={[styles.bottomSheetFollowBtn, followedMasjids.includes(selectedMasjidSheet) && styles.bottomSheetFollowBtnActive]}
              >
                <Text style={[styles.bottomSheetFollowText, followedMasjids.includes(selectedMasjidSheet) && styles.bottomSheetFollowTextActive]}>
                  {followedMasjids.includes(selectedMasjidSheet) ? "Following" : "Follow"}
                </Text>
              </Pressable>
              <Pressable hitSlop={12} onPress={() => setSelectedMasjidSheet("")} style={styles.bottomSheetCloseBtn}>
                <Text style={styles.bottomSheetCloseText}>✕</Text>
              </Pressable>
            </View>
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingVertical: 8, gap: 10 }}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator
            >
              {/* #2 Iqama card */}
              {(() => {
                const src = selectedMasjidSheet;
                if (!src) return null;
                const iq = iqamaBySource[src];
                if (!iq) return null;
                const prayers = ["fajr", "dhuhr", "asr", "maghrib", "isha"] as const;
                const anySet = prayers.some((p) => iq[p]?.iqama);
                const jumuah = iq["jumuah"]?.jumuah_times || [];
                if (!anySet && !jumuah.length) {
                  return (
                    <View style={styles.iqamaCard}>
                      <Text style={styles.iqamaTitle}>Iqama times</Text>
                      <Text style={styles.iqamaSub}>No iqama on file yet. Ask this masjid to claim their page in Masjidly Admin.</Text>
                    </View>
                  );
                }
                return (
                  <View style={styles.iqamaCard}>
                    <Text style={styles.iqamaTitle}>Iqama times</Text>
                    <View style={styles.iqamaRow}>
                      {prayers.map((p) => (
                        <View key={p} style={styles.iqamaCell}>
                          <Text style={styles.iqamaPrayer}>{p[0].toUpperCase() + p.slice(1)}</Text>
                          <Text style={styles.iqamaTime}>{iq[p]?.iqama || "—"}</Text>
                        </View>
                      ))}
                    </View>
                    {jumuah.length ? (
                      <Text style={styles.iqamaJumuah}>
                        Jumu'ah: {jumuah.join("  ·  ")}
                      </Text>
                    ) : null}
                    <Pressable style={styles.iqamaStampBtn} onPress={() => stampPassport(src)}>
                      <Text style={styles.iqamaStampText}>✓ I'm here — stamp passport</Text>
                    </Pressable>
                  </View>
                );
              })()}

              {orderedVisibleEvents
                .filter((ev) => normalizeText(ev.source).toLowerCase() === selectedMasjidSheet.toLowerCase())
                .map((ev, idx) => renderEventListCard(ev, `sheet-${idx}`))}
              {orderedVisibleEvents.filter((ev) => normalizeText(ev.source).toLowerCase() === selectedMasjidSheet.toLowerCase()).length === 0 ? (
                <Text style={[styles.bottomSheetSub, { textAlign: "center", marginTop: 24 }, isDarkTheme && styles.bottomSheetSubDark]}>
                  No events match the current filters for this masjid yet.
                </Text>
              ) : null}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Explore filters modal */}
      <Modal
        visible={showExploreFilters}
        animationType="slide"
        presentationStyle="fullScreen"
        statusBarTranslucent={false}
        onRequestClose={() => setShowExploreFilters(false)}
      >
        <View
          style={[
            styles.modalContainer,
            isMidnight && styles.modalContainerMidnight,
            isNeo && styles.modalContainerNeo,
            isVitaria && styles.modalContainerVitaria,
            isInferno && styles.modalContainerInferno,
            isEmerald && styles.modalContainerEmerald,
            { flex: 1, paddingTop: modalChromeTopPad },
          ]}
        >
          <View style={[styles.modalTop, isMidnight && styles.modalTopMidnight, isNeo && styles.modalTopNeo, isVitaria && styles.modalTopVitaria, isInferno && styles.modalTopInferno, isEmerald && styles.modalTopEmerald]}>
            <Text style={[styles.modalTitle, isMidnight && styles.modalTitleMidnight, isNeo && styles.modalTitleNeo, isVitaria && styles.modalTitleVitaria, isInferno && styles.modalTitleInferno, isEmerald && styles.modalTitleEmerald]} numberOfLines={1}>
              Filters
            </Text>
            <Pressable style={styles.modalCloseBtn} hitSlop={12} onPress={() => setShowExploreFilters(false)}>
              <Text style={styles.modalCloseText}>Done</Text>
            </Pressable>
          </View>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={[styles.modalBody, { paddingBottom: insets.bottom + 48 }]}
            keyboardShouldPersistTaps="handled"
          >
            <Text style={[styles.exploreFilterLabel, isDarkTheme && styles.exploreFilterLabelDark, isNeo && styles.exploreFilterLabelNeo]}>Keyword</Text>
            <TextInput
              style={[styles.input, isMidnight && styles.inputMidnight, isNeo && styles.inputNeo, isVitaria && styles.inputVitaria, isInferno && styles.inputInferno, isEmerald && styles.inputEmerald]}
              value={query}
              onChangeText={setQuery}
              placeholder="Search title, details, speaker"
              placeholderTextColor={inputPlaceholderColor}
            />
            <View style={styles.exploreFilterRow}>
              <View style={styles.exploreFilterCol}>
                <Text style={[styles.exploreFilterLabel, isDarkTheme && styles.exploreFilterLabelDark, isNeo && styles.exploreFilterLabelNeo]}>From</Text>
                <TextInput
                  style={[styles.input, isMidnight && styles.inputMidnight, isNeo && styles.inputNeo, isVitaria && styles.inputVitaria, isInferno && styles.inputInferno, isEmerald && styles.inputEmerald]}
                  value={startDate}
                  onChangeText={setStartDate}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={inputPlaceholderColor}
                />
              </View>
              <View style={styles.exploreFilterCol}>
                <Text style={[styles.exploreFilterLabel, isDarkTheme && styles.exploreFilterLabelDark, isNeo && styles.exploreFilterLabelNeo]}>To</Text>
                <TextInput
                  style={[styles.input, isMidnight && styles.inputMidnight, isNeo && styles.inputNeo, isVitaria && styles.inputVitaria, isInferno && styles.inputInferno, isEmerald && styles.inputEmerald]}
                  value={endDate}
                  onChangeText={setEndDate}
                  placeholder="YYYY-MM-DD"
                  placeholderTextColor={inputPlaceholderColor}
                />
              </View>
            </View>
            <View style={styles.exploreFilterRow}>
              <View style={styles.exploreFilterCol}>
                <Text style={[styles.exploreFilterLabel, isDarkTheme && styles.exploreFilterLabelDark, isNeo && styles.exploreFilterLabelNeo]}>Reference masjid</Text>
                <TextInput
                  style={[styles.input, isMidnight && styles.inputMidnight, isNeo && styles.inputNeo, isVitaria && styles.inputVitaria, isInferno && styles.inputInferno, isEmerald && styles.inputEmerald]}
                  value={reference}
                  onChangeText={setReference}
                  placeholder="Optional"
                  placeholderTextColor={inputPlaceholderColor}
                />
              </View>
              <View style={styles.exploreFilterCol}>
                <Text style={[styles.exploreFilterLabel, isDarkTheme && styles.exploreFilterLabelDark, isNeo && styles.exploreFilterLabelNeo]}>Radius (mi)</Text>
                <TextInput
                  style={[styles.input, isMidnight && styles.inputMidnight, isNeo && styles.inputNeo, isVitaria && styles.inputVitaria, isInferno && styles.inputInferno, isEmerald && styles.inputEmerald]}
                  value={radius}
                  onChangeText={setRadius}
                  placeholder="35"
                  keyboardType="number-pad"
                  placeholderTextColor={inputPlaceholderColor}
                />
              </View>
            </View>
            <View style={styles.exploreFilterActions}>
              <Pressable style={[styles.primaryBtn, styles.exploreFilterApplyBtn]} onPress={() => { loadEvents({ force: true }); setShowExploreFilters(false); }}>
                <Text style={styles.primaryBtnText}>{loading ? "Loading..." : "Apply Filters"}</Text>
              </Pressable>
              <Pressable
                style={[styles.roundGhostBtn, styles.exploreFilterResetBtn]}
                onPress={() => {
                  setQuery("");
                  setReference("");
                  setRadius("35");
                  setStartDate(todayIso());
                  setEndDate(plusDaysIso(45));
                  setQuickFilters([]);
                }}
              >
                <Text style={styles.exploreFilterResetText}>Reset</Text>
              </Pressable>
            </View>
            <Text style={[styles.exploreFilterLabel, isDarkTheme && styles.exploreFilterLabelDark, isNeo && styles.exploreFilterLabelNeo]}>Quick filters</Text>
            <View style={styles.exploreChipsGroup}>
              {[
                ["women", "Women"],
                ["youth", "Youth"],
                ["family", "Family"],
                ["after_maghrib", "After Maghrib"],
                ["free", "Free"],
                ["registration_required", "Registration required"],
              ].map(([id, label]) => {
                const active = quickFilters.includes(id as QuickFilterId);
                return (
                  <Pressable
                    key={`mod-quick-${id}`}
                    style={[styles.sourceChip, active && styles.sourceChipActive]}
                    onPress={() =>
                      setQuickFilters((prev) =>
                        prev.includes(id as QuickFilterId)
                          ? prev.filter((x) => x !== id)
                          : [...prev, id as QuickFilterId]
                      )
                    }
                  >
                    <Text style={[styles.sourceChipText, active && styles.sourceChipTextActive]}>{label}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={[styles.exploreFilterLabel, isDarkTheme && styles.exploreFilterLabelDark, isNeo && styles.exploreFilterLabelNeo]}>Sort</Text>
            <View style={styles.exploreChipsGroup}>
              {[
                ["soonest", "Soonest"],
                ["nearest", "Nearest"],
                ["relevant", "Most relevant"],
                ["recent", "Recently added"],
              ].map(([id, label]) => {
                const active = sortMode === id;
                return (
                  <Pressable key={`mod-sort-${id}`} style={[styles.sourceChip, active && styles.sourceChipActive]} onPress={() => setSortMode(id as SortMode)}>
                    <Text style={[styles.sourceChipText, active && styles.sourceChipTextActive]}>{label}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={[styles.exploreFilterLabel, isDarkTheme && styles.exploreFilterLabelDark, isNeo && styles.exploreFilterLabelNeo]}>Masjids</Text>
            <View style={styles.exploreChipsGroup}>
              {(meta?.sources || []).map((src) => {
                const active = selectedSources.has(src);
                return (
                  <Pressable
                    key={`mod-src-${src}`}
                    onPress={() => toggleSource(src)}
                    style={[styles.sourceChip, active && styles.sourceChipActive]}
                  >
                    <Text style={[styles.sourceChipText, active && styles.sourceChipTextActive]}>{formatSourceLabel(src)}</Text>
                  </Pressable>
                );
              })}
            </View>
            <Text style={[styles.exploreFilterLabel, isDarkTheme && styles.exploreFilterLabelDark, isNeo && styles.exploreFilterLabelNeo]}>Saved filter sets</Text>
            <View style={styles.exploreChipsGroup}>
              {savedFilterPresets.map((preset) => (
                <Pressable key={`mod-preset-${preset.id}`} style={styles.sourceChip} onPress={() => applyPreset(preset)}>
                  <Text style={styles.sourceChipText}>{preset.label}</Text>
                </Pressable>
              ))}
            </View>
            <View style={styles.presetEditorRow}>
              <TextInput
                style={[styles.input, styles.presetEditorInput, isMidnight && styles.inputMidnight, isNeo && styles.inputNeo, isVitaria && styles.inputVitaria, isInferno && styles.inputInferno, isEmerald && styles.inputEmerald]}
                value={presetDraftLabel}
                onChangeText={setPresetDraftLabel}
                placeholder="Preset name (e.g. Weekend family)"
                placeholderTextColor={inputPlaceholderColor}
              />
              <Pressable style={[styles.darkPillBtn, styles.presetEditorSaveBtn]} onPress={saveCurrentPreset}>
                <Text style={styles.darkPillBtnText}>{editingPresetId ? "Update" : "Create"}</Text>
              </Pressable>
              {editingPresetId ? (
                <Pressable
                  style={styles.roundGhostBtn}
                  onPress={() => {
                    setEditingPresetId("");
                    setPresetDraftLabel("");
                  }}
                >
                  <Text style={styles.roundGhostText}>✕</Text>
                </Pressable>
              ) : null}
            </View>
          </ScrollView>
        </View>
      </Modal>

      {/* #21 Reflection prompt */}
      <Modal
        visible={!!reflectionState}
        animationType="slide"
        transparent
        onRequestClose={() => setReflectionState(null)}
      >
        <View style={styles.bottomSheetBackdrop}>
          <Pressable style={StyleSheet.absoluteFillObject} onPress={() => setReflectionState(null)} />
          <View style={[styles.bottomSheetCard, { paddingBottom: insets.bottom + 24 }]}>
            <View style={styles.bottomSheetHandle} />
            <Text style={[styles.bottomSheetTitle, { marginHorizontal: 16 }]}>
              {reflectionState?.event?.title || "Reflection"}
            </Text>
            <Text style={[styles.bottomSheetSub, { marginHorizontal: 16, marginBottom: 12 }]}>
              How was it? Leave one benefit or thought — shown on the masjid page under your first name.
            </Text>
            <View style={{ flexDirection: "row", gap: 6, marginHorizontal: 16 }}>
              {[1, 2, 3, 4, 5].map((n) => (
                <Pressable
                  key={n}
                  onPress={() =>
                    setReflectionState((s) => (s ? { ...s, rating: n } : s))
                  }
                  style={[
                    styles.reflectStar,
                    (reflectionState?.rating || 0) >= n && styles.reflectStarActive,
                  ]}
                >
                  <Text style={[styles.reflectStarText, (reflectionState?.rating || 0) >= n && styles.reflectStarTextActive]}>
                    ★
                  </Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              style={styles.reflectInput}
              multiline
              placeholder="One thing you learned or appreciated…"
              value={reflectionState?.text || ""}
              onChangeText={(t) =>
                setReflectionState((s) => (s ? { ...s, text: t } : s))
              }
            />
            <View style={{ flexDirection: "row", gap: 8, marginHorizontal: 16, marginTop: 12 }}>
              <Pressable style={[styles.modalActionBtn, { flex: 1 }]} onPress={() => setReflectionState(null)}>
                <Text style={styles.modalActionBtnText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={[styles.modalActionBtn, styles.modalActionBtnPrimary, { flex: 1 }]}
                onPress={submitReflection}
              >
                <Text style={styles.modalActionBtnText}>Post reflection</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      {/* #31 Passport */}
      <Modal
        visible={passportOpen}
        animationType="slide"
        presentationStyle="fullScreen"
        statusBarTranslucent={false}
        onRequestClose={() => setPassportOpen(false)}
      >
        <View style={[styles.modalContainer, { flex: 1, paddingTop: modalChromeTopPad }]}>
          <View style={styles.modalTop}>
            <Text style={styles.modalTitle} numberOfLines={1}>Masjid Passport</Text>
            <Pressable style={styles.modalCloseBtn} hitSlop={12} onPress={() => setPassportOpen(false)}>
              <Text style={styles.modalCloseText}>Close</Text>
            </Pressable>
          </View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40, gap: 12 }}>
            <View style={styles.passportHero}>
              <Text style={styles.passportHeroTitle}>{passportStamps.length} / 24 masjids visited</Text>
              <Text style={styles.passportHeroSub}>
                Collect a stamp for each NJ masjid you visit. Open any masjid page → tap "+ Passport stamp".
              </Text>
              <View style={styles.passportProgressBar}>
                <View style={[styles.passportProgressFill, { width: `${Math.min(100, (passportStamps.length / 24) * 100)}%` }]} />
              </View>
            </View>
            <Text style={{ fontWeight: "800", fontSize: 14, marginTop: 10 }}>Enter stamp code</Text>
            <View style={{ flexDirection: "row", gap: 8 }}>
              <TextInput
                style={[styles.reflectInput, { flex: 1, minHeight: 44, marginHorizontal: 0 }]}
                placeholder="Scan QR or type source code (e.g. mcnj)"
                value={qrEntryBuffer}
                onChangeText={setQrEntryBuffer}
                autoCapitalize="none"
              />
              <Pressable
                style={[styles.modalActionBtn, styles.modalActionBtnPrimary]}
                onPress={() => {
                  const code = qrEntryBuffer.trim().toLowerCase();
                  if (code) {
                    stampPassport(code);
                    setQrEntryBuffer("");
                  }
                }}
              >
                <Text style={styles.modalActionBtnText}>Stamp</Text>
              </Pressable>
            </View>
            <Text style={{ fontWeight: "800", fontSize: 14, marginTop: 12 }}>Collected</Text>
            <View style={styles.passportGrid}>
              {meta?.sources.map((src) => {
                const has = passportStamps.some((s) => s.source === src);
                return (
                  <Pressable
                    key={`pp-${src}`}
                    style={[styles.passportStampCell, has && styles.passportStampCellDone]}
                    onPress={() => setSelectedMasjidProfile(src)}
                  >
                    <View style={[styles.passportStampLogo, { backgroundColor: masjidBrandColor(src) }]}>
                      <Text style={styles.passportStampLogoText}>{masjidInitials(src)}</Text>
                    </View>
                    <Text style={[styles.passportStampName, has && { color: "#1f7a42" }]} numberOfLines={2}>
                      {formatSourceLabel(src)}
                    </Text>
                    {has ? <Text style={styles.passportStampDone}>✓</Text> : null}
                  </Pressable>
                );
              })}
            </View>
          </ScrollView>
        </View>
      </Modal>

      {/* #24 Scholar directory */}
      <Modal
        visible={scholarScreenOpen}
        animationType="slide"
        presentationStyle="fullScreen"
        statusBarTranslucent={false}
        onRequestClose={() => setScholarScreenOpen(false)}
      >
        <View style={[styles.modalContainer, { flex: 1, paddingTop: modalChromeTopPad }]}>
          <View style={styles.modalTop}>
            <Text style={styles.modalTitle} numberOfLines={1}>
              {selectedSpeaker ? speakers.find((s) => s.slug === selectedSpeaker)?.name || "Scholar" : "Scholars & Speakers"}
            </Text>
            <Pressable
              style={styles.modalCloseBtn}
              hitSlop={12}
              onPress={() => {
                if (selectedSpeaker) {
                  setSelectedSpeaker(null);
                } else {
                  setScholarScreenOpen(false);
                }
              }}
            >
              <Text style={styles.modalCloseText}>{selectedSpeaker ? "Back" : "Close"}</Text>
            </Pressable>
          </View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40, gap: 10 }}>
            {!selectedSpeaker ? (
              speakers.length === 0 ? (
                <Text style={styles.bottomSheetSub}>Loading scholar directory…</Text>
              ) : (
                speakers.slice(0, 80).map((sp) => (
                  <Pressable
                    key={`sp-${sp.slug}`}
                    style={styles.scholarCard}
                    onPress={() => setSelectedSpeaker(sp.slug)}
                  >
                    {sp.image_url ? (
                      <Image source={{ uri: sp.image_url }} style={styles.scholarAvatar} />
                    ) : (
                      <View style={[styles.scholarAvatar, { backgroundColor: "#eef2fa", justifyContent: "center", alignItems: "center" }]}>
                        <Text style={{ fontWeight: "800", color: "#5b6a88" }}>{sp.name.split(" ").map((p) => p[0]).slice(0, 2).join("")}</Text>
                      </View>
                    )}
                    <View style={{ flex: 1 }}>
                      <Text style={styles.scholarName} numberOfLines={1}>{sp.name}</Text>
                      <Text style={styles.scholarSub}>
                        {sp.upcoming_events} upcoming · {sp.total_events} total · {sp.sources.length} masjid(s)
                      </Text>
                      {sp.next_title ? (
                        <Text style={styles.scholarNext} numberOfLines={1}>Next: {sp.next_title}</Text>
                      ) : null}
                    </View>
                  </Pressable>
                ))
              )
            ) : (
              (() => {
                const sp = speakers.find((s) => s.slug === selectedSpeaker);
                if (!sp) return null;
                const upcomingMatches = orderedVisibleEvents.filter(
                  (ev) =>
                    (ev.speaker || "")
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, "-")
                      .replace(/^-+|-+$/g, "") === sp.slug
                );
                return (
                  <>
                    <View style={styles.scholarHero}>
                      <Text style={styles.scholarName}>{sp.name}</Text>
                      <Text style={styles.scholarSub}>
                        {sp.upcoming_events} upcoming events · appears at {sp.sources.length} masjid(s)
                      </Text>
                      <Text style={{ color: "#4a3bb0", marginTop: 4 }}>
                        {sp.sources.map(formatSourceLabel).join(" · ")}
                      </Text>
                    </View>
                    {upcomingMatches.length ? (
                      upcomingMatches.map((ev, idx) => renderEventListCard(ev, `scholar-${idx}`))
                    ) : (
                      <Text style={styles.bottomSheetSub}>No upcoming talks matching the active filters.</Text>
                    )}
                  </>
                );
              })()
            )}
          </ScrollView>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppInner />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  welcomeContainer: { flex: 1, width: "100%", backgroundColor: "#eef3ff" },
  welcomeBody: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 34, gap: 14 },
  welcomePagerWrap: { flex: 1 },
  welcomeSlide: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 16, justifyContent: "center" },
  welcomeSlideTop: { justifyContent: "flex-start" },
  welcomeSlideTapZone: { width: "100%" },
  welcomeHeroOnlyCard: { minHeight: 640, justifyContent: "center" },
  welcomeSlideCard: {},
  welcomeUnifiedCard: {
    padding: 18,
    borderRadius: 22,
    shadowOpacity: 0.08,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 3,
  },
  welcomeInfoCard: {
    overflow: "hidden",
    minHeight: 640,
    justifyContent: "center",
    paddingTop: 18,
  },
  welcomeInfoGlowOne: { top: -76, left: -44, width: 210, height: 210, opacity: 0.7 },
  welcomeInfoGlowTwo: { bottom: -38, right: -24, width: 134, height: 134, opacity: 0.75 },
  welcomeInfoEyebrow: {
    alignSelf: "center",
    color: "#ffe2cb",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.2,
    marginBottom: 6,
  },
  welcomeInfoEyebrowNeo: { color: "#666" },
  welcomeInfoEyebrowEmerald: { color: "#3f6c54" },
  welcomeInfoTitle: { color: "#fff7f0", fontSize: 24, lineHeight: 31, letterSpacing: -0.4 },
  welcomeInfoTitleCentered: { textAlign: "center", alignSelf: "center" },
  welcomeInfoTitleNeo: { color: "#1f1f1f" },
  welcomeInfoTitleEmerald: { color: "#245b3c" },
  welcomeInfoLead: {
    marginTop: 8,
    marginBottom: 12,
    textAlign: "center",
    color: "#fff4ea",
    fontSize: 15,
    lineHeight: 22,
    fontWeight: "700",
  },
  welcomeInfoLeadNeo: { color: "#5a5a5a" },
  welcomeInfoLeadEmerald: { color: "#3f6b53" },
  welcomeFeatureStack: { gap: 10, marginBottom: 8 },
  welcomeFeatureRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.22)",
    backgroundColor: "rgba(255,255,255,0.08)",
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  welcomeFeatureRowNeo: { borderColor: "#b8b8b8", backgroundColor: "rgba(255,255,255,0.75)" },
  welcomeFeatureRowEmerald: { borderColor: "rgba(112,153,129,0.35)", backgroundColor: "rgba(235,247,239,0.7)" },
  welcomeFeatureBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.2)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.35)",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  welcomeFeatureBadgeNeo: { backgroundColor: "#ececec", borderColor: "#b8b8b8" },
  welcomeFeatureBadgeEmerald: { backgroundColor: "#e6f3ea", borderColor: "#b2d0bf" },
  welcomeFeatureBadgeText: { color: "#fff7ef", fontWeight: "800", fontSize: 12 },
  welcomeFeatureBadgeTextNeo: { color: "#333" },
  welcomeFeatureBadgeTextEmerald: { color: "#2f6245" },
  welcomeFeatureText: { flex: 1, color: "#fff8f2", fontSize: 15, lineHeight: 22, fontWeight: "700" },
  welcomeFeatureTextNeo: { color: "#3f3f3f", fontWeight: "700" },
  welcomeFeatureTextEmerald: { color: "#2f5a42", fontWeight: "700" },
  welcomeInfoStepDot: {
    backgroundColor: "rgba(255,255,255,0.22)",
    borderColor: "rgba(255,255,255,0.4)",
  },
  welcomeInfoStepDotNeo: { backgroundColor: "#ececec", borderColor: "#b8b8b8" },
  welcomeInfoStepDotEmerald: { backgroundColor: "#e6f3ea", borderColor: "#b2d0bf" },
  welcomeInfoStepDotText: { color: "#fffaf7" },
  welcomeInfoStepDotTextNeo: { color: "#333" },
  welcomeInfoStepDotTextEmerald: { color: "#2f6245" },
  welcomeInfoStepText: { color: "#fff3e7" },
  welcomeInfoStepTextNeo: { color: "#4b4b4b" },
  welcomeInfoStepTextEmerald: { color: "#335b45" },
  welcomeInfoSub: { color: "#ffe9d8" },
  welcomeInfoSubNeo: { color: "#575757" },
  welcomeInfoSubEmerald: { color: "#406a52" },
  welcomeCombinedSection: {
    marginTop: 14,
    gap: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(209,171,141,0.25)",
    backgroundColor: "rgba(245,170,109,0.08)",
    paddingHorizontal: 12,
    paddingTop: 12,
    paddingBottom: 10,
  },
  welcomeCombinedSectionOnHero: {
    borderColor: "rgba(255,255,255,0.24)",
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  welcomeCombinedSectionNeo: { borderColor: "rgba(120,120,120,0.3)", backgroundColor: "rgba(255,255,255,0.65)" },
  welcomeCombinedSectionEmerald: { borderColor: "rgba(90,129,106,0.28)", backgroundColor: "rgba(236,247,240,0.65)" },
  welcomeCombinedDivider: {
    height: 1,
    backgroundColor: "rgba(142,170,218,0.35)",
    marginVertical: 0,
  },
  welcomeCombinedDividerOnHero: { backgroundColor: "rgba(255,255,255,0.34)" },
  welcomeCombinedDividerDark: { backgroundColor: "rgba(208,219,246,0.26)" },
  welcomeCombinedDividerNeo: { backgroundColor: "rgba(120,120,120,0.35)" },
  welcomeCombinedDividerEmerald: { backgroundColor: "rgba(105,149,122,0.35)" },
  welcomeChatToast: {
    position: "absolute",
    top: 14,
    alignSelf: "center",
    zIndex: 3,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: "rgba(255,255,255,0.92)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.95)",
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  welcomeChatToastDark: { backgroundColor: "rgba(15,19,39,0.95)", borderColor: "rgba(207,216,255,0.42)" },
  welcomeChatToastText: { color: "#f07c56", fontSize: 13, fontWeight: "800", letterSpacing: 0.2 },
  welcomeChatToastTextDark: { color: "#f3f6ff" },
  welcomeSwipeHint: {
    marginTop: 14,
    color: "#e8f0ff",
    fontSize: 12,
    fontWeight: "600",
    textAlign: "center",
    letterSpacing: 0.2,
  },
  welcomeSwipeHintDark: { color: "#cfd4de" },
  welcomeCardHint: {
    marginTop: 10,
    color: "#7d8ca8",
    fontSize: 12,
    fontWeight: "600",
    textAlign: "center",
    letterSpacing: 0.15,
  },
  welcomeCardHintDark: { color: "#afbdd4" },
  welcomeCardHintNeo: { color: "#777" },
  welcomeCardHintEmerald: { color: "#4f7a5d" },
  welcomeCardHintOnHero: { color: "#ffe4d0" },
  welcomePagerDots: {
    flexDirection: "row",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
    marginBottom: 14,
  },
  welcomePagerDot: { width: 8, height: 8, borderRadius: 999, backgroundColor: "#9fb3d6" },
  welcomePagerDotActive: { width: 20, backgroundColor: "#345fbc" },
  welcomeHeroCard: {
    overflow: "hidden",
    width: "100%",
    maxWidth: "100%",
    alignSelf: "stretch",
    backgroundColor: "#123f8f",
    borderRadius: 22,
    padding: 18,
    borderWidth: 1,
    borderColor: "#0f367b",
    shadowColor: "#0e2f67",
    shadowOpacity: 0.28,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 6,
  },
  welcomeHeroCardMinera: { backgroundColor: "#ff7d50", borderColor: "#f6b18f", shadowColor: "#a84a2a" },
  welcomeHeroCardEmerald: { backgroundColor: "#cfe3d6", borderColor: "#a7c7b3", shadowColor: "#8daf9b" },
  welcomeHeroCardMidnight: { backgroundColor: "#0f1327", borderColor: "#2a3047", shadowColor: "#070a16" },
  welcomeHeroCardNeo: { backgroundColor: "#d9d9d9", borderColor: "#b9b9b9", shadowColor: "#7e7e7e" },
  welcomeHeroCardVitaria: { backgroundColor: "rgba(255,255,255,0.16)", borderColor: "rgba(255,255,255,0.28)", shadowColor: "#2a1a35" },
  welcomeHeroCardInferno: { backgroundColor: "rgba(26,9,4,0.82)", borderColor: "rgba(255,129,46,0.3)", shadowColor: "#000" },
  heroGlowOne: {
    position: "absolute",
    width: 170,
    height: 170,
    borderRadius: 999,
    backgroundColor: "#5ea4ff45",
    top: -58,
    right: -35,
  },
  heroGlowOneMinera: { backgroundColor: "#ffc5a34f" },
  heroGlowOneEmerald: { backgroundColor: "#6ca88345" },
  heroGlowOneMidnight: { backgroundColor: "#4552b13d" },
  heroGlowOneNeo: { backgroundColor: "#a6a6a64d" },
  heroGlowOneVitaria: { backgroundColor: "#ff9cc73d" },
  heroGlowOneInferno: { backgroundColor: "#ff6e213f" },
  heroGlowTwo: {
    position: "absolute",
    width: 110,
    height: 110,
    borderRadius: 999,
    backgroundColor: "#8bc7ff33",
    bottom: -28,
    left: -18,
  },
  heroGlowTwoMinera: { backgroundColor: "#ffd8bc4d" },
  heroGlowTwoEmerald: { backgroundColor: "#9ac8ae4f" },
  heroGlowTwoMidnight: { backgroundColor: "#7084f633" },
  heroGlowTwoNeo: { backgroundColor: "#8f8f8f33" },
  heroGlowTwoVitaria: { backgroundColor: "#fcb0e033" },
  heroGlowTwoInferno: { backgroundColor: "#ffae3a33" },
  welcomeBadge: {
    alignSelf: "flex-start",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#ffffff66",
    paddingHorizontal: 12,
    paddingVertical: 4,
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.9,
    backgroundColor: "#ffffff1f",
  },
  welcomeBadgeMinera: { backgroundColor: "rgba(255,255,255,0.22)", borderColor: "rgba(255,255,255,0.55)", color: "#fff9f5" },
  welcomeBadgeEmerald: { backgroundColor: "#e8f3ec", borderColor: "#a5c7b3", color: "#2d5f40" },
  welcomeBadgeMidnight: { backgroundColor: "#ffffff12", borderColor: "#cfd8ff44", color: "#e9edff" },
  welcomeBadgeNeo: { backgroundColor: "#ffffff99", borderColor: "#8f8f8f", color: "#191919" },
  welcomeBadgeVitaria: { backgroundColor: "rgba(255,255,255,0.18)", borderColor: "rgba(255,255,255,0.32)" },
  welcomeBadgeInferno: { backgroundColor: "rgba(255,122,43,0.16)", borderColor: "rgba(255,138,58,0.38)", color: "#ffe8d2" },
  welcomeLogoWrap: {
    marginTop: 0,
    alignSelf: "center",
    position: "relative",
  },
  welcomeLogoBase: { width: "100%", height: "100%" },
  welcomeBetaBadge: {
    position: "absolute",
    top: 14,
    right: 14,
    zIndex: 4,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.42)",
    backgroundColor: "rgba(255,255,255,0.2)",
    color: "#fff6ef",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  welcomeBetaBadgeNeo: { backgroundColor: "#f2f2f2", borderColor: "#b8b8b8", color: "#2e2e2e" },
  welcomeBetaBadgeEmerald: { backgroundColor: "#e8f4ec", borderColor: "#a7c7b3", color: "#2f6245" },
  welcomeBrand: { marginTop: 10, fontSize: 32, fontWeight: "900", color: "#ffffff", letterSpacing: -0.6, maxWidth: "100%" },
  welcomeTitle: { marginTop: -6, fontSize: 22, fontWeight: "900", color: "#ffffff", lineHeight: 28, letterSpacing: -0.4, maxWidth: "100%" },
  welcomeSub: { marginTop: 10, color: "#dce7ff", fontSize: 15, lineHeight: 23, maxWidth: "96%" },
  welcomeBrandMinera: { color: "#fffaf6", fontFamily: MINERA_FONT_BOLD, fontWeight: "700", letterSpacing: -0.15 },
  welcomeTitleMinera: { color: "#fff7f2", fontFamily: MINERA_FONT_MEDIUM, fontWeight: "700", letterSpacing: -0.05 },
  welcomeSubMinera: { color: "#ffece0", fontFamily: MINERA_FONT_REGULAR, fontWeight: "500" },
  welcomeBrandEmerald: { color: "#1f5236" },
  welcomeTitleEmerald: { color: "#245b3c" },
  welcomeSubEmerald: { color: "#406a52" },
  welcomeBrandNeo: { color: "#151515" },
  welcomeTitleNeo: { color: "#121212" },
  welcomeSubNeo: { color: "#4e4e4e" },
  heroTrustRow: { marginTop: 18, flexDirection: "row", flexWrap: "wrap", justifyContent: "center", gap: 10 },
  heroTrustPill: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#ffffff2f",
    backgroundColor: "#ffffff1a",
    color: "#f3f8ff",
    fontSize: 11,
    fontWeight: "700",
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  heroTrustPillMinera: { backgroundColor: "rgba(255,255,255,0.2)", borderColor: "rgba(255,255,255,0.45)", color: "#fff8f2", fontFamily: MINERA_FONT_MEDIUM, fontWeight: "600" },
  heroTrustPillEmerald: { backgroundColor: "#e6f3ea", borderColor: "#b2d0bf", color: "#3a6a50" },
  heroTrustPillNeo: { backgroundColor: "#f7f7f7", borderColor: "#b4b4b4", color: "#333" },
  tutorialCard: {
    backgroundColor: "#fff",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#d7e1f3",
    padding: 16,
    gap: 11,
    shadowColor: "#1a2f56",
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  tutorialTitle: { fontSize: 18, fontWeight: "900", color: "#173664", letterSpacing: -0.2 },
  tutorialRow: { flexDirection: "row", gap: 10, alignItems: "flex-start", paddingVertical: 2 },
  stepDot: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: "#e8f1ff",
    borderWidth: 1,
    borderColor: "#d4e2ff",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  stepDotText: { color: "#1f4c9b", fontSize: 13, fontWeight: "800" },
  tutorialStepText: { flex: 1, color: "#2c4368", fontSize: 15, lineHeight: 22 },
  stepDotMinera: { backgroundColor: "#ffeddc", borderColor: "#f0bf95" },
  stepDotEmerald: { backgroundColor: "#e6f3ea", borderColor: "#b2d0bf" },
  stepDotDark: { backgroundColor: "#ffffff1a", borderColor: "#ffffff38" },
  stepDotTextMinera: { color: "#a15e25", fontFamily: MINERA_FONT_BOLD, fontWeight: "700" },
  stepDotTextEmerald: { color: "#2f6245" },
  stepDotTextDark: { color: "#f6f8ff" },
  tutorialStepTextMinera: { color: "#3f4f67", fontFamily: MINERA_FONT_REGULAR, fontWeight: "500" },
  tutorialStepTextEmerald: { color: "#335b45" },
  tutorialStepTextDark: { color: "#d6def0" },
  stepDotNeo: { backgroundColor: "#ececec", borderColor: "#b8b8b8" },
  stepDotTextNeo: { color: "#333" },
  tutorialStepTextNeo: { color: "#4b4b4b" },
  welcomeFooterCard: {
    backgroundColor: "#fff",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#d7e1f3",
    padding: 16,
    shadowColor: "#1a2f56",
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 3 },
    elevation: 2,
  },
  welcomeFooterTitle: { fontSize: 18, fontWeight: "900", color: "#173664", letterSpacing: -0.2 },
  welcomeFooterSub: { marginTop: 6, color: "#60759b", fontSize: 14, lineHeight: 20 },
  welcomePrimaryBtn: {
    marginTop: 12,
    height: 54,
    borderRadius: 12,
    backgroundColor: "#1e63da",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#0f3e8e",
    shadowOpacity: 0.22,
    shadowRadius: 9,
    shadowOffset: { width: 0, height: 5 },
    elevation: 3,
  },
  welcomePrimaryBtnMinera: { backgroundColor: "#cf762f", shadowColor: "#8a4a18" },
  welcomePrimaryBtnEmerald: { backgroundColor: "#1f6b42", shadowColor: "#114227" },
  welcomePrimaryBtnMidnight: { backgroundColor: "#2a3360", shadowColor: "#0a0e1f" },
  welcomePrimaryBtnNeo: { backgroundColor: "#a9a9a9", shadowColor: "#666" },
  welcomePrimaryBtnVitaria: { backgroundColor: "rgba(255,173,144,0.9)", shadowColor: "#5f2744" },
  welcomePrimaryBtnInferno: { backgroundColor: "#ff7b2f", borderWidth: 1, borderColor: "#ffb076", shadowColor: "#532106" },
  welcomePrimaryBtnOnHero: { backgroundColor: "#2f3138", shadowColor: "#12161f" },
  welcomePrimaryBtnWhite: {
    backgroundColor: "#ffffff",
    borderColor: "rgba(255,255,255,0.95)",
    borderWidth: 1,
    shadowColor: "#a74d22",
    shadowOpacity: 0.15,
  },
  welcomePrimaryBtnInsideCard: {
    alignSelf: "center",
    width: "92%",
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.95)",
    shadowColor: "#a74d22",
    shadowOpacity: 0.15,
  },
  welcomePrimaryBtnText: { color: "#fff", fontSize: 19, fontWeight: "800", letterSpacing: 0.2 },
  welcomePrimaryBtnTextMinera: { color: "#f4f7ff", fontFamily: MINERA_FONT_BOLD, fontWeight: "700", letterSpacing: 0.05 },
  welcomePrimaryBtnTextWhite: { color: "#2b3040" },
  welcomePrimaryBtnTextEmerald: { color: "#e9ffee" },
  welcomePrimaryBtnTextNeo: { color: "#1a1a1a" },
  welcomePrimaryBtnTextInferno: { color: "#2a1306" },
  welcomePrimaryBtnTextInsideCard: { color: "#2b3040" },
  captureBody: { paddingBottom: 30, flexGrow: 1, justifyContent: "center" },
  captureCard: { minHeight: 680, justifyContent: "center", gap: 12, paddingTop: 22 },
  captureGlowOne: { top: -70, right: -40, width: 190, height: 190 },
  captureGlowTwo: { bottom: -34, left: -18, width: 124, height: 124 },
  captureBackPill: {
    alignSelf: "flex-start",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.5)",
    backgroundColor: "rgba(255,255,255,0.14)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginBottom: 2,
  },
  captureBackPillText: { color: "#fff2e8", fontSize: 12, fontWeight: "800", letterSpacing: 0.15 },
  captureTitle: { color: "#fff8f2", fontSize: 26, fontWeight: "900", letterSpacing: -0.6, lineHeight: 32, maxWidth: "100%" },
  captureSub: { color: "#ffe8d6", fontSize: 15, lineHeight: 22, marginBottom: 4 },
  captureFieldGroup: { gap: 7, marginTop: 6 },
  captureLabel: { color: "#ffeede", fontSize: 13, fontWeight: "700", letterSpacing: 0.1 },
  captureInput: {
    height: 46,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.4)",
    backgroundColor: "rgba(255,255,255,0.14)",
    color: "#fff8f3",
    paddingHorizontal: 12,
    fontSize: 15,
    fontWeight: "600",
  },
  captureInputNeo: { backgroundColor: "rgba(255,255,255,0.78)", borderColor: "#b0b0b0", color: "#1d1d1d" },
  captureInputEmerald: { backgroundColor: "rgba(239,248,242,0.75)", borderColor: "#a3c7b1", color: "#1f5137" },
  captureChoiceRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  captureChoicePill: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.45)",
    backgroundColor: "rgba(255,255,255,0.14)",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  captureChoicePillNeo: { borderColor: "#b1b1b1", backgroundColor: "#efefef" },
  captureChoicePillEmerald: { borderColor: "#a4c8b2", backgroundColor: "#ecf7f0" },
  captureChoicePillActive: { backgroundColor: "#2f3138", borderColor: "#1f2026" },
  captureChoicePillOnWelcome: { backgroundColor: "rgba(255,255,255,0.14)", borderColor: "rgba(255,255,255,0.45)" },
  captureChoicePillActiveOnWelcome: { backgroundColor: "#ffffff", borderColor: "#ffffff" },
  captureChoiceText: { color: "#fff1e4", fontSize: 13, fontWeight: "700" },
  captureChoiceTextOnWelcome: { color: "#fff3e7" },
  captureChoiceTextNeo: { color: "#363636" },
  captureChoiceTextEmerald: { color: "#2a5b40" },
  captureChoiceTextActive: { color: "#fff" },
  captureChoiceTextActiveOnWelcome: { color: "#273142" },
  captureErrorText: { marginTop: 4, color: "#ffd2c6", fontSize: 13, fontWeight: "700" },
  launchWrap: { flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: 24, overflow: "hidden" },
  launchGlowOne: { top: -62, right: -38, width: 210, height: 210, opacity: 0.78 },
  launchGlowTwo: { bottom: -34, left: -22, width: 148, height: 148, opacity: 0.82 },
  launchCard: {
    width: "100%",
    borderRadius: 24,
    borderWidth: 1,
    alignItems: "center",
    paddingVertical: 28,
    paddingHorizontal: 18,
    shadowOpacity: 0.22,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 9 },
    elevation: 6,
  },
  launchCardSurface: {
    backgroundColor: "#ff7d50",
    borderColor: "#f6b18f",
    shadowColor: "#a65022",
  },
  launchCardSurfaceDark: {
    backgroundColor: "rgba(17,21,36,0.86)",
    borderColor: "rgba(207,216,255,0.26)",
    shadowColor: "#060812",
  },
  launchCardSurfaceNeo: {
    backgroundColor: "rgba(247,247,247,0.9)",
    borderColor: "rgba(189,189,189,0.9)",
    shadowColor: "#7a7a7a",
  },
  launchCardSurfaceEmerald: {
    backgroundColor: "rgba(236,247,240,0.88)",
    borderColor: "rgba(138,182,156,0.6)",
    shadowColor: "#4c765f",
  },
  launchCardSurfaceInferno: {
    backgroundColor: "rgba(55,20,9,0.82)",
    borderColor: "rgba(255,166,102,0.4)",
    shadowColor: "#180700",
  },
  launchCardSurfaceVitaria: {
    backgroundColor: "rgba(255,150,113,0.26)",
    borderColor: "rgba(255,226,208,0.42)",
    shadowColor: "#8a4a2a",
  },
  launchLogo: { width: 200, height: 200, marginBottom: -8 },
  launchGreeting: {
    position: "absolute",
    top: 146,
    color: "#b55624",
    fontSize: 34,
    fontWeight: "900",
    letterSpacing: -0.6,
    textAlign: "center",
  },
  launchGreetingNeo: { color: "#8f4a25" },
  launchGreetingEmerald: { color: "#1f5137" },
  launchTitle: { color: "#ffffff", fontSize: 30, fontWeight: "900", letterSpacing: -0.4, textAlign: "center" },
  launchTitleDark: { color: "#eef2ff" },
  launchTitleNeo: { color: "#1f1f1f" },
  launchTitleEmerald: { color: "#1f5137" },
  launchSub: { marginTop: 8, color: "#fff0e3", fontSize: 16, fontWeight: "600", textAlign: "center" },
  launchSubDark: { color: "#cad3ec" },
  launchSubNeo: { color: "#626262" },
  launchSubEmerald: { color: "#3f6a53" },
  premiumHero: {
    borderRadius: 28,
    padding: 18,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#eceff5",
    shadowColor: "#283345",
    shadowOpacity: 0.12,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 7 },
    elevation: 4,
  },
  premiumHeroGlowOne: {
    position: "absolute",
    width: 250,
    height: 250,
    borderRadius: 125,
    top: -126,
    left: -50,
    backgroundColor: "rgba(255, 255, 255, 0.48)",
  },
  premiumHeroGlowOneMidnight: { backgroundColor: "rgba(126, 147, 255, 0.28)" },
  premiumHeroGlowOneNeo: { backgroundColor: "rgba(255, 255, 255, 0.42)" },
  premiumHeroGlowOneVitaria: { backgroundColor: "rgba(255, 209, 232, 0.32)" },
  premiumHeroGlowOneInferno: { backgroundColor: "rgba(255, 136, 74, 0.34)" },
  premiumHeroGlowOneEmerald: { backgroundColor: "rgba(140, 234, 177, 0.3)" },
  premiumHeroGlowTwo: {
    position: "absolute",
    width: 220,
    height: 220,
    borderRadius: 110,
    right: -62,
    bottom: -120,
    backgroundColor: "rgba(255, 222, 194, 0.4)",
  },
  premiumHeroGlowTwoMidnight: { backgroundColor: "rgba(74, 101, 215, 0.34)" },
  premiumHeroGlowTwoNeo: { backgroundColor: "rgba(201, 201, 201, 0.42)" },
  premiumHeroGlowTwoVitaria: { backgroundColor: "rgba(255, 161, 208, 0.3)" },
  premiumHeroGlowTwoInferno: { backgroundColor: "rgba(255, 106, 37, 0.32)" },
  premiumHeroGlowTwoEmerald: { backgroundColor: "rgba(74, 176, 113, 0.34)" },
  premiumGreeting: { color: "#ffffffd7", fontSize: 14, fontWeight: "700" },
  premiumName: { marginTop: 4, color: "#fff", fontSize: 42, fontWeight: "900", letterSpacing: -1 },
  premiumGreetingNeo: { color: "#3f3f3f" },
  premiumNameNeo: { color: "#151515" },
  statusStrip: {
    marginTop: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#ffffff7d",
    backgroundColor: "#f9f7f3d2",
    padding: 7,
    flexDirection: "row",
    alignItems: "center",
  },
  statusBadge: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "#ff934f",
    alignItems: "center",
    justifyContent: "center",
  },
  statusBadgeNum: { color: "#2d2b2b", fontWeight: "900" },
  statusText: { marginLeft: 10, color: "#2d2c33", fontSize: 15, fontWeight: "600" },
  statusStripMinera: { backgroundColor: "#e7dad4", borderColor: "#efe5e1" },
  statusBadgeMinera: { backgroundColor: "#ff984b" },
  statusBadgeNumMinera: { color: "#2b2f3b" },
  statusTextMinera: { color: "#2d313d" },
  statusBadgeMidnight: { backgroundColor: "#435085" },
  statusBadgeNumMidnight: { color: "#f4f7ff" },
  statusStripNeo: { backgroundColor: "#eeeeee", borderColor: "#b8b8b8" },
  statusBadgeNeo: { backgroundColor: "#9f9f9f" },
  statusBadgeNumNeo: { color: "#fff" },
  statusTextNeo: { color: "#232323" },
  statusBadgeVitaria: { backgroundColor: "#ff8f7a" },
  statusBadgeNumVitaria: { color: "#2f1120" },
  statusBadgeInferno: { backgroundColor: "#ff7b2f" },
  statusBadgeNumInferno: { color: "#2a1306" },
  statusStripEmerald: { backgroundColor: "#eaf5ee", borderColor: "#9fceb2" },
  statusBadgeEmerald: { backgroundColor: "#1f6b42" },
  statusBadgeNumEmerald: { color: "#e9ffee" },
  statusTextEmerald: { color: "#1f593a" },
  premiumCard: {
    marginTop: 12,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "#d8d9e2",
    backgroundColor: "#fcfcff",
    padding: 14,
  },
  premiumCardTitle: { color: "#252936", fontSize: 26, fontWeight: "900", letterSpacing: -0.5, flexShrink: 1 },
  premiumCardSub: { marginTop: 4, color: "#6a6f7b", fontSize: 16, fontWeight: "500" },
  premiumCardFooter: { marginTop: 14, flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  premiumCardMetric: { color: "#292f3f", fontSize: 18, fontWeight: "700" },
  premiumCardMinera: { backgroundColor: "#e7e8ed", borderColor: "#c9ceda" },
  premiumCardTitleMinera: { color: "#252a3d" },
  premiumCardSubMinera: { color: "#6a7080" },
  premiumCardMetricMinera: { color: "#2b3044" },
  premiumCardNeo: { backgroundColor: "#efefef", borderColor: "#b6b6b6" },
  premiumCardTitleNeo: { color: "#181818" },
  premiumCardSubNeo: { color: "#4f4f4f" },
  premiumCardMetricNeo: { color: "#191919" },
  darkPillBtn: {
    height: 42,
    paddingHorizontal: 18,
    borderRadius: 999,
    backgroundColor: "#2f3138",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#14171e",
    shadowOpacity: 0.22,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
  },
  darkPillBtnText: { color: "#fff", fontWeight: "700", fontSize: 15 },
  darkPillBtnMinera: { backgroundColor: "#2f3341", shadowColor: "#161925" },
  darkPillBtnTextMinera: { color: "#ffffff" },
  viewEventsBtn: {
    backgroundColor: "#f28b43",
    shadowColor: "#b86025",
  },
  viewEventsBtnText: { color: "#ffffff" },
  serviceGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  serviceChip: {
    borderRadius: 999,
    backgroundColor: "#f8f9fc",
    borderWidth: 1,
    borderColor: "#e2e5ee",
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  serviceChipText: { color: "#3b4252", fontSize: 13, fontWeight: "600" },
  serviceChipTextDark: { color: "#ecf1ff" },
  serviceChipTextNeo: { color: "#2d2d2d" },
  eventsShowcaseCard: {
    width: 220,
    borderRadius: 18,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e5e8f0",
    marginRight: 10,
    overflow: "hidden",
  },
  eventsShowcasePoster: { width: "100%", height: 120, backgroundColor: "#edf0f6" },
  eventsShowcaseTitle: { paddingHorizontal: 11, paddingTop: 10, color: "#1f293d", fontSize: 15, fontWeight: "800" },
  eventsShowcaseMeta: { paddingHorizontal: 11, paddingVertical: 9, color: "#667189", fontSize: 12, fontWeight: "600" },
  eventsShowcaseTitleDark: { color: "#f4f7ff" },
  eventsShowcaseTitleNeo: { color: "#191919" },
  eventsShowcaseMetaDark: { color: "#c5cee8" },
  eventsShowcaseMetaNeo: { color: "#4f4f4f" },
  hospitalTopBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  hospitalTopTitle: { color: "#1f2430", fontSize: 22, fontWeight: "900", letterSpacing: -0.4, flexShrink: 1 },
  hospitalTopTitleDark: { color: "#f4f7ff" },
  hospitalTopTitleNeo: { color: "#151515" },
  exploreTopSub: { marginTop: 2, color: "#6c7893", fontSize: 13, fontWeight: "600" },
  exploreTopSubDark: { color: "#b8c3de" },
  exploreTopSubNeo: { color: "#5a5a5a" },
  exploreQuickStrip: { marginBottom: 10 },
  exploreFilterCard: { gap: 6 },
  exploreFilterLabel: { fontSize: 12, color: "#7a859c", fontWeight: "700", marginTop: 2 },
  exploreFilterLabelDark: { color: "#adbad8" },
  exploreFilterLabelNeo: { color: "#666666" },
  exploreFilterRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, alignItems: "stretch" },
  exploreFilterCol: { flex: 1 },
  exploreFilterActions: { flexDirection: "row", alignItems: "center", gap: 10, marginTop: 2 },
  exploreFilterApplyBtn: { flex: 1, marginTop: 0 },
  exploreFilterResetBtn: { width: 82, height: 46, borderRadius: 12 },
  exploreFilterResetText: { color: "#4b556b", fontSize: 14, fontWeight: "700" },
  exploreMasjidLabel: { marginTop: 4, marginBottom: 1 },
  iconCircleBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    borderColor: "#dce0ea",
    backgroundColor: "#f8f9fc",
    alignItems: "center",
    justifyContent: "center",
  },
  iconCircleText: { color: "#2f3543", fontSize: 18, fontWeight: "700" },
  topPillControl: {
    flexDirection: "row",
    gap: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#dce0ea",
    backgroundColor: "#f8f9fc",
    paddingHorizontal: 8,
    paddingVertical: 6,
  },
  iconCircleBtnSmall: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  mapPanel: {
    borderRadius: 28,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#d9dde7",
    marginBottom: 12,
  },
  mapPanelMidnight: { borderColor: "#23273a", backgroundColor: "#0f1220" },
  mapPanelNeo: { borderColor: "#b7b7b7", backgroundColor: "#d2d2d2" },
  mapPanelVitaria: { borderColor: "rgba(255,255,255,0.22)", backgroundColor: "rgba(67,33,76,0.45)" },
  mapPanelInferno: { borderColor: "rgba(255,127,42,0.28)", backgroundColor: "rgba(28,10,4,0.72)" },
  mapPanelBg: { height: 300 },
  mapFeaturedCard: {
    position: "absolute",
    left: 16,
    right: 16,
    top: 16,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "#e2e5ee",
    backgroundColor: "#fbfcff",
    overflow: "hidden",
  },
  mapFeaturedPoster: { width: "100%", height: 170, backgroundColor: "#eceff5" },
  mapFeaturedContent: { padding: 12 },
  mapTag: {
    alignSelf: "flex-start",
    borderRadius: 999,
    backgroundColor: "#ffd4b4",
    color: "#5f3a1f",
    paddingHorizontal: 10,
    paddingVertical: 4,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "capitalize",
  },
  mapFeaturedTitle: { marginTop: 8, color: "#1e2431", fontSize: 19, fontWeight: "900", letterSpacing: -0.3, flexShrink: 1 },
  mapFeaturedMeta: { marginTop: 5, color: "#6a7389", fontSize: 13, fontWeight: "600" },
  mapFeaturedTitleDark: { color: "#f7f9ff" },
  mapFeaturedTitleNeo: { color: "#171717" },
  mapFeaturedMetaDark: { color: "#c7d0ea" },
  mapFeaturedMetaNeo: { color: "#555" },
  mapFeaturedActions: { marginTop: 11, flexDirection: "row", gap: 10, alignItems: "center" },
  mapCanvasWrap: {
    marginTop: 10,
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#d7deeb",
    backgroundColor: "#edf2fa",
  },
  mapCanvas: { width: "100%", height: 320 },
  mapClusterPin: {
    minWidth: 36,
    height: 36,
    borderRadius: 999,
    paddingHorizontal: 10,
    borderWidth: 2,
    borderColor: "#fff8ef",
    backgroundColor: "#ff7d50",
    alignItems: "center",
    justifyContent: "center",
  },
  mapClusterPinText: { color: "#fffdf8", fontWeight: "900", fontSize: 13 },
  mapSinglePin: {
    width: 28,
    height: 28,
    borderRadius: 999,
    borderWidth: 2,
    borderColor: "#fff8ef",
    backgroundColor: "#ffb282",
    alignItems: "center",
    justifyContent: "center",
  },
  mapSinglePinText: { fontSize: 13 },
  mapMasjidMarker: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#1c4f82",
    borderRadius: 16,
    paddingHorizontal: 9,
    paddingVertical: 7,
    borderWidth: 2,
    borderColor: "#fffdf6",
    shadowColor: "#000",
    shadowOpacity: 0.2,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
    elevation: 3,
  },
  mapMasjidMarkerDim: { backgroundColor: "#6b778c" },
  mapMasjidEmoji: { fontSize: 17 },
  mapMasjidPinWrap: { alignItems: "center", justifyContent: "flex-end" },
  mapMasjidLogo: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#fffdf6",
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
  mapMasjidLogoText: {
    color: "#fffdf8",
    fontSize: 13,
    fontWeight: "900",
    letterSpacing: 0.5,
    textAlign: "center",
    paddingHorizontal: 3,
  },
  mapMasjidPinTail: {
    width: 0,
    height: 0,
    marginTop: -2,
    borderLeftWidth: 6,
    borderRightWidth: 6,
    borderTopWidth: 9,
    borderLeftColor: "transparent",
    borderRightColor: "transparent",
  },
  mapMasjidBadge: {
    position: "absolute",
    right: -8,
    top: -8,
    minWidth: 22,
    paddingHorizontal: 5,
    paddingVertical: 2,
    borderRadius: 11,
    backgroundColor: "#e85d3b",
    borderWidth: 2,
    borderColor: "#fffdf6",
    alignItems: "center",
  },
  mapMasjidBadgeText: { color: "#fffdf8", fontSize: 11, fontWeight: "900" },
  mapCallout: { maxWidth: 220 },
  mapCalloutTitle: { color: "#16253d", fontSize: 13, fontWeight: "800" },
  mapCalloutSub: { marginTop: 3, color: "#556683", fontSize: 12, fontWeight: "600" },
  exploreCardMetaLine: { marginTop: 6, color: "#6f7a91", fontSize: 12, fontWeight: "700" },
  exploreCardMetaLineDark: { color: "#bfc9e3" },
  exploreCardMetaLineNeo: { color: "#5a5a5a" },
  exploreListWhen: { color: "#3d4a63", fontSize: 12, fontWeight: "800", letterSpacing: 0.2 },
  exploreListWhenDark: { color: "#c5d0ec" },
  exploreListWhenNeo: { color: "#4a4a4a" },
  exploreListTopic: { marginTop: 5, color: "#4a5568", fontSize: 13, fontWeight: "600", lineHeight: 18 },
  exploreListTopicDark: { color: "#aeb9d6" },
  exploreListTopicNeo: { color: "#555" },
  exploreListSpeaker: { marginTop: 4, color: "#5c6783", fontSize: 12, fontWeight: "700" },
  roundGhostBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    borderColor: "#dde2ec",
    backgroundColor: "#f5f7fb",
    alignItems: "center",
    justifyContent: "center",
  },
  roundGhostText: { fontSize: 17 },
  hospitalListCard: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#e2e5ee",
    backgroundColor: "#fff",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 10,
    marginBottom: 8,
  },
  hospitalListPoster: { width: 80, height: 64, borderRadius: 12, backgroundColor: "#edf0f6" },
  hospitalListTitle: { marginTop: 6, color: "#222938", fontSize: 17, fontWeight: "800" },
  hospitalListMeta: { marginTop: 2, color: "#6f7890", fontSize: 12, fontWeight: "600" },
  hospitalListTitleDark: { color: "#eef3ff" },
  hospitalListTitleNeo: { color: "#181818" },
  hospitalListMetaDark: { color: "#c6cfe8" },
  hospitalListMetaNeo: { color: "#545454" },
  container: { flex: 1, width: "100%", backgroundColor: "#eceef2" },
  containerMidnight: { backgroundColor: "#080a12" },
  containerNeo: { backgroundColor: "#d4d4d4" },
  containerVitaria: { backgroundColor: "#7f6672" },
  containerInferno: { backgroundColor: "#050405" },
  containerEmerald: { backgroundColor: "#c7e6d1" },
  topBar: {
    marginHorizontal: 12,
    marginTop: 8,
    marginBottom: 8,
    paddingHorizontal: 14,
    paddingVertical: 12,
    height: 116,
    backgroundColor: "#f8f9fc",
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#dde1ea",
  },
  topBarBrandRow: { alignItems: "center", justifyContent: "center", flex: 1 },
  topBarWordmark: { width: "100%", height: "100%", alignSelf: "center" },
  tabSceneWrap: { flex: 1 },
  scrollBody: { width: "100%", maxWidth: "100%", paddingHorizontal: 12, paddingBottom: 96, gap: 10, flexGrow: 1 },
  scrollBodyMidnight: { backgroundColor: "#080a12" },
  scrollBodyNeo: { backgroundColor: "#d4d4d4" },
  scrollBodyVitaria: { backgroundColor: "#7f6672" },
  scrollBodyInferno: { backgroundColor: "#050405" },
  scrollBodyEmerald: { backgroundColor: "#c7e6d1" },
  topBarMidnight: { backgroundColor: "#111424", borderColor: "#23273a" },
  topBarNeo: { backgroundColor: "#d8d8d8", borderColor: "#b9b9b9", borderRadius: 12 },
  topBarVitaria: { backgroundColor: "rgba(255,255,255,0.14)", borderColor: "rgba(255,255,255,0.26)" },
  topBarInferno: { backgroundColor: "rgba(30,10,5,0.62)", borderColor: "rgba(255,133,56,0.24)" },
  topBarEmerald: { backgroundColor: "#e0f2e7", borderColor: "#8fc6a7" },
  showcaseRow: {
    marginBottom: 8,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  showcaseTag: {
    fontSize: 12,
    fontWeight: "700",
    color: "#5f7397",
    backgroundColor: "#eaf2ff",
    borderWidth: 1,
    borderColor: "#d7e6ff",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  showcaseDate: { fontSize: 13, color: "#6a7da1", fontWeight: "600" },
  controlsCard: {
    backgroundColor: "#f7f8fc",
    borderRadius: 22,
    padding: 14,
    borderWidth: 1,
    borderColor: "#dde1ea",
    shadowColor: "#1f2430",
    shadowOpacity: 0.07,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  controlsCardMidnight: { backgroundColor: "#111424", borderColor: "#23273a" },
  controlsCardNeo: { backgroundColor: "#d8d8d8", borderColor: "#b9b9b9", borderRadius: 14, shadowOpacity: 0.02 },
  controlsCardVitaria: {
    backgroundColor: "rgba(255,255,255,0.14)",
    borderColor: "rgba(255,255,255,0.24)",
    shadowColor: "#24152f",
    shadowOpacity: 0.2,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
  controlsCardInferno: {
    backgroundColor: "rgba(28,10,4,0.66)",
    borderColor: "rgba(255,133,56,0.22)",
    shadowColor: "#000",
    shadowOpacity: 0.34,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 7 },
  },
  controlsCardEmerald: {
    backgroundColor: "#e5f5ea",
    borderColor: "#9fceb2",
    shadowColor: "#3d7b57",
    shadowOpacity: 0.1,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
  sectionTitle: { fontSize: 18, fontWeight: "900", color: "#1f2430", marginBottom: 10, letterSpacing: -0.2 },
  metaInfoLine: { color: "#5d667b", fontSize: 13, lineHeight: 20, marginTop: 2, fontWeight: "500" },
  sectionTitleMinera: { color: "#cf762f", fontFamily: MINERA_FONT_BOLD, fontWeight: "700", letterSpacing: 0 },
  metaInfoLineMinera: { color: "#4f6380", fontFamily: MINERA_FONT_REGULAR, fontWeight: "500" },
  sectionTitleEmerald: { color: "#0f5130" },
  metaInfoLineEmerald: { color: "#2f6f4a" },
  sectionTitleMidnight: { color: "#f4f7ff" },
  metaInfoLineMidnight: { color: "#9aa3bc" },
  sectionTitleNeo: { color: "#101010", letterSpacing: -0.7 },
  metaInfoLineNeo: { color: "#4f4f4f" },
  sectionTitleVitaria: { color: "#ffffff" },
  metaInfoLineVitaria: { color: "rgba(255,255,255,0.82)" },
  sectionTitleInferno: { color: "#fff4e8" },
  metaInfoLineInferno: { color: "rgba(255,195,162,0.86)" },
  smallWhyText: { color: "#6c758a", fontSize: 12, lineHeight: 18, marginBottom: 6, marginTop: 2 },
  premiumSectionHeader: {
    borderRadius: 22,
    borderWidth: 1,
    borderColor: "#d8dce7",
    padding: 14,
  },
  premiumSectionTitle: { color: "#1f2430", fontSize: 22, fontWeight: "900", letterSpacing: -0.3 },
  premiumSectionSub: { marginTop: 4, color: "#666f84", fontSize: 14, lineHeight: 20, fontWeight: "500" },
  premiumSectionTitleDark: { color: "#f4f7ff" },
  premiumSectionTitleNeo: { color: "#151515" },
  premiumSectionSubDark: { color: "#c2cce6" },
  premiumSectionSubNeo: { color: "#4d4d4d" },
  nextRow: {
    borderWidth: 1,
    borderColor: "#e2ebfa",
    borderRadius: 12,
    padding: 10,
    marginBottom: 8,
    backgroundColor: "#fbfdff",
  },
  nextTitle: { color: "#173664", fontSize: 15, fontWeight: "700" },
  nextMeta: { color: "#60789f", fontSize: 12, marginTop: 4, fontWeight: "600" },
  secondaryBtn: {
    height: 42,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#bcd2ff",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#eef5ff",
  },
  secondaryBtnText: { color: "#2a4b7e", fontWeight: "700", fontSize: 14 },
  themeButtonGrid: { marginTop: 8, flexDirection: "row", flexWrap: "wrap", gap: 8 },
  themeSelectBtn: {
    width: "48%",
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#cbd4e6",
    backgroundColor: "#f6f9ff",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  themeSelectBtnDark: { backgroundColor: "rgba(255,255,255,0.08)", borderColor: "rgba(255,255,255,0.2)" },
  themeSelectBtnActive: { backgroundColor: "#dce7ff", borderColor: "#9cb8ea" },
  themeSelectBtnActiveEmerald: { backgroundColor: "#d1ead9", borderColor: "#86bd9f" },
  themeSelectBtnText: { color: "#2d4f84", fontSize: 13, fontWeight: "700", textAlign: "center" },
  themeSelectBtnTextDark: { color: "#f2f6ff" },
  themeSelectBtnTextActive: { color: "#193c73" },
  themeSelectBtnTextActiveEmerald: { color: "#16563a" },
  utilityActionsWrap: { marginTop: 12, flexDirection: "row", flexWrap: "wrap", gap: 8 },
  utilityActionBtn: {
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#d2d8e7",
    backgroundColor: "#f7f9fd",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    flexGrow: 1,
  },
  utilityActionBtnText: { color: "#314d77", fontSize: 13, fontWeight: "700", textAlign: "center" },
  utilityActionBtnDark: { backgroundColor: "rgba(255,255,255,0.08)", borderColor: "rgba(255,255,255,0.2)" },
  utilityActionBtnTextDark: { color: "#f2f6ff" },
  calendarActionRow: { marginTop: 10, flexDirection: "row", flexWrap: "wrap", gap: 8 },
  calendarViewSwitch: {
    flexDirection: "row",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#d8deeb",
    backgroundColor: "#f7f9fe",
    padding: 4,
    marginBottom: 10,
  },
  calendarViewSwitchDark: { borderColor: "#2b334b", backgroundColor: "#0f1423" },
  calendarViewChip: {
    flex: 1,
    borderRadius: 10,
    minHeight: 38,
    alignItems: "center",
    justifyContent: "center",
  },
  calendarViewChipActive: { backgroundColor: "#ffffff", borderWidth: 1, borderColor: "#cfd8eb" },
  calendarViewChipText: { color: "#4f5d79", fontSize: 13, fontWeight: "700" },
  calendarViewChipTextActive: { color: "#202a40" },
  calendarWeekRow: { flexDirection: "row", marginTop: 4, marginBottom: 8 },
  calendarWeekday: { flex: 1, textAlign: "center", color: "#7b879d", fontSize: 12, fontWeight: "700" },
  calendarWeekdayDark: { color: "#afbbd7" },
  calendarWeekdayNeo: { color: "#616161" },
  calendarGrid: { flexDirection: "row", flexWrap: "wrap" },
  calendarDay: {
    width: "14.285%",
    aspectRatio: 1,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#dbe1ee",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f8fafe",
    marginBottom: 8,
  },
  calendarDayHasEvents: { borderColor: "#f9a77f", backgroundColor: "#fff0e8" },
  calendarDayHasEventsDark: { borderColor: "#5a66a5", backgroundColor: "#1a223b" },
  calendarDayHasEventsNeo: { borderColor: "#b6b6b6", backgroundColor: "#ececec" },
  calendarDayActive: { borderColor: "#ff7d50", borderWidth: 2, backgroundColor: "#ffd8c6" },
  calendarDayText: { color: "#4e5c77", fontSize: 13, fontWeight: "700" },
  calendarDayTextStrong: { color: "#2d3345" },
  calendarDayTextActive: { color: "#5c250f", fontWeight: "900" },
  calendarDayTextDark: { color: "#d2dbf3" },
  calendarDayDot: {
    position: "absolute",
    bottom: 4,
    width: 5,
    height: 5,
    borderRadius: 999,
    backgroundColor: "#ff7d50",
  },
  calendarDayDotActive: { backgroundColor: "#a2401f" },
  calendarDayEmpty: { width: "14.285%", aspectRatio: 1, marginBottom: 8 },
  calendarMiniRow: {
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#dfe5f1",
    backgroundColor: "#f9fbff",
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  calendarMiniTitle: { color: "#222b40", fontSize: 15, fontWeight: "800" },
  calendarMiniMeta: { marginTop: 3, color: "#6b7894", fontSize: 12, fontWeight: "600" },
  calendarDayModalBackdrop: {
    flex: 1,
    backgroundColor: "rgba(8, 10, 18, 0.45)",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  calendarDayModalCard: {
    borderRadius: 18,
    backgroundColor: "#ffffff",
    padding: 14,
    maxHeight: "78%",
  },
  themeChipRow: { marginTop: 8, flexDirection: "row", flexWrap: "wrap", gap: 8 },
  themeChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#d6deed",
    backgroundColor: "#f5f8ff",
    paddingHorizontal: 12,
    paddingVertical: 7,
  },
  themeChipInferno: { backgroundColor: "rgba(255,128,42,0.2)", borderColor: "rgba(255,150,80,0.38)" },
  themeChipMidnight: { backgroundColor: "#212844", borderColor: "#313a5a" },
  themeChipText: { color: "#2c4d80", fontSize: 12, fontWeight: "700" },
  themeChipTextInferno: { color: "#ffe5d0" },
  themeChipTextMidnight: { color: "#dbe3ff" },
  themeMetricRow: { marginTop: 6, flexDirection: "row", gap: 8 },
  themeMetricCard: {
    flex: 1,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#dce2ef",
    backgroundColor: "#f8faff",
    alignItems: "center",
    paddingVertical: 12,
  },
  themeMetricCardVitaria: { backgroundColor: "rgba(255,255,255,0.16)", borderColor: "rgba(255,255,255,0.28)" },
  themeMetricCardNeo: { backgroundColor: "#ececec", borderColor: "#b8b8b8" },
  themeMetricCardEmerald: { backgroundColor: "#e6f3ea", borderColor: "#b3d1bf" },
  themeMetricValue: { color: "#1f3f70", fontSize: 24, fontWeight: "900" },
  themeMetricValueVitaria: { color: "#fff" },
  themeMetricValueNeo: { color: "#191919" },
  themeMetricValueEmerald: { color: "#1f5f3d" },
  themeMetricLabel: { marginTop: 4, color: "#55729f", fontSize: 12, fontWeight: "600" },
  themeMetricLabelVitaria: { color: "rgba(255,255,255,0.85)" },
  themeMetricLabelNeo: { color: "#4a4a4a" },
  themeMetricLabelEmerald: { color: "#3d6f54" },
  homeStatsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 8 },
  statTile: {
    width: "48.8%",
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#dfe7f5",
    borderRadius: 16,
    paddingVertical: 12,
    paddingHorizontal: 12,
  },
  statLabel: { fontSize: 12, color: "#6b7ea1", fontWeight: "600" },
  statValue: { marginTop: 6, fontSize: 22, color: "#173664", fontWeight: "800" },
  statValueSmall: { marginTop: 8, fontSize: 16, color: "#173664", fontWeight: "700", textTransform: "capitalize" },
  featuredCard: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 12,
    borderWidth: 1,
    borderColor: "#dfe7f5",
    marginBottom: 10,
  },
  featuredHeaderRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  featuredLabel: { fontSize: 12, color: "#5b7299", fontWeight: "800", letterSpacing: 0.4 },
  featuredOpenBtn: {
    borderWidth: 1,
    borderColor: "#d5e3ff",
    borderRadius: 999,
    backgroundColor: "#eef4ff",
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  featuredOpenText: { color: "#234f99", fontWeight: "700", fontSize: 12 },
  featuredPoster: { width: "100%", height: 220, borderRadius: 12, backgroundColor: "#eef4ff", marginTop: 8 },
  featuredPosterFallback: {
    width: "100%",
    height: 220,
    borderRadius: 12,
    backgroundColor: "#eef4ff",
    marginTop: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  featuredTitle: { marginTop: 10, fontSize: 19, fontWeight: "800", color: "#11274c" },
  featuredMeta: { marginTop: 6, color: "#60789f", fontSize: 13, fontWeight: "600" },
  row: { flexDirection: "row", gap: 8 },
  input: {
    height: 44,
    borderWidth: 1,
    borderColor: "#d7dce8",
    borderRadius: 14,
    paddingHorizontal: 10,
    backgroundColor: "#fdfdff",
    color: "#1f2430",
    marginBottom: 8,
  },
  inputMidnight: { backgroundColor: "#0d1020", borderColor: "#2a3047", color: "#e9edff" },
  inputNeo: { backgroundColor: "#cfcfcf", borderColor: "#ababab", color: "#0f0f0f", borderRadius: 10 },
  inputVitaria: {
    backgroundColor: "rgba(255,255,255,0.18)",
    borderColor: "rgba(255,255,255,0.28)",
    color: "#fff",
  },
  inputInferno: {
    backgroundColor: "rgba(17,9,7,0.85)",
    borderColor: "rgba(255,125,65,0.25)",
    color: "#fff2e8",
  },
  inputEmerald: {
    backgroundColor: "#eef9f1",
    borderColor: "#9fceb2",
    color: "#1b5f3b",
  },
  half: { flex: 1 },
  presetEditorRow: { flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 8 },
  presetEditorInput: { flex: 1, marginBottom: 0 },
  presetEditorSaveBtn: { height: 44, borderRadius: 12, paddingHorizontal: 14 },
  sourceStrip: { marginBottom: 10 },
  sourceChip: {
    height: 32,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#d7dce8",
    paddingHorizontal: 10,
    justifyContent: "center",
    marginRight: 8,
    backgroundColor: "#f7f8fc",
  },
  sourceChipActive: { backgroundColor: "#eef2fb", borderColor: "#bcc5db" },
  sourceChipText: { color: "#5c657a", fontSize: 12, fontWeight: "700" },
  sourceChipTextActive: { color: "#222938" },
  generalChipActive: { backgroundColor: "#eceff6", borderColor: "#c5cad8" },
  generalChipTextActive: { color: "#222938" },
  sistersChipActive: { backgroundColor: "#fdefff", borderColor: "#e6c4ee" },
  sistersChipTextActive: { color: "#7a2e7f" },
  brothersChipActive: { backgroundColor: "#e8f3ff", borderColor: "#bcd7f5" },
  brothersChipTextActive: { color: "#2f5f97" },
  familyChipActive: { backgroundColor: "#fff3df", borderColor: "#f1d6a7" },
  familyChipTextActive: { color: "#8a6420" },
  primaryBtn: {
    height: 44,
    borderRadius: 10,
    backgroundColor: "#0f6fff",
    alignItems: "center",
    justifyContent: "center",
  },
  primaryBtnText: { color: "#fff", fontWeight: "800", fontSize: 15 },
  pills: { flexDirection: "row", gap: 8, marginTop: 10, marginBottom: 6 },
  pill: { backgroundColor: "#fff", borderWidth: 1, borderColor: "#e2ebfa", borderRadius: 999, paddingHorizontal: 12, paddingVertical: 7 },
  pillText: { color: "#5b7299", fontSize: 12, fontWeight: "600" },
  dayHeader: { marginTop: 14, marginBottom: 8, color: "#1d3866", fontWeight: "800", fontSize: 14 },
  dayHeaderDark: { color: "#dbe5ff" },
  dayHeaderNeo: { color: "#2e2e2e" },
  eventCard: {
    backgroundColor: "#fff",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#e2ebfa",
    marginBottom: 10,
    overflow: "hidden",
  },
  eventCardCompact: {
    backgroundColor: "#fff",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e2ebfa",
    marginBottom: 10,
    overflow: "hidden",
    flexDirection: "row",
  },
  posterCompact: { width: 88, height: 88, backgroundColor: "#eef4ff" },
  posterCompactFallback: { width: 88, height: 88, backgroundColor: "#eef4ff", alignItems: "center", justifyContent: "center" },
  eventBodyCompact: { flex: 1, minWidth: 0, padding: 10 },
  eventTitleCompact: { fontSize: 14, fontWeight: "800", color: "#11274c", flexShrink: 1 },
  poster: { width: "100%", height: 180, backgroundColor: "#eef4ff" },
  posterFallback: { height: 120, backgroundColor: "#eef4ff", alignItems: "center", justifyContent: "center" },
  posterFallbackText: { fontSize: 36, color: "#8aa0c4" },
  eventBody: { padding: 12 },
  eventTitle: { fontSize: 17, fontWeight: "800", color: "#11274c", flexShrink: 1, maxWidth: "100%" },
  eventMeta: { marginTop: 4, color: "#60789f", fontSize: 12, fontWeight: "600" },
  eventAudience: { marginTop: 6, color: "#345b91", fontSize: 12, fontWeight: "700" },
  eventSpeaker: { marginTop: 8, color: "#1e3f71", fontSize: 13, fontWeight: "600" },
  eventDesc: { marginTop: 8, color: "#2d456b", fontSize: 13, lineHeight: 19 },
  eventWhere: { marginTop: 8, color: "#4a6188", fontSize: 12 },
  emptyCard: {
    marginTop: 16,
    backgroundColor: "#fff",
    borderColor: "#cbdaf3",
    borderWidth: 1,
    borderStyle: "dashed",
    borderRadius: 12,
    padding: 14,
  },
  emptyText: { color: "#5e759b", textAlign: "center" },
  emptyTextDark: { color: "#c4cde8" },
  emptyTextNeo: { color: "#565656" },
  errorText: { color: "#a02f2f", marginTop: 12, textAlign: "center", fontWeight: "600" },
  tabBar: {
    position: "absolute",
    left: 10,
    right: 10,
    bottom: 12,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "#d9dde7",
    backgroundColor: "#f8f9fc",
    flexDirection: "row",
    padding: 8,
    gap: 6,
  },
  tabBarMidnight: { backgroundColor: "#111424", borderColor: "#23273a" },
  tabBarNeo: { backgroundColor: "#d8d8d8", borderColor: "#b9b9b9", borderRadius: 16 },
  tabBarVitaria: { backgroundColor: "rgba(43,18,57,0.58)", borderColor: "rgba(255,255,255,0.2)" },
  tabBarInferno: { backgroundColor: "rgba(18,8,6,0.92)", borderColor: "rgba(255,126,50,0.2)" },
  tabBarEmerald: { backgroundColor: "#e0f2e7", borderColor: "#8fc6a7" },
  tabBtn: {
    flex: 1,
    height: 46,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  tabBtnActive: { backgroundColor: "#ff7d50" },
  tabBtnActiveMidnight: { backgroundColor: "#ff7d50" },
  tabBtnActiveNeo: { backgroundColor: "#ff7d50" },
  tabBtnActiveVitaria: { backgroundColor: "#ff7d50" },
  tabBtnActiveInferno: { backgroundColor: "#ff7d50" },
  tabBtnActiveEmerald: { backgroundColor: "#ff7d50" },
  tabIcon: { color: "#8a92a4", fontSize: 14, marginBottom: 2 },
  tabIconMidnight: { color: "#6f7897" },
  tabIconNeo: { color: "#4a4a4a" },
  tabIconVitaria: { color: "rgba(255,255,255,0.82)" },
  tabIconInferno: { color: "rgba(255,195,162,0.86)" },
  tabIconEmerald: { color: "#2f6f4a" },
  tabIconActive: { color: "#fff8f2" },
  tabIconActiveInferno: { color: "#fffaf6" },
  tabIconActiveEmerald: { color: "#fff8f2" },
  tabText: { color: "#7a8397", fontWeight: "700", fontSize: 11 },
  tabTextMidnight: { color: "#8f97b2" },
  tabTextNeo: { color: "#4a4a4a" },
  tabTextVitaria: { color: "rgba(255,255,255,0.82)" },
  tabTextInferno: { color: "rgba(255,195,162,0.86)" },
  tabTextEmerald: { color: "#2f6f4a" },
  tabTextActive: { color: "#fff8f2" },
  tabTextActiveInferno: { color: "#fffaf6" },
  tabTextActiveEmerald: { color: "#fff8f2" },
  placeholderWrap: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  placeholderTitle: { fontSize: 24, fontWeight: "800", color: "#173664" },
  placeholderSub: { marginTop: 10, textAlign: "center", color: "#5f759d", lineHeight: 20 },
  modalContainer: { flex: 1, backgroundColor: "#eceef2" },
  modalContainerMidnight: { backgroundColor: "#080a12" },
  modalContainerNeo: { backgroundColor: "#d4d4d4" },
  modalContainerVitaria: { backgroundColor: "#7f6672" },
  modalContainerInferno: { backgroundColor: "#050405" },
  modalContainerEmerald: { backgroundColor: "#c7e6d1" },
  modalTop: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: "#d9dde7",
    backgroundColor: "#f8f9fc",
  },
  modalTopMidnight: { backgroundColor: "#111424", borderBottomColor: "#23273a" },
  modalTopNeo: { backgroundColor: "#d8d8d8", borderBottomColor: "#b9b9b9" },
  modalTopVitaria: { backgroundColor: "rgba(255,255,255,0.14)", borderBottomColor: "rgba(255,255,255,0.24)" },
  modalTopInferno: { backgroundColor: "rgba(30,10,5,0.62)", borderBottomColor: "rgba(255,133,56,0.24)" },
  modalTopEmerald: { backgroundColor: "#e0f2e7", borderBottomColor: "#8fc6a7" },
  modalTitle: { fontSize: 19, fontWeight: "900", color: "#1f2430" },
  modalTitleMidnight: { color: "#f4f7ff" },
  modalTitleNeo: { color: "#101010", letterSpacing: -0.5 },
  modalTitleVitaria: { color: "#fff" },
  modalTitleInferno: { color: "#fff4e8" },
  modalTitleEmerald: { color: "#0f5130" },
  modalCloseBtn: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#d5daea",
    paddingHorizontal: 10,
    paddingVertical: 6,
    backgroundColor: "#f2f4fa",
  },
  modalCloseBtnMidnight: { backgroundColor: "#1a2035", borderColor: "#2a3047" },
  modalCloseBtnNeo: { backgroundColor: "#c9c9c9", borderColor: "#9e9e9e" },
  modalCloseBtnVitaria: { backgroundColor: "rgba(255,255,255,0.2)", borderColor: "rgba(255,255,255,0.28)" },
  modalCloseBtnInferno: { backgroundColor: "rgba(255,115,44,0.22)", borderColor: "rgba(255,138,66,0.35)" },
  modalCloseBtnEmerald: { backgroundColor: "#cfe9da", borderColor: "#8fc6a7" },
  modalCloseText: { color: "#454f63", fontWeight: "700" },
  modalCloseTextMidnight: { color: "#d2d8ef" },
  modalCloseTextNeo: { color: "#111" },
  modalCloseTextVitaria: { color: "#fff" },
  modalCloseTextInferno: { color: "#ffeede" },
  modalCloseTextEmerald: { color: "#1b5f3b" },
  modalBody: { padding: 12, paddingBottom: 28, gap: 4 },
  modalPoster: { width: "100%", height: 330, borderRadius: 18, backgroundColor: "#edf0f6" },
  modalPosterFallback: {
    width: "100%",
    height: 280,
    borderRadius: 18,
    backgroundColor: "#edf0f6",
    alignItems: "center",
    justifyContent: "center",
  },
  modalEventTitle: { marginTop: 12, fontSize: 25, fontWeight: "900", color: "#1f2430", letterSpacing: -0.4 },
  modalMeta: { marginTop: 8, color: "#616b80", fontSize: 14, fontWeight: "600" },
  modalAudience: { marginTop: 8, color: "#424b5f", fontSize: 14, fontWeight: "700", textTransform: "capitalize" },
  modalExplainLabel: { marginTop: 12, color: "#2a3243", fontSize: 14, fontWeight: "900" },
  modalExplanation: { marginTop: 6, color: "#505a70", fontSize: 15, lineHeight: 22 },
  modalLine: { marginTop: 8, color: "#505a70", fontSize: 14, lineHeight: 20 },
  modalEventTitleDark: { color: "#f4f7ff" },
  modalEventTitleNeo: { color: "#181818" },
  modalMetaDark: { color: "#c4cee8" },
  modalMetaNeo: { color: "#535353" },
  modalAudienceDark: { color: "#d2dcfa" },
  modalAudienceNeo: { color: "#404040" },
  modalExplainLabelDark: { color: "#f4f7ff" },
  modalExplainLabelNeo: { color: "#1f1f1f" },
  modalExplanationDark: { color: "#d0d8ef" },
  modalExplanationNeo: { color: "#4f4f4f" },
  modalLineDark: { color: "#cdd5ed" },
  modalLineNeo: { color: "#505050" },
  modalActionsRow: { marginTop: 10, flexDirection: "row", flexWrap: "wrap", gap: 8 },
  modalActionBtn: {
    minHeight: 40,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#cfd8ea",
    backgroundColor: "#f6f9ff",
    paddingHorizontal: 12,
    paddingVertical: 9,
    alignItems: "center",
    justifyContent: "center",
    minWidth: 96,
  },
  modalActionBtnPrimary: { backgroundColor: "#e4ecfb", borderColor: "#a9bfe3" },
  modalActionBtnDark: { backgroundColor: "rgba(255,255,255,0.08)", borderColor: "rgba(255,255,255,0.22)" },
  modalActionBtnText: { color: "#2e4f82", fontSize: 13, fontWeight: "700", textAlign: "center" },
  modalActionBtnTextDark: { color: "#f4f7ff" },
  modalDescription: { marginTop: 12, color: "#1f3558", fontSize: 16, lineHeight: 24 },
  modalDescriptionDark: { color: "#d9e4ff" },
  modalDescriptionNeo: { color: "#393939" },

  eventModalContainer: { flex: 1, backgroundColor: "#f6f8fc" },
  eventModalContainerDark: { backgroundColor: "#0b1220" },

  eventHero: { width: "100%", overflow: "hidden" },
  eventHeroTopRow: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    gap: 8,
    zIndex: 5,
  },
  eventHeroIconBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.5)",
    alignItems: "center",
    justifyContent: "center",
  },
  eventHeroIconBtnActive: { backgroundColor: "#e85d3b" },
  eventHeroIconText: { color: "#fffdf8", fontSize: 18, fontWeight: "800" },
  eventHeroBottom: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    padding: 18,
    gap: 10,
  },
  eventHeroChipRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  eventHeroSourceChip: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.9)",
    alignItems: "center",
    justifyContent: "center",
  },
  eventHeroSourceInitials: { color: "#fffdf8", fontSize: 10, fontWeight: "900", letterSpacing: 0.3 },
  eventHeroSourceLabel: { color: "#fffdf8", fontSize: 12, fontWeight: "800", flex: 1 },
  eventHeroAudienceChip: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.22)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.35)",
  },
  eventHeroAudienceText: { color: "#fffdf8", fontSize: 11, fontWeight: "800", textTransform: "uppercase", letterSpacing: 0.4 },
  eventHeroTitle: { color: "#fffdf8", fontSize: 24, fontWeight: "900", lineHeight: 30, letterSpacing: -0.3 },

  eventWhenCard: {
    marginTop: 14,
    marginHorizontal: 14,
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 14,
    borderWidth: 1,
    borderColor: "#ebeef5",
  },
  eventWhenCardDark: { backgroundColor: "#121a29", borderColor: "#22304d" },
  eventWhenRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  eventWhenIcon: { fontSize: 22 },
  eventWhenPrimary: { color: "#1b2333", fontSize: 15, fontWeight: "900", letterSpacing: -0.2 },
  eventWhenSecondary: { color: "#6b7894", fontSize: 13, fontWeight: "600", marginTop: 2 },
  eventWhenAddBtn: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: "#eef3fb",
    borderWidth: 1,
    borderColor: "#d6e0f3",
  },
  eventWhenAddBtnDark: { backgroundColor: "#1c2a44", borderColor: "#2d4066" },
  eventWhenAddText: { color: "#2e4f82", fontSize: 12, fontWeight: "800" },

  eventSection: { marginTop: 16, marginHorizontal: 14, gap: 10 },
  eventSectionLabel: {
    color: "#6b7894",
    fontSize: 11,
    fontWeight: "900",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  eventRsvpRow: { flexDirection: "row", gap: 10 },
  eventRsvpPill: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderWidth: 1.5,
    borderColor: "#ebeef5",
  },
  eventRsvpPillDark: { backgroundColor: "#121a29", borderColor: "#22304d" },
  eventRsvpPillGoing: { backgroundColor: "#1c7a4a", borderColor: "#1c7a4a" },
  eventRsvpPillInterested: { backgroundColor: "#e8a62b", borderColor: "#e8a62b" },
  eventRsvpPillText: { color: "#1b2333", fontSize: 14, fontWeight: "800" },
  eventRsvpPillTextActive: { color: "#fffdf8" },
  eventRsvpLinkBtn: {
    marginTop: 4,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center",
    backgroundColor: "#eef3fb",
    borderWidth: 1,
    borderColor: "#d6e0f3",
  },
  eventRsvpLinkBtnDark: { backgroundColor: "#1c2a44", borderColor: "#2d4066" },
  eventRsvpLinkText: { color: "#2e4f82", fontSize: 13, fontWeight: "800" },

  eventInfoCard: {
    marginTop: 12,
    marginHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 14,
    backgroundColor: "#ffffff",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#ebeef5",
  },
  eventInfoCardDark: { backgroundColor: "#121a29", borderColor: "#22304d" },
  eventInfoIcon: { fontSize: 20 },
  eventInfoTitle: { color: "#1b2333", fontSize: 14, fontWeight: "800" },
  eventInfoSub: { color: "#6b7894", fontSize: 12, marginTop: 2, fontWeight: "600" },
  eventInfoChevron: { color: "#b0b9cf", fontSize: 24, fontWeight: "700", marginLeft: 4 },

  eventDescText: { color: "#34405a", fontSize: 15, lineHeight: 22, fontWeight: "500" },
  eventDescToggle: { marginTop: 6, color: "#2e4f82", fontSize: 13, fontWeight: "800" },

  eventMasjidCard: {
    marginTop: 16,
    marginHorizontal: 14,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    backgroundColor: "#ffffff",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#ebeef5",
  },
  eventMasjidCardDark: { backgroundColor: "#121a29", borderColor: "#22304d" },
  eventMasjidLogo: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  eventMasjidLogoText: { color: "#fffdf8", fontSize: 13, fontWeight: "900", letterSpacing: 0.4 },
  eventMasjidName: { color: "#1b2333", fontSize: 14, fontWeight: "900" },
  eventMasjidSub: { color: "#6b7894", fontSize: 12, marginTop: 2, fontWeight: "600" },
  eventFollowBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: "#1c4f82",
  },
  eventFollowBtnActive: { backgroundColor: "#1c7a4a" },
  eventFollowBtnText: { color: "#fffdf8", fontSize: 12, fontWeight: "800" },
  eventFollowBtnTextActive: { color: "#fffdf8" },

  eventLinksRow: { flexDirection: "row", gap: 10, marginTop: 14, marginHorizontal: 14 },
  eventLinkTile: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 14,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#ebeef5",
    alignItems: "center",
    gap: 4,
  },
  eventLinkTileDark: { backgroundColor: "#121a29", borderColor: "#22304d" },
  eventLinkIcon: { fontSize: 20 },
  eventLinkLabel: { color: "#1b2333", fontSize: 12, fontWeight: "800" },

  eventTrustCard: {
    marginTop: 16,
    marginHorizontal: 14,
    padding: 14,
    backgroundColor: "#ffffff",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#ebeef5",
    gap: 10,
  },
  eventTrustCardDark: { backgroundColor: "#121a29", borderColor: "#22304d" },
  eventTrustLabel: {
    color: "#6b7894",
    fontSize: 11,
    fontWeight: "900",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  eventTrustRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  eventTrustBarWrap: {
    flex: 1,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#e8ecf3",
    overflow: "hidden",
  },
  eventTrustBarFill: { height: "100%", backgroundColor: "#1c7a4a", borderRadius: 4 },
  eventTrustValue: { color: "#1b2333", fontSize: 13, fontWeight: "800", minWidth: 60, textAlign: "right" },
  eventTrustNote: { color: "#6b7894", fontSize: 12, fontWeight: "600", lineHeight: 16 },
  eventTrustActions: { flexDirection: "row", gap: 8, marginTop: 4 },
  eventTrustChip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: "#f4f6fb",
    borderWidth: 1,
    borderColor: "#e0e5ef",
    alignItems: "center",
  },
  eventTrustChipActive: { backgroundColor: "#1c4f82", borderColor: "#1c4f82" },
  eventTrustChipText: { color: "#34405a", fontSize: 12, fontWeight: "700" },
  eventTrustChipTextActive: { color: "#fffdf8" },

  eventReportToggle: { marginTop: 16, marginHorizontal: 14, alignItems: "center", padding: 10 },
  eventReportToggleText: { color: "#6b7894", fontSize: 13, fontWeight: "700", textDecorationLine: "underline" },

  eventReportCard: {
    marginTop: 4,
    marginHorizontal: 14,
    padding: 14,
    backgroundColor: "#ffffff",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#ebeef5",
    gap: 10,
  },
  eventReportCardDark: { backgroundColor: "#121a29", borderColor: "#22304d" },
  eventReportLabel: {
    color: "#6b7894",
    fontSize: 11,
    fontWeight: "900",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  eventReportChipRow: { flexDirection: "row", gap: 8 },
  eventReportChip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: "#f4f6fb",
    borderWidth: 1,
    borderColor: "#e0e5ef",
    alignItems: "center",
  },
  eventReportChipDark: { backgroundColor: "#1a2338", borderColor: "#2a374f" },
  eventReportChipActive: { backgroundColor: "#1c4f82", borderColor: "#1c4f82" },
  eventReportChipText: { color: "#34405a", fontSize: 12, fontWeight: "800" },
  eventReportChipTextActive: { color: "#fffdf8" },
  eventReportInput: {
    minHeight: 72,
    padding: 12,
    borderRadius: 10,
    backgroundColor: "#f4f6fb",
    borderWidth: 1,
    borderColor: "#e0e5ef",
    color: "#1b2333",
    fontSize: 14,
    textAlignVertical: "top",
  },
  eventReportInputDark: { backgroundColor: "#1a2338", borderColor: "#2a374f", color: "#f4f7ff" },
  eventReportSubmitBtn: {
    paddingVertical: 12,
    borderRadius: 12,
    backgroundColor: "#1c4f82",
    alignItems: "center",
  },
  eventReportSubmitText: { color: "#fffdf8", fontSize: 14, fontWeight: "800" },

  eventStickyFooter: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingTop: 10,
    backgroundColor: "rgba(246,248,252,0.97)",
    borderTopWidth: 1,
    borderTopColor: "#e4e8f1",
  },
  eventStickyFooterDark: {
    backgroundColor: "rgba(11,18,32,0.97)",
    borderTopColor: "#22304d",
  },
  eventStickySaveBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "#eef3fb",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#d6e0f3",
  },
  eventStickySaveBtnActive: { backgroundColor: "#e85d3b", borderColor: "#e85d3b" },
  eventStickySaveText: { color: "#e85d3b", fontSize: 22, fontWeight: "900" },
  eventStickySaveTextActive: { color: "#fffdf8" },
  eventStickyPrimaryBtn: {
    flex: 1,
    height: 52,
    borderRadius: 26,
    backgroundColor: "#1c4f82",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#1c4f82",
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  eventStickyPrimaryText: { color: "#fffdf8", fontSize: 15, fontWeight: "900", letterSpacing: -0.1 },
  eventStickyShareBtn: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: "#eef3fb",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#d6e0f3",
  },
  eventStickyShareText: { color: "#2e4f82", fontSize: 22, fontWeight: "900" },

  homeHero: {
    marginHorizontal: 14,
    marginTop: 14,
    borderRadius: 22,
    paddingHorizontal: 20,
    paddingVertical: 22,
    gap: 6,
    overflow: "hidden",
  },
  homeHeroGlowA: {
    position: "absolute",
    top: -60,
    left: -40,
    width: 220,
    height: 220,
    borderRadius: 110,
    backgroundColor: "rgba(255,255,255,0.55)",
  },
  homeHeroGlowB: {
    position: "absolute",
    right: -50,
    bottom: -70,
    width: 240,
    height: 240,
    borderRadius: 120,
    backgroundColor: "rgba(255,255,255,0.28)",
  },
  homeHeroShimmer: {
    position: "absolute",
    top: -30,
    left: 0,
    width: 80,
    height: 260,
    backgroundColor: "rgba(255,255,255,0.55)",
  },
  homeHeroHi: { color: "#fff", fontSize: 14, fontWeight: "700", letterSpacing: 0.2 },
  homeHeroCount: { color: "#fff", fontSize: 34, fontWeight: "900", letterSpacing: -0.8, marginTop: 2 },
  homeHeroSub: { color: "rgba(255,255,255,0.9)", fontSize: 13, fontWeight: "600", marginTop: 2 },
  homeHeroCta: {
    marginTop: 14,
    alignSelf: "flex-start",
    backgroundColor: "rgba(0,0,0,0.28)",
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
  },
  homeHeroCtaText: { color: "#fff", fontWeight: "800", fontSize: 14 },

  homeQuickRow: {
    flexDirection: "row",
    paddingHorizontal: 14,
    marginTop: 14,
    gap: 10,
  },
  homeQuickBtn: {
    flex: 1,
    paddingVertical: 14,
    borderRadius: 16,
    backgroundColor: "#ffffff",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#ebeef5",
    gap: 4,
  },
  homeQuickBtnDark: { backgroundColor: "#131a28", borderColor: "#22304d" },
  homeQuickEmoji: { fontSize: 22, color: "#1f2a3d" },
  homeQuickLabel: { fontSize: 12, fontWeight: "700", color: "#2e4f82" },

  homeSection: {
    marginTop: 18,
    marginHorizontal: 14,
    gap: 10,
  },
  homeSectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  homeSectionHeaderRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  homeSectionTitle: { fontSize: 18, fontWeight: "900", color: "#1f2a3d", letterSpacing: -0.2 },
  homeSectionCount: { fontSize: 12, color: "#6b7894", fontWeight: "700" },
  homeSectionSeeAll: { color: "#2e4f82", fontWeight: "800", fontSize: 12 },

  homeEventRow: {
    flexDirection: "row",
    gap: 12,
    padding: 10,
    backgroundColor: "#ffffff",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#ebeef5",
    alignItems: "flex-start",
  },
  homeEventRowDark: { backgroundColor: "#121a29", borderColor: "#22304d" },
  homeEventRowPoster: { width: 72, height: 72, borderRadius: 12, backgroundColor: "#eef2f9" },
  homeEventRowWhen: { color: "#ff7d50", fontWeight: "800", fontSize: 11 },
  homeEventRowTitle: { color: "#1b2333", fontWeight: "800", fontSize: 15, marginTop: 2, letterSpacing: -0.2 },
  homeEventRowMeta: { color: "#6b7894", fontSize: 12, marginTop: 2 },

  homeEmpty: {
    backgroundColor: "#f4f6fb",
    padding: 14,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#ebeef5",
  },
  homeEmptyDark: { backgroundColor: "#131a28", borderColor: "#22304d" },
  homeEmptyText: { color: "#5b6a88", fontSize: 13, fontWeight: "600" },

  homeFollowChip: {
    minWidth: 220,
    padding: 12,
    borderRadius: 14,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#ebeef5",
  },
  homeFollowChipDark: { backgroundColor: "#121a29", borderColor: "#22304d" },
  homeFollowName: { color: "#1b2333", fontSize: 14, fontWeight: "800" },
  homeFollowNext: { color: "#6b7894", fontSize: 12, marginTop: 4 },

  homeBrowseAllBtn: {
    marginTop: 22,
    marginHorizontal: 14,
    marginBottom: 12,
    paddingVertical: 16,
    paddingHorizontal: 18,
    borderRadius: 18,
    backgroundColor: "#1c4f82",
    alignItems: "center",
    shadowColor: "#1c4f82",
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 5,
  },
  homeBrowseAllBtnDark: { backgroundColor: "#2c6db4" },
  homeBrowseAllTitle: { color: "#fffdf8", fontSize: 15, fontWeight: "900", letterSpacing: -0.1 },
  homeBrowseAllSub: { color: "#cfe1f5", fontSize: 12, fontWeight: "600", marginTop: 4, textAlign: "center" },

  exploreMapHero: {
    width: "100%",
    overflow: "hidden",
    backgroundColor: "#e7ecf4",
  },
  exploreMapOverlayTop: {
    position: "absolute",
    top: 12,
    left: 14,
    right: 14,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
    backgroundColor: "rgba(8,10,18,0.58)",
  },
  exploreMapOverlayTitle: { color: "#fff", fontSize: 17, fontWeight: "900", letterSpacing: -0.3 },
  exploreMapOverlaySub: { color: "rgba(255,255,255,0.85)", marginTop: 2, fontSize: 12, fontWeight: "600" },
  exploreFilterBar: {
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#e3e6ee",
    backgroundColor: "#f7f9fc",
  },
  exploreFilterBarDark: { backgroundColor: "#10131d", borderBottomColor: "#1f2433" },
  exploreFilterBarNeo: { backgroundColor: "#d8d8d8", borderBottomColor: "#b9b9b9" },
  exploreAudienceStrip: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 4 },
  exploreMoreChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#ff7d50",
    backgroundColor: "rgba(255,125,80,0.12)",
    marginLeft: 4,
  },
  exploreMoreChipDark: { backgroundColor: "rgba(255,125,80,0.18)" },
  exploreMoreChipText: { color: "#c94d14", fontWeight: "800", fontSize: 13 },
  exploreMoreChipTextDark: { color: "#ffb18a" },
  exploreListWrap: { padding: 12, gap: 14 },
  exploreDaySection: { gap: 10 },
  exploreEmpty: {
    marginTop: 40,
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 20,
  },
  exploreEmptyTitle: { fontSize: 18, fontWeight: "900", color: "#1f2a3d" },
  exploreEmptySub: { fontSize: 13, textAlign: "center", color: "#5b6a88" },
  exploreEmptyBtn: {
    marginTop: 10,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: "#ff7d50",
  },
  exploreEmptyBtnText: { color: "#fff", fontWeight: "800", fontSize: 14 },
  exploreChipsGroup: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },

  cardTagsRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, marginTop: 4 },
  cardSpeakerTag: {
    fontSize: 11,
    fontWeight: "700",
    color: "#5b6a88",
    backgroundColor: "#eef2fa",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    maxWidth: 180,
  },
  topicTag: {
    fontSize: 11,
    fontWeight: "700",
    color: "#2f4571",
    backgroundColor: "#e2ebff",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
  },
  eventBadgeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: 6,
    marginBottom: 6,
  },
  freshnessPill: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    maxWidth: 200,
  },
  freshnessDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  freshnessPillText: {
    fontSize: 11,
    fontWeight: "700",
  },
  eventInviteBtn: {
    backgroundColor: "#6d53e8",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    alignSelf: "center",
  },
  eventInviteBtnText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 12,
  },
  iqamaCard: {
    marginHorizontal: 0,
    marginVertical: 6,
    padding: 14,
    borderRadius: 16,
    backgroundColor: "#f5f8ff",
    borderWidth: 1,
    borderColor: "#dde5f4",
    gap: 8,
  },
  iqamaTitle: {
    fontWeight: "800",
    fontSize: 15,
    color: "#2f4571",
  },
  iqamaSub: {
    fontSize: 12,
    color: "#5b6a88",
  },
  iqamaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  iqamaCell: {
    minWidth: 62,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
    backgroundColor: "#fff",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#e6ecf7",
    flexGrow: 1,
  },
  iqamaPrayer: {
    fontSize: 11,
    fontWeight: "700",
    color: "#6a7a97",
    marginBottom: 2,
  },
  iqamaTime: {
    fontSize: 15,
    fontWeight: "800",
    color: "#222a3f",
  },
  iqamaJumuah: {
    fontSize: 13,
    fontWeight: "700",
    color: "#2f4571",
  },
  iqamaStampBtn: {
    alignSelf: "flex-start",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "#eaf7ef",
    borderWidth: 1,
    borderColor: "#b8e1c6",
  },
  iqamaStampText: {
    color: "#1f7a42",
    fontWeight: "800",
    fontSize: 12,
  },
  reflectStar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#eef2fa",
    alignItems: "center",
    justifyContent: "center",
  },
  reflectStarActive: {
    backgroundColor: "#ffd257",
  },
  reflectStarText: {
    fontSize: 22,
    color: "#b6c0d6",
  },
  reflectStarTextActive: {
    color: "#8a5c00",
  },
  reflectInput: {
    marginHorizontal: 16,
    marginTop: 12,
    minHeight: 86,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: "#f3f6fc",
    borderWidth: 1,
    borderColor: "#d6deed",
    textAlignVertical: "top",
  },
  passportHero: {
    padding: 14,
    borderRadius: 18,
    backgroundColor: "#f2ecff",
    borderWidth: 1,
    borderColor: "#d9cfff",
    gap: 6,
  },
  passportHeroTitle: {
    fontSize: 20,
    fontWeight: "900",
    color: "#3a2f7f",
  },
  passportHeroSub: {
    fontSize: 13,
    color: "#5c4fa8",
  },
  passportProgressBar: {
    marginTop: 6,
    height: 8,
    borderRadius: 4,
    backgroundColor: "#e2d9fb",
    overflow: "hidden",
  },
  passportProgressFill: {
    height: "100%",
    backgroundColor: "#6d53e8",
  },
  passportGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  passportStampCell: {
    width: "31%",
    padding: 10,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#e0e7f3",
    backgroundColor: "#fff",
    alignItems: "center",
    gap: 6,
  },
  passportStampCellDone: {
    borderColor: "#b8e1c6",
    backgroundColor: "#eaf7ef",
  },
  passportStampLogo: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  passportStampLogoText: {
    color: "#fff",
    fontWeight: "800",
    fontSize: 12,
  },
  passportStampName: {
    fontSize: 11,
    fontWeight: "700",
    color: "#4a556a",
    textAlign: "center",
  },
  passportStampDone: {
    color: "#1f7a42",
    fontWeight: "900",
    fontSize: 14,
  },
  scholarCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 16,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e6ecf7",
  },
  scholarAvatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
  },
  scholarName: {
    fontWeight: "800",
    fontSize: 15,
    color: "#222a3f",
  },
  scholarSub: {
    fontSize: 12,
    color: "#5b6a88",
  },
  scholarNext: {
    fontSize: 12,
    color: "#4a3bb0",
    fontWeight: "700",
    marginTop: 2,
  },
  scholarHero: {
    padding: 14,
    borderRadius: 18,
    backgroundColor: "#f5f8ff",
    borderWidth: 1,
    borderColor: "#dde5f4",
    gap: 4,
  },
  topicChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#dde5f4",
    backgroundColor: "#f4f7ff",
  },
  topicChipActive: {
    borderColor: "#6d53e8",
    backgroundColor: "#6d53e8",
  },
  topicChipText: {
    fontSize: 12,
    fontWeight: "700",
    color: "#4a556a",
  },
  topicChipTextActive: {
    color: "#fff",
  },
  seriesStripTitle: {
    fontSize: 13,
    fontWeight: "800",
    color: "#4a556a",
    marginBottom: 4,
    marginLeft: 4,
  },
  seriesCard: {
    width: 160,
    padding: 10,
    borderRadius: 16,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e6ecf7",
    gap: 6,
  },
  seriesPoster: {
    width: "100%",
    height: 90,
    borderRadius: 12,
    backgroundColor: "#eef2fa",
  },
  seriesTitle: {
    fontWeight: "800",
    fontSize: 13,
    color: "#222a3f",
  },
  seriesSub: {
    fontSize: 11,
    color: "#5b6a88",
  },
  seriesCount: {
    fontSize: 11,
    fontWeight: "800",
    color: "#4a3bb0",
  },
  cardActionRow: {
    flexDirection: "row",
    gap: 6,
    marginTop: 10,
    flexWrap: "wrap",
  },
  cardActionChip: {
    minHeight: 30,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#d6deed",
    backgroundColor: "#f4f7fd",
    alignItems: "center",
    justifyContent: "center",
  },
  cardActionChipActive: {
    backgroundColor: "#ff7d50",
    borderColor: "#ff7d50",
  },
  cardActionChipText: { fontSize: 12, fontWeight: "800", color: "#2e4f82" },
  cardActionChipTextActive: { color: "#fff" },

  bottomSheetBackdrop: {
    flex: 1,
    backgroundColor: "rgba(8,10,18,0.48)",
    justifyContent: "flex-end",
  },
  bottomSheetCard: {
    backgroundColor: "#ffffff",
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 16,
    paddingTop: 8,
  },
  bottomSheetCardDark: { backgroundColor: "#101724" },
  bottomSheetCardNeo: { backgroundColor: "#dedede" },
  bottomSheetHandle: {
    alignSelf: "center",
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: "#c9d0dc",
    marginBottom: 10,
  },
  bottomSheetHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#ebeef5",
  },
  bottomSheetTitle: { color: "#1b2333", fontSize: 20, fontWeight: "900", letterSpacing: -0.3 },
  bottomSheetTitleDark: { color: "#f4f7ff" },
  bottomSheetSub: { color: "#6b7894", fontSize: 12, fontWeight: "700", marginTop: 2 },
  bottomSheetSubDark: { color: "#c4cee8" },
  bottomSheetFollowBtn: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#ff7d50",
    backgroundColor: "rgba(255,125,80,0.1)",
  },
  bottomSheetFollowBtnActive: { backgroundColor: "#ff7d50" },
  bottomSheetFollowText: { color: "#c94d14", fontWeight: "800", fontSize: 12 },
  bottomSheetFollowTextActive: { color: "#fff" },
  bottomSheetCloseBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f2f4fa",
  },
  bottomSheetCloseText: { fontSize: 18, color: "#454f63", fontWeight: "700" },

  calendarDayEventCard: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#ebeef5",
  },
  calendarDayEventCardDark: {
    backgroundColor: "#121a29",
    borderColor: "#22304d",
  },
  calendarDayEventPoster: { width: "100%", height: 150, backgroundColor: "#e7ecf4" },
  calendarDayEventPosterEmpty: { alignItems: "center", justifyContent: "center", backgroundColor: "#eef2f9" },
  calendarDayEventPosterEmptyText: { fontSize: 42, color: "#a3b0c8" },
  calendarDayEventTitle: { color: "#1b2333", fontSize: 16, fontWeight: "800", letterSpacing: -0.2 },
});

