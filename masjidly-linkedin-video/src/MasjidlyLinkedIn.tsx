import {
  AbsoluteFill,
  interpolate,
  Sequence,
  spring,
  useCurrentFrame,
  useVideoConfig,
  Img,
  staticFile,
} from "remotion";

const BRAND = {
  cream: "#fff7f0",
  deep: "#0c1018",
  accent2: "#ff8c4a",
};

/** iPhone-sized PNGs from store-screenshots-1284x2778 (see public/screenshots/) */
const SHOTS = {
  introBg: "screenshots/shot08.png",
  heroPhone: "screenshots/shot01.png",
  row1: "screenshots/shot02.png",
  row2: "screenshots/shot03.png",
  row3: "screenshots/shot04.png",
  ctaBg: "screenshots/shot05.png",
} as const;

const PhoneFrame: React.FC<{
  children: React.ReactNode;
  scale?: number;
  w?: number;
  h?: number;
}> = ({ children, scale = 1, w = 280, h = 580 }) => (
  <div
    style={{
      width: w,
      height: h,
      borderRadius: 36,
      border: "3px solid rgba(255,255,255,0.22)",
      boxShadow: "0 32px 80px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(255,255,255,0.06)",
      overflow: "hidden",
      background: "#0e1219",
      transform: `scale(${scale})`,
    }}
  >
    {children}
  </div>
);

const ScreenshotFill: React.FC<{ src: string }> = ({ src }) => (
  <Img
    src={staticFile(src)}
    style={{
      width: "100%",
      height: "100%",
      objectFit: "cover",
      objectPosition: "center top",
    }}
  />
);

const Ambient: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sweep = interpolate(frame, [0, 120], [0, 1], { extrapolateRight: "clamp" });
  const glow = 0.35 + 0.25 * Math.sin((frame / fps) * Math.PI * 0.4);
  return (
    <>
      <div
        style={{
          position: "absolute",
          left: "8%",
          top: "12%",
          width: 420,
          height: 420,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${BRAND.accent2}22 0%, transparent 70%)`,
          filter: "blur(40px)",
          opacity: glow,
        }}
      />
      <div
        style={{
          position: "absolute",
          right: "5%",
          bottom: "8%",
          width: 500,
          height: 500,
          borderRadius: "50%",
          background: "radial-gradient(circle, #4a6fff18 0%, transparent 65%)",
          filter: "blur(48px)",
          opacity: 0.5 + 0.2 * sweep,
        }}
      />
    </>
  );
};

const SceneIntro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const logoPop = spring({ frame, fps, config: { damping: 12, stiffness: 100 } });
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      }}
    >
      {/* Blurred real app UI — no stock photography */}
      <AbsoluteFill style={{ zIndex: 0 }}>
        <Img
          src={staticFile(SHOTS.introBg)}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            objectPosition: "center",
            filter: "blur(28px) saturate(1.1)",
            transform: "scale(1.08)",
          }}
        />
        <AbsoluteFill
          style={{
            background: "linear-gradient(135deg, rgba(12,16,24,0.88) 0%, rgba(30,42,68,0.78) 50%, rgba(45,32,20,0.85) 100%)",
          }}
        />
      </AbsoluteFill>
      <div style={{ textAlign: "center" as const, padding: 24, zIndex: 1, position: "relative" }}>
        <div
          style={{
            display: "inline-block",
            transform: `scale(${0.7 + 0.3 * logoPop}) translateY(${interpolate(logoPop, [0, 1], [24, 0])}px)`,
            marginBottom: 20,
          }}
        >
          <Img
            src={staticFile("icon.png")}
            style={{ width: 120, height: 120, borderRadius: 28 }}
          />
        </div>
        <h1
          style={{
            margin: 0,
            fontSize: 72,
            fontWeight: 800,
            letterSpacing: "-0.03em",
            color: BRAND.cream,
            textShadow: "0 4px 32px rgba(0,0,0,0.35)",
          }}
        >
          Masjidly
        </h1>
        <p
          style={{
            marginTop: 16,
            fontSize: 34,
            fontWeight: 500,
            color: "rgba(255,247,240,0.88)",
            maxWidth: 900,
          }}
        >
          Local masjid events — organized.
        </p>
      </div>
    </AbsoluteFill>
  );
};

const ScenePhone: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const sc = spring({ frame, fps, config: { damping: 16, stiffness: 90 } });
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: 48,
          padding: "0 64px",
        }}
      >
        <PhoneFrame scale={interpolate(sc, [0, 1], [0.92, 1])}>
          <ScreenshotFill src={SHOTS.heroPhone} />
        </PhoneFrame>
        <div style={{ maxWidth: 640 }}>
          <h2
            style={{
              margin: 0,
              fontSize: 48,
              fontWeight: 700,
              color: BRAND.cream,
              lineHeight: 1.15,
            }}
          >
            One home for everything happening at the masjid
          </h2>
          <p
            style={{
              marginTop: 20,
              fontSize: 28,
              color: "rgba(255,247,240,0.8)",
              lineHeight: 1.4,
            }}
          >
            This is the real app — the same build users see on their phones: events, maps, and
            reminders in one place.
          </p>
        </div>
      </div>
    </AbsoluteFill>
  );
};

const SceneFeatures: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const items = [
    { shot: SHOTS.row1, t: "Your week", s: "Home & upcoming events" },
    { shot: SHOTS.row2, t: "On the map", s: "Masjids and programs nearby" },
    { shot: SHOTS.row3, t: "Discover", s: "Follow speakers & masjids" },
  ];
  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        alignItems: "center",
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      }}
    >
      <div style={{ textAlign: "center" as const }}>
        <h2
          style={{
            margin: 0,
            fontSize: 44,
            fontWeight: 700,
            color: BRAND.cream,
            marginBottom: 36,
          }}
        >
          Real screens from Masjidly
        </h2>
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            justifyContent: "center",
            gap: 28,
            alignItems: "flex-end",
          }}
        >
          {items.map((item, i) => {
            const s = spring({
              frame: frame - i * 8,
              fps,
              config: { damping: 18, stiffness: 140 },
            });
            return (
              <div
                key={item.t}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  transform: `translateY(${(1 - s) * 40}px)`,
                  opacity: s,
                }}
              >
                <PhoneFrame w={200} h={420}>
                  <ScreenshotFill src={item.shot} />
                </PhoneFrame>
                <div
                  style={{
                    color: BRAND.cream,
                    fontSize: 24,
                    fontWeight: 700,
                    marginTop: 14,
                  }}
                >
                  {item.t}
                </div>
                <div style={{ color: "rgba(255,247,240,0.7)", fontSize: 17, marginTop: 4 }}>
                  {item.s}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </AbsoluteFill>
  );
};

const SceneCta: React.FC = () => {
  return (
    <AbsoluteFill
      style={{
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      }}
    >
      <Img
        src={staticFile(SHOTS.ctaBg)}
        style={{
          width: "100%",
          height: "100%",
          objectFit: "cover",
          objectPosition: "center",
        }}
      />
      <AbsoluteFill
        style={{
          background:
            "linear-gradient(105deg, rgba(8,10,16,0.88) 0%, rgba(12,16,24,0.55) 45%, rgba(20,14,10,0.75) 100%)",
        }}
      />
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <div style={{ textAlign: "center" as const, padding: 32, maxWidth: 960 }}>
          <h2
            style={{
              fontSize: 58,
              fontWeight: 800,
              color: BRAND.cream,
              margin: 0,
              textShadow: "0 2px 24px rgba(0,0,0,0.5)",
            }}
          >
            masjidly.app
          </h2>
          <p
            style={{
              fontSize: 32,
              color: "rgba(255,247,240,0.92)",
              marginTop: 18,
              textShadow: "0 1px 12px rgba(0,0,0,0.4)",
            }}
          >
            Free on the App Store — made for the ummah
          </p>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const MasjidlyLinkedIn: React.FC = () => {
  const { width, height } = useVideoConfig();
  return (
    <AbsoluteFill
      style={{
        width,
        height,
        background: `linear-gradient(135deg, ${BRAND.deep} 0%, #1e2a44 45%, #3d2418 100%)`,
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        overflow: "hidden",
      }}
    >
      <Ambient />
      <Sequence durationInFrames={90}>
        <SceneIntro />
      </Sequence>
      <Sequence from={90} durationInFrames={100}>
        <ScenePhone />
      </Sequence>
      <Sequence from={190} durationInFrames={120}>
        <SceneFeatures />
      </Sequence>
      <Sequence from={310} durationInFrames={140}>
        <SceneCta />
      </Sequence>
    </AbsoluteFill>
  );
};
