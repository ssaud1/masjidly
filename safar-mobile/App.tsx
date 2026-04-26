import { NotoColorEmoji_400Regular, useFonts } from "@expo-google-fonts/noto-color-emoji";
import { StatusBar } from "expo-status-bar";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Device from "expo-device";
import * as Linking from "expo-linking";
import * as Location from "expo-location";
import { LinearGradient } from "expo-linear-gradient";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { MaterialIcons } from "@expo/vector-icons";
import MapView, { Callout, Marker, type Region } from "react-native-maps";

// Haptics load lazily: native module is only present in builds that bundled
// expo-haptics at compile time. On older TestFlight binaries (pre-v6) the
// module isn't linked, so we swallow the import error and no-op. Vibration is
// always available as a minimal fallback.
type HapticsModule = {
  impactAsync?: (style: string) => Promise<void> | void;
  selectionAsync?: () => Promise<void> | void;
  notificationAsync?: (type: string) => Promise<void> | void;
  ImpactFeedbackStyle?: { Light: string; Medium: string; Heavy: string; Soft: string; Rigid: string };
  NotificationFeedbackType?: { Success: string; Warning: string; Error: string };
};
let hapticsModule: HapticsModule | null = null;
try {
  // Wrapped so Metro doesn't eagerly resolve into the JS bundle when the
  // native side can't satisfy the import.
  hapticsModule = require("expo-haptics");
} catch {
  hapticsModule = null;
}

function hapticTap(kind: "selection" | "success" = "selection") {
  try {
    if (hapticsModule) {
      if (kind === "success" && hapticsModule.notificationAsync && hapticsModule.NotificationFeedbackType) {
        void hapticsModule.notificationAsync(hapticsModule.NotificationFeedbackType.Success);
        return;
      }
      if (hapticsModule.selectionAsync) {
        void hapticsModule.selectionAsync();
        return;
      }
      if (hapticsModule.impactAsync && hapticsModule.ImpactFeedbackStyle) {
        void hapticsModule.impactAsync(hapticsModule.ImpactFeedbackStyle.Light);
        return;
      }
    }
  } catch {
    // fall through to Vibration
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Vibration } = require("react-native");
    Vibration?.vibrate?.(kind === "success" ? [0, 20, 40, 20] : 12);
  } catch {
    // truly no-op on any platform that has neither
  }
}
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import {
  AppState,
  Alert,
  ActivityIndicator,
  Animated,
  Easing,
  FlatList,
  Image,
  InteractionManager,
  KeyboardAvoidingView,
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

/** iOS UIScrollView defers child touches to detect scrolling; this restores instant button taps inside vertical lists. */
const IOS_SCROLL_INSTANT_TOUCH =
  Platform.OS === "ios" ? ({ delaysContentTouches: false } as Record<string, unknown>) : {};

/** Drop the default press delay so `Pressable` responds immediately (especially Android inside horizontal lists). */
const PRESSABLE_INSTANT = { unstable_pressDelay: 0 } as const;
// Apply the same instant-tap behavior to any Pressable that forgot to spread
// PRESSABLE_INSTANT. This keeps button response consistent across the app.
try {
  const pressableAny = Pressable as unknown as { defaultProps?: Record<string, unknown> };
  pressableAny.defaultProps = {
    ...(pressableAny.defaultProps || {}),
    unstable_pressDelay: 0,
  };
} catch {
  // non-fatal
}

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

type TabKey = "home" | "explore" | "discover" | "calendar" | "feed" | "settings";

type EventItem = {
  event_uid?: string;
  source: string;
  title: string;
  description: string;
  description_original?: string;
  description_ai_generated?: boolean;
  description_ai_model?: string;
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

type SpeakerVideo = {
  video_id: string;
  title: string;
  channel: string;
  published_at: string;
  duration_seconds: number;
  duration_label: string;
  view_count: number;
  thumbnail_url: string;
  url: string;
};

type MasjidAmenities = {
  amenities: Record<string, boolean | number | string>;
  description: string;
  website: string;
  phone: string;
  email: string;
  updated_at: string;
};

/** Short labels for Discover masjid cards — only keys we want to surface. */
const DISCOVER_AMENITY_LABELS: Record<string, string> = {
  basketball_court: "Court",
  gym: "Gym",
  sunday_school: "School",
  full_time_school: "Full-time school",
  youth_program: "Youth",
  hifz_program: "Hifz",
  quran_classes: "Qur'an",
  library: "Library",
  livestream_jumuah: "Live Jumu'ah",
  funeral_services: "Janazah",
  nikah_services: "Nikah",
  wheelchair_access: "Accessible",
  sisters_entrance: "Sisters' entrance",
  childcare_during_jumuah: "Childcare",
};

function discoverAmenityChips(
  amenities: Record<string, boolean | number | string> | undefined,
  max = 3,
): string[] {
  if (!amenities) return [];
  const out: string[] = [];
  for (const [key, val] of Object.entries(amenities)) {
    if (val === true) {
      const lbl = DISCOVER_AMENITY_LABELS[key];
      if (lbl) {
        out.push(lbl);
        if (out.length >= max) return out;
      }
    }
  }
  const ps = amenities.parking_spaces;
  if (typeof ps === "number" && ps > 0 && out.length < max) {
    out.push(ps >= 100 ? "Large lot" : "Parking");
  }
  return out.slice(0, max);
}

type MetaResponse = {
  sources: string[];
  default_reference: string;
  min_date: string;
  max_date: string;
  today: string;
  total_events: number;
  data_version?: string;
};

const EVENTS_CACHE_KEY = "masjidly_events_cache_v2";
const META_CACHE_KEY = "masjidly_meta_cache_v2";

type EventsCachePayload = {
  events: EventItem[];
  data_version: string;
  cached_at: number;
};

// Offline-first seed bundled with the app. Generated by safar_daily_pipeline.py
// (write_mobile_seed) so the very first launch — before any network call — still
// shows real events. Used only when AsyncStorage has no usable cache yet.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const BUNDLED_SEED_EVENTS = require("./assets/seed-events.json") as EventItem[];
// eslint-disable-next-line @typescript-eslint/no-var-requires
const BUNDLED_SEED_META = require("./assets/seed-meta.json") as MetaResponse;

const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL || "http://127.0.0.1:5060";
const TOKEN_KEY = "masjidly_auth_token";
const SAVED_EVENTS_KEY = "masjidly_saved_events_v1";
const PERSONALIZATION_KEY = "masjidly_personalization_v1";
const WELCOME_FLOW_DONE_KEY = "masjidly_welcome_flow_done_v1";
const GUIDED_TOUR_DONE_KEY = "masjidly_guided_tour_done_v5";
// Bump on every EAS update so the badge on the welcome screen reflects what's
// actually running on device. v2 = post-"always-welcome" build + Explore perf.
const APP_BUILD_VERSION = "v78";

// Static hosted URLs referenced from several places (Settings, About,
// PrivacyInfo).  Mirrored from `app.json > expo.extra.urls` so the app
// keeps working if `Constants.expoConfig` is unavailable (e.g. bare
// workflow or certain OTA-update edge cases).
const MASJIDLY_URLS = {
  privacy: "https://ssaud1.github.io/masjidly/privacy.html",
  support: "https://ssaud1.github.io/masjidly/support.html",
  terms: "https://ssaud1.github.io/masjidly/terms.html",
  deleteAccount: "https://ssaud1.github.io/masjidly/delete-account.html",
  marketing: "https://ssaud1.github.io/masjidly/",
  supportEmail: "support@masjidly.app",
} as const;

/** Bump when the hosted privacy policy materially changes — users must re-accept. */
const PRIVACY_POLICY_VERSION = "1";
const THEME_KEY = "masjidly_theme_v1";
const FOLLOWED_MASJIDS_KEY = "masjidly_followed_masjids_v1";
const FOLLOWED_SCHOLARS_KEY = "masjidly_followed_scholars_v1";
const MUTED_FEED_SOURCES_KEY = "masjidly_muted_feed_sources_v1";
const RSVP_STATUSES_KEY = "masjidly_rsvp_statuses_v1";
const RSVP_NOTIFICATION_IDS_KEY = "masjidly_rsvp_notification_ids_v1";
const PRAYER_NOTIFICATION_IDS_KEY = "masjidly_prayer_notification_ids_v1";
const NOTIFICATION_CAP_COUNTER_KEY = "masjidly_notification_cap_counter_v1";
const TONIGHT_DIGEST_NOTIFICATION_KEY = "masjidly_tonight_digest_id_v1";
const PAST_EVENT_HIDE_GRACE_HOURS = 3;
const FILTER_PRESETS_KEY = "masjidly_filter_presets_v1";
const FEEDBACK_RESPONSES_KEY = "masjidly_feedback_responses_v1";
const STREAK_TRACKER_KEY = "masjidly_streak_tracker_v1";
const REFERRAL_CODE_KEY = "masjidly_referral_code_v1";
const FEED_SETUP_DONE_KEY = "masjidly_feed_setup_done_v1";
// Whoever's share code THIS user entered when signing up. Set once during
// onboarding (or later via Settings) so we can credit the inviter for the
// monthly Masjid.ly merch raffle. Empty string until the user enters one.
const REFERRED_BY_KEY = "masjidly_referred_by_v1";
// Persisted tally of how many other users have signed up using *this*
// device's share code. Incremented when the backend tells us our code was
// used, or locally when we detect an invite chain in dev builds.
const REFERRAL_WINS_KEY = "masjidly_referral_wins_v1";
const OFFICIAL_LOGO = require("./assets/masjidly-logo.png");
const TOPBAR_WORDMARK = require("./assets/masjidly1.png");
const SPRITE_GREETER = require("./assets/sprite-greeter.png");
const SPRITE_AVATAR = require("./assets/sprite-avatar.png");
// Standing smiling Muslim man — current canonical companion art. Used for
// both the floating chatbot avatar and the full-size guide narrator. The
// older pixel sprites above are kept around for backward-compat only.
const SPRITE_MAN = require("./assets/sprite-man.png");
const WELCOME_LOGO = require("./assets/masjidly-6.png");
// Illustrations of a cat using Masjid.ly — shown on the welcome pager as a
// lighthearted "be like this" cue. Intentionally big and image-forward so the
// first experience feels warm instead of a wall of text.
const CAT_READING = require("./assets/cat-reading.jpg");
// Pixel-art GIF of a cat hammering a monitor — the "our hard workers are
// working" moment after the user hits Build my feed.
const FEED_BUILDING_CAT = require("./assets/feed-building-cat.gif");
// Material Symbols tab icons (rendered from SVG sources the user provided).
// All are monochrome greyscale PNGs so we recolor them at runtime via
// `tintColor` to match the active theme.
const TAB_ICON_HOME = require("./assets/tab-icons/home.png");
const TAB_ICON_MAP = require("./assets/tab-icons/map.png");
const TAB_ICON_DISCOVER = require("./assets/tab-icons/discover.png");
const TAB_ICON_CALENDAR = require("./assets/tab-icons/calendar.png");
const TAB_ICON_FEED = require("./assets/tab-icons/feed.png");
const TAB_ICON_SETTINGS = require("./assets/tab-icons/settings.png");

// ── Material Symbols rounded glyphs ────────────────────────────────────────
// Monochrome 96px PNGs rendered from Google's Material Design Icons repo
// (symbols/web/<name>/materialsymbolsrounded/<name>_24px.svg). Rendered at
// runtime via <Mi name="..." size={...} color={...} /> so they adopt the
// current theme colour via tintColor. This replaces the ad-hoc unicode /
// emoji glyphs (♥ ✕ ↗ ◇ etc.) the app used to scatter into Text nodes.
const MI_ICONS = {
  arrow_downward: require("./assets/mi/arrow_downward.png"),
  auto_awesome: require("./assets/mi/auto_awesome.png"),
  bookmark: require("./assets/mi/bookmark.png"),
  bookmark_fill1: require("./assets/mi/bookmark_fill1.png"),
  calendar_today: require("./assets/mi/calendar_today.png"),
  celebration: require("./assets/mi/celebration.png"),
  chat: require("./assets/mi/chat.png"),
  check: require("./assets/mi/check.png"),
  close: require("./assets/mi/close.png"),
  contrast: require("./assets/mi/contrast.png"),
  dark_mode: require("./assets/mi/dark_mode.png"),
  expand_less: require("./assets/mi/expand_less.png"),
  explore: require("./assets/mi/explore.png"),
  favorite: require("./assets/mi/favorite.png"),
  favorite_fill1: require("./assets/mi/favorite_fill1.png"),
  groups: require("./assets/mi/groups.png"),
  info: require("./assets/mi/info.png"),
  lightbulb: require("./assets/mi/lightbulb.png"),
  location_on: require("./assets/mi/location_on.png"),
  logout: require("./assets/mi/logout.png"),
  mail: require("./assets/mi/mail.png"),
  menu: require("./assets/mi/menu.png"),
  mosque: require("./assets/mi/mosque.png"),
  notifications: require("./assets/mi/notifications.png"),
  open_in_new: require("./assets/mi/open_in_new.png"),
  palette: require("./assets/mi/palette.png"),
  pets: require("./assets/mi/pets.png"),
  play_arrow: require("./assets/mi/play_arrow.png"),
  refresh: require("./assets/mi/refresh.png"),
  restart_alt: require("./assets/mi/restart_alt.png"),
  schedule: require("./assets/mi/schedule.png"),
  school: require("./assets/mi/school.png"),
  search: require("./assets/mi/search.png"),
  share: require("./assets/mi/share.png"),
  star: require("./assets/mi/star.png"),
  star_fill1: require("./assets/mi/star_fill1.png"),
  thumb_up: require("./assets/mi/thumb_up.png"),
  verified_user: require("./assets/mi/verified_user.png"),
  warning: require("./assets/mi/warning.png"),
  waving_hand: require("./assets/mi/waving_hand.png"),
} as const;
type MiName = keyof typeof MI_ICONS;
function Mi({
  name,
  size = 18,
  color,
  style,
}: {
  name: MiName;
  size?: number;
  color?: string;
  style?: any;
}) {
  const [iconFailed, setIconFailed] = useState(false);
  if (iconFailed) {
    return <MaterialIcons name="circle" size={Math.max(12, size - 6)} color={color || "#7f8aa5"} style={style} />;
  }
  return (
    <Image
      source={MI_ICONS[name]}
      style={[{ width: size, height: size, tintColor: color }, style]}
      resizeMode="contain"
      fadeDuration={0}
      onError={() => setIconFailed(true)}
    />
  );
}

function LoadableNetworkImage({
  uri,
  style,
  resizeMode = "cover",
  onError,
}: {
  uri: string;
  style: any;
  resizeMode?: "cover" | "contain" | "stretch" | "repeat" | "center";
  onError?: () => void;
}) {
  const [loading, setLoading] = useState(true);
  return (
    <View style={[style, styles.imageLoadContainer]}>
      <Image
        source={{ uri }}
        style={StyleSheet.absoluteFillObject}
        resizeMode={resizeMode}
        fadeDuration={0}
        onLoadStart={() => setLoading(true)}
        onLoadEnd={() => setLoading(false)}
        onError={() => {
          setLoading(false);
          onError?.();
        }}
      />
      {loading ? (
        <View style={styles.imageLoadingOverlay} pointerEvents="none">
          <ActivityIndicator size="small" color="#ff7a3c" />
        </View>
      ) : null}
    </View>
  );
}

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
// Real website domains for each masjid, hand-verified against their live
// sites so we can fetch their actual logos instead of showing text initials.
// If a domain here ever changes, the avatar just falls back to initials.
const MASJID_DOMAINS: Record<string, string> = {
  iceb: "icebnj.net",
  mcmc: "mcmcnj.org",
  iscj: "iscj.org",
  icpc: "icpcnj.org",
  mcgp: "themuslimcenter.org",
  darul_islah: "darulislah.org",
  nbic: "nbic.org",
  alfalah: "alfalahcenter.org",
  masjid_al_wali: "masjidalwali.org",
  icsj: "icsjmasjid.org",
  masjid_muhammad_newark: "masjidmuhammadnewark.org",
  icuc: "icucnj.com",
  ismc: "ismcnj.org",
  mcnj: "mcnjonline.com",
  icna_nj: "icnanj.org",
  jmic: "jmic.org",
  icmc: "icmcnj.com",
  icoc: "icoconline.org",
  bayonne_mc: "bayonnemuslims.com",
  hudson_ic: "hudsonislamiccenter.org",
  clifton_ic: "icpcnj.org",
  isbc: "isbri.org",
  mcjc: "masjidmuhammadjc.com",
  waarith: "masjidwd.org",
};

// High-res logo URL when we've got a direct link from the masjid's site
// (og:image / hero logo). These take priority over the favicon service.
// Keeping them narrow and hand-picked so we only override when the quality
// is meaningfully better than what the favicon resolver returns.
const MASJID_LOGO_OVERRIDES: Record<string, string> = {
  iceb: "https://www.icebnj.net/wp-content/uploads/2025/01/cropped-logo-1.png",
};

/** Build a logo URL for a masjid source. Prefers a hand-curated high-res
 * override, falls back to Google's favicon service (backed by Google's CDN,
 * stable, works for essentially every domain). Returns null for masjids we
 * don't have a confirmed domain for. */
function masjidLogoUrl(source: string): string | null {
  const key = (source || "").toLowerCase();
  if (MASJID_LOGO_OVERRIDES[key]) return MASJID_LOGO_OVERRIDES[key];
  const domain = MASJID_DOMAINS[key];
  if (!domain) return null;
  return `https://www.google.com/s2/favicons?domain=${domain}&sz=128`;
}

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
    followed_speakers: boolean;
    tonight_after_maghrib: boolean;
    prayer_reminders: boolean;
    rsvp_reminders: boolean;
    quiet_hours_start: string;
    quiet_hours_end: string;
    daily_notification_cap: number;
  };
};

type PersonalizationPrefs = {
  name: string;
  heardFrom: string;
  // Optional contact email. Captured during onboarding alongside an
  // explicit opt-in toggle (`emailOptIn`). We only ever email users
  // who've ticked the opt-in box — the field itself is kept even if
  // they say "no" so they can turn it back on later from Settings.
  email: string;
  emailOptIn: boolean;
  gender: "brother" | "sister" | "prefer_not_to_say" | "";
  preferredAudience: "all" | "brothers" | "sisters";
  interests: string[];
  completed: boolean;
  /** Empty = not accepted; otherwise matches `PRIVACY_POLICY_VERSION` at accept time. */
  privacy_policy_accepted_version: string;
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

// NOTE: intentionally uses the device's LOCAL date — not UTC. Previous version
// used new Date().toISOString() which flips to tomorrow's date after ~7pm ET,
// making the app think "today" had already advanced and bucketing tomorrow's
// events into the Today card.
function todayIso(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function plusDaysIso(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
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

// Convert "HH:mm" (24h) or "h:mm am/pm" / "h am" (already 12h) into a
// display-friendly 12-hour string like "6:45 PM". Handles a few messy
// cases we see in scraped data: single-digit hours, missing minutes,
// minutes after the meridian, stray whitespace. If we can't parse the
// string at all we return the input unchanged so we never hide info.
function formatClock12(raw: string): string {
  if (!raw) return "";
  const trimmed = String(raw).trim();
  // Already has am/pm? Normalize the meridian casing and let it through
  // (the scraper sometimes gives us "6:45 pm" or "6pm").
  const ampmMatch = trimmed.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)\s*$/i);
  if (ampmMatch) {
    const h = Number(ampmMatch[1]);
    const m = ampmMatch[2] ? ampmMatch[2] : "00";
    const meridian = ampmMatch[3].toLowerCase().startsWith("p") ? "PM" : "AM";
    const displayH = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${displayH}:${m} ${meridian}`;
  }
  // 24-hour "HH:mm" (or "H:mm").
  const hhmmMatch = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (hhmmMatch) {
    const h = Number(hhmmMatch[1]);
    const m = hhmmMatch[2];
    if (Number.isFinite(h) && h >= 0 && h <= 23) {
      const meridian = h >= 12 ? "PM" : "AM";
      const displayH = h === 0 ? 12 : h > 12 ? h - 12 : h;
      return `${displayH}:${m} ${meridian}`;
    }
  }
  return trimmed;
}

function eventTime(e: EventItem): string {
  const start = formatClock12(e.start_time || "");
  const end = formatClock12(e.end_time || "");
  if (start && end) return `${start} - ${end}`;
  if (start) return start;
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
  params.set("text", normalizeText(e.title || "Masjid.ly Event"));
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
  params.set("subject", normalizeText(e.title || "Masjid.ly Event"));
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

// Trim event-description fragments that sometimes leak into scraped speaker
// names (e.g. "Shaykh Ismail Hamdi will be speaking on..." → "Shaykh Ismail Hamdi").
// Cuts at common filler phrases and strips trailing articles/connectors.
function cleanSpeakerName(name: string): string {
  if (!name) return "";
  const raw = name.replace(/\s+/g, " ").trim();
  const stopPhrases = [
    " will be ",
    " will speak",
    " speaking ",
    " presents ",
    " talks ",
    " talk on ",
    " teaches ",
    " delivers ",
    " leads ",
    " on ",
    " at ",
    " for ",
    " about ",
    " discussing ",
    " as ",
    " who ",
    " that ",
  ];
  let cut = raw;
  for (const stop of stopPhrases) {
    const idx = cut.toLowerCase().indexOf(stop);
    if (idx > 3) cut = cut.slice(0, idx).trim();
  }
  // Also trim trailing punctuation and very long tail segments
  cut = cut.replace(/[,;:—–-]+.*$/, "").trim();
  // Cap length for display
  if (cut.length > 40) cut = cut.slice(0, 38).trim() + "…";
  return cut || raw;
}

// Aligned with SPEAKER_JUNK_WORDS in safar_custom_app.py — any token = reject.
const SPEAKER_JUNK_TOKENS = new Set([
  "gallery",
  "contact",
  "education",
  "services",
  "appointment",
  "nikkah",
  "home",
  "about",
  "donate",
  "menu",
  "team",
  "privacy",
  "policy",
  "terms",
  "login",
  "register",
  "subscribe",
  "the",
  "for",
  "with",
  "an",
  "to",
  "of",
  "and",
  "at",
  "on",
  "in",
  "by",
  "muslim",
  "center",
  "masjid",
  "islamic",
  "tonight",
  "night",
  "reminder",
  "lesson",
  "lecture",
  "khutbah",
  "reciting",
  "adhan",
  "ages",
  "continuation",
  "being",
  "our",
  "calendar",
  "volunteers",
  "volunteer",
  "staff",
  "committee",
  "board",
  "visit",
  "phone",
  "support",
  "welcome",
  "newsletter",
  "resources",
  "programs",
  "events",
  "media",
  "as",
  "he",
  "she",
  "they",
  "reflects",
  "reflect",
  "explore",
  "explores",
]);

const SCHOLAR_TITLE_PREFIX = new Set(["imam", "shaykh", "sheikh", "sheik", "ustadh", "ustad", "dr", "qari"]);
const SCHOLAR_ALIAS_MAP: Record<string, string> = {
  "shaykh ismael hamdi": "Shaykh Ismail Hamdi",
  "shaykh ismail hamdi": "Shaykh Ismail Hamdi",
  "sh ismail hamdi": "Shaykh Ismail Hamdi",
  "sheikh ismail hamdi": "Shaykh Ismail Hamdi",
  "imam tom facchine": "Imam Tom Facchine",
  "shaykh yahya ibrahim": "Shaykh Yahya Ibrahim",
};

function trimBadScholarTokens(name: string): string {
  const parts = name.replace(/\s+/g, " ").trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const w = parts[i];
    const letters = w.replace(/[^a-zA-Z]/g, "");
    const low = letters.toLowerCase();
    if (!letters) continue;
    const titleTok = low.replace(/\./g, "");
    if (i === 0 && SCHOLAR_TITLE_PREFIX.has(titleTok)) {
      out.push(w);
      continue;
    }
    if (SPEAKER_JUNK_TOKENS.has(low)) break;
    out.push(w);
  }
  if (out.length < 2) return "";
  return out.join(" ");
}

function scholarNameIsPlausible(name: string): boolean {
  const tokens = (name.match(/[A-Za-z]+/g) || []).map((t) => t.toLowerCase());
  if (!tokens.length || tokens.length > 5) return false;
  for (const t of tokens) {
    if (SPEAKER_JUNK_TOKENS.has(t)) return false;
  }
  const letters = tokens.join("").length;
  if (letters < 4) return false;
  return true;
}

function finalizeScholarCandidate(raw: string): string {
  const t = trimBadScholarTokens(cleanSpeakerName(raw)).trim();
  if (!t || !scholarNameIsPlausible(t)) return "";
  const aliasKey = t
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();
  return SCHOLAR_ALIAS_MAP[aliasKey] || t;
}

function inferSpeakerFromText(text: string): string {
  const t = normalizeText(text || "");
  if (!t) return "";
  const patterns = [
    /\b(?:imam|shaykh|sheikh|sheik|ustadh|ustad|dr\.?|qari)\s+[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){0,3}\b/gi,
    /\b(?:imam|shaykh|sheikh|sheik|ustadh|ustad|dr\.?|qari)\s+[a-z][a-zA-Z'-]+(?:\s+[a-z][a-zA-Z'-]+){0,3}\b/gi,
  ];
  for (const rx of patterns) {
    const re = new RegExp(rx.source, rx.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(t)) !== null) {
      const chunk = normalizeText(m[0]);
      const fin = finalizeScholarCandidate(chunk);
      if (fin) return fin;
    }
  }
  return "";
}

/** Structured speaker + same inference as event sheet; drops nav/blurb junk. */
function effectiveEventSpeakerName(e: EventItem): string {
  const direct = (e.speaker || "").trim();
  if (direct) {
    const fin = finalizeScholarCandidate(cleanSpeakerName(direct));
    if (fin) return fin;
  }
  return inferSpeakerFromText(
    `${e.poster_ocr_text || ""} ${e.description || ""} ${e.raw_text || ""} ${e.title || ""}`,
  );
}

function eventLineMatchesSpeakerSlug(line: string, slug: string): boolean {
  if (!line || !slug) return false;
  return line.includes(slug) || slug.includes(line);
}

function enrichDiscoverPosterFromEvents(sp: Speaker, pool: EventItem[]): Speaker {
  if (sp.image_url && !isWeakPosterUrl(sp.image_url)) return sp;
  const target = (sp.slug || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const nameHay = sp.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  let weak = "";
  for (const ev of pool) {
    const sn = effectiveEventSpeakerName(ev);
    if (!sn) continue;
    const line = sn.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const match =
      (target && eventLineMatchesSpeakerSlug(line, target)) ||
      (nameHay.length >= 4 && eventLineMatchesSpeakerSlug(line, nameHay));
    if (!match) continue;
    const p = eventPosterUrl(ev);
    if (p && !isWeakPosterUrl(p)) return { ...sp, image_url: p };
    if (p && !weak) weak = p;
  }
  return weak ? { ...sp, image_url: weak } : sp;
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

// Stable dedupe key. We intentionally DO NOT include title in the primary key.
// The same event often arrives twice (seed/cache/live) where one row has the
// cleaned title and another still has noisy OCR/caption text; title-based keys
// keep both. Instead we key by source+date+time and disambiguate with poster or
// source_url, then choose the better row via `eventDedupeQualityScore`.
function eventDedupeKey(e: any): string {
  const source = (e?.source || "").toString().trim().toLowerCase();
  const date = (e?.date || "").toString().trim();
  const startTime = (e?.start_time || "").toString().trim();
  const endTime = (e?.end_time || "").toString().trim();
  const poster = pickPoster((e as { image_urls?: unknown })?.image_urls);
  const sourceUrl = normalizeText(((e as { source_url?: unknown })?.source_url ?? "").toString()).toLowerCase();
  if (source && date && (startTime || endTime)) {
    const base = `sdt:${source}|${date}|${startTime}|${endTime}`;
    if (poster) return `${base}|p:${poster.toLowerCase().slice(0, 220)}`;
    if (sourceUrl) return `${base}|u:${sourceUrl.slice(0, 260)}`;
    return base;
  }
  const uid = (e?.event_uid || "").toString().trim().toLowerCase();
  if (uid) return `uid:${uid}`;
  const title = normalizeText((e?.title || "").toString()).toLowerCase().slice(0, 120);
  return `fallback:${source}|${date}|${startTime}|${title}`;
}

function eventDedupeQualityScore(e: any): number {
  let score = 0;
  const title = normalizeText((e?.title || "").toString());
  if (title) score += 6;
  if (!isWeakEventTitle(title)) score += 20;
  else score -= 8;
  if (/https?:\/\/|www\.|#[a-z0-9_]+/i.test(title)) score -= 14;
  if (
    /\b\d{1,5}\s+[a-z0-9]/i.test(title) &&
    /\b(street|st|ave|avenue|road|rd|lane|ln|blvd|drive|dr|nj)\b/i.test(title)
  ) {
    score -= 14;
  }
  const poster = pickPoster((e as { image_urls?: unknown })?.image_urls);
  if (poster) score += 4;
  if (poster && !isWeakPosterUrl(poster)) score += 8;
  const desc = normalizeText(((e?.description || "") as string).replace(/<[^>]+>/g, " "));
  if (desc && !isBoilerplateDescription(desc)) score += 3;
  if (normalizeText((e?.event_uid || "").toString())) score += 2;
  return score;
}

function upsertDedupeEvent(map: Map<string, EventItem>, candidate: EventItem) {
  const key = eventDedupeKey(candidate);
  const existing = map.get(key);
  if (!existing) {
    map.set(key, candidate);
    return;
  }
  if (eventDedupeQualityScore(candidate) > eventDedupeQualityScore(existing)) {
    map.set(key, candidate);
  }
}

function normalizedTitleTokensForDedupe(e: EventItem): string[] {
  const title = eventDisplayTitle(e)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/#[a-z0-9_]+/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) return [];
  const stop = new Set([
    "the", "and", "for", "with", "from", "this", "that", "your", "our", "you",
    "are", "was", "will", "into", "about", "event", "program", "at", "to", "of",
  ]);
  return title
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !stop.has(t));
}

function jaccardTitleSimilarity(a: EventItem, b: EventItem): number {
  const at = normalizedTitleTokensForDedupe(a);
  const bt = normalizedTitleTokensForDedupe(b);
  if (!at.length || !bt.length) return 0;
  const aSet = new Set(at);
  const bSet = new Set(bt);
  let intersection = 0;
  for (const t of aSet) if (bSet.has(t)) intersection += 1;
  const union = aSet.size + bSet.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function minutesDiffBetweenEvents(a: EventItem, b: EventItem): number {
  const am = parseEventClockMinutes(a.start_time);
  const bm = parseEventClockMinutes(b.start_time);
  if (am == null || bm == null) return 0;
  return Math.abs(am - bm);
}

function sourceUrlKey(e: EventItem): string {
  const raw = normalizeText((e.source_url || "").toString()).toLowerCase();
  if (!raw) return "";
  const noHash = raw.split("#")[0];
  const noQuery = noHash.split("?")[0];
  return noQuery.replace(/\/+$/, "");
}

function posterUrlFingerprint(url: string): string {
  const raw = normalizeText(url).toLowerCase();
  if (!raw) return "";
  const noHash = raw.split("#")[0];
  const noQuery = noHash.split("?")[0];
  const base = noQuery.split("/").filter(Boolean).pop() || noQuery;
  return base
    .replace(/_(?:\d{2,5}x\d{2,5}|[a-z]{1,4}\d{0,4})\.(jpg|jpeg|png|webp)$/i, ".$1")
    .replace(/-(?:\d{2,5}x\d{2,5})\.(jpg|jpeg|png|webp)$/i, ".$1");
}

function startsSameMinute(a: EventItem, b: EventItem): boolean {
  const aRaw = normalizeText((a.start_time || "").toString()).toLowerCase();
  const bRaw = normalizeText((b.start_time || "").toString()).toLowerCase();
  if (aRaw && bRaw && aRaw === bRaw) return true;
  const am = parseEventClockMinutes(a.start_time);
  const bm = parseEventClockMinutes(b.start_time);
  return am != null && bm != null && am === bm;
}

function endsSameMinute(a: EventItem, b: EventItem): boolean {
  const aRaw = normalizeText((a.end_time || "").toString()).toLowerCase();
  const bRaw = normalizeText((b.end_time || "").toString()).toLowerCase();
  if (aRaw && bRaw && aRaw === bRaw) return true;
  const am = parseEventClockMinutes(a.end_time);
  const bm = parseEventClockMinutes(b.end_time);
  return am != null && bm != null && am === bm;
}

function isNearDuplicateEvent(a: EventItem, b: EventItem): boolean {
  const sourceA = normalizeText(a.source).toLowerCase();
  const sourceB = normalizeText(b.source).toLowerCase();
  if (!sourceA || sourceA !== sourceB) return false;
  if ((a.date || "") !== (b.date || "")) return false;

  const uidA = normalizeText((a.event_uid || "").toString()).toLowerCase();
  const uidB = normalizeText((b.event_uid || "").toString()).toLowerCase();
  if (uidA && uidB && uidA === uidB) return true;

  const timeDiff = minutesDiffBetweenEvents(a, b);
  const posterA = pickPoster(a.image_urls);
  const posterB = pickPoster(b.image_urls);
  const posterSigA = posterUrlFingerprint(posterA);
  const posterSigB = posterUrlFingerprint(posterB);
  const urlA = sourceUrlKey(a);
  const urlB = sourceUrlKey(b);
  const titleSim = jaccardTitleSimilarity(a, b);
  const weakA = isWeakEventTitle(eventDisplayTitle(a));
  const weakB = isWeakEventTitle(eventDisplayTitle(b));
  const sameStartMinute = startsSameMinute(a, b);
  const sameEndMinute = endsSameMinute(a, b);

  if (urlA && urlB && urlA === urlB && timeDiff <= 240) return true;
  if (posterSigA && posterSigB && posterSigA === posterSigB && timeDiff <= 240) return true;
  if (posterA && posterB && posterA === posterB && (timeDiff <= 180 || titleSim >= 0.45)) return true;
  if (sameStartMinute && sameEndMinute && (weakA || weakB)) return true;
  if (sameStartMinute && titleSim >= 0.56) return true;
  if (titleSim >= 0.78 && timeDiff <= 240) return true;
  if ((weakA || weakB) && titleSim >= 0.38 && timeDiff <= 240) return true;
  return false;
}

function collapseNearDuplicateEvents(rows: EventItem[]): EventItem[] {
  const out: EventItem[] = [];
  for (const row of rows) {
    const idx = out.findIndex((existing) => isNearDuplicateEvent(existing, row));
    if (idx < 0) {
      out.push(row);
      continue;
    }
    if (eventDedupeQualityScore(row) > eventDedupeQualityScore(out[idx])) {
      out[idx] = row;
    }
  }
  return out;
}

function dropInferiorPosterlessClones(rows: EventItem[]): EventItem[] {
  if (rows.length <= 1) return rows;
  return rows.filter((row, idx) => {
    const rowPoster = pickPoster(row.image_urls);
    if (rowPoster) return true;
    const rowScore = eventDedupeQualityScore(row);
    const rowSource = normalizeText(row.source).toLowerCase();
    const rowDate = normalizeText(row.date);
    if (!rowSource || !rowDate) return true;
    for (let i = 0; i < rows.length; i += 1) {
      if (i === idx) continue;
      const other = rows[i];
      const otherPoster = pickPoster(other.image_urls);
      if (!otherPoster) continue;
      if (normalizeText(other.source).toLowerCase() !== rowSource) continue;
      if (normalizeText(other.date) !== rowDate) continue;
      const minuteDiff = minutesDiffBetweenEvents(row, other);
      if (minuteDiff > 180) continue;
      const otherScore = eventDedupeQualityScore(other);
      // Prefer the richer row (poster + cleaner metadata) when a no-poster
      // sibling appears nearby on the same masjid/day timeline.
      if (otherScore >= rowScore + 8) return false;
    }
    return true;
  });
}

// Identifies ongoing programs / class series that aren't discrete events the
// user wants in their "what's happening" feed. We keep things like Jumu'ah,
// halaqas, fundraisers, dinners, open houses, lectures, conferences, picnics,
// etc. but strip out rolling classes and school registration announcements.
// Returns the concrete Date an event starts at. Uses local timezone since
// event scrape data is stored in the masjid's local wall-clock time (ET for
// all NJ masjids today).
function eventStartDate(e: any): Date | null {
  const iso = (e?.date || "").toString().trim();
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const startMin = parseEventClockMinutes(e?.start_time);
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const hour = startMin != null ? Math.floor(startMin / 60) : 10;
  const min = startMin != null ? startMin % 60 : 0;
  const d = new Date(year, month, day, hour, min, 0, 0);
  return isNaN(d.getTime()) ? null : d;
}

/** Parse event clock text like "7:15 PM", "19:15", "7pm" into minutes since midnight. */
function parseEventClockMinutes(raw: unknown): number | null {
  if (!raw) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;
  const m = /^([0-2]?\d)(?::([0-5]\d))?\s*([ap])?\.?\s*m?\.?$/.exec(s);
  if (!m) return null;
  let hour = Number(m[1]);
  const min = Number(m[2] || "0");
  if (!Number.isFinite(hour) || !Number.isFinite(min) || min < 0 || min > 59) return null;
  const suffix = m[3] || "";
  if (suffix) {
    if (hour < 1 || hour > 12) return null;
    // 12am -> 00:xx, 12pm -> 12:xx
    hour = hour % 12;
    if (suffix === "p") hour += 12;
  } else if (hour > 23) {
    return null;
  }
  return hour * 60 + min;
}

type LocalNotificationPrefs = {
  quiet_hours_start?: string;
  quiet_hours_end?: string;
  daily_notification_cap?: number;
};

function parseClockMinutes(raw: string | undefined): number | null {
  const s = String(raw || "").trim().toLowerCase();
  const m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm) || hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

function isWithinQuietHours(at: Date, quietStart: string, quietEnd: string): boolean {
  const start = parseClockMinutes(quietStart);
  const end = parseClockMinutes(quietEnd);
  if (start == null || end == null) return false;
  const now = at.getHours() * 60 + at.getMinutes();
  if (start === end) return false;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}

async function consumeNotificationCap(
  triggerAt: Date,
  prefs: LocalNotificationPrefs | undefined,
  priority: "high" | "low",
): Promise<boolean> {
  const quietStart = prefs?.quiet_hours_start || "22:30";
  const quietEnd = prefs?.quiet_hours_end || "06:30";
  if (isWithinQuietHours(triggerAt, quietStart, quietEnd)) return false;
  const cap = Math.max(1, Math.min(25, Number(prefs?.daily_notification_cap ?? 6)));
  const dateKey = `${triggerAt.getFullYear()}-${String(triggerAt.getMonth() + 1).padStart(2, "0")}-${String(triggerAt.getDate()).padStart(2, "0")}`;
  try {
    const raw = await SecureStore.getItemAsync(NOTIFICATION_CAP_COUNTER_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    const used = Number(parsed[dateKey] || 0);
    const maxAllowed = priority === "high" ? cap + 2 : cap;
    if (used >= maxAllowed) return false;
    parsed[dateKey] = used + 1;
    await SecureStore.setItemAsync(NOTIFICATION_CAP_COUNTER_KEY, JSON.stringify(parsed));
    return true;
  } catch {
    return true;
  }
}

// Local notification scheduling for RSVP'd events. We fire two reminders:
//   1. 9:00am on the day-of ("Today: <title> at <masjid>, starts at 6:45pm")
//   2. ~2 hours before the event starts ("Starting soon: ...")
// Ids are persisted per-event-key so we can cancel them when the user
// un-RSVPs. Best-effort: never throws into the UI.
async function scheduleEventReminders(e: any, prefs?: LocalNotificationPrefs): Promise<void> {
  const key = (e?.event_uid && String(e.event_uid)) ||
    `${e?.source || ""}|${e?.date || ""}|${e?.start_time || ""}|${e?.title || ""}`;
  try {
    const perm = await Notifications.getPermissionsAsync();
    if (!perm.granted) {
      const req = await Notifications.requestPermissionsAsync();
      if (!req.granted) return;
    }
  } catch {
    return;
  }
  await cancelEventReminders(key);
  const start = eventStartDate(e);
  if (!start) return;
  const now = Date.now();
  const masjid = (e?.source || "").toString().toUpperCase();
  const title = (e?.title || "Your event").toString();
  const when = `${start.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
  const ids: string[] = [];
  const dayOf = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 9, 0, 0, 0);
  if (dayOf.getTime() > now + 60_000) {
    try {
      const allow = await consumeNotificationCap(dayOf, prefs, "low");
      if (!allow) throw new Error("suppressed");
      const id = await Notifications.scheduleNotificationAsync({
        content: {
          title: `Today: ${title}`,
          body: masjid ? `${masjid} · starts at ${when}` : `Starts at ${when}`,
          data: { event_key: key, kind: "day_of" },
        },
        trigger: dayOf as any,
      });
      ids.push(id);
    } catch { /* non-fatal */ }
  }
  const twoHoursBefore = new Date(start.getTime() - 2 * 60 * 60 * 1000);
  if (twoHoursBefore.getTime() > now + 60_000) {
    try {
      const allow = await consumeNotificationCap(twoHoursBefore, prefs, "high");
      if (!allow) throw new Error("suppressed");
      const id = await Notifications.scheduleNotificationAsync({
        content: {
          title: `Starting soon: ${title}`,
          body: masjid ? `${masjid} · ${when}` : `Starts at ${when}`,
          data: { event_key: key, kind: "two_hours" },
        },
        trigger: twoHoursBefore as any,
      });
      ids.push(id);
    } catch { /* non-fatal */ }
  }
  try {
    const raw = await SecureStore.getItemAsync(RSVP_NOTIFICATION_IDS_KEY);
    const map: Record<string, string[]> = raw ? JSON.parse(raw) : {};
    map[key] = ids;
    await SecureStore.setItemAsync(RSVP_NOTIFICATION_IDS_KEY, JSON.stringify(map));
  } catch { /* non-fatal */ }
}

async function cancelEventReminders(key: string): Promise<void> {
  try {
    const raw = await SecureStore.getItemAsync(RSVP_NOTIFICATION_IDS_KEY);
    if (!raw) return;
    const map: Record<string, string[]> = JSON.parse(raw);
    const ids = map[key] || [];
    for (const id of ids) {
      try { await Notifications.cancelScheduledNotificationAsync(id); } catch { /* non-fatal */ }
    }
    delete map[key];
    await SecureStore.setItemAsync(RSVP_NOTIFICATION_IDS_KEY, JSON.stringify(map));
  } catch { /* non-fatal */ }
}

// Returns true if the event has already ended relative to the device's local
// clock. Used to keep the Today bucket honest — a Monday 18:45-19:45 halaqa
// shouldn't still show up as "Today" at 9pm.
function isEventPastNow(e: any): boolean {
  const now = new Date();
  const isoDate = (e?.date || "").toString().trim();
  if (!isoDate) return false;
  const localTodayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (isoDate < localTodayIso) return true;
  if (isoDate > localTodayIso) return false;
  // Same-day: use end_time if present, else start_time + 60min, else start_time.
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const endMin = parseEventClockMinutes(e?.end_time);
  if (endMin != null) return nowMin > endMin;
  const startMin = parseEventClockMinutes(e?.start_time);
  if (startMin != null) return nowMin > startMin + 60; // assume 1h duration
  return false;
}

function isPastEventBeyondGrace(e: any, graceHours: number = PAST_EVENT_HIDE_GRACE_HOURS): boolean {
  if (!isEventPastNow(e)) return false;
  const start = eventStartDate(e);
  if (!start) return true;
  const endMin = parseEventClockMinutes(e?.end_time);
  const startMin = parseEventClockMinutes(e?.start_time);
  const fallbackStart = startMin != null ? startMin : start.getHours() * 60 + start.getMinutes();
  const effectiveEndMin = endMin != null ? endMin : fallbackStart + 60;
  const end = new Date(start);
  end.setHours(Math.floor(effectiveEndMin / 60), effectiveEndMin % 60, 0, 0);
  const graceMs = Math.max(1, graceHours) * 60 * 60 * 1000;
  return Date.now() - end.getTime() > graceMs;
}

function isEventLiveNow(e: any): boolean {
  const now = new Date();
  const isoDate = (e?.date || "").toString().trim();
  if (!isoDate) return false;
  const localTodayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (isoDate !== localTodayIso) return false;
  const startMin = parseEventClockMinutes(e?.start_time);
  if (startMin == null) return false;
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const endMin = parseEventClockMinutes(e?.end_time);
  const effectiveEnd = endMin != null ? endMin : startMin + 60; // default 1h duration
  return nowMin >= startMin && nowMin <= effectiveEnd;
}

// ── Guided tour content ────────────────────────────────────────────────────
// Narrated by the Muslim pixel sprite on first app entry. Each step can
// drive the app to a specific tab and highlight either a tab button or the
// floating chat launcher so the user sees what's being described in real
// time, not just reads about it.
type GuidedTourTaskId =
  | "goto-explore"
  | "tap-masjid-pin"
  | "follow-masjid"
  | "goto-discover"
  | "follow-scholar"
  | "goto-calendar"
  | "open-chatbot";

type GuidedTourTarget =
  | { kind: "tab"; tab: "home" | "explore" | "discover" | "calendar" | "feed" | "settings"; tabIndex: number }
  | { kind: "chatbot" }
  | {
      // Interactive step — the user must actually do something in the
      // real app to advance. We watch app state in an effect and call
      // `advanceTour(1)` when the condition is met.
      kind: "task";
      taskId: GuidedTourTaskId;
      // Optional visual highlight on the tab bar / chatbot launcher.
      highlight?: { kind: "tab"; tabIndex: number } | { kind: "chatbot" };
    }
  | { kind: "none" };

const GUIDED_TOUR_STEPS: Array<{
  title: string;
  body: string;
  hint?: string;  // shown under the card when the step is a task
  target: GuidedTourTarget;
}> = [
  // 1. Intro
  {
    title: "As-salāmu ʿalaykum!",
    body: "Let's actually use Masjid.ly together. I'll point, you tap. Takes about 90 seconds — and by the end you'll have a personalized feed.",
    target: { kind: "none" },
  },
  // 2. TASK — go to Map
  {
    title: "First stop: the map",
    body: "Tap the highlighted Map button at the BOTTOM of your screen (second tab). That's where every masjid in your area lives.",
    hint: "Tap the ring below ↓",
    target: { kind: "task", taskId: "goto-explore", highlight: { kind: "tab", tabIndex: 1 } },
  },
  // 3. TASK — tap a pin
  {
    title: "Every pin is a real masjid",
    body: "Each one runs real weekly programs — jumu'ah khutbahs, tafsir circles, youth nights, sisters halaqas. Tap any pin to peek inside.",
    hint: "Waiting for you to tap a masjid pin on the map…",
    target: { kind: "task", taskId: "tap-masjid-pin" },
  },
  // 4. TASK — follow a masjid
  {
    title: "Love this masjid? Follow it",
    body: "See the Follow button at the top of the sheet that just opened? That's how you make Masjid.ly yours. Tap Follow and this masjid's new programs will pop up on your Home screen first — and we'll nudge you when something good is happening near you.",
    hint: "Waiting for you to hit Follow on a masjid…",
    target: { kind: "task", taskId: "follow-masjid" },
  },
  // 5. Celebration
  {
    title: "Mashā' Allāh!",
    body: "You just followed your first masjid. Every halaqa, every tafsir session, every guest-speaker program they run this month will now surface on Home — you won't miss a thing.",
    target: { kind: "none" },
  },
  // 6. TASK — go to Discover
  {
    title: "Next: Discover teachers",
    body: "Tap the Discover tab. I'll show you every scholar and khatīb giving talks near you.",
    hint: "Waiting for you to tap Discover…",
    target: { kind: "task", taskId: "goto-discover", highlight: { kind: "tab", tabIndex: 2 } },
  },
  // 7. TASK — follow a scholar
  {
    title: "Follow a scholar you love",
    body: "These cards list every teacher with upcoming programs in your radius. Hit +Follow on any one of them — we'll make sure their next talk lands on your Home screen and ping you the day they're speaking.",
    hint: "Waiting for you to follow a scholar…",
    target: { kind: "task", taskId: "follow-scholar" },
  },
  // 8. Celebration
  {
    title: "Your feed is now personalized",
    body: "Bārak Allāhu fīk. The more you follow, the richer it gets — and you can browse scholars, masjids, or collections (sisters programs, youth nights, revert circles) any time from this tab.",
    target: { kind: "none" },
  },
  // 9. TASK — go to Calendar
  {
    title: "Plan your week in Calendar",
    body: "Tap the Calendar tab. Every dated program lives here — with AI-curated learning plans at the top (Qur'an, Seerah, Fiqh, Tazkiyah…).",
    hint: "Waiting for you to tap the Calendar tab…",
    target: { kind: "task", taskId: "goto-calendar", highlight: { kind: "tab", tabIndex: 3 } },
  },
  // 10. TASK — open chatbot
  {
    title: "Last thing — meet your buddy",
    body: "Tap me in the top-right corner any time. I know every event in your area. Try \"what's on tonight?\" or \"sisters halaqas this week\".",
    hint: "Waiting for you to tap the floating buddy…",
    target: { kind: "task", taskId: "open-chatbot", highlight: { kind: "chatbot" } },
  },
  // 11. Outro
  {
    title: "You're all set",
    body: "That's the tour. You followed a masjid, followed a scholar, and met the buddy. You can replay this any time from Settings → Replay walkthrough. See you at the next halaqa, inshā' Allāh.",
    target: { kind: "none" },
  },
];

// ── Chatbot query engine ───────────────────────────────────────────────────
// Parses a user query against the loaded events array and returns a ranked
// list of matching events + a short friendly summary. Everything runs
// locally on-device — no network required. Designed to gracefully degrade
// when data is sparse (e.g. offline on first launch).
interface ChatQueryContext {
  events: any[];
  location?: { latitude: number; longitude: number } | null;
  followedScholars?: string[];
  followedMasjids?: string[];
}
interface ChatQueryResult {
  reply: string;
  events: any[];
}
const CHAT_SUGGESTIONS = [
  "What's tonight?",
  "Tomorrow after maghrib",
  "Sisters this week",
  "Brothers this week",
  "Family events this weekend",
  "Closest event",
  "Free events",
  "Any youth programs?",
  "Tafsir this weekend",
  "Classes this month",
  "Fundraisers coming up",
  "Who made this app?",
] as const;
function answerChatQuery(raw: string, ctx: ChatQueryContext): ChatQueryResult {
  const q = (raw || "").toLowerCase().trim();
  if (!q) return { reply: "Ask me anything about events around you.", events: [] };
  const asksCreator = /\b(who\s+(made|built|created|owns)\s+(this\s+)?(app|masjid\.?ly)|who\s+is\s+shaheer|about\s+shaheer|founder)\b/.test(q);
  if (asksCreator) {
    return {
      reply:
        "Masjid.ly was made by Shaheer Saud. LinkedIn: https://www.linkedin.com/in/shaheersaud/ . He's open to marriage conversations — serious inquiries can reach out respectfully.",
      events: [],
    };
  }
  const today = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const isoOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const todayIso = isoOf(today);
  const addDays = (n: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() + n);
    return isoOf(d);
  };
  // Filter out past events right away
  const upcoming = (ctx.events || []).filter((e) => {
    if (!e?.date) return false;
    if (e.date < todayIso) return false;
    if (e.date === todayIso && isEventPastNow(e)) return false;
    return true;
  });

  // Intent detectors
  const wantsToday = /\b(today|tonight|right\s*now|happening\s*now|live)\b/.test(q);
  const wantsTomorrow = /\b(tomorrow|tmrw|tmr)\b/.test(q);
  const wantsWeekend = /\b(weekend|sat(urday)?|sun(day)?)\b/.test(q);
  const wantsWeek = /\b(this\s*week|next\s*7|week)\b/.test(q);
  const wantsNext = /\b(next|soonest|upcoming|coming\s*up)\b/.test(q);
  const wantsClosest = /\b(closest|nearest|near\s*me|nearby|around\s*me)\b/.test(q);
  const wantsSisters = /\b(sisters?|women|ladies|female)\b/.test(q);
  const wantsBrothers = /\b(brothers?|men|male)\b/.test(q);
  const wantsFamily = /\b(family|families|parents?|kids?\s+friendly|children)\b/.test(q);
  const wantsYouth = /\b(youth|teen|kids?|children|young)\b/.test(q);
  const wantsFree = /\b(free|no\s*cost|donation[-\s]?based)\b/.test(q);
  const wantsClasses = /\b(class|classes|course|courses|workshop|workshops)\b/.test(q);
  const wantsLecture = /\b(lecture|talk|khatira|dars|seminar)\b/.test(q);
  const wantsFundraiser = /\b(fundraiser|gala|banquet|charity\s+night)\b/.test(q);
  const wantsLivestream = /\b(live\s*stream|livestream|virtual|online|zoom)\b/.test(q);
  const wantsThisMonth = /\b(this\s+month|month)\b/.test(q);
  const topicMap: Array<{ re: RegExp; label: string }> = [
    { re: /\btafsir|tafs[iī]r|quran|qur'?an\b/, label: "tafsir" },
    { re: /\bseerah|prophet'?s? life\b/, label: "seerah" },
    { re: /\bhadith|had[iī]th\b/, label: "hadith" },
    { re: /\bfiqh\b/, label: "fiqh" },
    { re: /\baqeedah|aqidah\b/, label: "aqeedah" },
    { re: /\b(halaqa|halaqah|circle)\b/, label: "halaqa" },
    { re: /\bjumu'?ah|jumm?ah|friday\s+prayer\b/, label: "jumuah" },
    { re: /\bfundraiser|gala|banquet\b/, label: "fundraiser" },
    { re: /\bconference|summit\b/, label: "conference" },
    { re: /\bdinner|iftar|suhoor\b/, label: "dinner" },
  ];
  const matchedTopic = topicMap.find((t) => t.re.test(q));

  let pool = upcoming.slice();

  // Date filters
  if (wantsToday) pool = pool.filter((e) => e.date === todayIso);
  else if (wantsTomorrow) pool = pool.filter((e) => e.date === addDays(1));
  else if (wantsWeekend) {
    const weekend: string[] = [];
    for (let i = 0; i < 8; i++) {
      const d = new Date(today);
      d.setDate(d.getDate() + i);
      const dow = d.getDay();
      if (dow === 6 || dow === 0) weekend.push(isoOf(d));
    }
    pool = pool.filter((e) => weekend.includes(e.date));
  } else if (wantsWeek) {
    const cutoff = addDays(7);
    pool = pool.filter((e) => e.date >= todayIso && e.date <= cutoff);
  } else if (wantsThisMonth) {
    const monthPrefix = todayIso.slice(0, 7);
    pool = pool.filter((e) => (e.date || "").startsWith(monthPrefix));
  }

  // Audience filters
  const audOf = (e: any) => (e.gender_filter || e.audience || "").toString().toLowerCase();
  if (wantsSisters) pool = pool.filter((e) => /sister|women|female/.test(audOf(e)) || /sister|women|ladies/.test((e.title || "").toLowerCase()));
  if (wantsBrothers) pool = pool.filter((e) => /brother|men|male/.test(audOf(e)) || /brothers/.test((e.title || "").toLowerCase()));
  if (wantsFamily) pool = pool.filter((e) => /family|parents?|kids?|children/.test(`${e.title || ""} ${e.description || ""} ${e.audience || ""}`.toLowerCase()));
  if (wantsYouth) pool = pool.filter((e) => /youth|teen|kids|children/.test(`${e.title || ""} ${e.topic_tag || ""}`.toLowerCase()));
  if (wantsFree) pool = pool.filter((e) => !(e.cost || "").toString().match(/\$\d|\bpaid\b/i));
  if (wantsClasses) pool = pool.filter((e) => /class|course|workshop|halaqa|study/.test(`${e.title || ""} ${e.description || ""}`.toLowerCase()));
  if (wantsLecture) pool = pool.filter((e) => /lecture|talk|khatira|dars|seminar|guest/.test(`${e.title || ""} ${e.description || ""}`.toLowerCase()));
  if (wantsFundraiser) pool = pool.filter((e) => /fundraiser|gala|banquet|charity/.test(`${e.title || ""} ${e.description || ""}`.toLowerCase()));
  if (wantsLivestream) pool = pool.filter((e) => /youtube|instagram|live|livestream|zoom|virtual|online/.test(`${e.title || ""} ${e.description || ""} ${e.rsvp_link || ""}`.toLowerCase()));

  // Topic filter
  if (matchedTopic) {
    pool = pool.filter((e) => matchedTopic.re.test(`${e.title || ""} ${e.description || ""} ${e.topic_tag || ""}`.toLowerCase()));
  }

  // Free-text match against title/speaker/masjid when nothing else narrowed it down
  // (e.g. "bayonne", "shaykh omar").
  const keywords = q.replace(/[?.,!]/g, "").split(/\s+/).filter((w) => w.length > 2 && !["the", "and", "for", "are", "any", "what", "when", "where", "show", "me", "near", "next", "this", "that", "events", "event"].includes(w));
  if (!wantsToday && !wantsTomorrow && !wantsWeekend && !wantsWeek && !wantsThisMonth && !wantsSisters && !wantsBrothers && !wantsFamily && !wantsYouth && !wantsFree && !wantsClasses && !wantsLecture && !wantsFundraiser && !wantsLivestream && !matchedTopic && !wantsClosest && !wantsNext && keywords.length) {
    pool = pool.filter((e) => {
      const blob = `${e.title || ""} ${e.speaker || ""} ${e.source || ""} ${e.description || ""}`.toLowerCase();
      return keywords.some((k) => blob.includes(k));
    });
  }

  // Distance sort if we can
  if (wantsClosest && ctx.location) {
    const { latitude: lat0, longitude: lng0 } = ctx.location;
    const dist = (e: any) => {
      if (typeof e.latitude !== "number" || typeof e.longitude !== "number") return 1e9;
      const dx = (e.latitude - lat0) * 69;
      const dy = (e.longitude - lng0) * 54;
      return Math.sqrt(dx * dx + dy * dy);
    };
    pool = pool.slice().sort((a, b) => dist(a) - dist(b));
  } else {
    pool = pool.slice().sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (a.start_time || "").localeCompare(b.start_time || "");
    });
  }

  const top = pool.slice(0, 5);

  // Compose reply
  if (!top.length) {
    return {
      reply:
        wantsToday || wantsTomorrow
          ? "No events match that window. Pull down on Home to refresh, or widen your filters in Map."
          : "I couldn't find events matching that. Try \"family events this weekend\", \"classes this month\", or \"closest event\".",
      events: [],
    };
  }

  const headLine =
    wantsToday ? `Here's what's on today:` :
    wantsTomorrow ? `Tomorrow's lineup:` :
    wantsWeekend ? `This weekend:` :
    wantsWeek ? `Coming up this week:` :
    wantsClosest ? `Closest events to you:` :
    wantsSisters ? `Events for sisters:` :
    wantsBrothers ? `Events for brothers:` :
    wantsFamily ? `Family-friendly events:` :
    wantsYouth ? `Youth programs coming up:` :
    wantsClasses ? `Classes and workshops:` :
    wantsLecture ? `Talks and lectures:` :
    wantsFundraiser ? `Fundraisers coming up:` :
    wantsLivestream ? `Livestream / online options:` :
    matchedTopic ? `On "${matchedTopic.label}" — here's what I found:` :
    `Here's what I found:`;

  const countNote = pool.length > top.length ? ` (showing ${top.length} of ${pool.length})` : "";
  return { reply: `${headLine}${countNote}`, events: top };
}

function isProgramNotEvent(e: any): boolean {
  const title = (e?.title || "").toLowerCase();
  const blob = `${title} ${(e?.description || "").toLowerCase().slice(0, 400)}`;
  // Explicitly hide weekly school listings from the consumer feed.
  if (/\b(weekend|weekday|sunday|saturday|summer|after[-\s]?school)\s+school\b/.test(blob)) return true;
  // If the event carries a concrete date AND time, treat it as a real event
  // even if the title says "class" or "course" — those are still scheduled
  // things users might want to attend. Previously we were dropping all
  // "Quran class" / "Arabic class" entries which caused Tuesdays to look
  // empty. Only strip ongoing generic listings with no schedule anchor.
  const hasAnchor = !!(e?.date && e?.start_time);
  if (hasAnchor) {
    // Only flag summer/weekend school catch-all entries with no real date.
    if (!e?.start_time && /\b(sunday|weekend|weekday|saturday|summer|after[-\s]?school)\s+school\b/.test(blob)) {
      return true;
    }
    return false;
  }
  // No anchor → apply the stricter filters below.
  if (/\b(sunday|weekend|weekday|saturday|summer|after[-\s]?school)\s+school\b/.test(blob)) return true;
  if (/\b(tajweed|tajwid|quran|qur'?an|hifz|hifdh|arabic|islamic\s+studies|fiqh|aqeedah|aqidah|seerah|tafsir|qira'?ah|qaida)\s+class(es)?\b/.test(blob)) return true;
  if (/\b(kids|children|youth|teen)\s+(class(es)?|program|club|circle)\b/.test(blob)) return true;
  // Generic "class" without a date anchor (usually ongoing)
  if (/^\s*(sisters'?|brothers'?|adult)\s+(tajweed|quran|qur'?an|arabic|fiqh|seerah|tafsir)\s+class(es)?\s*$/.test(title)) return true;
  // Pure registration/enrollment announcements (not the event itself)
  if (/\b(enroll(ment)?|registration)\s+(is\s+)?(now\s+)?(open|available|starting)\b/.test(blob) && !/\b(event|dinner|gala|conference|retreat|picnic|fundraiser|banquet)\b/.test(blob)) return true;
  return false;
}

function isJumuahEvent(e: Partial<EventItem> | null | undefined): boolean {
  if (!e) return false;
  const st = normalizeText((e.source_type || "").toString()).toLowerCase();
  if (st === "synthetic_jummah") return true;
  const topics = Array.isArray(e.topics) ? e.topics.join(" ") : "";
  const blob = `${e.title || ""} ${e.description || ""} ${e.category || ""} ${topics}`.toLowerCase();
  return /\bjumu'?ah|jumm?ah|friday\s+prayer|khutbah\b/.test(blob);
}

function isWeakEventTitle(raw: string): boolean {
  const s = normalizeText(raw).toLowerCase();
  if (!s) return true;
  if (/^(when|time|date|where)\b[:\-\s]*/.test(s)) return true;
  if (/^\*?\s*time\*?\s*[:\-]/.test(s)) return true;
  if (/^[/\\]+/.test(s)) return true;
  if (/^\d+\s+likes?,?\s+\d+\s+comments?\b/.test(s)) return true;
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{1,2}$/.test(s)) return true;
  if (/^-\s*[a-z0-9_]+.*join us in \d+\s*(hour|hours|hr|min|minutes)\b/.test(s)) return true;
  if (/\b(?:presented?\s+by|organized\s+by|hosted\s+by)\b/.test(s)) return true;
  if (/\bpresents?\b/.test(s) && s.split(/\s+/).length <= 6) return true;
  if (/\b(register|rsvp|follow|link in bio|swipe|tickets?)\b/.test(s) && s.split(/\s+/).length <= 8) {
    return true;
  }
  if (/\b(we hope to see you|see you all there|insha'?allah|will you attend|official rsvp|add to my device calendar|be the first from your circle|bring a friend)\b/.test(s)) {
    return true;
  }
  if (/\b(mon|tue|wed|thu|fri|sat|sun)\b/.test(s) && /\b\d{1,2}:\d{2}\s*(am|pm)\b/.test(s) && s.split(/\s+/).length <= 10) {
    return true;
  }
  return false;
}

function cleanedDescriptionForTitle(raw: string): string {
  const s = normalizeText(raw || "");
  if (!s) return "";
  // Strip Instagram lead-in like "9 likes, 1 comments - handle on Date: "
  return s
    .replace(/^\d+\s+likes?,?\s+\d+\s+comments?\s*-\s*[^:]+:\s*/i, "")
    .replace(/^"+|"+$/g, "")
    .trim();
}

function titleCaseSentence(s: string): string {
  const tiny = new Set(["a", "an", "and", "or", "of", "the", "to", "in", "for", "on", "with", "by"]);
  const words = normalizeText(s).split(/\s+/).filter(Boolean);
  return words
    .map((w, i) => {
      if (!w) return w;
      const low = w.toLowerCase();
      if (i > 0 && tiny.has(low)) return low;
      return low.charAt(0).toUpperCase() + low.slice(1);
    })
    .join(" ");
}

function eventTitleLineScore(line: string): number {
  const s = normalizeText(line);
  if (!s || isWeakEventTitle(s)) return -999;
  const low = s.toLowerCase();
  const words = s.split(/\s+/).length;
  let score = 0;
  if (/\b(tafsir|tafseer|seerah|sirah|hadith|qur'?an|quran|tajweed|halaqa|dars|khatira|khutbah|lecture|talk|series|workshop|seminar|program|class|course|retreat|conference)\b/i.test(s)) {
    score += 8;
  }
  if (/\b(with|by)\s+(sh\.?|shaykh|sheikh|imam|ustadh|dr\.?)\b/i.test(s)) score += 5;
  if (/\b(we hope to see you|see you all there|insha'?allah|join us tonight|official rsvp|will you attend)\b/i.test(s)) {
    score -= 12;
  }
  if (/^\s*[/\\]/.test(s)) score -= 4;
  if (words >= 4 && words <= 15) score += 2;
  if (words > 22) score -= 4;
  // Slight preference for lines that look like a clean headline.
  const letters = (s.match(/[a-z]/gi) || []).length;
  if (letters >= 12) score += 1;
  if (/\b(presents?|presented by|organized by)\b/.test(low) && !/\s*:\s*/.test(s)) score -= 3;
  return score;
}

function extractNarrativeTitle(e: Partial<EventItem> | null | undefined): string {
  const desc = cleanedDescriptionForTitle((e?.description || "").toString());
  const raw = normalizeText((e?.raw_text || "").toString());
  const poster = normalizeText((e?.poster_ocr_text || "").toString());
  const blob = `${desc}\n${raw}\n${poster}`;
  if (!blob.trim()) return "";

  const explicit = /(?:title of (?:today'?s|tonight'?s|this)\s+(?:class|session|lecture)\s+is|tonight'?s class is)\s*[“"']?([^"”'.!?]{4,100})/i.exec(blob);
  if (explicit?.[1]) {
    const t = normalizeText(explicit[1]);
    if (t && !isWeakEventTitle(t)) return titleCaseSentence(t);
  }

  const story = /\bstory of\s+([^.!?\n]{4,90})/i.exec(blob);
  if (story?.[1]) {
    const speaker = effectiveEventSpeakerName(e as EventItem);
    const topic = titleCaseSentence(`Story of ${normalizeText(story[1])}`);
    if (topic && !isWeakEventTitle(topic)) {
      if (speaker) return `Tafsir Series with ${speaker}: ${topic}`;
      return topic;
    }
  }

  const joinFor = /\bjoin us (?:for|this)\s+(?:an?\s+)?([^.!?\n]{4,90})/i.exec(blob);
  if (joinFor?.[1]) {
    const rawTopic = normalizeText(joinFor[1]).replace(/\s+(led by|at|on)\b.*$/i, "").trim();
    const topic = titleCaseSentence(rawTopic);
    if (topic && !isWeakEventTitle(topic) && /\b(workshop|series|class|lecture|talk|seminar|hike|retreat|course|night)\b/i.test(topic)) {
      return topic;
    }
  }

  const lines = blob
    .split(/[.\n]+/)
    .map((x) => normalizeText(x))
    .filter(Boolean);
  let best = "";
  let bestScore = -999;
  for (const line of lines) {
    if (line.length < 10 || line.length > 110) continue;
    const presentsPayload = /\bpresents?\s*:\s*(.+)$/i.exec(line);
    if (presentsPayload?.[1]) {
      const t = titleCaseSentence(presentsPayload[1]);
      const sc = eventTitleLineScore(t) + 2;
      if (sc > bestScore) {
        bestScore = sc;
        best = t;
      }
      continue;
    }
    const sc = eventTitleLineScore(line);
    if (sc > bestScore) {
      bestScore = sc;
      best = line;
    }
  }
  return bestScore >= 0 ? best : "";
}

function eventDisplayTitle(e: Partial<EventItem> | null | undefined): string {
  const primary = normalizeText((e?.title || "").toString());
  const narrative = extractNarrativeTitle(e);
  if (primary && !isWeakEventTitle(primary)) {
    // Prefer cleaner narrative title when the primary looks like OCR/header noise.
    if (narrative) {
      const p = primary.toLowerCase();
      if (/^[/\\]/.test(primary) || /\bpresents?\b/i.test(primary) || /\b(we hope to see you|join us tonight)\b/i.test(p)) {
        return narrative;
      }
    }
    return primary;
  }
  if (narrative) return narrative;
  const blob = `${e?.description || ""}\n${e?.raw_text || ""}\n${e?.poster_ocr_text || ""}`;
  const lines = blob
    .split(/\r?\n+/)
    .map((x) => normalizeText(x))
    .filter(Boolean);
  for (const line of lines) {
    if (line.length < 8 || line.length > 120) continue;
    if (isWeakEventTitle(line)) continue;
    if (/(going|interested|save|follow|register|rsvp|www\.|http|@)/i.test(line) && line.split(/\s+/).length <= 8) {
      continue;
    }
    return line;
  }
  const lowerBlob = blob.toLowerCase();
  let inferredType = "";
  if (/\b(tafsir|tafseer)\b/.test(lowerBlob)) inferredType = "Tafsir Session";
  else if (/\b(seerah|sirah)\b/.test(lowerBlob)) inferredType = "Seerah Session";
  else if (/\b(halaqa|halaqah)\b/.test(lowerBlob)) inferredType = "Halaqa";
  else if (/\b(workshop)\b/.test(lowerBlob)) inferredType = "Workshop";
  else if (/\b(class|course|lesson)\b/.test(lowerBlob)) inferredType = "Class";
  else if (/\b(lecture|talk|seminar|khutbah)\b/.test(lowerBlob)) inferredType = "Lecture";
  else if (/\b(fundraiser|charity)\b/.test(lowerBlob)) inferredType = "Fundraiser";
  if (inferredType) {
    const speaker = effectiveEventSpeakerName((e || {}) as EventItem);
    return speaker ? `${inferredType} with ${speaker}` : inferredType;
  }
  return primary || "Untitled event";
}

/** Normalize API/cache shapes into a list of http(s) image URLs. */
function coercePosterUrls(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    const out: string[] = [];
    for (const x of raw) {
      if (typeof x === "string") {
        const u = x.trim();
        if (u.startsWith("http")) out.push(u);
      } else if (x && typeof (x as { url?: string }).url === "string") {
        const u = (x as { url: string }).url.trim();
        if (u.startsWith("http")) out.push(u);
      }
    }
    return out;
  }
  if (typeof raw === "string" && raw.trim().startsWith("http")) return [raw.trim()];
  return [];
}

/**
 * Best flyer/poster URL for an event. Prefer non-placeholder images, then any
 * non-weak URL, then any URL so lists and modals still show art when the only
 * asset is a generic CDN path.
 */
function pickPoster(urls: unknown): string {
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
  const isInstagramUiAsset = (url: string): boolean => {
    const low = url.toLowerCase();
    return (
      low.includes("static.cdninstagram.com/rsrc.php") ||
      low.includes("instagram.com/static/images") ||
      // Common IG app/web chrome assets (not user poster media).
      low.includes("/rsrc.php/v4/") ||
      (low.includes("cdninstagram.com") && low.includes("/rsrc.php"))
    );
  };
  const cleaned = coercePosterUrls(urls);
  if (!cleaned.length) return "";
  const good = cleaned.find((u) => !isInstagramUiAsset(u) && !bad.some((k) => u.toLowerCase().includes(k)));
  if (good) return good;
  const notWeak = cleaned.find((u) => !isInstagramUiAsset(u) && !isWeakPosterUrl(u));
  if (notWeak) return notWeak;
  const nonUi = cleaned.find((u) => !isInstagramUiAsset(u));
  return nonUi || cleaned[0] || "";
}

function eventPosterUrl(e: Pick<EventItem, "image_urls">): string {
  return pickPoster(e.image_urls);
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

function sourceTypeLabelForEvent(e: EventItem): string {
  const st = normalizeText(e.source_type || e.freshness?.source_type || "").toLowerCase();
  if (st === "instagram" || st === "instagram_recurring") return "Instagram";
  if (st === "email") return "Email";
  if (st === "website") return "Website";
  if (st === "synthetic_jummah") return "Synthetic";
  const url = normalizeText(e.source_url || "").toLowerCase();
  if (url.includes("instagram.com")) return "Instagram";
  if (url.includes("mail") || url.includes("gmail")) return "Email";
  if (url) return "Website";
  return "Unknown source";
}

function freshnessAgeLabel(e: EventItem): string {
  if (typeof e.freshness?.days_old === "number") {
    if (e.freshness.days_old <= 0) return "Fresh now";
    if (e.freshness.days_old === 1) return "1 day old";
    return `${Math.round(e.freshness.days_old)} days old`;
  }
  const posted = normalizeText(e.posted_at_utc || e.freshness?.posted_at || "");
  if (!posted) return "";
  const ts = Date.parse(posted);
  if (!Number.isFinite(ts)) return "";
  const days = Math.max(0, Math.round((Date.now() - ts) / (1000 * 60 * 60 * 24)));
  if (days <= 0) return "Fresh now";
  if (days === 1) return "1 day old";
  return `${days} days old`;
}

function duplicateSuppressionReason(e: EventItem): string {
  const uid = normalizeText(e.event_uid || "");
  if (uid) return "dedupe by event uid";
  const src = normalizeText(e.source_url || "");
  if (src) return "dedupe by source url";
  if (eventPosterUrl(e)) return "dedupe by poster + schedule";
  return "dedupe by source + schedule";
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

/** Sync normalization for M-AB12C-style share codes (same rules as commitReferralCode). */
function normalizeMasjidlyShareCode(raw: string): string {
  const cleaned = (raw || "")
    .toString()
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/^MASJIDLY[-\s]*/i, "")
    .replace(/^INVITE[-\s]*/i, "");
  if (!cleaned) return "";
  if (/^M-[A-Z0-9]{3,8}$/.test(cleaned)) return cleaned;
  if (/^M[A-Z0-9]{3,8}$/.test(cleaned)) return `M-${cleaned.slice(1)}`;
  if (/^[A-Z0-9]{3,8}$/.test(cleaned)) return `M-${cleaned}`;
  return "";
}

function AppInner() {
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Re-render time-sensitive labels (LIVE / starts soon / already happened)
  // without requiring a manual refresh.
  const [clockNowMs, setClockNowMs] = useState(() => Date.now());
  // Re-rendered at midnight and whenever the app returns to foreground so any
  // logic keyed off `today` advances without a cold start. Derived from the
  // device's local timezone.
  const [todayLocalIso, setTodayLocalIso] = useState<string>(todayIso());
  const today = todayLocalIso;
  const [devTapCount, setDevTapCount] = useState(0);
  const [developerPanelOpen, setDeveloperPanelOpen] = useState(false);

  const [reference, setReference] = useState("");
  const [radius, setRadius] = useState("35");
  const [query, setQuery] = useState("");
  const [startDate, setStartDate] = useState(todayIso());
  const [endDate, setEndDate] = useState(plusDaysIso(365));
  const [audienceFilter, setAudienceFilter] = useState<"all" | "brothers" | "sisters" | "family">("all");
  const [selectedSources, setSelectedSources] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<TabKey>("home");
  const [mountedTabs, setMountedTabs] = useState<Set<TabKey>>(
    () => new Set<TabKey>(["home", "explore", "discover", "calendar", "feed", "settings"])
  );
  // Outer Explore list is now a SectionList (virtualized); keep the ref loose
  // so switchTab can call scrollToLocation without type gymnastics.
  const exploreScrollRef = useRef<SectionList<EventItem> | null>(null);
  const calendarScrollRef = useRef<ScrollView | null>(null);
  const feedScrollRef = useRef<ScrollView | null>(null);
  const settingsScrollRef = useRef<ScrollView | null>(null);
  const settingsJumuahOffsetRef = useRef(0);
  const switchTab = useCallback((next: TabKey) => {
    // Fire haptic synchronously so the tap feels instant even if React takes a
    // frame or two to paint the target tab. This is the single biggest
    // perceived-speed lever for the bottom tab bar.
    try { hapticTap("selection"); } catch { /* non-fatal */ }
    setMountedTabs((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
    setTab(next);
    // Snap each scene to the top when the user taps its tab so they always
    // land on the most relevant content (e.g. today's events on Explore).
    requestAnimationFrame(() => {
      if (next === "explore") {
        // For the Map tab we want the hero map at the very top, not the first
        // event row; `scrollToLocation(section=0,item=0)` can land halfway
        // down by skipping the large header.
        try {
          (
            exploreScrollRef.current as unknown as {
              scrollToOffset?: (args: { offset: number; animated: boolean }) => void;
            } | null
          )?.scrollToOffset?.({ offset: 0, animated: false });
        } catch {
          // Safe no-op if list isn't mounted yet.
        }
      }
      if (next === "calendar") calendarScrollRef.current?.scrollTo({ y: 0, animated: false });
      if (next === "feed") {
        try {
          feedScrollRef.current?.scrollTo({ y: 0, animated: false });
        } catch {
          // safe no-op if list isn't mounted yet
        }
      }
    });
  }, []);
  const [entryScreen, setEntryScreen] = useState<"welcome" | "onboarding" | "launch" | "app">("welcome");
  // Guided tour (first-time walkthrough narrated by the Muslim pixel sprite).
  // Persists via SecureStore so it only plays once per install. The tour
  // drives tab navigation + highlights so the user sees each part live.
  const [guidedTourOpen, setGuidedTourOpen] = useState(false);
  const [guidedTourStep, setGuidedTourStep] = useState(0);
  const guidedTourAutoOpenTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tourPulse = useRef(new Animated.Value(0)).current;
  // Cross-fade values used to smoothly swap the tour card + highlight ring
  // between steps. We apply them to both the card container and the ring
  // so the old-step UI fades out together, the step state advances while
  // everything is invisible, then the new-step UI fades in in place.
  const tourContentOpacity = useRef(new Animated.Value(1)).current;
  const tourContentTranslate = useRef(new Animated.Value(0)).current;
  // Tracks whether a cross-fade is currently running so rapid taps on
  // "Next" / backdrop don't overlap animations.
  const tourTransitioningRef = useRef(false);
  // Floating sprite chatbot — always available top-right once the user is in
  // the main app shell. Opens a modal with event-aware Q&A.
  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<Array<{ role: "bot" | "user"; text: string; ts: number }>>([]);
  const [chatInput, setChatInput] = useState("");
  const chatScrollRef = useRef<ScrollView | null>(null);
  // Persistent bob for the floating sprite button so it feels alive
  const floatingSpriteBob = useRef(new Animated.Value(0)).current;
  // Orange halo behind the avatar — continuous breathe (never stops while on Home).
  const floatingSpriteHaloPulse = useRef(new Animated.Value(0)).current;
  // Slow, looping drift for the two decorative circles in the home logo
  // box (`topBarGlow` + `topBarGlowB`) so the brand feels alive without
  // being distracting. Both circles share one phase so they move together
  // as a single connected visual rhythm.
  const logoGlowA = useRef(new Animated.Value(0)).current;
  const [selectedEvent, setSelectedEvent] = useState<EventItem | null>(null);
  // Two-phase mount for the event detail modal: when a user taps an event we
  // want the Modal's fade animation to start immediately, so we render a cheap
  // skeleton until `detailReady` flips true on the next interaction tick. That
  // way the heavy hero + sections don't block the tap.
  const [detailReady, setDetailReady] = useState(false);
  const [currentUser, setCurrentUser] = useState<UserAuth | null>(null);
  const [deepLinkEventUid, setDeepLinkEventUid] = useState("");
  const [profileDraft, setProfileDraft] = useState<ProfilePayload>({
    favorite_sources: [],
    audience_filter: "all",
    radius: 35,
    onboarding_done: false,
    notifications: {
      new_event_followed: true,
      followed_speakers: true,
      tonight_after_maghrib: true,
      prayer_reminders: true,
      rsvp_reminders: true,
      quiet_hours_start: "22:30",
      quiet_hours_end: "06:30",
      daily_notification_cap: 6,
    },
  });
  const [pushToken, setPushToken] = useState("");
  const [savedEventsMap, setSavedEventsMap] = useState<Record<string, EventItem>>({});
  const [themeMode, setThemeMode] = useState<ThemeMode>("minera");
  const [onboardingError, setOnboardingError] = useState("");
  const [pendingWelcomeSlide, setPendingWelcomeSlide] = useState<number | null>(null);
  const welcomeSetupScrollRef = useRef<ScrollView | null>(null);
  const welcomeSetupScrollYRef = useRef(0);
  const [calendarView, setCalendarView] = useState<"month" | "list">("month");
  // "My Plan" mode filters the calendar to events the user has RSVP'd to
  // (going or interested). Great for checking what your own week looks like
  // without the noise of every event in the network.
  const [calendarMyPlan, setCalendarMyPlan] = useState(false);
  const [selectedCalendarDate, setSelectedCalendarDate] = useState("");
  // Which month is currently displayed in the calendar grid. Starts on "today"
  // and shifts forward/backward via ‹ / › arrows. Stored as an ISO date so we
  // can keep it in sync across midnight rollovers.
  const [calendarAnchorIso, setCalendarAnchorIso] = useState<string>(() => todayIso());
  const [selectedCalendarModalDate, setSelectedCalendarModalDate] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("relevant");
  const [exploreMode, setExploreMode] = useState<ExploreMode>("list");
  const [selectedMasjidSheet, setSelectedMasjidSheet] = useState("");
  const [showExploreFilters, setShowExploreFilters] = useState(false);
  const [showPrivacyPolicy, setShowPrivacyPolicy] = useState(false);
  const [showTermsOfUse, setShowTermsOfUse] = useState(false);
  const [showAboutPanel, setShowAboutPanel] = useState(false);
  const [quickFilters, setQuickFilters] = useState<QuickFilterId[]>([]);
  const [feedTopicFilter, setFeedTopicFilter] = useState<string | null>(null);
  // Top-level view switch inside Your Feed: "all" shows the personalized feed
  // sections (For You / Masjids / Scholars / Interests / Saved); "saved"
  // switches the whole screen to a dedicated saved & RSVP list so users can
  // get back to anything they hearted or marked going without scrolling past
  // the feed.
  const [feedView, setFeedView] = useState<"all" | "saved">("all");
  const [feedSetupDone, setFeedSetupDone] = useState(false);
  const [feedSetupOpen, setFeedSetupOpen] = useState(false);
  // When true, re-open the inline Your Feed wizard in-place (replacing the
  // feed body) even though the user already completed setup once. This is
  // how the "Edit Your Feed" card and Settings entry invite users to change
  // their masjids/speakers/topics without popping a modal over the feed.
  const [feedEditMode, setFeedEditMode] = useState(false);
  const [feedSetupStep, setFeedSetupStep] = useState<0 | 1 | 2 | 3>(0);
  const [feedSetupMasjids, setFeedSetupMasjids] = useState<string[]>([]);
  const [feedSetupScholars, setFeedSetupScholars] = useState<string[]>([]);
  const [feedSetupTopics, setFeedSetupTopics] = useState<string[]>([]);
  const [feedSetupApplying, setFeedSetupApplying] = useState(false);
  const [feedBuildPhase, setFeedBuildPhase] = useState<"building" | "success" | null>(null);
  const feedBuildProgress = useRef(new Animated.Value(0)).current;
  const feedBuildHammerTilt = useRef(new Animated.Value(0)).current;
  const feedBuildSuccessScale = useRef(new Animated.Value(0.6)).current;
  const feedSetupHydratedRef = useRef(false);
  const [savedFilterPresets, setSavedFilterPresets] = useState<SavedFilterPreset[]>([]);
  const [presetDraftLabel, setPresetDraftLabel] = useState("");
  const [editingPresetId, setEditingPresetId] = useState("");
  // Keep the map's current region in a ref (not state) so user pans / zooms and
  // programmatic re-centers don't thrash the whole Explore memoized tree. We
  // still persist the last viewed region to SecureStore between launches.
  const mapRegionRef = useRef<Region>(DEFAULT_MAP_REGION);
  const mapRef = useRef<MapView | null>(null);
  const [followedMasjids, setFollowedMasjids] = useState<string[]>([]);
  const [mutedFeedSources, setMutedFeedSources] = useState<string[]>([]);
  const [rsvpStatuses, setRsvpStatuses] = useState<Record<string, RsvpStatus>>({});
  // One-shot: after events hydrate for the first time and we know the user's
  // RSVPs, schedule any missing day-of / 2h reminders. This catches users who
  // tapped "Going" before this feature existed.
  const rsvpReminderCatchupRan = useRef(false);
  useEffect(() => {
    if (rsvpReminderCatchupRan.current) return;
    if (profileDraft.notifications?.rsvp_reminders === false) {
      rsvpReminderCatchupRan.current = true;
      return;
    }
    if (!events.length) return;
    const rsvpKeys = Object.keys(rsvpStatuses);
    if (!rsvpKeys.length) { rsvpReminderCatchupRan.current = true; return; }
    rsvpReminderCatchupRan.current = true;
    (async () => {
      try {
        const raw = await SecureStore.getItemAsync(RSVP_NOTIFICATION_IDS_KEY);
        const scheduled: Record<string, string[]> = raw ? JSON.parse(raw) : {};
        for (const e of events) {
          const key = e.event_uid ? String(e.event_uid) : `${e.source || ""}|${e.date || ""}|${e.start_time || ""}|${e.title || ""}`;
          if (!rsvpStatuses[key]) continue;
          if (scheduled[key]) continue;
          try { await scheduleEventReminders(e, profileDraft.notifications); } catch { /* non-fatal */ }
        }
      } catch { /* non-fatal */ }
    })();
  }, [events, rsvpStatuses, profileDraft.notifications?.rsvp_reminders]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (profileDraft.notifications?.prayer_reminders === false) {
          const raw = await SecureStore.getItemAsync(PRAYER_NOTIFICATION_IDS_KEY);
          const ids: string[] = raw ? JSON.parse(raw) : [];
          for (const id of ids) {
            try { await Notifications.cancelScheduledNotificationAsync(id); } catch { /* non-fatal */ }
          }
          await SecureStore.deleteItemAsync(PRAYER_NOTIFICATION_IDS_KEY);
          return;
        }
        if (!followedMasjids.length) return;
        const res = await fetch(`${API_BASE_URL}/api/prayer-times`);
        if (!res.ok) return;
        const payload = await res.json();
        const rows = Array.isArray(payload?.sources) ? payload.sources : [];
        const followedSet = new Set(followedMasjids.map((s) => normalizeText(s).toLowerCase()));
        const now = new Date();
        const scheduledIds: string[] = [];
        for (const row of rows) {
          if (cancelled) return;
          const src = normalizeText(row?.source).toLowerCase();
          if (!followedSet.has(src)) continue;
          const prayers = row?.prayers || {};
          for (const prayerName of ["maghrib", "isha"]) {
            const mm = parseClockMinutes(prayers?.[prayerName]);
            if (mm == null) continue;
            const trigger = new Date(now);
            trigger.setHours(Math.floor(mm / 60), mm % 60, 0, 0);
            trigger.setMinutes(trigger.getMinutes() - 15);
            if (trigger.getTime() <= Date.now() + 90_000) continue;
            const allow = await consumeNotificationCap(trigger, profileDraft.notifications, "high");
            if (!allow) continue;
            try {
              const id = await Notifications.scheduleNotificationAsync({
                content: {
                  title: `${formatSourceLabel(src)} · ${prayerName[0].toUpperCase() + prayerName.slice(1)} soon`,
                  body: `Prayer time around ${formatClock12(prayers?.[prayerName] || "")}.`,
                  data: { source: src, kind: "prayer_reminder", prayer: prayerName },
                },
                trigger: trigger as any,
              });
              scheduledIds.push(id);
            } catch {
              // non-fatal
            }
          }
        }
        if (!cancelled) await SecureStore.setItemAsync(PRAYER_NOTIFICATION_IDS_KEY, JSON.stringify(scheduledIds));
      } catch {
        // non-fatal
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [followedMasjids, profileDraft.notifications]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const prevId = await SecureStore.getItemAsync(TONIGHT_DIGEST_NOTIFICATION_KEY);
        if (prevId) {
          try { await Notifications.cancelScheduledNotificationAsync(prevId); } catch { /* non-fatal */ }
          await SecureStore.deleteItemAsync(TONIGHT_DIGEST_NOTIFICATION_KEY);
        }
        if (profileDraft.notifications?.tonight_after_maghrib === false) return;
        const now = new Date();
        const trigger = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 19, 30, 0, 0);
        if (trigger.getTime() <= Date.now() + 90_000) return;
        const allow = await consumeNotificationCap(trigger, profileDraft.notifications, "low");
        if (!allow) return;
        const tonightCount = events.filter((e) => {
          if ((e.date || "") !== todayIso()) return false;
          if (!followedMasjids.length) return true;
          return followedMasjids.some((src) => normalizeText(src).toLowerCase() === normalizeText(e.source).toLowerCase());
        }).length;
        const id = await Notifications.scheduleNotificationAsync({
          content: {
            title: "Tonight after Maghrib",
            body: tonightCount > 0 ? `${tonightCount} program${tonightCount === 1 ? "" : "s"} near you.` : "See what's happening near your masjids tonight.",
            data: { kind: "tonight_digest" },
          },
          trigger: trigger as any,
        });
        if (!cancelled) await SecureStore.setItemAsync(TONIGHT_DIGEST_NOTIFICATION_KEY, id);
      } catch {
        // non-fatal
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [events, followedMasjids, profileDraft.notifications]);
  const [feedbackResponses, setFeedbackResponses] = useState<Record<string, "helpful" | "off" | "attended">>({});
  const [showModerationQueue, setShowModerationQueue] = useState(false);
  const [moderationReports, setModerationReports] = useState<any[]>([]);
  const [selectedMasjidProfile, setSelectedMasjidProfile] = useState("");
  const [reportIssueType, setReportIssueType] = useState("time");
  const [reportDetails, setReportDetails] = useState("");
  const [showReportSection, setShowReportSection] = useState(false);
  /** Technical trust breakdown + quick-fix actions (hidden by default). */
  const [showEventDataChecks, setShowEventDataChecks] = useState(false);
  /** Event detail: full-screen poster viewer */
  const [posterFullscreenUri, setPosterFullscreenUri] = useState<string | null>(null);
  const [showFullDescription, setShowFullDescription] = useState(false);
  const [showOriginalDescription, setShowOriginalDescription] = useState(false);
  const [cacheWarmStatus, setCacheWarmStatus] = useState<"warming" | "ready">("warming");
  const [reflectionState, setReflectionState] = useState<{ event?: EventItem; rating: number; text: string } | null>(null);
  const [eventSeries, setEventSeries] = useState<EventSeries[]>([]);
  const [speakers, setSpeakers] = useState<Speaker[]>([]);
  const [scholarScreenOpen, setScholarScreenOpen] = useState(false);
  const [selectedSpeaker, setSelectedSpeaker] = useState<string | null>(null);
  // Past YouTube talks per speaker slug. Populated lazily when a user
  // opens a scholar; the backend keeps a fresh copy in SQLite so we can
  // show lectures even when YouTube is temporarily unreachable.
  const [speakerVideos, setSpeakerVideos] = useState<
    Record<string, { videos: SpeakerVideo[]; loading: boolean; status?: string }>
  >({});
  // Per-source amenities loaded once at startup (see loadMasjidAmenities).
  // The map key is the lowercased source slug and each entry is the
  // exact payload the admin panel wrote, minus the row-id metadata.
  const [masjidAmenities, setMasjidAmenities] = useState<
    Record<string, MasjidAmenities>
  >({});
  // Discover > Collections preview. When set, we show a full-screen modal
  // listing exactly the events that match the selected editorial collection.
  // This way every collection tile lands somewhere concrete (not a dead-end
  // tab switch) — including "Tonight" / "This weekend" / "For reverts"
  // which don't have a direct 1:1 Explore filter.
  const [collectionPreview, setCollectionPreview] = useState<
    | null
    | {
        id: string;
        title: string;
        sub: string;
        events: EventItem[];
        exploreHandoff?: { halaqa?: string | null; quick?: QuickFilterId[] };
      }
  >(null);

  // The "AI knowledge plan" sheet opened from the Calendar tab. Each
  // plan is a curated sequence of events that teach one topic well.
  const [knowledgePlanPreview, setKnowledgePlanPreview] = useState<
    | null
    | {
        id: string;
        title: string;
        sub: string;
        mi: MiName;
        color: string;
        events: EventItem[];
      }
  >(null);
  // Followed scholars — persisted locally so a user's list survives app restarts.
  const [followedScholars, setFollowedScholars] = useState<string[]>([]);
  // Tracks masjid sources whose remote logo 404'd or failed to load so we
  // permanently fall back to text initials for them this session.
  const [failedLogoSources, setFailedLogoSources] = useState<Set<string>>(() => new Set());
  const markLogoFailed = useCallback((source: string) => {
    const key = (source || "").toLowerCase();
    if (!key) return;
    setFailedLogoSources((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);

  useEffect(() => {
    const id = setInterval(() => setClockNowMs(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  // Remote poster URLs that failed to load once. We remember failures so the
  // UI can immediately render the fallback art instead of showing a blank box.
  const [failedPosterUrls, setFailedPosterUrls] = useState<Set<string>>(() => new Set());
  const markPosterFailed = useCallback((url: string) => {
    const key = normalizeText(url);
    if (!key) return;
    setFailedPosterUrls((prev) => {
      if (prev.has(key)) return prev;
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  }, []);
  const canRenderPoster = useCallback(
    (url: string) => {
      const key = normalizeText(url);
      return !!key && !failedPosterUrls.has(key);
    },
    [failedPosterUrls],
  );

  // Renders a masjid logo with graceful fallback: if we have a confirmed
  // domain for the source we render the real logo (curated override or
  // Google favicon service); on load error it flips to text-initials in
  // the masjid's brand color. Shared across map pins, masjid sheet,
  // profile modal, event detail hero, and Discover rows.
  const renderMasjidLogo = useCallback(
    (
      source: string,
      size: number,
      opts?: { style?: any; textStyle?: any; borderColor?: string; borderWidth?: number }
    ) => {
      const src = (source || "").toLowerCase();
      const tint = masjidBrandColor(src);
      const uri = masjidLogoUrl(src);
      const failed = failedLogoSources.has(src);
      const borderStyle = opts?.borderColor
        ? { borderWidth: opts?.borderWidth ?? 1.5, borderColor: opts.borderColor }
        : null;
      const containerBase = {
        width: size,
        height: size,
        borderRadius: size / 2,
        alignItems: "center" as const,
        justifyContent: "center" as const,
        overflow: "hidden" as const,
      };
      if (uri && !failed) {
        return (
          <View style={[containerBase, { backgroundColor: "#ffffff" }, borderStyle, opts?.style]}>
            <Image
              source={{ uri }}
              style={{ width: size - 4, height: size - 4, borderRadius: (size - 4) / 2 }}
              resizeMode="contain"
              fadeDuration={0}
              onError={() => markLogoFailed(src)}
            />
          </View>
        );
      }
      return (
        <View style={[containerBase, { backgroundColor: tint }, borderStyle, opts?.style]}>
          <Text style={[{ color: "#fff", fontWeight: "800", fontSize: Math.max(10, Math.round(size * 0.36)) }, opts?.textStyle]}>
            {masjidInitials(src)}
          </Text>
        </View>
      );
    },
    [failedLogoSources, markLogoFailed]
  );
  const [halaqaFilter, setHalaqaFilter] = useState<string | null>(null);
  // Progressive render: Explore starts by drawing only the next ~2 weeks of
  // day-sections. "Show more" reveals the rest. Keeps tap-to-tab snappy even
  // when the catalog has hundreds of events.
  const EXPLORE_SECTIONS_BATCH = 14;
  const [exploreSectionLimit, setExploreSectionLimit] = useState(EXPLORE_SECTIONS_BATCH);
  const [passportStamps, setPassportStamps] = useState<{ source: string; stamped_at: string }[]>([]);
  const [passportOpen, setPassportOpen] = useState(false);
  const [qrEntryBuffer, setQrEntryBuffer] = useState("");
  const [iqamaBySource, setIqamaBySource] = useState<Record<string, Record<string, { iqama: string; jumuah_times: string[] }>>>({});
  // Calculated *adhan* (prayer start) times per masjid, keyed by source
  // slug. Sourced from the Aladhan public API using the masjid's known
  // lat/lon in MASJID_COORDS. We use this as a fallback when the backend
  // hasn't ingested a masjid's iqama page yet — it's not perfectly
  // accurate (iqama is always *after* adhan), but it still gives users
  // a useful "what's the prayer window right now" signal without a
  // dedicated scraper.
  const [prayerTimesBySource, setPrayerTimesBySource] = useState<
    Record<string, { date: string; fajr: string; dhuhr: string; asr: string; maghrib: string; isha: string }>
  >({});
  const [prayerApiBySource, setPrayerApiBySource] = useState<
    Record<
      string,
      {
        source_url: string;
        last_updated_label: string;
        source_type: string;
        is_stale: boolean;
        stale_reason: string;
        prayers: Record<string, string>;
        iqama: Record<string, string>;
        jumuah: Array<{ time: string; language?: string; parking_notes?: string; women_section?: string; minutes_until?: number }>;
      }
    >
  >({});
  const [masjidProfileViewTab, setMasjidProfileViewTab] = useState<"events" | "prayer">("events");
  const [jumuahFinderRows, setJumuahFinderRows] = useState<any[]>([]);
  const [showJumuahFinder, setShowJumuahFinder] = useState(false);
  const [jumuahFilters, setJumuahFilters] = useState<{ language: string; start: string; end: string; radius: number; parking: boolean }>({
    language: "",
    start: "12:00",
    end: "14:30",
    radius: 25,
    parking: false,
  });
  const [streakCount, setStreakCount] = useState(0);
  const [streakMonth, setStreakMonth] = useState(todayIso().slice(0, 7));
  const [goalCount] = useState(2);
  const [referralCode, setReferralCode] = useState("");
  // Who invited this user — set once and persisted. If empty, we show
  // a "Got a friend code? Enter it for the merch raffle" prompt.
  const [referredByCode, setReferredByCode] = useState("");
  // How many friends have joined with *our* code. Updated from backend on
  // profile fetch; falls back to whatever we cached locally so the number
  // doesn't regress when offline.
  const [referralWins, setReferralWins] = useState(0);
  // Input buffer used by the "Enter a friend's code" field on both
  // onboarding and Settings. Kept separate from `referredByCode` so the
  // user can edit before committing.
  const [referralInput, setReferralInput] = useState("");
  const [referralSavingState, setReferralSavingState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [referralSaveError, setReferralSaveError] = useState("");
  const [lastSyncedAt, setLastSyncedAt] = useState<number>(Date.now());
  const [personalization, setPersonalization] = useState<PersonalizationPrefs>({
    name: "",
    heardFrom: "",
    email: "",
    emailOptIn: false,
    gender: "",
    preferredAudience: "all",
    interests: [],
    completed: false,
    privacy_policy_accepted_version: "",
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
  const welcomeScrollX = useRef(new Animated.Value(0)).current;
  // Step transition animations: fade + slide when moving between sub-steps
  // of the onboarding form and the inline feed-setup wizard. Direction refs
  // let us slide in from the right when advancing (Next) and from the left
  // when going back (Back).
  const setupStepAnim = useRef(new Animated.Value(1)).current;
  const setupStepDirRef = useRef<1 | -1>(1);
  const feedStepAnim = useRef(new Animated.Value(1)).current;
  const feedStepDirRef = useRef<1 | -1>(1);
  /** Same horizontal travel as welcome cardFlipTranslateX edge (58px) for a consistent wipe. */
  const STEP_TRANSITION_PX = 58;
  const STEP_TRANSITION_MS = 280;
  // Muslim pixel sprite that drops in, grabs the welcome card, lifts it,
  // greets the user with a salam + welcome, then releases and flies away.
  // Plays once per welcome mount when slide 0 is active.
  const spriteTranslateY = useRef(new Animated.Value(-280)).current;
  const spriteTranslateX = useRef(new Animated.Value(0)).current;
  const spriteScale = useRef(new Animated.Value(0.9)).current;
  const spriteCardLiftY = useRef(new Animated.Value(0)).current;
  const spriteBubbleOpacity = useRef(new Animated.Value(0)).current;
  const spriteBubbleScale = useRef(new Animated.Value(0.85)).current;
  const spriteBounce = useRef(new Animated.Value(0)).current;
  const spriteArmReach = useRef(new Animated.Value(0)).current;
  const [spriteBubbleText, setSpriteBubbleText] = useState<string>("");
  const hasPlayedSpriteRef = useRef(false);
  // True for the single render cycle right after the user finishes (or skips)
  // onboarding. We use this to:
  //   1. Always route first-timers through the `launch` celebration screen
  //      instead of jumping straight to Home (so they see "Welcome to
  //      Masjid.ly!" for ~2s before the feed).
  //   2. Swap the launch screen's subtitle from "Welcome back, <name>" to
  //      a proper first-time greeting.
  const justCompletedOnboardingRef = useRef(false);
  const onboardingCardOpacity = useRef(new Animated.Value(0)).current;
  const onboardingCardTranslateY = useRef(new Animated.Value(48)).current;
  const finishExitProgress = useRef(new Animated.Value(0)).current;
  const launchOpacity = useRef(new Animated.Value(0)).current;
  const launchScale = useRef(new Animated.Value(0.9)).current;
  const launchTranslateY = useRef(new Animated.Value(18)).current;
  const launchGlowDrift = useRef(new Animated.Value(0)).current;
  // Master exit opacity — applied to the entire launch screen wrapper so
  // glows, card, and greeting all fade together instead of the greeting
  // lingering while the card disappears. Starts visible (1) and fades to 0
  // only during the final exit step.
  const launchExitOpacity = useRef(new Animated.Value(1)).current;
  // App-shell fade-in used to cross-fade from the launch celebration
  // into Home. Defaults to 1 (fully visible) and only drops to 0 right
  // before we kick off the hand-off animation in `runExit`.
  const appShellFadeIn = useRef(new Animated.Value(1)).current;
  // While the launch → app cross-fade is running we render the launch
  // screen as an absolute overlay on top of the main app shell so both
  // screens can animate simultaneously. Cleared once the fade finishes.
  const [launchOverlayVisible, setLaunchOverlayVisible] = useState(false);
  // Three-dot bouncing indicator shown under the card so the 2.8s intro
  // doesn't feel stalled, and stays visible if data loading drags on beyond
  // the intro timeline.
  const launchDotPulse = useRef(new Animated.Value(0)).current;
  const homeHeroGlowDrift = useRef(new Animated.Value(0)).current;
  const homeHeroGlowLoopRef = useRef<Animated.CompositeAnimation | null>(null);
  // Spins the refresh icon while the event list is being re-fetched.
  // Also drives the Masjid.ly hero logo's extra pulse on manual refresh.
  const refreshSpin = useRef(new Animated.Value(0)).current;
  const refreshSpinLoopRef = useRef<Animated.CompositeAnimation | null>(null);
  const heroRefreshPulse = useRef(new Animated.Value(0)).current;
  // (legacy explore intro-motion removed; tabs now stay mounted and switch instantly)
  const welcomeSlidesRef = useRef<ScrollView | null>(null);
  const [welcomeSlideIndex, setWelcomeSlideIndex] = useState(0);
  const welcomeContinueTapTsRef = useRef(0);
  // Sub-step within the third welcome slide ("Tell us about yourself").
  // 0: name + how-heard + email (+ opt-in)
  // 1: gender + what events + friend code
  // 2: privacy consent
  // 3: finish setup (review/confirm)
  const [setupSubStep, setSetupSubStep] = useState<0 | 1 | 2 | 3>(0);
  // Keeps step-1 interest taps snappy by deferring the expensive
  // app-wide personalization re-rank until the user taps "Next".
  const [setupInterestsDraft, setSetupInterestsDraft] = useState<string[] | null>(null);
  /** Prevents double-submit on Finish Setup; no blocking overlay — we jump straight to launch. */
  const finishSetupInFlightRef = useRef(false);
  // Run a quick slide+fade enter animation whenever the onboarding sub-step
  // or feed-setup wizard step changes. The direction refs are updated in the
  // Back/Next handlers so the new content slides in from the correct side.
  useEffect(() => {
    setupStepAnim.setValue(0);
    Animated.timing(setupStepAnim, {
      toValue: 1,
      duration: STEP_TRANSITION_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [setupSubStep, setupStepAnim]);
  useEffect(() => {
    feedStepAnim.setValue(0);
    Animated.timing(feedStepAnim, {
      toValue: 1,
      duration: STEP_TRANSITION_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [feedSetupStep, feedStepAnim]);
  useEffect(() => {
    if (entryScreen !== "welcome" || welcomeSlideIndex !== 2 || setupSubStep !== 1) return;
    setSetupInterestsDraft((prev) => (prev === null ? [...personalization.interests] : prev));
  }, [entryScreen, welcomeSlideIndex, setupSubStep, personalization.interests]);
  useEffect(() => {
    if (entryScreen === "welcome") return;
    setSetupInterestsDraft(null);
  }, [entryScreen]);
  const { width: screenWidth, height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const eventModalPosterHeight = Math.min(240, Math.round(windowHeight * 0.26));
  const masjidPosterWidth = Math.min(320, Math.round(screenWidth - 64));
  const masjidPosterHeight = Math.round(masjidPosterWidth * (4 / 3)) + 104;
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
          email: normalizeText((parsed as any).email || ""),
          emailOptIn: !!(parsed as any).emailOptIn,
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
          privacy_policy_accepted_version:
            typeof (parsed as any).privacy_policy_accepted_version === "string"
              ? (parsed as any).privacy_policy_accepted_version
              : "",
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
        const [followedRaw, rsvpRaw, presetsRaw, feedbackRaw, streakRaw, referralRaw, scholarsRaw, mutedSourcesRaw, referredByRaw, referralWinsRaw, feedSetupDoneRaw] = await Promise.all([
          SecureStore.getItemAsync(FOLLOWED_MASJIDS_KEY),
          SecureStore.getItemAsync(RSVP_STATUSES_KEY),
          SecureStore.getItemAsync(FILTER_PRESETS_KEY),
          SecureStore.getItemAsync(FEEDBACK_RESPONSES_KEY),
          SecureStore.getItemAsync(STREAK_TRACKER_KEY),
          SecureStore.getItemAsync(REFERRAL_CODE_KEY),
          SecureStore.getItemAsync(FOLLOWED_SCHOLARS_KEY),
          SecureStore.getItemAsync(MUTED_FEED_SOURCES_KEY),
          SecureStore.getItemAsync(REFERRED_BY_KEY),
          SecureStore.getItemAsync(REFERRAL_WINS_KEY),
          SecureStore.getItemAsync(FEED_SETUP_DONE_KEY),
        ]);
        if (followedRaw) {
          const parsed = JSON.parse(followedRaw);
          if (Array.isArray(parsed)) setFollowedMasjids(parsed.map((x) => normalizeText(String(x))).filter(Boolean));
        }
        if (scholarsRaw) {
          try {
            const parsed = JSON.parse(scholarsRaw);
            if (Array.isArray(parsed)) setFollowedScholars(parsed.map((x) => String(x)).filter(Boolean));
          } catch { /* corrupt json — ignore */ }
        }
        if (mutedSourcesRaw) {
          try {
            const parsed = JSON.parse(mutedSourcesRaw);
            if (Array.isArray(parsed)) setMutedFeedSources(parsed.map((x) => normalizeText(String(x)).toLowerCase()).filter(Boolean));
          } catch {
            // ignore
          }
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
          const generated = `M-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
          setReferralCode(generated);
          await SecureStore.setItemAsync(REFERRAL_CODE_KEY, generated);
        }
        if (referredByRaw) {
          setReferredByCode(referredByRaw);
        }
        if (referralWinsRaw) {
          const n = Number(referralWinsRaw);
          if (Number.isFinite(n) && n >= 0) setReferralWins(n);
        }
        setFeedSetupDone(feedSetupDoneRaw === "1");
      } catch {
        // ignore non-blocking local behavior cache errors
      } finally {
        feedSetupHydratedRef.current = true;
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
    pulse.start();
    bubbleFloat.start();
    return () => {
      pulse.stop();
      bubbleFloat.stop();
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
    welcomeScrollX,
    welcomeSlidesRef,
  ]);

  // (The animated Muslim-companion drop-in greeter was removed from the
  // welcome screen in v26 per product direction — we now surface the
  // companion only through the guided tour that plays after setup, and
  // through the floating chat launcher on the main shell.)

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
    launchGlowDrift.setValue(0);
    launchExitOpacity.setValue(1);
    launchDotPulse.setValue(0);
    // Two phases:
    // 1. Intro — bring in greeting, then card, then hold. Loading indicator
    //    keeps animating throughout.
    // 2. Exit — once data is hydrated AND the hold has finished, fade the
    //    whole wrapper (glows + card + greeting + dots) out on a single
    //    master opacity so nothing pops out abruptly.
    const intro = Animated.sequence([
      Animated.parallel([
        Animated.timing(launchOpacity, {
          toValue: 1,
          duration: 640,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.spring(launchScale, {
          toValue: 1,
          friction: 7,
          tension: 84,
          useNativeDriver: true,
        }),
        Animated.timing(launchTranslateY, {
          toValue: 0,
          duration: 700,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]),
      Animated.delay(650),
    ]);
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
    // Bouncing-dots indicator — loops until exit fade begins.
    const dotsLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(launchDotPulse, {
          toValue: 1,
          duration: 720,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(launchDotPulse, {
          toValue: 0,
          duration: 720,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ])
    );
    const pulseStart = setTimeout(() => {
      glowFloat.start();
      dotsLoop.start();
    }, 300);
    let disposed = false;
    let exitStarted = false;
    let waitingInterval: ReturnType<typeof setInterval> | null = null;
    // For first-time users, guarantee the launch celebration sits on screen
    // long enough to actually read "Welcome to Masjid.ly!" before we fade to
    // Home. Returning users get the short version (no min dwell) so the
    // app boots as fast as possible.
    const launchMountedAt = Date.now();
    const isFirstTimeEntry = justCompletedOnboardingRef.current;
    // 2.2s total (intro ~1.7s + ~0.5s extra hold) — long enough to register,
    // short enough that nobody will feel they're stuck on a splash.
    const MIN_FIRST_TIME_MS = 2200;
    const runExit = () => {
      if (exitStarted || disposed) return;
      // If we're a first-timer and we haven't yet reached the minimum dwell,
      // schedule the real exit for exactly when we will reach it. This
      // keeps the exit fade smooth and deterministic (no second pulse).
      if (isFirstTimeEntry) {
        const elapsed = Date.now() - launchMountedAt;
        if (elapsed < MIN_FIRST_TIME_MS) {
          setTimeout(runExit, MIN_FIRST_TIME_MS - elapsed);
          return;
        }
      }
      exitStarted = true;
      // Cross-fade hand-off: render the launch screen as an overlay on
      // top of the app shell and animate its opacity DOWN while the
      // app shell simultaneously fades UP. Swapping entry-screen state
      // immediately (instead of after the animation) lets Home paint
      // underneath the overlay so the transition is truly smooth — no
      // hard snap between two full-screen layouts.
      setLaunchOverlayVisible(true);
      appShellFadeIn.setValue(0);
      // Clear the first-time-entry flag here (was previously cleared
      // after the fade); the overlay keeps the celebration visible so
      // there's no visual regression.
      justCompletedOnboardingRef.current = false;
      setEntryScreen("app");
      Animated.parallel([
        Animated.timing(launchExitOpacity, {
          toValue: 0,
          duration: 560,
          easing: Easing.inOut(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(appShellFadeIn, {
          toValue: 1,
          duration: 560,
          // A touch of out-cubic so Home settles gently rather than
          // racing in.
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished) setLaunchOverlayVisible(false);
      });
    };
    intro.start(({ finished }) => {
      if (!finished || disposed) return;
      // If events already hydrated (cache or seed), exit immediately. Else
      // poll briefly — the bundled seed hydration is synchronous and almost
      // always available within a few hundred ms of intro completing.
      const isReady = () => events.length > 0 || !loading;
      if (isReady()) {
        runExit();
        return;
      }
      waitingInterval = setInterval(() => {
        if (disposed) return;
        if (isReady()) {
          if (waitingInterval) {
            clearInterval(waitingInterval);
            waitingInterval = null;
          }
          runExit();
        }
      }, 150);
      // Safety net: never keep the splash open longer than 2s after intro.
      setTimeout(() => {
        if (waitingInterval) {
          clearInterval(waitingInterval);
          waitingInterval = null;
        }
        runExit();
      }, 2000);
    });
    return () => {
      disposed = true;
      clearTimeout(pulseStart);
      if (waitingInterval) clearInterval(waitingInterval);
      glowFloat.stop();
      dotsLoop.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryScreen]);

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
        ]),
        { iterations: -1 },
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

  // Spin the refresh icon whenever an event re-fetch is in flight so
  // the refresh tap is always visually acknowledged. Also gives a
  // one-shot "breathing" pulse to the home hero logo so the circles
  // around it react to the manual refresh, matching the Assalaam
  // popup's event-count animation.
  useEffect(() => {
    if (loading) {
      refreshSpin.setValue(0);
      refreshSpinLoopRef.current?.stop();
      refreshSpinLoopRef.current = Animated.loop(
        Animated.timing(refreshSpin, {
          toValue: 1,
          duration: 900,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
      );
      refreshSpinLoopRef.current.start();
      Animated.sequence([
        Animated.timing(heroRefreshPulse, { toValue: 1, duration: 280, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(heroRefreshPulse, { toValue: 0, duration: 540, easing: Easing.inOut(Easing.cubic), useNativeDriver: true }),
      ]).start();
    } else {
      refreshSpinLoopRef.current?.stop();
      refreshSpinLoopRef.current = null;
      Animated.timing(refreshSpin, { toValue: 0, duration: 180, useNativeDriver: true }).start();
    }
    return () => {
      refreshSpinLoopRef.current?.stop();
      refreshSpinLoopRef.current = null;
    };
  }, [loading, refreshSpin, heroRefreshPulse]);

  // Keep `today` honest across midnight rollovers AND foreground/background
  // transitions. Without this, a phone left open overnight would still treat
  // yesterday as today until the user cold-launched the app.
  useEffect(() => {
    let cancelled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const scheduleMidnightTick = () => {
      if (cancelled) return;
      const now = new Date();
      const nextMidnight = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + 1,
        0,
        0,
        5, // small buffer so we're clearly on the next day
      );
      const ms = Math.max(1000, nextMidnight.getTime() - now.getTime());
      timeoutHandle = setTimeout(() => {
        if (cancelled) return;
        setTodayLocalIso(todayIso());
        scheduleMidnightTick();
      }, ms);
    };

    scheduleMidnightTick();
    setTodayLocalIso(todayIso());

    const appStateSub = AppState.addEventListener("change", (nextState) => {
      if (nextState === "active") {
        setTodayLocalIso(todayIso());
      }
    });

    return () => {
      cancelled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      appStateSub.remove();
    };
  }, []);

  const sourceArray = useMemo(() => Array.from(selectedSources), [selectedSources]);

  const loadProfile = async () => {
    try {
      // Demo mode: ignore the persisted welcome-done flag so the three-slide
      // intro shows on every launch. Still read it so SecureStore stays warm.
      void SecureStore.getItemAsync(WELCOME_FLOW_DONE_KEY).catch(() => null);
      const me = await apiJson("/api/auth/me");
      if (!me?.authenticated) {
        setCurrentUser(null);
        // Dev/demo mode: always start on the welcome flow so the three-slide
        // intro is shown on every launch. Flip this back to
        // `if (localWelcomeDone) setEntryScreen("app")` once we ship v1.
        setEntryScreen("welcome");
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
          followed_speakers: p.notifications?.followed_speakers !== false,
          tonight_after_maghrib: !!p.notifications?.tonight_after_maghrib,
          prayer_reminders: p.notifications?.prayer_reminders !== false,
          rsvp_reminders: !!p.notifications?.rsvp_reminders,
          quiet_hours_start: normalizeText(p.notifications?.quiet_hours_start || "22:30") || "22:30",
          quiet_hours_end: normalizeText(p.notifications?.quiet_hours_end || "06:30") || "06:30",
          daily_notification_cap: Math.max(1, Math.min(25, Number(p.notifications?.daily_notification_cap || 6))),
        },
      });
      if (favorites.length) setSelectedSources(new Set(favorites));
      if (favorites.length) setFollowedMasjids(favorites);
      if (p.audience_filter) setAudienceFilter(p.audience_filter);
      if (Number.isFinite(Number(p.radius))) setRadius(String(Math.max(5, Math.min(200, Number(p.radius)))));
      // Back-fill referral bookkeeping from the server when available.
      // The server treats its value as authoritative for the wins count
      // (since only it can see cross-device invites), but we cache it
      // locally so the UI doesn't flip to 0 while offline.
      if (typeof p.referred_by === "string" && p.referred_by && !referredByCode) {
        setReferredByCode(p.referred_by);
        SecureStore.setItemAsync(REFERRED_BY_KEY, p.referred_by).catch(() => {});
      }
      if (Number.isFinite(Number(p.referral_wins))) {
        const n = Math.max(0, Number(p.referral_wins));
        setReferralWins(n);
        SecureStore.setItemAsync(REFERRAL_WINS_KEY, String(n)).catch(() => {});
      }
      // Always show the three-slide welcome flow for now (demo mode).
      setEntryScreen("welcome");
    } catch {
      setCurrentUser(null);
    }
  };

  const saveOnboarding = async () => {
    if (finishSetupInFlightRef.current) return;
    try {
      setOnboardingError("");
      const cleanedName = normalizeText(personalization.name);
      const cleanedHeardFrom = normalizeText(personalization.heardFrom);
      const cleanedEmail = (personalization.email || "").trim().toLowerCase();
      if (!cleanedName) {
        setOnboardingError("Please enter your name.");
        return;
      }
      if (!cleanedHeardFrom) {
        setOnboardingError("Please share how you heard about Masjid.ly.");
        return;
      }
      if (!personalization.gender) {
        setOnboardingError("Please select your gender.");
        return;
      }
      // Email is optional, but if they typed something in the field we
      // require it to be a valid address (otherwise we'd silently drop
      // it on the floor and they'd think they were subscribed).
      if (cleanedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanedEmail)) {
        setOnboardingError("That email doesn't look right. Double-check or leave it blank.");
        return;
      }
      if (personalization.privacy_policy_accepted_version !== PRIVACY_POLICY_VERSION) {
        setOnboardingError("Please read and agree to the Privacy Policy to continue.");
        return;
      }
      const finalInterests = Array.from(
        new Set((setupInterestsDraft ?? personalization.interests).map((x) => normalizeText(x)).filter(Boolean))
      );
      finishSetupInFlightRef.current = true;
      const nextPersonalization: PersonalizationPrefs = {
        ...personalization,
        name: cleanedName,
        heardFrom: cleanedHeardFrom,
        email: cleanedEmail,
        interests: finalInterests,
        // If they didn't give us an email, opt-in can't be true regardless
        // of the toggle state — keeps the data model honest.
        emailOptIn: cleanedEmail ? personalization.emailOptIn : false,
        completed: true,
        privacy_policy_accepted_version: PRIVACY_POLICY_VERSION,
      };
      setPersonalization(nextPersonalization);
      // Transition immediately so the last "Next" feels instant.
      finishExitProgress.setValue(1);
      justCompletedOnboardingRef.current = true;
      setSetupInterestsDraft(null);
      setEntryScreen("launch");
      // Refresh feed while the launch celebration plays (profile/radius/sources may have changed).
      void loadEvents({ force: true });

      // Persist in background; do not block the visual transition.
      void Promise.all([
        SecureStore.setItemAsync(PERSONALIZATION_KEY, JSON.stringify(nextPersonalization)),
        SecureStore.setItemAsync(WELCOME_FLOW_DONE_KEY, "1"),
      ]).catch(() => {});

      let referredByForApi = referredByCode || normalizeMasjidlyShareCode(referralInput);
      if (referralCode && referredByForApi === referralCode) referredByForApi = "";
      if (referralInput.trim()) {
        const n = normalizeMasjidlyShareCode(referralInput);
        if (n && (!referralCode || n !== referralCode)) {
          void commitReferralCode(referralInput);
        }
      }
      void apiJson("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...profileDraft,
          onboarding_done: true,
          radius: Number(radius || profileDraft.radius || 35),
          favorite_sources: Array.from(selectedSources),
          audience_filter: audienceFilter,
          expo_push_token: pushToken || profileDraft.expo_push_token || "",
          referral_code: referralCode,
          referred_by: referredByForApi || "",
          contact_email: cleanedEmail,
          email_opt_in: cleanedEmail ? personalization.emailOptIn : false,
        }),
      }).catch(() => {});
    } catch (e) {
      finishSetupInFlightRef.current = false;
      setOnboardingError((e as Error).message || "Could not save onboarding.");
    }
  };

  const skipOnboarding = async () => {
    try {
      setOnboardingError("");
      if (personalization.privacy_policy_accepted_version !== PRIVACY_POLICY_VERSION) {
        setOnboardingError("Please accept the Privacy Policy before continuing.");
        return;
      }
      const nextPersonalization: PersonalizationPrefs = {
        ...personalization,
        completed: true,
        privacy_policy_accepted_version: PRIVACY_POLICY_VERSION,
      };
      setPersonalization(nextPersonalization);
      finishExitProgress.setValue(1);
      // Same as finishOnboarding: always show the launch celebration on
      // first entry so the jump to Home doesn't feel abrupt.
      justCompletedOnboardingRef.current = true;
      setEntryScreen("launch");
      void loadEvents({ force: true });
      // Persist in background; skip flow should feel immediate.
      void Promise.all([
        SecureStore.setItemAsync(PERSONALIZATION_KEY, JSON.stringify(nextPersonalization)),
        SecureStore.setItemAsync(WELCOME_FLOW_DONE_KEY, "1"),
      ]).catch(() => {});
    } catch {
      justCompletedOnboardingRef.current = true;
      setEntryScreen("launch");
      void loadEvents({ force: true });
    }
  };

  const confirmSkipAccountSetup = () => {
    Alert.alert(
      "Continue without an account?",
      "No problem — you can keep using Masjid.ly as a guest now. Account creation is optional (recommended for syncing your saves and follows), and you can do it later in Settings → Account.",
      [
        { text: "Keep setup", style: "cancel" },
        {
          text: "Skip for now",
          style: "destructive",
          onPress: () => {
            hapticTap("selection");
            if (personalization.privacy_policy_accepted_version !== PRIVACY_POLICY_VERSION) {
              setOnboardingError("Please accept the Privacy Policy once, then tap Skip for now.");
              if (entryScreen === "welcome" && setupSubStep < 2) {
                setupStepDirRef.current = 1;
                setSetupSubStep(2);
              }
              return;
            }
            void skipOnboarding();
          },
        },
      ],
    );
  };

  const toggleInterest = (interest: string) => {
    if (entryScreen === "welcome" && welcomeSlideIndex === 2 && setupSubStep === 1) {
      setSetupInterestsDraft((prev) => {
        const base = prev ?? personalization.interests;
        const has = base.includes(interest);
        return has ? base.filter((x) => x !== interest) : [...base, interest];
      });
      return;
    }
    setPersonalization((prev) => {
      const has = prev.interests.includes(interest);
      return {
        ...prev,
        interests: has ? prev.interests.filter((x) => x !== interest) : [...prev.interests, interest],
      };
    });
  };

  const renderPrivacyPolicyConsent = (opts: { welcomeHero?: boolean }) => {
    const accepted = personalization.privacy_policy_accepted_version === PRIVACY_POLICY_VERSION;
    const legalColor = opts.welcomeHero
      ? isNeo
        ? "#2a2a2a"
        : isEmerald
          ? "#1f3d29"
          : isDarkTheme
            ? "#e8ecff"
            : "#fff2e8"
      : isDarkTheme
        ? "#c4cee8"
        : "#3d4a63";
    const linkColor = opts.welcomeHero
      ? isNeo
        ? "#5c4dcc"
        : isEmerald
          ? "#0d5c2e"
          : "#fff2e8"
      : isDarkTheme
        ? "#9db0db"
        : "#b84818";
    return (
      <View style={styles.captureFieldGroup}>
        <Text
          style={[
            styles.captureLabel,
            opts.welcomeHero && isNeo && styles.welcomeInfoStepTextNeo,
            opts.welcomeHero && isEmerald && styles.welcomeInfoStepTextEmerald,
            !opts.welcomeHero && isDarkTheme && { color: "#f4f7ff" },
          ]}
        >
          Privacy
        </Text>
        <View style={styles.capturePrivacyRow}>
          <Pressable {...PRESSABLE_INSTANT} 
            hitSlop={6}
            onPress={() => {
              hapticTap("selection");
              setPersonalization((prev) => ({
                ...prev,
                privacy_policy_accepted_version:
                  prev.privacy_policy_accepted_version === PRIVACY_POLICY_VERSION ? "" : PRIVACY_POLICY_VERSION,
              }));
            }}
            style={styles.capturePrivacyCheckWrap}
          >
            <View style={[styles.capturePrivacyCheck, accepted && styles.capturePrivacyCheckOn]}>
              {accepted ? <Text style={styles.capturePrivacyCheckMark}>✓</Text> : null}
            </View>
          </Pressable>
          <View style={{ flex: 1 }}>
            <Text style={[styles.capturePrivacyLegalText, { color: legalColor }]}>
              I have read and agree to the{" "}
              <Text
                style={[styles.capturePrivacyLink, { color: linkColor }]}
                onPress={() => {
                  hapticTap("selection");
                  void Linking.openURL(MASJIDLY_URLS.privacy);
                }}
              >
                Privacy Policy
              </Text>
              . You can also open it anytime in Settings. We use your answers here to personalize events; the policy
              explains location, notifications, and optional email.
            </Text>
          </View>
        </View>
      </View>
    );
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
  const [locationBannerDismissed, setLocationBannerDismissed] = useState(false);
  const [locationRequesting, setLocationRequesting] = useState(false);

  const requestLocationAndSave = useCallback(async () => {
    try {
      setLocationRequesting(true);
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        Alert.alert(
          "Location off",
          "Location permission wasn't granted. You can turn it on in Settings and try again.",
          [{ text: "OK" }]
        );
        setLocationBannerDismissed(true);
        return;
      }
      const pos = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });
      const nextDraft = {
        ...profileDraft,
        home_lat: pos.coords.latitude,
        home_lon: pos.coords.longitude,
      };
      setProfileDraft(nextDraft);
      // Persist to server if signed in; ignore failures silently.
      try {
        await apiJson("/api/profile", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...nextDraft,
            onboarding_done: nextDraft.onboarding_done,
            radius: Number(radius || nextDraft.radius || 35),
            favorite_sources: Array.from(selectedSources),
            audience_filter: audienceFilter,
          }),
        });
      } catch {
        // local state is enough to enable near-me sort
      }
      // Re-center the map on the user's location via the imperative ref so we
      // don't re-render the entire Explore tree.
      const nextRegion: Region = {
        ...mapRegionRef.current,
        latitude: pos.coords.latitude,
        longitude: pos.coords.longitude,
      };
      mapRegionRef.current = nextRegion;
      mapRef.current?.animateToRegion(nextRegion, 400);
    } catch (e) {
      Alert.alert("Couldn't get location", (e as Error).message || "Try again in a moment.");
    } finally {
      setLocationRequesting(false);
    }
  }, [profileDraft, radius, selectedSources, audienceFilter]);

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
      // Prefer the live API as source of truth. Only fill from the bundled
      // seed for (source, title) combos the API omitted — NEVER carry over
      // the prior on-screen/AsyncStorage copy, since that lets backend date
      // corrections (e.g. weekday_overrides shifting Mon→Tue) stay stale on
      // screen alongside the fixed date and causes duplicate/zombie rows.
      const byKey = new Map<string, EventItem>();
      for (const item of fetched) {
        upsertDedupeEvent(byKey, item);
      }
      const apiSourceTitlePairs = new Set<string>();
      for (const item of fetched) {
        const src = ((item as any)?.source || "").toString().toLowerCase();
        const title = ((item as any)?.title || "").toString().toLowerCase();
        if (src && title) apiSourceTitlePairs.add(`${src}|${title}`);
      }
      for (const item of BUNDLED_SEED_EVENTS as EventItem[]) {
        const k = eventDedupeKey(item);
        const src = ((item as any)?.source || "").toString().toLowerCase();
        const title = ((item as any)?.title || "").toString().toLowerCase();
        if (src && title && apiSourceTitlePairs.has(`${src}|${title}`)) {
          // API has other dates for this series — trust the API, skip seed.
          continue;
        }
        if (!byKey.has(k)) {
          upsertDedupeEvent(byKey, item);
        }
      }
      const unioned = Array.from(byKey.values()).map((ev) => ({
        ...(ev as EventItem),
        image_urls: coercePosterUrls((ev as EventItem).image_urls),
      }));
      setEvents(unioned);
      setLastSyncedAt(Date.now());
      // Persist the union so next cold start already has the full set.
      const toCache: EventsCachePayload = {
        events: unioned,
        data_version: remoteDataVersionRef.current || "unknown",
        cached_at: Date.now(),
      };
      AsyncStorage.setItem(EVENTS_CACHE_KEY, JSON.stringify(toCache)).catch(() => {});
    } catch (e) {
      const msg = (e as Error).message || "Failed to load events";
      setError(msg);
      // Don't nuke events if we already have a valid cached snapshot onscreen
      // — seed + cache are still useful offline. If we have literally nothing,
      // fall back to the bundled seed as a last resort.
      if (!events.length) {
        const fallback: EventItem[] = [];
        const byKey = new Map<string, EventItem>();
        for (const item of BUNDLED_SEED_EVENTS as EventItem[]) {
          upsertDedupeEvent(byKey, item);
        }
        for (const item of byKey.values()) fallback.push(item);
        if (fallback.length) setEvents(fallback);
      }
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
        let appliedMeta = false;
        if (metaRaw) {
          try {
            const parsedMeta = JSON.parse(metaRaw) as MetaResponse;
            if (parsedMeta && Array.isArray(parsedMeta.sources)) {
              setMeta((prev) => prev || parsedMeta);
              appliedMeta = true;
            }
          } catch {
            // ignore malformed cache
          }
        }
        // Offline-first floor: always start from the bundled seed. Cache (if
        // present and fresher per-event) overlays on top, so the app never
        // shows a narrow/stale snapshot first and then "catches up" to the
        // full set. The live fetch later will overlay freshest data.
        if (!appliedMeta && BUNDLED_SEED_META && Array.isArray(BUNDLED_SEED_META.sources)) {
          setMeta((prev) => prev || BUNDLED_SEED_META);
        }
        if (!events.length) {
          const byKey = new Map<string, EventItem>();
          for (const item of BUNDLED_SEED_EVENTS as EventItem[]) {
            upsertDedupeEvent(byKey, item);
          }
          let cachedAt = 0;
          if (eventsRaw) {
            try {
              const parsed = JSON.parse(eventsRaw) as EventsCachePayload;
              if (parsed?.events?.length) {
                for (const item of parsed.events) {
                  upsertDedupeEvent(byKey, item); // overlay seed
                }
                cachedAt = parsed.cached_at || 0;
              }
            } catch {
              // ignore malformed cache
            }
          }
          if (byKey.size) {
            setEvents(Array.from(byKey.values()));
            if (cachedAt) setLastSyncedAt(cachedAt);
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

  // Warm image cache for the first chunk of visible poster URLs so cards don't
  // appear empty while the user scrolls Home/Explore.
  useEffect(() => {
    if (entryScreen !== "app") return;
    setCacheWarmStatus("warming");
    let cancelled = false;
    const warmFallbackTimer = setTimeout(() => {
      if (!cancelled) setCacheWarmStatus("ready");
    }, 8000);
    const run = async () => {
      const nowIso = todayIso();
      const isSoon = (ev: EventItem): boolean => {
        const d = normalizeText(ev.date || "");
        return !!d && d >= nowIso && d <= plusDaysIso(2);
      };
      const followedSet = new Set(followedMasjids.map((s) => normalizeText(s).toLowerCase()));
      const topPosterUrls = events
        .filter((ev) => isSoon(ev) || followedSet.has(normalizeText(ev.source).toLowerCase()))
        .map((ev) => eventPosterUrl(ev))
        .filter((u): u is string => !!u && canRenderPoster(u))
        .slice(0, 70);
      const otherPosterUrls = events
        .map((ev) => eventPosterUrl(ev))
        .filter((u): u is string => !!u && canRenderPoster(u) && !topPosterUrls.includes(u))
        .slice(0, 180);
      const speakerUrls = speakers
        .map((s) => normalizeText(s.image_url || ""))
        .filter((u): u is string => !!u)
        .slice(0, 80);
      const logoUrls = (meta?.sources || [])
        .map((src) => masjidLogoUrl(src) || "")
        .filter((u): u is string => !!u)
        .slice(0, 80);
      const phase1 = Array.from(new Set([...topPosterUrls, ...speakerUrls.slice(0, 20), ...logoUrls.slice(0, 20)]));
      const phase2 = Array.from(new Set([...otherPosterUrls, ...speakerUrls.slice(20), ...logoUrls.slice(20)]));
      for (const url of phase1) {
        if (cancelled) return;
        await Image.prefetch(url).catch(() => false);
      }
      if (!cancelled) setCacheWarmStatus("ready");
      for (const url of phase2) {
        if (cancelled) return;
        void Image.prefetch(url).catch(() => false);
      }
    };
    void run();
    return () => {
      cancelled = true;
      clearTimeout(warmFallbackTimer);
    };
  }, [entryScreen, events, speakers, meta?.sources, canRenderPoster, followedMasjids]);

  // First-time guided tour: after the user enters the main app shell, check
  // whether they've seen the walkthrough. If not, kick it off shortly after
  // so they have time to register the UI first.
  useEffect(() => {
    if (entryScreen !== "app") return;
    let cancelled = false;
    (async () => {
      try {
        const done = await SecureStore.getItemAsync(GUIDED_TOUR_DONE_KEY);
        if (done === "1") return;
      } catch {
        // if SecureStore read fails, still show the tour — it's a freebie
      }
      if (cancelled) return;
      // Brief delay so the app has settled into Home before the overlay appears
      if (guidedTourAutoOpenTimeoutRef.current) {
        clearTimeout(guidedTourAutoOpenTimeoutRef.current);
        guidedTourAutoOpenTimeoutRef.current = null;
      }
      guidedTourAutoOpenTimeoutRef.current = setTimeout(() => {
        void (async () => {
          if (cancelled) return;
          try {
            const doneNow = await SecureStore.getItemAsync(GUIDED_TOUR_DONE_KEY);
            if (doneNow === "1") return;
          } catch {
            // non-fatal
          }
          if (!cancelled) {
            setGuidedTourStep(0);
            setGuidedTourOpen(true);
          }
        })();
      }, 900);
    })();
    return () => {
      cancelled = true;
      if (guidedTourAutoOpenTimeoutRef.current) {
        clearTimeout(guidedTourAutoOpenTimeoutRef.current);
        guidedTourAutoOpenTimeoutRef.current = null;
      }
    };
  }, [entryScreen]);

  // When the tour opens or the step advances, drive the app to the tab the
  // narration is pointing at so the user actually sees what's being
  // described in the UI behind the overlay. For "task" steps we purposely
  // DO NOT switch tabs — the user has to do it themselves, that's the
  // whole point of the interactive tour.
  useEffect(() => {
    if (!guidedTourOpen) return;
    const step = GUIDED_TOUR_STEPS[guidedTourStep];
    if (!step) return;
    if (step.target.kind === "tab") {
      if (tab !== step.target.tab) {
        try { setTab(step.target.tab); } catch { /* non-fatal */ }
        setMountedTabs((prev) => (prev.has(step.target.kind === "tab" ? step.target.tab : "home") ? prev : new Set(prev).add((step.target as { tab: TabKey }).tab)));
      }
    } else if (step.target.kind === "chatbot") {
      if (tab !== "home") {
        try { setTab("home"); } catch { /* non-fatal */ }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guidedTourOpen, guidedTourStep]);

  // Interactive tour: when a task step becomes active, snapshot the
  // relevant counts so we can detect the user's action even during a
  // replay when some follows already exist. A separate effect below
  // watches for the delta.
  const tourTaskBaselineRef = useRef<{
    followedMasjids: number;
    followedScholars: number;
    savedEvents: number;
    masjidSheetOpen: boolean;
  }>({ followedMasjids: 0, followedScholars: 0, savedEvents: 0, masjidSheetOpen: false });

  useEffect(() => {
    if (!guidedTourOpen) return;
    const step = GUIDED_TOUR_STEPS[guidedTourStep];
    if (!step || step.target.kind !== "task") return;
    tourTaskBaselineRef.current = {
      followedMasjids: followedMasjids.length,
      followedScholars: followedScholars.length,
      savedEvents: Object.keys(savedEventsMap).length,
      masjidSheetOpen: !!selectedMasjidSheet,
    };
    // Only re-capture when the step index changes — we don't want every
    // subsequent state change to reset the baseline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guidedTourOpen, guidedTourStep]);

  // Auto-advance when the user completes the task for the current step.
  // We deliberately watch only the state slices each task cares about so
  // unrelated updates don't churn through this effect.
  useEffect(() => {
    if (!guidedTourOpen) return;
    if (tourTransitioningRef.current) return;
    const step = GUIDED_TOUR_STEPS[guidedTourStep];
    if (!step || step.target.kind !== "task") return;
    const base = tourTaskBaselineRef.current;
    let done = false;
    switch (step.target.taskId) {
      case "goto-explore":
        done = tab === "explore";
        break;
      case "tap-masjid-pin":
        done = !!selectedMasjidSheet && !base.masjidSheetOpen;
        // If a sheet was already open when the step began, accept any
        // re-tap that changes which masjid is selected.
        if (!done && !!selectedMasjidSheet && base.masjidSheetOpen) {
          done = true;
        }
        break;
      case "follow-masjid":
        done = followedMasjids.length > base.followedMasjids;
        break;
      case "goto-discover":
        done = tab === "discover";
        break;
      case "follow-scholar":
        done = followedScholars.length > base.followedScholars;
        break;
      case "goto-calendar":
        done = tab === "calendar";
        break;
      case "open-chatbot":
        done = chatOpen;
        break;
      default:
        done = false;
    }
    if (done) {
      // Small delay so the user sees their action register (a button
      // turning green, a sheet opening) before the tour card swaps.
      const t = setTimeout(() => {
        try { hapticTap?.("success"); } catch { /* non-fatal */ }
        advanceTour(1);
      }, 520);
      return () => clearTimeout(t);
    }
  }, [
    guidedTourOpen,
    guidedTourStep,
    tab,
    selectedMasjidSheet,
    followedMasjids.length,
    followedScholars.length,
    savedEventsMap,
    chatOpen,
    // `advanceTour` and haptic helpers are stable refs/callbacks
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ]);

  // Looping pulse for the tour highlight ring. Runs only while the tour is
  // open so we don't burn cycles when idle.
  useEffect(() => {
    if (!guidedTourOpen) {
      tourPulse.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(tourPulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(tourPulse, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [guidedTourOpen, tourPulse]);

  // When the tour opens, make sure the cross-fade starts from a clean
  // "visible" baseline. Without this, a replay-from-Settings would inherit
  // whatever opacity the last step-advance left us in.
  useEffect(() => {
    if (guidedTourOpen) {
      tourContentOpacity.setValue(1);
      tourContentTranslate.setValue(0);
      tourTransitioningRef.current = false;
    }
  }, [guidedTourOpen, tourContentOpacity, tourContentTranslate]);

  // Smooth cross-fade between tour steps. We fade+slide the current card
  // and ring out, advance the step state, let the tab-switch effect settle,
  // then fade+slide the new card and ring back in. If `advanceTour(1)` is
  // called past the final step we close the tour cleanly.
  const advanceTour = useCallback(
    (delta: number) => {
      if (tourTransitioningRef.current) return;
      const nextIndex = guidedTourStep + delta;
      // Closing the tour: brief fade of the whole overlay, then hide.
      if (nextIndex >= GUIDED_TOUR_STEPS.length) {
        tourTransitioningRef.current = true;
        Animated.timing(tourContentOpacity, {
          toValue: 0,
          duration: 220,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }).start(() => {
          if (guidedTourAutoOpenTimeoutRef.current) {
            clearTimeout(guidedTourAutoOpenTimeoutRef.current);
            guidedTourAutoOpenTimeoutRef.current = null;
          }
          setGuidedTourOpen(false);
          SecureStore.setItemAsync(GUIDED_TOUR_DONE_KEY, "1").catch(() => {});
          // Reset for next replay
          tourContentOpacity.setValue(1);
          tourContentTranslate.setValue(0);
          tourTransitioningRef.current = false;
        });
        return;
      }
      if (nextIndex < 0) return; // safety — we never move backwards right now
      tourTransitioningRef.current = true;
      Animated.parallel([
        Animated.timing(tourContentOpacity, {
          toValue: 0,
          duration: 170,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(tourContentTranslate, {
          toValue: -10,
          duration: 170,
          easing: Easing.in(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start(() => {
        setGuidedTourStep(nextIndex);
        // Slide in from below so the new card feels like it's arriving,
        // not popping in. We delay a frame so the tab-switch effect has
        // time to schedule the `setTab(...)` before we paint the new
        // card over the new tab.
        tourContentTranslate.setValue(10);
        requestAnimationFrame(() => {
          Animated.parallel([
            Animated.timing(tourContentOpacity, {
              toValue: 1,
              duration: 260,
              easing: Easing.out(Easing.cubic),
              useNativeDriver: true,
            }),
            Animated.timing(tourContentTranslate, {
              toValue: 0,
              duration: 260,
              easing: Easing.out(Easing.cubic),
              useNativeDriver: true,
            }),
          ]).start(() => {
            tourTransitioningRef.current = false;
          });
        });
      });
    },
    [guidedTourStep, tourContentOpacity, tourContentTranslate],
  );

  // Persistent idle bob + halo pulse for the floating sprite (infinite loops
  // for the whole time the main shell is visible).
  useEffect(() => {
    if (entryScreen !== "app") return;
    const bobLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(floatingSpriteBob, { toValue: 1, duration: 1400, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(floatingSpriteBob, { toValue: 0, duration: 1400, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
      { iterations: -1 },
    );
    const haloLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(floatingSpriteHaloPulse, {
          toValue: 1,
          duration: 2200,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
        Animated.timing(floatingSpriteHaloPulse, {
          toValue: 0,
          duration: 2200,
          easing: Easing.inOut(Easing.sin),
          useNativeDriver: true,
        }),
      ]),
      { iterations: -1 },
    );
    bobLoop.start();
    haloLoop.start();
    return () => {
      bobLoop.stop();
      haloLoop.stop();
    };
  }, [entryScreen, floatingSpriteBob, floatingSpriteHaloPulse]);

  // Slow, continuous drift for the two decorative circles in the home
  // logo box. We intentionally keep them in sync so the two orbs feel
  // connected top-to-bottom as one seamless brand motion.
  useEffect(() => {
    if (entryScreen !== "app") return;
    const loopA = Animated.loop(
      Animated.sequence([
        Animated.timing(logoGlowA, { toValue: 1, duration: 5200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(logoGlowA, { toValue: 0, duration: 5200, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ]),
      { iterations: -1 },
    );
    loopA.start();
    return () => {
      loopA.stop();
    };
  }, [entryScreen, logoGlowA]);

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

  // Two-phase event-detail mount: defer the heavy body one tick so the Modal
  // fade animation starts instantly on tap. Also reset the flag on close so
  // the next open goes through the same fast path.
  useEffect(() => {
    if (!selectedEvent) {
      setDetailReady(false);
      return;
    }
    const handle = InteractionManager.runAfterInteractions(() => {
      setDetailReady(true);
    });
    return () => {
      handle.cancel?.();
    };
  }, [selectedEvent]);

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
        if (detail?.event) {
          const ev = detail.event as EventItem;
          setSelectedEvent({ ...ev, image_urls: coercePosterUrls(ev.image_urls) });
        }
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
    if (eventPosterUrl(e)) confidence += 8;
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
  const getTrustSignalBreakdown = (e: EventItem): Array<{ key: string; label: string; ok: boolean }> => {
    const title = eventDisplayTitle(e);
    const poster = eventPosterUrl(e);
    const sourceType = sourceTypeLabelForEvent(e).toLowerCase();
    return [
      { key: "title", label: "Title quality", ok: !!title && !isWeakEventTitle(title) },
      { key: "time", label: "Time present", ok: !!normalizeText(e.start_time || "") },
      { key: "poster", label: "Poster detected", ok: !!poster && !isWeakPosterUrl(poster) },
      { key: "source", label: "Source mapped", ok: sourceType !== "unknown source" },
    ];
  };
  const detectSourceConflict = (e: EventItem): string => {
    const st = normalizeText(e.source_type || "").toLowerCase();
    const srcUrl = normalizeText(e.source_url || "").toLowerCase();
    const hasInstagramUrl = srcUrl.includes("instagram.com");
    if ((st === "instagram" || st === "instagram_recurring") && srcUrl && !hasInstagramUrl) {
      return "Source conflict: marked Instagram but URL looks non-Instagram";
    }
    if (st === "website" && hasInstagramUrl) {
      return "Source conflict: marked Website but URL is Instagram";
    }
    if (st === "email" && hasInstagramUrl) {
      return "Source conflict: marked Email but URL is Instagram";
    }
    return "";
  };
  const suggestedQuickFixKind = (e: EventItem): "title" | "speaker" | "poster" | "duplicate" | null => {
    if (isWeakEventTitle(eventDisplayTitle(e))) return "title";
    if (!effectiveEventSpeakerName(e) && /\b(with|by)\s+(imam|shaykh|sheikh|ustadh|dr\.?)\b/i.test(`${e.description || ""} ${e.raw_text || ""}`)) {
      return "speaker";
    }
    if (!eventPosterUrl(e)) return "poster";
    const conflict = detectSourceConflict(e);
    if (conflict) return "duplicate";
    return null;
  };
  const getTrustPassChips = (e: EventItem, opts?: { debug?: boolean }): string[] => {
    const conf = getEventConfidence(e);
    const chips: string[] = [];
    chips.push(`${conf.label} (${conf.score}%)`);
    chips.push(sourceTypeLabelForEvent(e));
    const age = freshnessAgeLabel(e);
    if (age) chips.push(age);
    if (isLikelyStaleEvent(e)) chips.push("Likely stale");
    if (opts?.debug) chips.push(duplicateSuppressionReason(e));
    return chips.slice(0, opts?.debug ? 5 : 4);
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

  const getEventTemporalState = (e: EventItem): { isLive: boolean; isPast: boolean; startsInMinutes: number | null } => {
    // Depend on the ticker so labels refresh automatically every ~15s.
    void clockNowMs;
    const isLive = isEventLiveNow(e);
    const isPast = isEventPastNow(e);
    let startsInMinutes: number | null = null;
    if (!isLive && !isPast) {
      const start = eventStartDate(e);
      if (start) {
        const diffMs = start.getTime() - clockNowMs;
        const diffMin = Math.ceil(diffMs / 60000);
        if (diffMin >= 0 && diffMin <= 60) startsInMinutes = diffMin;
      }
    }
    return { isLive, isPast, startsInMinutes };
  };

  const visibleEvents = useMemo(() => {
    const filtered = events.filter((e) => {
      if (isProgramNotEvent(e)) return false;
      if (isJumuahEvent(e)) return false;
      if (isPastEventBeyondGrace(e)) return false;
      if (audienceFilter !== "all" && inferAudience(e) !== audienceFilter) return false;
      if (quickFilters.length && !quickFilters.every((f) => matchesQuickFilter(e, f))) return false;
      return true;
    });
    return dropInferiorPosterlessClones(collapseNearDuplicateEvents(filtered));
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

  // Masjid map sheet should always show everything upcoming for that masjid,
  // independent of active Explore filters/chips/search. Users tap a masjid on
  // the map expecting the full board, not just the currently-filtered subset.
  const upcomingEventsBySource = useMemo(() => {
    const out: Record<string, EventItem[]> = {};
    for (const ev of events) {
      const src = normalizeText(ev.source).toLowerCase();
      const d = normalizeText(ev.date);
      if (!src || !d) continue;
      if (d < today) continue;
      if (isEventPastNow(ev)) continue;
      if (!out[src]) out[src] = [];
      out[src].push(ev);
    }
    for (const src of Object.keys(out)) {
      out[src].sort((a, b) =>
        `${a.date || "9999-12-31"} ${a.start_time || "99:99"}`.localeCompare(
          `${b.date || "9999-12-31"} ${b.start_time || "99:99"}`
        )
      );
    }
    return out;
  }, [events, today]);

  const grouped = useMemo(() => {
    const map = new Map<string, EventItem[]>();
    for (const e of orderedVisibleEvents) {
      if (!map.has(e.date)) map.set(e.date, []);
      map.get(e.date)!.push(e);
    }
    return map;
  }, [orderedVisibleEvents]);

  // The Explore/Map tab's section list must ALWAYS be chronological, starting
  // with today (or the soonest upcoming day if today has nothing). The
  // user's chosen `sortMode` on the rest of the app ("relevant", "nearest",
  // "recent") affects ordering WITHIN each day here — not which day comes
  // first. Previously we relied on Map insertion order, which meant a
  // "relevant" sort could push a future day to the top of the list while
  // today's events were buried several sections down.
  const exploreSections = useMemo(() => {
    const todayKey = today;
    return Array.from(grouped.entries())
      .map(([day, rows]) => {
        const filtered = halaqaFilter
          ? rows.filter((r) => (r.topics || []).includes(halaqaFilter))
          : rows;
        // Within a single day always show earlier start times first — for
        // the Explore list, a chronological intra-day order reads more
        // naturally than a relevance-ranked one.
        const dayRows = [...filtered].sort((a, b) =>
          (a.start_time || "99:99").localeCompare(b.start_time || "99:99"),
        );
        return { title: day, data: dayRows };
      })
      .filter((s) => s.data.length > 0)
      // Drop past-date sections entirely so the list always opens on
      // today / soonest. Today's own past-time events still show inside
      // today's section (handled by the card UI), which is the desired
      // behavior for "what's on tonight?".
      .filter((s) => (s.title || "") >= todayKey)
      .sort((a, b) => (a.title || "").localeCompare(b.title || ""));
  }, [grouped, halaqaFilter, today]);

  // Only surface topic chips that actually have upcoming visible events — an
  // empty chip just leads to an empty feed and confuses the user.
  const availableTopicChips = useMemo(() => {
    const present = new Set<string>();
    for (const e of visibleEvents) {
      if ((e.date || "") < today) continue;
      if (isEventPastNow(e)) continue;
      for (const t of e.topics || []) {
        if ((HALAQA_FILTER_TOPICS as readonly string[]).includes(t)) present.add(t);
      }
    }
    return (HALAQA_FILTER_TOPICS as readonly string[]).filter((t) => present.has(t));
  }, [visibleEvents, today]);

  useEffect(() => {
    if (halaqaFilter && !availableTopicChips.includes(halaqaFilter)) {
      setHalaqaFilter(null);
    }
  }, [availableTopicChips, halaqaFilter]);

  const savedEvents = useMemo(
    () =>
      Object.values(savedEventsMap).sort((a, b) =>
        `${a.date || "9999-12-31"} ${a.start_time || "99:99"}`.localeCompare(
          `${b.date || "9999-12-31"} ${b.start_time || "99:99"}`
        )
      ),
    [savedEventsMap]
  );

  const feedUpcomingEvents = useMemo(
    () => orderedVisibleEvents.filter((e) => (e.date || "") >= today && !isEventPastNow(e)),
    [orderedVisibleEvents, today]
  );

  const followedMasjidSet = useMemo(
    () => new Set(followedMasjids.map((s) => normalizeText(s).toLowerCase()).filter(Boolean)),
    [followedMasjids]
  );

  const followedScholarSlugSet = useMemo(() => {
    const slugify = (value: string) =>
      normalizeText(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return new Set(followedScholars.map(slugify).filter(Boolean));
  }, [followedScholars]);

  const normalizedInterestTerms = useMemo(
    () => Array.from(new Set(personalization.interests.map((x) => normalizeText(x).toLowerCase()).filter(Boolean))),
    [personalization.interests]
  );

  const feedTopicOptions = useMemo(() => {
    const options = [...normalizedInterestTerms];
    for (const topic of availableTopicChips) {
      const low = normalizeText(topic).toLowerCase();
      if (low && !options.includes(low)) options.push(low);
    }
    return options.slice(0, 7);
  }, [normalizedInterestTerms, availableTopicChips]);

  useEffect(() => {
    if (feedTopicFilter && !feedTopicOptions.includes(feedTopicFilter)) {
      setFeedTopicFilter(null);
    }
  }, [feedTopicFilter, feedTopicOptions]);

  const feedRankedEvents = useMemo(() => {
    const slugify = (value: string) =>
      normalizeText(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    const muted = new Set(mutedFeedSources.map((s) => normalizeText(s).toLowerCase()));
    return feedUpcomingEvents
      .filter((event) => !muted.has(normalizeText(event.source).toLowerCase()))
      .map((event) => {
        const scoreBase = scoreEventForPersonalization(event);
        const reasons: string[] = [];
        let score = scoreBase;
        const sourceKey = normalizeText(event.source).toLowerCase();
        const speakerSlug = slugify(effectiveEventSpeakerName(event));
        const fromFollowedMasjid = followedMasjidSet.has(sourceKey);
        const fromFollowedScholar = !!speakerSlug && followedScholarSlugSet.has(speakerSlug);
        const eventKey = eventStorageKey(event);
        const blob = `${event.title || ""} ${event.description || ""} ${event.category || ""} ${(event.topics || []).join(" ")}`.toLowerCase();
        const topicHits = normalizedInterestTerms.filter((term) => blob.includes(term)).length;
        if (fromFollowedMasjid) {
          score += 22;
          reasons.push("From a masjid you follow");
        }
        if (fromFollowedScholar) {
          score += 20;
          reasons.push("From a scholar you follow");
        }
        if (topicHits > 0) {
          score += 12 + topicHits * 4;
          reasons.push(topicHits > 1 ? "Matches multiple interests" : "Matches your interests");
        }
        const rsvp = rsvpStatuses[eventKey];
        if (rsvp === "going") {
          score += 10;
          reasons.push("You're going");
        } else if (rsvp === "interested") {
          score += 7;
          reasons.push("You're interested");
        }
        if (savedEventsMap[eventKey]) {
          score += 8;
          reasons.push("Saved by you");
        }
        if (typeof event.freshness?.days_old === "number") {
          score += Math.max(0, 6 - Math.min(6, event.freshness.days_old));
        }
        return {
          event,
          score,
          reasons,
          fromFollowedMasjid,
          fromFollowedScholar,
        };
      })
      .sort(
        (a, b) =>
          Number(b.fromFollowedMasjid || b.fromFollowedScholar) - Number(a.fromFollowedMasjid || a.fromFollowedScholar) ||
          Number(b.fromFollowedMasjid) - Number(a.fromFollowedMasjid) ||
          Number(b.fromFollowedScholar) - Number(a.fromFollowedScholar) ||
          b.score - a.score ||
          `${a.event.date || "9999-12-31"} ${a.event.start_time || "99:99"}`.localeCompare(
            `${b.event.date || "9999-12-31"} ${b.event.start_time || "99:99"}`
          )
      );
  }, [
    feedUpcomingEvents,
    mutedFeedSources,
    followedMasjidSet,
    followedScholarSlugSet,
    normalizedInterestTerms,
    rsvpStatuses,
    savedEventsMap,
    scoreEventForPersonalization,
  ]);
  const feedReasonByKey = useMemo(() => {
    const out: Record<string, string> = {};
    for (const row of feedRankedEvents) {
      const key = eventStorageKey(row.event);
      if (!key) continue;
      out[key] = row.reasons[0] || "Personalized for you";
    }
    return out;
  }, [feedRankedEvents]);

  const forYouFeedEvents = useMemo(() => feedRankedEvents.slice(0, 6).map((x) => x.event), [feedRankedEvents]);
  const followedMasjidFeedEvents = useMemo(
    () => feedUpcomingEvents.filter((e) => followedMasjidSet.has(normalizeText(e.source).toLowerCase())).slice(0, 8),
    [feedUpcomingEvents, followedMasjidSet]
  );
  const followedScholarFeedEvents = useMemo(() => {
    const slugify = (value: string) =>
      normalizeText(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return feedUpcomingEvents
      .filter((e) => {
        const speakerSlug = slugify(effectiveEventSpeakerName(e));
        return !!speakerSlug && followedScholarSlugSet.has(speakerSlug);
      })
      .slice(0, 8);
  }, [feedUpcomingEvents, followedScholarSlugSet]);
  const interestFeedEvents = useMemo(() => {
    const terms = feedTopicFilter ? [feedTopicFilter] : normalizedInterestTerms;
    if (!terms.length) return [] as EventItem[];
    return feedRankedEvents
      .map((x) => x.event)
      .filter((e) => {
        const blob = `${e.title || ""} ${e.description || ""} ${e.category || ""} ${(e.topics || []).join(" ")}`.toLowerCase();
        return terms.some((term) => blob.includes(term));
      })
      .slice(0, 8);
  }, [feedRankedEvents, normalizedInterestTerms, feedTopicFilter]);
  const savedAndRsvpFeedEvents = useMemo(() => {
    const dedup = new Set<string>();
    const merged: EventItem[] = [];
    const pushUnique = (event: EventItem) => {
      const key = eventStorageKey(event);
      if (!key || dedup.has(key)) return;
      dedup.add(key);
      merged.push(event);
    };
    for (const e of savedEvents) {
      pushUnique(e);
    }
    for (const e of feedUpcomingEvents) {
      const rsvp = rsvpStatuses[eventStorageKey(e)];
      if (rsvp === "going" || rsvp === "interested") pushUnique(e);
    }
    return merged
      .sort((a, b) =>
        Number((a.date || "") >= today && !isEventPastNow(a)) !== Number((b.date || "") >= today && !isEventPastNow(b))
          ? Number((b.date || "") >= today && !isEventPastNow(b)) - Number((a.date || "") >= today && !isEventPastNow(a))
          : `${a.date || "9999-12-31"} ${a.start_time || "99:99"}`.localeCompare(
              `${b.date || "9999-12-31"} ${b.start_time || "99:99"}`
            )
      )
      .slice(0, 14);
  }, [savedEvents, feedUpcomingEvents, rsvpStatuses, today]);

  // Full, uncapped version used by the dedicated "Saved" tab inside Your
  // Feed. Keeps saved ♥ items and RSVP'd events in one merged list, split
  // later into "Upcoming" and "Past" by the renderer.
  const feedSavedTabEvents = useMemo(() => {
    const dedup = new Set<string>();
    const merged: EventItem[] = [];
    const pushUnique = (event: EventItem) => {
      const key = eventStorageKey(event);
      if (!key || dedup.has(key)) return;
      dedup.add(key);
      merged.push(event);
    };
    for (const e of savedEvents) pushUnique(e);
    for (const e of feedUpcomingEvents) {
      const rsvp = rsvpStatuses[eventStorageKey(e)];
      if (rsvp === "going" || rsvp === "interested") pushUnique(e);
    }
    return merged.sort((a, b) =>
      `${a.date || "9999-12-31"} ${a.start_time || "99:99"}`.localeCompare(
        `${b.date || "9999-12-31"} ${b.start_time || "99:99"}`
      )
    );
  }, [savedEvents, feedUpcomingEvents, rsvpStatuses]);

  const feedFollowedMasjidSummaries = useMemo(
    () =>
      followedMasjids
        .map((raw) => {
          const source = normalizeText(raw);
          if (!source) return null;
          const lc = source.toLowerCase();
          const upcoming = feedUpcomingEvents
            .filter((e) => normalizeText(e.source).toLowerCase() === lc)
            .sort((a, b) =>
              `${a.date || ""} ${a.start_time || "99:99"}`.localeCompare(
                `${b.date || ""} ${b.start_time || "99:99"}`
              )
            );
          return {
            source,
            upcomingCount: upcoming.length,
            nextEvent: upcoming[0],
            amenitiesRec: masjidAmenities[lc],
          };
        })
        .filter((row): row is NonNullable<typeof row> => row != null),
    [followedMasjids, feedUpcomingEvents, masjidAmenities]
  );

  const feedUnfollowedMasjidBuckets = useMemo(() => {
    const byMasjid = new Map<string, { source: string; count: number; nextDate?: string; distance?: number }>();
    for (const e of feedUpcomingEvents) {
      const src = normalizeText(e.source);
      if (!src || followedMasjidSet.has(src.toLowerCase())) continue;
      const cur = byMasjid.get(src) || { source: src, count: 0, distance: typeof e.distance_miles === "number" ? e.distance_miles : undefined };
      cur.count += 1;
      if (!cur.nextDate || (e.date || "") < cur.nextDate) cur.nextDate = e.date;
      if (cur.distance == null && typeof e.distance_miles === "number") cur.distance = e.distance_miles;
      byMasjid.set(src, cur);
    }
    return [...byMasjid.values()]
      .sort((a, b) => {
        if (a.distance != null && b.distance != null && a.distance !== b.distance) return a.distance - b.distance;
        return b.count - a.count;
      })
      .slice(0, 10);
  }, [feedUpcomingEvents, followedMasjidSet]);

  const feedSpeakerCards = useMemo(() => {
    const slugify = (value: string) =>
      normalizeText(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    const bySlug = new Map<string, Speaker>();
    for (const sp of speakers) {
      const canonicalName = finalizeScholarCandidate(cleanSpeakerName(sp.name || sp.slug || ""));
      const slug = slugify(canonicalName || sp.slug || sp.name);
      if (!slug) continue;
      bySlug.set(slug, {
        ...sp,
        slug,
        name: canonicalName || cleanSpeakerName(sp.name || sp.slug || ""),
      });
    }
    for (const e of feedUpcomingEvents) {
      const name = finalizeScholarCandidate(cleanSpeakerName(effectiveEventSpeakerName(e)));
      if (!name) continue;
      const slug = slugify(name);
      if (!slug) continue;
      const existing = bySlug.get(slug) || {
        slug,
        name,
        total_events: 0,
        upcoming_events: 0,
        sources: [],
      };
      existing.upcoming_events = Math.max(existing.upcoming_events || 0, 0) + 1;
      existing.total_events = Math.max(existing.total_events || 0, 0) + 1;
      const src = normalizeText(e.source);
      if (src && !existing.sources.includes(src)) existing.sources.push(src);
      if (!existing.next_date || (e.date || "") < (existing.next_date || "9999-12-31")) {
        existing.next_date = e.date || null;
        existing.next_title = eventDisplayTitle(e);
      }
      if (!existing.name || existing.name.length < name.length) existing.name = name;
      bySlug.set(slug, existing);
    }
    return [...bySlug.values()]
      .filter((sp) => (sp.upcoming_events || 0) > 0 || followedScholarSlugSet.has(sp.slug))
      .sort(
        (a, b) =>
          Number(followedScholarSlugSet.has(b.slug)) - Number(followedScholarSlugSet.has(a.slug)) ||
          (b.upcoming_events || 0) - (a.upcoming_events || 0) ||
          cleanSpeakerName(a.name).localeCompare(cleanSpeakerName(b.name))
      )
      .slice(0, 14);
  }, [speakers, feedUpcomingEvents, followedScholarSlugSet]);

  const feedSetupMasjidOptions = useMemo(() => {
    const combined = [...feedFollowedMasjidSummaries.map((x) => x.source), ...feedUnfollowedMasjidBuckets.map((x) => x.source)];
    return Array.from(new Set(combined)).slice(0, 24);
  }, [feedFollowedMasjidSummaries, feedUnfollowedMasjidBuckets]);

  const feedSetupSpeakerOptions = useMemo(
    () => feedSpeakerCards.map((s) => ({ slug: s.slug, name: cleanSpeakerName(s.name), upcoming: s.upcoming_events || 0 })).slice(0, 20),
    [feedSpeakerCards]
  );

  const feedSetupTopicOptions = useMemo(() => {
    const fromInterests = personalization.interests.map((x) => normalizeText(x).toLowerCase()).filter(Boolean);
    const merged = Array.from(new Set([...feedTopicOptions, ...fromInterests]));
    return merged.length ? merged : ["halaqas", "classes", "community", "family", "youth"];
  }, [feedTopicOptions, personalization.interests]);

  const openFeedSetupWizard = useCallback(() => {
    setFeedSetupMasjids(followedMasjids);
    setFeedSetupScholars(followedScholars);
    setFeedSetupTopics(personalization.interests.map((x) => normalizeText(x).toLowerCase()).filter(Boolean));
    setFeedSetupStep(0);
    setFeedSetupApplying(false);
    // Open the wizard inline on the Your Feed tab (not a modal). If the
    // user is elsewhere in the app, jump them to the Your Feed tab so the
    // wizard actually shows.
    setFeedEditMode(true);
    setFeedSetupOpen(false);
    setTab("feed");
  }, [followedMasjids, followedScholars, personalization.interests]);

  // Wipes the "feed setup done" flag so the mandatory inline wizard prompts
  // the user again the next time they open the Your Feed tab. Also clears
  // wizard selections so they start from a blank slate rather than their
  // previously-followed list. Called from Settings → Content.
  const resetFeedSetup = useCallback(() => {
    Alert.alert(
      "Reset Your Feed setup?",
      "We'll ask you again which masjids, speakers, and topics you want — just like the first time. Your saved events and followed masjids stay.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Reset",
          style: "destructive",
          onPress: async () => {
            try {
              await SecureStore.deleteItemAsync(FEED_SETUP_DONE_KEY);
            } catch {
              // non-fatal
            }
            setFeedSetupDone(false);
            setFeedEditMode(false);
            setFeedSetupOpen(false);
            setFeedSetupApplying(false);
            setFeedSetupStep(0);
            setFeedSetupMasjids([]);
            setFeedSetupScholars([]);
            setFeedSetupTopics([]);
            hapticTap("selection");
            setTab("feed");
          },
        },
      ]
    );
  }, []);

  useEffect(() => {
    if (!feedSetupHydratedRef.current) return;
    if (entryScreen !== "app") return;
    if (tab !== "feed") return;
    if (feedSetupDone || feedSetupApplying) return;
    // Prime selections for the inline wizard on the Your Feed screen.
    // We no longer pop a modal — the wizard takes over the tab body itself
    // and the user must answer to proceed.
    setFeedSetupMasjids((prev) => (prev.length ? prev : followedMasjids));
    setFeedSetupScholars((prev) => (prev.length ? prev : followedScholars));
    setFeedSetupTopics((prev) =>
      prev.length
        ? prev
        : personalization.interests.map((x) => normalizeText(x).toLowerCase()).filter(Boolean)
    );
  }, [
    tab,
    entryScreen,
    feedSetupDone,
    feedSetupApplying,
    followedMasjids,
    followedScholars,
    personalization.interests,
  ]);

  const applyFeedSetupWizard = useCallback(async () => {
    if (feedSetupApplying) return;
    setFeedSetupApplying(true);
    setFeedBuildPhase("building");
    setFeedSetupStep(3);
    // Keep the hammer-cat GIF on screen longer for QA screenshots.
    const BUILD_SCREEN_MS = 12000;
    feedBuildProgress.setValue(0);
    Animated.sequence([
      Animated.timing(feedBuildProgress, { toValue: 0.42, duration: 900, easing: Easing.out(Easing.cubic), useNativeDriver: false }),
      Animated.timing(feedBuildProgress, { toValue: 0.78, duration: 1100, easing: Easing.inOut(Easing.quad), useNativeDriver: false }),
      Animated.timing(feedBuildProgress, { toValue: 0.98, duration: 1000, easing: Easing.out(Easing.quad), useNativeDriver: false }),
    ]).start();
    // Sways the hammer-cat GIF around its existing motion so the card
    // feels alive even if a frame ever drops.
    feedBuildHammerTilt.setValue(0);
    const tiltLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(feedBuildHammerTilt, { toValue: 1, duration: 420, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
        Animated.timing(feedBuildHammerTilt, { toValue: -1, duration: 420, easing: Easing.inOut(Easing.sin), useNativeDriver: true }),
      ])
    );
    tiltLoop.start();
    const nextMasjids = Array.from(new Set(feedSetupMasjids.map((x) => normalizeText(x)).filter(Boolean)));
    const nextScholars = Array.from(new Set(feedSetupScholars.map((x) => String(x)).filter(Boolean)));
    const nextTopics = Array.from(new Set(feedSetupTopics.map((x) => normalizeText(x).toLowerCase()).filter(Boolean))).slice(0, 8);
    const minBuildHold = new Promise<void>((resolve) => setTimeout(resolve, BUILD_SCREEN_MS));
    try {
      setFollowedMasjids(nextMasjids);
      setFollowedScholars(nextScholars);
      setPersonalization((prev) => ({ ...prev, interests: nextTopics }));
      setFeedTopicFilter(nextTopics[0] || null);
      await Promise.all([
        SecureStore.setItemAsync(FOLLOWED_MASJIDS_KEY, JSON.stringify(nextMasjids)),
        SecureStore.setItemAsync(FOLLOWED_SCHOLARS_KEY, JSON.stringify(nextScholars)),
        SecureStore.setItemAsync(PERSONALIZATION_KEY, JSON.stringify({
          ...personalization,
          interests: nextTopics,
        })),
        SecureStore.setItemAsync(FEED_SETUP_DONE_KEY, "1"),
        minBuildHold,
      ]);
      try {
        if (currentUser) {
          await apiJson("/api/profile", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              favorite_sources: nextMasjids,
              audience_filter: profileDraft.audience_filter || "all",
              radius: profileDraft.radius || 35,
              onboarding_done: profileDraft.onboarding_done,
              notifications: profileDraft.notifications || {
                new_event_followed: true,
                followed_speakers: true,
                tonight_after_maghrib: true,
                prayer_reminders: true,
                rsvp_reminders: true,
                quiet_hours_start: "22:30",
                quiet_hours_end: "06:30",
                daily_notification_cap: 6,
              },
            }),
          });
        }
      } catch {
        // non-fatal sync failure
      }
      tiltLoop.stop();
      Animated.timing(feedBuildProgress, { toValue: 1, duration: 280, easing: Easing.out(Easing.cubic), useNativeDriver: false }).start();
      setFeedBuildPhase("success");
      feedBuildSuccessScale.setValue(0.6);
      Animated.spring(feedBuildSuccessScale, { toValue: 1, friction: 6, tension: 110, useNativeDriver: true }).start();
      hapticTap("success");
      await new Promise<void>((resolve) => setTimeout(resolve, 1000));
      setFeedSetupDone(true);
      setFeedSetupOpen(false);
      setFeedEditMode(false);
    } catch {
      Alert.alert("Couldn't save feed setup", "Try again in a moment.");
    } finally {
      tiltLoop.stop();
      setFeedBuildPhase(null);
      setFeedSetupApplying(false);
      setFeedSetupStep(0);
    }
  }, [
    feedSetupApplying,
    feedSetupMasjids,
    feedSetupScholars,
    feedSetupTopics,
    personalization,
    currentUser,
    profileDraft.audience_filter,
    profileDraft.radius,
    profileDraft.onboarding_done,
    profileDraft.notifications,
  ]);

  /** All upcoming visible events (same filters as Explore), for Calendar month grid + export list. */
  const calendarScheduleEvents = useMemo(() => {
    return orderedVisibleEvents
      .filter((e) => normalizeText(e.date) && (e.date || "") >= today && !isEventPastNow(e))
      .sort((a, b) =>
        `${a.date || ""} ${a.start_time || "99:99"}`.localeCompare(`${b.date || ""} ${b.start_time || "99:99"}`)
      );
  }, [orderedVisibleEvents, today]);

  /**
   * AI-style "knowledge plans" for the Calendar tab. Given the pool of
   * upcoming events we propose a curated 4–5-event track per major
   * knowledge theme. The selection is deliberately heuristic (regex
   * topic match + diversity + chronological spread) so we don't need a
   * server round-trip — but the shape (`topic → sequenced events`) is
   * designed so a real LLM/backend can later drop in a better ranker
   * without the UI changing.
   */
  const knowledgePlans = useMemo(() => {
    type Topic = {
      id: string;
      title: string;
      sub: string;
      mi: MiName;
      color: string;
      match: (e: EventItem) => boolean;
    };
    const textOf = (e: EventItem) =>
      `${e.title || ""} ${e.description || ""} ${e.category || ""} ${e.topics?.join(" ") || ""}`.toLowerCase();
    const topics: Topic[] = [
      {
        id: "quran-tafsir",
        title: "Qur'an & Tafsir",
        sub: "Understand the Book of Allah, verse by verse.",
        mi: "auto_awesome",
        color: "#2e7d5f",
        match: (e) => /\b(tafsir|tafseer|qur'?an|quran|tajweed|ayah|surah|qira'?ah|recitation)\b/.test(textOf(e)),
      },
      {
        id: "seerah",
        title: "Seerah & Sunnah",
        sub: "Walk through the life of the Prophet ﷺ.",
        mi: "star_fill1",
        color: "#8b5a2b",
        match: (e) => /\b(seerah|sirah|prophet'?s life|madinah era|makkah era|meccan era|madani era|sunnah|hadith|prophet muhammad|companions|sahaba)\b/.test(textOf(e)),
      },
      {
        id: "fiqh-aqeedah",
        title: "Fiqh & Aqeedah",
        sub: "Foundations of belief and daily rulings.",
        mi: "verified_user",
        color: "#3a4faa",
        match: (e) => /\b(fiqh|aqeedah|aqidah|usul|pillars|tawheed|tawhid|creed|halal|haram|rulings|jurisprudence|hanafi|shafi|maliki|hanbali)\b/.test(textOf(e)),
      },
      {
        id: "tazkiyah",
        title: "Tazkiyah of the Heart",
        sub: "Spiritual growth, dua, and self-purification.",
        mi: "favorite",
        color: "#a24e9a",
        match: (e) => /\b(tazkiyah|tazkiya|purification|sufi|tasawwuf|spirituality|dhikr|zikr|dua|heart|ihsan|reliance|tawakkul|patience|sabr)\b/.test(textOf(e)),
      },
      {
        id: "family-youth",
        title: "Family, Youth & Parenting",
        sub: "Raising a household on the prophetic path.",
        mi: "groups",
        color: "#c15a1d",
        match: (e) => /\b(family|marriage|parenting|youth|teen|kids?|children|students?|couples|mother|father|parents?)\b/.test(textOf(e)),
      },
      {
        id: "contemporary",
        title: "Contemporary Issues",
        sub: "Islam in today's world — mental health, media, identity.",
        mi: "lightbulb",
        color: "#3f6c8c",
        match: (e) => /\b(mental health|anxiety|depression|therapy|identity|media|technology|social media|dawah|community|racism|justice|palestine|ummah|politics|finance|islamic finance|riba)\b/.test(textOf(e)),
      },
    ];

    // Audience-specific plan, only included when the user has declared
    // an audience preference. Always placed FIRST so brothers/sisters
    // immediately see what's programmed for them specifically.
    if (personalization.preferredAudience === "sisters") {
      topics.unshift({
        id: "sisters-track",
        title: "Sisters' learning track",
        sub: "Halaqahs, tafsir & circles specifically for sisters.",
        mi: "school",
        color: "#a24e9a",
        match: (e) => inferAudience(e) === "sisters",
      });
    } else if (personalization.preferredAudience === "brothers") {
      topics.unshift({
        id: "brothers-track",
        title: "Brothers' learning track",
        sub: "Halaqahs, classes & circles specifically for brothers.",
        mi: "school",
        color: "#2e5caa",
        match: (e) => inferAudience(e) === "brothers",
      });
    }

    const nowKey = today;
    // Cap how far ahead we look. A 6-week window is long enough to
    // produce a real "plan" (2–3 events per month) without surfacing
    // stale content that won't help the user this season.
    const horizonEnd = plusDaysIso(6 * 7);

    const candidatePool = orderedVisibleEvents
      .filter((e) => {
        const d = e.date || "";
        if (!d) return false;
        if (d < nowKey) return false;
        if (d > horizonEnd) return false;
        if (isEventPastNow(e)) return false;
        // Respect the user's audience preference: if they picked
        // "brothers" we never surface sisters-only events in their
        // personalised plan (and vice versa). "family" / "general"
        // events pass for everyone.
        if (personalization.preferredAudience === "brothers" && inferAudience(e) === "sisters") return false;
        if (personalization.preferredAudience === "sisters" && inferAudience(e) === "brothers") return false;
        return true;
      })
      .sort((a, b) =>
        `${a.date || ""} ${a.start_time || "99:99"}`.localeCompare(
          `${b.date || ""} ${b.start_time || "99:99"}`,
        ),
      );

    const plans = topics
      .map((topic) => {
        const matches = candidatePool.filter(topic.match);
        // Diversity pass — max 2 events per speaker so the plan doesn't
        // become "The Shaykh X sampler" when one teacher dominates the
        // topic. Also avoid duplicate same-day entries.
        const seenBySpeaker = new Map<string, number>();
        const seenByDate = new Set<string>();
        const picked: EventItem[] = [];
        for (const ev of matches) {
          const speakerKey = (ev.speaker || "").toLowerCase().trim();
          const dateKey = ev.date || "";
          const speakerCount = speakerKey ? seenBySpeaker.get(speakerKey) || 0 : 0;
          if (speakerKey && speakerCount >= 2) continue;
          if (dateKey && seenByDate.has(dateKey)) continue;
          picked.push(ev);
          if (speakerKey) seenBySpeaker.set(speakerKey, speakerCount + 1);
          if (dateKey) seenByDate.add(dateKey);
          if (picked.length >= 5) break;
        }
        return {
          id: topic.id,
          title: topic.title,
          sub: topic.sub,
          mi: topic.mi,
          color: topic.color,
          events: picked,
        };
      })
      .filter((p) => p.events.length >= 2);

    return plans;
    // Depends on events + today + audience preference so sisters/brothers
    // see their dedicated track as soon as they set a preference.
  }, [orderedVisibleEvents, today, personalization.preferredAudience]);

  const futureVisibleCount = useMemo(() => {
    // Home headline count should include Jumu'ah totals even though Jumu'ah
    // cards are intentionally hidden from Home/Explore/Discover feeds.
    return events.filter((e) => !isProgramNotEvent(e) && (e.date || "") >= today && !isEventPastNow(e)).length;
  }, [events, today]);

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
    const pins: Array<{ sourceKey: string; latitude: number; longitude: number; count: number; hasLive: boolean }> = [];
    for (const sourceKey of keys) {
      const coord = MASJID_COORDS[sourceKey];
      if (!coord) continue;
      const eventsHere = orderedVisibleEvents.filter(
        (ev) => normalizeText(ev.source).toLowerCase() === sourceKey
      );
      const hasLive = eventsHere.some((ev) => isEventLiveNow(ev));
      pins.push({
        sourceKey,
        latitude: coord.latitude,
        longitude: coord.longitude,
        count: eventsHere.length,
        hasLive,
      });
    }
    return pins;
  }, [meta?.sources, orderedVisibleEvents]);

  // Whenever the user changes filters, audience, or the underlying catalog
  // shape changes, snap the progressive-render cap back to the first batch so
  // they see the newest matches without scrolling.
  useEffect(() => {
    setExploreSectionLimit(EXPLORE_SECTIONS_BATCH);
  }, [audienceFilter, halaqaFilter, quickFilters, exploreSections.length]);

  useEffect(() => {
    if (exploreMode !== "map" || !masjidPinsForExplore.length) return;
    const withEvents = masjidPinsForExplore.filter((p) => p.count > 0);
    const pool = withEvents.length ? withEvents : masjidPinsForExplore;
    const latitude = pool.reduce((sum, p) => sum + p.latitude, 0) / pool.length;
    const longitude = pool.reduce((sum, p) => sum + p.longitude, 0) / pool.length;
    const nextRegion: Region = { ...mapRegionRef.current, latitude, longitude };
    mapRegionRef.current = nextRegion;
    mapRef.current?.animateToRegion(nextRegion, 0);
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
    const willSave = !next[key];
    if (next[key]) delete next[key];
    else next[key] = e;
    setSavedEventsMap(next);
    hapticTap(willSave ? "success" : "selection");
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

  // Commit a share code the user typed in. Returns the normalized code if
  // accepted, empty string on validation fail. We optimistically POST to
  // the backend so the inviter gets credit, but the local tie-up lives on
  // device either way — this keeps the raffle-entry flow working even if
  // the backend is offline.
  const commitReferralCode = async (rawInput: string): Promise<string> => {
    if (!(rawInput || "").toString().trim()) {
      setReferralSaveError("Enter a code first.");
      setReferralSavingState("error");
      return "";
    }
    const normalized = normalizeMasjidlyShareCode(rawInput);
    if (!normalized) {
      setReferralSaveError("That doesn't look like a Masjid.ly code. It should look like M-AB12C.");
      setReferralSavingState("error");
      return "";
    }
    if (referralCode && normalized === referralCode) {
      setReferralSaveError("That's your own code — share it with a friend instead.");
      setReferralSavingState("error");
      return "";
    }
    setReferralSavingState("saving");
    setReferralSaveError("");
    setReferredByCode(normalized);
    try {
      await SecureStore.setItemAsync(REFERRED_BY_KEY, normalized);
    } catch {
      // local persistence is best-effort; the in-memory copy is enough
      // to unblock the rest of the flow.
    }
    try {
      await apiJson("/api/referral", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          inviter_code: normalized,
          invitee_code: referralCode,
        }),
      });
    } catch {
      // Backend may not have the endpoint yet — that's fine, the local
      // state is enough to enter the raffle on the next sync.
    }
    setReferralSavingState("saved");
    hapticTap("success");
    return normalized;
  };

  const toggleFollowScholar = (slug: string) => {
    if (!slug) return;
    const willFollow = !followedScholars.includes(slug);
    const next = willFollow ? [...followedScholars, slug] : followedScholars.filter((s) => s !== slug);
    setFollowedScholars(next);
    queueMicrotask(() => hapticTap(willFollow ? "success" : "selection"));
    InteractionManager.runAfterInteractions(() => {
      void (async () => {
        try {
          await SecureStore.setItemAsync(FOLLOWED_SCHOLARS_KEY, JSON.stringify(next));
        } catch {
          /* non-blocking scholar-follow cache write */
        }
      })();
    });
  };

  const toggleFollowMasjid = (source: string) => {
    const src = normalizeText(source);
    if (!src) return;
    const willFollow = !followedMasjids.includes(src);
    const next = willFollow ? [...followedMasjids, src] : followedMasjids.filter((s) => s !== src);
    setFollowedMasjids(next);
    queueMicrotask(() => hapticTap(willFollow ? "success" : "selection"));
    const user = currentUser;
    const draft = profileDraft;
    const rad = radius;
    const aud = audienceFilter;
    const token = pushToken;
    InteractionManager.runAfterInteractions(() => {
      void (async () => {
        try {
          await SecureStore.setItemAsync(FOLLOWED_MASJIDS_KEY, JSON.stringify(next));
        } catch {
          // non-blocking follow cache write
        }
        if (user) {
          try {
            await apiJson("/api/profile", {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ...draft,
                onboarding_done: draft.onboarding_done,
                radius: Number(rad || draft.radius || 35),
                favorite_sources: next,
                audience_filter: aud,
                expo_push_token: token,
              }),
            });
          } catch {
            // local follow can continue even if profile sync fails
          }
        }
      })();
    });
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
    const willActivate = current !== status;
    if (current === status) {
      delete next[key];
    } else {
      next[key] = status;
    }
    setRsvpStatuses(next);
    hapticTap(willActivate ? "success" : "selection");
    try {
      await SecureStore.setItemAsync(RSVP_STATUSES_KEY, JSON.stringify(next));
    } catch {
      // ignore local rsvp write failure
    }
    // Fire-and-forget: schedule / cancel local reminders so users get pinged
    // the morning of and ~2h before each RSVP'd event. We store the scheduled
    // notification ids keyed by event so we can cancel them if the user
    // changes their mind.
    try {
      if (willActivate) {
        if (profileDraft.notifications?.rsvp_reminders !== false) {
          await scheduleEventReminders(e, profileDraft.notifications);
        }
      } else {
        await cancelEventReminders(key);
      }
    } catch {
      // notification scheduling is best-effort; never block the UI.
    }
  };

  const updateNotificationPreference = async (
    key: keyof NonNullable<ProfilePayload["notifications"]>,
    value: boolean | string | number,
  ) => {
    hapticTap("selection");
    const nextNotifications = {
      new_event_followed: profileDraft.notifications?.new_event_followed ?? true,
      followed_speakers: profileDraft.notifications?.followed_speakers ?? true,
      tonight_after_maghrib: profileDraft.notifications?.tonight_after_maghrib ?? true,
      prayer_reminders: profileDraft.notifications?.prayer_reminders ?? true,
      rsvp_reminders: profileDraft.notifications?.rsvp_reminders ?? true,
      quiet_hours_start: profileDraft.notifications?.quiet_hours_start || "22:30",
      quiet_hours_end: profileDraft.notifications?.quiet_hours_end || "06:30",
      daily_notification_cap: profileDraft.notifications?.daily_notification_cap || 6,
      [key]: value,
    };
    if (typeof nextNotifications.daily_notification_cap !== "number") {
      nextNotifications.daily_notification_cap = Number(nextNotifications.daily_notification_cap || 6);
    }
    nextNotifications.daily_notification_cap = Math.max(1, Math.min(25, Number(nextNotifications.daily_notification_cap || 6)));
    nextNotifications.quiet_hours_start = normalizeText(String(nextNotifications.quiet_hours_start || "22:30")) || "22:30";
    nextNotifications.quiet_hours_end = normalizeText(String(nextNotifications.quiet_hours_end || "06:30")) || "06:30";
    const nextDraft = { ...profileDraft, notifications: nextNotifications };
    setProfileDraft(nextDraft);
    try {
      await apiJson("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...nextDraft,
          radius: Number(radius || nextDraft.radius || 35),
          expo_push_token: pushToken || nextDraft.expo_push_token || "",
        }),
      });
    } catch {
      // local setting still applies even if remote profile sync fails.
    }
  };

  const shareEvent = (e: EventItem) => {
    hapticTap("selection");
    const when = `${formatHumanDate(e.date)} · ${eventTime(e)}`;
    const link = e.deep_link?.web || e.source_url || "";
    const masjid = formatSourceLabel(e.source);
    const msg = link
      ? `${e.title} at ${masjid}\n${when}\n${link}`
      : `${e.title} at ${masjid}\n${when}`;
    Share.share({ title: e.title, message: msg, ...(link ? { url: link } : {}) });
  };

  const openEventDetails = useCallback((e: EventItem) => {
    hapticTap("selection");
    setSelectedEvent(e);
  }, []);

  const closeEventDetails = useCallback(() => {
    hapticTap("selection");
    setPosterFullscreenUri(null);
    setSelectedEvent(null);
  }, []);

  // #12 Bring-a-friend invite — pre-filled invite with poster + deep link + "save my seat" CTA
  const inviteFriendsToEvent = (e: EventItem) => {
    const when = `${formatHumanDate(e.date)} · ${eventTime(e)}`;
    const masjid = formatSourceLabel(e.source);
    const link = e.deep_link?.web || `https://masjidly.app/event/${e.event_uid || ""}`;
    const poster = eventPosterUrl(e);
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
      `— via Masjid.ly`,
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
      const res = await fetch(`${API_BASE_URL}/api/speakers?speaker_normalize=ai`);
      if (!res.ok) return;
      const d = await res.json();
      setSpeakers(d.speakers || []);
    } catch {
      // ignore
    }
  }, []);

  // #17 YouTube archive per speaker. Mark the slot as loading immediately
  // so the detail view can show a spinner; the backend call itself caches
  // for 72 hours so rapid re-opens don't hammer the network.
  const loadSpeakerVideos = useCallback(async (slug: string) => {
    if (!slug) return;
    setSpeakerVideos((prev) => {
      if (prev[slug]?.videos?.length && !prev[slug].loading) return prev;
      return { ...prev, [slug]: { videos: prev[slug]?.videos || [], loading: true } };
    });
    try {
      const res = await fetch(`${API_BASE_URL}/api/speakers/${encodeURIComponent(slug)}/videos`);
      if (!res.ok) {
        setSpeakerVideos((prev) => ({
          ...prev,
          [slug]: { videos: prev[slug]?.videos || [], loading: false, status: "error" },
        }));
        return;
      }
      const d = await res.json();
      setSpeakerVideos((prev) => ({
        ...prev,
        [slug]: {
          videos: Array.isArray(d.videos) ? d.videos : [],
          loading: false,
          status: d.status || "ok",
        },
      }));
    } catch {
      setSpeakerVideos((prev) => ({
        ...prev,
        [slug]: { videos: prev[slug]?.videos || [], loading: false, status: "offline" },
      }));
    }
  }, []);

  // #22 Masjid amenities — one bulk fetch at startup so every profile
  // modal can render instantly. Re-runs when the backend data version
  // changes (same `data_version` hook as the events cache).
  const loadMasjidAmenities = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/masjids/amenities`);
      if (!res.ok) return;
      const d = await res.json();
      const map = d?.masjids || {};
      const normalized: Record<string, MasjidAmenities> = {};
      Object.keys(map).forEach((k) => {
        const row = map[k] || {};
        normalized[k.toLowerCase()] = {
          amenities: row.amenities || {},
          description: row.description || "",
          website: row.website || "",
          phone: row.phone || "",
          email: row.email || "",
          updated_at: row.updated_at || "",
        };
      });
      setMasjidAmenities(normalized);
    } catch {
      // ignore — amenities are additive; missing = nothing to show.
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

  // Fetch today's *adhan* (prayer start) times for a masjid from the
  // Aladhan public API. Uses the coordinates we already ship in
  // MASJID_COORDS so every masjid in our directory gets accurate, local
  // prayer times even when the backend hasn't scraped their iqama page
  // yet. ISNA method (2) since most of our masjids are NJ/NY-area.
  const loadPrayerTimesFor = useCallback(async (source: string) => {
    try {
      if (!source) return;
      const key = (source || "").toString();
      try {
        const resApi = await fetch(`${API_BASE_URL}/api/prayer-times/${encodeURIComponent(key)}`);
        if (resApi.ok) {
          const payload = await resApi.json();
          const row = payload?.source;
          if (row && typeof row === "object") {
            const prayers = row.prayers || {};
            setPrayerApiBySource((prev) => ({
              ...prev,
              [key]: {
                source_url: row.source_url || "",
                last_updated_label: row.last_updated_label || "",
                source_type: row.source_type || "website_scrape",
                is_stale: !!row.is_stale,
                stale_reason: row.stale_reason || "",
                prayers: {
                  fajr: normalizeText(prayers.fajr || ""),
                  dhuhr: normalizeText(prayers.dhuhr || ""),
                  asr: normalizeText(prayers.asr || ""),
                  maghrib: normalizeText(prayers.maghrib || ""),
                  isha: normalizeText(prayers.isha || ""),
                },
                iqama: row.iqama || {},
                jumuah: Array.isArray(row.jumuah) ? row.jumuah : [],
              },
            }));
            if (prayers.fajr || prayers.dhuhr || prayers.asr || prayers.maghrib || prayers.isha) {
              setPrayerTimesBySource((prev) => ({
                ...prev,
                [key]: {
                  date: todayIso(),
                  fajr: normalizeText(prayers.fajr || ""),
                  dhuhr: normalizeText(prayers.dhuhr || ""),
                  asr: normalizeText(prayers.asr || ""),
                  maghrib: normalizeText(prayers.maghrib || ""),
                  isha: normalizeText(prayers.isha || ""),
                },
              }));
              return;
            }
          }
        }
      } catch {
        // non-fatal: fall through to aladhan fallback
      }
      const coord = MASJID_COORDS[key] || MASJID_COORDS[key.toLowerCase()];
      if (!coord) return;
      const today = new Date();
      const dd = String(today.getDate()).padStart(2, "0");
      const mm = String(today.getMonth() + 1).padStart(2, "0");
      const yyyy = today.getFullYear();
      // Don't refetch if we already have today's times cached.
      const cached = prayerTimesBySource[key];
      const todayDateIso = `${yyyy}-${mm}-${dd}`;
      if (cached && cached.date === todayDateIso) return;
      const url = `https://api.aladhan.com/v1/timings/${dd}-${mm}-${yyyy}?latitude=${coord.latitude}&longitude=${coord.longitude}&method=2`;
      const res = await fetch(url);
      if (!res.ok) return;
      const d = await res.json();
      const t = d?.data?.timings;
      if (!t) return;
      // Strip timezone suffixes Aladhan sometimes appends, e.g. "5:45 (EST)".
      const clean = (s: string) => String(s || "").replace(/\s*\([^)]+\)\s*$/, "").trim();
      setPrayerTimesBySource((prev) => ({
        ...prev,
        [key]: {
          date: todayDateIso,
          fajr: clean(t.Fajr),
          dhuhr: clean(t.Dhuhr),
          asr: clean(t.Asr),
          maghrib: clean(t.Maghrib),
          isha: clean(t.Isha),
        },
      }));
    } catch {
      // non-blocking fallback; the iqama card will just show "—"
    }
    // prayerTimesBySource intentionally omitted to keep the callback
    // stable and avoid unnecessary refetches.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const refreshJumuahFinder = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (profileDraft.home_lat != null) params.set("lat", String(profileDraft.home_lat));
      if (profileDraft.home_lon != null) params.set("lon", String(profileDraft.home_lon));
      params.set("radius", String(jumuahFilters.radius || 25));
      if (jumuahFilters.language) params.set("language", jumuahFilters.language);
      if (jumuahFilters.start) params.set("start", jumuahFilters.start);
      if (jumuahFilters.end) params.set("end", jumuahFilters.end);
      if (jumuahFilters.parking) params.set("parking", "1");
      const res = await fetch(`${API_BASE_URL}/api/jumuah/finder?${params.toString()}`);
      if (!res.ok) return;
      const payload = await res.json();
      setJumuahFinderRows(Array.isArray(payload?.results) ? payload.results : []);
    } catch {
      // non-fatal
    }
  }, [jumuahFilters.end, jumuahFilters.language, jumuahFilters.parking, jumuahFilters.radius, jumuahFilters.start, profileDraft.home_lat, profileDraft.home_lon]);

  const submitPrayerTimeReport = useCallback(
    async (source: string, prayer: string, details: string) => {
      try {
        await apiJson("/api/prayer-times/report", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source,
            prayer,
            issue: "wrong_time",
            details: normalizeText(details) || "Reported from mobile app",
            source_url: prayerApiBySource[source]?.source_url || "",
          }),
        });
        Alert.alert("Report sent", "Thanks - we'll review this prayer time.");
      } catch {
        Alert.alert("Couldn't send report", "Please try again in a moment.");
      }
    },
    [prayerApiBySource],
  );

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
    loadMasjidAmenities();
  }, [loadEventSeries, loadSpeakers, loadMasjidAmenities]);

  useEffect(() => {
    if (selectedSpeaker) {
      loadSpeakerVideos(selectedSpeaker);
    }
  }, [selectedSpeaker, loadSpeakerVideos]);

  useEffect(() => {
    loadPassport();
  }, [loadPassport]);

  useEffect(() => {
    if (selectedMasjidSheet) {
      loadIqamaFor(selectedMasjidSheet);
      loadPrayerTimesFor(selectedMasjidSheet);
    }
  }, [selectedMasjidSheet, loadIqamaFor, loadPrayerTimesFor]);

  useEffect(() => {
    if (selectedMasjidProfile) {
      setMasjidProfileViewTab("events");
      loadIqamaFor(selectedMasjidProfile);
      loadPrayerTimesFor(selectedMasjidProfile);
    }
  }, [selectedMasjidProfile, loadIqamaFor, loadPrayerTimesFor]);

  useEffect(() => {
    if (tab === "discover") {
      void refreshJumuahFinder();
    }
  }, [refreshJumuahFinder, tab]);

  // Add a single event to the device calendar. We route through a Google
  // Calendar template URL because it works cross-platform (iOS opens the
  // URL handler and lets the user pick any calendar; Android opens the
  // Google Calendar app or default calendar). Avoids a native dependency
  // on expo-calendar that would require a new EAS Build.
  const addEventToDeviceCalendar = async (e: EventItem) => {
    try {
      const dateIso = (e.date || "").replace(/-/g, "");
      const startHm = (e.start_time || "18:00").replace(/:/g, "").padEnd(4, "0").slice(0, 4);
      const endHm = (e.end_time || "").replace(/:/g, "").padEnd(4, "0").slice(0, 4);
      const sMin = Number(startHm.slice(0, 2)) * 60 + Number(startHm.slice(2, 4));
      const effectiveEnd = endHm.length === 4 ? endHm : String(Math.floor(((sMin + 60) / 60)) % 24).padStart(2, "0") + String((sMin + 60) % 60).padStart(2, "0");
      const start = `${dateIso}T${startHm}00`;
      const end = `${dateIso}T${effectiveEnd}00`;
      const location = `${formatSourceLabel(e.source)}`;
      const details = `${e.description || ""}${e.source_url ? `\n\nMore: ${e.source_url}` : ""}\n\nAdded via Masjid.ly`;
      const url =
        `https://www.google.com/calendar/render?action=TEMPLATE` +
        `&text=${encodeURIComponent(e.title || "Event")}` +
        `&dates=${start}/${end}` +
        `&details=${encodeURIComponent(details)}` +
        `&location=${encodeURIComponent(location)}`;
      hapticTap("success");
      await Linking.openURL(url);
    } catch (err) {
      console.warn("add-to-calendar", err);
      Alert.alert("Calendar", "Couldn't open your calendar app. Try again in a moment.");
    }
  };

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

  const submitCommunityCorrection = async (opts?: { eventUid?: string; issueType?: string; details?: string; closeAfter?: boolean }) => {
    const eventUid = normalizeText(opts?.eventUid || selectedEvent?.event_uid || "");
    if (!eventUid) return;
    const issueType = normalizeText(opts?.issueType || reportIssueType || "other").toLowerCase();
    const details = normalizeText(opts?.details ?? reportDetails);
    try {
      await apiJson("/api/moderation/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_uid: eventUid,
          issue_type: issueType,
          details,
        }),
      });
      hapticTap("success");
      setReportIssueType(issueType);
      setReportDetails("");
      if (opts?.closeAfter ?? true) setShowReportSection(false);
      Alert.alert("Thanks", "Your correction report was sent to moderation.");
    } catch (err) {
      Alert.alert("Could not submit", (err as Error).message || "Try again shortly.");
    }
  };

  const submitQuickCorrection = async (ev: EventItem, issueType: "title" | "speaker" | "poster" | "duplicate") => {
    if (!ev.event_uid) return;
    hapticTap("selection");
    setSelectedEvent(ev);
    setReportIssueType(issueType);
    const autoDetails = `quick-fix:${issueType} source=${sourceTypeLabelForEvent(ev)} title="${eventDisplayTitle(ev)}"`;
    await submitCommunityCorrection({ eventUid: ev.event_uid, issueType, details: autoDetails, closeAfter: false });
  };

  useEffect(() => {
    if (!selectedEvent) {
      setShowReportSection(false);
      setShowEventDataChecks(false);
      setShowFullDescription(false);
      setShowOriginalDescription(false);
      setReportDetails("");
      setReportIssueType("time");
      return;
    }
    const suggested = suggestedQuickFixKind(selectedEvent);
    if (!suggested) return;
    const issue = suggested === "duplicate" ? "duplicate" : suggested;
    setShowReportSection(true);
    setReportIssueType(issue);
    const hint =
      suggested === "title"
        ? "Auto-suggested: title quality looks weak. Suggest a clearer event name."
        : suggested === "speaker"
        ? "Auto-suggested: likely missing speaker. Add the speaker name."
        : suggested === "poster"
        ? "Auto-suggested: poster missing or failed. Add a poster source link."
        : "Auto-suggested: source/type conflict. Confirm if this is a duplicate.";
    setReportDetails((prev) => (normalizeText(prev) ? prev : hint));
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
  const applyModerationMacro = async (reportId: number, macro: "title_fix" | "speaker_fix" | "poster_fix" | "merge_duplicate") => {
    const label =
      macro === "title_fix"
        ? "Approve title fix"
        : macro === "speaker_fix"
        ? "Approve speaker fix"
        : macro === "poster_fix"
        ? "Approve poster swap"
        : "Merge duplicate";
    try {
      await updateModerationReportStatus(reportId, "resolved");
      Alert.alert("Macro applied", `${label} was marked resolved.`);
    } catch {
      // updateModerationReportStatus already surfaces failures
    }
  };

  const openMasjidPartnerSnapshot = () => {
    const upcoming = events.filter((e) => (e.date || "") >= today && !isEventPastNow(e));
    const bySource = new Map<string, number>();
    for (const e of upcoming) {
      const src = normalizeText(e.source || "").toLowerCase();
      if (!src) continue;
      bySource.set(src, (bySource.get(src) || 0) + 1);
    }
    const top = Array.from(bySource.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([src, count]) => `${formatSourceLabel(src)} (${count})`)
      .join(", ");
    Alert.alert(
      "Masjid partner snapshot",
      `${upcoming.length} upcoming events tracked across ${bySource.size} masjids.\nTop active: ${top || "n/a"}.\n\nWant your masjid dashboard + claim access? Email team@masjidly.app.`,
    );
  };
  const claimFirstFollowedMasjid = async () => {
    const source = normalizeText(followedMasjids[0] || "").toLowerCase();
    if (!source) {
      Alert.alert("Follow a masjid first", "Follow a masjid, then tap claim so we can start your partner onboarding.");
      return;
    }
    try {
      const payload = await apiJson("/api/admin/claim-masjid", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
      });
      Alert.alert(
        "Claim request submitted",
        payload?.verified
          ? `${formatSourceLabel(source)} is now verified for your account.`
          : `Claim request received for ${formatSourceLabel(source)}. We'll verify and follow up.`,
      );
    } catch (err) {
      Alert.alert("Could not claim", (err as Error).message || "Please sign in and try again.");
    }
  };
  const muteSourceFromFeed = async (source: string) => {
    const src = normalizeText(source).toLowerCase();
    if (!src) return;
    if (mutedFeedSources.includes(src)) return;
    const next = [...mutedFeedSources, src];
    setMutedFeedSources(next);
    hapticTap("selection");
    try {
      await SecureStore.setItemAsync(MUTED_FEED_SOURCES_KEY, JSON.stringify(next));
    } catch {
      // ignore local write errors
    }
  };
  const clearMutedFeedSources = async () => {
    setMutedFeedSources([]);
    hapticTap("selection");
    try {
      await SecureStore.deleteItemAsync(MUTED_FEED_SOURCES_KEY);
    } catch {
      // ignore
    }
  };

  const tutorialSteps = [
    "Use Home for upcoming events and live-now programs.",
    "Tap Explore to filter by date, masjid, audience, and search text.",
    "Use Discover for scholars, collections, and quick paths into the events you care about.",
    "Tap any event poster/card to open full details and full flyer.",
  ];

  const goToWelcomeSlide = (nextSlide: number) => {
    const clamped = Math.max(0, Math.min(2, nextSlide));
    const pagerWidth = Math.max(screenWidth, 1);
    setWelcomeSlideIndex(clamped);
    const x = clamped * pagerWidth;
    const scroller = welcomeSlidesRef.current;
    if (!scroller) return;
    requestAnimationFrame(() => {
      scroller.scrollTo({ x, y: 0, animated: true });
    });
  };
  const advanceWelcomeToSetup = useCallback(() => {
    const now = Date.now();
    if (now - welcomeContinueTapTsRef.current < 300) return;
    welcomeContinueTapTsRef.current = now;
    hapticTap("selection");
    goToWelcomeSlide(2);
  }, [goToWelcomeSlide]);

  // Our companion character — a single, smiling, standing Muslim man in a
  // white thobe and kufi. Rendered at whatever `width` the call site needs;
  // the image is square (1024×1024) so height always equals width.
  // The `mode` argument is retained purely for backwards-compat with the
  // previous two-asset system; both modes now render the same art.
  const renderPixelSprite = (
    _unused?: Animated.Value,
    width: number = 64,
    _mode: "avatar" | "greeter" = "avatar"
  ) => {
    return (
      <Image
        source={SPRITE_MAN}
        style={{ width, height: width }}
        resizeMode="contain"
      />
    );
  };

  const renderWelcomeScreen = () => {
    const pagerWidth = Math.max(screenWidth, 1);
    const setupInterests = setupInterestsDraft ?? personalization.interests;
    // Keep the onboarding card centered on taller phones (matching other
    // welcome cards), but stay top-aligned on short screens so every field
    // remains reachable without clipping.
    const centerSetupCard = windowHeight >= 760;
    const welcomeLogoSize = Math.min(380, Math.round(Math.max(200, pagerWidth - 32)));
    const welcomeLogoMarginBottom = -Math.round(welcomeLogoSize * 0.21);
    const handleSetupScroll = (event: any) => {
      const y = event?.nativeEvent?.contentOffset?.y ?? 0;
      welcomeSetupScrollYRef.current = y;
    };
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
              <Pressable unstable_pressDelay={0} onPress={() => goToWelcomeSlide(1)} style={styles.welcomeSlideTapZone}>
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
                  <View
                    style={[
                      styles.welcomeLogoWrap,
                      { width: welcomeLogoSize, height: welcomeLogoSize, marginBottom: welcomeLogoMarginBottom },
                    ]}
                  >
                    <Image source={WELCOME_LOGO} style={styles.welcomeLogoBase} resizeMode="contain" />
                  </View>
                  <Text style={[styles.welcomeBetaBadge, isNeo && styles.welcomeBetaBadgeNeo, isEmerald && styles.welcomeBetaBadgeEmerald]}>{`Version ${APP_BUILD_VERSION}`}</Text>
          <Text style={[styles.welcomeTitle, isMinera && styles.welcomeTitleMinera, isEmerald && styles.welcomeTitleEmerald, isNeo && styles.welcomeTitleNeo]}>Local masjid events, beautifully organized</Text>
          <Text style={[styles.welcomeSub, isMinera && styles.welcomeSubMinera, isEmerald && styles.welcomeSubEmerald, isNeo && styles.welcomeSubNeo]}>
            Discover upcoming programs, classes, and community nights from nearby masjids in one place.
          </Text>
          <View style={styles.heroTrustRow}>
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.8}
              style={[styles.heroTrustPill, isMinera && styles.heroTrustPillMinera, isEmerald && styles.heroTrustPillEmerald, isNeo && styles.heroTrustPillNeo]}
            >
              14+ NJ masjids
            </Text>
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.8}
              style={[styles.heroTrustPill, isMinera && styles.heroTrustPillMinera, isEmerald && styles.heroTrustPillEmerald, isNeo && styles.heroTrustPillNeo]}
            >
              Trusted sources
            </Text>
            <Text
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.8}
              style={[styles.heroTrustPill, isMinera && styles.heroTrustPillMinera, isEmerald && styles.heroTrustPillEmerald, isNeo && styles.heroTrustPillNeo]}
            >
              Fast discovery
            </Text>
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
                    opacity: cardFlipOpacity(1),
                    transform: [
                      { perspective: 1100 },
                      { translateX: cardFlipTranslateX(1) },
                      { rotateY: cardFlipRotate(1) },
                      { scale: cardFlipScale(1) },
                    ],
                  },
                ]}
              >
                <Animated.View
                  pointerEvents="none"
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
                        { translateY: bubbleDrift.interpolate({ inputRange: [0, 1], outputRange: [0, -14] }) },
                        { translateX: bubbleDrift.interpolate({ inputRange: [0, 1], outputRange: [0, -6] }) },
                      ],
                    },
                  ]}
                />
                <Animated.View
                  pointerEvents="none"
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
                        { translateY: bubbleDrift.interpolate({ inputRange: [0, 1], outputRange: [0, 12] }) },
                        { translateX: bubbleDrift.interpolate({ inputRange: [0, 1], outputRange: [0, 8] }) },
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

                <View style={styles.welcomeFeatureStack}>
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
                </View>

                <Animated.View style={{ transform: [{ scale: buttonScale }] }}>
            <Pressable
              unstable_pressDelay={0}
              hitSlop={10}
              pressRetentionOffset={18}
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
                {
                  Animated.spring(buttonScale, {
                    toValue: 0.97,
                    friction: 6,
                    tension: 120,
                    useNativeDriver: true,
                  }).start();
                  // Fire on press-in so tiny finger movement doesn't cancel.
                  advanceWelcomeToSetup();
                }
              }
              onPressOut={() =>
                Animated.spring(buttonScale, {
                  toValue: 1,
                  friction: 6,
                  tension: 120,
                  useNativeDriver: true,
                }).start()
              }
                    onPress={advanceWelcomeToSetup}
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

            <View
              style={[
                styles.welcomeSlide,
                styles.welcomeSlideSetup,
                {
                  width: pagerWidth,
                  // Explicit height is required: the parent is a horizontal
                  // ScrollView and its children otherwise size to content,
                  // which would collapse the inner vertical ScrollView
                  // (flex:1 with no parent height ⇒ 0px tall).
                  height: Math.max(windowHeight - insets.top - insets.bottom - 40, 480),
                },
              ]}
            >
              <KeyboardAvoidingView
                style={styles.welcomeSetupKAV}
                behavior={Platform.OS === "ios" ? "padding" : undefined}
                keyboardVerticalOffset={0}
              >
              <ScrollView
                ref={welcomeSetupScrollRef}
                style={styles.welcomeSetupScroll}
                contentContainerStyle={[
                  styles.welcomeSetupScrollContent,
                  {
                    justifyContent: centerSetupCard ? "center" : "flex-start",
                    // When centered, keep top/bottom inset symmetric so the
                    // card doesn't look like it's floating too high.
                    paddingTop: centerSetupCard ? 8 : 12,
                    paddingBottom: centerSetupCard ? 8 : Math.max(insets.bottom, 24) + 24,
                  },
                ]}
                keyboardShouldPersistTaps="always"
                showsVerticalScrollIndicator
                nestedScrollEnabled
                directionalLockEnabled
                {...IOS_SCROLL_INSTANT_TOUCH}
                onScroll={handleSetupScroll}
                scrollEventThrottle={16}
              >
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
                  pointerEvents="none"
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
                  pointerEvents="none"
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
                <Animated.View
                  style={{
                    opacity: setupStepAnim,
                    transform: [
                      {
                        translateX: setupStepAnim.interpolate({
                          inputRange: [0, 1],
                          outputRange: [setupStepDirRef.current * STEP_TRANSITION_PX, 0],
                        }),
                      },
                    ],
                  }}
                >
                <Text style={[styles.captureTitle, styles.captureTitleCentered, isNeo && styles.welcomeInfoTitleNeo, isEmerald && styles.welcomeInfoTitleEmerald]}>
                  {setupSubStep === 0
                    ? "Tell us about yourself"
                    : setupSubStep === 1
                      ? "Your preferences"
                      : setupSubStep === 2
                        ? "Privacy & permissions"
                        : "You're all set"}
                </Text>
                <Text style={[styles.captureSub, styles.captureSubCentered, isNeo && styles.welcomeInfoSubNeo, isEmerald && styles.welcomeInfoSubEmerald]}>
                  {setupSubStep === 0
                    ? "This isn't a dating app — we just want to personalize your experience. Nothing's sold to anyone; I (the person who made this app) can't afford a lawsuit anyway."
                    : setupSubStep === 1
                      ? "Help us personalize your feed. Friend code is optional — you get entered in our monthly merch raffle if you have one."
                      : setupSubStep === 2
                        ? "Quick read + one tap to agree. You can review it anytime from Settings."
                        : "A quick review before we take you into the app."}
                </Text>
                {setupSubStep === 0 ? (
                  <View style={styles.captureOptionalAccountNote}>
                    <Text style={styles.captureOptionalAccountNoteTitle}>Account setup is optional</Text>
                    <Text style={styles.captureOptionalAccountNoteText}>
                      Recommended for syncing your saves/follows across devices. You can skip now and create one later in Settings → Account.
                    </Text>
                  </View>
                ) : null}
                {/* Step 0: Name, How heard, Email + opt-in (email last). */}
                {setupSubStep === 0 ? (
                  <>
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

                    {/* Email + explicit opt-in, positioned last in this step
                        so the user sees name/source first and only lands on
                        the email field at the bottom of the screen. */}
                    <View style={styles.captureFieldGroup}>
                      <Text style={[styles.captureLabel, isNeo && styles.welcomeInfoStepTextNeo, isEmerald && styles.welcomeInfoStepTextEmerald]}>
                        Email (optional)
                      </Text>
                      <TextInput
                        style={[styles.captureInput, isNeo && styles.captureInputNeo, isEmerald && styles.captureInputEmerald]}
                        value={personalization.email}
                        onChangeText={(value) => setPersonalization((prev) => ({ ...prev, email: value }))}
                        placeholder="you@example.com"
                        placeholderTextColor={isNeo ? "#6b6b6b" : isEmerald ? "#4f7a5d" : "#ffdfc9"}
                        autoCapitalize="none"
                        autoCorrect={false}
                        keyboardType="email-address"
                        textContentType="emailAddress"
                      />
                      <Pressable {...PRESSABLE_INSTANT}
                        style={({ pressed }) => [
                          styles.captureEmailOptInRow,
                          personalization.emailOptIn && styles.captureEmailOptInRowActive,
                          pressed && styles.captureChoicePillPressed,
                        ]}
                        onPress={() => {
                          hapticTap("selection");
                          if (!personalization.email?.trim() && !personalization.emailOptIn) {
                            setOnboardingError("Add your email first, then opt in.");
                            return;
                          }
                          setPersonalization((prev) => ({ ...prev, emailOptIn: !prev.emailOptIn }));
                        }}
                      >
                        <View
                          style={[
                            styles.captureEmailOptInBox,
                            personalization.emailOptIn && styles.captureEmailOptInBoxActive,
                          ]}
                        >
                          {personalization.emailOptIn ? (
                            <Text style={styles.captureEmailOptInCheck}>✓</Text>
                          ) : null}
                        </View>
                        <View style={{ flex: 1 }}>
                          <Text style={[styles.captureEmailOptInLabel, isNeo && { color: "#1b1b1b" }, isEmerald && { color: "#1f3d29" }]}>
                            Email me Masjid.ly updates
                          </Text>
                          <Text style={[styles.captureEmailOptInSub, isNeo && { color: "#4c4c4c" }, isEmerald && { color: "#3b6349" }]}>
                            Big announcements, merch raffle winners, new features.
                            No spam — max ~1 email/month. You can opt out any time.
                          </Text>
                        </View>
                      </Pressable>
                    </View>
                  </>
                ) : null}

                {/* Step 1: Gender, What events, Friend code. */}
                {setupSubStep === 1 ? (
                  <>
                    <View style={styles.captureFieldGroup}>
                      <Text style={[styles.captureLabel, isNeo && styles.welcomeInfoStepTextNeo, isEmerald && styles.welcomeInfoStepTextEmerald]}>Gender (is not a political question)</Text>
                      <View style={styles.captureChoiceRow}>
                        {[
                          ["brother", "Brother"],
                          ["sister", "Sister"],
                          ["prefer_not_to_say", "Prefer not to say"],
                        ].map(([id, label]) => {
                          const active = personalization.gender === id;
                          return (
                            <Pressable {...PRESSABLE_INSTANT}
                              key={`gender-welcome-${id}`}
                              unstable_pressDelay={0}
                              onPress={() => {
                                hapticTap("selection");
                                setPersonalization((prev) => ({ ...prev, gender: id as PersonalizationPrefs["gender"] }));
                              }}
                              style={({ pressed }) => [
                                styles.captureChoicePill,
                                styles.captureChoicePillOnWelcome,
                                isNeo && styles.captureChoicePillNeo,
                                isEmerald && styles.captureChoicePillEmerald,
                                active && styles.captureChoicePillActive,
                                active && styles.captureChoicePillActiveOnWelcome,
                                pressed && styles.captureChoicePillPressed,
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
                          const active = setupInterests.includes(interest);
                          return (
                            <Pressable {...PRESSABLE_INSTANT}
                              key={`interest-welcome-${interest}`}
                              unstable_pressDelay={0}
                              onPress={() => {
                                hapticTap("selection");
                                toggleInterest(interest);
                              }}
                              style={({ pressed }) => [
                                styles.captureChoicePill,
                                styles.captureChoicePillOnWelcome,
                                isNeo && styles.captureChoicePillNeo,
                                isEmerald && styles.captureChoicePillEmerald,
                                active && styles.captureChoicePillActive,
                                active && styles.captureChoicePillActiveOnWelcome,
                                pressed && styles.captureChoicePillPressed,
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

                    {/* Referral / share code — optional, entered on its own
                        step so the raffle nudge has room to breathe. */}
                    <View style={styles.captureFieldGroup}>
                      <Text style={[styles.captureLabel, isNeo && styles.welcomeInfoStepTextNeo, isEmerald && styles.welcomeInfoStepTextEmerald]}>
                        Got a friend's share code? (optional)
                      </Text>
                      <TextInput
                        style={[styles.captureInput, isNeo && styles.captureInputNeo, isEmerald && styles.captureInputEmerald]}
                        value={referralInput}
                        onChangeText={(value) => {
                          setReferralInput(value.toUpperCase());
                          if (referralSavingState !== "idle") setReferralSavingState("idle");
                          if (referralSaveError) setReferralSaveError("");
                        }}
                        autoCapitalize="characters"
                        autoCorrect={false}
                        placeholder="M-AB12C"
                        placeholderTextColor={isNeo ? "#6b6b6b" : isEmerald ? "#4f7a5d" : "#ffdfc9"}
                      />
                      <Text style={[styles.captureHelper, isNeo && styles.welcomeInfoStepTextNeo, isEmerald && styles.welcomeInfoStepTextEmerald]}>
                        When friends sign up with your code, you're both entered
                        in our monthly Masjid.ly merch raffle. You'll get your own
                        code in Settings → Share Masjid.ly after setup.
                      </Text>
                      {referralSaveError ? (
                        <Text style={styles.captureErrorText}>{referralSaveError}</Text>
                      ) : null}
                    </View>
                  </>
                ) : null}

                {/* Step 2: Privacy consent. */}
                {setupSubStep === 2 ? renderPrivacyPolicyConsent({ welcomeHero: true }) : null}

                {/* Step 3: Final review / confirm. */}
                {setupSubStep === 3 ? (
                  <View style={styles.captureReviewCard}>
                    <Text style={[styles.captureReviewRow, isNeo && { color: "#1b1b1b" }, isEmerald && { color: "#1f3d29" }]}>
                      <Text style={styles.captureReviewKey}>Name: </Text>
                      <Text>{normalizeText(personalization.name) || "—"}</Text>
                    </Text>
                    <Text style={[styles.captureReviewRow, isNeo && { color: "#1b1b1b" }, isEmerald && { color: "#1f3d29" }]}>
                      <Text style={styles.captureReviewKey}>Heard about us: </Text>
                      <Text>{normalizeText(personalization.heardFrom) || "—"}</Text>
                    </Text>
                    <Text style={[styles.captureReviewRow, isNeo && { color: "#1b1b1b" }, isEmerald && { color: "#1f3d29" }]}>
                      <Text style={styles.captureReviewKey}>Email: </Text>
                      <Text>
                        {(personalization.email || "").trim() || "not provided"}
                        {personalization.email && personalization.emailOptIn ? " · updates on" : ""}
                      </Text>
                    </Text>
                    <Text style={[styles.captureReviewRow, isNeo && { color: "#1b1b1b" }, isEmerald && { color: "#1f3d29" }]}>
                      <Text style={styles.captureReviewKey}>Gender: </Text>
                      <Text>
                        {personalization.gender === "brother"
                          ? "Brother"
                          : personalization.gender === "sister"
                            ? "Sister"
                            : personalization.gender === "prefer_not_to_say"
                              ? "Prefer not to say"
                              : "—"}
                      </Text>
                    </Text>
                    <Text style={[styles.captureReviewRow, isNeo && { color: "#1b1b1b" }, isEmerald && { color: "#1f3d29" }]}>
                      <Text style={styles.captureReviewKey}>Interests: </Text>
                      <Text>
                        {setupInterests.length
                          ? setupInterests.join(", ")
                          : "none yet (add them later)"}
                      </Text>
                    </Text>
                    {(referralInput || "").trim() ? (
                      <Text style={[styles.captureReviewRow, isNeo && { color: "#1b1b1b" }, isEmerald && { color: "#1f3d29" }]}>
                        <Text style={styles.captureReviewKey}>Friend code: </Text>
                        <Text>{referralInput.trim()}</Text>
                      </Text>
                    ) : null}
                    <Text style={[styles.captureReviewRow, isNeo && { color: "#1b1b1b" }, isEmerald && { color: "#1f3d29" }]}>
                      <Text style={styles.captureReviewKey}>Privacy Policy: </Text>
                      <Text>
                        {personalization.privacy_policy_accepted_version === PRIVACY_POLICY_VERSION
                          ? "Accepted"
                          : "Not yet accepted (go back one step)"}
                      </Text>
                    </Text>
                  </View>
                ) : null}
                {onboardingError ? <Text style={styles.captureErrorText}>{onboardingError}</Text> : null}

                <View style={styles.setupSubStepBtnRow}>
                  <Pressable
                    unstable_pressDelay={0}
                    style={[
                      styles.welcomePrimaryBtn,
                      styles.welcomePrimaryBtnOnHero,
                      styles.setupSubStepSkipBtn,
                    ]}
                    onPress={confirmSkipAccountSetup}
                  >
                    <Text
                      style={[styles.welcomePrimaryBtnText, styles.setupSubStepSkipBtnText]}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.82}
                    >
                      Skip for now
                    </Text>
                  </Pressable>
                  {setupSubStep > 0 ? (
                    <Pressable
                      unstable_pressDelay={0}
                      style={[
                        styles.welcomePrimaryBtn,
                        styles.welcomePrimaryBtnOnHero,
                        styles.setupSubStepBackBtn,
                      ]}
                      onPress={() => {
                        hapticTap("selection");
                        setOnboardingError("");
                        setupStepDirRef.current = -1;
                        setSetupSubStep((s) => (Math.max(0, s - 1) as 0 | 1 | 2 | 3));
                      }}
                    >
                      <Text
                        style={[styles.welcomePrimaryBtnText, styles.setupSubStepBackBtnText]}
                        numberOfLines={1}
                        adjustsFontSizeToFit
                        minimumFontScale={0.82}
                      >
                        Back
                      </Text>
                    </Pressable>
                  ) : null}
                  <Pressable
                    unstable_pressDelay={0}
                    style={[
                      styles.welcomePrimaryBtn,
                      styles.welcomePrimaryBtnOnHero,
                      styles.welcomePrimaryBtnWhite,
                      styles.setupSubStepNextBtn,
                      isEmerald && styles.welcomePrimaryBtnEmerald,
                      isMidnight && styles.welcomePrimaryBtnMidnight,
                      isNeo && styles.welcomePrimaryBtnNeo,
                      isVitaria && styles.welcomePrimaryBtnVitaria,
                      isInferno && styles.welcomePrimaryBtnInferno,
                    ]}
                    onPress={() => {
                      if (finishSetupInFlightRef.current) return;
                      setOnboardingError("");
                      // Per-step gating so users can't skip past required
                      // fields. Validation mirrors saveOnboarding() but
                      // only for what this step covers.
                      if (setupSubStep === 0) {
                        if (!normalizeText(personalization.name)) {
                          setOnboardingError("Please enter your name.");
                          return;
                        }
                        if (!normalizeText(personalization.heardFrom)) {
                          setOnboardingError("Please share how you heard about Masjid.ly.");
                          return;
                        }
                        const cleanedEmail = (personalization.email || "").trim();
                        if (cleanedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanedEmail)) {
                          setOnboardingError("That email doesn't look right. Double-check or leave it blank.");
                          return;
                        }
                        hapticTap("selection");
                        setupStepDirRef.current = 1;
                        setSetupSubStep(1);
                        return;
                      }
                      if (setupSubStep === 1) {
                        if (!personalization.gender) {
                          setOnboardingError("Please pick a gender option (or Prefer not to say).");
                          return;
                        }
                        hapticTap("selection");
                        setupStepDirRef.current = 1;
                        setSetupSubStep(2);
                        return;
                      }
                      if (setupSubStep === 2) {
                        if (personalization.privacy_policy_accepted_version !== PRIVACY_POLICY_VERSION) {
                          setOnboardingError("Please read and agree to the Privacy Policy to continue.");
                          return;
                        }
                        hapticTap("selection");
                        setupStepDirRef.current = 1;
                        setSetupSubStep(3);
                        return;
                      }
                      // Step 3: finish for real.
                      hapticTap("selection");
                      void saveOnboarding();
                    }}
                  >
                    <Text
                      style={[styles.welcomePrimaryBtnText, styles.welcomePrimaryBtnTextMinera, styles.welcomePrimaryBtnTextWhite, isEmerald && styles.welcomePrimaryBtnTextEmerald, isNeo && styles.welcomePrimaryBtnTextNeo, isInferno && styles.welcomePrimaryBtnTextInferno]}
                      numberOfLines={1}
                      adjustsFontSizeToFit
                      minimumFontScale={0.8}
                    >
                      {setupSubStep === 3 ? "Finish Setup" : "Next"}
                    </Text>
                  </Pressable>
                </View>
                </Animated.View>
              </Animated.View>
              </ScrollView>
              </KeyboardAvoidingView>
            </View>
          </Animated.ScrollView>

          <View style={styles.welcomePagerDots}>
            {welcomeSlideIndex === 2
              ? [0, 1, 2, 3].map((dot) => (
                  <View
                    key={`setup-dot-${dot}`}
                    style={[styles.welcomePagerDot, setupSubStep === dot && styles.welcomePagerDotActive]}
                  />
                ))
              : [0, 1, 2].map((dot) => (
                  <View
                    key={`welcome-dot-${dot}`}
                    style={[styles.welcomePagerDot, welcomeSlideIndex === dot && styles.welcomePagerDotActive]}
                  />
                ))}
          </View>
        </View>
      </SafeAreaView>
    );
  };

  const renderProfileCaptureScreen = () => (
    <SafeAreaView style={[styles.welcomeContainer, isMidnight && styles.containerMidnight, isNeo && styles.containerNeo, isVitaria && styles.containerVitaria, isInferno && styles.containerInferno, isEmerald && styles.containerEmerald]}>
      <ScrollView
        contentContainerStyle={[styles.welcomeBody, styles.captureBody, isMidnight && styles.scrollBodyMidnight, isNeo && styles.scrollBodyNeo, isVitaria && styles.scrollBodyVitaria, isInferno && styles.scrollBodyInferno, isEmerald && styles.scrollBodyEmerald]}
        keyboardShouldPersistTaps="always"
        {...IOS_SCROLL_INSTANT_TOUCH}
      >
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
            pointerEvents="none"
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
            pointerEvents="none"
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
          <Pressable {...PRESSABLE_INSTANT}
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
            This isn't a dating app — we just want to personalize your experience.
            Nothing's sold to anyone; I (the person who made this app) can't afford a lawsuit anyway.
          </Text>
          <View style={styles.captureOptionalAccountNote}>
            <Text style={styles.captureOptionalAccountNoteTitle}>Account setup is optional</Text>
            <Text style={styles.captureOptionalAccountNoteText}>
              Recommended for syncing your saves/follows across devices. You can skip now and create one later in Settings → Account.
            </Text>
          </View>
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
            <Text style={[styles.captureLabel, isNeo && styles.welcomeInfoStepTextNeo, isEmerald && styles.welcomeInfoStepTextEmerald]}>Gender (is not a political question)</Text>
            <View style={styles.captureChoiceRow}>
              {[
                ["brother", "Brother"],
                ["sister", "Sister"],
                ["prefer_not_to_say", "Prefer not to say"],
              ].map(([id, label]) => {
                const active = personalization.gender === id;
                return (
                  <Pressable {...PRESSABLE_INSTANT}
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

          {renderPrivacyPolicyConsent({ welcomeHero: true })}

          {onboardingError ? <Text style={styles.captureErrorText}>{onboardingError}</Text> : null}

          <View style={styles.setupSubStepBtnRow}>
            <Pressable
              unstable_pressDelay={0}
              style={[
                styles.welcomePrimaryBtn,
                styles.welcomePrimaryBtnOnHero,
                styles.setupSubStepSkipBtn,
              ]}
              onPress={confirmSkipAccountSetup}
            >
              <Text
                style={[styles.welcomePrimaryBtnText, styles.setupSubStepSkipBtnText]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.82}
              >
                Skip for now
              </Text>
            </Pressable>
            <Pressable {...PRESSABLE_INSTANT}
              style={[
                styles.welcomePrimaryBtn,
                styles.welcomePrimaryBtnOnHero,
                isEmerald && styles.welcomePrimaryBtnEmerald,
                isMidnight && styles.welcomePrimaryBtnMidnight,
                isNeo && styles.welcomePrimaryBtnNeo,
                isVitaria && styles.welcomePrimaryBtnVitaria,
                isInferno && styles.welcomePrimaryBtnInferno,
              ]}
              onPress={() => {
                hapticTap("selection");
                void saveOnboarding();
              }}
            >
              <Text
                style={[styles.welcomePrimaryBtnText, styles.welcomePrimaryBtnTextMinera, isEmerald && styles.welcomePrimaryBtnTextEmerald, isNeo && styles.welcomePrimaryBtnTextNeo, isInferno && styles.welcomePrimaryBtnTextInferno]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.8}
              >
                Finish Setup
              </Text>
            </Pressable>
          </View>
        </Animated.View>
      </ScrollView>
    </SafeAreaView>
  );

  const renderLaunchScreen = () => (
    <SafeAreaView style={[styles.welcomeContainer, isMidnight && styles.containerMidnight, isNeo && styles.containerNeo, isVitaria && styles.containerVitaria, isInferno && styles.containerInferno, isEmerald && styles.containerEmerald]}>
      <Animated.View style={[styles.launchWrap, { opacity: launchExitOpacity }]}>
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
            styles.launchSimpleHero,
            {
              opacity: launchOpacity,
              transform: [{ translateY: launchTranslateY }, { scale: launchScale }],
            },
          ]}
        >
          <View
            style={[
              styles.launchSimpleLogoWrap,
              isNeo && styles.launchSimpleLogoWrapNeo,
              isEmerald && styles.launchSimpleLogoWrapEmerald,
              isMidnight && styles.launchSimpleLogoWrapMidnight,
              isVitaria && styles.launchSimpleLogoWrapVitaria,
              isInferno && styles.launchSimpleLogoWrapInferno,
            ]}
          >
            <Image source={WELCOME_LOGO} style={styles.launchSimpleLogo} resizeMode="contain" />
          </View>
          <View style={styles.launchSimpleTextBlock}>
            <Text
              style={[
                styles.launchSimpleTitle,
                isNeo && styles.launchTitleNeo,
                isEmerald && styles.launchTitleEmerald,
                isMidnight && styles.launchTitleDark,
                isVitaria && styles.launchTitleVitaria,
                isInferno && styles.launchTitleInferno,
              ]}
            >
              Welcome to Masjidly
            </Text>
            <Text
              style={[
                styles.launchSimpleSub,
                isNeo && styles.launchSubNeo,
                isEmerald && styles.launchSubEmerald,
                isMidnight && styles.launchSubDark,
                isVitaria && styles.launchSubVitaria,
                isInferno && styles.launchSubInferno,
              ]}
            >
              {loading && events.length === 0 ? "Loading your feed…" : "Getting your home feed ready…"}
            </Text>
          </View>
        </Animated.View>
        <Animated.View
          style={[
            styles.launchDotsRow,
            { opacity: launchOpacity },
          ]}
        >
          {[0, 1, 2].map((i) => {
            // Stagger each dot by 1/3 of a cycle so they "bounce" in sequence.
            const phaseShift = i / 3;
            const dotOpacity = launchDotPulse.interpolate({
              inputRange: [0, 0.5, 1],
              outputRange: [0.35, 1, 0.35],
            });
            const dotScale = launchDotPulse.interpolate({
              inputRange: [0, 0.5, 1],
              outputRange: [0.85, 1.15, 0.85],
            });
            const dotTranslate = launchDotPulse.interpolate({
              inputRange: [0, 0.5, 1],
              outputRange: [0, -4 - phaseShift * 3, 0],
            });
            return (
              <Animated.View
                key={`launch-dot-${i}`}
                style={[
                  styles.launchDot,
                  isMidnight && styles.launchDotDark,
                  {
                    opacity: dotOpacity,
                    transform: [{ scale: dotScale }, { translateY: dotTranslate }],
                  },
                ]}
              />
            );
          })}
        </Animated.View>
      </Animated.View>
    </SafeAreaView>
  );

  const renderOnboardingScreen = () => (
    <SafeAreaView style={[styles.welcomeContainer, isMidnight && styles.containerMidnight, isNeo && styles.containerNeo, isVitaria && styles.containerVitaria, isInferno && styles.containerInferno, isEmerald && styles.containerEmerald]}>
      <ScrollView contentContainerStyle={[styles.welcomeBody, isMidnight && styles.scrollBodyMidnight, isNeo && styles.scrollBodyNeo, isVitaria && styles.scrollBodyVitaria, isInferno && styles.scrollBodyInferno, isEmerald && styles.scrollBodyEmerald]}>
        <View style={[styles.tutorialCard, isMidnight && styles.controlsCardMidnight, isNeo && styles.controlsCardNeo, isVitaria && styles.controlsCardVitaria, isInferno && styles.controlsCardInferno, isEmerald && styles.controlsCardEmerald]}>
          <Text style={[styles.tutorialTitle, isMidnight && styles.sectionTitleMidnight, isNeo && styles.sectionTitleNeo, isVitaria && styles.sectionTitleVitaria, isInferno && styles.sectionTitleInferno, isEmerald && styles.sectionTitleEmerald]}>
            Personalize Masjid.ly
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
                <Pressable {...PRESSABLE_INSTANT}
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
          <Pressable {...PRESSABLE_INSTANT}
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
              <Pressable {...PRESSABLE_INSTANT}
                  key={src}
                  onPress={() => toggleSource(src)}
                style={[styles.sourceChip, active && styles.sourceChipActive]}
              >
                  <Text style={[styles.sourceChipText, active && styles.sourceChipTextActive]}>{formatSourceLabel(src)}</Text>
              </Pressable>
            );
          })}
        </ScrollView>
          {renderPrivacyPolicyConsent({})}
          <Pressable {...PRESSABLE_INSTANT} style={styles.primaryBtn} onPress={saveOnboarding}>
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
    const homeFeedEvents = orderedVisibleEvents.filter((e) => !isJumuahEvent(e));
    const todayEvents = homeFeedEvents.filter(
      (e) => (e.date || "") === today && !isEventPastNow(e),
    );
    // Home should read like a timeline: same filters as Explore, but always
    // chronological. The global `sortMode` (relevant/nearest) would otherwise
    // surface a few "top" picks and silently skip everything in between.
    const todayEventsChrono = [...todayEvents].sort((a, b) =>
      (a.start_time || "99:99").localeCompare(b.start_time || "99:99"),
    );
    const liveNowEvents = homeFeedEvents.filter((e) => isEventLiveNow(e)).slice(0, 5);
    const thisWeekEvents = homeFeedEvents
      .filter((e) => (e.date || "") > today && (e.date || "") <= plusDaysIso(7))
      .sort((a, b) =>
        `${a.date || ""} ${a.start_time || "99:99"}`.localeCompare(`${b.date || ""} ${b.start_time || "99:99"}`),
      )
      .slice(0, 40);
    const nearYouEvents = reference
      ? [...homeFeedEvents]
          .filter((e) => typeof e.distance_miles === "number" && e.date >= today)
          .sort((a, b) => Number(a.distance_miles ?? 9999) - Number(b.distance_miles ?? 9999))
          .slice(0, 3)
      : [];
    // Closest masjid to the user's saved home location (if any), with their
    // next few upcoming events. Lets the user answer "what's happening at *my*
    // masjid?" without opening the map.
    const homeLatRaw = Number(profileDraft.home_lat);
    const homeLonRaw = Number(profileDraft.home_lon);
    const hasHomeCoords =
      Number.isFinite(homeLatRaw) && Number.isFinite(homeLonRaw) && (homeLatRaw !== 0 || homeLonRaw !== 0);
    let nearestMasjidKey = "";
    let nearestMasjidMiles: number | null = null;
    if (hasHomeCoords) {
      let bestMi = Infinity;
      for (const [key, coord] of Object.entries(MASJID_COORDS)) {
        const mi = haversineMiles(homeLatRaw, homeLonRaw, coord.latitude, coord.longitude);
        if (mi < bestMi) {
          bestMi = mi;
          nearestMasjidKey = key;
        }
      }
      if (Number.isFinite(bestMi)) nearestMasjidMiles = bestMi;
    }
    const nearestMasjidEvents = nearestMasjidKey
      ? homeFeedEvents
          .filter(
            (e) =>
              normalizeText(e.source).toLowerCase() === nearestMasjidKey.toLowerCase() &&
              (e.date || "") >= today &&
              !isEventPastNow(e),
          )
          .slice(0, 3)
      : [];
    const followedWithNext: Array<{ source: string; next: EventItem | null }> = followedMasjids.map((src) => ({
      source: src,
      next:
        homeFeedEvents.find((e) => normalizeText(e.source).toLowerCase() === src.toLowerCase() && (e.date || "") >= today) || null,
    }));
    // "First upcoming" must be min(date >= today), NOT orderedVisibleEvents[0]
    // (which is sorted by the user's chosen sortMode, so it can lead with a
    // relevance-boosted event that isn't actually the soonest).
    const soonestUpcoming = homeFeedEvents
      .filter((e) => (e.date || "") >= today && !isEventPastNow(e))
      .reduce<EventItem | null>((acc, cur) => {
        const candidate = `${cur.date || ""} ${cur.start_time || "99:99"}`;
        const incumbent = acc ? `${acc.date || ""} ${acc.start_time || "99:99"}` : "";
        if (!acc || candidate.localeCompare(incumbent) < 0) return cur;
        return acc;
      }, null);
    const nextDate = soonestUpcoming?.date ? new Date(`${soonestUpcoming.date}T00:00:00`) : null;
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
    const quickActions: Array<{ label: string; mi: MiName; action: () => void }> = [
      { label: "Browse", mi: "explore", action: () => switchTab("explore") },
      { label: "Calendar", mi: "calendar_today", action: () => switchTab("calendar") },
      { label: "Your Feed", mi: "auto_awesome", action: () => switchTab("feed") },
      { label: "Refresh", mi: "refresh", action: () => loadEvents({ force: true }) },
    ];

    const renderMiniEventRow = (e: EventItem, keyHint: string) => {
      const key = eventStorageKey(e);
      const rsvpState = rsvpStatuses[key];
      const saved = isSavedEvent(e);
      const poster = eventPosterUrl(e);
      const temporal = getEventTemporalState(e);
      const displayTitle = eventDisplayTitle(e);
    return (
        <Pressable
          {...PRESSABLE_INSTANT}
          key={`home-row-${keyHint}`}
          style={[styles.homeEventRow, isDarkTheme && styles.homeEventRowDark]}
          onPress={() => openEventDetails(e)}
        >
          {poster && canRenderPoster(poster) ? (
            <LoadableNetworkImage uri={poster} style={styles.homeEventRowPoster} onError={() => markPosterFailed(poster)} />
          ) : (
            <View style={[styles.homeEventRowPoster, { alignItems: "center", justifyContent: "center" }]}>
              <Mi name="mosque" size={26} color="#a3b0c8" />
            </View>
          )}
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap" }}>
              {temporal.isPast ? (
                <View style={styles.eventPastBadge}>
                  <Text style={styles.eventPastText}>ALREADY HAPPENED</Text>
                </View>
              ) : null}
              {temporal.isLive ? (
                <View style={styles.liveNowBadge}>
                  <View style={styles.liveNowDot} />
                  <Text style={styles.liveNowText}>LIVE NOW</Text>
                </View>
              ) : null}
              {!temporal.isLive && !temporal.isPast && temporal.startsInMinutes != null ? (
                <View style={styles.eventStartsSoonBadge}>
                  <Text style={styles.eventStartsSoonText}>
                    {temporal.startsInMinutes <= 1 ? "STARTS IN 1M" : `STARTS IN ${temporal.startsInMinutes}M`}
                  </Text>
                </View>
              ) : null}
              <Text style={[styles.homeEventRowWhen, isDarkTheme && { color: "#c4cee8" }]}>
                {formatHumanDate(e.date)} · {eventTime(e)}
              </Text>
            </View>
            <Text style={[styles.homeEventRowTitle, isDarkTheme && { color: "#f4f7ff" }]} numberOfLines={2}>
              {displayTitle}
            </Text>
            <Text style={[styles.homeEventRowMeta, isDarkTheme && { color: "#a6b4d4" }]} numberOfLines={1}>
              {formatSourceLabel(e.source)}
              {typeof e.distance_miles === "number" ? ` · ${e.distance_miles.toFixed(1)} mi` : ""}
            </Text>
            <View style={styles.cardActionRow}>
              <Pressable
                {...PRESSABLE_INSTANT}
                hitSlop={6}
                style={[styles.cardActionChip, rsvpState === "going" && styles.cardActionChipActive]}
                onPress={(ev) => { ev.stopPropagation?.(); toggleRsvp(e, "going"); }}
              >
                <Text style={[styles.cardActionChipText, rsvpState === "going" && styles.cardActionChipTextActive]}>
                  {rsvpState === "going" ? "Going ✓" : "Going"}
                </Text>
              </Pressable>
              <Pressable
                {...PRESSABLE_INSTANT}
                hitSlop={6}
                style={[styles.cardActionChip, rsvpState === "interested" && styles.cardActionChipActive]}
                onPress={(ev) => { ev.stopPropagation?.(); toggleRsvp(e, "interested"); }}
              >
                <Text style={[styles.cardActionChipText, rsvpState === "interested" && styles.cardActionChipTextActive]}>
                  {rsvpState === "interested" ? "Interested ✓" : "Interested"}
                </Text>
              </Pressable>
              <Pressable
                {...PRESSABLE_INSTANT}
                hitSlop={6}
                style={({ pressed }) => [
                  styles.cardActionChip,
                  saved && styles.cardActionChipActive,
                  pressed && styles.cardActionChipPressed,
                ]}
                onPress={(ev) => { ev.stopPropagation?.(); toggleSavedEvent(e); }}
              >
                <Mi
                  name={saved ? "favorite_fill1" : "favorite"}
                  size={14}
                  color={saved ? "#fff" : "#2e4f82"}
                />
              </Pressable>
              <Pressable
                {...PRESSABLE_INSTANT}
                hitSlop={6}
                style={({ pressed }) => [
                  styles.cardActionChip,
                  pressed && styles.cardActionChipPressed,
                ]}
                onPress={(ev) => { ev.stopPropagation?.(); shareEvent(e); }}
              >
                <Mi name="open_in_new" size={14} color="#2e4f82" />
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
        {...IOS_SCROLL_INSTANT_TOUCH}
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
                  {
                    scale: Animated.add(
                      homeHeroGlowDrift.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1.14] }),
                      heroRefreshPulse.interpolate({ inputRange: [0, 1], outputRange: [0, 0.18] }),
                    ),
                  },
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
                  {
                    scale: Animated.add(
                      homeHeroGlowDrift.interpolate({ inputRange: [0, 1], outputRange: [1.08, 0.9] }),
                      heroRefreshPulse.interpolate({ inputRange: [0, 1], outputRange: [0, 0.22] }),
                    ),
                  },
                  { translateX: homeHeroGlowDrift.interpolate({ inputRange: [0, 1], outputRange: [30, -10] }) },
                  { translateY: homeHeroGlowDrift.interpolate({ inputRange: [0, 1], outputRange: [20, -16] }) },
                ],
              },
            ]}
          />
          <Text style={[styles.homeHeroHi, isNeo && { color: "#2e2e2e" }]}>Assalamu alaikum, {welcomeName}</Text>
          <Text style={[styles.homeHeroCount, isNeo && { color: "#151515" }]}>
            {futureVisibleCount} upcoming events
            </Text>
          <Text style={[styles.homeHeroSub, isNeo && { color: "#3f3f3f" }]}>
            {nextEventText} · {new Set(homeFeedEvents.map((e) => e.source)).size} masjids
          </Text>
          <Text style={[styles.homeHeroStatus, isNeo && { color: "#5a5a5a" }]}>
            {cacheWarmStatus === "ready" ? "Feed ready" : "Refreshing latest..."}
          </Text>
          <Pressable {...PRESSABLE_INSTANT} style={styles.homeHeroCta} onPress={() => switchTab("explore")}>
            <Text style={styles.homeHeroCtaText}>Plan your week  →</Text>
            </Pressable>
        </LinearGradient>

        <View style={styles.homeQuickRow}>
          {quickActions.map((a) => {
            const isRefreshAction = a.label === "Refresh";
            const emojiSpin = refreshSpin.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
            return (
              <Pressable
                {...PRESSABLE_INSTANT}
                key={`qa-${a.label}`}
                style={({ pressed }) => [
                  styles.homeQuickBtn,
                  isDarkTheme && styles.homeQuickBtnDark,
                  pressed && styles.cardActionChipPressed,
                ]}
                onPress={() => {
                  hapticTap("selection");
                  a.action();
                }}
              >
                {isRefreshAction ? (
                  <Animated.View style={{ transform: [{ rotate: emojiSpin }] }}>
                    <Mi name={a.mi} size={22} color={isDarkTheme ? "#f4f7ff" : "#273143"} />
                  </Animated.View>
                ) : (
                  <Mi name={a.mi} size={22} color={isDarkTheme ? "#f4f7ff" : "#273143"} />
                )}
                <Text style={[styles.homeQuickLabel, isDarkTheme && { color: "#f4f7ff" }]}>{a.label}</Text>
              </Pressable>
            );
          })}
        </View>

        {liveNowEvents.length ? (
          <View style={styles.homeSection}>
            <View style={styles.homeSectionHeader}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                <View style={styles.liveNowBadge}>
                  <View style={styles.liveNowDot} />
                  <Text style={styles.liveNowText}>LIVE</Text>
                </View>
                <Text style={[styles.homeSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>Right now</Text>
              </View>
              <Text style={[styles.homeSectionCount, isDarkTheme && { color: "#c4cee8" }]}>
                {liveNowEvents.length}
              </Text>
            </View>
            <Text style={[styles.homeSectionSub, isDarkTheme && { color: "#9db0db" }]}>
              Your seat's waiting — walk in, these just started.
            </Text>
            {liveNowEvents.map((e, idx) => renderMiniEventRow(e, `live-${idx}`))}
          </View>
        ) : null}

        <View style={styles.homeSection}>
          <View style={styles.homeSectionHeader}>
            <Text style={[styles.homeSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>Tonight</Text>
            <View style={styles.homeSectionHeaderRight}>
              {todayEvents.length ? (
                <Text style={[styles.homeSectionCount, isDarkTheme && { color: "#c4cee8" }]}>
                  {todayEvents.length}
          </Text>
              ) : null}
              <Pressable {...PRESSABLE_INSTANT} onPress={() => switchTab("explore")} hitSlop={8}>
                <Text style={[styles.homeSectionSeeAll, isDarkTheme && { color: "#9db0db" }]}>See all →</Text>
              </Pressable>
                </View>
            </View>
          {todayEvents.length ? (
            todayEventsChrono.slice(0, 20).map((e, idx) => renderMiniEventRow(e, `today-${idx}`))
          ) : (
            <View style={[styles.homeEmpty, isDarkTheme && styles.homeEmptyDark]}>
              <Text style={[styles.homeEmptyText, isDarkTheme && { color: "#c4cee8" }]}>
                Quiet evening near you. {nextEventText}.
              </Text>
              </View>
            )}
        </View>

        {thisWeekEvents.length ? (
          <View style={styles.homeSection}>
            <View style={styles.homeSectionHeader}>
              <Text style={[styles.homeSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>This week</Text>
              <Pressable {...PRESSABLE_INSTANT} onPress={() => switchTab("explore")} hitSlop={8}>
                <Text style={[styles.homeSectionSeeAll, isDarkTheme && { color: "#9db0db" }]}>See all</Text>
          </Pressable>
        </View>
            {thisWeekEvents.map((e, idx) => renderMiniEventRow(e, `week-${idx}`))}
        </View>
        ) : null}

        {nearestMasjidKey ? (
          <View style={styles.homeSection}>
            <View style={styles.homeSectionHeader}>
              <Text style={[styles.homeSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>
                Your closest masjid
              </Text>
              <Pressable {...PRESSABLE_INSTANT} onPress={() => switchTab("explore")} hitSlop={6}>
                <Text style={[styles.homeSectionCount, { color: "#ff7d50" }]}>See on map →</Text>
              </Pressable>
            </View>
            <Pressable
              {...PRESSABLE_INSTANT}
              style={[styles.nearestMasjidCard, isDarkTheme && styles.nearestMasjidCardDark]}
              onPress={() => setSelectedMasjidProfile(nearestMasjidKey)}
            >
              <View style={styles.nearestMasjidRow}>
                <Mi name="location_on" size={22} color={isDarkTheme ? "#ff9977" : "#ff7d50"} />

                <View style={{ flex: 1 }}>
                  <Text style={[styles.nearestMasjidName, isDarkTheme && { color: "#f4f7ff" }]} numberOfLines={1}>
                    {formatSourceLabel(nearestMasjidKey)}
                  </Text>
                  <Text style={[styles.nearestMasjidMeta, isDarkTheme && { color: "#a6b4d4" }]} numberOfLines={1}>
                    {nearestMasjidMiles != null ? `${nearestMasjidMiles.toFixed(1)} mi away` : "Near you"}
                    {nearestMasjidEvents.length > 0
                      ? ` · ${nearestMasjidEvents.length} upcoming`
                      : " · no upcoming events"}
                  </Text>
                </View>
              </View>
            </Pressable>
            {nearestMasjidEvents.map((e, idx) => renderMiniEventRow(e, `nearest-${idx}`))}
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
            <Pressable {...PRESSABLE_INSTANT}
                  key={`follow-${source}`}
                  style={[styles.homeFollowChip, isDarkTheme && styles.homeFollowChipDark]}
                  onPress={() => setSelectedMasjidProfile(source)}
                >
                  <Text style={[styles.homeFollowName, isDarkTheme && { color: "#f4f7ff" }]} numberOfLines={1}>
                    {formatSourceLabel(source)}
                  </Text>
                  <Text style={[styles.homeFollowNext, isDarkTheme && { color: "#c4cee8" }]} numberOfLines={1}>
                    {next ? `${formatHumanDate(next.date)} · ${eventDisplayTitle(next)}` : "No upcoming events"}
                </Text>
            </Pressable>
              ))}
          </ScrollView>
      </View>
        ) : null}

        <Pressable {...PRESSABLE_INSTANT}
          style={[styles.homeBrowseAllBtn, isDarkTheme && styles.homeBrowseAllBtnDark]}
          onPress={() => switchTab("explore")}
        >
          <Text style={[styles.homeBrowseAllTitle, isDarkTheme && { color: "#f4f7ff" }]}>
            Browse all {homeFeedEvents.length} upcoming event{homeFeedEvents.length === 1 ? "" : "s"}
          </Text>
          <Text style={[styles.homeBrowseAllSub, isDarkTheme && { color: "#c4cee8" }]}>
            Home lists today and the next 7 days in time order (up to 20 today / 40 this week). Explore has the full map & filters.
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
    const listPosterUri = eventPosterUrl(e);
    const displayTitle = eventDisplayTitle(e);
    const temporal = getEventTemporalState(e);
    const trustChips = getTrustPassChips(e, { debug: __DEV__ && tab === "feed" });
    const feedReason = tab === "feed" ? feedReasonByKey[key] || "" : "";
    return (
      <Pressable
        {...PRESSABLE_INSTANT}
        key={`event-card-${keyHint || key}`}
        style={styles.hospitalListCard}
        onPress={() => openEventDetails(e)}
      >
        {listPosterUri && canRenderPoster(listPosterUri) ? (
          <LoadableNetworkImage
            uri={listPosterUri}
            style={styles.hospitalListPoster}
            onError={() => markPosterFailed(listPosterUri)}
          />
        ) : (
          <View
            style={[
              styles.hospitalListPoster,
              { backgroundColor: masjidBrandColor(e.source), alignItems: "center", justifyContent: "center" },
            ]}
          >
            <Text style={{ color: "#fff", fontWeight: "900", fontSize: 18 }}>{masjidInitials(e.source)}</Text>
          </View>
        )}
        <View style={{ flex: 1 }}>
          <View style={styles.eventBadgeRow}>
            {temporal.isPast ? (
              <View style={styles.eventPastBadge}>
                <Text style={styles.eventPastText}>ALREADY HAPPENED</Text>
              </View>
            ) : null}
            {temporal.isLive ? (
              <View style={styles.liveNowBadge}>
                <View style={styles.liveNowDot} />
                <Text style={styles.liveNowText}>LIVE NOW</Text>
              </View>
            ) : null}
            {!temporal.isLive && !temporal.isPast && temporal.startsInMinutes != null ? (
              <View style={styles.eventStartsSoonBadge}>
                <Text style={styles.eventStartsSoonText}>
                  {temporal.startsInMinutes <= 1 ? "STARTS IN 1M" : `STARTS IN ${temporal.startsInMinutes}M`}
                </Text>
              </View>
            ) : null}
            <View style={[styles.freshnessPill, { backgroundColor: freshPalette.bg }]}>
              <View style={[styles.freshnessDot, { backgroundColor: freshPalette.dot }]} />
              <Text style={[styles.freshnessPillText, { color: freshPalette.text }]} numberOfLines={1}>
                {fresh.label}
              </Text>
            </View>
            {verified ? (
              <View style={[styles.freshnessPill, { backgroundColor: "rgba(48,168,96,0.14)", flexDirection: "row", alignItems: "center", gap: 4 }]}>
                <Mi name="check" size={12} color="#1f7a42" />
                <Text style={[styles.freshnessPillText, { color: "#1f7a42" }]}>Verified</Text>
              </View>
            ) : null}
            {flagged ? (
              <View style={[styles.freshnessPill, { backgroundColor: "rgba(214,99,46,0.16)", flexDirection: "row", alignItems: "center", gap: 4 }]}>
                <Mi name="warning" size={12} color="#9a4311" />
                <Text style={[styles.freshnessPillText, { color: "#9a4311" }]}>Flagged</Text>
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
            {displayTitle}
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
          {feedReason ? (
            <Text style={[styles.hospitalListMeta, { color: "#5b6d90", fontWeight: "700" }]} numberOfLines={1}>
              Why in your feed: {feedReason}
            </Text>
          ) : null}
          {trustChips.length ? (
            <Text style={[styles.hospitalListMeta, { color: "#6e5bb2" }]} numberOfLines={1}>
              Trust pass: {trustChips.join(" · ")}
            </Text>
          ) : null}
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
              {...PRESSABLE_INSTANT}
              hitSlop={6}
              style={({ pressed }) => [
                styles.cardActionChip,
                rsvpState === "going" && styles.cardActionChipActive,
                pressed && styles.cardActionChipPressed,
              ]}
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
              {...PRESSABLE_INSTANT}
              hitSlop={6}
              style={({ pressed }) => [
                styles.cardActionChip,
                rsvpState === "interested" && styles.cardActionChipActive,
                pressed && styles.cardActionChipPressed,
              ]}
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
              {...PRESSABLE_INSTANT}
              hitSlop={6}
              style={({ pressed }) => [
                styles.cardActionChip,
                saved && styles.cardActionChipActive,
                pressed && styles.cardActionChipPressed,
              ]}
              onPress={(ev) => {
                ev.stopPropagation?.();
                toggleSavedEvent(e);
              }}
            >
              <Mi
                name={saved ? "favorite_fill1" : "favorite"}
                size={14}
                color={saved ? "#fff" : "#2e4f82"}
              />
            </Pressable>
            <Pressable
              {...PRESSABLE_INSTANT}
              hitSlop={6}
              style={({ pressed }) => [
                styles.cardActionChip,
                pressed && styles.cardActionChipPressed,
              ]}
              onPress={(ev) => {
                ev.stopPropagation?.();
                shareEvent(e);
              }}
            >
              <Mi name="open_in_new" size={14} color="#2e4f82" />
                </Pressable>
            {tab === "feed" ? (
              <Pressable
                {...PRESSABLE_INSTANT}
                hitSlop={6}
                style={({ pressed }) => [
                  styles.cardActionChip,
                  pressed && styles.cardActionChipPressed,
                ]}
                onPress={(ev) => {
                  ev.stopPropagation?.();
                  muteSourceFromFeed(e.source);
                }}
              >
                <Text style={styles.cardActionChipText}>Not interested</Text>
              </Pressable>
            ) : null}
              </View>
            </View>
      </Pressable>
    );
  };

  const exploreMapHeight = Math.round(windowHeight * 0.55);

  const recenterMapOnMe = useCallback(() => {
    const lat = Number(profileDraft.home_lat);
    const lon = Number(profileDraft.home_lon);
    if (Number.isFinite(lat) && Number.isFinite(lon) && (lat !== 0 || lon !== 0)) {
      mapRef.current?.animateToRegion(
        { latitude: lat, longitude: lon, latitudeDelta: 0.2, longitudeDelta: 0.2 },
        450,
      );
      return;
    }
    // Fall back to requesting a fresh location; will update profileDraft and
    // center when it completes.
    requestLocationAndSave();
  }, [profileDraft.home_lat, profileDraft.home_lon]);

  const renderExploreHeroMap = () => {
    const homeLat = Number(profileDraft.home_lat);
    const homeLon = Number(profileDraft.home_lon);
    const hasHome =
      Number.isFinite(homeLat) && Number.isFinite(homeLon) && (homeLat !== 0 || homeLon !== 0);
    return (
      <View style={[styles.exploreMapHero, { height: exploreMapHeight }]}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFillObject}
        initialRegion={mapRegionRef.current}
        showsUserLocation
        showsMyLocationButton={false}
        onRegionChangeComplete={(r) => {
          mapRegionRef.current = r;
        }}
      >
        {hasHome ? (
          <Marker
            key="home-location"
            coordinate={{ latitude: homeLat, longitude: homeLon }}
            anchor={{ x: 0.5, y: 0.5 }}
            tracksViewChanges={false}
          >
            <View style={styles.mapHomePinWrap}>
              <View style={styles.mapHomePinOuter}>
                <View style={styles.mapHomePinInner} />
              </View>
              <View style={styles.mapHomePinLabelWrap}>
                <Text style={styles.mapHomePinLabel}>You</Text>
              </View>
            </View>
            <Callout>
              <View style={styles.mapCallout}>
                <Text style={styles.mapCalloutTitle}>Your location</Text>
                <Text style={styles.mapCalloutSub}>
                  Events within {radius || "35"} mi are prioritized here.
                </Text>
              </View>
            </Callout>
          </Marker>
        ) : null}
        {masjidPinsForExplore.map((pin) => (
          <Marker
            key={`masjid-${pin.sourceKey}`}
            coordinate={{ latitude: pin.latitude, longitude: pin.longitude }}
            onPress={() => setSelectedMasjidSheet(pin.sourceKey)}
            tracksViewChanges={false}
            anchor={{ x: 0.5, y: 1 }}
          >
            <View style={styles.mapMasjidPinWrap}>
              {pin.hasLive ? <View style={styles.mapMasjidLiveRing} pointerEvents="none" /> : null}
              {(() => {
                const logoUri = masjidLogoUrl(pin.sourceKey);
                const logoFailed = failedLogoSources.has((pin.sourceKey || "").toLowerCase());
                const hasLogo = !!logoUri && !logoFailed;
                const tint = pin.count === 0 ? "#6b778c" : masjidBrandColor(pin.sourceKey);
                return (
                  <View
                    style={[
                      styles.mapMasjidLogo,
                      { backgroundColor: hasLogo ? "#ffffff" : tint },
                      pin.hasLive && styles.mapMasjidLogoLive,
                    ]}
                  >
                    {hasLogo ? (
                      <Image
                        source={{ uri: logoUri! }}
                        style={styles.mapMasjidLogoImage}
                        resizeMode="contain"
                        onError={() => markLogoFailed(pin.sourceKey)}
                      />
                    ) : (
                      <Text style={styles.mapMasjidLogoText} numberOfLines={1}>
                        {masjidInitials(pin.sourceKey)}
                      </Text>
                    )}
                    {pin.count > 0 ? (
                      <View style={[styles.mapMasjidBadge, pin.hasLive && styles.mapMasjidBadgeLive]}>
                        <Text style={styles.mapMasjidBadgeText}>{pin.hasLive ? "LIVE" : pin.count > 99 ? "99+" : pin.count}</Text>
                      </View>
                    ) : null}
                  </View>
                );
              })()}
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
      <Pressable {...PRESSABLE_INSTANT}
        accessibilityRole="button"
        accessibilityLabel="Recenter map on my location"
        onPress={recenterMapOnMe}
        style={styles.mapRecenterBtn}
        hitSlop={10}
      >
        <Mi name="location_on" size={22} color="#273143" />
      </Pressable>
    </View>
    );
  };

  const renderExplore = () => {
    const visibleSections = exploreSections.slice(0, exploreSectionLimit);
    const hasMore = exploreSections.length > exploreSectionLimit;
    const header = (
      <>
        {renderExploreHeroMap()}

        {!profileDraft.home_lat && !profileDraft.home_lon && !locationBannerDismissed ? (
        <View style={[styles.locPromptCard, isDarkTheme && styles.locPromptCardDark]}>
          <View style={{ flex: 1 }}>
            <Text style={[styles.locPromptTitle, isDarkTheme && { color: "#f4f7ff" }]}>
              See masjids near you
            </Text>
            <Text style={[styles.locPromptSub, isDarkTheme && { color: "#b6bdd0" }]}>
              Share your location to see which masjids are closest and sort events by distance.
            </Text>
          </View>
          <View style={styles.locPromptBtnRow}>
            <Pressable {...PRESSABLE_INSTANT}
              style={styles.locPromptSecondaryBtn}
              onPress={() => setLocationBannerDismissed(true)}
              disabled={locationRequesting}
            >
              <Text style={styles.locPromptSecondaryBtnText}>Not now</Text>
            </Pressable>
            <Pressable {...PRESSABLE_INSTANT}
              style={styles.locPromptPrimaryBtn}
              onPress={requestLocationAndSave}
              disabled={locationRequesting}
            >
              <Text style={styles.locPromptPrimaryBtnText}>
                {locationRequesting ? "Locating…" : "Use my location"}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}

      <View style={[styles.exploreFilterBar, isDarkTheme && styles.exploreFilterBarDark, isNeo && styles.exploreFilterBarNeo]}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.exploreAudienceStrip}
          {...IOS_SCROLL_INSTANT_TOUCH}
        >
          {[
            ["all", "All"],
            ["brothers", "Brothers"],
            ["sisters", "Sisters"],
            ["family", "Family"],
          ].map(([id, label]) => {
            const active = audienceFilter === id;
            return (
              <Pressable
                {...PRESSABLE_INSTANT}
                key={`explore-aud-${id}`}
                onPress={() => setAudienceFilter(id as typeof audienceFilter)}
                style={audienceChipStyle(id, active)}
              >
                <Text style={audienceChipTextStyle(id, active)}>{label}</Text>
              </Pressable>
            );
          })}
          <Pressable
            {...PRESSABLE_INSTANT}
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
        {...IOS_SCROLL_INSTANT_TOUCH}
      >
        <Pressable
          {...PRESSABLE_INSTANT}
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
        {availableTopicChips.map((t) => (
          <Pressable
            {...PRESSABLE_INSTANT}
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
            {...IOS_SCROLL_INSTANT_TOUCH}
          >
            {eventSeries.slice(0, 12).map((s) => (
              <Pressable
                {...PRESSABLE_INSTANT}
                key={`series-${s.series_id}`}
                style={styles.seriesCard}
                onPress={() => {
                  setSelectedMasjidSheet(s.source);
                }}
              >
                {s.image_url && canRenderPoster(s.image_url) ? (
                  <LoadableNetworkImage
                    uri={s.image_url}
                    style={styles.seriesPoster}
                    onError={() => markPosterFailed(s.image_url || "")}
                  />
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

      </>
    );

    const emptyNode = (
      <View style={styles.exploreEmpty}>
        <Text style={[styles.exploreEmptyTitle, isDarkTheme && { color: "#f4f7ff" }]}>Nothing tonight — that's okay.</Text>
        <Text style={[styles.exploreEmptySub, isDarkTheme && { color: "#c4cee8" }]}>
          Reset the filters and we'll show you every halaqah, talk, and class within reach.
        </Text>
        <Pressable {...PRESSABLE_INSTANT}
          onPress={() => {
            setQuery("");
            setReference("");
            setRadius("35");
            setStartDate(todayIso());
            setEndDate(plusDaysIso(365));
            setAudienceFilter("all");
            setQuickFilters([]);
            setHalaqaFilter(null);
          }}
          style={styles.exploreEmptyBtn}
        >
          <Text style={styles.exploreEmptyBtnText}>Reset filters</Text>
        </Pressable>
      </View>
    );

    const footerNode = hasMore ? (
      <Pressable {...PRESSABLE_INSTANT}
        onPress={() => setExploreSectionLimit((n) => n + EXPLORE_SECTIONS_BATCH)}
        style={styles.exploreLoadMoreBtn}
      >
        <Text style={styles.exploreLoadMoreBtnText}>
          {`Show ${Math.min(
            EXPLORE_SECTIONS_BATCH,
            exploreSections.length - exploreSectionLimit,
          )} more days`}
        </Text>
      </Pressable>
    ) : null;

    return (
      <SectionList
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
        {...IOS_SCROLL_INSTANT_TOUCH}
        sections={visibleSections}
        keyExtractor={(item, index) => `${eventStorageKey(item)}-${index}`}
        renderItem={({ item, index, section }) =>
          renderEventListCard(item, `${section.title}-${index}`)
        }
        renderSectionHeader={({ section }) => (
          <Text
            style={[
              styles.dayHeader,
              styles.exploreSectionHeader,
              isDarkTheme && styles.dayHeaderDark,
              isNeo && styles.dayHeaderNeo,
            ]}
          >
            {formatHumanDate(section.title)}
          </Text>
        )}
        ListHeaderComponent={header}
        ListEmptyComponent={emptyNode}
        ListFooterComponent={footerNode}
        stickySectionHeadersEnabled={false}
        initialNumToRender={8}
        maxToRenderPerBatch={8}
        windowSize={7}
        removeClippedSubviews
        SectionSeparatorComponent={() => <View style={{ height: 6 }} />}
      />
    );
  };

  const renderCalendar = () => {
    const datedUpcoming = calendarMyPlan
      ? calendarScheduleEvents.filter((e) => {
          const status = rsvpStatuses[eventStorageKey(e)];
          return status === "going" || status === "interested";
        })
      : calendarScheduleEvents;
    const eventsByDate = new Map<string, EventItem[]>();
    for (const e of datedUpcoming) {
      const key = normalizeText(e.date);
      const bucket = eventsByDate.get(key) || [];
      bucket.push(e);
      eventsByDate.set(key, bucket);
    }

    const viewedDate = new Date(`${calendarAnchorIso}T00:00:00`);
    const viewedYear = viewedDate.getFullYear();
    const viewedMonth = viewedDate.getMonth();
    const monthStart = new Date(viewedYear, viewedMonth, 1);
    const daysInMonth = new Date(viewedYear, viewedMonth + 1, 0).getDate();
    const leadingBlanks = monthStart.getDay();
    const monthLabel = monthStart.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const cells: Array<{ iso: string | null; day: number | null }> = [];
    for (let i = 0; i < leadingBlanks; i += 1) cells.push({ iso: null, day: null });
    for (let day = 1; day <= daysInMonth; day += 1) {
      const iso = `${viewedYear}-${String(viewedMonth + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      cells.push({ iso, day });
    }
    while (cells.length % 7 !== 0) cells.push({ iso: null, day: null });

    // Active agenda day — prefer the user's current selection; fall back to
    // today when today is within the visible month; else the first day in the
    // visible month that actually has events; else the 1st.
    const inSameMonth = (iso: string) => iso.startsWith(`${viewedYear}-${String(viewedMonth + 1).padStart(2, "0")}`);
    let activeDate = "";
    if (selectedCalendarDate && inSameMonth(selectedCalendarDate)) {
      activeDate = selectedCalendarDate;
    } else if (inSameMonth(today)) {
      activeDate = today;
    } else {
      const firstEventDay = Array.from(eventsByDate.keys())
        .filter(inSameMonth)
        .sort()[0];
      activeDate = firstEventDay || `${viewedYear}-${String(viewedMonth + 1).padStart(2, "0")}-01`;
    }
    const activeDateEvents = eventsByDate.get(activeDate) || [];

    const shiftMonth = (delta: number) => {
      const next = new Date(viewedYear, viewedMonth + delta, 1);
      const iso = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}-01`;
      setCalendarAnchorIso(iso);
      // Clear the single-day pin so the agenda auto-picks today / first-event
      // when the user lands on the new month.
      setSelectedCalendarDate("");
    };

    const goToToday = () => {
      setCalendarAnchorIso(today);
      setSelectedCalendarDate(today);
    };

    return (
    <ScrollView
      ref={calendarScrollRef}
      contentContainerStyle={[styles.scrollBody, isMidnight && styles.scrollBodyMidnight, isNeo && styles.scrollBodyNeo, isVitaria && styles.scrollBodyVitaria, isInferno && styles.scrollBodyInferno, isEmerald && styles.scrollBodyEmerald]}
      {...IOS_SCROLL_INSTANT_TOUCH}
    >
      <LinearGradient
        colors={isMidnight ? ["#0c0f19", "#151b2a"] : isNeo ? ["#d8d8d8", "#d2d2d2"] : isVitaria ? ["#8f7680", "#b3949d"] : isInferno ? ["#070607", "#1b0901"] : isEmerald ? ["#b8e5c9", "#8fd5ad"] : ["#f0f2f7", "#e8ebf3"]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.premiumSectionHeader}
      >
          <Text style={[styles.premiumSectionTitle, isDarkTheme && styles.premiumSectionTitleDark, isNeo && styles.premiumSectionTitleNeo]}>Calendar</Text>
        <Text style={[styles.premiumSectionSub, isDarkTheme && styles.premiumSectionSubDark, isNeo && styles.premiumSectionSubNeo]}>
            A month at a glance. Tap any day to see who's speaking and where to sit.
        </Text>
      </LinearGradient>

        <View style={[styles.calendarViewSwitch, isDarkTheme && styles.calendarViewSwitchDark]}>
          <Pressable
            {...PRESSABLE_INSTANT}
            style={[styles.calendarViewChip, calendarView === "month" && styles.calendarViewChipActive]}
            onPress={() => setCalendarView("month")}
          >
            <Text style={[styles.calendarViewChipText, calendarView === "month" && styles.calendarViewChipTextActive]}>Month</Text>
          </Pressable>
          <Pressable
            {...PRESSABLE_INSTANT}
            style={[styles.calendarViewChip, calendarView === "list" && styles.calendarViewChipActive]}
            onPress={() => setCalendarView("list")}
          >
            <Text style={[styles.calendarViewChipText, calendarView === "list" && styles.calendarViewChipTextActive]}>Export list</Text>
          </Pressable>
          <Pressable
            {...PRESSABLE_INSTANT}
            style={[styles.calendarViewChip, calendarMyPlan && styles.calendarViewChipActive]}
            onPress={() => setCalendarMyPlan((prev) => !prev)}
          >
            <Text style={[styles.calendarViewChipText, calendarMyPlan && styles.calendarViewChipTextActive]}>
              My plan
            </Text>
          </Pressable>
        </View>
        {calendarMyPlan ? (
          <View style={styles.calendarMyPlanHint}>
            <Text style={styles.calendarMyPlanHintText}>
              Showing only events you said you're going to or interested in.
            </Text>
          </View>
        ) : null}

        {calendarView === "month" && knowledgePlans.length > 0 ? (
          <View style={[styles.knowledgePlanCard, isDarkTheme && styles.knowledgePlanCardDark]}>
            <View style={styles.knowledgePlanHeaderRow}>
              <View style={{ flex: 1 }}>
                <Text style={[styles.knowledgePlanKicker, isDarkTheme && { color: "#f4b57d" }]}>
                  Curated for you
                </Text>
                <Text style={[styles.knowledgePlanTitle, isDarkTheme && { color: "#f4f7ff" }]}>
                  AI learning plans
                </Text>
                <Text style={[styles.knowledgePlanSub, isDarkTheme && { color: "#c4cee8" }]}>
                  Pick a topic — we'll line up the best events from your local masjids so the
                  knowledge builds in order, without the noise.
                </Text>
              </View>
            </View>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingVertical: 4, paddingRight: 4, gap: 12 }}
              {...IOS_SCROLL_INSTANT_TOUCH}
            >
              {knowledgePlans.map((plan) => {
                const firstDate = plan.events[0]?.date || "";
                const lastDate = plan.events[plan.events.length - 1]?.date || "";
                const spanLabel = firstDate && lastDate
                  ? firstDate === lastDate
                    ? formatHumanDate(firstDate)
                    : `${formatHumanDate(firstDate)} → ${formatHumanDate(lastDate)}`
                  : "Upcoming";
                return (
                  <Pressable
                    {...PRESSABLE_INSTANT}
                    key={`plan-${plan.id}`}
                    onPress={() => setKnowledgePlanPreview(plan)}
                    style={({ pressed }) => [
                      styles.knowledgePlanTile,
                      { backgroundColor: plan.color },
                      pressed && { opacity: 0.92, transform: [{ scale: 0.98 }] },
                    ]}
                  >
                    <View style={styles.knowledgePlanGlyphRow}>
                      <Mi name={plan.mi} size={24} color="#ffffff" />
                      <View style={styles.knowledgePlanChipCount}>
                        <Text style={styles.knowledgePlanChipCountText}>
                          {plan.events.length} stops
                        </Text>
                      </View>
                    </View>
                    <Text style={styles.knowledgePlanTileTitle} numberOfLines={2}>
                      {plan.title}
                    </Text>
                    <Text style={styles.knowledgePlanTileSub} numberOfLines={2}>
                      {plan.sub}
                    </Text>
                    <Text style={styles.knowledgePlanTileSpan} numberOfLines={1}>
                      {spanLabel}
                    </Text>
                    <View style={styles.knowledgePlanTileCta}>
                      <Text style={styles.knowledgePlanTileCtaText}>View plan →</Text>
                    </View>
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        ) : null}

        {calendarView === "month" ? (
          <>
            <View style={[styles.calendarMonthBar, isDarkTheme && styles.calendarMonthBarDark]}>
              <Pressable {...PRESSABLE_INSTANT} onPress={() => shiftMonth(-1)} hitSlop={12} style={styles.calendarMonthArrowBtn}>
                <Text style={styles.calendarMonthArrow}>‹</Text>
              </Pressable>
              <Pressable {...PRESSABLE_INSTANT} onPress={goToToday} style={{ flex: 1, alignItems: "center" }}>
                <Text style={[styles.calendarMonthLabel, isDarkTheme && { color: "#f4f7ff" }]}>{monthLabel}</Text>
                <Text style={[styles.calendarMonthLabelSub, isDarkTheme && { color: "#8793ab" }]}>
                  Tap to jump to today
                </Text>
              </Pressable>
              <Pressable {...PRESSABLE_INSTANT} onPress={() => shiftMonth(1)} hitSlop={12} style={styles.calendarMonthArrowBtn}>
                <Text style={styles.calendarMonthArrow}>›</Text>
              </Pressable>
            </View>

            <View style={[styles.controlsCard, isMidnight && styles.controlsCardMidnight, isNeo && styles.controlsCardNeo, isVitaria && styles.controlsCardVitaria, isInferno && styles.controlsCardInferno, isEmerald && styles.controlsCardEmerald]}>
              <View style={styles.calendarWeekRow}>
                {CALENDAR_WEEKDAYS.map((d) => (
                  <Text key={`wd-${d}`} style={[styles.calendarWeekday, isDarkTheme && styles.calendarWeekdayDark, isNeo && styles.calendarWeekdayNeo]}>
                    {d}
                  </Text>
                ))}
              </View>
              <View style={styles.calendarGrid}>
                {cells.map((cell, idx) => {
                  if (!cell.iso || !cell.day) return <View key={`blank-${idx}`} style={styles.calendarDayEmpty} />;
                  const dayEvents = eventsByDate.get(cell.iso) || [];
                  const hasEvents = dayEvents.length > 0;
                  const active = activeDate === cell.iso;
                  const isToday = cell.iso === today;
                  return (
                    <Pressable
                      {...PRESSABLE_INSTANT}
                      key={`day-${cell.iso}`}
                      onPress={() => {
                        setSelectedCalendarDate(cell.iso || "");
                      }}
                      onLongPress={() => {
                        if (cell.iso) setSelectedCalendarModalDate(cell.iso);
                      }}
                      style={[
                        styles.calendarDay,
                        hasEvents && styles.calendarDayHasEvents,
                        active && styles.calendarDayActive,
                        isDarkTheme && hasEvents && styles.calendarDayHasEventsDark,
                        isNeo && hasEvents && styles.calendarDayHasEventsNeo,
                        isToday && !active && styles.calendarDayToday,
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
                      <Text style={[styles.calendarDayText, hasEvents && styles.calendarDayTextStrong, active && styles.calendarDayTextActive, isToday && styles.calendarDayTextToday, isDarkTheme && styles.calendarDayTextDark]}>
                        {cell.day}
                      </Text>
                      {hasEvents ? (
                        <View style={styles.calendarDayDotRow}>
                          {Array.from({ length: Math.min(3, dayEvents.length) }).map((_, dotIdx) => (
                            <View
                              key={`dot-${cell.iso}-${dotIdx}`}
                              style={[styles.calendarDayDot, active && styles.calendarDayDotActive]}
                            />
                          ))}
                        </View>
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
              <View style={styles.calendarLegendRow}>
                <View style={styles.calendarLegendItem}>
                  <View style={styles.calendarLegendSwatchToday} />
                  <Text style={[styles.calendarLegendText, isDarkTheme && { color: "#c4cee8" }]}>Today</Text>
                </View>
                <View style={styles.calendarLegendItem}>
                  <View style={styles.calendarLegendSwatchEvents} />
                  <Text style={[styles.calendarLegendText, isDarkTheme && { color: "#c4cee8" }]}>Has events</Text>
                </View>
                <View style={styles.calendarLegendItem}>
                  <View style={styles.calendarLegendSwatchSelected} />
                  <Text style={[styles.calendarLegendText, isDarkTheme && { color: "#c4cee8" }]}>Selected</Text>
                </View>
              </View>
            </View>

            <View style={[styles.controlsCard, isMidnight && styles.controlsCardMidnight, isNeo && styles.controlsCardNeo, isVitaria && styles.controlsCardVitaria, isInferno && styles.controlsCardInferno, isEmerald && styles.controlsCardEmerald]}>
              <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" }}>
                <Text style={[styles.sectionTitle, isMinera && styles.sectionTitleMinera, isMidnight && styles.sectionTitleMidnight, isNeo && styles.sectionTitleNeo, isVitaria && styles.sectionTitleVitaria, isInferno && styles.sectionTitleInferno, isEmerald && styles.sectionTitleEmerald]}>
                  {formatHumanDate(activeDate)}
                </Text>
                <Text style={[styles.calendarAgendaCount, isDarkTheme && { color: "#c4cee8" }]}>
                  {activeDateEvents.length} event{activeDateEvents.length === 1 ? "" : "s"}
                </Text>
              </View>
              {activeDateEvents.length === 0 ? (
                <Text style={[styles.metaInfoLine, isDarkTheme && styles.metaInfoLineMidnight, { marginTop: 10 }]}>
                  No events on this day. Try another day or switch to Explore.
                </Text>
              ) : (
                <View style={{ gap: 10, marginTop: 8 }}>
                  {activeDateEvents.map((e, idx) => {
                    const poster = eventPosterUrl(e);
                    const rsvpState = rsvpStatuses[eventStorageKey(e)];
                    const saved = isSavedEvent(e);
                    return (
                      <Pressable {...PRESSABLE_INSTANT}
                        key={`cal-agenda-${eventStorageKey(e)}-${idx}`}
                        style={[styles.calendarAgendaRow, isDarkTheme && styles.calendarAgendaRowDark]}
                        onPress={() => openEventDetails(e)}
                      >
                        {poster && canRenderPoster(poster) ? (
                          <LoadableNetworkImage
                            uri={poster}
                            style={styles.calendarAgendaPoster}
                            onError={() => markPosterFailed(poster)}
                          />
                        ) : (
                          <View style={[styles.calendarAgendaPoster, { alignItems: "center", justifyContent: "center", backgroundColor: masjidBrandColor(e.source) }]}>
                            <Text style={{ color: "#fff", fontWeight: "900", fontSize: 16 }}>{masjidInitials(e.source)}</Text>
                          </View>
                        )}
                        <View style={{ flex: 1, gap: 4 }}>
                          <Text style={[styles.calendarAgendaWhen, isDarkTheme && { color: "#c4cee8" }]}>
                            {eventTime(e)} · {formatSourceLabel(e.source)}
                          </Text>
                          <Text style={[styles.calendarAgendaTitle, isDarkTheme && { color: "#f4f7ff" }]} numberOfLines={2}>
                            {eventDisplayTitle(e)}
                          </Text>
                          <View style={styles.cardActionRow}>
                            <Pressable {...PRESSABLE_INSTANT}
                              hitSlop={6}
                              style={({ pressed }) => [
                                styles.cardActionChip,
                                rsvpState === "going" && styles.cardActionChipActive,
                                pressed && styles.cardActionChipPressed,
                              ]}
                              onPress={(ev) => {
                                ev.stopPropagation?.();
                                toggleRsvp(e, "going");
                              }}
                            >
                              <Text style={[styles.cardActionChipText, rsvpState === "going" && styles.cardActionChipTextActive]}>
                                {rsvpState === "going" ? "Going ✓" : "Going"}
                              </Text>
                            </Pressable>
                            <Pressable {...PRESSABLE_INSTANT}
                              hitSlop={6}
                              style={({ pressed }) => [
                                styles.cardActionChip,
                                saved && styles.cardActionChipActive,
                                pressed && styles.cardActionChipPressed,
                              ]}
                              onPress={(ev) => {
                                ev.stopPropagation?.();
                                toggleSavedEvent(e);
                              }}
                            >
                              <Mi
                                name={saved ? "favorite_fill1" : "favorite"}
                                size={14}
                                color={saved ? "#fff" : "#2e4f82"}
                              />
                            </Pressable>
                            {e.event_uid ? (
                              <Pressable {...PRESSABLE_INSTANT}
                                hitSlop={6}
                                style={({ pressed }) => [
                                  styles.cardActionChip,
                                  pressed && styles.cardActionChipPressed,
                                ]}
                                onPress={(ev) => {
                                  ev.stopPropagation?.();
                                  openCalendarExportPicker(e);
                                }}
                              >
                                <Mi name="calendar_today" size={14} color="#2e4f82" />
                              </Pressable>
                            ) : null}
                          </View>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              )}
            </View>
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
      {calendarScheduleEvents.map((e, idx) => {
        const calPoster = eventPosterUrl(e);
        return (
        <View key={`cal-${e.event_uid || e.title}-${idx}`} style={styles.hospitalListCard}>
          {calPoster && canRenderPoster(calPoster) ? (
            <LoadableNetworkImage uri={calPoster} style={styles.hospitalListPoster} onError={() => markPosterFailed(calPoster)} />
          ) : (
            <View
              style={[
                styles.hospitalListPoster,
                { backgroundColor: masjidBrandColor(e.source), alignItems: "center", justifyContent: "center" },
              ]}
            >
              <Text style={{ color: "#fff", fontWeight: "900", fontSize: 18 }}>{masjidInitials(e.source)}</Text>
            </View>
          )}
          <View style={{ flex: 1 }}>
            <Text style={styles.mapTag}>Calendar</Text>
            <Text style={[styles.hospitalListTitle, isDarkTheme && styles.hospitalListTitleDark, isNeo && styles.hospitalListTitleNeo]} numberOfLines={1}>{eventDisplayTitle(e)}</Text>
            <Text style={[styles.hospitalListMeta, isDarkTheme && styles.hospitalListMetaDark, isNeo && styles.hospitalListMetaNeo]} numberOfLines={1}>
                    {formatHumanDate(e.date)} • {eventTime(e)} • {formatSourceLabel(e.source)}
            </Text>
            <View style={styles.calendarActionRow}>
              {e.event_uid ? (
                      <Pressable {...PRESSABLE_INSTANT} style={styles.darkPillBtn} onPress={() => openCalendarExportPicker(e)}>
                        <Text style={styles.darkPillBtnText}>Export Calendar</Text>
                </Pressable>
              ) : null}
              {e.source_url ? (
                <Pressable {...PRESSABLE_INSTANT} style={styles.roundGhostBtn} onPress={() => Linking.openURL(e.source_url)}>
                  <Mi name="open_in_new" size={16} color="#273143" />
                </Pressable>
              ) : null}
            </View>
          </View>
        </View>
        );
      })}
          </>
        )}
    </ScrollView>
  );
  };

  const renderFeed = () => {
    const feedSection = (
      title: string,
      subtitle: string,
      eventsForSection: EventItem[],
      keyPrefix: string,
      emptyText: string
    ) => (
      <View style={styles.discoverSection}>
        <Text style={[styles.discoverSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>{title}</Text>
        <Text style={[styles.discoverSectionSub, isDarkTheme && { color: "#9db0db" }]}>{subtitle}</Text>
        {eventsForSection.length ? (
          eventsForSection.map((event, idx) => (
            <View key={`${keyPrefix}-${eventStorageKey(event)}-${idx}`}>{renderEventListCard(event, `${keyPrefix}-${idx}`)}</View>
          ))
        ) : (
          <View style={styles.emptyCard}>
            <Text style={[styles.emptyText, isDarkTheme && styles.emptyTextDark, isNeo && styles.emptyTextNeo]}>{emptyText}</Text>
          </View>
        )}
      </View>
    );

    // First-time setup: a forced, full-screen inline wizard that replaces the
    // feed body. The user cannot dismiss or skip — they must pick masjids,
    // then speakers, then class topics, then watch a short "Building your
    // feed…" moment before the real feed appears. They can re-edit later
    // from Settings → Content → Your Feed setup.
    if (!feedSetupDone || feedEditMode || (feedSetupApplying && !feedSetupOpen)) {
      const step = feedSetupStep;
      const isBuilding = feedSetupApplying;
      const isReEditing = feedSetupDone && feedEditMode;
      const canAdvance =
        step === 0
          ? feedSetupMasjids.length > 0
          : step === 1
            ? feedSetupScholars.length > 0
            : step === 2
              ? feedSetupTopics.length > 0
              : false;
      const stepTitle =
        step === 0
          ? "Which masjids do you want to see?"
          : step === 1
            ? "Which speakers do you want in your feed?"
            : "What type of classes do you want?";
      const stepSub =
        step === 0
          ? "Pick at least one masjid. You can change this anytime in Settings."
          : step === 1
            ? "Choose speakers you'd like to hear from. Change anytime in Settings."
            : "Pick the topics you care about — halaqas, tafsir, youth, and more.";
      const stepCount = 3;
      return (
        <View
          style={[
            styles.scrollBody,
            isMidnight && styles.scrollBodyMidnight,
            isNeo && styles.scrollBodyNeo,
            isVitaria && styles.scrollBodyVitaria,
            isInferno && styles.scrollBodyInferno,
            isEmerald && styles.scrollBodyEmerald,
            { flex: 1 },
          ]}
        >
          <View
            style={[
              styles.feedWizardTopBar,
              isDarkTheme && styles.feedWizardTopBarDark,
              isNeo && styles.feedWizardTopBarNeo,
              isEmerald && styles.feedWizardTopBarEmerald,
              isInferno && styles.feedWizardTopBarInferno,
              isVitaria && styles.feedWizardTopBarVitaria,
            ]}
          >
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text
                style={[
                  styles.feedWizardTopTitle,
                  isDarkTheme && styles.feedWizardTopTitleDark,
                  isNeo && styles.feedWizardTopTitleNeo,
                  isEmerald && styles.feedWizardTopTitleEmerald,
                  isInferno && styles.feedWizardTopTitleInferno,
                  isVitaria && styles.feedWizardTopTitleVitaria,
                ]}
              >
                {isReEditing ? "Edit feed" : "Set up your feed"}
              </Text>
              <Text
                style={[
                  styles.feedWizardTopSub,
                  isDarkTheme && styles.feedWizardTopSubDark,
                  isNeo && styles.feedWizardTopSubNeo,
                  isEmerald && styles.feedWizardTopSubEmerald,
                  isInferno && styles.feedWizardTopSubInferno,
                  isVitaria && styles.feedWizardTopSubVitaria,
                ]}
                numberOfLines={2}
              >
                {isReEditing
                  ? "Masjids, speakers & topics · saves when you tap Build my feed."
                  : "Three steps: masjids, speakers, topics."}
              </Text>
            </View>
            {isReEditing ? (
              <Pressable
                {...PRESSABLE_INSTANT}
                hitSlop={10}
                onPress={() => {
                  setFeedEditMode(false);
                  setFeedSetupStep(0);
                }}
              >
                <Text style={[styles.feedWizardCancelLink, isDarkTheme && styles.feedWizardCancelLinkDark]}>Cancel</Text>
              </Pressable>
            ) : null}
          </View>

          {isBuilding ? (
            <View style={[styles.feedBuildWrap, isDarkTheme && styles.feedBuildWrapDark]}>
              {feedBuildPhase === "success" ? (
                <Animated.View
                  style={[
                    styles.feedBuildSuccessCard,
                    isDarkTheme && styles.feedBuildSuccessCardDark,
                    { transform: [{ scale: feedBuildSuccessScale }] },
                  ]}
                >
                  <View style={styles.feedBuildSuccessBadge}>
                    <Mi name="check" size={48} color="#ffffff" />
                  </View>
                  <Text style={[styles.feedBuildTitle, isDarkTheme && styles.feedBuildTitleDark]}>
                    Your feed is ready
                  </Text>
                  <Text style={[styles.feedBuildSub, isDarkTheme && styles.feedBuildSubDark]}>
                    {feedSetupMasjids.length} masjid{feedSetupMasjids.length === 1 ? "" : "s"} ·{" "}
                    {feedSetupScholars.length} speaker{feedSetupScholars.length === 1 ? "" : "s"} ·{" "}
                    {feedSetupTopics.length} topic{feedSetupTopics.length === 1 ? "" : "s"}
                  </Text>
                </Animated.View>
              ) : (
                <View style={[styles.feedBuildCard, isDarkTheme && styles.feedBuildCardDark]}>
                  <Animated.View
                    style={[
                      styles.feedBuildGifWrap,
                      {
                        transform: [
                          {
                            rotate: feedBuildHammerTilt.interpolate({
                              inputRange: [-1, 0, 1],
                              outputRange: ["-2.5deg", "0deg", "2.5deg"],
                            }),
                          },
                        ],
                      },
                    ]}
                  >
                    <Image source={FEED_BUILDING_CAT} style={styles.feedBuildGif} resizeMode="cover" />
                  </Animated.View>
                  <Text style={[styles.feedBuildTitle, isDarkTheme && styles.feedBuildTitleDark]}>
                    Building your feed
                  </Text>
                  <Text style={[styles.feedBuildSub, isDarkTheme && styles.feedBuildSubDark]}>
                    Our hard workers are working.
                  </Text>
                  <View style={[styles.feedBuildBarTrack, isDarkTheme && styles.feedBuildBarTrackDark]}>
                    <Animated.View
                      style={[
                        styles.feedBuildBarFill,
                        {
                          width: feedBuildProgress.interpolate({
                            inputRange: [0, 1],
                            outputRange: ["0%", "100%"],
                          }),
                        },
                      ]}
                    />
                  </View>
                  <Text style={[styles.feedBuildPercent, isDarkTheme && styles.feedBuildPercentDark]}>
                    Saving masjids, speakers &amp; topics…
                  </Text>
                </View>
              )}
            </View>
          ) : (
            <>
              <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 6, paddingBottom: 20, gap: 8 }}
                showsVerticalScrollIndicator
                keyboardShouldPersistTaps="handled"
                nestedScrollEnabled
                {...IOS_SCROLL_INSTANT_TOUCH}
              >
                <Animated.View
                  style={{
                    opacity: feedStepAnim,
                    transform: [
                      {
                        translateX: feedStepAnim.interpolate({
                          inputRange: [0, 1],
                          outputRange: [feedStepDirRef.current * STEP_TRANSITION_PX, 0],
                        }),
                      },
                    ],
                    gap: 8,
                  }}
                >
                  <View style={[styles.feedSetupHeader, { borderBottomWidth: 0, paddingHorizontal: 0, paddingTop: 4, paddingBottom: 6 }]}>
                    <Text style={[styles.feedSetupStepPill, isDarkTheme && styles.feedSetupStepPillDark]}>
                      Step {step + 1} of {stepCount}
                    </Text>
                    <Text style={[styles.feedSetupTitle, isDarkTheme && styles.feedSetupTitleDark]}>{stepTitle}</Text>
                    <Text style={[styles.feedSetupSub, isDarkTheme && styles.feedSetupSubDark]}>{stepSub}</Text>
                  </View>
                  {!isReEditing ? (
                    <Text
                      style={[
                        styles.feedWizardExplainerCompact,
                        isDarkTheme && styles.feedWizardExplainerCompactDark,
                        isNeo && styles.feedWizardExplainerCompactNeo,
                        isEmerald && styles.feedWizardExplainerCompactEmerald,
                      ]}
                    >
                      Your feed ranks upcoming events from masjids and speakers you follow, topics you pick, plus your saves and RSVPs.
                    </Text>
                  ) : null}

                {step === 0
                  ? feedSetupMasjidOptions.map((source) => {
                      const active = feedSetupMasjids.includes(source);
                      const upcomingCount = feedUpcomingEvents.filter(
                        (e) => normalizeText(e.source).toLowerCase() === source.toLowerCase()
                      ).length;
                      return (
                        <Pressable
                          {...PRESSABLE_INSTANT}
                          key={`feed-wizard-m-${source}`}
                          hitSlop={6}
                          style={({ pressed }) => [
                            styles.feedSetupChoiceRow,
                            isDarkTheme && styles.feedSetupChoiceRowDark,
                            active && styles.feedSetupChoiceRowActive,
                            pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
                          ]}
                          onPress={() => {
                            hapticTap("selection");
                            setFeedSetupMasjids((prev) =>
                              prev.includes(source) ? prev.filter((x) => x !== source) : [...prev, source]
                            );
                          }}
                        >
                          {renderMasjidLogo(source, 38, {
                            style: styles.feedSetupMasjidLogo,
                            textStyle: styles.discoverMasjidAvatarText,
                          })}
                          <View style={{ flex: 1 }}>
                            <Text
                              style={[styles.feedSetupChoiceTitle, isDarkTheme && styles.feedSetupChoiceTitleDark]}
                              numberOfLines={1}
                            >
                              {formatSourceLabel(source)}
                            </Text>
                            <Text
                              style={[styles.feedSetupChoiceMeta, isDarkTheme && styles.feedSetupChoiceMetaDark]}
                              numberOfLines={1}
                            >
                              {upcomingCount} upcoming event{upcomingCount === 1 ? "" : "s"}
                            </Text>
                          </View>
                          <Text
                            style={[
                              styles.feedSetupChoiceState,
                              active && styles.feedSetupChoiceStateActive,
                            ]}
                          >
                            {active ? "✓" : "+"}
                          </Text>
                        </Pressable>
                      );
                    })
                  : null}

                {step === 1
                  ? feedSetupSpeakerOptions.map((sp) => {
                      const active = feedSetupScholars.includes(sp.slug);
                      return (
                        <Pressable
                          {...PRESSABLE_INSTANT}
                          key={`feed-wizard-sp-${sp.slug}`}
                          hitSlop={6}
                          style={({ pressed }) => [
                            styles.feedSetupChoiceRow,
                            isDarkTheme && styles.feedSetupChoiceRowDark,
                            active && styles.feedSetupChoiceRowActive,
                            pressed && { opacity: 0.85, transform: [{ scale: 0.98 }] },
                          ]}
                          onPress={() => {
                            hapticTap("selection");
                            setFeedSetupScholars((prev) =>
                              prev.includes(sp.slug) ? prev.filter((x) => x !== sp.slug) : [...prev, sp.slug]
                            );
                          }}
                        >
                          <View style={styles.feedSetupSpeakerAvatar}>
                            <Text style={styles.feedSetupSpeakerAvatarText}>
                              {sp.name
                                .split(" ")
                                .map((p) => p[0])
                                .filter(Boolean)
                                .slice(0, 2)
                                .join("")
                                .toUpperCase()}
                            </Text>
                          </View>
                          <View style={{ flex: 1 }}>
                            <Text
                              style={[styles.feedSetupChoiceTitle, isDarkTheme && styles.feedSetupChoiceTitleDark]}
                              numberOfLines={1}
                            >
                              {sp.name}
                            </Text>
                            <Text
                              style={[styles.feedSetupChoiceMeta, isDarkTheme && styles.feedSetupChoiceMetaDark]}
                              numberOfLines={1}
                            >
                              {sp.upcoming} upcoming talk{sp.upcoming === 1 ? "" : "s"}
                            </Text>
                          </View>
                          <Text
                            style={[
                              styles.feedSetupChoiceState,
                              active && styles.feedSetupChoiceStateActive,
                            ]}
                          >
                            {active ? "✓" : "+"}
                          </Text>
                        </Pressable>
                      );
                    })
                  : null}

                {step === 2 ? (
                  <View style={styles.feedSetupTopicWrap}>
                    {feedSetupTopicOptions.map((topic) => {
                      const active = feedSetupTopics.includes(topic);
                      return (
                        <Pressable
                          {...PRESSABLE_INSTANT}
                          key={`feed-wizard-topic-${topic}`}
                          hitSlop={6}
                          style={({ pressed }) => [
                            styles.feedTopicChip,
                            active && styles.feedTopicChipActive,
                            pressed && { opacity: 0.85, transform: [{ scale: 0.96 }] },
                          ]}
                          onPress={() => {
                            hapticTap("selection");
                            setFeedSetupTopics((prev) =>
                              prev.includes(topic) ? prev.filter((x) => x !== topic) : [...prev, topic]
                            );
                          }}
                        >
                          <Text
                            style={[
                              styles.feedTopicChipText,
                              active && styles.feedTopicChipTextActive,
                            ]}
                          >
                            {topic}
                          </Text>
                        </Pressable>
                      );
                    })}
                  </View>
                ) : null}
                </Animated.View>
              </ScrollView>

              <View style={[styles.feedSetupFooter, { paddingHorizontal: 14, paddingBottom: Math.max(insets.bottom, 12) }]}>
                <Pressable
                  {...PRESSABLE_INSTANT}
                  hitSlop={8}
                  style={({ pressed }) => [
                    styles.feedSetupBackBtn,
                    step === 0 && { opacity: 0.5 },
                    pressed && step !== 0 && { opacity: 0.7, transform: [{ scale: 0.97 }] },
                  ]}
                  disabled={step === 0}
                  onPress={() => {
                    hapticTap("selection");
                    feedStepDirRef.current = -1;
                    setFeedSetupStep((s) => (s > 0 ? ((s - 1) as 0 | 1 | 2 | 3) : s));
                  }}
                >
                  <Text style={styles.feedSetupBackText}>Back</Text>
                </Pressable>
                <Pressable
                  {...PRESSABLE_INSTANT}
                  hitSlop={8}
                  style={({ pressed }) => [
                    styles.feedSetupNextBtn,
                    !canAdvance && { opacity: 0.5 },
                    pressed && canAdvance && { opacity: 0.88, transform: [{ scale: 0.97 }] },
                  ]}
                  disabled={!canAdvance}
                  onPress={() => {
                    hapticTap(step < 2 ? "selection" : "success");
                    if (step < 2) {
                      feedStepDirRef.current = 1;
                      setFeedSetupStep((s) => ((s + 1) as 0 | 1 | 2 | 3));
                    } else {
                      void applyFeedSetupWizard();
                    }
                  }}
                >
                  <Text style={styles.feedSetupNextText}>
                    {step === 2
                      ? "Build my feed"
                      : `Next${
                          step === 0 && feedSetupMasjids.length
                            ? ` (${feedSetupMasjids.length})`
                            : step === 1 && feedSetupScholars.length
                              ? ` (${feedSetupScholars.length})`
                              : ""
                        }`}
                  </Text>
                </Pressable>
              </View>
            </>
          )}
        </View>
      );
    }

    return (
      <ScrollView
        ref={feedScrollRef}
        style={[styles.scrollBody, isMidnight && styles.scrollBodyMidnight, isNeo && styles.scrollBodyNeo, isVitaria && styles.scrollBodyVitaria, isInferno && styles.scrollBodyInferno, isEmerald && styles.scrollBodyEmerald]}
        contentContainerStyle={{ paddingBottom: 120, gap: 8 }}
        showsVerticalScrollIndicator={false}
        {...IOS_SCROLL_INSTANT_TOUCH}
      >
        <LinearGradient
          colors={isMidnight ? ["#0c0f19", "#151b2a"] : isNeo ? ["#d8d8d8", "#d2d2d2"] : isVitaria ? ["#8f7680", "#b3949d"] : isInferno ? ["#070607", "#1b0901"] : isEmerald ? ["#b8e5c9", "#8fd5ad"] : ["#f0f2f7", "#e8ebf3"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.premiumSectionHeader}
        >
          <View style={{ flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={[styles.premiumSectionTitle, isDarkTheme && styles.premiumSectionTitleDark, isNeo && styles.premiumSectionTitleNeo]}>Your Feed</Text>
              <Text style={[styles.premiumSectionSub, isDarkTheme && styles.premiumSectionSubDark, isNeo && styles.premiumSectionSubNeo]}>
                {feedView === "saved"
                  ? `${feedSavedTabEvents.length} saved & RSVP'd event${feedSavedTabEvents.length === 1 ? "" : "s"}.`
                  : "Personalized from your follows, interests, saves, and RSVPs."}
              </Text>
            </View>
            <Pressable
              {...PRESSABLE_INSTANT}
              onPress={() => openFeedSetupWizard()}
              style={[
                styles.feedHeaderEditBtn,
                isDarkTheme && styles.feedHeaderEditBtnDark,
                isNeo && styles.feedHeaderEditBtnNeo,
                isEmerald && styles.feedHeaderEditBtnEmerald,
                isInferno && styles.feedHeaderEditBtnInferno,
                isVitaria && styles.feedHeaderEditBtnVitaria,
              ]}
              hitSlop={6}
            >
              <Text
                style={[
                  styles.feedHeaderEditBtnText,
                  isDarkTheme && styles.feedHeaderEditBtnTextDark,
                  isNeo && styles.feedHeaderEditBtnTextNeo,
                  isEmerald && styles.feedHeaderEditBtnTextEmerald,
                  isInferno && styles.feedHeaderEditBtnTextInferno,
                  isVitaria && styles.feedHeaderEditBtnTextVitaria,
                ]}
              >
                Edit
              </Text>
            </Pressable>
          </View>
        </LinearGradient>

        {/* Top-level view switch: All personalized sections vs dedicated Saved list. */}
        <View style={[styles.feedViewSwitch, isDarkTheme && styles.feedViewSwitchDark]}>
          <Pressable
            {...PRESSABLE_INSTANT}
            onPress={() => setFeedView("all")}
            style={[
              styles.feedViewSwitchBtn,
              feedView === "all" && styles.feedViewSwitchBtnActive,
              { flexDirection: "row", alignItems: "center", gap: 6 },
            ]}
          >
            <Mi
              name="auto_awesome"
              size={14}
              color={
                feedView === "all"
                  ? "#fff"
                  : isDarkTheme
                  ? "#e8ecf4"
                  : "#273143"
              }
            />
            <Text
              style={[
                styles.feedViewSwitchText,
                isDarkTheme && styles.feedViewSwitchTextDark,
                feedView === "all" && styles.feedViewSwitchTextActive,
              ]}
              numberOfLines={1}
            >
              Your Feed
            </Text>
          </Pressable>
          <Pressable
            {...PRESSABLE_INSTANT}
            onPress={() => setFeedView("saved")}
            style={[
              styles.feedViewSwitchBtn,
              feedView === "saved" && styles.feedViewSwitchBtnActive,
              { flexDirection: "row", alignItems: "center", gap: 6 },
            ]}
          >
            <Mi
              name={feedView === "saved" ? "favorite_fill1" : "favorite"}
              size={14}
              color={
                feedView === "saved"
                  ? "#fff"
                  : isDarkTheme
                  ? "#e8ecf4"
                  : "#273143"
              }
            />
            <Text
              style={[
                styles.feedViewSwitchText,
                isDarkTheme && styles.feedViewSwitchTextDark,
                feedView === "saved" && styles.feedViewSwitchTextActive,
              ]}
              numberOfLines={1}
            >
              Saved{savedEvents.length ? ` (${savedEvents.length})` : ""}
            </Text>
          </Pressable>
        </View>

        {feedView === "saved" ? (() => {
          const upcomingSaved = feedSavedTabEvents.filter(
            (e) => (e.date || "") >= today && !isEventPastNow(e)
          );
          const pastSaved = feedSavedTabEvents.filter(
            (e) => !((e.date || "") >= today && !isEventPastNow(e))
          );
          if (feedSavedTabEvents.length === 0) {
            return (
              <View style={[styles.discoverSection, { paddingTop: 4 }]}>
                <View style={[styles.feedSavedEmptyCard, isDarkTheme && styles.feedSavedEmptyCardDark]}>
                  <Text style={[styles.feedSavedEmptyTitle, isDarkTheme && { color: "#f4f7ff" }]}>
                    Nothing saved yet
                  </Text>
                  <Text style={[styles.feedSavedEmptySub, isDarkTheme && { color: "#aebcdc" }]}>
                    Tap the heart on any event to save it, or RSVP going/interested
                    — everything will collect here for easy access.
                  </Text>
                  <Pressable
                    {...PRESSABLE_INSTANT}
                    onPress={() => setFeedView("all")}
                    style={styles.feedSavedEmptyBtn}
                  >
                    <Text style={styles.feedSavedEmptyBtnText}>Browse Your Feed</Text>
                  </Pressable>
                </View>
              </View>
            );
          }
          return (
            <View style={styles.discoverSection}>
              {upcomingSaved.length ? (
                <>
                  <Text style={[styles.discoverSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>
                    Upcoming · {upcomingSaved.length}
                  </Text>
                  <Text style={[styles.discoverSectionSub, isDarkTheme && { color: "#9db0db" }]}>
                    Events you saved or RSVP'd to that haven't happened yet.
                  </Text>
                  {upcomingSaved.map((event, idx) => (
                    <View key={`feed-saved-up-${eventStorageKey(event)}-${idx}`}>
                      {renderEventListCard(event, `feed-saved-up-${idx}`)}
                    </View>
                  ))}
                </>
              ) : null}
              {pastSaved.length ? (
                <>
                  <Text
                    style={[
                      styles.discoverSectionTitle,
                      isDarkTheme && { color: "#f4f7ff" },
                      { marginTop: upcomingSaved.length ? 18 : 0 },
                    ]}
                  >
                    Past · {pastSaved.length}
                  </Text>
                  <Text style={[styles.discoverSectionSub, isDarkTheme && { color: "#9db0db" }]}>
                    Previously saved events, kept here for reference.
                  </Text>
                  {pastSaved.map((event, idx) => (
                    <View key={`feed-saved-past-${eventStorageKey(event)}-${idx}`}>
                      {renderEventListCard(event, `feed-saved-past-${idx}`)}
                    </View>
                  ))}
                </>
              ) : null}
            </View>
          );
        })() : null}

        {feedView === "all" ? (
        <>
        <View style={styles.discoverSection}>
          {feedTopicOptions.length ? (
            <View style={styles.feedTopicRow}>
              <Pressable
                {...PRESSABLE_INSTANT}
                style={[
                  styles.feedTopicChip,
                  isDarkTheme && styles.feedTopicChipDark,
                  isNeo && styles.feedTopicChipNeo,
                  isEmerald && styles.feedTopicChipEmerald,
                  !feedTopicFilter && styles.feedTopicChipActive,
                  isDarkTheme && !feedTopicFilter && styles.feedTopicChipActiveDark,
                ]}
                onPress={() => setFeedTopicFilter(null)}
              >
                <Text
                  style={[
                    styles.feedTopicChipText,
                    isDarkTheme && styles.feedTopicChipTextDark,
                    isNeo && styles.feedTopicChipTextNeo,
                    isEmerald && styles.feedTopicChipTextEmerald,
                    !feedTopicFilter && styles.feedTopicChipTextActive,
                    isDarkTheme && !feedTopicFilter && styles.feedTopicChipTextActiveDark,
                  ]}
                >
                  All topics
                </Text>
              </Pressable>
              {feedTopicOptions.map((topic, idx) => {
                const active = feedTopicFilter === topic;
                return (
                  <Pressable
                    {...PRESSABLE_INSTANT}
                    key={`feed-topic-${topic}-${idx}`}
                    style={[
                      styles.feedTopicChip,
                      isDarkTheme && styles.feedTopicChipDark,
                      isNeo && styles.feedTopicChipNeo,
                      isEmerald && styles.feedTopicChipEmerald,
                      active && styles.feedTopicChipActive,
                      isDarkTheme && active && styles.feedTopicChipActiveDark,
                    ]}
                    onPress={() => setFeedTopicFilter((prev) => (prev === topic ? null : topic))}
                  >
                    <Text
                      style={[
                        styles.feedTopicChipText,
                        isDarkTheme && styles.feedTopicChipTextDark,
                        isNeo && styles.feedTopicChipTextNeo,
                        isEmerald && styles.feedTopicChipTextEmerald,
                        active && styles.feedTopicChipTextActive,
                        isDarkTheme && active && styles.feedTopicChipTextActiveDark,
                      ]}
                    >
                      {topic}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}
        </View>
        {false ? (
          <View style={styles.discoverSection}>
            <View style={styles.feedBuilderCard}>
            <Text style={[styles.discoverSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>Build Your Feed</Text>
            <Text style={[styles.discoverSectionSub, isDarkTheme && { color: "#9db0db" }]}>
              Choose masjids, speakers, and topics first. Then your feed below is fully personalized.
            </Text>

            <Text style={[styles.feedBuilderStepLabel, isDarkTheme && styles.feedBuilderStepLabelDark]}>
              1) Which masjids do you want to see?
            </Text>
            {feedFollowedMasjidSummaries.length > 0 ? (
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                style={{ flexGrow: 0 }}
                contentContainerStyle={{ gap: 12, paddingVertical: 4, paddingRight: 8 }}
                {...IOS_SCROLL_INSTANT_TOUCH}
              >
                {feedFollowedMasjidSummaries.map((row) => {
                  const chips = discoverAmenityChips(row.amenitiesRec?.amenities, 3);
                  const next = row.nextEvent;
                  return (
                    <Pressable {...PRESSABLE_INSTANT}
                      key={`feed-fol-m-${row.source}`}
                      style={[styles.discoverFollowedMasjidCard, isDarkTheme && styles.discoverFollowedMasjidCardDark]}
                      onPress={() => setSelectedMasjidSheet(row.source)}
                    >
                      <View style={styles.discoverFollowedMasjidCardTop}>
                        {renderMasjidLogo(row.source, 40, {
                          style: styles.discoverFollowedMasjidLogo,
                          textStyle: styles.discoverMasjidAvatarText,
                        })}
                        <View style={{ flex: 1, minWidth: 0 }}>
                          <Text style={[styles.discoverFollowedMasjidTitle, isDarkTheme && { color: "#f4f7ff" }]} numberOfLines={2}>
                            {formatSourceLabel(row.source)}
                          </Text>
                          <Text style={[styles.discoverFollowedMasjidMeta, isDarkTheme && { color: "#9db0db" }]} numberOfLines={2}>
                            {row.upcomingCount} upcoming
                            {next?.date ? ` · next ${formatHumanDate(next.date)}` : ""}
                          </Text>
                        </View>
                      </View>
                      {chips.length > 0 ? (
                        <View style={styles.discoverFollowedMasjidChips}>
                          {chips.map((c) => (
                            <View key={`${row.source}-feed-chip-${c}`} style={[styles.discoverAmenityChip, isDarkTheme && styles.discoverAmenityChipDark]}>
                              <Text style={[styles.discoverAmenityChipText, isDarkTheme && { color: "#c4cee8" }]}>{c}</Text>
                            </View>
                          ))}
                        </View>
                      ) : null}
                      <Pressable {...PRESSABLE_INSTANT}
                        hitSlop={8}
                        onPress={(ev) => {
                          (ev as unknown as { stopPropagation?: () => void })?.stopPropagation?.();
                          toggleFollowMasjid(row.source);
                        }}
                        style={[styles.discoverFollowBtn, styles.feedInlineFollowBtn, styles.discoverFollowBtnActive]}
                      >
                        <Text style={[styles.discoverFollowText, styles.discoverFollowTextActive]}>✓ Following</Text>
                      </Pressable>
                    </Pressable>
                  );
                })}
              </ScrollView>
            ) : null}

            {feedUnfollowedMasjidBuckets.map((m) => (
              <Pressable {...PRESSABLE_INSTANT}
                key={`feed-masjid-${m.source}`}
                style={[styles.discoverMasjidRow, isDarkTheme && styles.discoverMasjidRowDark]}
                onPress={() => setSelectedMasjidSheet(m.source)}
              >
                {renderMasjidLogo(m.source, 44, { style: styles.discoverMasjidAvatar, textStyle: styles.discoverMasjidAvatarText })}
                <View style={{ flex: 1 }}>
                  <Text style={[styles.discoverMasjidTitle, isDarkTheme && { color: "#f4f7ff" }]} numberOfLines={1}>
                    {formatSourceLabel(m.source)}
                  </Text>
                  <Text style={[styles.discoverMasjidSub, isDarkTheme && { color: "#9db0db" }]} numberOfLines={1}>
                    {m.count} upcoming{m.distance != null ? ` · ${m.distance.toFixed(1)} mi` : ""}
                    {m.nextDate ? ` · next ${formatHumanDate(m.nextDate)}` : ""}
                  </Text>
                </View>
                <Pressable {...PRESSABLE_INSTANT}
                  hitSlop={10}
                  onPress={(ev) => {
                    (ev as unknown as { stopPropagation?: () => void })?.stopPropagation?.();
                    toggleFollowMasjid(m.source);
                  }}
                  onStartShouldSetResponder={() => true}
                  onResponderTerminationRequest={() => false}
                  style={[
                    styles.discoverFollowBtn,
                    followedMasjids.includes(m.source) && styles.discoverFollowBtnActive,
                  ]}
                >
                  <Text
                    style={[
                      styles.discoverFollowText,
                      followedMasjids.includes(m.source) && styles.discoverFollowTextActive,
                    ]}
                  >
                    {followedMasjids.includes(m.source) ? "✓ Following" : "+ Follow"}
                  </Text>
                </Pressable>
              </Pressable>
            ))}

            <Text style={[styles.feedBuilderStepLabel, isDarkTheme && styles.feedBuilderStepLabelDark, { marginTop: 12 }]}>
              2) Which speakers do you want?
            </Text>
            <FlatList
              data={feedSpeakerCards}
              keyExtractor={(s) => `feed-scholar-${s.slug}`}
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ height: 326, flexGrow: 0 }}
              contentContainerStyle={{ paddingHorizontal: 2, paddingVertical: 4, gap: 12 }}
              initialNumToRender={4}
              maxToRenderPerBatch={4}
              windowSize={5}
              nestedScrollEnabled
              removeClippedSubviews={false}
              renderItem={({ item: sp }) => {
                const following = followedScholarSlugSet.has(sp.slug);
                const nextDate = sp.next_date || null;
                return (
                  <Pressable
                    {...PRESSABLE_INSTANT}
                    style={[styles.discoverScholarCard, isDarkTheme && styles.discoverScholarCardDark]}
                    onPress={() => {
                      setSelectedSpeaker(sp.slug);
                      setScholarScreenOpen(true);
                    }}
                  >
                    <View style={styles.discoverScholarAvatarWrap}>
                      {sp.image_url && canRenderPoster(sp.image_url) ? (
                        <LoadableNetworkImage
                          uri={sp.image_url}
                          style={styles.discoverScholarAvatar}
                          onError={() => markPosterFailed(sp.image_url || "")}
                        />
                      ) : (
                        <View style={[styles.discoverScholarAvatar, { backgroundColor: "#ffe3d1", alignItems: "center", justifyContent: "center" }]}>
                          <Text style={{ color: "#9b4a1b", fontWeight: "900", fontSize: 20 }}>
                            {cleanSpeakerName(sp.name).split(" ").map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase()}
                          </Text>
                        </View>
                      )}
                    </View>
                    <Text style={[styles.discoverScholarName, isDarkTheme && { color: "#f4f7ff" }]} numberOfLines={2}>{cleanSpeakerName(sp.name)}</Text>
                    <Text style={[styles.discoverScholarSub, isDarkTheme && { color: "#9db0db" }]} numberOfLines={1}>
                      {sp.upcoming_events || 0} upcoming talk{(sp.upcoming_events || 0) === 1 ? "" : "s"}
                    </Text>
                    {nextDate ? (
                      <Text style={[styles.discoverScholarNext, isDarkTheme && { color: "#c4cee8" }]} numberOfLines={1}>
                        Next: {formatHumanDate(nextDate)}
                      </Text>
                    ) : null}
                    <Pressable {...PRESSABLE_INSTANT}
                      onPress={(ev) => {
                        (ev as unknown as { stopPropagation?: () => void })?.stopPropagation?.();
                        toggleFollowScholar(sp.slug);
                      }}
                      onStartShouldSetResponder={() => true}
                      onResponderTerminationRequest={() => false}
                      style={[styles.discoverFollowBtn, following && styles.discoverFollowBtnActive]}
                    >
                      <Text style={[styles.discoverFollowText, following && styles.discoverFollowTextActive]}>
                        {following ? "✓ Following" : "+ Follow"}
                      </Text>
                    </Pressable>
                  </Pressable>
                );
              }}
            />

            <Text style={[styles.feedBuilderStepLabel, isDarkTheme && styles.feedBuilderStepLabelDark, { marginTop: 10 }]}>
              3) Which topics do you want?
            </Text>
            {feedTopicOptions.length ? (
              <View style={styles.feedTopicRow}>
                <Pressable {...PRESSABLE_INSTANT}
                  style={[
                    styles.feedTopicChip,
                    isDarkTheme && styles.feedTopicChipDark,
                    isNeo && styles.feedTopicChipNeo,
                    isEmerald && styles.feedTopicChipEmerald,
                    !feedTopicFilter && styles.feedTopicChipActive,
                    isDarkTheme && !feedTopicFilter && styles.feedTopicChipActiveDark,
                  ]}
                  onPress={() => setFeedTopicFilter(null)}
                >
                  <Text
                    style={[
                      styles.feedTopicChipText,
                      isDarkTheme && styles.feedTopicChipTextDark,
                      isNeo && styles.feedTopicChipTextNeo,
                      isEmerald && styles.feedTopicChipTextEmerald,
                      !feedTopicFilter && styles.feedTopicChipTextActive,
                      isDarkTheme && !feedTopicFilter && styles.feedTopicChipTextActiveDark,
                    ]}
                  >
                    All topics
                  </Text>
                </Pressable>
                {feedTopicOptions.map((topic, idx) => {
                  const active = feedTopicFilter === topic;
                  return (
                    <Pressable {...PRESSABLE_INSTANT}
                      key={`feed-topic-${topic}-${idx}`}
                      style={[
                        styles.feedTopicChip,
                        isDarkTheme && styles.feedTopicChipDark,
                        isNeo && styles.feedTopicChipNeo,
                        isEmerald && styles.feedTopicChipEmerald,
                        active && styles.feedTopicChipActive,
                        isDarkTheme && active && styles.feedTopicChipActiveDark,
                      ]}
                      onPress={() => setFeedTopicFilter((prev) => (prev === topic ? null : topic))}
                    >
                      <Text
                        style={[
                          styles.feedTopicChipText,
                          isDarkTheme && styles.feedTopicChipTextDark,
                          isNeo && styles.feedTopicChipTextNeo,
                          isEmerald && styles.feedTopicChipTextEmerald,
                          active && styles.feedTopicChipTextActive,
                          isDarkTheme && active && styles.feedTopicChipTextActiveDark,
                        ]}
                      >
                        {topic}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            ) : null}
          </View>
        </View>
        ) : null}

        {feedSection(
          "From Masjids You Follow",
          followedMasjids.length
            ? `${followedMasjids.length} followed masjid${followedMasjids.length === 1 ? "" : "s"} powering this section.`
            : "Follow masjids in Discover and they will show up here first.",
          followedMasjidFeedEvents,
          "feed-masjid",
          "No upcoming events yet from your followed masjids."
        )}

        {feedSection(
          "From Scholars You Follow",
          followedScholars.length
            ? "New and upcoming sessions from the speakers you care about."
            : "Follow scholars in Discover to unlock this section.",
          followedScholarFeedEvents,
          "feed-scholars",
          "No upcoming sessions found from followed scholars right now."
        )}

        {feedSection(
          "For You Today",
          "Top picks ranked by your follows, intent, and what is coming up next.",
          forYouFeedEvents,
          "feed-for-you",
          "Follow a few masjids or scholars and your top picks will appear here."
        )}

        {feedSection(
          "Because You're Interested In",
          feedTopicFilter
            ? `Showing results for “${feedTopicFilter}”.`
            : "Events matched against your selected interests and topics.",
          interestFeedEvents,
          "feed-interest",
          "Pick interests during setup (or in onboarding) to personalize this section."
        )}

        {feedSection(
          "Saved & RSVP",
          "Quick access to events you hearted or marked as going/interested.",
          savedAndRsvpFeedEvents,
          "feed-saved-rsvp",
          "You have not saved or RSVP'd to anything yet. Tap heart or RSVP on any event."
        )}
        </>
        ) : null}
      </ScrollView>
    );
  };

  const renderDiscover = () => {
    // A curated front door: scholars first (the people), then collections
    // (editorially-framed lists), then masjids (followed + near you).
    // We intentionally do NOT show every event here — that's what Explore and
    // Calendar are for. Discover is about *who* and *what scenes* exist.
    const upcomingForSpeaker = (slug: string): EventItem[] => {
      const target = (slug || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      if (!target) return [];
      return orderedVisibleEvents
        .filter((e) => {
          const line = effectiveEventSpeakerName(e).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
          return line && eventLineMatchesSpeakerSlug(line, target);
        })
        .filter((e) => (e.date || "") >= today && !isEventPastNow(e))
        .slice(0, 3);
    };

    const deriveDiscoverSpeakersFromEvents = (): Speaker[] => {
      const agg = new Map<string, Speaker>();
      for (const ev of orderedVisibleEvents) {
        const raw = effectiveEventSpeakerName(ev).trim();
        if (!raw) continue;
        const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        if (!slug) continue;
        const cur = agg.get(slug) || { slug, name: raw, total_events: 0, upcoming_events: 0, sources: [] as string[] };
        cur.total_events += 1;
        if ((ev.date || "") >= today && !isEventPastNow(ev)) cur.upcoming_events += 1;
        const src = normalizeText(ev.source);
        if (src && !cur.sources.includes(src)) cur.sources.push(src);
        if (!cur.next_title || (ev.date || "") < (cur.next_date || "9999-12-31")) {
          cur.next_title = ev.title;
          cur.next_date = ev.date || null;
        }
        agg.set(slug, cur);
      }
      return [...agg.values()]
        .filter((s) => s.upcoming_events > 0 || s.total_events > 0)
        .sort((a, b) => (b.upcoming_events || 0) - (a.upcoming_events || 0));
    };

    const enrichSpeakerFromClientEvents = (s: Speaker): Speaker => {
      const target = (s.slug || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      if (!target) return s;
      let clientUp = 0;
      let clientTotal = 0;
      for (const e of orderedVisibleEvents) {
        const line = effectiveEventSpeakerName(e).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        if (!line || !eventLineMatchesSpeakerSlug(line, target)) continue;
        clientTotal += 1;
        if ((e.date || "") >= today && !isEventPastNow(e)) clientUp += 1;
      }
      return {
        ...s,
        upcoming_events: Math.max(s.upcoming_events || 0, clientUp),
        total_events: Math.max(s.total_events || 0, clientTotal),
      };
    };

    // Prefer /api/speakers, but always reconcile counts with the events the user
    // actually has loaded (API cache / radius / timing can disagree). If the API
    // list is empty, derive the rail from events so Discover matches "See all".
    const baseDiscoverSpeakers: Speaker[] = speakers.length ? speakers : deriveDiscoverSpeakersFromEvents();
    const mergedDiscoverSpeakers = baseDiscoverSpeakers.map(enrichSpeakerFromClientEvents);
    const topSpeakers = [...mergedDiscoverSpeakers]
      .map((s) => {
        const name = finalizeScholarCandidate(cleanSpeakerName(s.name));
        if (!name) return null;
        return enrichDiscoverPosterFromEvents({ ...s, name }, orderedVisibleEvents);
      })
      .filter((s): s is Speaker => s != null)
      .filter((s) => (s.upcoming_events || 0) > 0 || (s.total_events || 0) > 0)
      .sort(
        (a, b) =>
          (b.upcoming_events || 0) - (a.upcoming_events || 0) ||
          (b.total_events || 0) - (a.total_events || 0),
      )
      .slice(0, 12);

    const todayIso = today;
    const weekendStart = (() => {
      const d = new Date();
      while (d.getDay() !== 5 && d.getDay() !== 6) d.setDate(d.getDate() + 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    })();
    const weekendEnd = (() => {
      const d = new Date(weekendStart);
      d.setDate(d.getDate() + 1);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    })();

    type Collection = { id: string; title: string; sub: string; match: (e: EventItem) => boolean };
    const collections: Collection[] = [
      {
        id: "tonight",
        title: "Tonight",
        sub: "Walk in now or pray Maghrib there",
        match: (e: EventItem) => (e.date || "") === todayIso && !isEventPastNow(e),
      },
      {
        id: "this-weekend",
        title: "This weekend",
        sub: "Family-friendly halaqahs across NJ",
        match: (e: EventItem) => (e.date || "") === weekendStart || (e.date || "") === weekendEnd,
      },
      {
        id: "youth",
        title: "For youth",
        sub: "Circles, sports nights, mentor hangouts",
        match: (e: EventItem) => /\b(youth|teen|kids?|junior|students?)\b/i.test(`${e.title} ${e.description || ""}`),
      },
      {
        id: "women",
        title: "Women's halaqahs",
        sub: "Sisters-only gatherings & tafsir",
        match: (e: EventItem) => /\b(women|sister|sisters|ladies|lady)\b/i.test(`${e.title} ${e.description || ""}`),
      },
      {
        id: "tafsir",
        title: "Qur'an & Tafsir",
        sub: "Book of Allah, verse by verse",
        match: (e: EventItem) => /\b(tafsir|qur'?an|quran|tajweed|qira'?ah)\b/i.test(`${e.title} ${e.description || ""}`),
      },
      {
        id: "seerah",
        title: "Seerah & Sirah",
        sub: "The Prophet's life (peace be upon him)",
        match: (e: EventItem) => /\b(seerah|sirah|madinah era|madani era|meccan era|prophet'?s life)\b/i.test(`${e.title} ${e.description || ""}`),
      },
      {
        id: "for-reverts",
        title: "For reverts",
        sub: "Open, beginner-friendly, no Arabic needed",
        match: (e: EventItem) => /\b(revert|new muslim|islam 101|introduction to|beginner)\b/i.test(`${e.title} ${e.description || ""}`),
      },
      {
        id: "free",
        title: "Completely free",
        sub: "No ticket, just show up",
        match: (e: EventItem) => /\bfree\b/i.test(`${e.title} ${e.description || ""}`) && !/\$\d+|ticket|paid|registration/i.test(`${e.title} ${e.description || ""}`),
      },
    ];
    const collectionsWithCounts = collections
      .map((c) => ({ ...c, count: orderedVisibleEvents.filter((e) => c.match(e) && (e.date || "") >= todayIso && !isEventPastNow(e)).length }))
      .filter((c) => c.count > 0);

    const followedSet = new Set(followedMasjids.map((s) => s.toLowerCase()));

    const followedMasjidSummaries = followedMasjids
      .map((raw) => {
        const source = normalizeText(raw);
        if (!source) return null;
        const lc = source.toLowerCase();
        const upcoming = orderedVisibleEvents
          .filter(
            (e) =>
              normalizeText(e.source).toLowerCase() === lc &&
              (e.date || "") >= todayIso &&
              !isEventPastNow(e),
          )
          .sort((a, b) =>
            `${a.date || ""} ${a.start_time || "99:99"}`.localeCompare(
              `${b.date || ""} ${b.start_time || "99:99"}`,
            ),
          );
        return {
          source,
          upcomingCount: upcoming.length,
          nextEvent: upcoming[0],
          amenitiesRec: masjidAmenities[lc],
        };
      })
      .filter((row): row is NonNullable<typeof row> => row != null);

    const unfollowedMasjidBuckets = (() => {
      const byMasjid = new Map<string, { source: string; count: number; nextDate?: string; distance?: number }>();
      for (const e of orderedVisibleEvents) {
        const src = normalizeText(e.source);
        if (!src || followedSet.has(src.toLowerCase())) continue;
        if ((e.date || "") < todayIso || isEventPastNow(e)) continue;
        const cur = byMasjid.get(src) || { source: src, count: 0, distance: typeof e.distance_miles === "number" ? e.distance_miles : undefined };
        cur.count += 1;
        if (!cur.nextDate || (e.date || "") < cur.nextDate) cur.nextDate = e.date;
        if (cur.distance == null && typeof e.distance_miles === "number") cur.distance = e.distance_miles;
        byMasjid.set(src, cur);
      }
      return [...byMasjid.values()]
        .sort((a, b) => {
          if (a.distance != null && b.distance != null && a.distance !== b.distance) return a.distance - b.distance;
          return b.count - a.count;
        })
        .slice(0, 12);
    })();

    return (
      <ScrollView
        contentContainerStyle={[styles.scrollBody, isMidnight && styles.scrollBodyMidnight, isNeo && styles.scrollBodyNeo, isVitaria && styles.scrollBodyVitaria, isInferno && styles.scrollBodyInferno, isEmerald && styles.scrollBodyEmerald]}
        {...IOS_SCROLL_INSTANT_TOUCH}
      >
        <LinearGradient
          colors={isMidnight ? ["#0c0f19", "#151b2a"] : isNeo ? ["#d8d8d8", "#d2d2d2"] : isVitaria ? ["#8f7680", "#b3949d"] : isInferno ? ["#070607", "#1b0901"] : isEmerald ? ["#b8e5c9", "#8fd5ad"] : ["#f0f2f7", "#e8ebf3"]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={styles.premiumSectionHeader}
        >
          <Text style={[styles.premiumSectionTitle, isDarkTheme && styles.premiumSectionTitleDark, isNeo && styles.premiumSectionTitleNeo]}>Discover</Text>
          <Text style={[styles.premiumSectionSub, isDarkTheme && styles.premiumSectionSubDark, isNeo && styles.premiumSectionSubNeo]}>
            Scholars, halaqahs, and masjids waiting for your first visit.
          </Text>
        </LinearGradient>

        {(() => {
          const nextClosest = jumuahFinderRows
            .flatMap((row) => (Array.isArray(row.jumuah) ? row.jumuah.map((slot: any) => ({ row, slot })) : []))
            .filter((x) => typeof x.slot?.minutes_until === "number" && x.slot.minutes_until >= -20)
            .sort((a, b) => Number(a.slot.minutes_until) - Number(b.slot.minutes_until))[0];
          return (
            <View style={[styles.hospitalListCard, { marginHorizontal: 12, marginBottom: 10 }]}>
              <Text style={[styles.hospitalListTitle, isDarkTheme && styles.hospitalListTitleDark]}>Jumu'ah finder</Text>
              <Text style={[styles.hospitalListMeta, isDarkTheme && styles.hospitalListMetaDark]}>
                {nextClosest
                  ? `${formatSourceLabel(nextClosest.row.source)} · starts in ${Math.max(0, Number(nextClosest.slot.minutes_until))} min`
                  : "Find Friday khutbah by language, time, distance, and parking."}
              </Text>
              <View style={[styles.modalActionsRow, { marginTop: 8 }]}>
                <Pressable {...PRESSABLE_INSTANT} style={styles.roundGhostBtn} onPress={() => setShowJumuahFinder(true)}>
                  <Text style={styles.roundGhostText}>Open finder</Text>
                </Pressable>
                <Pressable {...PRESSABLE_INSTANT} style={styles.roundGhostBtn} onPress={() => void refreshJumuahFinder()}>
                  <Text style={styles.roundGhostText}>Refresh</Text>
                </Pressable>
              </View>
            </View>
          );
        })()}

        {(() => {
          const weekEnd = plusDaysIso(7);
          const upcomingFollowed = followedScholars
            .flatMap((slug) => {
              const target = slug.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
              return orderedVisibleEvents.filter((e) => {
                const line = effectiveEventSpeakerName(e).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
                return line && eventLineMatchesSpeakerSlug(line, target);
              });
            })
            .filter((e) => (e.date || "") >= todayIso && (e.date || "") <= weekEnd)
            .slice(0, 6);
          if (!upcomingFollowed.length || !followedScholars.length) return null;
          return (
            <View style={styles.discoverFollowedScholarsCard}>
              <Text style={styles.discoverFollowedScholarsTitle}>
                Your scholars are teaching this week
              </Text>
              <Text style={styles.discoverFollowedScholarsSub}>
                {upcomingFollowed.length} upcoming talk{upcomingFollowed.length === 1 ? "" : "s"} from the teachers you follow.
              </Text>
              {upcomingFollowed.slice(0, 3).map((e, i) => (
                <Pressable
                  {...PRESSABLE_INSTANT}
                  key={`followed-sp-${i}-${eventStorageKey(e)}`}
                  style={styles.discoverFollowedScholarsRow}
                  onPress={() => openEventDetails(e)}
                >
                  <Text style={styles.discoverFollowedScholarsRowWho} numberOfLines={1}>
                    {effectiveEventSpeakerName(e) || "Speaker"}
                  </Text>
                  <Text style={styles.discoverFollowedScholarsRowWhat} numberOfLines={2}>
                    {eventDisplayTitle(e)}
                  </Text>
                  <Text style={styles.discoverFollowedScholarsRowWhen}>
                    {formatHumanDate(e.date)} · {eventTime(e)} · {formatSourceLabel(e.source)}
                  </Text>
                </Pressable>
              ))}
            </View>
          );
        })()}

        {/* Scholars & Speakers rail */}
        <View style={styles.discoverSection}>
          <View style={styles.discoverSectionHeader}>
            <Text style={[styles.discoverSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>Scholars & speakers</Text>
            <Pressable {...PRESSABLE_INSTANT} onPress={() => setScholarScreenOpen(true)} hitSlop={8}>
              <Text style={[styles.discoverSeeAll, isDarkTheme && { color: "#9db0db" }]}>See all →</Text>
            </Pressable>
          </View>
          <Text style={[styles.discoverSectionSub, isDarkTheme && { color: "#9db0db" }]}>
            Follow a teacher you love. We'll ping you when they speak near you.
          </Text>
          {topSpeakers.length === 0 ? (
            <View style={[styles.discoverEmpty, isDarkTheme && styles.discoverEmptyDark]}>
              <Text style={[styles.discoverEmptyText, isDarkTheme && { color: "#c4cee8" }]}>
                No upcoming scholars in your feed yet. Pull to refresh, or widen your radius.
              </Text>
            </View>
          ) : (
            <FlatList
              data={topSpeakers}
              keyExtractor={(s) => `scholar-${s.slug}`}
              horizontal
              showsHorizontalScrollIndicator={false}
              style={{ height: 328, flexGrow: 0 }}
              contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 4, gap: 12 }}
              initialNumToRender={4}
              maxToRenderPerBatch={4}
              windowSize={5}
              nestedScrollEnabled
              removeClippedSubviews={false}
              renderItem={({ item: sp }) => {
                const following = followedScholars.includes(sp.slug);
                const next = upcomingForSpeaker(sp.slug)[0];
                return (
                  <Pressable
                    {...PRESSABLE_INSTANT}
                    style={[styles.discoverScholarCard, isDarkTheme && styles.discoverScholarCardDark]}
                    onPress={() => {
                      setSelectedSpeaker(sp.slug);
                      setScholarScreenOpen(true);
                    }}
                  >
                    <View style={styles.discoverScholarAvatarWrap}>
                      {sp.image_url && canRenderPoster(sp.image_url) ? (
                        <LoadableNetworkImage
                          uri={sp.image_url}
                          style={styles.discoverScholarAvatar}
                          onError={() => markPosterFailed(sp.image_url || "")}
                        />
                      ) : (
                        <View style={[styles.discoverScholarAvatar, { backgroundColor: "#ffe3d1", alignItems: "center", justifyContent: "center" }]}>
                          <Text style={{ color: "#9b4a1b", fontWeight: "900", fontSize: 20 }}>
                            {cleanSpeakerName(sp.name).split(" ").map((p) => p[0]).filter(Boolean).slice(0, 2).join("").toUpperCase()}
                          </Text>
                        </View>
                      )}
                    </View>
                    <Text style={[styles.discoverScholarName, isDarkTheme && { color: "#f4f7ff" }]} numberOfLines={2}>{cleanSpeakerName(sp.name)}</Text>
                    <Text style={[styles.discoverScholarSub, isDarkTheme && { color: "#9db0db" }]} numberOfLines={1}>
                      {sp.upcoming_events} upcoming talk{sp.upcoming_events === 1 ? "" : "s"}
                    </Text>
                    {next?.date ? (
                      <Text style={[styles.discoverScholarNext, isDarkTheme && { color: "#c4cee8" }]} numberOfLines={1}>
                        Next: {formatHumanDate(next.date)}
                      </Text>
                    ) : null}
                    <Pressable {...PRESSABLE_INSTANT}
                      onPress={(ev) => {
                        // Belt & braces: RN's responder system normally has
                        // the inner Pressable win, but on some Android builds
                        // the outer card's onPress can still fire. Guard it.
                        (ev as unknown as { stopPropagation?: () => void })?.stopPropagation?.();
                        toggleFollowScholar(sp.slug);
                      }}
                      onStartShouldSetResponder={() => true}
                      onResponderTerminationRequest={() => false}
                      hitSlop={10}
                      style={[styles.discoverScholarFollowBtn, following && styles.discoverScholarFollowBtnActive]}
                    >
                      <Text style={[styles.discoverScholarFollowText, following && styles.discoverScholarFollowTextActive]}>
                        {following ? "✓ Following" : "+ Follow"}
                      </Text>
                    </Pressable>
                  </Pressable>
                );
              }}
            />
          )}
        </View>

        {/* Curated collections */}
        {collectionsWithCounts.length ? (
          <View style={styles.discoverSection}>
            <Text style={[styles.discoverSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>Collections</Text>
            <Text style={[styles.discoverSectionSub, isDarkTheme && { color: "#9db0db" }]}>
              Editorial picks — tap to browse.
            </Text>
            <View style={styles.collectionGrid}>
              {collectionsWithCounts.map((c) => (
                <Pressable {...PRESSABLE_INSTANT}
                  key={`coll-${c.id}`}
                  style={[styles.collectionTile, isDarkTheme && styles.collectionTileDark]}
                  onPress={() => {
                    // Build the concrete event list this collection maps to
                    // and open a preview modal. We also remember a matching
                    // Explore handoff (filter settings) for collections that
                    // have a 1:1 filter, so the user can jump into Explore
                    // from the modal if they want the full ranked list.
                    const matchedEvents = orderedVisibleEvents
                      .filter((e) => c.match(e) && (e.date || "") >= todayIso && !isEventPastNow(e))
                      .sort((a, b) =>
                        `${a.date || "9999-12-31"} ${a.start_time || "99:99"}`.localeCompare(
                          `${b.date || "9999-12-31"} ${b.start_time || "99:99"}`,
                        ),
                      );
                    let exploreHandoff: { halaqa?: string | null; quick?: QuickFilterId[] } | undefined;
                    if (c.id === "youth") exploreHandoff = { halaqa: "youth" };
                    else if (c.id === "tafsir") exploreHandoff = { halaqa: "tafsir" };
                    else if (c.id === "seerah") exploreHandoff = { halaqa: "seerah" };
                    else if (c.id === "women") exploreHandoff = { quick: ["women"] };
                    else if (c.id === "free") exploreHandoff = { quick: ["free"] };
                    hapticTap("selection");
                    setCollectionPreview({
                      id: c.id,
                      title: c.title,
                      sub: c.sub,
                      events: matchedEvents,
                      exploreHandoff,
                    });
                  }}
                >
                  <Text style={[styles.collectionTileTitle, isDarkTheme && { color: "#f4f7ff" }]}>{c.title}</Text>
                  <Text style={[styles.collectionTileSub, isDarkTheme && { color: "#9db0db" }]} numberOfLines={2}>{c.sub}</Text>
                  <Text style={[styles.collectionTileCount, isDarkTheme && { color: "#c4cee8" }]}>{c.count} event{c.count === 1 ? "" : "s"}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : null}

        {/* Masjids — below collections: followed masjids get rich cards;
            everyone else appears under "More near you". */}
        {followedMasjidSummaries.length > 0 || unfollowedMasjidBuckets.length > 0 ? (
          <View style={styles.discoverSection}>
            <View style={styles.discoverSectionHeader}>
              <Text style={[styles.discoverSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>Masjids</Text>
              <Pressable {...PRESSABLE_INSTANT} onPress={() => { hapticTap("selection"); switchTab("explore"); }} hitSlop={8}>
                <Text style={[styles.discoverSeeAll, isDarkTheme && { color: "#9db0db" }]}>Map & list →</Text>
              </Pressable>
            </View>
            <Text style={[styles.discoverSectionSub, isDarkTheme && { color: "#9db0db" }]}>
              Follow masjids you care about — programs, amenities, and what's next on the calendar.
            </Text>

            {followedMasjidSummaries.length > 0 ? (
              <>
                <Text style={[styles.discoverSubsectionLabel, isDarkTheme && styles.discoverSubsectionLabelDark]}>
                  Masjids you follow
                </Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={{ flexGrow: 0 }}
                  contentContainerStyle={{ gap: 12, paddingVertical: 6, paddingRight: 8 }}
                  {...IOS_SCROLL_INSTANT_TOUCH}
                >
                  {followedMasjidSummaries.map((row) => {
                    const chips = discoverAmenityChips(row.amenitiesRec?.amenities, 3);
                    const desc = (row.amenitiesRec?.description || "").trim();
                    const shortDesc = desc.length > 80 ? `${desc.slice(0, 78)}…` : desc;
                    const next = row.nextEvent;
                    return (
                      <Pressable {...PRESSABLE_INSTANT}
                        key={`fol-m-${row.source}`}
                        style={[styles.discoverFollowedMasjidCard, isDarkTheme && styles.discoverFollowedMasjidCardDark]}
                        onPress={() => setSelectedMasjidSheet(row.source)}
                      >
                        <View style={styles.discoverFollowedMasjidCardTop}>
                          {renderMasjidLogo(row.source, 40, {
                            style: styles.discoverFollowedMasjidLogo,
                            textStyle: styles.discoverMasjidAvatarText,
                          })}
                          <View style={{ flex: 1, minWidth: 0 }}>
                            <Text style={[styles.discoverFollowedMasjidTitle, isDarkTheme && { color: "#f4f7ff" }]} numberOfLines={2}>
                              {formatSourceLabel(row.source)}
                            </Text>
                            <Text style={[styles.discoverFollowedMasjidMeta, isDarkTheme && { color: "#9db0db" }]} numberOfLines={2}>
                              {row.upcomingCount} upcoming
                              {next?.date ? ` · next ${formatHumanDate(next.date)}` : ""}
                            </Text>
                          </View>
                        </View>
                        {chips.length > 0 ? (
                          <View style={styles.discoverFollowedMasjidChips}>
                            {chips.map((c) => (
                              <View
                                key={`${row.source}-chip-${c}`}
                                style={[styles.discoverAmenityChip, isDarkTheme && styles.discoverAmenityChipDark]}
                              >
                                <Text style={[styles.discoverAmenityChipText, isDarkTheme && { color: "#c4cee8" }]}>{c}</Text>
                              </View>
                            ))}
                          </View>
                        ) : null}
                        {shortDesc ? (
                          <Text style={[styles.discoverFollowedMasjidBlurb, isDarkTheme && { color: "#9db0db" }]} numberOfLines={2}>
                            {shortDesc}
                          </Text>
                        ) : null}
                        {next ? (
                          <Text style={[styles.discoverFollowedMasjidNext, isDarkTheme && { color: "#c4cee8" }]} numberOfLines={2}>
                            Next event: {next.title}
                          </Text>
                        ) : null}
                      </Pressable>
                    );
                  })}
                </ScrollView>
              </>
            ) : null}

            {unfollowedMasjidBuckets.length > 0 ? (
              <>
                <Text
                  style={[
                    styles.discoverSubsectionLabel,
                    isDarkTheme && styles.discoverSubsectionLabelDark,
                    { marginTop: followedMasjidSummaries.length > 0 ? 16 : 0 },
                  ]}
                >
                  More near you
                </Text>
                <Text style={[styles.discoverSectionSub, isDarkTheme && { color: "#9db0db" }, { marginTop: 2, marginBottom: 8 }]}>
                  Masjids in your area you don't follow yet — tap for full profile.
                </Text>
                {unfollowedMasjidBuckets.map((m) => (
                  <Pressable {...PRESSABLE_INSTANT}
                    key={`disc-masjid-${m.source}`}
                    style={[styles.discoverMasjidRow, isDarkTheme && styles.discoverMasjidRowDark]}
                    onPress={() => setSelectedMasjidSheet(m.source)}
                  >
                    {renderMasjidLogo(m.source, 44, { style: styles.discoverMasjidAvatar, textStyle: styles.discoverMasjidAvatarText })}
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.discoverMasjidTitle, isDarkTheme && { color: "#f4f7ff" }]} numberOfLines={1}>
                        {formatSourceLabel(m.source)}
                      </Text>
                      <Text style={[styles.discoverMasjidSub, isDarkTheme && { color: "#9db0db" }]} numberOfLines={1}>
                        {m.count} upcoming{m.distance != null ? ` · ${m.distance.toFixed(1)} mi` : ""}
                        {m.nextDate ? ` · next ${formatHumanDate(m.nextDate)}` : ""}
                      </Text>
                    </View>
                    <Pressable {...PRESSABLE_INSTANT}
                      hitSlop={10}
                      onPress={(ev) => {
                        (ev as unknown as { stopPropagation?: () => void })?.stopPropagation?.();
                        toggleFollowMasjid(m.source);
                      }}
                      onStartShouldSetResponder={() => true}
                      onResponderTerminationRequest={() => false}
                      style={[
                        styles.discoverFollowBtn,
                        followedMasjids.includes(m.source) && styles.discoverFollowBtnActive,
                      ]}
                    >
                      <Text
                        style={[
                          styles.discoverFollowText,
                          followedMasjids.includes(m.source) && styles.discoverFollowTextActive,
                        ]}
                      >
                        {followedMasjids.includes(m.source) ? "✓ Following" : "+ Follow"}
                      </Text>
                    </Pressable>
                  </Pressable>
                ))}
              </>
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    );
  };

  // Redesigned Settings screen: iOS-style grouped list with profile hero,
  // bold category sections, and every item actionable (tap-to-edit, toggle,
  // or deep-link). Includes legal links (Privacy, Terms) and clean About.
  const renderSettings = () => {
    const rowProps = {
      chevron: isDarkTheme ? "#5c6c8c" : "#c8cdd8",
      textColor: isDarkTheme ? "#f4f7ff" : "#1b2333",
      subColor: isDarkTheme ? "#9db0db" : "#7a859b",
    };
    const SettingsRow = ({
      icon,
      label,
      value,
      onPress,
      danger,
      last,
    }: { icon: string; label: string; value?: string; onPress: () => void; danger?: boolean; last?: boolean }) => {
      const iconIsMi = (icon as string) in MI_ICONS;
      const miTint = danger ? "#c94620" : (isDarkTheme ? "#e8ecf4" : "#273143");
      return (
      <Pressable
        {...PRESSABLE_INSTANT}
        onPress={() => { onPress(); hapticTap("selection"); }}
        style={[styles.settingsRow, last && styles.settingsRowLast, isDarkTheme && styles.settingsRowDark]}
      >
        <View style={[styles.settingsRowIcon, isDarkTheme && styles.settingsRowIconDark]}>
          {iconIsMi ? (
            <Mi name={icon as MiName} size={20} color={miTint} />
          ) : (
            <Text style={[styles.settingsRowIconText, emojiFontStyle]}>{icon}</Text>
          )}
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.settingsRowLabel, { color: danger ? "#c94620" : rowProps.textColor }]}>
            {label}
          </Text>
          {value ? (
            <Text style={[styles.settingsRowValue, { color: rowProps.subColor }]} numberOfLines={1}>
              {value}
            </Text>
          ) : null}
        </View>
        <Text style={[styles.settingsRowChevron, { color: rowProps.chevron }]}>›</Text>
      </Pressable>
      );
    };
    const SectionLabel = ({ children }: { children: any }) => (
      <Text style={[styles.settingsSectionLabel, isDarkTheme && { color: "#8aa3d4" }]}>
        {children}
      </Text>
    );
    const SectionCard = ({ children }: { children: any }) => (
      <View style={[styles.settingsSectionCard, isDarkTheme && styles.settingsSectionCardDark]}>
        {children}
      </View>
    );
    const currentThemeLabel =
      themeMode === "minera" ? "Light" :
      themeMode === "inferno" ? "Dark" :
      themeMode === "midnight" ? "Midnight" :
      themeMode === "emerald" ? "Emerald" :
      themeMode === "vitaria" ? "Vitaria" :
      themeMode === "neo" ? "Neo" : "Light";
    const seedSourceCount = Array.isArray(BUNDLED_SEED_META?.sources) ? BUNDLED_SEED_META.sources.length : 0;
    const seedEventCount =
      typeof (BUNDLED_SEED_META as any)?.event_count === "number"
        ? (BUNDLED_SEED_META as any).event_count
        : BUNDLED_SEED_EVENTS.length;
    const seedDataVersion = normalizeText((BUNDLED_SEED_META as any)?.data_version || "unknown");
    const seedGeneratedAtRaw = normalizeText((BUNDLED_SEED_META as any)?.generated_at_utc || "");
    const seedGeneratedAtLabel = (() => {
      if (!seedGeneratedAtRaw) return "Unknown";
      const parsed = new Date(seedGeneratedAtRaw);
      if (Number.isNaN(parsed.getTime())) return seedGeneratedAtRaw;
      return parsed.toLocaleString();
    })();
    const seedMinDate = normalizeText((BUNDLED_SEED_META as any)?.min_date || "");
    const seedMaxDate = normalizeText((BUNDLED_SEED_META as any)?.max_date || "");
    const upcomingJumuahBySource = new Map<string, EventItem>();
    for (const e of events) {
      if (!isJumuahEvent(e)) continue;
      if ((e.date || "") < today || isEventPastNow(e)) continue;
      const src = normalizeText(e.source).toLowerCase();
      if (!src) continue;
      const prev = upcomingJumuahBySource.get(src);
      if (!prev) {
        upcomingJumuahBySource.set(src, e);
        continue;
      }
      const nextKey = `${e.date || ""} ${e.start_time || "99:99"}`;
      const prevKey = `${prev.date || ""} ${prev.start_time || "99:99"}`;
      if (nextKey.localeCompare(prevKey) < 0) upcomingJumuahBySource.set(src, e);
    }
    const jumuahSettingsRows = (meta?.sources || [])
      .map((src) => {
        const sourceKey = normalizeText(src).toLowerCase();
        const iqRows = iqamaBySource[sourceKey] || {};
        const jumuahTimes = Array.from(
          new Set((iqRows["jumuah"]?.jumuah_times || []).map((x) => normalizeText(x)).filter(Boolean)),
        );
        const nextJumuah = upcomingJumuahBySource.get(sourceKey) || null;
        if (!jumuahTimes.length && !nextJumuah) return null;
        const nextLabel = nextJumuah
          ? `Next: ${formatHumanDate(nextJumuah.date)}${eventTime(nextJumuah) ? ` · ${eventTime(nextJumuah)}` : ""}`
          : "";
        const value = jumuahTimes.length
          ? `${jumuahTimes.join("  ·  ")}${nextLabel ? ` · ${nextLabel}` : ""}`
          : nextLabel;
        return { source: src, value };
      })
      .filter((row): row is { source: string; value: string } => !!row)
      .sort((a, b) => {
        const af = followedMasjids.some((m) => normalizeText(m).toLowerCase() === normalizeText(a.source).toLowerCase()) ? 0 : 1;
        const bf = followedMasjids.some((m) => normalizeText(m).toLowerCase() === normalizeText(b.source).toLowerCase()) ? 0 : 1;
        if (af !== bf) return af - bf;
        return formatSourceLabel(a.source).localeCompare(formatSourceLabel(b.source));
      });
    const scrollToJumuahSettings = () => {
      hapticTap("selection");
      settingsScrollRef.current?.scrollTo({
        y: Math.max(0, settingsJumuahOffsetRef.current - 8),
        animated: true,
      });
    };

    return (
      <ScrollView
        ref={settingsScrollRef}
        style={{ flex: 1 }}
        contentContainerStyle={[styles.settingsScrollBody, isDarkTheme && styles.settingsScrollBodyDark, { paddingBottom: insets.bottom + 110 }]}
        showsVerticalScrollIndicator={false}
        {...IOS_SCROLL_INSTANT_TOUCH}
      >
        {/* Profile hero */}
        <View style={[styles.settingsProfileHero, isDarkTheme && styles.settingsProfileHeroDark]}>
          <View style={styles.settingsProfileAvatar}>
            <Text style={styles.settingsProfileAvatarText}>
              {(personalization.name || currentUser?.email || "you").trim().slice(0, 1).toUpperCase()}
            </Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={[styles.settingsProfileName, isDarkTheme && { color: "#f4f7ff" }]}>
              {personalization.name || "Welcome, friend"}
            </Text>
            <Text style={[styles.settingsProfileSub, isDarkTheme && { color: "#9db0db" }]} numberOfLines={1}>
              {currentUser?.email || "Browsing as a guest"}
            </Text>
            <View style={styles.settingsProfileMetaRow}>
              <View style={styles.settingsProfileMetaChip}>
                <Text style={styles.settingsProfileMetaChipText}>{streakCount}/{goalCount} this month</Text>
              </View>
              <View style={styles.settingsProfileMetaChip}>
                <Text style={styles.settingsProfileMetaChipText}>{followedMasjids.length} following</Text>
              </View>
            </View>
          </View>
        </View>

        {/* Share Masjid.ly — keep near top so it doesn't get lost. */}
        <View style={styles.shareCard}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 6 }}>
            <View style={styles.shareCardIcon}>
              <Mi name="star_fill1" size={20} color="#fff" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.shareCardTitle}>Share Masjid.ly — win merch</Text>
              <Text style={styles.shareCardSub}>
                Invite friends, enter the monthly raffle
              </Text>
            </View>
          </View>
          <Text style={styles.shareCardBody}>
            Every friend who signs up with your code counts as a raffle entry.
            Top inviter each month wins official Masjid.ly merch —
            hoodie, beanie, dua journal. We'll DM the winner in-app.
          </Text>

          <View style={styles.shareCodePill}>
            <Text style={styles.shareCodePillLabel}>YOUR CODE</Text>
            <Text style={styles.shareCodePillValue}>{referralCode || "—"}</Text>
            <Pressable {...PRESSABLE_INSTANT}
              style={styles.shareCodeCopyBtn}
              hitSlop={8}
              onPress={() => {
                if (!referralCode) return;
                hapticTap("selection");
                Share.share({
                  title: "My Masjid.ly code",
                  message: referralCode,
                });
              }}
            >
              <Text style={styles.shareCodeCopyBtnText}>Share</Text>
            </Pressable>
          </View>

          <View style={styles.shareStatsRow}>
            <View style={styles.shareStatChip}>
              <Text style={styles.shareStatChipNum}>{referralWins}</Text>
              <Text style={styles.shareStatChipLabel}>friend{referralWins === 1 ? "" : "s"} joined</Text>
            </View>
            <View style={styles.shareStatChip}>
              <Text style={styles.shareStatChipNum}>{referralWins}</Text>
              <Text style={styles.shareStatChipLabel}>raffle entr{referralWins === 1 ? "y" : "ies"}</Text>
            </View>
          </View>

          <Pressable {...PRESSABLE_INSTANT}
            style={styles.shareCardBtn}
            onPress={() => {
              if (!referralCode) {
                Alert.alert("Still generating your code", "Give us a second and try again.");
                return;
              }
              Share.share({
                title: "Join me on Masjid.ly",
                message:
                  `Salaam — I've been using Masjid.ly to find masjid events, halaqahs, and speakers near me. Join with my code ${referralCode} and we both get entered into the monthly merch raffle.\n\nhttps://masjidly.app/invite/${referralCode}`,
              });
              hapticTap("success");
            }}
          >
            <Text style={styles.shareCardBtnText}>Share my code →</Text>
          </Pressable>

          {/* "Invited by" — can be set once during onboarding, or after
              the fact from here. Once set it becomes read-only (the
              inviter has already been credited). */}
          {referredByCode ? (
            <View style={styles.shareReferredBox}>
              <Text style={styles.shareReferredLabel}>Invited by</Text>
              <Text style={styles.shareReferredValue}>{referredByCode}</Text>
              <Text style={styles.shareReferredHint}>
                JazakAllahu khayran — your friend is entered in the raffle.
              </Text>
            </View>
          ) : (
            <View style={styles.shareReferredBox}>
              <Text style={styles.shareReferredLabel}>Got invited by a friend?</Text>
              <View style={styles.shareReferredInputRow}>
                <TextInput
                  value={referralInput}
                  onChangeText={(value) => {
                    setReferralInput(value.toUpperCase());
                    if (referralSavingState !== "idle") setReferralSavingState("idle");
                    if (referralSaveError) setReferralSaveError("");
                  }}
                  autoCapitalize="characters"
                  autoCorrect={false}
                  placeholder="M-AB12C"
                  placeholderTextColor="#a3aec6"
                  style={styles.shareReferredInput}
                />
                <Pressable {...PRESSABLE_INSTANT}
                  style={[styles.shareReferredSubmit, referralSavingState === "saving" && { opacity: 0.7 }]}
                  disabled={referralSavingState === "saving"}
                  onPress={async () => {
                    const saved = await commitReferralCode(referralInput);
                    if (saved) {
                      setReferralInput("");
                      Alert.alert(
                        "Code saved",
                        `Your friend's code ${saved} was recorded — they're entered into the raffle. JazakAllahu khayran.`,
                      );
                    }
                  }}
                >
                  <Text style={styles.shareReferredSubmitText}>
                    {referralSavingState === "saving" ? "Saving…" : "Save"}
                  </Text>
                </Pressable>
              </View>
              {referralSaveError ? (
                <Text style={styles.shareReferredError}>{referralSaveError}</Text>
              ) : null}
              <Text style={styles.shareReferredHint}>
                Enter their code so they get raffle credit. You can only set this once.
              </Text>
            </View>
          )}
        </View>

        <View style={styles.settingsQuickTabsRow}>
          <Pressable {...PRESSABLE_INSTANT}
            onPress={scrollToJumuahSettings}
            style={({ pressed }) => [
              styles.settingsQuickTabBtn,
              isDarkTheme && styles.settingsQuickTabBtnDark,
              pressed && styles.settingsQuickTabBtnPressed,
            ]}
          >
            <Mi name="schedule" size={15} color={isDarkTheme ? "#d9e4ff" : "#2d4066"} />
            <Text style={[styles.settingsQuickTabText, isDarkTheme && styles.settingsQuickTabTextDark]}>
              Jumu'ah
            </Text>
          </Pressable>
        </View>

        {/* ACCOUNT */}
        <SectionLabel>ACCOUNT</SectionLabel>
        <SectionCard>
          <SettingsRow
            icon="verified_user"
            label="Your profile"
            value={personalization.name ? "Name, interests & preferences" : "Tell us about yourself"}
            onPress={() => setEntryScreen("welcome")}
          />
          <SettingsRow
            icon="bookmark"
            label="Masjid Passport"
            value={`${passportStamps.length} of 24 masjids stamped`}
            onPress={() => setPassportOpen(true)}
            last
          />
        </SectionCard>

        {/* NOTIFICATIONS */}
        <SectionLabel>NOTIFICATIONS</SectionLabel>
        <SectionCard>
          <SettingsRow
            icon="mail"
            label="New events from followed masjids"
            value={profileDraft.notifications?.new_event_followed === false ? "Off" : "On"}
            onPress={() =>
              updateNotificationPreference(
                "new_event_followed",
                profileDraft.notifications?.new_event_followed === false,
              )
            }
          />
          <SettingsRow
            icon="schedule"
            label="Tonight after Maghrib digest"
            value={profileDraft.notifications?.tonight_after_maghrib === false ? "Off" : "On"}
            onPress={() =>
              updateNotificationPreference(
                "tonight_after_maghrib",
                profileDraft.notifications?.tonight_after_maghrib === false,
              )
            }
          />
          <SettingsRow
            icon="school"
            label="New talks from followed speakers"
            value={profileDraft.notifications?.followed_speakers === false ? "Off" : "On"}
            onPress={() =>
              updateNotificationPreference(
                "followed_speakers",
                profileDraft.notifications?.followed_speakers === false,
              )
            }
          />
          <SettingsRow
            icon="mosque"
            label="Prayer reminders"
            value={profileDraft.notifications?.prayer_reminders === false ? "Off" : "On — 15 min before Maghrib/Isha"}
            onPress={() =>
              updateNotificationPreference(
                "prayer_reminders",
                profileDraft.notifications?.prayer_reminders === false,
              )
            }
          />
          <SettingsRow
            icon="notifications"
            label="Push notifications"
            value={pushToken ? "On — you'll get reminders & new-event nudges" : "Off — tap to enable"}
            onPress={() => Linking.openSettings()}
          />
          <SettingsRow
            icon="check"
            label="RSVP reminders"
            value={profileDraft.notifications?.rsvp_reminders === false ? "Off" : "On — notified 2 hours before"}
            onPress={() =>
              updateNotificationPreference(
                "rsvp_reminders",
                profileDraft.notifications?.rsvp_reminders === false,
              )
            }
          />
          <SettingsRow
            icon="dark_mode"
            label="Quiet hours"
            value={`${profileDraft.notifications?.quiet_hours_start || "22:30"} - ${profileDraft.notifications?.quiet_hours_end || "06:30"}`}
            onPress={() => {
              const curStart = profileDraft.notifications?.quiet_hours_start || "22:30";
              const curEnd = profileDraft.notifications?.quiet_hours_end || "06:30";
              const presets = [
                ["22:30", "06:30"],
                ["23:00", "06:00"],
                ["00:00", "07:00"],
              ] as const;
              const idx = Math.max(0, presets.findIndex((p) => p[0] === curStart && p[1] === curEnd));
              const next = presets[(idx + 1) % presets.length];
              void updateNotificationPreference("quiet_hours_start", next[0]);
              void updateNotificationPreference("quiet_hours_end", next[1]);
            }}
          />
          <SettingsRow
            icon="notifications"
            label="Daily notification cap"
            value={`${profileDraft.notifications?.daily_notification_cap || 6} per day`}
            onPress={() => {
              const cur = Number(profileDraft.notifications?.daily_notification_cap || 6);
              const next = cur >= 10 ? 4 : cur + 2;
              void updateNotificationPreference("daily_notification_cap", next);
            }}
          />
          <SettingsRow
            icon="favorite"
            label="Followed masjids"
            value={followedMasjids.length > 0 ? `${followedMasjids.length} masjid${followedMasjids.length === 1 ? "" : "s"} — get their new events` : "Follow a masjid to get its new events"}
            onPress={() => switchTab("discover")}
            last
          />
        </SectionCard>

        <SectionLabel>MASJID PARTNERS</SectionLabel>
        <SectionCard>
          <SettingsRow
            icon="groups"
            label="Claim your masjid profile"
            value={followedMasjids.length ? `Claim ${formatSourceLabel(followedMasjids[0])}` : "Follow a masjid to claim"}
            onPress={claimFirstFollowedMasjid}
          />
          <SettingsRow
            icon="info"
            label="Partnership analytics snapshot"
            value="Live event coverage and activity"
            onPress={openMasjidPartnerSnapshot}
          />
          <SettingsRow
            icon="close"
            label="Hidden feed sources"
            value={mutedFeedSources.length ? `${mutedFeedSources.length} hidden` : "None hidden"}
            onPress={() => {
              if (!mutedFeedSources.length) {
                Alert.alert("No hidden sources", "Tap 'Not interested' on a feed card to hide that source.");
                return;
              }
              Alert.alert(
                "Hidden feed sources",
                mutedFeedSources.map((s) => formatSourceLabel(s)).join(", "),
                [
                  { text: "Close", style: "cancel" },
                  { text: "Clear all", style: "destructive", onPress: () => void clearMutedFeedSources() },
                ],
              );
            }}
            last
          />
        </SectionCard>

        {/* PRAYER & QIBLA — daily utility. We don't try to build our own
            compass (sensor access + magnetometer calibration is fiddly
            across iOS/Android). Instead we hand off to Google's Qibla
            Finder PWA which is already battle-tested, and offer quick
            prayer-time links keyed off the user's location. */}
        <SectionLabel>PRAYER & QIBLA</SectionLabel>
        <SectionCard>
          <SettingsRow
            icon="explore"
            label="Open Qibla compass"
            value="Google Qibla Finder — points you toward Makkah"
            onPress={() => {
              hapticTap("selection");
              Linking.openURL("https://qiblafinder.withgoogle.com/intl/en/").catch(() =>
                Alert.alert("Couldn't open", "Please open qiblafinder.withgoogle.com in your browser."),
              );
            }}
          />
          <SettingsRow
            icon="schedule"
            label="Today's prayer times"
            value={
              profileDraft.home_lat && profileDraft.home_lon
                ? "See times based on your location"
                : "Enable location first for accurate times"
            }
            onPress={() => {
              hapticTap("selection");
              const lat = profileDraft.home_lat;
              const lon = profileDraft.home_lon;
              if (typeof lat === "number" && typeof lon === "number") {
                Linking.openURL(
                  `https://www.islamicfinder.org/prayer-times/?city=&country=&latitude=${lat}&longitude=${lon}`,
                ).catch(() => {});
              } else {
                Alert.alert(
                  "Location needed",
                  "Enable 'Use my location' below to get prayer times for where you are right now.",
                );
              }
            }}
            last
          />
        </SectionCard>

        <View
          onLayout={(e) => {
            settingsJumuahOffsetRef.current = e.nativeEvent.layout.y;
          }}
        >
          {/* JUMU'AH */}
          <SectionLabel>JUMU'AH</SectionLabel>
          <SectionCard>
            {jumuahSettingsRows.length ? (
              jumuahSettingsRows.map((row, idx) => (
                <SettingsRow
                  key={`settings-jumuah-${row.source}`}
                  icon="schedule"
                  label={formatSourceLabel(row.source)}
                  value={row.value}
                  onPress={() => setSelectedMasjidProfile(row.source)}
                  last={idx === jumuahSettingsRows.length - 1}
                />
              ))
            ) : (
              <SettingsRow
                icon="schedule"
                label="No Jumu'ah entries yet"
                value="Pull to refresh events or open Explore for full listings"
                onPress={() => switchTab("explore")}
                last
              />
            )}
          </SectionCard>
        </View>

        {/* LOCATION & RADIUS */}
        <SectionLabel>LOCATION</SectionLabel>
        <SectionCard>
          <SettingsRow
            icon="location_on"
            label="Use my location"
            value={profileDraft.home_lat && profileDraft.home_lon ? "Enabled — showing what's near you" : "Disabled — tap to allow"}
            onPress={() => requestLocationAndSave()}
          />
          <SettingsRow
            icon="search"
            label="Search radius"
            value={radius === "999" ? "Any distance" : `Within ${radius || 35} miles`}
            onPress={() => {
              Alert.alert(
                "Search radius",
                "Pick how far to look when 'Nearest' is used.",
                [
                  { text: "5 mi", onPress: () => setRadius("5") },
                  { text: "10 mi", onPress: () => setRadius("10") },
                  { text: "25 mi", onPress: () => setRadius("25") },
                  { text: "50 mi", onPress: () => setRadius("50") },
                  { text: "Any", onPress: () => setRadius("999") },
                  { text: "Cancel", style: "cancel" },
                ]
              );
            }}
            last
          />
        </SectionCard>

        {/* CONTENT & AUDIENCE */}
        <SectionLabel>CONTENT</SectionLabel>
        <SectionCard>
          <SettingsRow
            icon="groups"
            label="Default audience"
            value={audienceFilter === "all" ? "Everyone" : audienceFilter[0].toUpperCase() + audienceFilter.slice(1)}
            onPress={() => {
              Alert.alert(
                "Default audience",
                "Which events to surface by default?",
                [
                  { text: "Everyone", onPress: () => setAudienceFilter("all") },
                  { text: "Brothers", onPress: () => setAudienceFilter("brothers") },
                  { text: "Sisters", onPress: () => setAudienceFilter("sisters") },
                  { text: "Family", onPress: () => setAudienceFilter("family") },
                  { text: "Cancel", style: "cancel" },
                ]
              );
            }}
          />
          <SettingsRow
            icon="school"
            label="Scholars & Speakers"
            value="Browse directory, follow for reminders"
            onPress={() => setScholarScreenOpen(true)}
          />
          <SettingsRow
            icon="auto_awesome"
            label="Your Feed setup"
            value="Pick masjids, speakers, and topics for your feed"
            onPress={() => openFeedSetupWizard()}
          />
          <SettingsRow
            icon="restart_alt"
            label="Reset Your Feed"
            value="Start over and get prompted like a first-time user"
            onPress={resetFeedSetup}
          />
          <SettingsRow
            icon="calendar_today"
            label="Export next 30 days"
            value="Add upcoming events to your calendar"
            onPress={exportBulkCalendar}
            last
          />
        </SectionCard>

        {/* APPEARANCE */}
        <SectionLabel>APPEARANCE</SectionLabel>
        <SectionCard>
          <SettingsRow
            icon="contrast"
            label="Theme"
            value={currentThemeLabel}
            onPress={() => {
              Alert.alert(
                "Theme",
                "Pick how Masjid.ly looks.",
                [
                  { text: "Light", onPress: () => applyThemeMode("minera") },
                  { text: "Dark", onPress: () => applyThemeMode("inferno") },
                  { text: "Midnight", onPress: () => applyThemeMode("midnight") },
                  { text: "Emerald", onPress: () => applyThemeMode("emerald") },
                  { text: "Cancel", style: "cancel" },
                ]
              );
            }}
            last
          />
        </SectionCard>

        {/* DATA & STORAGE */}
        <SectionLabel>DATA & STORAGE</SectionLabel>
        <SectionCard>
          <SettingsRow
            icon="refresh"
            label="Refresh events"
            value={`${events.length} events loaded · tap to sync now`}
            onPress={() => { loadEvents({ force: true }); hapticTap("success"); }}
          />
          <SettingsRow
            icon="favorite"
            label="Clear saved events"
            value={`${savedEvents.length} saved — remove all`}
            onPress={() => {
              Alert.alert(
                "Clear saved events",
                "This removes every event from your saved list. Your RSVPs and reminders stay.",
                [
                  { text: "Cancel", style: "cancel" },
                  { text: "Clear", style: "destructive", onPress: () => { clearSavedEvents(); hapticTap("success"); } },
                ]
              );
            }}
            last
          />
        </SectionCard>

        {/* SEEDED SNAPSHOT */}
        <SectionLabel>SEEDED</SectionLabel>
        <SectionCard>
          <SettingsRow
            icon="bookmark"
            label="Bundled snapshot"
            value={`${seedEventCount} events · ${seedSourceCount} sources`}
            onPress={() =>
              Alert.alert(
                "Bundled seed snapshot",
                "This is the offline snapshot packed with the app. Live API sync overlays newer data when available.",
              )
            }
          />
          <SettingsRow
            icon="schedule"
            label="Seed generated"
            value={seedGeneratedAtLabel}
            onPress={() =>
              Alert.alert(
                "Seed generated",
                `UTC timestamp from seed-meta.json:\n${seedGeneratedAtRaw || "Unknown"}`,
              )
            }
          />
          <SettingsRow
            icon="calendar_today"
            label="Seed date range"
            value={seedMinDate && seedMaxDate ? `${seedMinDate} → ${seedMaxDate}` : "Unknown"}
            onPress={() =>
              Alert.alert(
                "Seed date range",
                seedMinDate && seedMaxDate
                  ? `From ${seedMinDate} through ${seedMaxDate}.`
                  : "No range available in seed metadata.",
              )
            }
          />
          <SettingsRow
            icon="info"
            label="Seed version"
            value={seedDataVersion}
            onPress={() =>
              Alert.alert(
                "Seed version",
                `Version token from seed-meta.json:\n${seedDataVersion}`,
              )
            }
            last
          />
        </SectionCard>

        {/* SUPPORT & COMMUNITY */}
        <SectionLabel>SUPPORT & COMMUNITY</SectionLabel>
        <SectionCard>
          <SettingsRow
            icon="mail"
            label="Send feedback"
            value="Tell us what to fix or add"
            onPress={() =>
              Alert.alert(
                "Send feedback",
                "Email hello@masjidly.app with questions, feature requests, or masjids we should add.",
                [
                  { text: "Cancel", style: "cancel" },
                  { text: "Open mail", onPress: () => Linking.openURL("mailto:hello@masjidly.app?subject=Masjid.ly%20feedback") },
                ],
              )
            }
          />
          <SettingsRow
            icon="share"
            label="Invite a friend"
            value="Share Masjid.ly with people who'd love it"
            onPress={() =>
              Share.share({
                title: "Invite to Masjid.ly",
                message: `Join me on Masjid.ly for local masjid events. My code: ${referralCode}\n\nhttps://masjidly.app/invite/${referralCode}`,
              })
            }
          />
          <SettingsRow
            icon="lightbulb"
            label="Replay walkthrough"
            value="Meet your Masjid.ly companion again"
            onPress={() => {
              // Make sure we're on Home so the tour's tab-highlights are
              // visible behind the overlay, then kick off the guided tour
              // from step 0. We also clear the "done" flag so future cold
              // starts can still trigger it naturally if we ever reset
              // state. (Not strictly required for this one-shot replay.)
              try { switchTab("home"); } catch { /* non-fatal */ }
              SecureStore.deleteItemAsync(GUIDED_TOUR_DONE_KEY).catch(() => {});
              setGuidedTourStep(0);
              // Small delay so Home has painted before the tour overlay
              // drops in — otherwise the first tab highlight can flash
              // before the scene behind it is visible.
              setTimeout(() => {
                setGuidedTourOpen(true);
                Alert.alert(
                  "Walkthrough started",
                  "Tap Next (or anywhere on the dim backdrop) to advance. Skip any time.",
                  [{ text: "Got it" }],
                );
              }, 120);
            }}
            last
          />
        </SectionCard>

        {/* ACCOUNT — sign out + delete (Apple requires in-app deletion) */}
        <SectionLabel>ACCOUNT</SectionLabel>
        <SectionCard>
          <SettingsRow
            icon="logout"
            label={currentUser ? "Sign out" : "Sign in or create account"}
            value={currentUser ? (currentUser.email || "Signed in") : "Sync your saves across devices"}
            onPress={() => {
              if (!currentUser) {
                setEntryScreen("welcome");
                return;
              }
              Alert.alert(
                "Sign out?",
                "You'll stay on this device but your saves won't sync until you sign back in.",
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Sign out",
                    style: "destructive",
                    onPress: async () => {
                      try { await apiJson("/api/auth/logout", { method: "POST" }); } catch { /* non-fatal */ }
                      await setToken("");
                      setCurrentUser(null);
                      hapticTap("success");
                      Alert.alert("Signed out", "You can sign back in any time from Settings.");
                    },
                  },
                ]
              );
            }}
          />
          <SettingsRow
            icon="warning"
            danger
            label="Delete my account"
            value="Permanently remove your account and data"
            onPress={() => {
              Alert.alert(
                "Delete your account?",
                "This permanently removes your account, saved events, follows, RSVPs, and notification preferences. This cannot be undone.",
                [
                  { text: "Cancel", style: "cancel" },
                  {
                    text: "Continue",
                    style: "destructive",
                    onPress: () => {
                      Alert.alert(
                        "Are you absolutely sure?",
                        "Tap 'Delete forever' to permanently wipe your Masjid.ly account. You'll be signed out immediately.",
                        [
                          { text: "Keep my account", style: "cancel" },
                          {
                            text: "Delete forever",
                            style: "destructive",
                            onPress: async () => {
                              try {
                                await apiJson("/api/account", { method: "DELETE" });
                              } catch (e: any) {
                                // If the backend endpoint is unavailable we
                                // still wipe local state so the user's
                                // session is gone from this device.
                                console.warn("account delete failed on server", e?.message || e);
                              }
                              await setToken("");
                              setCurrentUser(null);
                              setSavedEventsMap({});
                              setFollowedMasjids([]);
                              setFollowedScholars([]);
                              try {
                                await SecureStore.deleteItemAsync(WELCOME_FLOW_DONE_KEY);
                              } catch { /* non-fatal */ }
                              hapticTap("success");
                              Alert.alert(
                                "Account deleted",
                                "Your account has been removed. If anything remains after 7 days, email support@masjidly.app.",
                                [{ text: "OK", onPress: () => setEntryScreen("welcome") }]
                              );
                            },
                          },
                        ]
                      );
                    },
                  },
                  {
                    text: "Open instructions on web",
                    onPress: () => { Linking.openURL(MASJIDLY_URLS.deleteAccount).catch(() => {}); },
                  },
                ]
              );
            }}
            last
          />
        </SectionCard>

        {/* LEGAL */}
        <SectionLabel>LEGAL</SectionLabel>
        <SectionCard>
          <SettingsRow
            icon="info"
            label="Privacy policy"
            value="Hosted at ssaud1.github.io/masjidly"
            onPress={() => setShowPrivacyPolicy(true)}
          />
          <SettingsRow
            icon="info"
            label="Terms of use"
            onPress={() => setShowTermsOfUse(true)}
          />
          <SettingsRow
            icon="info"
            label="Open policy & support on web"
            value="Opens ssaud1.github.io/masjidly in your browser"
            onPress={() => { Linking.openURL(MASJIDLY_URLS.marketing).catch(() => {}); }}
          />
          <SettingsRow
            icon="info"
            label="Data & permissions"
            value="What we collect, why, and how to delete"
            onPress={() => setShowPrivacyPolicy(true)}
            last
          />
        </SectionCard>

        {/* ABOUT */}
        <SectionLabel>ABOUT</SectionLabel>
        <SectionCard>
          <SettingsRow
            icon="info"
            label="About Masjid.ly"
            value={`Version ${APP_BUILD_VERSION}`}
            onPress={() => setShowAboutPanel(true)}
            last
          />
        </SectionCard>

        {/* Tap-to-reveal developer panel */}
      <Pressable {...PRESSABLE_INSTANT}
        onPress={() => {
          const nextCount = devTapCount + 1;
          setDevTapCount(nextCount);
          if (nextCount >= 7) {
            setDeveloperPanelOpen((v) => !v);
            setDevTapCount(0);
            hapticTap("success");
          }
        }}
        style={styles.settingsVersionRow}
        hitSlop={8}
      >
        <Text style={[styles.settingsVersionText, isDarkTheme && { color: "#6b778c" }]}>
            Masjid.ly · {APP_BUILD_VERSION} · Made with love for the ummah
        </Text>
      </Pressable>

      {developerPanelOpen ? (
          <View style={[styles.settingsSectionCard, isDarkTheme && styles.settingsSectionCardDark, { marginTop: 12, padding: 16 }]}>
            <Text style={[styles.settingsSectionLabel, { marginLeft: 0, marginBottom: 10 }]}>DEVELOPER</Text>
            <Text style={{ color: isDarkTheme ? "#c4cee8" : "#4a5568", fontSize: 12, marginBottom: 4 }}>
            API Base: {API_BASE_URL}
          </Text>
            <Text style={{ color: isDarkTheme ? "#c4cee8" : "#4a5568", fontSize: 12, marginBottom: 4 }}>
            Push token: {pushToken ? `${pushToken.slice(0, 24)}…` : "Not registered"}
          </Text>
            <Text style={{ color: isDarkTheme ? "#c4cee8" : "#4a5568", fontSize: 12, marginBottom: 4 }}>
            Events loaded: {events.length} · Haptics: {hapticsModule ? "native" : "fallback"}
          </Text>
            <Text style={{ color: isDarkTheme ? "#c4cee8" : "#4a5568", fontSize: 12, marginBottom: 4 }}>
            Today anchor: {today}
          </Text>
            <Pressable {...PRESSABLE_INSTANT}
              style={[styles.utilityActionBtn, { marginTop: 10 }, isDarkTheme && styles.utilityActionBtnDark]}
              onPress={loadModerationQueue}
            >
              <Text style={[styles.utilityActionBtnText, isDarkTheme && styles.utilityActionBtnTextDark]}>Open Moderation Queue</Text>
            </Pressable>
        </View>
      ) : null}
    </ScrollView>
  );
  };

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
      exploreSectionLimit,
      masjidPinsForExplore,
      exploreMapHeight,
      audienceFilter,
      savedEventsMap,
      rsvpStatuses,
      themeMode,
      halaqaFilter,
      eventSeries,
      followedMasjids,
      profileDraft.home_lat,
      profileDraft.home_lon,
      locationBannerDismissed,
      locationRequesting,
    ]
  );
  const calendarSceneNode = useMemo(
    () => renderCalendar(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      calendarScheduleEvents,
      calendarView,
      selectedCalendarDate,
      calendarAnchorIso,
      today,
      rsvpStatuses,
      savedEventsMap,
      themeMode,
    ]
  );
  const feedSceneNode = useMemo(
    () => renderFeed(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      forYouFeedEvents,
      followedMasjidFeedEvents,
      followedScholarFeedEvents,
      interestFeedEvents,
      savedAndRsvpFeedEvents,
      feedFollowedMasjidSummaries,
      feedUnfollowedMasjidBuckets,
      feedSpeakerCards,
      followedMasjids,
      followedScholars,
      feedTopicFilter,
      feedTopicOptions,
      themeMode,
    ]
  );
  // Memoize home and settings too so tab switching is instant — these only
  // rebuild when their real data inputs change.
  const homeSceneNode = useMemo(
    () => renderHome(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      orderedVisibleEvents,
      visibleEvents,
      today,
      futureVisibleCount,
      followedMasjids,
      profileDraft.home_lat,
      profileDraft.home_lon,
      reference,
      personalization.name,
      currentUser?.email,
      savedEventsMap,
      rsvpStatuses,
      themeMode,
      meta,
      lastSyncedAt,
    ]
  );
  const settingsSceneNode = useMemo(
    () => renderSettings(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profileDraft, themeMode, meta, currentUser, followedMasjids, orderedVisibleEvents, iqamaBySource, today]
  );
  const discoverSceneNode = useMemo(
    () => renderDiscover(),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [orderedVisibleEvents, speakers, followedScholars, followedMasjids, themeMode, reference]
  );

  const renderTabScene = (sceneTab: TabKey) => {
    if (sceneTab === "home") return homeSceneNode;
    if (sceneTab === "explore") return exploreSceneNode;
    if (sceneTab === "discover") return discoverSceneNode;
    if (sceneTab === "calendar") return calendarSceneNode;
    if (sceneTab === "feed") return feedSceneNode;
    return settingsSceneNode;
  };

  if (entryScreen === "welcome") return renderWelcomeScreen();
  if (entryScreen === "onboarding") return renderProfileCaptureScreen();
  if (entryScreen === "launch") return renderLaunchScreen();

  return (
    <View style={{ flex: 1 }}>
    <Animated.View style={{ flex: 1, opacity: appShellFadeIn }}>
    <SafeAreaView style={[styles.container, isMidnight && styles.containerMidnight, isNeo && styles.containerNeo, isVitaria && styles.containerVitaria, isInferno && styles.containerInferno, isEmerald && styles.containerEmerald]}>
      <StatusBar style={isMidnight || isVitaria || isInferno ? "light" : "dark"} />
      {tab === "home" ? (
        <LinearGradient
          colors={
            isMidnight
              ? ["#1a1f30", "#0c111d", "#070a12"]
              : isInferno
                ? ["#ff5a2c", "#ff3a14", "#c42505"]
                : isEmerald
                  ? ["#1d6a45", "#0f4a2f", "#083b24"]
                  : isVitaria
                    ? ["#8a5a68", "#634047", "#3d2a30"]
                    : isNeo
                      ? ["#2b2b2b", "#1b1b1b", "#0f0f0f"]
                      : ["#ff9362", "#ff6d3f", "#f2551e"]
          }
          start={{ x: 0.0, y: 0.0 }}
          end={{ x: 1.0, y: 1.0 }}
          style={styles.topBar}
        >
          {/* Soft highlight glow so the wordmark feels elevated — the two
              circles drift in slow, offset loops so the brand breathes. */}
          <Animated.View
            pointerEvents="none"
            style={[
              styles.topBarGlow,
              {
                transform: [
                  {
                    translateY: logoGlowA.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, -10],
                    }),
                  },
                  {
                    translateX: logoGlowA.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, 7],
                    }),
                  },
                  {
                    scale: logoGlowA.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.94, 1.08],
                    }),
                  },
                ],
                opacity: logoGlowA.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.5, 0.82],
                }),
              },
            ]}
          />
          <Animated.View
            pointerEvents="none"
            style={[
              styles.topBarGlowB,
              {
                transform: [
                  {
                    translateY: logoGlowA.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, 12],
                    }),
                  },
                  {
                    translateX: logoGlowA.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0, -10],
                    }),
                  },
                  {
                    scale: logoGlowA.interpolate({
                      inputRange: [0, 1],
                      outputRange: [1.02, 0.94],
                    }),
                  },
                ],
                opacity: logoGlowA.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.54, 0.78],
                }),
              },
            ]}
          />
          <View style={styles.topBarBrandRow}>
            <Image source={TOPBAR_WORDMARK} style={styles.topBarWordmark} resizeMode="contain" tintColor="#ffffff" />
          </View>
        </LinearGradient>
      ) : null}

      <View style={styles.tabSceneWrap}>
        {(["home", "explore", "discover", "calendar", "feed", "settings"] as const).map((id) => {
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
        {(
          [
            ["home", TAB_ICON_HOME, "Home"],
            ["explore", TAB_ICON_MAP, "Map"],
            ["discover", TAB_ICON_DISCOVER, "Discover"],
            ["calendar", TAB_ICON_CALENDAR, "Calendar"],
            ["feed", TAB_ICON_FEED, "Your Feed"],
            ["settings", TAB_ICON_SETTINGS, "Settings"],
          ] as const
        ).map(([id, iconSource, label]) => {
          const active = tab === id;
          // Derive the correct glyph color for the current theme. Material
          // Symbols PNGs are grey on transparent — we recolor them via
          // `tintColor` so they perfectly match the text color of the tab.
          const inactiveColor = isMidnight
            ? "#6f7897"
            : isNeo
              ? "#4a4a4a"
              : isVitaria
                ? "rgba(255,255,255,0.82)"
                : isInferno
                  ? "rgba(255,195,162,0.86)"
                  : isEmerald
                    ? "#2f6f4a"
                    : "#8a92a4";
          const activeColor = isInferno || isEmerald ? "#fffaf6" : "#fff8f2";
          const tintColor = active ? activeColor : inactiveColor;
          return (
            <Pressable
              {...PRESSABLE_INSTANT}
              key={id}
              hitSlop={4}
              style={({ pressed }) => [
                styles.tabBtn,
                active && styles.tabBtnActive,
                isMidnight && active && styles.tabBtnActiveMidnight,
                isNeo && active && styles.tabBtnActiveNeo,
                isVitaria && active && styles.tabBtnActiveVitaria,
                isInferno && active && styles.tabBtnActiveInferno,
                isEmerald && active && styles.tabBtnActiveEmerald,
                pressed && { opacity: 0.55 },
              ]}
              onPressIn={() => {
                if (!active) switchTab(id as typeof tab);
              }}
            >
              <Image
                source={iconSource}
                style={[styles.tabIconImage, { tintColor }]}
                resizeMode="contain"
              />
              <Text
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.7}
                allowFontScaling={false}
                style={[
                  styles.tabText,
                  isMidnight && styles.tabTextMidnight,
                  isNeo && styles.tabTextNeo,
                  isVitaria && styles.tabTextVitaria,
                  isInferno && styles.tabTextInferno,
                  isEmerald && styles.tabTextEmerald,
                  active && styles.tabTextActive,
                  isInferno && active && styles.tabTextActiveInferno,
                  isEmerald && active && styles.tabTextActiveEmerald,
                ]}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <Modal
        visible={!!selectedEvent}
        animationType="fade"
        presentationStyle="fullScreen"
        statusBarTranslucent={false}
        onRequestClose={closeEventDetails}
      >
        {selectedEvent && !detailReady ? (
          <View style={[styles.eventModalContainer, isDarkTheme && styles.eventModalContainerDark, styles.eventModalSkeleton]}>
            <View style={[styles.eventHero, { height: Math.min(windowHeight * 0.5, 420), backgroundColor: masjidBrandColor(selectedEvent.source) }]}>
              <LinearGradient
                colors={["rgba(0,0,0,0.45)", "rgba(0,0,0,0)", "rgba(0,0,0,0.85)"]}
                locations={[0, 0.35, 1]}
                style={StyleSheet.absoluteFillObject}
              />
              <View style={[styles.eventHeroTopRow, { paddingTop: insets.top + 10 }]}>
                <Pressable
                  {...PRESSABLE_INSTANT}
                  style={styles.eventHeroIconBtn}
                  hitSlop={10}
                  onPress={closeEventDetails}
                >
                  <Mi name="close" size={18} color="#fff" />
                </Pressable>
              </View>
              <View style={styles.eventModalSkeletonTitleWrap}>
                <Text style={styles.eventModalSkeletonTitle} numberOfLines={2}>
                  {eventDisplayTitle(selectedEvent)}
                </Text>
                <Text style={styles.eventModalSkeletonSub} numberOfLines={1}>
                  {formatHumanDate(selectedEvent.date)}
                </Text>
              </View>
            </View>
            <View style={styles.eventModalSkeletonBody}>
              <ActivityIndicator size="small" color={isDarkTheme ? "#f4f7ff" : "#173664"} />
            </View>
          </View>
        ) : null}
        {selectedEvent && detailReady ? (() => {
          const ev = selectedEvent;
          const displayTitle = eventDisplayTitle(ev);
          const rsvpKey = eventStorageKey(ev);
          const rsvpState = rsvpStatuses[rsvpKey];
          const saved = isSavedEvent(ev);
          const isFollowed = followedMasjids.includes(ev.source);
          const audience = inferAudience(ev);
          const poster = eventPosterUrl(ev);
          const speaker = effectiveEventSpeakerName(ev);
          const locationParts = [ev.location_name, ev.address].filter(Boolean);
          const brandColor = masjidBrandColor(ev.source);
          const descRaw = normalizeText((ev.description || "").replace(/<[^>]+>/g, " "));
          const descOriginal = normalizeText(
            (ev.description_original || ev.raw_text || ev.poster_ocr_text || "").replace(/<[^>]+>/g, " "),
          );
          const explanation = buildEventExplanation(ev);
          const canToggleOriginal = !!descOriginal && !!descRaw && descOriginal !== descRaw;
          const activeDesc = showOriginalDescription ? descOriginal : descRaw;
          const descToShow = activeDesc || explanation;
          const descIsLong = descToShow.length > 220;
          const descShown = !descIsLong || showFullDescription ? descToShow : `${descToShow.slice(0, 220).trim()}…`;
          const conf = getEventConfidence(ev);
          const transparency = transparencyLabel(ev);
          const recurring = recurringProgramLabel(ev);
          const shareEv = () => {
            hapticTap("selection");
            Share.share({
              title: displayTitle,
              message: `${displayTitle} • ${formatHumanDate(ev.date)} ${ev.deep_link?.web || ev.source_url || ""}`,
            });
          };
          const feedbackState = feedbackResponses[rsvpKey];
          return (
            <View style={[styles.eventModalContainer, isDarkTheme && styles.eventModalContainerDark]}>
              <ScrollView
                style={{ flex: 1 }}
                contentContainerStyle={{ paddingBottom: insets.bottom + 140 }}
                showsVerticalScrollIndicator={false}
                keyboardShouldPersistTaps="handled"
                {...IOS_SCROLL_INSTANT_TOUCH}
              >
                <View style={[styles.eventHero, { height: Math.min(windowHeight * 0.5, 420) }]}>
                  {poster && canRenderPoster(poster) ? (
                    <LoadableNetworkImage
                      uri={poster}
                      style={StyleSheet.absoluteFillObject}
                      onError={() => markPosterFailed(poster)}
                    />
                  ) : (
                    <View style={[StyleSheet.absoluteFillObject, { backgroundColor: brandColor }]} />
                  )}
                  {poster && canRenderPoster(poster) ? (
                    <Pressable
                      {...PRESSABLE_INSTANT}
                      style={StyleSheet.absoluteFillObject}
                      onPress={() => {
                        hapticTap("selection");
                        setPosterFullscreenUri(poster);
                      }}
                      accessibilityRole="button"
                      accessibilityLabel="View full poster"
                    />
                  ) : null}
                  <LinearGradient
                    pointerEvents="none"
                    colors={["rgba(0,0,0,0.45)", "rgba(0,0,0,0)", "rgba(0,0,0,0.85)"]}
                    locations={[0, 0.35, 1]}
                    style={StyleSheet.absoluteFillObject}
                  />
                  <View style={[styles.eventHeroTopRow, { paddingTop: insets.top + 10 }]}>
                    <Pressable
                      {...PRESSABLE_INSTANT}
                      style={styles.eventHeroIconBtn}
                      hitSlop={10}
                      onPress={closeEventDetails}
                    >
                      <Mi name="close" size={18} color="#fffdf8" />
                    </Pressable>
                    <View style={{ flex: 1 }} />
                    <Pressable
                      {...PRESSABLE_INSTANT}
                      style={[styles.eventHeroIconBtn, saved && styles.eventHeroIconBtnActive]}
                      hitSlop={10}
                      onPress={() => toggleSavedEvent(ev)}
                    >
                      <Mi name={saved ? "favorite_fill1" : "favorite"} size={18} color="#fffdf8" />
                    </Pressable>
                    <Pressable {...PRESSABLE_INSTANT} style={styles.eventHeroIconBtn} hitSlop={10} onPress={shareEv}>
                      <Mi name="open_in_new" size={18} color="#fffdf8" />
            </Pressable>
          </View>
                  <View style={styles.eventHeroBottom}>
                    <View style={styles.eventHeroChipRow}>
                      {renderMasjidLogo(ev.source, 30, {
                        style: { borderWidth: 1.5, borderColor: "rgba(255,255,255,0.9)" },
                        textStyle: styles.eventHeroSourceInitials,
                      })}
                      <Text style={styles.eventHeroSourceLabel} numberOfLines={1}>
                        {formatSourceLabel(ev.source)}
              </Text>
                      {audience ? (
                        <View style={styles.eventHeroAudienceChip}>
                          <Text style={styles.eventHeroAudienceText}>{audience}</Text>
                        </View>
                      ) : null}
                    </View>
                    <Text style={styles.eventHeroTitle} numberOfLines={3}>{displayTitle}</Text>
                  </View>
                </View>

                <View style={[styles.eventWhenCard, isDarkTheme && styles.eventWhenCardDark]}>
                  <View style={styles.eventWhenRow}>
                    <MaterialIcons
                      name="calendar-month"
                      size={22}
                      color={isDarkTheme ? "#c4cee8" : "#4a5568"}
                      style={styles.eventWhenIconGlyph}
                    />
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
                      <Pressable {...PRESSABLE_INSTANT}
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
                    <Pressable {...PRESSABLE_INSTANT}
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
                <Pressable {...PRESSABLE_INSTANT}
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
                  <Pressable {...PRESSABLE_INSTANT}
                      style={[styles.eventRsvpLinkBtn, isDarkTheme && styles.eventRsvpLinkBtnDark]}
                      onPress={() => Linking.openURL(ev.rsvp_link)}
                  >
                      <Text style={[styles.eventRsvpLinkText, isDarkTheme && { color: "#9fc6ff" }]}>Official RSVP →</Text>
                  </Pressable>
                ) : null}
                  <Pressable {...PRESSABLE_INSTANT}
                    style={[styles.eventRsvpLinkBtn, isDarkTheme && styles.eventRsvpLinkBtnDark, { marginTop: 8 }]}
                    onPress={() => addEventToDeviceCalendar(ev)}
                  >
                    <Text style={[styles.eventRsvpLinkText, isDarkTheme && { color: "#9fc6ff" }]}>
                      Add to my device calendar →
                    </Text>
                  </Pressable>
                </View>

                {/* #18 Attendees + #12 Invite friends */}
                <View style={[styles.eventInfoCard, isDarkTheme && styles.eventInfoCardDark]}>
                  <MaterialIcons
                    name="groups"
                    size={20}
                    color={isDarkTheme ? "#c4cee8" : "#4a5568"}
                    style={styles.eventInfoIconGlyph}
                  />
                  <View style={{ flex: 1 }}>
                    {(ev.attendees?.going || 0) > 0 ? (
                      <View style={styles.whosGoingAvatars}>
                        {Array.from({ length: Math.min(5, ev.attendees?.going || 0) }).map((_, i) => {
                          const palette = ["#ff7a3c", "#4a5c85", "#1c7a4a", "#8a3e9f", "#b36a00"];
                          const initials = ["AR", "YM", "NH", "SK", "ZT"];
                          return (
                            <View
                              key={`who-av-${i}`}
                              style={[
                                styles.whosGoingAvatar,
                                { backgroundColor: palette[i % palette.length], marginLeft: i === 0 ? 0 : -10 },
                              ]}
                            >
                              <Text style={styles.whosGoingAvatarText}>{initials[i % initials.length]}</Text>
                            </View>
                          );
                        })}
                      </View>
                    ) : null}
                    <Text style={[styles.eventInfoTitle, isDarkTheme && { color: "#f4f7ff" }, (ev.attendees?.going || 0) > 0 && { marginTop: 8 }]}>
                      {(ev.attendees?.going || 0) > 0
                        ? `${ev.attendees?.going} going${(ev.attendees?.interested || 0) > 0 ? ` · ${ev.attendees?.interested} interested` : ""}`
                        : "Be the first from your circle"}
                    </Text>
                    <Text style={[styles.eventInfoSub, isDarkTheme && { color: "#c4cee8" }]}>
                      Invite a friend — one tap sends them the poster & seat link.
                    </Text>
                  </View>
                  <Pressable {...PRESSABLE_INSTANT}
                    style={styles.eventInviteBtn}
                    hitSlop={8}
                    onPress={() => inviteFriendsToEvent(ev)}
                  >
                    <Text style={styles.eventInviteBtnText}>Bring a friend</Text>
                  </Pressable>
                </View>

                {locationParts.length ? (
                  <Pressable {...PRESSABLE_INSTANT}
                    style={[styles.eventInfoCard, isDarkTheme && styles.eventInfoCardDark]}
                    disabled={!ev.map_link}
                    onPress={() => ev.map_link && Linking.openURL(ev.map_link)}
                  >
                    <MaterialIcons
                      name="place"
                      size={20}
                      color={isDarkTheme ? "#c4cee8" : "#4a5568"}
                      style={styles.eventInfoIconGlyph}
                    />
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
                    <Mi
                      name={ev.correction?.flagged ? "warning" : "check"}
                      size={18}
                      color={ev.correction?.flagged ? "#9a4311" : "#1f7a42"}
                      style={{ marginRight: 8 }}
                    />
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
                      <MaterialIcons
                        name="forum"
                        size={20}
                        color="#5c4fa8"
                        style={styles.eventInfoIconGlyph}
                      />
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.eventInfoTitle, { color: "#3a2f7f" }]}>How was it?</Text>
                        <Text style={[styles.eventInfoSub, { color: "#5c4fa8" }]}>
                          Share one benefit so other attendees can see. 2–3 taps, private name.
                        </Text>
                      </View>
                      <Pressable {...PRESSABLE_INSTANT}
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
                    <MaterialIcons
                      name="mic"
                      size={20}
                      color={isDarkTheme ? "#c4cee8" : "#4a5568"}
                      style={styles.eventInfoIconGlyph}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.eventInfoTitle, isDarkTheme && { color: "#f4f7ff" }]} numberOfLines={2}>{speaker}</Text>
                      <Text style={[styles.eventInfoSub, isDarkTheme && { color: "#c4cee8" }]}>Speaker</Text>
              </View>
                  </View>
                ) : null}

                {descToShow ? (
                  <View style={styles.eventSection}>
                    <Text style={[styles.eventSectionLabel, isDarkTheme && { color: "#c4cee8" }]}>About</Text>
                    {ev.description_ai_generated ? (
                      <Text style={[styles.eventInfoSub, isDarkTheme && { color: "#9fc6ff" }, { marginBottom: 6 }]}>
                        AI summary
                      </Text>
                    ) : null}
                    <Text style={[styles.eventDescText, isDarkTheme && { color: "#e4ebf7" }]}>{descShown}</Text>
                    {canToggleOriginal ? (
                      <Pressable
                        {...PRESSABLE_INSTANT}
                        onPress={() => setShowOriginalDescription((v) => !v)}
                        hitSlop={6}
                        style={[styles.eventDescToggleBtn, isDarkTheme && styles.eventDescToggleBtnDark, { marginTop: 8 }]}
                      >
                        <View style={styles.eventDescToggleLead}>
                          <MaterialIcons
                            name={showOriginalDescription ? "notes" : "article"}
                            size={14}
                            color={isDarkTheme ? "#cfe1ff" : "#2e4f82"}
                          />
                          <Text style={[styles.eventDescToggle, isDarkTheme && { color: "#cfe1ff" }]}>
                            {showOriginalDescription ? "Show polished description" : "Show original source text"}
                          </Text>
                        </View>
                        <MaterialIcons
                          name={showOriginalDescription ? "keyboard-arrow-up" : "arrow-forward"}
                          size={16}
                          color={isDarkTheme ? "#9fc6ff" : "#2e4f82"}
                        />
                      </Pressable>
                    ) : null}
                    {descIsLong ? (
                      <Pressable
                        {...PRESSABLE_INSTANT}
                        onPress={() => setShowFullDescription((v) => !v)}
                        hitSlop={6}
                        style={[styles.eventDescToggleBtn, isDarkTheme && styles.eventDescToggleBtnDark]}
                      >
                        <View style={styles.eventDescToggleLead}>
                          <MaterialIcons
                            name={showFullDescription ? "unfold-less" : "auto-stories"}
                            size={14}
                            color={isDarkTheme ? "#cfe1ff" : "#2e4f82"}
                          />
                          <Text style={[styles.eventDescToggle, isDarkTheme && { color: "#cfe1ff" }]}>
                            {showFullDescription ? "Show less" : "Read more details"}
                          </Text>
                        </View>
                        <MaterialIcons
                          name={showFullDescription ? "keyboard-arrow-up" : "arrow-forward"}
                          size={16}
                          color={isDarkTheme ? "#9fc6ff" : "#2e4f82"}
                        />
                      </Pressable>
                    ) : null}
                  </View>
                ) : null}

                  <Pressable {...PRESSABLE_INSTANT}
                  style={[styles.eventMasjidCard, isDarkTheme && styles.eventMasjidCardDark]}
                  onPress={() => setSelectedMasjidProfile(ev.source)}
                >
                  {renderMasjidLogo(ev.source, 44, { textStyle: styles.eventMasjidLogoText })}
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.eventMasjidName, isDarkTheme && { color: "#f4f7ff" }]} numberOfLines={1}>
                      {formatSourceLabel(ev.source)}
                    </Text>
                    <Text style={[styles.eventMasjidSub, isDarkTheme && { color: "#c4cee8" }]}>Tap to view masjid profile</Text>
                  </View>
                  <Pressable {...PRESSABLE_INSTANT}
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
                      <Pressable {...PRESSABLE_INSTANT}
                        style={[styles.eventLinkTile, isDarkTheme && styles.eventLinkTileDark]}
                        onPress={() => Linking.openURL(ev.source_url)}
                      >
                        <MaterialIcons
                          name="language"
                          size={20}
                          color={isDarkTheme ? "#c4cee8" : "#4a5568"}
                          style={styles.eventLinkIconGlyph}
                        />
                        <Text style={[styles.eventLinkLabel, isDarkTheme && { color: "#f4f7ff" }]}>Event page</Text>
                  </Pressable>
                ) : null}
                    {ev.deep_link?.web ? (
                  <Pressable {...PRESSABLE_INSTANT}
                        style={[styles.eventLinkTile, isDarkTheme && styles.eventLinkTileDark]}
                        onPress={() => Linking.openURL(ev.deep_link?.web || "")}
                  >
                        <MaterialIcons
                          name="link"
                          size={20}
                          color={isDarkTheme ? "#c4cee8" : "#4a5568"}
                          style={styles.eventLinkIconGlyph}
                        />
                        <Text style={[styles.eventLinkLabel, isDarkTheme && { color: "#f4f7ff" }]}>Open link</Text>
                  </Pressable>
                ) : null}
                    {ev.map_link ? (
                  <Pressable {...PRESSABLE_INSTANT}
                        style={[styles.eventLinkTile, isDarkTheme && styles.eventLinkTileDark]}
                        onPress={() => Linking.openURL(ev.map_link || "")}
                  >
                        <MaterialIcons
                          name="map"
                          size={20}
                          color={isDarkTheme ? "#c4cee8" : "#4a5568"}
                          style={styles.eventLinkIconGlyph}
                        />
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
                  {ev.correction?.verified ? (
                    <Text style={[styles.eventTrustNote, { color: "#2f8a57" }]}>
                      Last verified by community: {ev.correction?.score || 0} confirmations
                    </Text>
                  ) : null}
                  {detectSourceConflict(ev) ? (
                    <Text style={[styles.eventTrustNote, { color: "#a85617" }]}>
                      {detectSourceConflict(ev)}
                    </Text>
                  ) : null}
                  <Pressable
                    {...PRESSABLE_INSTANT}
                    style={[styles.eventReportToggle, { marginTop: 4 }]}
                    onPress={() => setShowEventDataChecks((v) => !v)}
                    hitSlop={6}
                  >
                    <Text style={[styles.eventReportToggleText, isDarkTheme && { color: "#9db0db" }]}>
                      {showEventDataChecks ? "Hide listing quality & quick fixes" : "Listing quality & quick fixes"}
                    </Text>
                  </Pressable>
                  {showEventDataChecks ? (
                    <View style={{ marginTop: 6 }}>
                      <View style={styles.eventTrustBreakdownRow}>
                        {getTrustSignalBreakdown(ev).map((sig) => (
                          <View
                            key={`trust-signal-${sig.key}`}
                            style={[
                              styles.eventTrustBreakdownChip,
                              sig.ok ? styles.eventTrustBreakdownChipOk : styles.eventTrustBreakdownChipWarn,
                            ]}
                          >
                            <Text
                              style={[
                                styles.eventTrustBreakdownChipText,
                                sig.ok ? styles.eventTrustBreakdownChipTextOk : styles.eventTrustBreakdownChipTextWarn,
                              ]}
                            >
                              {sig.ok ? "✓ " : "⚠ "} {sig.label}
                            </Text>
                          </View>
                        ))}
                      </View>
                      <Text style={[styles.eventTrustNote, isDarkTheme && { color: "#bcc6df" }]}>
                        Trust pass: {getTrustPassChips(ev, { debug: __DEV__ }).join(" · ")}
                      </Text>
                      <View style={styles.eventTrustActions}>
                        {(["title", "speaker", "poster", "duplicate"] as const).map((kind) => (
                          <Pressable
                            {...PRESSABLE_INSTANT}
                            key={`quick-fix-${kind}`}
                            style={[styles.eventTrustChip, { backgroundColor: "rgba(78,108,180,0.12)" }]}
                            onPress={() => submitQuickCorrection(ev, kind)}
                          >
                            <Text style={[styles.eventTrustChipText, { color: "#2d4f88" }]}>
                              {kind === "title"
                                ? "Fix title"
                                : kind === "speaker"
                                ? "Fix speaker"
                                : kind === "poster"
                                ? "Fix poster"
                                : "Mark duplicate"}
                            </Text>
                          </Pressable>
                        ))}
                      </View>
                    </View>
                  ) : null}
                  <View style={styles.eventTrustActions}>
                    <Pressable {...PRESSABLE_INSTANT}
                      style={[styles.eventTrustChip, feedbackState === "helpful" && styles.eventTrustChipActive]}
                      onPress={() => submitFeedback(ev, "helpful")}
                    >
                      <Mi
                        name="thumb_up"
                        size={14}
                        style={styles.eventTrustChipIcon}
                        color={feedbackState === "helpful" ? "#fff" : (isDarkTheme ? "#c4cee8" : "#4a5568")}
                      />
                      <Text style={[styles.eventTrustChipText, feedbackState === "helpful" && styles.eventTrustChipTextActive]}>Helpful</Text>
                    </Pressable>
                    <Pressable {...PRESSABLE_INSTANT}
                      style={[styles.eventTrustChip, feedbackState === "attended" && styles.eventTrustChipActive]}
                      onPress={() => submitFeedback(ev, "attended")}
                    >
                      <Mi
                        name="check"
                        size={14}
                        style={styles.eventTrustChipIcon}
                        color={feedbackState === "attended" ? "#fff" : (isDarkTheme ? "#c4cee8" : "#4a5568")}
                      />
                      <Text style={[styles.eventTrustChipText, feedbackState === "attended" && styles.eventTrustChipTextActive]}>Attended</Text>
                    </Pressable>
                    <Pressable {...PRESSABLE_INSTANT}
                      style={[styles.eventTrustChip, feedbackState === "off" && styles.eventTrustChipActive]}
                      onPress={() => submitFeedback(ev, "off")}
                    >
                      <Mi
                        name="warning"
                        size={14}
                        style={styles.eventTrustChipIcon}
                        color={feedbackState === "off" ? "#fff" : (isDarkTheme ? "#c4cee8" : "#4a5568")}
                      />
                      <Text style={[styles.eventTrustChipText, feedbackState === "off" && styles.eventTrustChipTextActive]}>Info off</Text>
                    </Pressable>
                  </View>
                </View>

                <Pressable {...PRESSABLE_INSTANT}
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
                      {[["title", "Title"], ["speaker", "Speaker"], ["poster", "Poster"], ["duplicate", "Duplicate"], ["time", "Time"], ["location", "Location"], ["category", "Category"]].map(([id, label]) => (
                        <Pressable {...PRESSABLE_INSTANT}
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
                    <Pressable {...PRESSABLE_INSTANT} style={styles.eventReportSubmitBtn} onPress={() => void submitCommunityCorrection()}>
                      <Text style={styles.eventReportSubmitText}>Submit correction</Text>
                    </Pressable>
                  </View>
              ) : null}
            </ScrollView>

              <View style={[styles.eventStickyFooter, { paddingBottom: Math.max(insets.bottom, 10) }, isDarkTheme && styles.eventStickyFooterDark]}>
                <Pressable {...PRESSABLE_INSTANT}
                  style={[styles.eventStickySaveBtn, saved && styles.eventStickySaveBtnActive]}
                  onPress={() => toggleSavedEvent(ev)}
                >
                  <Mi
                    name={saved ? "favorite_fill1" : "favorite"}
                    size={22}
                    color={saved ? "#fffdf8" : "#e85d3b"}
                  />
                </Pressable>
                <Pressable {...PRESSABLE_INSTANT}
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
                <Pressable {...PRESSABLE_INSTANT} style={styles.eventStickyShareBtn} onPress={shareEv}>
                  <Mi name="open_in_new" size={20} color="#2e4f82" />
                </Pressable>
              </View>
            </View>
          );
        })() : null}
      </Modal>
      <Modal
        visible={!!posterFullscreenUri}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setPosterFullscreenUri(null)}
      >
        <View style={styles.posterFullscreenRoot}>
          <Pressable
            {...PRESSABLE_INSTANT}
            style={StyleSheet.absoluteFillObject}
            onPress={() => setPosterFullscreenUri(null)}
            accessibilityRole="button"
            accessibilityLabel="Close poster"
          />
          <View
            style={[StyleSheet.absoluteFillObject, styles.posterFullscreenCenter]}
            pointerEvents="box-none"
          >
            {posterFullscreenUri ? (
              <LoadableNetworkImage
                uri={posterFullscreenUri}
                style={{
                  width: Math.max(1, screenWidth - 24),
                  height: Math.max(1, windowHeight - 24),
                }}
                resizeMode="contain"
                onError={() => {
                  setPosterFullscreenUri(null);
                }}
              />
            ) : null}
          </View>
          <Pressable
            {...PRESSABLE_INSTANT}
            style={[styles.posterFullscreenClose, { top: insets.top + 10 }]}
            onPress={() => setPosterFullscreenUri(null)}
            hitSlop={14}
            accessibilityRole="button"
            accessibilityLabel="Close"
          >
            <Mi name="close" size={22} color="#fffdf8" />
          </Pressable>
        </View>
      </Modal>
      <Modal
        visible={!!selectedCalendarModalDate}
        transparent
        animationType="slide"
        onRequestClose={() => setSelectedCalendarModalDate("")}
      >
        <View style={styles.bottomSheetBackdrop}>
          <Pressable {...PRESSABLE_INSTANT} style={StyleSheet.absoluteFillObject} onPress={() => setSelectedCalendarModalDate("")} />
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
              <Pressable {...PRESSABLE_INSTANT} hitSlop={12} onPress={() => setSelectedCalendarModalDate("")} style={styles.bottomSheetCloseBtn}>
                <Mi name="close" size={18} color="#454f63" />
              </Pressable>
            </View>
            <FlatList
              style={{ flex: 1 }}
              contentContainerStyle={{ gap: 14, paddingTop: 12 }}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator
              data={calendarModalEvents}
              keyExtractor={(e, idx) => `day-modal-${eventStorageKey(e)}-${idx}`}
              initialNumToRender={6}
              maxToRenderPerBatch={6}
              windowSize={5}
              removeClippedSubviews
              ListEmptyComponent={
                <View style={{ alignItems: "center", paddingVertical: 24, gap: 12 }}>
                  <Text style={[styles.bottomSheetTitle, isDarkTheme && styles.bottomSheetTitleDark]}>No events today</Text>
                  <Text style={[styles.bottomSheetSub, { textAlign: "center" }, isDarkTheme && styles.bottomSheetSubDark]}>
                    Check another day or explore upcoming events.
                  </Text>
                  <Pressable {...PRESSABLE_INSTANT}
                    style={styles.exploreEmptyBtn}
                    onPress={() => {
                      setSelectedCalendarModalDate("");
                      switchTab("explore");
                    }}
                  >
                    <Text style={styles.exploreEmptyBtnText}>Browse all events</Text>
                  </Pressable>
                </View>
              }
              renderItem={({ item: e }) => {
                const key = eventStorageKey(e);
                const rsvpState = rsvpStatuses[key];
                const saved = isSavedEvent(e);
                const poster = eventPosterUrl(e);
                const temporal = getEventTemporalState(e);
                return (
                    <Pressable {...PRESSABLE_INSTANT}
                      style={[styles.calendarDayEventCard, isDarkTheme && styles.calendarDayEventCardDark]}
                      onPress={() => openEventDetails(e)}
                    >
                      {poster && canRenderPoster(poster) ? (
                        <LoadableNetworkImage
                          uri={poster}
                          style={styles.calendarDayEventPoster}
                          onError={() => markPosterFailed(poster)}
                        />
                      ) : (
                        <View style={[styles.calendarDayEventPoster, styles.calendarDayEventPosterEmpty]}>
                          <Mi name="mosque" size={36} color="#a3b0c8" />
                        </View>
                      )}
                      <View style={{ padding: 12, gap: 6 }}>
                        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          {temporal.isPast ? (
                            <View style={styles.eventPastBadge}>
                              <Text style={styles.eventPastText}>ALREADY HAPPENED</Text>
                            </View>
                          ) : null}
                          {temporal.isLive ? (
                            <View style={styles.liveNowBadge}>
                              <View style={styles.liveNowDot} />
                              <Text style={styles.liveNowText}>LIVE NOW</Text>
                            </View>
                          ) : null}
                          {!temporal.isLive && !temporal.isPast && temporal.startsInMinutes != null ? (
                            <View style={styles.eventStartsSoonBadge}>
                              <Text style={styles.eventStartsSoonText}>
                                {temporal.startsInMinutes <= 1 ? "STARTS IN 1M" : `STARTS IN ${temporal.startsInMinutes}M`}
                              </Text>
                            </View>
                          ) : null}
                          <Text style={styles.mapTag}>{inferAudience(e)}</Text>
                          <Text style={[styles.bottomSheetSub, isDarkTheme && styles.bottomSheetSubDark]}>
                            {eventTime(e)} · {formatSourceLabel(e.source)}
                          </Text>
                        </View>
                        <Text style={[styles.calendarDayEventTitle, isDarkTheme && { color: "#f4f7ff" }]} numberOfLines={2}>
                          {eventDisplayTitle(e)}
                        </Text>
                        <View style={styles.cardActionRow}>
                          <Pressable {...PRESSABLE_INSTANT}
                            hitSlop={6}
                            style={[styles.cardActionChip, rsvpState === "going" && styles.cardActionChipActive]}
                            onPress={(ev) => { ev.stopPropagation?.(); toggleRsvp(e, "going"); }}
                          >
                            <Text style={[styles.cardActionChipText, rsvpState === "going" && styles.cardActionChipTextActive]}>
                              {rsvpState === "going" ? "Going ✓" : "Going"}
                            </Text>
                          </Pressable>
                          <Pressable {...PRESSABLE_INSTANT}
                            hitSlop={6}
                            style={[styles.cardActionChip, rsvpState === "interested" && styles.cardActionChipActive]}
                            onPress={(ev) => { ev.stopPropagation?.(); toggleRsvp(e, "interested"); }}
                          >
                            <Text style={[styles.cardActionChipText, rsvpState === "interested" && styles.cardActionChipTextActive]}>
                              {rsvpState === "interested" ? "Interested ✓" : "Interested"}
                            </Text>
                          </Pressable>
                          <Pressable {...PRESSABLE_INSTANT}
                            hitSlop={6}
                            style={[styles.cardActionChip, saved && styles.cardActionChipActive]}
                            onPress={(ev) => { ev.stopPropagation?.(); toggleSavedEvent(e); }}
                          >
                            <Mi
                              name={saved ? "favorite_fill1" : "favorite"}
                              size={14}
                              color={saved ? "#fff" : "#2e4f82"}
                            />
                          </Pressable>
                          <Pressable {...PRESSABLE_INSTANT}
                            hitSlop={6}
                            style={styles.cardActionChip}
                            onPress={(ev) => { ev.stopPropagation?.(); shareEvent(e); }}
                          >
                            <Mi name="open_in_new" size={14} color="#2e4f82" />
                          </Pressable>
                          {e.event_uid ? (
                            <Pressable {...PRESSABLE_INSTANT}
                              hitSlop={6}
                              style={styles.cardActionChip}
                              onPress={(ev) => { ev.stopPropagation?.(); openCalendarExportPicker(e); }}
                            >
                              <Mi name="calendar_today" size={14} color="#2e4f82" />
                            </Pressable>
          ) : null}
                        </View>
                      </View>
                    </Pressable>
                  );
              }}
            />
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
            <View style={{ flexDirection: "row", alignItems: "center", flex: 1, gap: 10 }}>
              {selectedMasjidProfile ? renderMasjidLogo(selectedMasjidProfile, 34) : null}
              <Text
                style={[styles.modalTitle, isMidnight && styles.modalTitleMidnight, isNeo && styles.modalTitleNeo, isVitaria && styles.modalTitleVitaria, isInferno && styles.modalTitleInferno, isEmerald && styles.modalTitleEmerald, { flex: 1 }]}
                numberOfLines={1}
              >
                {formatSourceLabel(selectedMasjidProfile)}
              </Text>
            </View>
            <Pressable {...PRESSABLE_INSTANT} style={styles.modalCloseBtn} hitSlop={12} onPress={() => setSelectedMasjidProfile("")}>
              <Text style={styles.modalCloseText}>Close</Text>
            </Pressable>
          </View>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={[styles.modalBody, { paddingBottom: insets.bottom + 40 }]}
            keyboardShouldPersistTaps="handled"
          >
            {(() => {
              const upcomingHere = masjidProfileEvents.filter((e) => (e.date || "") >= today && !isEventPastNow(e));
              const nextOne = upcomingHere[0];
              const coord = MASJID_COORDS[selectedMasjidProfile?.toLowerCase()];
              return (
                <View style={styles.masjidHeroCard}>
                  <Text style={styles.masjidHeroLine}>
                    {upcomingHere.length > 0
                      ? `${upcomingHere.length} upcoming gathering${upcomingHere.length === 1 ? "" : "s"} on the board.`
                      : "No events currently scheduled. Follow to get the next announcement."}
                  </Text>
                  {nextOne ? (
                    <Text style={styles.masjidHeroNext} numberOfLines={2}>
                      Next: {formatHumanDate(nextOne.date)} · {eventTime(nextOne) || "—"}  ·  {nextOne.title}
                    </Text>
                  ) : null}
                  {coord ? (
                    <Pressable {...PRESSABLE_INSTANT}
                      style={styles.masjidHeroDirectionsBtn}
                      onPress={() =>
                        Linking.openURL(
                          `https://www.google.com/maps/search/?api=1&query=${coord.latitude},${coord.longitude}`,
                        )
                      }
                    >
                      <Text style={styles.masjidHeroDirectionsText}>Get directions  →</Text>
                    </Pressable>
                  ) : null}
                </View>
              );
            })()}

            <View style={styles.modalActionsRow}>
              <Pressable {...PRESSABLE_INSTANT} style={[styles.modalActionBtn, styles.modalActionBtnPrimary]} onPress={() => toggleFollowMasjid(selectedMasjidProfile)}>
                <Text style={styles.modalActionBtnText}>
                  {followedMasjids.includes(selectedMasjidProfile) ? "Following masjid" : "Follow masjid"}
                </Text>
              </Pressable>
              {masjidProfileEvents[0]?.source_url ? (
                <Pressable {...PRESSABLE_INSTANT} style={styles.modalActionBtn} onPress={() => Linking.openURL(masjidProfileEvents[0].source_url)}>
                  <Text style={styles.modalActionBtnText}>Contact / website</Text>
                </Pressable>
              ) : null}
              {masjidProfileEvents[0]?.map_link ? (
                <Pressable {...PRESSABLE_INSTANT} style={styles.modalActionBtn} onPress={() => Linking.openURL(masjidProfileEvents[0].map_link || "")}>
                  <Text style={styles.modalActionBtnText}>Prayer schedule link</Text>
                </Pressable>
              ) : null}
              <Pressable {...PRESSABLE_INSTANT} style={[styles.modalActionBtn, { backgroundColor: "#eaf7ef" }]} onPress={() => stampPassport(selectedMasjidProfile)}>
                <Text style={[styles.modalActionBtnText, { color: "#1f7a42" }]}>+ Passport stamp</Text>
              </Pressable>
            </View>
            <View style={{ flexDirection: "row", gap: 8, marginBottom: 10 }}>
              <Pressable
                {...PRESSABLE_INSTANT}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: 16,
                  backgroundColor: masjidProfileViewTab === "events" ? "#2f67f5" : "#eef2ff",
                }}
                onPress={() => setMasjidProfileViewTab("events")}
              >
                <Text style={{ color: masjidProfileViewTab === "events" ? "#fff" : "#405072", fontWeight: "700" }}>Events</Text>
              </Pressable>
              <Pressable
                {...PRESSABLE_INSTANT}
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: 16,
                  backgroundColor: masjidProfileViewTab === "prayer" ? "#2f67f5" : "#eef2ff",
                }}
                onPress={() => setMasjidProfileViewTab("prayer")}
              >
                <Text style={{ color: masjidProfileViewTab === "prayer" ? "#fff" : "#405072", fontWeight: "700" }}>Prayer</Text>
              </Pressable>
            </View>

            {masjidProfileViewTab === "prayer" ? (() => {
              const iq = iqamaBySource[selectedMasjidProfile] || {};
              const prayers = ["fajr", "dhuhr", "asr", "maghrib", "isha"] as const;
              const anyIqama = prayers.some((p) => iq[p]?.iqama);
              const jumuah = iq["jumuah"]?.jumuah_times || [];
              const calc = prayerTimesBySource[selectedMasjidProfile];
              const apiPrayer = prayerApiBySource[selectedMasjidProfile];
              const usingFallback = !anyIqama && !!calc;
              if (!anyIqama && !calc && !jumuah.length) return null;
              return (
                <>
                  {apiPrayer?.is_stale ? (
                    <View style={[styles.hospitalListCard, { borderColor: "#f5b53d", borderWidth: 1, marginBottom: 10 }]}>
                      <Text style={[styles.hospitalListTitle, { color: "#9b5b00" }]}>Prayer data may be outdated</Text>
                      <Text style={styles.hospitalListMeta}>
                        {apiPrayer.last_updated_label || "unknown update time"} {apiPrayer.stale_reason ? `· ${apiPrayer.stale_reason}` : ""}
                      </Text>
                    </View>
                  ) : null}
                  <View style={styles.iqamaCard}>
                    <Text style={styles.iqamaTitle}>
                      {anyIqama ? "Iqama times" : "Prayer times today"}
                    </Text>
                    {usingFallback ? (
                      <Text style={styles.iqamaSub}>
                        Calculated adhan times (ISNA) — iqama is typically 10–20 min later.
                      </Text>
                    ) : null}
                    {apiPrayer?.last_updated_label ? (
                      <Text style={styles.iqamaSub}>
                        Updated {apiPrayer.last_updated_label} · {apiPrayer.source_type || "website_scrape"}
                      </Text>
                    ) : null}
                    <View style={styles.iqamaRow}>
                      {prayers.map((p) => (
                        <View key={p} style={styles.iqamaCell}>
                          <Text style={styles.iqamaPrayer}>{p[0].toUpperCase() + p.slice(1)}</Text>
                          <Text style={styles.iqamaTime}>
                            {iq[p]?.iqama
                              ? iq[p].iqama
                              : apiPrayer?.prayers?.[p]
                              ? apiPrayer.prayers[p]
                              : calc
                              ? (calc as any)[p] || "—"
                              : "—"}
                          </Text>
                          <Pressable
                            {...PRESSABLE_INSTANT}
                            onPress={() => submitPrayerTimeReport(selectedMasjidProfile, p, `Reported from ${formatSourceLabel(selectedMasjidProfile)}`)}
                          >
                            <Text style={[styles.hospitalListMeta, { color: "#4d75c4", marginTop: 4 }]}>Report wrong time</Text>
                          </Pressable>
                        </View>
                      ))}
                    </View>
                    {jumuah.length ? (
                      <Text style={styles.iqamaJumuah}>Jumu'ah: {jumuah.join("  ·  ")}</Text>
                    ) : null}
                    {apiPrayer?.source_url ? (
                      <Pressable {...PRESSABLE_INSTANT} onPress={() => Linking.openURL(apiPrayer.source_url)}>
                        <Text style={[styles.hospitalListMeta, { color: "#4d75c4", marginTop: 8 }]}>Open source schedule</Text>
                      </Pressable>
                    ) : null}
                  </View>
                </>
              );
            })() : (
              <>
                {(() => {
                  const am = masjidAmenities[(selectedMasjidProfile || "").toLowerCase()];
                  if (!am) return null;
                  const entries = Object.entries(am.amenities || {}).filter(([, v]) => {
                    if (typeof v === "boolean") return v;
                    if (typeof v === "number") return v > 0;
                    if (typeof v === "string") return v && v !== "none";
                    return false;
                  });
                  if (!entries.length && !am.description) return null;
                  const labelize = (k: string) => k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
                  return (
                    <View style={styles.amenitiesCard}>
                      <Text style={styles.amenitiesTitle}>Masjid amenities</Text>
                      {am.description ? <Text style={styles.amenitiesBody}>{am.description}</Text> : null}
                      {entries.length ? (
                        <View style={styles.amenitiesGrid}>
                          {entries.map(([k, v]) => (
                            <View key={`am-${k}`} style={styles.amenitiesChip}>
                              <Text style={styles.amenitiesChipCheck}>✓</Text>
                              <Text style={styles.amenitiesChipText}>{labelize(k)}{typeof v === "number" ? ` · ${v}` : typeof v === "string" ? ` · ${v}` : ""}</Text>
                            </View>
                          ))}
                        </View>
                      ) : null}
                    </View>
                  );
                })()}
                {masjidProfileEvents.slice(0, 15).map((e, idx) => renderEventListCard(e, `masjid-profile-${idx}`))}
              </>
            )}
          </ScrollView>
        </View>
      </Modal>
      <Modal
        visible={showJumuahFinder}
        animationType="slide"
        presentationStyle="fullScreen"
        statusBarTranslucent={false}
        onRequestClose={() => setShowJumuahFinder(false)}
      >
        <View style={[styles.modalContainer, { flex: 1, paddingTop: modalChromeTopPad }]}>
          <View style={styles.modalTop}>
            <Text style={styles.modalTitle}>Jumu'ah finder</Text>
            <Pressable {...PRESSABLE_INSTANT} style={styles.modalCloseBtn} hitSlop={12} onPress={() => setShowJumuahFinder(false)}>
              <Text style={styles.modalCloseText}>Close</Text>
            </Pressable>
          </View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={[styles.modalBody, { paddingBottom: insets.bottom + 32 }]}>
            <View style={styles.modalActionsRow}>
              <Pressable {...PRESSABLE_INSTANT} style={styles.roundGhostBtn} onPress={() => setJumuahFilters((p) => ({ ...p, language: p.language ? "" : "english" }))}>
                <Text style={styles.roundGhostText}>{jumuahFilters.language ? `Lang: ${jumuahFilters.language}` : "Language: any"}</Text>
              </Pressable>
              <Pressable {...PRESSABLE_INSTANT} style={styles.roundGhostBtn} onPress={() => setJumuahFilters((p) => ({ ...p, parking: !p.parking }))}>
                <Text style={styles.roundGhostText}>{jumuahFilters.parking ? "Parking: required" : "Parking: any"}</Text>
              </Pressable>
              <Pressable {...PRESSABLE_INSTANT} style={styles.roundGhostBtn} onPress={() => setJumuahFilters((p) => ({ ...p, radius: p.radius >= 50 ? 15 : p.radius + 10 }))}>
                <Text style={styles.roundGhostText}>Radius: {jumuahFilters.radius}mi</Text>
              </Pressable>
            </View>
            <Pressable {...PRESSABLE_INSTANT} style={[styles.roundGhostBtn, { alignSelf: "flex-start", marginBottom: 10 }]} onPress={() => void refreshJumuahFinder()}>
              <Text style={styles.roundGhostText}>Apply filters</Text>
            </Pressable>
            {jumuahFinderRows.length === 0 ? (
              <View style={styles.hospitalListCard}>
                <Text style={styles.hospitalListMeta}>No Jumu'ah matches yet. Try widening radius/time.</Text>
              </View>
            ) : null}
            {jumuahFinderRows.map((row, idx) => (
              <View key={`jumuah-${row.source || idx}`} style={styles.hospitalListCard}>
                <Text style={styles.hospitalListTitle}>{formatSourceLabel(row.source)}</Text>
                <Text style={styles.hospitalListMeta}>
                  {typeof row.distance_miles === "number" ? `${row.distance_miles} mi away` : "Distance unknown"} · Updated {row.last_updated_label || "unknown"}
                </Text>
                {(row.jumuah || []).map((slot: any, jdx: number) => (
                  <Text key={`slot-${jdx}`} style={styles.hospitalListMeta}>
                    {slot.time || "TBD"}{slot.language ? ` · ${slot.language}` : ""}{typeof slot.minutes_until === "number" ? ` · in ${Math.max(0, slot.minutes_until)}m` : ""}
                  </Text>
                ))}
                <View style={styles.modalActionsRow}>
                  <Pressable {...PRESSABLE_INSTANT} style={styles.roundGhostBtn} onPress={() => setSelectedMasjidProfile(row.source)}>
                    <Text style={styles.roundGhostText}>Open masjid</Text>
                  </Pressable>
                  <Pressable {...PRESSABLE_INSTANT} style={styles.roundGhostBtn} onPress={() => row.source_url && Linking.openURL(row.source_url)}>
                    <Text style={styles.roundGhostText}>Source</Text>
                  </Pressable>
                </View>
              </View>
            ))}
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
            <Pressable {...PRESSABLE_INSTANT} style={styles.modalCloseBtn} hitSlop={12} onPress={() => setShowModerationQueue(false)}>
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
                  <Pressable {...PRESSABLE_INSTANT} style={styles.roundGhostBtn} onPress={() => updateModerationReportStatus(Number(r.id), "in_review")}>
                    <Text style={styles.roundGhostText}>Review</Text>
                  </Pressable>
                  <Pressable {...PRESSABLE_INSTANT} style={styles.roundGhostBtn} onPress={() => updateModerationReportStatus(Number(r.id), "resolved")}>
                    <Text style={styles.roundGhostText}>Resolve</Text>
                  </Pressable>
                </View>
                <View style={styles.modalActionsRow}>
                  <Pressable {...PRESSABLE_INSTANT} style={styles.roundGhostBtn} onPress={() => applyModerationMacro(Number(r.id), "title_fix")}>
                    <Text style={styles.roundGhostText}>Approve title</Text>
                  </Pressable>
                  <Pressable {...PRESSABLE_INSTANT} style={styles.roundGhostBtn} onPress={() => applyModerationMacro(Number(r.id), "speaker_fix")}>
                    <Text style={styles.roundGhostText}>Approve speaker</Text>
                  </Pressable>
                  <Pressable {...PRESSABLE_INSTANT} style={styles.roundGhostBtn} onPress={() => applyModerationMacro(Number(r.id), "poster_fix")}>
                    <Text style={styles.roundGhostText}>Swap poster</Text>
                  </Pressable>
                  <Pressable {...PRESSABLE_INSTANT} style={styles.roundGhostBtn} onPress={() => applyModerationMacro(Number(r.id), "merge_duplicate")}>
                    <Text style={styles.roundGhostText}>Merge dup</Text>
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
          <Pressable {...PRESSABLE_INSTANT} style={StyleSheet.absoluteFillObject} onPress={() => setSelectedMasjidSheet("")} />
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
              {selectedMasjidSheet ? (
                <View style={{ marginRight: 12 }}>
                  {renderMasjidLogo(selectedMasjidSheet, 44)}
                </View>
              ) : null}
              <View style={{ flex: 1 }}>
                <Text style={[styles.bottomSheetTitle, isDarkTheme && styles.bottomSheetTitleDark]} numberOfLines={2}>
                  {formatSourceLabel(selectedMasjidSheet)}
                </Text>
                <Text style={[styles.bottomSheetSub, isDarkTheme && styles.bottomSheetSubDark]}>
                  {(upcomingEventsBySource[selectedMasjidSheet.toLowerCase()] || []).length} upcoming event(s)
                </Text>
              </View>
              <Pressable {...PRESSABLE_INSTANT}
                onPress={() => toggleFollowMasjid(selectedMasjidSheet)}
                hitSlop={8}
                style={[styles.bottomSheetFollowBtn, followedMasjids.includes(selectedMasjidSheet) && styles.bottomSheetFollowBtnActive]}
              >
                <Text style={[styles.bottomSheetFollowText, followedMasjids.includes(selectedMasjidSheet) && styles.bottomSheetFollowTextActive]}>
                  {followedMasjids.includes(selectedMasjidSheet) ? "Following" : "Follow"}
                </Text>
              </Pressable>
              <Pressable {...PRESSABLE_INSTANT} hitSlop={12} onPress={() => setSelectedMasjidSheet("")} style={styles.bottomSheetCloseBtn}>
                <Mi name="close" size={18} color="#454f63" />
              </Pressable>
            </View>
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{ paddingVertical: 8, gap: 10 }}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator
            >
              {/* Events come FIRST — it's what the user tapped the masjid
                  for. Iqama / prayer-time block renders below so it's
                  still available without burying the upcoming events. */}
              {(() => {
                const masjidEvents = upcomingEventsBySource[selectedMasjidSheet.toLowerCase()] || [];
                if (!masjidEvents.length) {
                  return (
                    <Text style={[styles.bottomSheetSub, { textAlign: "center", marginTop: 24 }, isDarkTheme && styles.bottomSheetSubDark]}>
                      Nothing on the board for this masjid yet. Follow them — we'll ping you the moment they add an event.
                    </Text>
                  );
                }
                // Horizontal ScrollView (more reliable than a nested
                // horizontal FlatList with pagingEnabled inside a vertical
                // ScrollView — that combo intermittently collapses to 0
                // height on iOS and was hiding the events entirely).
                // Below the carousel we also render a plain vertical list as
                // a guaranteed-functional fallback so users can always see
                // and tap every event for this masjid.
                return (
                  <View>
                    <ScrollView
                      horizontal
                      showsHorizontalScrollIndicator={false}
                      decelerationRate="fast"
                      snapToInterval={masjidPosterWidth + 16}
                      snapToAlignment="start"
                      style={{ height: masjidPosterHeight }}
                      contentContainerStyle={{ paddingHorizontal: 16, paddingVertical: 8, gap: 16 }}
                    >
                      {masjidEvents.map((ev, idx) => {
                        const poster = eventPosterUrl(ev);
                        return (
                          <Pressable {...PRESSABLE_INSTANT}
                            key={`sheet-poster-${eventStorageKey(ev)}-${idx}`}
                            style={[
                              styles.masjidPosterCard,
                              { width: masjidPosterWidth },
                              isDarkTheme && styles.masjidPosterCardDark,
                            ]}
                            onPress={() => {
                              setSelectedMasjidSheet("");
                              openEventDetails(ev);
                            }}
                          >
                            {poster && canRenderPoster(poster) ? (
                              <LoadableNetworkImage
                                uri={poster}
                                style={styles.masjidPosterImage}
                                onError={() => markPosterFailed(poster)}
                              />
                            ) : (
                              <View style={[styles.masjidPosterImage, styles.masjidPosterImageEmpty]}>
                                <Mi name="mosque" size={56} color="#a3b0c8" />
                              </View>
                            )}
                            <View style={styles.masjidPosterCaption}>
                              <View style={styles.masjidPosterCaptionMeta}>
                                <Text style={styles.masjidPosterCaptionDate} numberOfLines={1}>
                                  {formatHumanDate(ev.date)}
                                </Text>
                                <Text style={styles.masjidPosterCaptionDot}>·</Text>
                                <Text style={styles.masjidPosterCaptionTime} numberOfLines={1}>
                                  {eventTime(ev)}
                                </Text>
                              </View>
                              <Text style={styles.masjidPosterCaptionTitle} numberOfLines={2}>
                                {eventDisplayTitle(ev)}
                              </Text>
                              <View style={styles.masjidPosterCaptionHint}>
                                <Text style={styles.masjidPosterCaptionHintText}>
                                  {idx + 1} / {masjidEvents.length} · tap to open
                                </Text>
                              </View>
                            </View>
                          </Pressable>
                        );
                      })}
                    </ScrollView>
                    <View style={{ paddingHorizontal: 16, marginTop: 12, gap: 8 }}>
                      <Text style={[styles.bottomSheetSub, isDarkTheme && styles.bottomSheetSubDark, { fontWeight: "800", color: "#1b2333" }]}>
                        All upcoming ({masjidEvents.length})
                      </Text>
                      {masjidEvents.map((ev, idx) => {
                        const temporal = getEventTemporalState(ev);
                        return (
                          <Pressable {...PRESSABLE_INSTANT}
                            key={`sheet-list-${eventStorageKey(ev)}-${idx}`}
                            style={[styles.sheetEventRow, isDarkTheme && styles.sheetEventRowDark]}
                            onPress={() => {
                              setSelectedMasjidSheet("");
                              openEventDetails(ev);
                            }}
                          >
                            <View style={{ flex: 1 }}>
                              <View style={{ flexDirection: "row", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                {temporal.isPast ? (
                                  <View style={styles.eventPastBadge}>
                                    <Text style={styles.eventPastText}>ALREADY HAPPENED</Text>
                                  </View>
                                ) : null}
                                {temporal.isLive ? (
                                  <View style={styles.liveNowBadge}>
                                    <View style={styles.liveNowDot} />
                                    <Text style={styles.liveNowText}>LIVE NOW</Text>
                                  </View>
                                ) : null}
                                {!temporal.isLive && !temporal.isPast && temporal.startsInMinutes != null ? (
                                  <View style={styles.eventStartsSoonBadge}>
                                    <Text style={styles.eventStartsSoonText}>
                                      {temporal.startsInMinutes <= 1 ? "STARTS IN 1M" : `STARTS IN ${temporal.startsInMinutes}M`}
                                    </Text>
                                  </View>
                                ) : null}
                                <Text style={[styles.sheetEventWhen, isDarkTheme && { color: "#c4cee8" }]} numberOfLines={1}>
                                  {formatHumanDate(ev.date)} · {eventTime(ev)}
                                </Text>
                              </View>
                              <Text style={[styles.sheetEventTitle, isDarkTheme && { color: "#f4f7ff" }]} numberOfLines={2}>
                                {eventDisplayTitle(ev)}
                              </Text>
                            </View>
                            <Text style={[styles.sheetEventChevron, isDarkTheme && { color: "#8aa3d4" }]}>›</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  </View>
                );
              })()}

              {/* Iqama / prayer times card. Now below events so the
                  primary reason for opening the sheet is visible first. */}
              {(() => {
                const src = selectedMasjidSheet;
                if (!src) return null;
                const iq = iqamaBySource[src] || {};
                const prayers = ["fajr", "dhuhr", "asr", "maghrib", "isha"] as const;
                const anyIqama = prayers.some((p) => iq[p]?.iqama);
                const jumuah = iq["jumuah"]?.jumuah_times || [];
                const calc = prayerTimesBySource[src];
                const usingFallback = !anyIqama && !!calc;
                if (!anyIqama && !calc && !jumuah.length) {
                  return (
                    <View style={styles.iqamaCard}>
                      <Text style={styles.iqamaTitle}>Prayer times</Text>
                      <Text style={styles.iqamaSub}>Loading today's prayer times…</Text>
                    </View>
                  );
                }
                return (
                  <View style={styles.iqamaCard}>
                    <Text style={styles.iqamaTitle}>
                      {anyIqama ? "Iqama times" : "Prayer times today"}
                    </Text>
                    {usingFallback ? (
                      <Text style={styles.iqamaSub}>
                        Calculated adhan times (ISNA) — iqama is typically 10–20 min later.
                      </Text>
                    ) : null}
                    <View style={styles.iqamaRow}>
                      {prayers.map((p) => (
                        <View key={p} style={styles.iqamaCell}>
                          <Text style={styles.iqamaPrayer}>{p[0].toUpperCase() + p.slice(1)}</Text>
                          <Text style={styles.iqamaTime}>
                            {iq[p]?.iqama
                              ? iq[p].iqama
                              : calc
                              ? (calc as any)[p] || "—"
                              : "—"}
                          </Text>
                        </View>
                      ))}
                    </View>
                    {jumuah.length ? (
                      <Text style={styles.iqamaJumuah}>
                        Jumu'ah: {jumuah.join("  ·  ")}
                      </Text>
                    ) : null}
                    <Pressable {...PRESSABLE_INSTANT} style={styles.iqamaStampBtn} onPress={() => stampPassport(src)}>
                      <Text style={styles.iqamaStampText}>✓ I'm here — stamp passport</Text>
                    </Pressable>
                  </View>
                );
              })()}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* Explore filters modal — redesigned: grouped cards, preset date
          chips, visual distance picker, masjid grid, sticky apply bar with
          live match count. */}
      <Modal
        visible={showExploreFilters}
        animationType="slide"
        presentationStyle="fullScreen"
        statusBarTranslucent={false}
        onRequestClose={() => setShowExploreFilters(false)}
      >
        {(() => {
          const activeFilterCount =
            (query.trim() ? 1 : 0) +
            (audienceFilter !== "all" ? 1 : 0) +
            quickFilters.length +
            (selectedSources.size > 0 ? 1 : 0) +
            (sortMode !== "soonest" ? 1 : 0) +
            (radius && radius !== "35" ? 1 : 0);
          const visibleMatchCount = orderedVisibleEvents.length;
          const resetAll = () => {
            setQuery("");
            setReference("");
            setRadius("35");
            setStartDate(todayIso());
            setEndDate(plusDaysIso(365));
            setQuickFilters([]);
            setSelectedSources(new Set());
            setAudienceFilter("all");
            setSortMode("soonest");
            hapticTap("selection");
          };
          const applyDatePreset = (kind: "today" | "weekend" | "week" | "month" | "any") => {
            const now = new Date();
            const pad = (n: number) => String(n).padStart(2, "0");
            const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
            if (kind === "today") {
              const t = iso(now);
              setStartDate(t);
              setEndDate(t);
            } else if (kind === "weekend") {
              const day = now.getDay();
              const daysToFri = (5 - day + 7) % 7;
              const fri = new Date(now);
              fri.setDate(now.getDate() + daysToFri);
              const sun = new Date(fri);
              sun.setDate(fri.getDate() + 2);
              setStartDate(iso(fri));
              setEndDate(iso(sun));
            } else if (kind === "week") {
              setStartDate(iso(now));
              setEndDate(plusDaysIso(7));
            } else if (kind === "month") {
              setStartDate(iso(now));
              setEndDate(plusDaysIso(30));
            } else {
              setStartDate(todayIso());
              setEndDate(plusDaysIso(365));
            }
            hapticTap("selection");
          };
          const dateKind: "today" | "weekend" | "week" | "month" | "any" | "custom" = (() => {
            if (startDate === todayIso() && endDate === plusDaysIso(365)) return "any";
            if (startDate === endDate && startDate === todayIso()) return "today";
            if (startDate === todayIso() && endDate === plusDaysIso(7)) return "week";
            if (startDate === todayIso() && endDate === plusDaysIso(30)) return "month";
            return "custom";
          })();
          return (
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
                <View style={{ flex: 1 }}>
                  <Text style={[styles.modalTitle, isMidnight && styles.modalTitleMidnight, isNeo && styles.modalTitleNeo, isVitaria && styles.modalTitleVitaria, isInferno && styles.modalTitleInferno, isEmerald && styles.modalTitleEmerald]} numberOfLines={1}>
                    Refine
            </Text>
                  <Text style={[styles.filtersHeaderSub, isDarkTheme && { color: "#9db0db" }]}>
                    {activeFilterCount === 0 ? "No filters active" : `${activeFilterCount} filter${activeFilterCount === 1 ? "" : "s"} active · ${visibleMatchCount} event${visibleMatchCount === 1 ? "" : "s"}`}
                  </Text>
                </View>
                {activeFilterCount > 0 ? (
                  <Pressable {...PRESSABLE_INSTANT} onPress={resetAll} hitSlop={10} style={styles.filtersResetPill}>
                    <Text style={styles.filtersResetPillText}>Reset</Text>
                  </Pressable>
                ) : null}
            <Pressable {...PRESSABLE_INSTANT} style={styles.modalCloseBtn} hitSlop={12} onPress={() => setShowExploreFilters(false)}>
              <Text style={styles.modalCloseText}>Done</Text>
            </Pressable>
          </View>
          <ScrollView
            style={{ flex: 1 }}
                contentContainerStyle={[styles.filtersScrollBody, { paddingBottom: insets.bottom + 100 }]}
            keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                {/* WHEN — date preset chips */}
                <View style={[styles.filtersCard, isDarkTheme && styles.filtersCardDark]}>
                  <View style={styles.filtersCardHeader}>
                    <Text style={[styles.filtersCardTitle, isDarkTheme && { color: "#f4f7ff" }]}>When</Text>
                    <Text style={[styles.filtersCardSub, isDarkTheme && { color: "#9db0db" }]}>
                      {dateKind === "custom" ? `${startDate} → ${endDate}` : null}
                    </Text>
                  </View>
                  <View style={styles.filtersChipRow}>
                    {[
                      ["today", "Today"],
                      ["weekend", "This weekend"],
                      ["week", "Next 7 days"],
                      ["month", "Next 30 days"],
                      ["any", "Any time"],
                    ].map(([id, label]) => {
                      const active = dateKind === id;
                      return (
                        <Pressable {...PRESSABLE_INSTANT}
                          key={`when-${id}`}
                          style={[styles.filtersChip, active && styles.filtersChipActive, isDarkTheme && styles.filtersChipDark, active && isDarkTheme && styles.filtersChipActiveDark]}
                          onPress={() => applyDatePreset(id as any)}
                        >
                          <Text style={[styles.filtersChipText, active && styles.filtersChipTextActive, isDarkTheme && styles.filtersChipTextDark]}>{label}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                {/* AUDIENCE */}
                <View style={[styles.filtersCard, isDarkTheme && styles.filtersCardDark]}>
                  <View style={styles.filtersCardHeader}>
                    <Text style={[styles.filtersCardTitle, isDarkTheme && { color: "#f4f7ff" }]}>For whom</Text>
                    <Text style={[styles.filtersCardSub, isDarkTheme && { color: "#9db0db" }]}>Audience — pick one</Text>
                  </View>
                  <View style={styles.filtersChipRow}>
                    {([
                      ["all", "Everyone"],
                      ["brothers", "Brothers"],
                      ["sisters", "Sisters"],
                      ["family", "Family"],
                    ] as const).map(([id, label]) => {
                      const active = audienceFilter === id;
                      return (
                        <Pressable {...PRESSABLE_INSTANT}
                          key={`aud-${id}`}
                          style={[styles.filtersChip, active && styles.filtersChipActive, isDarkTheme && styles.filtersChipDark, active && isDarkTheme && styles.filtersChipActiveDark]}
                          onPress={() => { setAudienceFilter(id); hapticTap("selection"); }}
                        >
                          <Text style={[styles.filtersChipText, active && styles.filtersChipTextActive, isDarkTheme && styles.filtersChipTextDark]}>{label}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                {/* QUICK PICKS */}
                <View style={[styles.filtersCard, isDarkTheme && styles.filtersCardDark]}>
                  <View style={styles.filtersCardHeader}>
                    <Text style={[styles.filtersCardTitle, isDarkTheme && { color: "#f4f7ff" }]}>Quick picks</Text>
                    <Text style={[styles.filtersCardSub, isDarkTheme && { color: "#9db0db" }]}>
                      {quickFilters.length > 0 ? `${quickFilters.length} selected` : "Add any that fit"}
                    </Text>
                  </View>
                  <View style={styles.filtersChipRow}>
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
                        <Pressable {...PRESSABLE_INSTANT}
                          key={`qp-${id}`}
                          style={[styles.filtersChip, active && styles.filtersChipActive, isDarkTheme && styles.filtersChipDark, active && isDarkTheme && styles.filtersChipActiveDark]}
                          onPress={() => {
                            setQuickFilters((prev) =>
                              prev.includes(id as QuickFilterId)
                                ? prev.filter((x) => x !== id)
                                : [...prev, id as QuickFilterId]
                            );
                            hapticTap("selection");
                          }}
                        >
                          <Text style={[styles.filtersChipText, active && styles.filtersChipTextActive, isDarkTheme && styles.filtersChipTextDark]}>{label}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                {/* SORT */}
                <View style={[styles.filtersCard, isDarkTheme && styles.filtersCardDark]}>
                  <View style={styles.filtersCardHeader}>
                    <Text style={[styles.filtersCardTitle, isDarkTheme && { color: "#f4f7ff" }]}>Sort by</Text>
                  </View>
                  <View style={styles.filtersChipRow}>
                    {[
                      ["soonest", "Soonest"],
                      ["nearest", "Nearest"],
                      ["relevant", "Most relevant"],
                      ["recent", "Recently added"],
                    ].map(([id, label]) => {
                      const active = sortMode === id;
                      return (
                        <Pressable {...PRESSABLE_INSTANT}
                          key={`sort-${id}`}
                          style={[styles.filtersChip, active && styles.filtersChipActive, isDarkTheme && styles.filtersChipDark, active && isDarkTheme && styles.filtersChipActiveDark]}
                          onPress={() => { setSortMode(id as SortMode); hapticTap("selection"); }}
                        >
                          <Text style={[styles.filtersChipText, active && styles.filtersChipTextActive, isDarkTheme && styles.filtersChipTextDark]}>{label}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                {/* DISTANCE */}
                <View style={[styles.filtersCard, isDarkTheme && styles.filtersCardDark]}>
                  <View style={styles.filtersCardHeader}>
                    <Text style={[styles.filtersCardTitle, isDarkTheme && { color: "#f4f7ff" }]}>How far</Text>
                    <Text style={[styles.filtersCardSub, isDarkTheme && { color: "#9db0db" }]}>
                      {radius === "999" ? "Any distance" : `Within ${radius || 35} miles`}
                    </Text>
                  </View>
                  <View style={styles.filtersChipRow}>
                    {[
                      ["5", "5 mi"],
                      ["10", "10 mi"],
                      ["25", "25 mi"],
                      ["50", "50 mi"],
                      ["999", "Any"],
                    ].map(([val, label]) => {
                      const active = radius === val;
                      return (
                        <Pressable {...PRESSABLE_INSTANT}
                          key={`dist-${val}`}
                          style={[styles.filtersChip, active && styles.filtersChipActive, isDarkTheme && styles.filtersChipDark, active && isDarkTheme && styles.filtersChipActiveDark]}
                          onPress={() => { setRadius(val as string); hapticTap("selection"); }}
                        >
                          <Text style={[styles.filtersChipText, active && styles.filtersChipTextActive, isDarkTheme && styles.filtersChipTextDark]}>{label}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                {/* MASJIDS */}
                <View style={[styles.filtersCard, isDarkTheme && styles.filtersCardDark]}>
                  <View style={styles.filtersCardHeader}>
                    <Text style={[styles.filtersCardTitle, isDarkTheme && { color: "#f4f7ff" }]}>Masjids</Text>
                    <Text style={[styles.filtersCardSub, isDarkTheme && { color: "#9db0db" }]}>
                      {selectedSources.size === 0 ? "All masjids" : `${selectedSources.size} selected`}
                    </Text>
                  </View>
                  <View style={styles.filtersChipRow}>
                    {selectedSources.size > 0 ? (
                      <Pressable {...PRESSABLE_INSTANT}
                        style={[styles.filtersChip, styles.filtersChipGhost, isDarkTheme && styles.filtersChipDark]}
                        onPress={() => { setSelectedSources(new Set()); hapticTap("selection"); }}
                      >
                        <Text style={[styles.filtersChipText, styles.filtersChipGhostText]}>Clear</Text>
                      </Pressable>
                    ) : null}
                    {(meta?.sources || []).map((src) => {
                      const active = selectedSources.has(src);
                      return (
                        <Pressable {...PRESSABLE_INSTANT}
                          key={`msj-${src}`}
                          onPress={() => { toggleSource(src); hapticTap("selection"); }}
                          style={[styles.filtersChip, active && styles.filtersChipActive, isDarkTheme && styles.filtersChipDark, active && isDarkTheme && styles.filtersChipActiveDark]}
                        >
                          {renderMasjidLogo(src, 18, { style: { marginRight: 6 } })}
                          <Text style={[styles.filtersChipText, active && styles.filtersChipTextActive, isDarkTheme && styles.filtersChipTextDark]}>{formatSourceLabel(src)}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>

                {/* KEYWORD */}
                <View style={[styles.filtersCard, isDarkTheme && styles.filtersCardDark]}>
                  <View style={styles.filtersCardHeader}>
                    <Text style={[styles.filtersCardTitle, isDarkTheme && { color: "#f4f7ff" }]}>Keyword</Text>
                    <Text style={[styles.filtersCardSub, isDarkTheme && { color: "#9db0db" }]}>Search titles, descriptions, speakers</Text>
                  </View>
                  <TextInput
                    style={[styles.filtersSearchInput, isDarkTheme && styles.filtersSearchInputDark]}
                    value={query}
                    onChangeText={setQuery}
                    placeholder="e.g. tafseer, youth halaqa, Mufti Menk"
                    placeholderTextColor={isDarkTheme ? "#5a6a8a" : "#a0a9bd"}
                    returnKeyType="search"
                  />
                </View>

                {/* CUSTOM DATES (advanced) */}
                {dateKind === "custom" ? (
                  <View style={[styles.filtersCard, isDarkTheme && styles.filtersCardDark]}>
                    <View style={styles.filtersCardHeader}>
                      <Text style={[styles.filtersCardTitle, isDarkTheme && { color: "#f4f7ff" }]}>Custom range</Text>
                    </View>
                    <View style={{ flexDirection: "row", gap: 10 }}>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.filtersInputLabel, isDarkTheme && { color: "#9db0db" }]}>From</Text>
                        <TextInput
                          style={[styles.filtersSearchInput, isDarkTheme && styles.filtersSearchInputDark]}
                          value={startDate}
                          onChangeText={setStartDate}
                          placeholder="YYYY-MM-DD"
                          placeholderTextColor={isDarkTheme ? "#5a6a8a" : "#a0a9bd"}
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Text style={[styles.filtersInputLabel, isDarkTheme && { color: "#9db0db" }]}>To</Text>
                        <TextInput
                          style={[styles.filtersSearchInput, isDarkTheme && styles.filtersSearchInputDark]}
                          value={endDate}
                          onChangeText={setEndDate}
                          placeholder="YYYY-MM-DD"
                          placeholderTextColor={isDarkTheme ? "#5a6a8a" : "#a0a9bd"}
                        />
                      </View>
                    </View>
                  </View>
                ) : null}

                {/* SAVED PRESETS */}
                {savedFilterPresets.length > 0 || presetDraftLabel ? (
                  <View style={[styles.filtersCard, isDarkTheme && styles.filtersCardDark]}>
                    <View style={styles.filtersCardHeader}>
                      <Text style={[styles.filtersCardTitle, isDarkTheme && { color: "#f4f7ff" }]}>Saved filter sets</Text>
                      <Text style={[styles.filtersCardSub, isDarkTheme && { color: "#9db0db" }]}>Your go-to combos</Text>
                    </View>
                    <View style={styles.filtersChipRow}>
                      {savedFilterPresets.map((preset) => (
                        <Pressable {...PRESSABLE_INSTANT}
                          key={`preset-${preset.id}`}
                          style={[styles.filtersChip, isDarkTheme && styles.filtersChipDark]}
                          onPress={() => { applyPreset(preset); hapticTap("selection"); }}
                        >
                          <Text style={[styles.filtersChipText, isDarkTheme && styles.filtersChipTextDark]}>{preset.label}</Text>
                        </Pressable>
                      ))}
                    </View>
                  </View>
                ) : null}

                <View style={[styles.filtersCard, isDarkTheme && styles.filtersCardDark, { marginBottom: 4 }]}>
                  <View style={styles.filtersCardHeader}>
                    <Text style={[styles.filtersCardTitle, isDarkTheme && { color: "#f4f7ff" }]}>Save this combo</Text>
                  </View>
                  <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
              <TextInput
                      style={[styles.filtersSearchInput, { flex: 1 }, isDarkTheme && styles.filtersSearchInputDark]}
                value={presetDraftLabel}
                onChangeText={setPresetDraftLabel}
                      placeholder="Preset name"
                      placeholderTextColor={isDarkTheme ? "#5a6a8a" : "#a0a9bd"}
                    />
                    <Pressable {...PRESSABLE_INSTANT} style={styles.filtersSavePresetBtn} onPress={saveCurrentPreset}>
                      <Text style={styles.filtersSavePresetText}>{editingPresetId ? "Update" : "Save"}</Text>
              </Pressable>
              {editingPresetId ? (
                <Pressable {...PRESSABLE_INSTANT}
                        style={[styles.filtersChip, styles.filtersChipGhost]}
                  onPress={() => {
                    setEditingPresetId("");
                    setPresetDraftLabel("");
                  }}
                >
                        <Mi name="close" size={14} color="#c94620" />
                </Pressable>
              ) : null}
            </View>
                </View>
          </ScrollView>

              {/* Sticky apply bar */}
              <View style={[styles.filtersStickyApplyWrap, { paddingBottom: insets.bottom + 12 }, isDarkTheme && styles.filtersStickyApplyWrapDark]}>
                <Pressable {...PRESSABLE_INSTANT}
                  style={styles.filtersApplyBtn}
                  onPress={() => {
                    loadEvents({ force: true });
                    setShowExploreFilters(false);
                    hapticTap("success");
                  }}
                >
                  <Text style={styles.filtersApplyBtnText}>
                    {loading ? "Loading…" : `Show ${visibleMatchCount} event${visibleMatchCount === 1 ? "" : "s"}`}
                  </Text>
                </Pressable>
              </View>
        </View>
          );
        })()}
      </Modal>

      {/* Privacy policy modal — in-app plain-english policy */}
      <Modal
        visible={showPrivacyPolicy}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setShowPrivacyPolicy(false)}
      >
        <View style={[styles.modalContainer, isDarkTheme && styles.modalContainerMidnight, { flex: 1, paddingTop: modalChromeTopPad }]}>
          <View style={[styles.modalTop, isDarkTheme && styles.modalTopMidnight]}>
            <Text style={[styles.modalTitle, isDarkTheme && styles.modalTitleMidnight]} numberOfLines={1}>Privacy policy</Text>
            <Pressable {...PRESSABLE_INSTANT} style={styles.modalCloseBtn} hitSlop={12} onPress={() => setShowPrivacyPolicy(false)}>
              <Text style={styles.modalCloseText}>Close</Text>
            </Pressable>
          </View>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 40, gap: 14 }}
            showsVerticalScrollIndicator={false}
          >
            <Text style={[styles.legalUpdated, isDarkTheme && { color: "#9db0db" }]}>Last updated: April 21, 2026</Text>

            <Text style={[styles.legalIntro, isDarkTheme && { color: "#c4cee8" }]}>
              Masjid.ly is a tool to help you find and attend events at local masjids. We built it with
              the same adab we'd want from any service touching our community — collect only what's
              needed, never sell your data, and give you plain-English control.
            </Text>

            <Text style={[styles.legalSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>What we collect</Text>
            <Text style={[styles.legalBody, isDarkTheme && { color: "#c4cee8" }]}>
              <Text style={styles.legalBold}>When you give it to us: </Text>
              Your first name (if you enter one), your email (if you sign up), your interests and audience
              preferences, and the masjids and scholars you choose to follow.
              {"\n\n"}
              <Text style={styles.legalBold}>From your device (only if you allow it): </Text>
              Your approximate location — used to sort events by distance and show what's near you. Push
              notification token — used only to send reminders for events you RSVP'd to or new events from
              masjids you follow. A random share code we generate for you.
              {"\n\n"}
              <Text style={styles.legalBold}>Automatically: </Text>
              Which events you save, RSVP to, or mark as attended — stored locally on your device and (if
              signed in) synced to your account so it follows you across devices.
            </Text>

            <Text style={[styles.legalSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>What we don't collect</Text>
            <Text style={[styles.legalBody, isDarkTheme && { color: "#c4cee8" }]}>
              No advertising identifiers, no third-party trackers, no contacts list, no browsing history,
              no biometric data. We don't sell your data. Full stop.
            </Text>

            <Text style={[styles.legalSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>How we use it</Text>
            <Text style={[styles.legalBody, isDarkTheme && { color: "#c4cee8" }]}>
              Solely to: show you relevant events, sort by distance, send reminders for events you've
              RSVP'd to, notify you about new events from masjids you follow, and keep your saved list
              synced between devices. That's it.
            </Text>

            <Text style={[styles.legalSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>Where your data lives</Text>
            <Text style={[styles.legalBody, isDarkTheme && { color: "#c4cee8" }]}>
              Most data stays on your device (AsyncStorage). Account data — if you sign up — is stored on
              our servers hosted in the United States. We use the following services, each of which has
              its own privacy policy:
              {"\n"}• Railway (event API hosting){"\n"}• Expo (push notifications){"\n"}• Google Maps (map
              tiles only; your coordinates never leave your phone on the map screen){"\n"}• Ko-fi (only
              if you donate, directly on their site — we never see your payment info)
            </Text>

            <Text style={[styles.legalSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>Sharing</Text>
            <Text style={[styles.legalBody, isDarkTheme && { color: "#c4cee8" }]}>
              We do not share, sell, or rent your personal data to anyone, ever. The only time we
              disclose information is if we're legally required to (a court order), and we'd push back
              first.
            </Text>

            <Text style={[styles.legalSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>Your rights</Text>
            <Text style={[styles.legalBody, isDarkTheme && { color: "#c4cee8" }]}>
              You can:
              {"\n"}• View, edit, or clear your profile from Settings → Your profile.
              {"\n"}• Clear your saved events and RSVPs from Settings → Clear saved events.
              {"\n"}• Revoke location or notification permission at any time in iOS Settings.
              {"\n"}• Delete your account and all associated data: email <Text style={styles.legalBold}>hello@masjidly.app</Text> and we'll wipe it within 7 days.
            </Text>

            <Text style={[styles.legalSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>Children</Text>
            <Text style={[styles.legalBody, isDarkTheme && { color: "#c4cee8" }]}>
              Masjid.ly is intended for users age 13 and up. We don't knowingly collect data from anyone
              under 13. If you think a child has provided information, email us and we'll delete it.
            </Text>

            <Text style={[styles.legalSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>Changes</Text>
            <Text style={[styles.legalBody, isDarkTheme && { color: "#c4cee8" }]}>
              We may update this policy — the date at the top will reflect when. We'll never make a
              material change without an in-app notice.
            </Text>

            <Text style={[styles.legalSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>Contact</Text>
            <Pressable {...PRESSABLE_INSTANT} onPress={() => Linking.openURL("mailto:hello@masjidly.app?subject=Masjid.ly%20privacy")}>
              <Text style={[styles.legalBody, { color: "#2e4f82", fontWeight: "700" }]}>
                hello@masjidly.app
              </Text>
            </Pressable>
          </ScrollView>
        </View>
      </Modal>

      {/* Terms of use modal */}
      <Modal
        visible={showTermsOfUse}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setShowTermsOfUse(false)}
      >
        <View style={[styles.modalContainer, isDarkTheme && styles.modalContainerMidnight, { flex: 1, paddingTop: modalChromeTopPad }]}>
          <View style={[styles.modalTop, isDarkTheme && styles.modalTopMidnight]}>
            <Text style={[styles.modalTitle, isDarkTheme && styles.modalTitleMidnight]} numberOfLines={1}>Terms of use</Text>
            <Pressable {...PRESSABLE_INSTANT} style={styles.modalCloseBtn} hitSlop={12} onPress={() => setShowTermsOfUse(false)}>
              <Text style={styles.modalCloseText}>Close</Text>
            </Pressable>
          </View>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: 20, paddingBottom: insets.bottom + 40, gap: 14 }}
            showsVerticalScrollIndicator={false}
          >
            <Text style={[styles.legalUpdated, isDarkTheme && { color: "#9db0db" }]}>Last updated: April 21, 2026</Text>

            <Text style={[styles.legalIntro, isDarkTheme && { color: "#c4cee8" }]}>
              By using Masjid.ly, you agree to the following. Most of it is common sense — we're including
              it so everyone's clear.
            </Text>

            <Text style={[styles.legalSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>The service</Text>
            <Text style={[styles.legalBody, isDarkTheme && { color: "#c4cee8" }]}>
              Masjid.ly aggregates publicly-posted event information from masjids, Islamic centers, and
              scholars in New Jersey and nearby areas. We do our best to keep it accurate, but event
              details (times, speakers, topics) are set by the masjid, not by us. <Text style={styles.legalBold}>Always
              confirm with the masjid before travelling.</Text>
            </Text>

            <Text style={[styles.legalSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>Event content & accuracy</Text>
            <Text style={[styles.legalBody, isDarkTheme && { color: "#c4cee8" }]}>
              We scrape event information from masjid websites, Instagram pages, and email newsletters
              they've made public. If something is wrong, missing, or shouldn't be listed — email
              hello@masjidly.app and we'll fix it fast. We're a small team; please assume good faith.
            </Text>

            <Text style={[styles.legalSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>Conduct</Text>
            <Text style={[styles.legalBody, isDarkTheme && { color: "#c4cee8" }]}>
              Masjid.ly is a tool for the community. Don't use it to harass, impersonate, spam, or scrape
              in a way that burdens our servers. Don't use the app to attend a masjid and misbehave —
              that's between you and Allah, but reflect on it.
            </Text>

            <Text style={[styles.legalSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>No warranty</Text>
            <Text style={[styles.legalBody, isDarkTheme && { color: "#c4cee8" }]}>
              The app is provided "as is." We make no guarantees of uptime, accuracy, or fitness for any
              particular purpose. We're not liable for anything arising from your use of the app (e.g. an
              event was cancelled and you drove there anyway).
            </Text>

            <Text style={[styles.legalSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>Donations</Text>
            <Text style={[styles.legalBody, isDarkTheme && { color: "#c4cee8" }]}>
              Donations via the Sadaqah Jar go through Ko-fi. They're non-refundable (since they're gifts,
              not payments for service). Donations do not grant any premium feature or special access —
              the app works the same whether you tip or not.
            </Text>

            <Text style={[styles.legalSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>Changes to these terms</Text>
            <Text style={[styles.legalBody, isDarkTheme && { color: "#c4cee8" }]}>
              We may update these terms. The "Last updated" date at the top tells you when.
            </Text>

            <Text style={[styles.legalSectionTitle, isDarkTheme && { color: "#f4f7ff" }]}>Contact</Text>
            <Pressable {...PRESSABLE_INSTANT} onPress={() => Linking.openURL("mailto:hello@masjidly.app?subject=Masjid.ly%20terms")}>
              <Text style={[styles.legalBody, { color: "#2e4f82", fontWeight: "700" }]}>
                hello@masjidly.app
              </Text>
            </Pressable>
          </ScrollView>
        </View>
      </Modal>

      {/* About modal */}
      <Modal
        visible={showAboutPanel}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowAboutPanel(false)}
      >
        <View style={[styles.modalContainer, isDarkTheme && styles.modalContainerMidnight, { flex: 1, paddingTop: 14 }]}>
          <View style={[styles.modalTop, isDarkTheme && styles.modalTopMidnight]}>
            <Text style={[styles.modalTitle, isDarkTheme && styles.modalTitleMidnight]} numberOfLines={1}>About Masjid.ly</Text>
            <Pressable {...PRESSABLE_INSTANT} style={styles.modalCloseBtn} hitSlop={12} onPress={() => setShowAboutPanel(false)}>
              <Text style={styles.modalCloseText}>Close</Text>
            </Pressable>
          </View>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: 24, paddingBottom: insets.bottom + 40, gap: 16, alignItems: "center" }}
            showsVerticalScrollIndicator={false}
          >
            <Image source={require("./assets/masjidly-logo.png")} style={{ width: 84, height: 84, borderRadius: 20 }} />
            <Text style={[styles.aboutAppName, isDarkTheme && { color: "#f4f7ff" }]}>Masjid.ly</Text>
            <Text style={[styles.aboutVersion, isDarkTheme && { color: "#9db0db" }]}>Version {APP_BUILD_VERSION}</Text>
            <Text style={[styles.aboutTagline, isDarkTheme && { color: "#c4cee8" }]}>
              Every halaqah, talk, and class at your local masjids — in one place.
            </Text>
            <View style={[styles.settingsSectionCard, isDarkTheme && styles.settingsSectionCardDark, { width: "100%", marginTop: 12 }]}>
              <Pressable {...PRESSABLE_INSTANT}
                style={[styles.settingsRow, isDarkTheme && styles.settingsRowDark]}
                onPress={() => Linking.openURL("mailto:hello@masjidly.app")}
              >
                <View style={[styles.settingsRowIcon, isDarkTheme && styles.settingsRowIconDark]}>
                  <Mi name="mail" size={20} color={isDarkTheme ? "#e8ecf4" : "#273143"} />
                </View>
                <Text style={[styles.settingsRowLabel, isDarkTheme && { color: "#f4f7ff" }]}>hello@masjidly.app</Text>
              </Pressable>
              <Pressable {...PRESSABLE_INSTANT}
                style={[styles.settingsRow, isDarkTheme && styles.settingsRowDark]}
                onPress={() => Linking.openURL("https://ko-fi.com/shaheer23407")}
              >
                <View style={[styles.settingsRowIcon, isDarkTheme && styles.settingsRowIconDark]}>
                  <Mi name="favorite_fill1" size={20} color={isDarkTheme ? "#ff7a9c" : "#c94660"} />
                </View>
                <Text style={[styles.settingsRowLabel, isDarkTheme && { color: "#f4f7ff" }]}>Support the project</Text>
              </Pressable>
              <Pressable {...PRESSABLE_INSTANT}
                style={[styles.settingsRow, styles.settingsRowLast, isDarkTheme && styles.settingsRowDark]}
                onPress={() => { setShowAboutPanel(false); setTimeout(() => setShowPrivacyPolicy(true), 250); }}
              >
                <View style={[styles.settingsRowIcon, isDarkTheme && styles.settingsRowIconDark]}>
                  <Mi name="info" size={20} color={isDarkTheme ? "#e8ecf4" : "#273143"} />
                </View>
                <Text style={[styles.settingsRowLabel, isDarkTheme && { color: "#f4f7ff" }]}>Privacy policy</Text>
              </Pressable>
            </View>
            <Text style={[styles.aboutFooter, isDarkTheme && { color: "#6b778c" }]}>
              Built with love by one brother for the ummah.{"\n"}
              Jazakum Allahu khayran for using it.
            </Text>
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
          <Pressable {...PRESSABLE_INSTANT} style={StyleSheet.absoluteFillObject} onPress={() => setReflectionState(null)} />
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
                <Pressable {...PRESSABLE_INSTANT}
                  key={n}
                  onPress={() =>
                    setReflectionState((s) => (s ? { ...s, rating: n } : s))
                  }
                  style={[
                    styles.reflectStar,
                    (reflectionState?.rating || 0) >= n && styles.reflectStarActive,
                  ]}
                >
                  <Mi
                    name={(reflectionState?.rating || 0) >= n ? "star_fill1" : "star"}
                    size={22}
                    color={(reflectionState?.rating || 0) >= n ? "#8a5c00" : "#b6c0d6"}
                  />
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
              <Pressable {...PRESSABLE_INSTANT} style={[styles.modalActionBtn, { flex: 1 }]} onPress={() => setReflectionState(null)}>
                <Text style={styles.modalActionBtnText}>Cancel</Text>
              </Pressable>
              <Pressable {...PRESSABLE_INSTANT}
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
            <Pressable {...PRESSABLE_INSTANT} style={styles.modalCloseBtn} hitSlop={12} onPress={() => setPassportOpen(false)}>
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
              <Pressable {...PRESSABLE_INSTANT}
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
                  <Pressable {...PRESSABLE_INSTANT}
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

      {/* Discover > Collections preview */}
      <Modal
        visible={!!collectionPreview}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setCollectionPreview(null)}
      >
        <View style={[styles.modalContainer, { flex: 1, paddingTop: modalChromeTopPad }]}>
          <View style={styles.modalTop}>
            <View style={{ flex: 1 }}>
              <Text style={styles.modalTitle} numberOfLines={1}>
                {collectionPreview?.title || "Collection"}
              </Text>
              {collectionPreview?.sub ? (
                <Text style={[styles.bottomSheetSub, { marginTop: 2 }]} numberOfLines={2}>
                  {collectionPreview.sub}
                </Text>
              ) : null}
            </View>
            <Pressable {...PRESSABLE_INSTANT}
              style={styles.modalCloseBtn}
              hitSlop={12}
              onPress={() => setCollectionPreview(null)}
            >
              <Text style={styles.modalCloseText}>Close</Text>
            </Pressable>
          </View>
          <ScrollView
            style={{ flex: 1 }}
            contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 40, gap: 10 }}
          >
            {collectionPreview?.events.length ? (
              <>
                <Text style={[styles.bottomSheetSub, { marginBottom: 4 }]}>
                  {collectionPreview.events.length} event
                  {collectionPreview.events.length === 1 ? "" : "s"} match
                </Text>
                {collectionPreview.events.map((e, i) => {
                  const poster = eventPosterUrl(e);
                  const saved = isSavedEvent(e);
                  return (
                    <Pressable {...PRESSABLE_INSTANT}
                      key={`coll-ev-${i}-${eventStorageKey(e)}`}
                      style={({ pressed }) => [
                        styles.discoverFollowedScholarsRow,
                        { backgroundColor: isDarkTheme ? "#1b2238" : "#ffffff", padding: 12, gap: 8 },
                        pressed && styles.cardActionChipPressed,
                      ]}
                      onPress={() => {
                        hapticTap("selection");
                        setCollectionPreview(null);
                        openEventDetails(e);
                      }}
                    >
                      {poster && canRenderPoster(poster) ? (
                        <LoadableNetworkImage
                          uri={poster}
                          style={{ width: "100%", height: 180, borderRadius: 12 }}
                          onError={() => markPosterFailed(poster)}
                        />
                      ) : (
                        <View style={{ width: "100%", height: 90, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: masjidBrandColor(e.source) }}>
                          <Text style={{ color: "#fff", fontWeight: "900", fontSize: 18 }}>{masjidInitials(e.source)}</Text>
                        </View>
                      )}
                      <Text
                        style={[styles.discoverFollowedScholarsRowWhat, isDarkTheme && { color: "#f4f7ff" }, { fontSize: 16 }]}
                        numberOfLines={2}
                      >
                        {eventDisplayTitle(e)}
                      </Text>
                      <Text style={[styles.discoverFollowedScholarsRowWho, isDarkTheme && { color: "#c4cee8" }]} numberOfLines={1}>
                        {formatSourceLabel(e.source)}
                        {effectiveEventSpeakerName(e) ? ` · ${effectiveEventSpeakerName(e)}` : ""}
                      </Text>
                      <Text style={[styles.discoverFollowedScholarsRowWhen, isDarkTheme && { color: "#9db0db" }]}>
                        {formatHumanDate(e.date)} · {eventTime(e)}
                      </Text>
                      <View style={{ flexDirection: "row", gap: 8, marginTop: 4 }}>
                        <Pressable {...PRESSABLE_INSTANT}
                          hitSlop={6}
                          onPress={(ev) => {
                            ev.stopPropagation?.();
                            toggleSavedEvent(e);
                          }}
                          style={({ pressed }) => [
                            styles.cardActionChip,
                            saved && styles.cardActionChipActive,
                            pressed && styles.cardActionChipPressed,
                            { flexDirection: "row", alignItems: "center", gap: 4 },
                          ]}
                        >
                          <Mi
                            name={saved ? "favorite_fill1" : "favorite"}
                            size={12}
                            color={saved ? "#fff" : "#2e4f82"}
                          />
                          <Text style={[styles.cardActionChipText, saved && styles.cardActionChipTextActive]}>
                            {saved ? "Saved" : "Save"}
                          </Text>
                        </Pressable>
                      </View>
                    </Pressable>
                  );
                })}
                {collectionPreview.exploreHandoff ? (
                  <Pressable {...PRESSABLE_INSTANT}
                    style={[styles.sadaqahBtn, { marginTop: 12 }]}
                    onPress={() => {
                      const handoff = collectionPreview.exploreHandoff!;
                      if ("halaqa" in handoff && handoff.halaqa !== undefined) {
                        setHalaqaFilter(handoff.halaqa);
                      }
                      if (handoff.quick && handoff.quick.length) {
                        setQuickFilters((prev) => {
                          const merged = new Set<QuickFilterId>(prev);
                          handoff.quick!.forEach((q) => merged.add(q));
                          return Array.from(merged);
                        });
                      }
                      setCollectionPreview(null);
                      switchTab("explore");
                      hapticTap("success");
                    }}
                  >
                    <Text style={styles.sadaqahBtnText}>Open in Explore with this filter →</Text>
                  </Pressable>
                ) : null}
              </>
            ) : (
              <Text style={styles.bottomSheetSub}>
                No events match this collection right now. Check back after the next refresh.
              </Text>
            )}
          </ScrollView>
        </View>
      </Modal>

      {/* AI-generated knowledge plan preview (from Calendar tab) */}
      <Modal
        visible={!!knowledgePlanPreview}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setKnowledgePlanPreview(null)}
      >
        {knowledgePlanPreview ? (
          <View style={[styles.modalContainer, { flex: 1, paddingTop: modalChromeTopPad }]}>
            <LinearGradient
              colors={[knowledgePlanPreview.color, `${knowledgePlanPreview.color}cc`]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={styles.knowledgePlanModalHeader}
            >
              <View style={{ flex: 1 }}>
                <Text style={styles.knowledgePlanModalKicker}>AI learning plan</Text>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 }}>
                  <Mi name={knowledgePlanPreview.mi} size={22} color="#ffffff" />
                  <Text style={styles.knowledgePlanModalTitle} numberOfLines={2}>
                    {knowledgePlanPreview.title}
                  </Text>
                </View>
                <Text style={styles.knowledgePlanModalSub} numberOfLines={3}>
                  {knowledgePlanPreview.sub}
                </Text>
              </View>
              <Pressable {...PRESSABLE_INSTANT}
                hitSlop={14}
                onPress={() => setKnowledgePlanPreview(null)}
                style={styles.knowledgePlanModalClose}
              >
                <Text style={styles.knowledgePlanModalCloseText}>Close</Text>
              </Pressable>
            </LinearGradient>
            <ScrollView
              style={{ flex: 1 }}
              contentContainerStyle={{ padding: 16, paddingBottom: insets.bottom + 56, gap: 12 }}
            >
              <View style={[styles.knowledgePlanBanner, isDarkTheme && { backgroundColor: "#1b2238" }]}>
                <Text style={[styles.knowledgePlanBannerTitle, isDarkTheme && { color: "#f4f7ff" }]}>
                  Why this order
                </Text>
                <Text style={[styles.knowledgePlanBannerSub, isDarkTheme && { color: "#c4cee8" }]}>
                  Events are sequenced by date, with a variety of speakers so you hear the
                  topic from more than one angle. Tap any stop to RSVP or save it.
                </Text>
              </View>

              {knowledgePlanPreview.events.map((e, idx) => {
                const poster = eventPosterUrl(e);
                const saved = isSavedEvent(e);
                const rsvpState = rsvpStatuses[eventStorageKey(e)];
                return (
                  <Pressable {...PRESSABLE_INSTANT}
                    key={`plan-ev-${idx}-${eventStorageKey(e)}`}
                    onPress={() => {
                      setKnowledgePlanPreview(null);
                      openEventDetails(e);
                    }}
                    style={[styles.knowledgePlanStep, isDarkTheme && { backgroundColor: "#1b2238" }]}
                  >
                    <View style={[styles.knowledgePlanStepNumber, { backgroundColor: knowledgePlanPreview.color }]}>
                      <Text style={styles.knowledgePlanStepNumberText}>{idx + 1}</Text>
                    </View>
                    <View style={{ flex: 1, gap: 4 }}>
                      <Text style={[styles.knowledgePlanStepWhen, isDarkTheme && { color: "#9db0db" }]}>
                        {formatHumanDate(e.date)} · {eventTime(e)}
                      </Text>
                      <Text style={[styles.knowledgePlanStepTitle, isDarkTheme && { color: "#f4f7ff" }]} numberOfLines={2}>
                        {eventDisplayTitle(e)}
                      </Text>
                      <Text style={[styles.knowledgePlanStepWho, isDarkTheme && { color: "#c4cee8" }]} numberOfLines={1}>
                        {formatSourceLabel(e.source)}
                        {effectiveEventSpeakerName(e) ? ` · ${effectiveEventSpeakerName(e)}` : ""}
                      </Text>
                      <View style={styles.cardActionRow}>
                        <Pressable {...PRESSABLE_INSTANT}
                          hitSlop={6}
                          onPress={(ev) => {
                            ev.stopPropagation?.();
                            toggleRsvp(e, "going");
                          }}
                          style={({ pressed }) => [
                            styles.cardActionChip,
                            rsvpState === "going" && styles.cardActionChipActive,
                            pressed && styles.cardActionChipPressed,
                          ]}
                        >
                          <Text style={[styles.cardActionChipText, rsvpState === "going" && styles.cardActionChipTextActive]}>
                            {rsvpState === "going" ? "Going ✓" : "Going"}
                          </Text>
                        </Pressable>
                        <Pressable {...PRESSABLE_INSTANT}
                          hitSlop={6}
                          onPress={(ev) => {
                            ev.stopPropagation?.();
                            toggleSavedEvent(e);
                          }}
                          style={({ pressed }) => [
                            styles.cardActionChip,
                            saved && styles.cardActionChipActive,
                            pressed && styles.cardActionChipPressed,
                            { flexDirection: "row", alignItems: "center", gap: 4 },
                          ]}
                        >
                          <Mi
                            name={saved ? "favorite_fill1" : "favorite"}
                            size={12}
                            color={saved ? "#fff" : "#2e4f82"}
                          />
                          <Text style={[styles.cardActionChipText, saved && styles.cardActionChipTextActive]}>
                            {saved ? "Saved" : "Save"}
                          </Text>
                        </Pressable>
                      </View>
                    </View>
                    {poster && canRenderPoster(poster) ? (
                      <LoadableNetworkImage
                        uri={poster}
                        style={styles.knowledgePlanStepPoster}
                        onError={() => markPosterFailed(poster)}
                      />
                    ) : (
                      <View style={[styles.knowledgePlanStepPoster, { alignItems: "center", justifyContent: "center", backgroundColor: masjidBrandColor(e.source) }]}>
                        <Text style={{ color: "#fff", fontWeight: "900" }}>{masjidInitials(e.source)}</Text>
                      </View>
                    )}
                  </Pressable>
                );
              })}

              <Pressable {...PRESSABLE_INSTANT}
                style={[styles.sadaqahBtn, { backgroundColor: knowledgePlanPreview.color }]}
                onPress={() => {
                  // Batch all plan events into Saved in one state update so
                  // React doesn't clobber earlier writes with stale reads.
                  let addedCount = 0;
                  setSavedEventsMap((prev) => {
                    const next = { ...prev };
                    for (const ev of knowledgePlanPreview.events) {
                      const key = eventStorageKey(ev);
                      if (!next[key]) {
                        next[key] = ev;
                        addedCount += 1;
                      }
                    }
                    SecureStore.setItemAsync(SAVED_EVENTS_KEY, JSON.stringify(next)).catch(() => {});
                    return next;
                  });
                  hapticTap("success");
                  setTimeout(() => {
                    Alert.alert(
                      "Plan saved",
                      addedCount > 0
                        ? `Added ${addedCount} event${addedCount === 1 ? "" : "s"} to your Saved list.`
                        : "All stops were already in your Saved list.",
                    );
                  }, 0);
                }}
              >
                <Text style={styles.sadaqahBtnText}>Save this plan to my shortlist</Text>
              </Pressable>
            </ScrollView>
          </View>
        ) : null}
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
            <Pressable {...PRESSABLE_INSTANT}
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
              (() => {
                // Prefer the backend speakers payload when available, but
                // fall back to deriving a list from the loaded events so
                // the directory never shows an infinite loading spinner.
                const list: Speaker[] = speakers.length
                  ? speakers
                  : (() => {
                      const agg = new Map<string, Speaker>();
                      for (const ev of orderedVisibleEvents) {
                        const raw = effectiveEventSpeakerName(ev).trim();
                        if (!raw) continue;
                        const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
                        if (!slug) continue;
                        const cur = agg.get(slug) || { slug, name: raw, total_events: 0, upcoming_events: 0, sources: [] as string[] };
                        cur.total_events += 1;
                        if ((ev.date || "") >= today && !isEventPastNow(ev)) cur.upcoming_events += 1;
                        const src = normalizeText(ev.source);
                        if (src && !cur.sources.includes(src)) cur.sources.push(src);
                        if (!cur.next_title || (ev.date || "") < (cur.next_date || "9999-12-31")) {
                          cur.next_title = ev.title;
                          cur.next_date = ev.date || null;
                        }
                        const evPoster = eventPosterUrl(ev);
                        if (!cur.image_url && evPoster) cur.image_url = evPoster;
                        agg.set(slug, cur);
                      }
                      return [...agg.values()]
                        .filter((s) => s.upcoming_events > 0 || s.total_events > 0)
                        .sort((a, b) => (b.upcoming_events || 0) - (a.upcoming_events || 0));
                    })();
                if (list.length === 0) {
                  return (
                    <View style={{ padding: 20, alignItems: "center", gap: 10 }}>
                      <Text style={[styles.bottomSheetSub, { textAlign: "center" }]}>
                        Your scholar directory is warming up. Pull down to refresh, or try a wider radius in Explore.
                      </Text>
                      <Pressable {...PRESSABLE_INSTANT}
                        onPress={() => { hapticTap("selection"); loadSpeakers(); }}
                        style={({ pressed }) => [styles.bottomSheetFollowBtn, pressed && styles.cardActionChipPressed]}
                      >
                        <Text style={styles.bottomSheetFollowText}>Try again</Text>
                      </Pressable>
                    </View>
                  );
                }
                return list.slice(0, 80).map((sp) => (
                  <Pressable {...PRESSABLE_INSTANT}
                    key={`sp-${sp.slug}`}
                    style={({ pressed }) => [styles.scholarCard, pressed && styles.cardActionChipPressed]}
                    onPress={() => { hapticTap("selection"); setSelectedSpeaker(sp.slug); }}
                  >
                    {sp.image_url && canRenderPoster(sp.image_url) ? (
                      <LoadableNetworkImage
                        uri={sp.image_url}
                        style={styles.scholarAvatar}
                        onError={() => markPosterFailed(sp.image_url || "")}
                      />
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
                ));
              })()
            ) : (
              (() => {
                const upcomingMatches = orderedVisibleEvents.filter(
                  (ev) =>
                    effectiveEventSpeakerName(ev)
                      .toLowerCase()
                      .replace(/[^a-z0-9]+/g, "-")
                      .replace(/^-+|-+$/g, "") === selectedSpeaker
                );
                const sp = speakers.find((s) => s.slug === selectedSpeaker)
                  || (upcomingMatches.length
                    ? {
                        slug: selectedSpeaker,
                        name: effectiveEventSpeakerName(upcomingMatches[0]) || selectedSpeaker,
                        total_events: upcomingMatches.length,
                        upcoming_events: upcomingMatches.filter((e) => (e.date || "") >= today && !isEventPastNow(e)).length,
                        sources: Array.from(new Set(upcomingMatches.map((e) => normalizeText(e.source)).filter(Boolean))),
                      } as Speaker
                    : null);
                if (!sp) return null;
                const videoState = speakerVideos[selectedSpeaker] || { videos: [], loading: false };
                const videos = videoState.videos;
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
                    <View style={styles.pastTalksHeaderRow}>
                      <Text style={styles.pastTalksHeader}>Past talks on YouTube</Text>
                      {videoState.loading ? (
                        <ActivityIndicator size="small" color="#4a3bb0" />
                      ) : null}
                    </View>
                    {!videoState.loading && videos.length === 0 ? (
                      <Text style={styles.bottomSheetSub}>
                        {videoState.status === "offline"
                          ? "Couldn't reach YouTube — try again in a bit."
                          : "No lectures found yet. We'll try again next time the directory syncs."}
                      </Text>
                    ) : null}
                    {videos.slice(0, 12).map((v) => (
                      <Pressable {...PRESSABLE_INSTANT}
                        key={`yt-${v.video_id}`}
                        style={({ pressed }) => [styles.videoCard, pressed && styles.cardActionChipPressed]}
                        onPress={() => {
                          hapticTap("selection");
                          Linking.openURL(v.url);
                        }}
                      >
                        {v.thumbnail_url && canRenderPoster(v.thumbnail_url) ? (
                          <LoadableNetworkImage
                            uri={v.thumbnail_url}
                            style={styles.videoThumb}
                            onError={() => markPosterFailed(v.thumbnail_url || "")}
                          />
                        ) : (
                          <View style={[styles.videoThumb, { backgroundColor: "#16131f", justifyContent: "center", alignItems: "center" }]}>
                            <Mi name="play_arrow" size={24} color="#ff4b4b" />
                          </View>
                        )}
                        <View style={{ flex: 1 }}>
                          <Text style={styles.videoTitle} numberOfLines={2}>{v.title}</Text>
                          <Text style={styles.videoMeta} numberOfLines={1}>
                            {v.channel || "YouTube"}
                            {v.duration_label ? ` · ${v.duration_label}` : ""}
                            {v.published_at ? ` · ${v.published_at}` : ""}
                          </Text>
                        </View>
                      </Pressable>
                    ))}
                  </>
                );
              })()
            )}
          </ScrollView>
        </View>
      </Modal>

      {/* Floating sprite chatbot launcher (top-right) — always available
          while the user is in the main app shell. Tapping opens the chat
          modal. Long-pressing replays the guided tour. */}
      <Animated.View
        style={[
          styles.floatingSpriteWrap,
          {
            top: Math.max(insets.top, 8) + 6,
            transform: [
              {
                translateY: floatingSpriteBob.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, -4],
                }),
              },
            ],
          },
        ]}
        pointerEvents="box-none"
      >
        <Pressable
          {...PRESSABLE_INSTANT}
          accessibilityRole="button"
          accessibilityLabel="Open Masjid.ly assistant"
          onPress={() => {
            hapticTap("selection");
            if (chatMessages.length === 0) {
              setChatMessages([
                {
                  role: "bot",
                  text: "As-salāmu ʿalaykum! Ask me anything: dates, topics, sisters/brothers/family, scholar names, masjid names, closest events, free events, livestreams, or \"who made this app?\"",
                  ts: Date.now(),
                },
              ]);
            }
            setChatOpen(true);
          }}
          onLongPress={() => {
            hapticTap("success");
            setGuidedTourStep(0);
            setGuidedTourOpen(true);
          }}
          style={({ pressed }) => [styles.floatingSpriteBtn, pressed && { opacity: 0.85, transform: [{ scale: 0.95 }] }]}
        >
          <Animated.View
            style={[
              styles.floatingSpriteHalo,
              {
                opacity: floatingSpriteHaloPulse.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.42, 0.92],
                }),
                transform: [
                  {
                    scale: floatingSpriteHaloPulse.interpolate({
                      inputRange: [0, 1],
                      outputRange: [0.88, 1.14],
                    }),
                  },
                ],
              },
            ]}
          />
          {renderPixelSprite(undefined, 38, "avatar")}
        </Pressable>
      </Animated.View>

      <Modal
        visible={feedSetupOpen}
        animationType="fade"
        transparent
        statusBarTranslucent
        onRequestClose={() => {
          if (feedSetupDone) setFeedSetupOpen(false);
        }}
      >
        <View style={styles.feedSetupBackdrop}>
          <View style={[styles.feedSetupCard, isDarkTheme && styles.feedSetupCardDark]}>
            {feedSetupStep === 3 ? (
              <View style={[styles.feedBuildWrap, { paddingVertical: 24 }]}>
                {feedBuildPhase === "success" ? (
                  <Animated.View
                    style={[
                      styles.feedBuildSuccessCard,
                      isDarkTheme && styles.feedBuildSuccessCardDark,
                      { transform: [{ scale: feedBuildSuccessScale }], shadowOpacity: 0 },
                    ]}
                  >
                    <View style={styles.feedBuildSuccessBadge}>
                      <Mi name="check" size={48} color="#ffffff" />
                    </View>
                    <Text style={[styles.feedBuildTitle, isDarkTheme && styles.feedBuildTitleDark]}>
                      Your feed is ready
                    </Text>
                  </Animated.View>
                ) : (
                  <View style={[styles.feedBuildCard, isDarkTheme && styles.feedBuildCardDark, { shadowOpacity: 0 }]}>
                    <Animated.View
                      style={[
                        styles.feedBuildGifWrap,
                        {
                          transform: [
                            {
                              rotate: feedBuildHammerTilt.interpolate({
                                inputRange: [-1, 0, 1],
                                outputRange: ["-2.5deg", "0deg", "2.5deg"],
                              }),
                            },
                          ],
                        },
                      ]}
                    >
                      <Image source={FEED_BUILDING_CAT} style={styles.feedBuildGif} resizeMode="cover" />
                    </Animated.View>
                    <Text style={[styles.feedBuildTitle, isDarkTheme && styles.feedBuildTitleDark]}>
                      Building your feed
                    </Text>
                    <Text style={[styles.feedBuildSub, isDarkTheme && styles.feedBuildSubDark]}>
                      Our hard workers are working.
                    </Text>
                    <View style={[styles.feedBuildBarTrack, isDarkTheme && styles.feedBuildBarTrackDark]}>
                      <Animated.View
                        style={[
                          styles.feedBuildBarFill,
                          {
                            width: feedBuildProgress.interpolate({
                              inputRange: [0, 1],
                              outputRange: ["0%", "100%"],
                            }),
                          },
                        ]}
                      />
                    </View>
                  </View>
                )}
              </View>
            ) : (
              <>
                <ScrollView
                  style={styles.feedSetupScroll}
                  contentContainerStyle={styles.feedSetupScrollContent}
                  showsVerticalScrollIndicator
                  keyboardShouldPersistTaps="handled"
                  nestedScrollEnabled
                  {...IOS_SCROLL_INSTANT_TOUCH}
                >
                  <Text
                    style={[
                      styles.feedWizardExplainer,
                      isDarkTheme && styles.feedWizardExplainerDark,
                      isNeo && styles.feedWizardExplainerNeo,
                      isEmerald && styles.feedWizardExplainerEmerald,
                      isInferno && styles.feedWizardExplainerInferno,
                      isVitaria && styles.feedWizardExplainerVitaria,
                    ]}
                  >
                    {feedSetupDone
                      ? "Your feed ranks upcoming programs from what you pick below, plus your saves and RSVPs. Scroll through every option; Next moves between steps; changes save when you finish."
                      : "Your feed is your personalized stream: masjids and speakers you follow, topics you care about, plus saves and RSVPs. Select below and scroll to see every choice."}
                  </Text>
                  <View style={[styles.feedSetupHeader, { borderBottomWidth: 0, paddingTop: 6, paddingBottom: 6 }]}>
                    <View style={styles.feedSetupHeaderTop}>
                      <Text style={[styles.feedSetupStepPill, isDarkTheme && styles.feedSetupStepPillDark]}>
                        Step {feedSetupStep + 1} of 3
                      </Text>
                      <Pressable
                        {...PRESSABLE_INSTANT}
                        style={styles.feedSetupCloseBtn}
                        onPress={() => {
                          if (feedSetupDone) {
                            setFeedSetupOpen(false);
                            setFeedSetupStep(0);
                            setFeedSetupApplying(false);
                            return;
                          }
                          Alert.alert(
                            "Finish feed setup?",
                            "Complete this one-time setup now, or continue later from Settings.",
                            [
                              { text: "Keep going", style: "cancel" },
                              {
                                text: "Continue later",
                                onPress: () => {
                                  setFeedSetupOpen(false);
                                  setFeedSetupStep(0);
                                  setFeedSetupApplying(false);
                                },
                              },
                            ]
                          );
                        }}
                      >
                        <Mi name="close" size={13} color="#5f7395" />
                      </Pressable>
                    </View>
                    <Text style={[styles.feedSetupTitle, isDarkTheme && styles.feedSetupTitleDark]}>
                      {feedSetupStep === 0
                        ? "Which masjids do you want to follow?"
                        : feedSetupStep === 1
                          ? "Which speakers do you want in your feed?"
                          : "Pick topics for your feed"}
                    </Text>
                    <Text style={[styles.feedSetupSub, isDarkTheme && styles.feedSetupSubDark]}>
                      {feedSetupStep === 0
                        ? "Tap to select masjids. You can change this anytime in Settings."
                        : feedSetupStep === 1
                          ? "Choose speakers and we'll prioritize their upcoming events."
                          : "Select what you care about most. This powers recommendations."}
                    </Text>
                  </View>

                  {feedSetupStep === 0
                    ? feedSetupMasjidOptions.map((source) => {
                        const active = feedSetupMasjids.includes(source);
                        const upcomingCount = feedUpcomingEvents.filter((e) => normalizeText(e.source).toLowerCase() === source.toLowerCase()).length;
                        return (
                          <Pressable
                            {...PRESSABLE_INSTANT}
                            key={`feed-setup-m-${source}`}
                            style={[styles.feedSetupChoiceRow, isDarkTheme && styles.feedSetupChoiceRowDark, active && styles.feedSetupChoiceRowActive]}
                            onPress={() =>
                              setFeedSetupMasjids((prev) =>
                                prev.includes(source) ? prev.filter((x) => x !== source) : [...prev, source]
                              )
                            }
                          >
                            {renderMasjidLogo(source, 38, { style: styles.feedSetupMasjidLogo, textStyle: styles.discoverMasjidAvatarText })}
                            <View style={{ flex: 1 }}>
                              <Text style={[styles.feedSetupChoiceTitle, isDarkTheme && styles.feedSetupChoiceTitleDark]} numberOfLines={1}>
                                {formatSourceLabel(source)}
                              </Text>
                              <Text style={[styles.feedSetupChoiceMeta, isDarkTheme && styles.feedSetupChoiceMetaDark]} numberOfLines={1}>
                                {upcomingCount} upcoming events
                              </Text>
                            </View>
                            <Text style={[styles.feedSetupChoiceState, active && styles.feedSetupChoiceStateActive]}>
                              {active ? "✓" : "+"}
                            </Text>
                          </Pressable>
                        );
                      })
                    : null}

                  {feedSetupStep === 1
                    ? feedSetupSpeakerOptions.map((sp) => {
                        const active = feedSetupScholars.includes(sp.slug);
                        return (
                          <Pressable
                            {...PRESSABLE_INSTANT}
                            key={`feed-setup-sp-${sp.slug}`}
                            style={[styles.feedSetupChoiceRow, isDarkTheme && styles.feedSetupChoiceRowDark, active && styles.feedSetupChoiceRowActive]}
                            onPress={() =>
                              setFeedSetupScholars((prev) =>
                                prev.includes(sp.slug) ? prev.filter((x) => x !== sp.slug) : [...prev, sp.slug]
                              )
                            }
                          >
                            <View style={styles.feedSetupSpeakerAvatar}>
                              <Text style={styles.feedSetupSpeakerAvatarText}>
                                {sp.name
                                  .split(" ")
                                  .map((p) => p[0])
                                  .filter(Boolean)
                                  .slice(0, 2)
                                  .join("")
                                  .toUpperCase()}
                              </Text>
                            </View>
                            <View style={{ flex: 1 }}>
                              <Text style={[styles.feedSetupChoiceTitle, isDarkTheme && styles.feedSetupChoiceTitleDark]} numberOfLines={1}>
                                {sp.name}
                              </Text>
                              <Text style={[styles.feedSetupChoiceMeta, isDarkTheme && styles.feedSetupChoiceMetaDark]} numberOfLines={1}>
                                {sp.upcoming} upcoming talks
                              </Text>
                            </View>
                            <Text style={[styles.feedSetupChoiceState, active && styles.feedSetupChoiceStateActive]}>
                              {active ? "✓" : "+"}
                            </Text>
                          </Pressable>
                        );
                      })
                    : null}

                  {feedSetupStep === 2 ? (
                    <View style={styles.feedSetupTopicWrap}>
                      {feedSetupTopicOptions.map((topic) => {
                        const active = feedSetupTopics.includes(topic);
                        return (
                          <Pressable
                            {...PRESSABLE_INSTANT}
                            key={`feed-setup-topic-${topic}`}
                            style={[styles.feedTopicChip, active && styles.feedTopicChipActive]}
                            onPress={() =>
                              setFeedSetupTopics((prev) =>
                                prev.includes(topic) ? prev.filter((x) => x !== topic) : [...prev, topic]
                              )
                            }
                          >
                            <Text style={[styles.feedTopicChipText, active && styles.feedTopicChipTextActive]}>{topic}</Text>
                          </Pressable>
                        );
                      })}
                    </View>
                  ) : null}
                </ScrollView>

                <View style={[styles.feedSetupFooter, { paddingBottom: Math.max(insets.bottom, 12) }]}>
                  <Pressable
                    {...PRESSABLE_INSTANT}
                    style={[styles.feedSetupBackBtn, (feedSetupStep === 0 || feedSetupApplying) && { opacity: 0.5 }]}
                    disabled={feedSetupStep === 0 || feedSetupApplying}
                    onPress={() => setFeedSetupStep((s) => (s > 0 ? ((s - 1) as 0 | 1 | 2 | 3) : s))}
                  >
                    <Text style={styles.feedSetupBackText}>Back</Text>
                  </Pressable>
                  <Pressable
                    {...PRESSABLE_INSTANT}
                    style={[styles.feedSetupNextBtn, feedSetupApplying && { opacity: 0.6 }]}
                    disabled={feedSetupApplying}
                    onPress={() => {
                      if (feedSetupStep < 2) {
                        setFeedSetupStep((s) => ((s + 1) as 0 | 1 | 2 | 3));
                      } else {
                        void applyFeedSetupWizard();
                      }
                    }}
                  >
                    <Text style={styles.feedSetupNextText}>{feedSetupStep < 2 ? "Next →" : "Build my feed"}</Text>
                  </Pressable>
                </View>
              </>
            )}
          </View>
        </View>
      </Modal>

      {/* Guided tour overlay — first-time walkthrough narrated by the sprite.
          Uses a translucent backdrop so the actual app UI stays visible
          beneath. As the user advances, we switch tabs and pulse a highlight
          ring around the relevant tab button (or the floating chatbot). */}
      {guidedTourOpen
        ? (() => {
          const step = GUIDED_TOUR_STEPS[guidedTourStep];
          const isLast = guidedTourStep >= GUIDED_TOUR_STEPS.length - 1;

          // Geometry of the bottom tab bar (matches styles.tabBar /
          // styles.tabBtn): 10pt side inset, 8pt inner padding, 12pt bottom
          // inset, 46pt button height, 6pt gap between 6 equal buttons.
          const TABBAR_BOTTOM = 12;
          const TABBAR_SIDE = 10;
          const TABBAR_PAD = 8;
          const TAB_GAP = 6;
          const TAB_H = 46;
          const TAB_COUNT = 6;
          const innerWidth = screenWidth - TABBAR_SIDE * 2 - TABBAR_PAD * 2;
          const btnWidth = (innerWidth - TAB_GAP * (TAB_COUNT - 1)) / TAB_COUNT;

          const ringScale = tourPulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] });
          const ringOpacity = tourPulse.interpolate({ inputRange: [0, 1], outputRange: [0.95, 0.55] });

          // Resolve the visual highlight target. Task steps may carry an
          // optional `.highlight` (e.g. the tab they want the user to tap
          // to complete the task); "tab" and "chatbot" kinds are always
          // self-describing.
          const highlightSource:
            | { kind: "tab"; tabIndex: number }
            | { kind: "chatbot" }
            | null =
            step?.target.kind === "tab"
              ? { kind: "tab", tabIndex: step.target.tabIndex }
              : step?.target.kind === "chatbot"
                ? { kind: "chatbot" }
                : step?.target.kind === "task" && step.target.highlight
                  ? step.target.highlight
                  : null;

          let highlight: null | { left: number; bottom?: number; top?: number; right?: number; width: number; height: number; radius: number } = null;
          if (highlightSource?.kind === "tab") {
            const idx = highlightSource.tabIndex;
            const btnCenterX =
              TABBAR_SIDE + TABBAR_PAD + idx * (btnWidth + TAB_GAP) + btnWidth / 2;
            const ringW = btnWidth + 10;
            const ringH = TAB_H + 10;
            highlight = {
              left: btnCenterX - ringW / 2,
              bottom: TABBAR_BOTTOM + TABBAR_PAD - 5,
              width: ringW,
              height: ringH,
              radius: 18,
            };
          } else if (highlightSource?.kind === "chatbot") {
            // Matches the (shrunken) floatingSpriteBtn geometry: 44pt button
            // with a 56pt halo, positioned at right:12 on the top bar.
            highlight = {
              left: screenWidth - 12 - 62,
              top: insets.top + 6 - 6,
              width: 62,
              height: 62,
              radius: 31,
            };
          }

          // Task steps demand real user interaction — the backdrop must
          // pass taps through to the real UI underneath. Narrative steps
          // keep the tap-to-advance backdrop for quick walkthrough pacing.
          const isTaskStep = step?.target.kind === "task";

          // For task steps keep the card pinned to the TOP so it doesn't
          // block the target element. For narrative "tab" / "chatbot"
          // steps we position mid-lower so the highlighted element at the
          // bottom is visible. Intro/outro center vertically.
          const cardPositionedAtBottom = !isTaskStep && step?.target.kind !== "none";
          const cardPositionedAtTop = isTaskStep;

          // Skip tears down the tour immediately. We don't go via
          // advanceTour here because that reads guidedTourStep from
          // the closure (stale) and would just advance one step.
          const skipTour = () => {
            hapticTap("selection");
            if (tourTransitioningRef.current) return;
            tourTransitioningRef.current = true;
            Animated.timing(tourContentOpacity, {
              toValue: 0,
              duration: 220,
              easing: Easing.in(Easing.cubic),
              useNativeDriver: true,
            }).start(() => {
              if (guidedTourAutoOpenTimeoutRef.current) {
                clearTimeout(guidedTourAutoOpenTimeoutRef.current);
                guidedTourAutoOpenTimeoutRef.current = null;
              }
              setGuidedTourOpen(false);
              SecureStore.setItemAsync(GUIDED_TOUR_DONE_KEY, "1").catch(() => {});
              tourContentOpacity.setValue(1);
              tourContentTranslate.setValue(0);
              tourTransitioningRef.current = false;
            });
          };
          const nextTour = () => {
            hapticTap("selection");
            advanceTour(1);
          };

          return (
            <View
              style={[styles.tourBackdropLight, isTaskStep && styles.tourBackdropTask]}
              pointerEvents={isTaskStep ? "box-none" : "auto"}
            >
              {/* Tappable backdrop — advances narrative steps with a tap.
                  Suppressed on task steps so touches pass through to the
                  real UI underneath (the whole point: user does the thing). */}
              {isTaskStep ? null : (
                <Pressable {...PRESSABLE_INSTANT}
                  style={StyleSheet.absoluteFillObject}
                  onPress={nextTour}
                />
              )}

              {/* Pulsing highlight ring for the current target. Cross-fades
                  with the card when the step changes so the ring never
                  "teleports" between targets. */}
              {highlight && (
                <Animated.View
                  pointerEvents="none"
                  style={[
                    styles.tourHighlightRing,
                    {
                      left: highlight.left,
                      width: highlight.width,
                      height: highlight.height,
                      borderRadius: highlight.radius,
                      ...(highlight.bottom !== undefined ? { bottom: highlight.bottom } : {}),
                      ...(highlight.top !== undefined ? { top: highlight.top } : {}),
                    },
                    {
                      // Combine the step cross-fade (tourContentOpacity) with
                      // the looping pulse (ringOpacity) by multiplying them,
                      // then layer the pulse's scale on top.
                      opacity: Animated.multiply(tourContentOpacity, ringOpacity),
                      transform: [{ scale: ringScale }],
                    },
                  ]}
                />
              )}

              {/* Card + sprite narrator. Positioned based on step target. */}
              <Animated.View
                style={[
                  styles.tourCardOuterV2,
                  cardPositionedAtTop
                    ? { top: Math.max(insets.top + 16, 56) }
                    : cardPositionedAtBottom
                      ? { top: Math.max(insets.top + 80, 120) }
                      : { top: "30%" as unknown as number },
                  {
                    opacity: tourContentOpacity,
                    transform: [{ translateY: tourContentTranslate }],
                  },
                ]}
                pointerEvents="auto"
              >
                <View style={styles.tourSpriteRow}>
                  {renderPixelSprite(undefined, 88, "avatar")}
                </View>
                <View style={styles.tourCard}>
                  <View style={styles.tourProgressRow}>
                    {GUIDED_TOUR_STEPS.map((_, i) => (
                      <View
                        key={`tour-dot-${i}`}
                        style={[
                          styles.tourProgressDot,
                          i === guidedTourStep && styles.tourProgressDotActive,
                        ]}
                      />
                    ))}
                  </View>
                  <Text style={styles.tourTitle}>{step?.title || ""}</Text>
                  <Text style={styles.tourBody}>{step?.body || ""}</Text>
                  {isTaskStep && step?.hint ? (
                    <View style={styles.tourTaskHintRow}>
                      <View style={styles.tourTaskHintDot} />
                      <Text style={styles.tourTaskHintText}>{step.hint}</Text>
                    </View>
                  ) : null}
                  <View style={styles.tourBtnRow}>
                    <Pressable {...PRESSABLE_INSTANT} style={styles.tourSkipBtn} onPress={skipTour}>
                      <Text style={styles.tourSkipText}>Skip tour</Text>
                    </Pressable>
                    {isTaskStep ? (
                      <>
                        <Pressable {...PRESSABLE_INSTANT} style={styles.tourSkipStepBtn} onPress={nextTour}>
                          <Text style={styles.tourSkipStepText}>Skip step</Text>
                        </Pressable>
                        <Pressable {...PRESSABLE_INSTANT} style={styles.tourNextBtn} onPress={nextTour}>
                          <Text style={styles.tourNextText}>Done →</Text>
                        </Pressable>
                      </>
                    ) : (
                      <Pressable {...PRESSABLE_INSTANT} style={styles.tourNextBtn} onPress={nextTour}>
                        <Text style={styles.tourNextText}>
                          {isLast ? "Let's go!" : "Next →"}
                        </Text>
                      </Pressable>
                    )}
                  </View>
                </View>
              </Animated.View>
            </View>
          );
        })()
        : null}

      {/* Sprite chatbot — event-aware local Q&A. Uses a pageSheet
          presentation on iOS so the system status bar sits *above* the
          modal (no overlap with our header). On Android we fall back to
          fullScreen and apply explicit top-inset padding so the header
          doesn't collide with the notification bar. */}
      <Modal
        visible={chatOpen}
        animationType="slide"
        presentationStyle={Platform.OS === "ios" ? "pageSheet" : "fullScreen"}
        onRequestClose={() => setChatOpen(false)}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          style={[styles.chatContainer, isDarkTheme && { backgroundColor: "#0c1121" }]}
          keyboardVerticalOffset={0}
        >
          <View
            style={[
              styles.chatHeader,
              isDarkTheme && { borderBottomColor: "#1f2640" },
              // pageSheet already clears the status bar on iOS. On
              // Android, pad by the measured top inset so we never
              // overlap the system clock / battery row.
              Platform.OS === "android" && { paddingTop: Math.max(insets.top, 12) + 10 },
            ]}
          >
            <View style={styles.chatHeaderLeft}>
              <View style={styles.chatHeaderSprite}>
                {renderPixelSprite(undefined, 44, "avatar")}
              </View>
              <View style={{ flex: 1 }}>
                <Text
                  style={[styles.chatHeaderTitle, isDarkTheme && { color: "#f4f7ff" }]}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  Masjid.ly buddy
                </Text>
                <Text
                  style={[styles.chatHeaderSub, isDarkTheme && { color: "#9db0db" }]}
                  numberOfLines={1}
                  ellipsizeMode="tail"
                >
                  Ask about events, topics, masjids, or scholars
                </Text>
              </View>
            </View>
            <Pressable {...PRESSABLE_INSTANT} hitSlop={10} onPress={() => setChatOpen(false)} style={styles.chatCloseBtn}>
              <Text style={[styles.chatCloseText, isDarkTheme && { color: "#f4f7ff" }]}>Done</Text>
            </Pressable>
          </View>

          <ScrollView
            ref={chatScrollRef}
            style={{ flex: 1 }}
            contentContainerStyle={styles.chatScrollContent}
            onContentSizeChange={() => chatScrollRef.current?.scrollToEnd({ animated: true })}
          >
            {chatMessages.map((m, i) => (
              <View
                key={`chat-${i}`}
                style={[
                  styles.chatBubbleRow,
                  m.role === "user" ? styles.chatBubbleRowUser : styles.chatBubbleRowBot,
                ]}
              >
                {m.role === "bot" ? (
                  <View style={styles.chatBubbleAvatar}>
                    {renderPixelSprite(undefined, 42, "avatar")}
                  </View>
                ) : null}
                <View
                  style={[
                    styles.chatBubble,
                    m.role === "user" ? styles.chatBubbleUser : styles.chatBubbleBot,
                    isDarkTheme && m.role === "bot" && { backgroundColor: "#1a2035", borderColor: "#2c3654" },
                  ]}
                >
                  <Text
                    style={[
                      styles.chatBubbleText,
                      m.role === "user" ? styles.chatBubbleTextUser : styles.chatBubbleTextBot,
                      isDarkTheme && m.role === "bot" && { color: "#f4f7ff" },
                    ]}
                  >
                    {m.text}
                  </Text>
                </View>
              </View>
            ))}
            {/* Render latest bot reply's attached events as cards, if any */}
            {(() => {
              const lastBot = [...chatMessages].reverse().find((m) => m.role === "bot") as any;
              const attached = lastBot?.events as any[] | undefined;
              if (!attached?.length) return null;
              return (
                <View style={styles.chatEventListWrap}>
                  {attached.map((e, idx) => (
                    <Pressable {...PRESSABLE_INSTANT}
                      key={`chat-ev-${idx}-${e.event_uid || e.id || idx}`}
                      onPress={() => {
                        setChatOpen(false);
                        openEventDetails(e as EventItem);
                      }}
                      style={[styles.chatEventCard, isDarkTheme && styles.chatEventCardDark]}
                    >
                      <Text style={[styles.chatEventDate, isDarkTheme && { color: "#ffad75" }]} numberOfLines={1}>
                        {formatHumanDate(e.date)}{e.start_time ? ` · ${eventTime(e)}` : ""}
                      </Text>
                      <Text style={[styles.chatEventTitle, isDarkTheme && { color: "#f4f7ff" }]} numberOfLines={2}>
                        {e.title || "Untitled event"}
                      </Text>
                      <Text style={[styles.chatEventSource, isDarkTheme && { color: "#9db0db" }]} numberOfLines={1}>
                        {formatSourceLabel(e.source || "")}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              );
            })()}
          </ScrollView>

          {/* Suggested chips */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.chatSuggestRow}
            contentContainerStyle={styles.chatSuggestRowContent}
            {...IOS_SCROLL_INSTANT_TOUCH}
          >
            {CHAT_SUGGESTIONS.map((s) => (
              <Pressable {...PRESSABLE_INSTANT}
                key={`sugg-${s}`}
                style={[styles.chatChip, isDarkTheme && styles.chatChipDark]}
                onPress={() => {
                  const userMsg = { role: "user" as const, text: s, ts: Date.now() };
                  const ans = answerChatQuery(s, {
                    events,
                    location:
                      typeof profileDraft.home_lat === "number" && typeof profileDraft.home_lon === "number"
                        ? { latitude: profileDraft.home_lat, longitude: profileDraft.home_lon }
                        : null,
                    followedScholars,
                    followedMasjids,
                  });
                  const botMsg = { role: "bot" as const, text: ans.reply, ts: Date.now() + 1, events: ans.events } as any;
                  setChatMessages((prev) => [...prev, userMsg, botMsg]);
                }}
              >
                <Text style={[styles.chatChipText, isDarkTheme && { color: "#c4cee8" }]}>{s}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <View style={[styles.chatInputRow, isDarkTheme && { backgroundColor: "#0c1121", borderTopColor: "#1f2640" }]}>
            <TextInput
              style={[styles.chatInput, isDarkTheme && styles.chatInputDark]}
              value={chatInput}
              onChangeText={setChatInput}
              placeholder="Ask me about events…"
              placeholderTextColor={isDarkTheme ? "#6e7a96" : "#8d96ab"}
              returnKeyType="send"
              onSubmitEditing={() => {
                const text = chatInput.trim();
                if (!text) return;
                setChatInput("");
                const userMsg = { role: "user" as const, text, ts: Date.now() };
                const ans = answerChatQuery(text, {
                  events,
                  location:
                    typeof profileDraft.home_lat === "number" && typeof profileDraft.home_lon === "number"
                      ? { latitude: profileDraft.home_lat, longitude: profileDraft.home_lon }
                      : null,
                  followedScholars,
                  followedMasjids,
                });
                const botMsg = { role: "bot" as const, text: ans.reply, ts: Date.now() + 1, events: ans.events } as any;
                setChatMessages((prev) => [...prev, userMsg, botMsg]);
              }}
            />
            <Pressable {...PRESSABLE_INSTANT}
              style={[styles.chatSendBtn, !chatInput.trim() && { opacity: 0.45 }]}
              disabled={!chatInput.trim()}
              onPress={() => {
                const text = chatInput.trim();
                if (!text) return;
                setChatInput("");
                const userMsg = { role: "user" as const, text, ts: Date.now() };
                const ans = answerChatQuery(text, {
                  events,
                  location:
                    typeof profileDraft.home_lat === "number" && typeof profileDraft.home_lon === "number"
                      ? { latitude: profileDraft.home_lat, longitude: profileDraft.home_lon }
                      : null,
                  followedScholars,
                  followedMasjids,
                });
                const botMsg = { role: "bot" as const, text: ans.reply, ts: Date.now() + 1, events: ans.events } as any;
                setChatMessages((prev) => [...prev, userMsg, botMsg]);
              }}
            >
              <Text style={styles.chatSendText}>Send</Text>
            </Pressable>
          </View>
          {/* Bottom inset so the input row never sits under the home
              indicator on iPhones with no hardware button. */}
          {insets.bottom > 0 && Platform.OS === "ios" ? (
            <View style={{ height: insets.bottom, backgroundColor: isDarkTheme ? "#0c1121" : "#ffffff" }} />
          ) : null}
        </KeyboardAvoidingView>
      </Modal>
    </SafeAreaView>
    </Animated.View>
    {launchOverlayVisible ? (
      <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
        {renderLaunchScreen()}
      </View>
    ) : null}
    </View>
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
  spriteOverlay: {
    position: "absolute",
    top: 0,
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "flex-start",
    zIndex: 20,
  },
  spriteBubble: {
    minWidth: 180,
    maxWidth: 260,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 16,
    backgroundColor: "#ffffff",
    marginBottom: 8,
    shadowColor: "#000",
    shadowOpacity: 0.18,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
    borderWidth: 1,
    borderColor: "rgba(0,0,0,0.06)",
  },
  spriteBubbleText: {
    fontSize: 14,
    lineHeight: 18,
    fontWeight: "700",
    color: "#2b1b0e",
    textAlign: "center",
    letterSpacing: 0.1,
  },
  spriteBubbleTail: {
    position: "absolute",
    bottom: -6,
    alignSelf: "center",
    width: 12,
    height: 12,
    backgroundColor: "#ffffff",
    transform: [{ rotate: "45deg" }],
    borderRightWidth: 1,
    borderBottomWidth: 1,
    borderColor: "rgba(0,0,0,0.06)",
  },
  // ── Floating sprite chatbot launcher (top-right) ─────────────────────────
  floatingSpriteWrap: {
    position: "absolute",
    right: 12,
    zIndex: 50,
  },
  floatingSpriteBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#ffffff",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#ff4a14",
    shadowOpacity: 0.24,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 5,
    borderWidth: 1.25,
    borderColor: "rgba(255,122,60,0.35)",
  },
  floatingSpriteHalo: {
    position: "absolute",
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "rgba(255,122,60,0.14)",
    zIndex: -1,
  },
  // ── Guided tour overlay ──────────────────────────────────────────────────
  tourBackdrop: {
    flex: 1,
    backgroundColor: "rgba(8,12,24,0.66)",
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 24,
  },
  // Lighter backdrop for the walkthrough — leaves enough of the app visible
  // that the user can actually see which tab/UI element is being described.
  tourBackdropLight: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(8,12,24,0.38)",
    zIndex: 1200,
    elevation: 1200,
  },
  // Much lighter dim for task steps — we want the real UI to feel
  // primary since the user is actually going to interact with it.
  tourBackdropTask: {
    backgroundColor: "rgba(8,12,24,0.12)",
  },
  tourCardOuter: {
    width: "100%",
    maxWidth: 360,
    alignItems: "center",
  },
  // Absolutely-positioned variant so we can pin the narration card below
  // the top of the screen without covering the tab bar.
  tourCardOuterV2: {
    position: "absolute",
    left: 20,
    right: 20,
    alignItems: "center",
  },
  // Pulsing ring drawn over whatever UI the current step is pointing at
  // (a tab button or the floating chat launcher). pointerEvents="none" so
  // the backdrop below still catches taps that advance the tour.
  tourHighlightRing: {
    position: "absolute",
    borderWidth: 3,
    borderColor: "#ff7a3c",
    backgroundColor: "rgba(255,122,60,0.12)",
    shadowColor: "#ff7a3c",
    shadowOpacity: 0.7,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 0 },
  },
  tourSpriteRow: {
    marginBottom: -22,
    zIndex: 2,
  },
  tourCard: {
    backgroundColor: "#ffffff",
    borderRadius: 22,
    paddingTop: 32,
    paddingHorizontal: 22,
    paddingBottom: 18,
    width: "100%",
    shadowColor: "#000",
    shadowOpacity: 0.3,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
    borderWidth: 1,
    borderColor: "rgba(255,122,60,0.15)",
  },
  tourProgressRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 6,
    marginBottom: 16,
  },
  tourProgressDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#e6e9f2",
  },
  tourProgressDotActive: {
    width: 18,
    backgroundColor: "#ff7a3c",
  },
  tourEmoji: {
    fontSize: 30,
    textAlign: "center",
    marginBottom: 8,
  },
  tourTitle: {
    fontSize: 20,
    fontWeight: "900",
    color: "#1f2a3d",
    textAlign: "center",
    letterSpacing: 0.2,
    marginBottom: 10,
  },
  tourBody: {
    fontSize: 14.5,
    lineHeight: 22,
    color: "#4a5670",
    textAlign: "center",
    marginBottom: 18,
  },
  tourBtnRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 10,
  },
  tourSkipBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  tourSkipText: {
    color: "#6b7894",
    fontSize: 14,
    fontWeight: "700",
  },
  tourNextBtn: {
    flex: 1,
    paddingVertical: 13,
    borderRadius: 14,
    backgroundColor: "#ff7a3c",
    alignItems: "center",
    shadowColor: "#ff4a14",
    shadowOpacity: 0.25,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
  },
  tourNextText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "900",
    letterSpacing: 0.3,
  },
  tourSkipStepBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: "rgba(244, 135, 37, 0.14)",
  },
  tourSkipStepText: {
    color: "#c15a1d",
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  tourTaskHintRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: "rgba(244, 135, 37, 0.12)",
  },
  tourTaskHintDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#f48725",
  },
  tourTaskHintText: {
    flex: 1,
    fontSize: 12.5,
    color: "#7a4416",
    fontWeight: "700",
    lineHeight: 16,
  },
  // ── Chatbot modal ────────────────────────────────────────────────────────
  chatContainer: {
    flex: 1,
    backgroundColor: "#f7f8fc",
  },
  chatHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: "#e6e9f2",
    backgroundColor: "#ffffff",
    minHeight: 62,
  },
  chatHeaderLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    flex: 1,
    minWidth: 0,
  },
  chatHeaderSprite: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  chatHeaderTitle: {
    fontSize: 17,
    fontWeight: "900",
    color: "#1f2a3d",
  },
  chatHeaderSub: {
    fontSize: 12,
    color: "#6b7894",
    marginTop: 1,
  },
  chatCloseBtn: {
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  chatCloseText: {
    fontSize: 15,
    fontWeight: "800",
    color: "#ff7a3c",
  },
  chatScrollContent: {
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 12,
  },
  chatBubbleRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    maxWidth: "100%",
  },
  chatBubbleRowBot: {
    justifyContent: "flex-start",
  },
  chatBubbleRowUser: {
    justifyContent: "flex-end",
  },
  chatBubbleAvatar: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  chatBubble: {
    maxWidth: "80%",
    paddingHorizontal: 15,
    paddingVertical: 12,
    borderRadius: 20,
  },
  chatBubbleBot: {
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e6e9f2",
    borderTopLeftRadius: 6,
  },
  chatBubbleUser: {
    backgroundColor: "#ff7a3c",
    borderTopRightRadius: 6,
  },
  chatBubbleText: {
    fontSize: 15,
    lineHeight: 21,
  },
  chatBubbleTextBot: {
    color: "#1f2a3d",
  },
  chatBubbleTextUser: {
    color: "#ffffff",
    fontWeight: "600",
  },
  chatEventListWrap: {
    gap: 8,
    paddingHorizontal: 4,
    marginTop: 4,
  },
  chatEventCard: {
    padding: 12,
    backgroundColor: "#ffffff",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#e6e9f2",
  },
  chatEventCardDark: {
    backgroundColor: "#1a2035",
    borderColor: "#2c3654",
  },
  chatEventDate: {
    fontSize: 12,
    fontWeight: "900",
    color: "#ff7a3c",
    letterSpacing: 0.3,
    marginBottom: 4,
  },
  chatEventTitle: {
    fontSize: 14,
    fontWeight: "800",
    color: "#1f2a3d",
    lineHeight: 19,
  },
  chatEventSource: {
    fontSize: 11.5,
    color: "#6b7894",
    marginTop: 4,
    fontWeight: "600",
  },
  chatSuggestRow: {
    maxHeight: 54,
    backgroundColor: "#ffffff",
    borderTopWidth: 1,
    borderTopColor: "#eef0f6",
  },
  chatSuggestRowContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chatChip: {
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 18,
    backgroundColor: "#fff4ec",
    borderWidth: 1,
    borderColor: "#ffd7b8",
  },
  chatChipDark: {
    backgroundColor: "#1a2035",
    borderColor: "#2c3654",
  },
  chatChipText: {
    fontSize: 12,
    color: "#9b4a1b",
    fontWeight: "700",
  },
  chatInputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    padding: 12,
    backgroundColor: "#ffffff",
    borderTopWidth: 1,
    borderTopColor: "#eef0f6",
  },
  chatInput: {
    flex: 1,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
    backgroundColor: "#f2f4f9",
    fontSize: 15,
    color: "#1f2a3d",
  },
  chatInputDark: {
    backgroundColor: "#1a2035",
    color: "#f4f7ff",
  },
  chatSendBtn: {
    paddingHorizontal: 16,
    paddingVertical: 11,
    borderRadius: 14,
    backgroundColor: "#ff7a3c",
  },
  chatSendText: {
    color: "#ffffff",
    fontWeight: "900",
    fontSize: 14,
    letterSpacing: 0.3,
  },
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
  welcomeSwipeHint: {
    marginTop: 14,
    color: "#e8f0ff",
    fontSize: 12,
    fontWeight: "600",
    textAlign: "center",
    letterSpacing: 0.2,
  },
  welcomeSwipeHintDark: { color: "#cfd4de" },
  welcomeCatTagline: {
    color: "#ffe4d0",
    fontSize: 15,
    fontWeight: "700",
    textAlign: "center",
    letterSpacing: 0.2,
    marginTop: -2,
    marginBottom: 14,
  },
  welcomeCatTaglineMinera: { color: "#fff4ec" },
  welcomeCatTaglineEmerald: { color: "#244c35" },
  welcomeCatTaglineNeo: { color: "#333" },
  welcomeCatCard: {
    alignSelf: "center",
    width: "100%",
    aspectRatio: 4 / 3,
    borderRadius: 20,
    overflow: "hidden",
    backgroundColor: "rgba(0,0,0,0.18)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.22)",
    shadowColor: "#000",
    shadowOpacity: 0.28,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
    marginBottom: 14,
  },
  welcomeCatCardTight: {
    aspectRatio: 4 / 3,
    marginTop: 4,
    marginBottom: 12,
  },
  welcomeCatImage: {
    width: "100%",
    height: "100%",
  },
  welcomeCatCaption: {
    color: "#ffffff",
    fontSize: 20,
    fontWeight: "800",
    textAlign: "center",
    letterSpacing: -0.2,
    marginTop: 2,
    marginBottom: 4,
  },
  welcomeCatCaptionMinera: { color: "#fff4ec" },
  welcomeCatCaptionEmerald: { color: "#1f3b2a" },
  welcomeCatCaptionNeo: { color: "#1e1e1e" },
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
    marginTop: 4,
    marginBottom: 10,
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
  welcomeTitle: { marginTop: -6, fontSize: 22, fontWeight: "900", color: "#ffffff", lineHeight: 28, letterSpacing: -0.4, maxWidth: "100%", textAlign: "center", alignSelf: "center" },
  welcomeSub: { marginTop: 10, color: "#dce7ff", fontSize: 15, lineHeight: 23, maxWidth: "96%", textAlign: "center", alignSelf: "center" },
  welcomeBrandMinera: { color: "#fffaf6", fontFamily: MINERA_FONT_BOLD, fontWeight: "700", letterSpacing: -0.15 },
  welcomeTitleMinera: { color: "#fff7f2", fontFamily: MINERA_FONT_MEDIUM, fontWeight: "700", letterSpacing: -0.05 },
  welcomeSubMinera: { color: "#ffece0", fontFamily: MINERA_FONT_REGULAR, fontWeight: "500" },
  welcomeBrandEmerald: { color: "#1f5236" },
  welcomeTitleEmerald: { color: "#245b3c" },
  welcomeSubEmerald: { color: "#406a52" },
  welcomeBrandNeo: { color: "#151515" },
  welcomeTitleNeo: { color: "#121212" },
  welcomeSubNeo: { color: "#4e4e4e" },
  heroTrustRow: { marginTop: 18, flexDirection: "row", flexWrap: "nowrap", justifyContent: "space-between", alignItems: "center", gap: 6 },
  heroTrustPill: {
    flex: 1,
    minWidth: 0,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#ffffff2f",
    backgroundColor: "#ffffff1a",
    color: "#f3f8ff",
    fontSize: 10,
    fontWeight: "700",
    textAlign: "center",
    paddingHorizontal: 8,
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
  captureCard: { gap: 12, paddingTop: 22, paddingBottom: 24 },
  // Slide-3 (Quick setup) overrides: content must anchor to the top and be
  // scrollable because on shorter phones (SE/mini/11) the form is taller
  // than the viewport. Without these the card was centered inside a
  // too-tall container and the title + Name field got pushed above the
  // status bar with no way to reach them.
  welcomeSlideSetup: {
    justifyContent: "flex-start",
    paddingTop: 0,
    paddingBottom: 0,
  },
  welcomeSetupKAV: { flex: 1, width: "100%" },
  welcomeSetupScroll: { flex: 1, width: "100%" },
  welcomeSetupScrollContent: {
    flexGrow: 1,
    justifyContent: "flex-start",
    paddingHorizontal: 0,
  },
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
  welcomeSkipPill: {
    position: "absolute",
    top: 14,
    right: 14,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.55)",
    backgroundColor: "rgba(255,255,255,0.16)",
    paddingHorizontal: 14,
    paddingVertical: 6,
    zIndex: 2,
  },
  welcomeSkipPillText: { color: "#fff2e8", fontSize: 12, fontWeight: "800", letterSpacing: 0.4 },
  welcomeSkipPillTextNeo: { color: "#2e2e2e" },
  welcomeSkipPillTextEmerald: { color: "#2f6245" },
  captureTitle: { color: "#fff8f2", fontSize: 26, fontWeight: "900", letterSpacing: -0.6, lineHeight: 32, maxWidth: "100%" },
  captureTitleCentered: { textAlign: "center", alignSelf: "center" },
  captureSub: { color: "#ffe8d6", fontSize: 15, lineHeight: 22, marginBottom: 4 },
  captureSubCentered: { textAlign: "center", alignSelf: "center", maxWidth: 560 },
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
  captureChoiceRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "center" },
  captureChoicePill: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.45)",
    backgroundColor: "rgba(255,255,255,0.14)",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  captureChoicePillPressed: { opacity: 0.55, transform: [{ scale: 0.96 }] },
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
  captureHelper: { marginTop: 6, color: "#ffd7bc", fontSize: 12, lineHeight: 18, fontWeight: "600", opacity: 0.9 },
  captureEmailOptInRow: {
    marginTop: 10,
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: 12,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.18)",
  },
  captureEmailOptInRowActive: {
    backgroundColor: "rgba(255,255,255,0.16)",
    borderColor: "rgba(255,214,180,0.65)",
  },
  captureEmailOptInBox: {
    width: 22,
    height: 22,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.55)",
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 2,
  },
  captureEmailOptInBoxActive: {
    backgroundColor: "#ffd7bc",
    borderColor: "#ffd7bc",
  },
  captureEmailOptInCheck: { color: "#5b2e12", fontSize: 14, fontWeight: "900" },
  captureEmailOptInLabel: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "800",
  },
  captureEmailOptInSub: {
    color: "#ffe2cb",
    fontSize: 12,
    lineHeight: 17,
    marginTop: 3,
    fontWeight: "500",
  },
  captureReviewCard: {
    marginTop: 8,
    padding: 14,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.1)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.24)",
    gap: 6,
  },
  captureReviewRow: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "600",
    lineHeight: 20,
  },
  captureReviewKey: {
    color: "#ffdfc9",
    fontWeight: "900",
  },
  captureOptionalAccountNote: {
    marginTop: 10,
    marginBottom: 2,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.1)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.22)",
    gap: 2,
  },
  captureOptionalAccountNoteTitle: {
    color: "#ffffff",
    fontSize: 13,
    fontWeight: "900",
    letterSpacing: 0.2,
  },
  captureOptionalAccountNoteText: {
    color: "#ffe7d7",
    fontSize: 12,
    lineHeight: 17,
    fontWeight: "600",
  },
  setupSubStepBtnRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
    flexWrap: "wrap",
    gap: 10,
    marginTop: 12,
    paddingRight: 4,
  },
  setupSubStepSkipBtn: {
    flexGrow: 1,
    flexBasis: 132,
    minWidth: 132,
    backgroundColor: "rgba(255,255,255,0.1)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
  },
  setupSubStepSkipBtnText: {
    color: "#fff4ea",
    fontWeight: "800",
    fontSize: 14,
    lineHeight: 18,
    textAlign: "center",
    paddingHorizontal: 8,
  },
  setupSubStepBackBtn: {
    flexGrow: 1,
    flexBasis: 104,
    minWidth: 104,
    backgroundColor: "rgba(255,255,255,0.14)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.35)",
  },
  setupSubStepBackBtnText: {
    color: "#ffffff",
    fontWeight: "800",
    fontSize: 15,
  },
  setupSubStepNextBtn: {
    flexGrow: 1.2,
    flexBasis: 138,
    minWidth: 138,
    marginRight: 2,
  },
  capturePrivacyRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    padding: 12,
    borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.08)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.2)",
  },
  capturePrivacyCheckWrap: { alignSelf: "flex-start" },
  capturePrivacyCheck: {
    width: 24,
    height: 24,
    borderRadius: 7,
    borderWidth: 2,
    borderColor: "rgba(255,255,255,0.55)",
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
  },
  capturePrivacyCheckOn: {
    backgroundColor: "#ff7a3c",
    borderColor: "#ff9255",
  },
  capturePrivacyCheckMark: { color: "#fff", fontSize: 14, fontWeight: "900" },
  capturePrivacyLegalText: { flex: 1, fontSize: 13, lineHeight: 20, fontWeight: "600" },
  capturePrivacyLink: { fontWeight: "900", textDecorationLine: "underline" },
  loadingMasjidlyOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(5, 9, 18, 0.34)",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 28,
  },
  loadingMasjidlyCard: {
    width: "100%",
    maxWidth: 320,
    backgroundColor: "#ffffff",
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 22,
    paddingVertical: 26,
    shadowColor: "#0b1330",
    shadowOpacity: 0.13,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 9,
  },
  loadingMasjidlyCardDark: {
    backgroundColor: "#171d2d",
    shadowOpacity: 0.38,
  },
  loadingMasjidlyTitle: {
    fontSize: 18,
    fontWeight: "800",
    color: "#1d2433",
    letterSpacing: -0.2,
  },
  loadingMasjidlyTitleDark: {
    color: "#f1f5ff",
  },
  launchWrap: { flex: 1, justifyContent: "center", alignItems: "center", paddingHorizontal: 24, overflow: "hidden" },
  launchGlowOne: { top: -62, right: -38, width: 210, height: 210, opacity: 0.78 },
  launchGlowTwo: { bottom: -34, left: -22, width: 148, height: 148, opacity: 0.82 },
  launchCard: {
    width: "100%",
    borderRadius: 24,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 20,
    paddingBottom: 18,
    paddingHorizontal: 20,
    minHeight: 390,
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
    backgroundColor: "#ff865c",
    borderColor: "rgba(255,235,220,0.62)",
    shadowColor: "#8a4a2a",
  },
  launchTopCluster: {
    width: "100%",
    alignItems: "center",
    gap: 8,
  },
  launchKicker: {
    color: "rgba(255,255,255,0.86)",
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 1.3,
    textAlign: "center",
  },
  launchKickerDark: { color: "rgba(226,233,255,0.92)" },
  launchKickerNeo: { color: "#4e4e4e" },
  launchKickerEmerald: { color: "#2b5a41" },
  launchGreeting: {
    marginTop: 28,
    color: "#b55624",
    fontSize: 26,
    fontWeight: "900",
    letterSpacing: -0.4,
    textAlign: "center",
    alignSelf: "center",
    paddingHorizontal: 18,
  },
  launchGreetingNeo: { color: "#8f4a25" },
  launchGreetingEmerald: { color: "#1f5137" },
  launchCatCard: {
    alignSelf: "center",
    marginTop: 18,
    width: 180,
    height: 180,
    borderRadius: 90,
    overflow: "hidden",
    backgroundColor: "rgba(255, 255, 255, 0.22)",
    borderWidth: 4,
    borderColor: "rgba(255, 255, 255, 0.55)",
    shadowColor: "#0d1221",
    shadowOpacity: 0.22,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 14 },
    elevation: 10,
  },
  launchCatImage: {
    width: "100%",
    height: "100%",
  },
  launchDotsRow: {
    marginTop: 22,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  launchDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#d68750",
  },
  launchDotDark: { backgroundColor: "#ffb486" },
  launchSimpleHero: {
    marginTop: 46,
    minHeight: "78%",
    width: "100%",
    alignItems: "center",
    justifyContent: "flex-start",
    paddingHorizontal: 20,
  },
  launchSimpleLogoWrap: {
    width: 300,
    height: 300,
    borderRadius: 44,
    backgroundColor: "rgba(255,122,60,0.92)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.55)",
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
  },
  launchSimpleLogoWrapNeo: { backgroundColor: "#f2f2f2", borderColor: "#b4b4b4" },
  launchSimpleLogoWrapEmerald: { backgroundColor: "#e6f3ea", borderColor: "#a7c7b3" },
  launchSimpleLogoWrapMidnight: { backgroundColor: "#151a32", borderColor: "#2e3858" },
  launchSimpleLogoWrapVitaria: { backgroundColor: "rgba(255,255,255,0.2)", borderColor: "rgba(255,255,255,0.36)" },
  launchSimpleLogoWrapInferno: { backgroundColor: "#2b1208", borderColor: "#7b3a17" },
  launchSimpleLogo: {
    width: "100%",
    height: "100%",
  },
  launchSimpleTextBlock: {
    marginTop: "auto",
    marginBottom: 20,
    alignItems: "center",
    width: "100%",
  },
  launchSimpleTitle: {
    color: "#1f2f4f",
    fontSize: 44,
    fontWeight: "900",
    letterSpacing: -0.7,
    textAlign: "center",
    lineHeight: 48,
  },
  launchSimpleSub: {
    marginTop: 14,
    color: "#4c5f84",
    fontSize: 16,
    lineHeight: 22,
    fontWeight: "700",
    textAlign: "center",
  },
  launchTitle: { color: "#ffffff", fontSize: 38, fontWeight: "900", letterSpacing: -0.5, textAlign: "center", lineHeight: 42 },
  launchTitleDark: { color: "#eef2ff" },
  launchTitleNeo: { color: "#1f1f1f" },
  launchTitleEmerald: { color: "#1f5137" },
  launchTitleVitaria: { color: "#fffaf6" },
  launchTitleInferno: { color: "#ffe6d4" },
  launchLead: {
    color: "#ffe9da",
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
    lineHeight: 21,
    paddingHorizontal: 4,
  },
  launchBottomNote: {
    width: "100%",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.26)",
    backgroundColor: "rgba(255,255,255,0.14)",
  },
  launchBottomNoteDark: {
    borderColor: "rgba(219,227,255,0.26)",
    backgroundColor: "rgba(219,227,255,0.1)",
  },
  launchBottomNoteNeo: {
    borderColor: "rgba(111,111,111,0.22)",
    backgroundColor: "rgba(255,255,255,0.66)",
  },
  launchBottomNoteEmerald: {
    borderColor: "rgba(104,146,120,0.28)",
    backgroundColor: "rgba(246,255,249,0.62)",
  },
  launchFeatureStack: {
    width: "100%",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.26)",
    backgroundColor: "rgba(255,255,255,0.12)",
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 8,
  },
  launchFeatureStackDark: {
    borderColor: "rgba(219,227,255,0.25)",
    backgroundColor: "rgba(219,227,255,0.08)",
  },
  launchFeatureStackNeo: {
    borderColor: "rgba(126,126,126,0.24)",
    backgroundColor: "rgba(255,255,255,0.64)",
  },
  launchFeatureStackEmerald: {
    borderColor: "rgba(104,146,120,0.28)",
    backgroundColor: "rgba(246,255,249,0.58)",
  },
  launchFeatureStackVitaria: {
    borderColor: "rgba(255,255,255,0.32)",
    backgroundColor: "rgba(255,255,255,0.16)",
  },
  launchFeatureRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 8,
  },
  launchFeatureDot: {
    width: 6,
    height: 6,
    borderRadius: 999,
    backgroundColor: "#fff2e6",
    marginTop: 6,
  },
  launchFeatureDotDark: { backgroundColor: "#d8e2ff" },
  launchFeatureDotNeo: { backgroundColor: "#585858" },
  launchFeatureDotEmerald: { backgroundColor: "#2f6c47" },
  launchFeatureText: {
    flex: 1,
    color: "#fff5ec",
    fontSize: 13,
    lineHeight: 19,
    fontWeight: "700",
  },
  launchFeatureTextDark: { color: "#d7e0f6" },
  launchFeatureTextNeo: { color: "#505050" },
  launchFeatureTextEmerald: { color: "#305f47" },
  launchFeatureTextVitaria: { color: "#fff8f3" },
  launchSub: { color: "#fff0e3", fontSize: 15, fontWeight: "700", textAlign: "center", lineHeight: 20 },
  launchSubDark: { color: "#cad3ec" },
  launchSubNeo: { color: "#626262" },
  launchSubEmerald: { color: "#3f6a53" },
  launchSubVitaria: { color: "#fff8f3" },
  launchSubInferno: { color: "#ffd1b7" },
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
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 999,
    backgroundColor: "#2f3138",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#14171e",
    shadowOpacity: 0.22,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 5 },
  },
  darkPillBtnText: { color: "#fff", fontWeight: "700", fontSize: 12 },
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
  mapHomePinWrap: { alignItems: "center", justifyContent: "center" },
  mapHomePinOuter: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "rgba(45,112,255,0.25)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 2,
    borderColor: "#ffffff",
  },
  mapHomePinInner: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "#2d70ff",
  },
  mapHomePinLabelWrap: {
    marginTop: 2,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
    backgroundColor: "rgba(12,15,25,0.85)",
  },
  mapHomePinLabel: { color: "#ffffff", fontSize: 11, fontWeight: "800", letterSpacing: 0.4 },
  mapRecenterBtn: {
    position: "absolute",
    right: 14,
    bottom: 18,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "#ffffff",
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#0b1220",
    shadowOpacity: 0.22,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  mapRecenterEmoji: { fontSize: 20 },
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
  mapMasjidLogoImage: {
    width: 36,
    height: 36,
    borderRadius: 18,
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
  mapMasjidBadgeLive: { backgroundColor: "#ff2d55" },
  mapMasjidLogoLive: {
    shadowColor: "#ff2d55",
    shadowOpacity: 0.6,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
  },
  mapMasjidLiveRing: {
    position: "absolute",
    top: -6, left: -6, right: -6, bottom: -6,
    borderRadius: 40,
    borderWidth: 3,
    borderColor: "#ff2d55",
    opacity: 0.55,
  },
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
    marginBottom: 10,
    paddingHorizontal: 10,
    paddingVertical: 12,
    height: 132,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.22)",
    overflow: "hidden",
    shadowColor: "#ff4a14",
    shadowOpacity: 0.28,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  topBarGlow: {
    position: "absolute",
    top: -38,
    left: -6,
    width: 206,
    height: 206,
    borderRadius: 103,
    backgroundColor: "rgba(255,206,168,0.5)",
  },
  topBarGlowB: {
    position: "absolute",
    bottom: -86,
    right: -24,
    width: 244,
    height: 244,
    borderRadius: 122,
    backgroundColor: "rgba(255,195,152,0.46)",
  },
  topBarBrandRow: { alignItems: "center", justifyContent: "center", flex: 1 },
  topBarWordmark: { width: "100%", height: "100%", alignSelf: "center" },
  tabSceneWrap: { flex: 1 },
  scrollBody: { width: "100%", maxWidth: "100%", paddingHorizontal: 12, paddingBottom: 120, gap: 10, flexGrow: 1 },
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
  feedWizardExplainer: {
    marginTop: 10,
    fontSize: 13,
    lineHeight: 20,
    color: "#5a657c",
    fontWeight: "500",
  },
  feedWizardExplainerDark: { color: "#c5d0ef" },
  feedWizardExplainerNeo: { color: "#3d3d3d" },
  feedWizardExplainerEmerald: { color: "#2f5a40" },
  feedWizardExplainerInferno: { color: "rgba(255,210,180,0.92)" },
  feedWizardExplainerVitaria: { color: "rgba(255,255,255,0.88)" },
  feedWizardTopBar: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginHorizontal: 12,
    marginTop: 8,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#d8dce7",
    backgroundColor: "rgba(248,251,255,0.92)",
  },
  feedWizardTopBarDark: { borderColor: "#2c3654", backgroundColor: "rgba(18,24,40,0.96)" },
  feedWizardTopBarNeo: { borderColor: "#c4c4c4", backgroundColor: "rgba(245,245,245,0.95)" },
  feedWizardTopBarEmerald: { borderColor: "#9fcab0", backgroundColor: "rgba(238,248,241,0.95)" },
  feedWizardTopBarInferno: { borderColor: "rgba(255,126,50,0.35)", backgroundColor: "rgba(28,12,8,0.94)" },
  feedWizardTopBarVitaria: { borderColor: "rgba(255,255,255,0.2)", backgroundColor: "rgba(60,40,68,0.55)" },
  feedWizardTopTitle: { fontSize: 17, fontWeight: "900", color: "#1f2430", letterSpacing: -0.3 },
  feedWizardTopTitleDark: { color: "#f4f7ff" },
  feedWizardTopTitleNeo: { color: "#151515" },
  feedWizardTopTitleEmerald: { color: "#0f5130" },
  feedWizardTopTitleInferno: { color: "#fff4e8" },
  feedWizardTopTitleVitaria: { color: "#ffffff" },
  feedWizardTopSub: { marginTop: 2, fontSize: 12, lineHeight: 16, color: "#5d7192", fontWeight: "600" },
  feedWizardTopSubDark: { color: "#aebcdc" },
  feedWizardTopSubNeo: { color: "#454545" },
  feedWizardTopSubEmerald: { color: "#2f6f4a" },
  feedWizardTopSubInferno: { color: "rgba(255,210,180,0.9)" },
  feedWizardTopSubVitaria: { color: "rgba(255,255,255,0.85)" },
  feedWizardCancelLink: { fontSize: 14, fontWeight: "800", color: "#2a5fb0", paddingLeft: 8 },
  feedWizardCancelLinkDark: { color: "#9eb9ff" },
  feedWizardExplainerCompact: { fontSize: 12, lineHeight: 17, color: "#5d7192", fontWeight: "500", marginBottom: 4 },
  feedWizardExplainerCompactDark: { color: "#9db0db" },
  feedWizardExplainerCompactNeo: { color: "#4a5568" },
  feedWizardExplainerCompactEmerald: { color: "#3a5c47" },
  feedHeaderEditBtn: {
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "rgba(42,95,176,0.35)",
    backgroundColor: "rgba(42,95,176,0.08)",
    paddingHorizontal: 12,
    paddingVertical: 7,
    alignSelf: "flex-start",
  },
  feedHeaderEditBtnDark: { borderColor: "rgba(158,185,255,0.45)", backgroundColor: "rgba(120,160,255,0.12)" },
  feedHeaderEditBtnNeo: { borderColor: "#9a9a9a", backgroundColor: "rgba(0,0,0,0.04)" },
  feedHeaderEditBtnEmerald: { borderColor: "#5aa97a", backgroundColor: "rgba(90,169,122,0.12)" },
  feedHeaderEditBtnInferno: { borderColor: "rgba(255,140,80,0.5)", backgroundColor: "rgba(255,100,40,0.12)" },
  feedHeaderEditBtnVitaria: { borderColor: "rgba(255,255,255,0.35)", backgroundColor: "rgba(255,255,255,0.1)" },
  feedHeaderEditBtnText: { fontSize: 13, fontWeight: "900", color: "#2a4a7c" },
  feedHeaderEditBtnTextDark: { color: "#dbe6ff" },
  feedHeaderEditBtnTextNeo: { color: "#222" },
  feedHeaderEditBtnTextEmerald: { color: "#14532d" },
  feedHeaderEditBtnTextInferno: { color: "#fff4e8" },
  feedHeaderEditBtnTextVitaria: { color: "#ffffff" },
  feedTopicRow: {
    marginTop: 10,
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  feedTopicChip: {
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#cfd7ea",
    backgroundColor: "#f8fbff",
    paddingHorizontal: 11,
    paddingVertical: 6,
  },
  feedTopicChipActive: {
    borderColor: "#8cb3f2",
    backgroundColor: "#e2ecff",
  },
  feedTopicChipDark: {
    borderColor: "rgba(190,204,236,0.3)",
    backgroundColor: "rgba(255,255,255,0.07)",
  },
  feedTopicChipNeo: {
    borderColor: "#b8b8b8",
    backgroundColor: "#f2f2f2",
  },
  feedTopicChipEmerald: {
    borderColor: "#9fcab0",
    backgroundColor: "#eef8f1",
  },
  feedTopicChipActiveDark: {
    borderColor: "rgba(143,183,255,0.8)",
    backgroundColor: "rgba(97,142,222,0.35)",
  },
  feedTopicChipText: {
    color: "#476185",
    fontSize: 12,
    fontWeight: "700",
    textTransform: "capitalize",
  },
  feedTopicChipTextDark: {
    color: "#d5dff7",
  },
  feedTopicChipTextNeo: {
    color: "#4f4f4f",
  },
  feedTopicChipTextEmerald: {
    color: "#2a6644",
  },
  feedTopicChipTextActive: {
    color: "#224d88",
  },
  feedTopicChipTextActiveDark: {
    color: "#f4f8ff",
  },
  feedBuilderCard: {
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "#dbe3f2",
    backgroundColor: "#f7f9ff",
    padding: 12,
    gap: 8,
  },
  feedBuilderStepLabel: {
    marginTop: 2,
    color: "#294971",
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  feedBuilderStepLabelDark: {
    color: "#ced9f4",
  },
  feedInlineFollowBtn: {
    marginTop: 8,
    alignSelf: "flex-start",
  },
  feedSetupBackdrop: {
    flex: 1,
    backgroundColor: "rgba(8,12,20,0.55)",
    justifyContent: "center",
    paddingHorizontal: 16,
  },
  feedSetupCard: {
    borderRadius: 20,
    borderWidth: 1,
    borderColor: "#d7e0f0",
    backgroundColor: "#f8fbff",
    maxHeight: "84%",
    overflow: "hidden",
  },
  feedSetupCardDark: {
    borderColor: "#2a3550",
    backgroundColor: "#10192c",
  },
  feedSetupHeader: {
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(112,132,168,0.18)",
    gap: 6,
  },
  feedSetupHeaderTop: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  feedSetupCloseBtn: {
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#d1dbef",
    backgroundColor: "#ffffff",
  },
  feedSetupCloseText: {
    color: "#5f7395",
    fontSize: 13,
    fontWeight: "900",
    lineHeight: 15,
  },
  feedSetupStepPill: {
    alignSelf: "flex-start",
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#c6d5ee",
    backgroundColor: "#eaf1ff",
    color: "#2a4a7c",
    paddingHorizontal: 9,
    paddingVertical: 4,
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.4,
  },
  feedSetupStepPillDark: {
    borderColor: "#3c4d70",
    backgroundColor: "#1d2b47",
    color: "#dbe6ff",
  },
  feedSetupTitle: {
    color: "#1d2d48",
    fontSize: 23,
    fontWeight: "900",
    lineHeight: 29,
    letterSpacing: -0.4,
  },
  feedSetupTitleDark: { color: "#edf3ff" },
  feedSetupSub: {
    color: "#5d7192",
    fontSize: 13,
    lineHeight: 19,
    fontWeight: "600",
  },
  feedSetupSubDark: { color: "#aebcdc" },
  feedSetupScroll: { flex: 1 },
  feedSetupScrollContent: { paddingHorizontal: 12, paddingVertical: 10, gap: 8 },
  feedSetupChoiceRow: {
    minHeight: 58,
    borderRadius: 13,
    borderWidth: 1,
    borderColor: "#dbe3f2",
    backgroundColor: "#ffffff",
    paddingHorizontal: 10,
    paddingVertical: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 9,
  },
  feedSetupChoiceRowDark: {
    borderColor: "#304162",
    backgroundColor: "#151f35",
  },
  feedSetupChoiceRowActive: {
    borderColor: "#8eb2f5",
    backgroundColor: "#e7efff",
  },
  feedSetupChoiceTitle: {
    color: "#1f355a",
    fontSize: 14,
    fontWeight: "800",
  },
  feedSetupChoiceTitleDark: { color: "#e8f0ff" },
  feedSetupChoiceMeta: {
    marginTop: 1,
    color: "#6a7f9f",
    fontSize: 12,
    fontWeight: "600",
  },
  feedSetupChoiceMetaDark: { color: "#aebede" },
  feedSetupChoiceState: {
    color: "#6a7f9f",
    fontSize: 22,
    fontWeight: "900",
    paddingHorizontal: 4,
  },
  feedSetupChoiceStateActive: { color: "#2a5fb0" },
  feedSetupMasjidLogo: {
    width: 38,
    height: 38,
    borderRadius: 19,
  },
  feedSetupSpeakerAvatar: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#ffe3d1",
    borderWidth: 1,
    borderColor: "#ffd0b4",
  },
  feedSetupSpeakerAvatarText: {
    color: "#9b4a1b",
    fontSize: 14,
    fontWeight: "900",
  },
  feedSetupTopicWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  feedSetupFooter: {
    borderTopWidth: 1,
    borderTopColor: "rgba(112,132,168,0.18)",
    padding: 12,
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 10,
  },
  feedSetupBackBtn: {
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#cad6ee",
    backgroundColor: "#f3f7ff",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
    flex: 1,
  },
  feedSetupBackText: { color: "#3f5f90", fontSize: 14, fontWeight: "800" },
  feedSetupNextBtn: {
    minHeight: 44,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#4c84e6",
    backgroundColor: "#4a81e2",
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
    flex: 1.3,
  },
  feedSetupNextText: { color: "#ffffff", fontSize: 14, fontWeight: "900" },
  feedSetupLoadingWrap: {
    padding: 24,
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  feedSetupLoadingDots: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
  feedSetupLoadingDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#7ea7ef",
  },
  feedBuildWrap: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 24,
    paddingVertical: 32,
  },
  feedBuildWrapDark: {},
  feedBuildCard: {
    width: "100%",
    maxWidth: 360,
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderRadius: 24,
    paddingHorizontal: 22,
    paddingTop: 22,
    paddingBottom: 24,
    shadowColor: "#0b1330",
    shadowOpacity: 0.08,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 10 },
    elevation: 6,
  },
  feedBuildCardDark: {
    backgroundColor: "#151b2c",
    shadowOpacity: 0.4,
  },
  feedBuildGifWrap: {
    width: 188,
    height: 188,
    borderRadius: 22,
    overflow: "hidden",
    marginBottom: 18,
    backgroundColor: "#f5f6fb",
  },
  feedBuildGif: {
    width: "100%",
    height: "100%",
  },
  feedBuildTitle: {
    fontSize: 22,
    fontWeight: "800",
    color: "#0f172a",
    letterSpacing: -0.3,
    textAlign: "center",
  },
  feedBuildTitleDark: { color: "#f4f7ff" },
  feedBuildSub: {
    marginTop: 6,
    fontSize: 14,
    color: "#5b6478",
    textAlign: "center",
    lineHeight: 20,
  },
  feedBuildSubDark: { color: "#a6b1c9" },
  feedBuildBarTrack: {
    marginTop: 20,
    width: "100%",
    height: 8,
    borderRadius: 999,
    backgroundColor: "#e7ebf3",
    overflow: "hidden",
  },
  feedBuildBarTrackDark: {
    backgroundColor: "#263049",
  },
  feedBuildBarFill: {
    height: "100%",
    backgroundColor: "#2f6bff",
    borderRadius: 999,
  },
  feedBuildPercent: {
    marginTop: 10,
    fontSize: 12,
    fontWeight: "600",
    color: "#6d7590",
    letterSpacing: 0.2,
    textAlign: "center",
  },
  feedBuildPercentDark: { color: "#8da0c7" },
  feedBuildSuccessCard: {
    width: "100%",
    maxWidth: 360,
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderRadius: 24,
    paddingHorizontal: 22,
    paddingTop: 32,
    paddingBottom: 28,
    shadowColor: "#0b1330",
    shadowOpacity: 0.08,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 10 },
    elevation: 6,
  },
  feedBuildSuccessCardDark: {
    backgroundColor: "#151b2c",
    shadowOpacity: 0.4,
  },
  feedBuildSuccessBadge: {
    width: 92,
    height: 92,
    borderRadius: 46,
    backgroundColor: "#19a870",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 18,
    shadowColor: "#19a870",
    shadowOpacity: 0.35,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  feedEditCancelPill: {
    alignSelf: "flex-start",
    marginTop: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.18)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.3)",
  },
  feedEditCancelPillText: {
    color: "#ffffff",
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 0.3,
  },
  feedViewSwitch: {
    flexDirection: "row",
    marginHorizontal: 12,
    marginTop: 10,
    marginBottom: 4,
    padding: 4,
    borderRadius: 14,
    backgroundColor: "#eef1f7",
    borderWidth: 1,
    borderColor: "#dfe4ef",
    gap: 4,
  },
  feedViewSwitchDark: {
    backgroundColor: "rgba(22,27,44,0.85)",
    borderColor: "rgba(255,255,255,0.1)",
  },
  feedViewSwitchBtn: {
    flex: 1,
    flexBasis: 0,
    minWidth: 0,
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  feedViewSwitchBtnActive: {
    backgroundColor: "#ff7d50",
    shadowColor: "#000",
    shadowOpacity: 0.08,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 2,
  },
  feedViewSwitchText: {
    color: "#54617b",
    fontWeight: "800",
    fontSize: 13,
    letterSpacing: 0.2,
  },
  feedViewSwitchTextDark: {
    color: "#b3bed8",
  },
  feedViewSwitchTextActive: {
    color: "#fff8f2",
  },
  feedSavedEmptyCard: {
    borderRadius: 18,
    padding: 20,
    backgroundColor: "#fff4ec",
    borderWidth: 1,
    borderColor: "#ffd6b9",
    gap: 10,
    alignItems: "flex-start",
  },
  feedSavedEmptyCardDark: {
    backgroundColor: "rgba(255,125,80,0.12)",
    borderColor: "rgba(255,125,80,0.3)",
  },
  feedSavedEmptyTitle: {
    color: "#3e1d05",
    fontSize: 18,
    fontWeight: "900",
  },
  feedSavedEmptySub: {
    color: "#7a4a28",
    fontSize: 13,
    lineHeight: 19,
    fontWeight: "600",
  },
  feedSavedEmptyBtn: {
    marginTop: 4,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: "#ff7d50",
  },
  feedSavedEmptyBtnText: {
    color: "#fff8f2",
    fontWeight: "900",
    fontSize: 13,
    letterSpacing: 0.3,
  },
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
    width: 5,
    height: 5,
    borderRadius: 999,
    backgroundColor: "#ff7d50",
  },
  calendarDayDotRow: {
    position: "absolute",
    bottom: 4,
    flexDirection: "row",
    gap: 2,
  },
  calendarDayDotActive: { backgroundColor: "#a2401f" },
  calendarDayEmpty: { width: "14.285%", aspectRatio: 1, marginBottom: 8 },
  calendarDayToday: {
    borderColor: "#2d70ff",
    borderWidth: 2,
  },
  calendarDayTextToday: { color: "#1849b8" },
  calendarMonthBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: 14,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e3e8f1",
    marginVertical: 10,
  },
  calendarMonthBarDark: { backgroundColor: "#111728", borderColor: "#2b334b" },
  calendarMonthArrowBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#f4f7fd",
  },
  calendarMonthArrow: { fontSize: 24, fontWeight: "800", color: "#2e4f82", lineHeight: 26 },
  calendarMonthLabel: { fontSize: 18, fontWeight: "800", color: "#1e2740" },
  calendarMonthLabelSub: { fontSize: 11, fontWeight: "600", color: "#8793ab", marginTop: 2 },
  calendarLegendRow: {
    flexDirection: "row",
    justifyContent: "space-around",
    marginTop: 10,
    paddingHorizontal: 6,
  },
  calendarLegendItem: { flexDirection: "row", alignItems: "center", gap: 6 },
  calendarLegendText: { fontSize: 11, fontWeight: "600", color: "#4e5c77" },
  calendarLegendSwatchToday: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: "#2d70ff",
    backgroundColor: "#ffffff",
  },
  calendarLegendSwatchEvents: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "#fff0e8",
    borderWidth: 1,
    borderColor: "#f9a77f",
  },
  calendarLegendSwatchSelected: {
    width: 12,
    height: 12,
    borderRadius: 6,
    backgroundColor: "#ffd8c6",
    borderWidth: 2,
    borderColor: "#ff7d50",
  },
  calendarAgendaCount: {
    fontSize: 12,
    fontWeight: "700",
    color: "#4e5c77",
    letterSpacing: 0.4,
    textTransform: "uppercase",
  },
  calendarAgendaRow: {
    flexDirection: "row",
    gap: 12,
    padding: 10,
    borderRadius: 16,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e3e8f1",
  },
  calendarAgendaRowDark: { backgroundColor: "#111728", borderColor: "#2b334b" },
  calendarAgendaPoster: {
    width: 72,
    height: 72,
    borderRadius: 12,
    backgroundColor: "#e3e8f1",
  },
  calendarAgendaWhen: {
    fontSize: 12,
    fontWeight: "700",
    color: "#4e5c77",
    letterSpacing: 0.3,
  },
  calendarAgendaTitle: { fontSize: 15, fontWeight: "800", color: "#1e2740" },
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
    padding: 6,
    gap: 4,
  },
  tabBarMidnight: { backgroundColor: "#111424", borderColor: "#23273a" },
  tabBarNeo: { backgroundColor: "#d8d8d8", borderColor: "#b9b9b9", borderRadius: 16 },
  tabBarVitaria: { backgroundColor: "rgba(43,18,57,0.58)", borderColor: "rgba(255,255,255,0.2)" },
  tabBarInferno: { backgroundColor: "rgba(18,8,6,0.92)", borderColor: "rgba(255,126,50,0.2)" },
  tabBarEmerald: { backgroundColor: "#e0f2e7", borderColor: "#8fc6a7" },
  tabBtn: {
    flex: 1,
    flexBasis: 0,
    minWidth: 0,
    height: 52,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 2,
    paddingVertical: 4,
  },
  tabBtnActive: { backgroundColor: "#ff7d50" },
  tabBtnActiveMidnight: { backgroundColor: "#ff7d50" },
  tabBtnActiveNeo: { backgroundColor: "#ff7d50" },
  tabBtnActiveVitaria: { backgroundColor: "#ff7d50" },
  tabBtnActiveInferno: { backgroundColor: "#ff7d50" },
  tabBtnActiveEmerald: { backgroundColor: "#ff7d50" },
  tabIcon: { color: "#8a92a4", fontSize: 18, lineHeight: 20, marginBottom: 2, textAlign: "center" },
  tabIconImage: { width: 22, height: 22, marginBottom: 3, alignSelf: "center" },
  tabIconMidnight: { color: "#6f7897" },
  tabIconNeo: { color: "#4a4a4a" },
  tabIconVitaria: { color: "rgba(255,255,255,0.82)" },
  tabIconInferno: { color: "rgba(255,195,162,0.86)" },
  tabIconEmerald: { color: "#2f6f4a" },
  tabIconActive: { color: "#fff8f2" },
  tabIconActiveInferno: { color: "#fffaf6" },
  tabIconActiveEmerald: { color: "#fff8f2" },
  tabText: { color: "#7a8397", fontWeight: "700", fontSize: 10, lineHeight: 12, textAlign: "center", includeFontPadding: false },
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

  posterFullscreenRoot: { flex: 1, backgroundColor: "rgba(0,0,0,0.94)" },
  posterFullscreenCenter: {
    justifyContent: "center",
    alignItems: "center",
    padding: 12,
  },
  posterFullscreenClose: {
    position: "absolute",
    right: 16,
    zIndex: 4,
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: "rgba(0,0,0,0.45)",
    alignItems: "center",
    justifyContent: "center",
  },

  eventModalContainer: { flex: 1, backgroundColor: "#f6f8fc" },
  eventModalContainerDark: { backgroundColor: "#0b1220" },
  eventModalSkeleton: {},
  eventModalSkeletonTitleWrap: {
    position: "absolute",
    left: 20,
    right: 20,
    bottom: 28,
  },
  eventModalSkeletonTitle: {
    color: "#ffffff",
    fontSize: 28,
    fontWeight: "900",
    letterSpacing: -0.6,
    lineHeight: 34,
  },
  eventModalSkeletonSub: {
    color: "rgba(255,255,255,0.82)",
    fontSize: 14,
    fontWeight: "700",
    marginTop: 8,
    letterSpacing: 0.2,
  },
  eventModalSkeletonBody: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 40,
  },

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
  eventWhenIconGlyph: { width: 24, textAlign: "center" },
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
  eventInfoIconGlyph: { width: 24, textAlign: "center" },
  eventInfoTitle: { color: "#1b2333", fontSize: 14, fontWeight: "800" },
  eventInfoSub: { color: "#6b7894", fontSize: 12, marginTop: 2, fontWeight: "600" },
  eventInfoChevron: { color: "#b0b9cf", fontSize: 24, fontWeight: "700", marginLeft: 4 },

  eventDescText: { color: "#34405a", fontSize: 15, lineHeight: 22, fontWeight: "500" },
  eventDescToggleBtn: {
    marginTop: 8,
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minWidth: 176,
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "#eaf2ff",
    borderWidth: 1,
    borderColor: "#cfdcf7",
    shadowColor: "#2e4f82",
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 1,
  },
  eventDescToggleBtnDark: { backgroundColor: "#1c2a44", borderColor: "#355180" },
  eventDescToggleLead: { flexDirection: "row", alignItems: "center", gap: 6 },
  eventDescToggle: { color: "#2e4f82", fontSize: 13, fontWeight: "900" },

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
  eventLinkIconGlyph: { width: 24, textAlign: "center" },
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
  eventTrustBreakdownRow: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 6, marginBottom: 2 },
  eventTrustBreakdownChip: { paddingHorizontal: 9, paddingVertical: 5, borderRadius: 999, borderWidth: 1 },
  eventTrustBreakdownChipOk: { backgroundColor: "#edf8f2", borderColor: "#b8dfc8" },
  eventTrustBreakdownChipWarn: { backgroundColor: "#fff3e9", borderColor: "#f0c8aa" },
  eventTrustBreakdownChipText: { fontSize: 11, fontWeight: "700" },
  eventTrustBreakdownChipTextOk: { color: "#267448" },
  eventTrustBreakdownChipTextWarn: { color: "#9a4e19" },
  eventTrustChip: {
    flex: 1,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: "#f4f6fb",
    borderWidth: 1,
    borderColor: "#e0e5ef",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
  },
  eventTrustChipIcon: { width: 14, height: 14 },
  eventTrustChipActive: { backgroundColor: "#1c4f82", borderColor: "#1c4f82" },
  eventTrustChipText: { color: "#34405a", fontSize: 12, lineHeight: 14, fontWeight: "700", includeFontPadding: false },
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
  homeHeroHi: { color: "#fff", fontSize: 14, fontWeight: "700", letterSpacing: 0.2 },
  homeHeroCount: { color: "#fff", fontSize: 34, fontWeight: "900", letterSpacing: -0.8, marginTop: 2 },
  homeHeroSub: { color: "rgba(255,255,255,0.9)", fontSize: 13, fontWeight: "600", marginTop: 2 },
  homeHeroStatus: { color: "rgba(255,255,255,0.82)", fontSize: 12, fontWeight: "700", marginTop: 6 },
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
  nearestMasjidCard: {
    backgroundColor: "#fff5ef",
    borderColor: "#ffd3bd",
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
  },
  nearestMasjidCardDark: {
    backgroundColor: "#1f2335",
    borderColor: "#354165",
  },
  nearestMasjidRow: { flexDirection: "row", alignItems: "center", gap: 12 },
  nearestMasjidPin: { fontSize: 22 },
  nearestMasjidName: { fontSize: 16, fontWeight: "800", color: "#1f2a3d" },
  nearestMasjidMeta: { fontSize: 12, color: "#6b7894", marginTop: 2, fontWeight: "600" },
  homeSectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  homeSectionHeaderRight: { flexDirection: "row", alignItems: "center", gap: 10 },
  homeSectionTitle: { fontSize: 18, fontWeight: "900", color: "#1f2a3d", letterSpacing: -0.2 },
  homeSectionSub: { fontSize: 13, color: "#6b7894", marginTop: 2, marginBottom: 8, fontStyle: "italic" },

  sadaqahCard: {
    marginTop: 16,
    marginHorizontal: 16,
    padding: 16,
    borderRadius: 22,
    backgroundColor: "#fff8f0",
    borderWidth: 1,
    borderColor: "#ffd4b2",
    shadowColor: "#ff7a3c",
    shadowOffset: { width: 0, height: 6 },
    shadowRadius: 14,
    shadowOpacity: 0.08,
    elevation: 2,
  },
  sadaqahIcon: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: "#ff7a3c",
    alignItems: "center", justifyContent: "center",
  },
  sadaqahIconText: { color: "#fff", fontSize: 20, fontWeight: "900" },
  sadaqahTitle: { fontSize: 17, fontWeight: "900", color: "#1f2a3d", letterSpacing: -0.2 },
  sadaqahSub: { fontSize: 12, color: "#8b6a55", marginTop: 1 },
  sadaqahBody: { fontSize: 13.5, color: "#4a3a2d", lineHeight: 19, marginTop: 4 },
  sadaqahBtn: {
    marginTop: 12,
    alignSelf: "flex-start",
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 14,
    backgroundColor: "#ff7a3c",
  },
  sadaqahBtnText: { color: "#fff", fontWeight: "900", fontSize: 14, letterSpacing: 0.2 },

  // Share Masjid.ly / raffle card. Purple-leaning palette so it reads as
  // a reward-flavored section and doesn't compete visually with Sadaqah.
  shareCard: {
    marginTop: 14,
    marginHorizontal: 16,
    padding: 16,
    borderRadius: 22,
    backgroundColor: "#f4efff",
    borderWidth: 1,
    borderColor: "#d7c9ff",
    shadowColor: "#6d4ddc",
    shadowOffset: { width: 0, height: 6 },
    shadowRadius: 14,
    shadowOpacity: 0.09,
    elevation: 2,
  },
  shareCardIcon: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: "#6d4ddc",
    alignItems: "center", justifyContent: "center",
  },
  shareCardIconText: { color: "#fff", fontSize: 20, fontWeight: "900" },
  shareCardTitle: { fontSize: 17, fontWeight: "900", color: "#26173e", letterSpacing: -0.2 },
  shareCardSub: { fontSize: 12, color: "#6b5a8e", marginTop: 1 },
  shareCardBody: { fontSize: 13.5, color: "#3b2c5c", lineHeight: 19, marginTop: 6 },
  shareCodePill: {
    marginTop: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e1d6ff",
  },
  shareCodePillLabel: { fontSize: 10, fontWeight: "900", color: "#6d4ddc", letterSpacing: 1 },
  shareCodePillValue: {
    flex: 1,
    fontSize: 18,
    fontWeight: "900",
    color: "#26173e",
    letterSpacing: 1.2,
  },
  shareCodeCopyBtn: {
    paddingHorizontal: 14,
    paddingVertical: 7,
    borderRadius: 10,
    backgroundColor: "#6d4ddc",
  },
  shareCodeCopyBtnText: { color: "#fff", fontWeight: "900", fontSize: 12.5, letterSpacing: 0.4 },
  shareStatsRow: {
    flexDirection: "row",
    gap: 10,
    marginTop: 12,
  },
  shareStatChip: {
    flex: 1,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 14,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#e1d6ff",
    alignItems: "flex-start",
  },
  shareStatChipNum: { fontSize: 20, fontWeight: "900", color: "#26173e" },
  shareStatChipLabel: { fontSize: 11.5, fontWeight: "700", color: "#6b5a8e", marginTop: 2 },
  shareCardBtn: {
    marginTop: 12,
    alignSelf: "flex-start",
    paddingHorizontal: 18,
    paddingVertical: 11,
    borderRadius: 14,
    backgroundColor: "#6d4ddc",
  },
  shareCardBtnText: { color: "#fff", fontWeight: "900", fontSize: 14, letterSpacing: 0.2 },
  shareReferredBox: {
    marginTop: 14,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: "#e1d6ff",
  },
  shareReferredLabel: { fontSize: 12, fontWeight: "900", color: "#26173e", letterSpacing: 0.3 },
  shareReferredValue: { fontSize: 16, fontWeight: "900", color: "#6d4ddc", letterSpacing: 1, marginTop: 4 },
  shareReferredHint: { fontSize: 11.5, color: "#6b5a8e", marginTop: 6, lineHeight: 16 },
  shareReferredInputRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginTop: 8,
  },
  shareReferredInput: {
    flex: 1,
    backgroundColor: "#ffffff",
    borderWidth: 1,
    borderColor: "#d7c9ff",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    fontWeight: "800",
    color: "#26173e",
    letterSpacing: 1,
  },
  shareReferredSubmit: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: "#6d4ddc",
  },
  shareReferredSubmitText: { color: "#fff", fontWeight: "900", fontSize: 13, letterSpacing: 0.4 },
  shareReferredError: { marginTop: 6, color: "#c94620", fontWeight: "700", fontSize: 12 },

  discoverSection: { marginTop: 18, paddingHorizontal: 16 },
  discoverSectionHeader: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  discoverSectionTitle: { fontSize: 18, fontWeight: "900", color: "#1f2a3d", letterSpacing: -0.2 },
  discoverSectionSub: { fontSize: 13, color: "#6b7894", marginTop: 4, marginBottom: 10, lineHeight: 19 },
  discoverSubsectionLabel: {
    fontSize: 12,
    fontWeight: "900",
    color: "#4a5c85",
    letterSpacing: 0.6,
    textTransform: "uppercase",
    marginTop: 4,
    marginBottom: 2,
  },
  discoverSubsectionLabelDark: { color: "#8aa3d4" },
  discoverSeeAll: { fontSize: 13, fontWeight: "800", color: "#4a5c85" },
  discoverFollowedMasjidCard: {
    width: 228,
    padding: 12,
    borderRadius: 16,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#e8ecf4",
    shadowColor: "#1e2942",
    shadowOpacity: 0.07,
    shadowOffset: { width: 0, height: 6 },
    shadowRadius: 12,
    elevation: 2,
  },
  discoverFollowedMasjidCardDark: {
    backgroundColor: "#1a2035",
    borderColor: "#2c3654",
    shadowOpacity: 0.12,
  },
  discoverFollowedMasjidCardTop: { flexDirection: "row", alignItems: "flex-start", gap: 10 },
  discoverFollowedMasjidLogo: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  discoverFollowedMasjidTitle: { fontSize: 14, fontWeight: "900", color: "#1f2a3d", lineHeight: 18 },
  discoverFollowedMasjidMeta: { fontSize: 11.5, color: "#6b7894", marginTop: 4, fontWeight: "600", lineHeight: 15 },
  discoverFollowedMasjidChips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginTop: 10 },
  discoverAmenityChip: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    backgroundColor: "#f0f3fa",
    borderWidth: 1,
    borderColor: "#dce2f0",
  },
  discoverAmenityChipDark: { backgroundColor: "#252b42", borderColor: "#3d4a6b" },
  discoverAmenityChipText: { fontSize: 10.5, fontWeight: "800", color: "#4a5c85", letterSpacing: 0.2 },
  discoverFollowedMasjidBlurb: { fontSize: 11.5, color: "#6b7894", marginTop: 8, lineHeight: 16, fontWeight: "500" },
  discoverFollowedMasjidNext: { fontSize: 11.5, color: "#ff7a3c", marginTop: 8, fontWeight: "800", lineHeight: 16 },
  discoverEmpty: {
    padding: 14, borderRadius: 14, backgroundColor: "#f4f5f9",
    borderWidth: 1, borderColor: "#e4e7ef",
  },
  discoverEmptyDark: { backgroundColor: "#181c2a", borderColor: "#262e44" },
  discoverEmptyText: { color: "#4a5670", fontSize: 13, lineHeight: 19 },

  discoverScholarCard: {
    width: 150, borderRadius: 18, backgroundColor: "#fff",
    borderWidth: 1, borderColor: "#e6e9f2",
    padding: 10, gap: 4,
    shadowColor: "#1e2942",
    shadowOpacity: 0.06, shadowOffset: { width: 0, height: 6 }, shadowRadius: 12,
    elevation: 2,
  },
  discoverScholarCardDark: { backgroundColor: "#1a2035", borderColor: "#2c3654" },
  discoverScholarAvatarWrap: { width: "100%", aspectRatio: 4 / 5, borderRadius: 14, overflow: "hidden", backgroundColor: "#ffd7b8" },
  discoverScholarAvatar: { width: "100%", height: "100%" },
  discoverScholarName: { fontSize: 14, fontWeight: "900", color: "#1f2a3d", marginTop: 6, lineHeight: 18 },
  discoverScholarSub: { fontSize: 11, color: "#6b7894", fontWeight: "600" },
  discoverScholarNext: { fontSize: 11, color: "#ff7a3c", fontWeight: "800" },
  // Follow CTA (scholars). Intentionally loud — this is the #1 action in
  // Discover, so it should feel impossible to miss.
  discoverScholarFollowBtn: {
    marginTop: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 12,
    backgroundColor: "#ff7a3c",
    alignItems: "center",
    shadowColor: "#ff7a3c",
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
    borderWidth: 1,
    borderColor: "#ff9255",
  },
  discoverScholarFollowBtnActive: {
    backgroundColor: "#e7f4ec",
    borderColor: "#a8d9ba",
    shadowOpacity: 0,
    elevation: 0,
  },
  discoverScholarFollowText: { color: "#fff", fontWeight: "900", fontSize: 13.5, letterSpacing: 0.4 },
  discoverScholarFollowTextActive: { color: "#1c7a4a" },

  collectionGrid: { flexDirection: "row", flexWrap: "wrap", gap: 10 },
  collectionTile: {
    width: "48%", borderRadius: 16, padding: 12, minHeight: 92,
    backgroundColor: "#fff", borderWidth: 1, borderColor: "#e6e9f2",
  },
  collectionTileDark: { backgroundColor: "#1a2035", borderColor: "#2c3654" },
  collectionTileTitle: { fontSize: 14, fontWeight: "900", color: "#1f2a3d" },
  collectionTileSub: { fontSize: 11.5, color: "#6b7894", marginTop: 3, lineHeight: 15 },
  collectionTileCount: { fontSize: 11, color: "#ff7a3c", fontWeight: "900", marginTop: 6, letterSpacing: 0.3 },

  discoverMasjidRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    padding: 12, borderRadius: 14, marginBottom: 8,
    backgroundColor: "#fff", borderWidth: 1, borderColor: "#e6e9f2",
  },
  discoverMasjidRowDark: { backgroundColor: "#1a2035", borderColor: "#2c3654" },
  discoverMasjidAvatar: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: "center", justifyContent: "center",
  },
  discoverMasjidAvatarText: { color: "#fff", fontWeight: "900", fontSize: 13 },
  discoverMasjidTitle: { fontSize: 14, fontWeight: "900", color: "#1f2a3d" },
  discoverMasjidSub: { fontSize: 12, color: "#6b7894", marginTop: 2 },
  // Follow CTA (masjids). Same aggressive visual weight as scholar Follow.
  discoverFollowBtn: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 12,
    backgroundColor: "#ff7a3c",
    shadowColor: "#ff7a3c",
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
    borderWidth: 1,
    borderColor: "#ff9255",
  },
  discoverFollowText: { color: "#fff", fontWeight: "900", fontSize: 13.5, letterSpacing: 0.4 },
  // Green "Following" state mirrors the scholar Follow button active state
  // so the two Follow rails in Discover feel like the same control.
  discoverFollowBtnActive: {
    backgroundColor: "#2ea56f",
    borderColor: "#6cd9a5",
    shadowColor: "#2ea56f",
  },
  discoverFollowTextActive: { color: "#fff" },

  masjidHeroCard: {
    padding: 14, borderRadius: 16, marginBottom: 10,
    backgroundColor: "#fff8f0", borderWidth: 1, borderColor: "#ffe0c5",
  },
  masjidHeroLine: { fontSize: 14, fontWeight: "900", color: "#6b3a19", lineHeight: 20 },
  masjidHeroNext: { marginTop: 6, fontSize: 13, color: "#8a4b22", lineHeight: 18, fontWeight: "600" },
  masjidHeroDirectionsBtn: {
    marginTop: 10, alignSelf: "flex-start",
    paddingHorizontal: 14, paddingVertical: 9, borderRadius: 11,
    backgroundColor: "#ff7a3c",
  },
  masjidHeroDirectionsText: { color: "#fff", fontWeight: "900", fontSize: 13, letterSpacing: 0.2 },

  calendarMyPlanHint: {
    marginHorizontal: 16, marginTop: 10, padding: 10,
    borderRadius: 10, backgroundColor: "#fff1e2", borderWidth: 1, borderColor: "#ffd4af",
  },
  calendarMyPlanHintText: { fontSize: 12.5, color: "#7a4416", fontWeight: "700" },

  knowledgePlanCard: {
    backgroundColor: "#ffffff",
    borderRadius: 20,
    marginHorizontal: 16,
    marginTop: 14,
    marginBottom: 4,
    paddingVertical: 16,
    paddingHorizontal: 16,
    gap: 12,
    shadowColor: "#1c2545",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.08,
    shadowRadius: 14,
    elevation: 3,
    borderWidth: 1,
    borderColor: "rgba(28, 37, 69, 0.06)",
  },
  knowledgePlanCardDark: {
    backgroundColor: "#141a2b",
    borderColor: "rgba(255,255,255,0.06)",
  },
  knowledgePlanHeaderRow: { flexDirection: "row", alignItems: "flex-start", gap: 12 },
  knowledgePlanKicker: {
    fontSize: 11,
    fontWeight: "800",
    color: "#c15a1d",
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  knowledgePlanTitle: {
    fontSize: 20,
    fontWeight: "800",
    color: "#1c2545",
    marginTop: 2,
  },
  knowledgePlanSub: {
    fontSize: 13,
    color: "#495067",
    marginTop: 4,
    lineHeight: 18,
  },
  knowledgePlanTile: {
    width: 230,
    borderRadius: 18,
    padding: 16,
    gap: 8,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.16,
    shadowRadius: 10,
    elevation: 4,
  },
  knowledgePlanGlyphRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 2,
  },
  knowledgePlanGlyph: {
    fontSize: 28,
    color: "#ffffff",
    fontWeight: "900",
    includeFontPadding: false,
    textShadowColor: "rgba(0,0,0,0.18)",
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 2,
  },
  knowledgePlanChipCount: {
    backgroundColor: "rgba(255,255,255,0.22)",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
  },
  knowledgePlanChipCountText: {
    color: "#ffffff",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.3,
  },
  knowledgePlanTileTitle: {
    color: "#ffffff",
    fontSize: 17,
    fontWeight: "800",
    lineHeight: 22,
  },
  knowledgePlanTileSub: {
    color: "rgba(255,255,255,0.88)",
    fontSize: 12.5,
    lineHeight: 17,
  },
  knowledgePlanTileSpan: {
    color: "rgba(255,255,255,0.82)",
    fontSize: 11.5,
    fontWeight: "700",
    marginTop: 4,
    letterSpacing: 0.3,
  },
  knowledgePlanTileCta: {
    marginTop: 8,
    alignSelf: "flex-start",
    backgroundColor: "rgba(255,255,255,0.22)",
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
  },
  knowledgePlanTileCtaText: {
    color: "#ffffff",
    fontSize: 12.5,
    fontWeight: "800",
    letterSpacing: 0.2,
  },

  knowledgePlanModalHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
    paddingHorizontal: 20,
    paddingVertical: 20,
    borderBottomLeftRadius: 20,
    borderBottomRightRadius: 20,
  },
  knowledgePlanModalKicker: {
    color: "rgba(255,255,255,0.82)",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1.3,
    textTransform: "uppercase",
  },
  knowledgePlanModalTitle: {
    color: "#ffffff",
    fontSize: 24,
    fontWeight: "900",
    marginTop: 4,
  },
  knowledgePlanModalSub: {
    color: "rgba(255,255,255,0.88)",
    fontSize: 13.5,
    marginTop: 6,
    lineHeight: 19,
  },
  knowledgePlanModalClose: {
    backgroundColor: "rgba(255,255,255,0.22)",
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: 999,
  },
  knowledgePlanModalCloseText: { color: "#ffffff", fontWeight: "800", fontSize: 12.5 },
  knowledgePlanBanner: {
    backgroundColor: "#fff5ea",
    borderRadius: 14,
    padding: 14,
    gap: 6,
  },
  knowledgePlanBannerTitle: {
    fontSize: 13,
    fontWeight: "800",
    color: "#7a4416",
    letterSpacing: 0.3,
  },
  knowledgePlanBannerSub: {
    fontSize: 12.5,
    color: "#6b4a2a",
    lineHeight: 17,
  },
  knowledgePlanStep: {
    flexDirection: "row",
    gap: 12,
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 12,
    shadowColor: "#1c2545",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.05,
    shadowRadius: 6,
    elevation: 1,
  },
  knowledgePlanStepNumber: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
  },
  knowledgePlanStepNumberText: {
    color: "#ffffff",
    fontWeight: "900",
    fontSize: 13,
  },
  knowledgePlanStepWhen: {
    fontSize: 11.5,
    color: "#6b7390",
    fontWeight: "700",
    letterSpacing: 0.3,
    textTransform: "uppercase",
  },
  knowledgePlanStepTitle: {
    fontSize: 15,
    fontWeight: "800",
    color: "#1c2545",
  },
  knowledgePlanStepWho: {
    fontSize: 12.5,
    color: "#495067",
  },
  knowledgePlanStepPoster: {
    width: 54,
    height: 54,
    borderRadius: 10,
    alignSelf: "center",
    backgroundColor: "#e6eaf4",
  },

  whosGoingAvatars: { flexDirection: "row", alignItems: "center" },
  whosGoingAvatar: {
    width: 28, height: 28, borderRadius: 14,
    alignItems: "center", justifyContent: "center",
    borderWidth: 2, borderColor: "#fff",
  },
  whosGoingAvatarText: { color: "#fff", fontWeight: "900", fontSize: 11, letterSpacing: 0.2 },

  discoverFollowedScholarsCard: {
    marginTop: 16, marginHorizontal: 16, padding: 14,
    borderRadius: 18, backgroundColor: "#fff8f0",
    borderWidth: 1, borderColor: "#ffd4b2",
  },
  discoverFollowedScholarsTitle: { fontSize: 15, fontWeight: "900", color: "#6b3a19", letterSpacing: -0.1 },
  discoverFollowedScholarsSub: { fontSize: 12, color: "#8a4b22", marginTop: 2, marginBottom: 10 },
  discoverFollowedScholarsRow: {
    paddingVertical: 8, borderTopWidth: 1, borderTopColor: "#ffe0c5",
  },
  discoverFollowedScholarsRowWho: { fontSize: 13, fontWeight: "900", color: "#1f2a3d" },
  discoverFollowedScholarsRowWhat: { fontSize: 13.5, color: "#3a4560", marginTop: 2, lineHeight: 18 },
  discoverFollowedScholarsRowWhen: { fontSize: 11, color: "#8a4b22", fontWeight: "700", marginTop: 3 },
  homeSectionCount: { fontSize: 12, color: "#6b7894", fontWeight: "700" },
  homeSectionSeeAll: { color: "#2e4f82", fontWeight: "800", fontSize: 12 },
  imageLoadContainer: {
    overflow: "hidden",
  },
  imageLoadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.22)",
  },

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
  liveNowBadge: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#ff2d55",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    marginRight: 6,
    marginBottom: 2,
  },
  liveNowDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: "#fff",
    marginRight: 5,
  },
  liveNowText: {
    color: "#fff",
    fontWeight: "900",
    fontSize: 9.5,
    letterSpacing: 0.6,
  },
  eventStartsSoonBadge: {
    backgroundColor: "#f48725",
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 8,
    marginRight: 6,
    marginBottom: 2,
  },
  eventStartsSoonText: {
    color: "#fff",
    fontWeight: "900",
    fontSize: 9.5,
    letterSpacing: 0.45,
  },
  eventPastBadge: {
    backgroundColor: "#3c465c",
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 8,
    marginRight: 6,
    marginBottom: 2,
  },
  eventPastText: {
    color: "#fff",
    fontWeight: "900",
    fontSize: 11,
    letterSpacing: 0.55,
  },
  homeEventRowTitle: { color: "#1b2333", fontWeight: "800", fontSize: 15, marginTop: 2, letterSpacing: -0.2 },
  homeEventRowMeta: { color: "#6b7894", fontSize: 12, marginTop: 2 },

  // Redesigned filters modal
  filtersHeaderSub: { color: "#6b7894", fontSize: 12, fontWeight: "600", marginTop: 2 },
  filtersResetPill: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: "#fff0ea",
    marginRight: 10,
  },
  filtersResetPillText: { color: "#c94620", fontWeight: "800", fontSize: 12, letterSpacing: 0.2 },
  filtersScrollBody: { padding: 16, gap: 12 },
  filtersCard: {
    backgroundColor: "#ffffff",
    borderRadius: 16,
    padding: 16,
    borderWidth: 1,
    borderColor: "#ebeef5",
    shadowColor: "#1b2333",
    shadowOpacity: 0.04,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  filtersCardDark: { backgroundColor: "#121a29", borderColor: "#22304d" },
  filtersCardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "baseline",
    marginBottom: 12,
  },
  filtersCardTitle: { color: "#1b2333", fontSize: 15, fontWeight: "900", letterSpacing: -0.1 },
  filtersCardSub: { color: "#8b96af", fontSize: 12, fontWeight: "600" },
  filtersChipRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  filtersChip: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 18,
    backgroundColor: "#f4f6fb",
    borderWidth: 1,
    borderColor: "#e5e8ef",
  },
  filtersChipDark: { backgroundColor: "#1a2437", borderColor: "#263450" },
  filtersChipActive: { backgroundColor: "#1b2333", borderColor: "#1b2333" },
  filtersChipActiveDark: { backgroundColor: "#4a79ff", borderColor: "#4a79ff" },
  filtersChipText: { color: "#1b2333", fontSize: 13, fontWeight: "700" },
  filtersChipTextDark: { color: "#c4cee8" },
  filtersChipTextActive: { color: "#ffffff" },
  filtersChipGhost: {
    backgroundColor: "transparent",
    borderColor: "#c94620",
    borderStyle: "dashed",
  },
  filtersChipGhostText: { color: "#c94620", fontWeight: "800" },
  filtersSearchInput: {
    backgroundColor: "#f4f6fb",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#e5e8ef",
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 15,
    color: "#1b2333",
  },
  filtersSearchInputDark: {
    backgroundColor: "#0c1424",
    borderColor: "#263450",
    color: "#f4f7ff",
  },
  filtersInputLabel: { color: "#6b7894", fontSize: 11, fontWeight: "700", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.6 },
  filtersSavePresetBtn: {
    backgroundColor: "#1b2333",
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
  },
  filtersSavePresetText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  filtersStickyApplyWrap: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 16,
    paddingTop: 12,
    backgroundColor: "rgba(255,255,255,0.95)",
    borderTopWidth: 1,
    borderTopColor: "#ebeef5",
  },
  filtersStickyApplyWrapDark: {
    backgroundColor: "rgba(12,20,36,0.96)",
    borderTopColor: "#22304d",
  },
  filtersApplyBtn: {
    backgroundColor: "#1b2333",
    paddingVertical: 16,
    borderRadius: 14,
    alignItems: "center",
    shadowColor: "#1b2333",
    shadowOpacity: 0.2,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  filtersApplyBtnText: { color: "#fff", fontSize: 16, fontWeight: "900", letterSpacing: 0.2 },

  sheetEventRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#ebeef5",
    padding: 12,
    gap: 8,
  },
  sheetEventRowDark: { backgroundColor: "#121a29", borderColor: "#22304d" },
  sheetEventWhen: { color: "#ff7d50", fontWeight: "800", fontSize: 11 },
  sheetEventTitle: { color: "#1b2333", fontWeight: "800", fontSize: 14, marginTop: 3, letterSpacing: -0.1 },
  sheetEventChevron: { color: "#b4bdd1", fontSize: 26, fontWeight: "300", marginLeft: 6 },

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
  locPromptCard: {
    marginHorizontal: 16,
    marginTop: 12,
    padding: 14,
    backgroundColor: "#f2f5fb",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "#dfe4ef",
    gap: 10,
  },
  locPromptCardDark: {
    backgroundColor: "#161a26",
    borderColor: "#242b3b",
  },
  locPromptTitle: { fontSize: 15, fontWeight: "800", color: "#15203b", letterSpacing: -0.2 },
  locPromptSub: { fontSize: 13, color: "#5a6679", marginTop: 2 },
  locPromptBtnRow: { flexDirection: "row", gap: 8, marginTop: 6 },
  locPromptPrimaryBtn: {
    flex: 1,
    backgroundColor: "#2a63ff",
    borderRadius: 10,
    paddingVertical: 10,
    alignItems: "center",
  },
  locPromptPrimaryBtnText: { color: "#fff", fontSize: 14, fontWeight: "800" },
  locPromptSecondaryBtn: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
    backgroundColor: "transparent",
    alignItems: "center",
    justifyContent: "center",
  },
  locPromptSecondaryBtnText: { color: "#5a6679", fontSize: 14, fontWeight: "700" },
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
  exploreLoadMoreBtn: {
    alignSelf: "center",
    marginTop: 8,
    marginBottom: 18,
    paddingHorizontal: 22,
    paddingVertical: 12,
    borderRadius: 999,
    backgroundColor: "#173664",
  },
  exploreLoadMoreBtnText: { color: "#ffffff", fontWeight: "800", fontSize: 14, letterSpacing: 0.2 },
  exploreSectionHeader: { paddingHorizontal: 12, paddingTop: 6, paddingBottom: 6 },
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
  pastTalksHeaderRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 18,
    marginBottom: 4,
  },
  pastTalksHeader: {
    fontSize: 14,
    fontWeight: "800",
    color: "#222a3f",
    letterSpacing: 0.2,
  },
  videoCard: {
    flexDirection: "row",
    gap: 12,
    padding: 10,
    borderRadius: 14,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#eceff9",
    alignItems: "center",
  },
  videoThumb: {
    width: 120,
    height: 68,
    borderRadius: 10,
    backgroundColor: "#16131f",
  },
  videoTitle: {
    fontSize: 13,
    fontWeight: "700",
    color: "#222a3f",
    lineHeight: 17,
  },
  videoMeta: {
    marginTop: 3,
    fontSize: 11,
    color: "#6f7b94",
  },
  amenitiesCard: {
    padding: 14,
    borderRadius: 16,
    backgroundColor: "#f4f9f1",
    borderWidth: 1,
    borderColor: "#d5e4cb",
    gap: 10,
    marginTop: 8,
  },
  amenitiesTitle: {
    fontSize: 14,
    fontWeight: "800",
    color: "#27451d",
  },
  amenitiesBody: {
    fontSize: 13,
    color: "#3c5a30",
    lineHeight: 18,
  },
  amenitiesGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  amenitiesChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: "#fff",
    borderWidth: 1,
    borderColor: "#d5e4cb",
  },
  amenitiesChipCheck: {
    color: "#2f7a1c",
    fontWeight: "800",
    fontSize: 12,
  },
  amenitiesChipText: {
    color: "#27451d",
    fontWeight: "700",
    fontSize: 12,
  },
  amenitiesContactRow: {
    flexDirection: "row",
    gap: 16,
    marginTop: 2,
  },
  amenitiesContactLink: {
    color: "#235ea8",
    fontWeight: "700",
    fontSize: 13,
  },
  topicChip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 999,
    borderWidth: 1,
    borderColor: "#e4e9f4",
    backgroundColor: "#ffffff",
    shadowColor: "#0a1f3f",
    shadowOpacity: 0.04,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 1,
  },
  topicChipActive: {
    borderColor: "#ff7d50",
    backgroundColor: "#ff7d50",
    shadowColor: "#ff7d50",
    shadowOpacity: 0.28,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 3,
  },
  topicChipText: {
    fontSize: 13,
    fontWeight: "700",
    color: "#4a556a",
    letterSpacing: 0.1,
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
  cardActionChipPressed: { opacity: 0.7, transform: [{ scale: 0.94 }] },
  settingsVersionRow: {
    alignItems: "center",
    paddingVertical: 22,
  },
  settingsVersionText: {
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 0.5,
    color: "#8793ab",
    textTransform: "uppercase",
  },

  // iOS-style grouped Settings list
  settingsScrollBody: {
    padding: 16,
    paddingTop: 8,
    backgroundColor: "#f3f5fa",
  },
  settingsScrollBodyDark: { backgroundColor: "#070b14" },
  settingsProfileHero: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#ffffff",
    borderRadius: 20,
    padding: 18,
    marginBottom: 16,
    gap: 14,
    borderWidth: 1,
    borderColor: "#ebeef5",
    shadowColor: "#1b2333",
    shadowOpacity: 0.06,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 2,
  },
  settingsProfileHeroDark: {
    backgroundColor: "#121a29",
    borderColor: "#22304d",
  },
  settingsProfileAvatar: {
    width: 62,
    height: 62,
    borderRadius: 31,
    backgroundColor: "#1b2333",
    alignItems: "center",
    justifyContent: "center",
  },
  settingsProfileAvatarText: { color: "#fff", fontSize: 24, fontWeight: "900" },
  settingsProfileName: { color: "#1b2333", fontSize: 18, fontWeight: "900", letterSpacing: -0.2 },
  settingsProfileSub: { color: "#7a859b", fontSize: 13, marginTop: 2 },
  settingsProfileMetaRow: { flexDirection: "row", gap: 6, marginTop: 8, flexWrap: "wrap" },
  settingsProfileMetaChip: {
    backgroundColor: "#f4f6fb",
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "#e5e8ef",
  },
  settingsProfileMetaChipText: { color: "#4a5568", fontSize: 11, fontWeight: "800" },
  settingsQuickTabsRow: {
    marginTop: 10,
    marginBottom: 2,
    marginHorizontal: 16,
    flexDirection: "row",
    gap: 8,
  },
  settingsQuickTabBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 7,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#d7e2f3",
    backgroundColor: "#eef4ff",
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  settingsQuickTabBtnDark: {
    backgroundColor: "#16233a",
    borderColor: "#2c446b",
  },
  settingsQuickTabBtnPressed: {
    opacity: 0.82,
    transform: [{ scale: 0.98 }],
  },
  settingsQuickTabText: {
    color: "#2d4066",
    fontSize: 13,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  settingsQuickTabTextDark: {
    color: "#d9e4ff",
  },
  settingsSectionLabel: {
    color: "#7a859b",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 0.8,
    marginLeft: 14,
    marginBottom: 8,
    marginTop: 10,
  },
  settingsSectionCard: {
    backgroundColor: "#ffffff",
    borderRadius: 14,
    borderWidth: 1,
    borderColor: "#ebeef5",
    overflow: "hidden",
    marginBottom: 6,
  },
  settingsSectionCardDark: { backgroundColor: "#121a29", borderColor: "#22304d" },
  settingsRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 14,
    paddingVertical: 14,
    gap: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "#ebeef5",
  },
  settingsRowDark: { borderBottomColor: "#22304d" },
  settingsRowLast: { borderBottomWidth: 0 },
  settingsRowIcon: {
    width: 30,
    height: 30,
    borderRadius: 8,
    backgroundColor: "#f4f6fb",
    alignItems: "center",
    justifyContent: "center",
  },
  settingsRowIconDark: { backgroundColor: "#1a2437" },
  settingsRowIconText: { fontSize: 15, color: "#4a5568", fontWeight: "900" },
  settingsRowLabel: { fontSize: 15, fontWeight: "700", color: "#1b2333", letterSpacing: -0.1 },
  settingsRowValue: { fontSize: 12, color: "#7a859b", marginTop: 2, fontWeight: "500" },
  settingsRowChevron: { fontSize: 22, fontWeight: "400" },

  // Legal & About
  legalUpdated: { color: "#7a859b", fontSize: 12, fontWeight: "600", marginBottom: 4 },
  legalIntro: { color: "#4a5568", fontSize: 15, lineHeight: 22, fontWeight: "500" },
  legalSectionTitle: { color: "#1b2333", fontSize: 16, fontWeight: "900", marginTop: 16, letterSpacing: -0.1 },
  legalBody: { color: "#4a5568", fontSize: 14, lineHeight: 22 },
  legalBold: { fontWeight: "800", color: "#1b2333" },
  aboutAppName: { color: "#1b2333", fontSize: 24, fontWeight: "900", letterSpacing: -0.4 },
  aboutVersion: { color: "#7a859b", fontSize: 13, fontWeight: "700" },
  aboutTagline: { color: "#4a5568", fontSize: 15, textAlign: "center", lineHeight: 22, paddingHorizontal: 20 },
  aboutFooter: { color: "#8793ab", fontSize: 12, textAlign: "center", lineHeight: 18, marginTop: 16 },

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
  masjidPosterCard: {
    backgroundColor: "#ffffff",
    borderRadius: 22,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "#ebeef5",
    shadowColor: "#0b1220",
    shadowOpacity: 0.12,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 10 },
    elevation: 4,
  },
  masjidPosterCardDark: {
    backgroundColor: "#121a29",
    borderColor: "#22304d",
    shadowOpacity: 0.4,
  },
  masjidPosterImage: {
    width: "100%",
    aspectRatio: 3 / 4,
    backgroundColor: "#e7ecf4",
  },
  masjidPosterImageEmpty: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#eef2f9",
  },
  masjidPosterEmptyEmoji: { fontSize: 56, color: "#a3b0c8" },
  masjidPosterCaption: { padding: 14, gap: 6 },
  masjidPosterCaptionMeta: { flexDirection: "row", alignItems: "center", gap: 6 },
  masjidPosterCaptionDate: { color: "#6b778c", fontSize: 12, fontWeight: "700", letterSpacing: 0.3 },
  masjidPosterCaptionDot: { color: "#6b778c", fontSize: 12, fontWeight: "700" },
  masjidPosterCaptionTime: { color: "#6b778c", fontSize: 12, fontWeight: "700", letterSpacing: 0.3 },
  masjidPosterCaptionTitle: { color: "#1b2333", fontSize: 16, fontWeight: "800", letterSpacing: -0.2 },
  masjidPosterCaptionHint: { marginTop: 2 },
  masjidPosterCaptionHintText: { color: "#8793ab", fontSize: 11, fontWeight: "600", letterSpacing: 0.5 },
});

