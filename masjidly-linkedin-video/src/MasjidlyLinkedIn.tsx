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
  ink: "#1b2333",
  accent: "#e85a24",
  accent2: "#ff8c4a",
};

const PhoneFrame: React.FC<{ children: React.ReactNode; scale?: number }> = ({
  children,
  scale = 1,
}) => (
  <div
    style={{
      width: 280,
      height: 580,
      borderRadius: 36,
      border: "3px solid rgba(255,255,255,0.22)",
      boxShadow: "0 32px 80px rgba(0,0,0,0.45), inset 0 0 0 1px rgba(255,255,255,0.06)",
      overflow: "hidden",
      background: "linear-gradient(180deg, #1a1f2e 0%, #0e1219 100%)",
      transform: `scale(${scale})`,
    }}
  >
    {children}
  </div>
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
      <div style={{ textAlign: "center" as const, padding: 24 }}>
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
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              paddingTop: 64,
              paddingLeft: 20,
              paddingRight: 20,
              minHeight: "100%",
              boxSizing: "border-box",
              background: `linear-gradient(180deg, #e85a24 0%, #c94a1a 35%, #0e1219 35%)`,
            }}
          >
            <Img
              src={staticFile("masjidly3.png")}
              style={{ width: 200, height: 80, objectFit: "contain", marginTop: 8 }}
            />
            <p
              style={{
                color: "rgba(255,255,255,0.95)",
                fontSize: 16,
                textAlign: "center",
                marginTop: 24,
                lineHeight: 1.45,
              }}
            >
              Halaqahs, classes, and community — from masjids you trust.
            </p>
          </div>
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
            Plan your week, see what is on the calendar, and explore nearby — without digging through
            five different social feeds.
          </p>
        </div>
      </div>
    </AbsoluteFill>
  );
};

const SceneFeatures: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
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
            marginBottom: 40,
          }}
        >
          Built for the way you already move
        </h2>
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            justifyContent: "center",
            gap: 32,
          }}
        >
          {[
            { icon: "tabs/home.png", t: "Home", s: "Your week at a glance" },
            { icon: "tabs/map.png", t: "Map", s: "Masjids near you" },
            { icon: "tabs/discover.png", t: "Discover", s: "Speakers and events" },
          ].map((item, i) => {
            const s = spring({
              frame: frame - i * 8,
              fps,
              config: { damping: 18, stiffness: 140 },
            });
            return (
              <div
                key={item.t}
                style={{
                  width: 240,
                  padding: 28,
                  borderRadius: 20,
                  background: "rgba(255,255,255,0.06)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  transform: `translateY(${(1 - s) * 40}px)`,
                  opacity: s,
                }}
              >
                <Img
                  src={staticFile(item.icon)}
                  style={{ width: 56, height: 56, marginBottom: 16 }}
                />
                <div style={{ color: BRAND.cream, fontSize: 26, fontWeight: 700 }}>{item.t}</div>
                <div style={{ color: "rgba(255,247,240,0.7)", fontSize: 19, marginTop: 8 }}>
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
        justifyContent: "center",
        alignItems: "center",
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      }}
    >
      <div style={{ textAlign: "center" as const, padding: 32 }}>
        <h2
          style={{
            fontSize: 56,
            fontWeight: 800,
            color: BRAND.cream,
            margin: 0,
          }}
        >
          masjidly.app
        </h2>
        <p style={{ fontSize: 32, color: "rgba(255,247,240,0.85)", marginTop: 16 }}>
          Free on the App Store — made for the ummah
        </p>
        <div
          style={{
            marginTop: 32,
            display: "flex",
            justifyContent: "center",
            gap: 16,
            opacity: 0.9,
          }}
        >
          {["calendar", "feed", "settings"].map((name) => (
            <Img
              key={name}
              src={staticFile(`tabs/${name}.png`)}
              style={{ width: 44, height: 44, opacity: 0.85 }}
            />
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};

export const MasjidlyLinkedIn: React.FC = () => {
  const { width, height } = useVideoConfig();
  // 15s @ 30fps; LinkedIn-friendly 16:9
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
