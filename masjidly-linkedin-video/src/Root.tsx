import "./index.css";
import { Composition } from "remotion";
import { MasjidlyLinkedIn } from "./MasjidlyLinkedIn";

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="MasjidlyLinkedIn"
        component={MasjidlyLinkedIn}
        durationInFrames={450}
        fps={30}
        width={1920}
        height={1080}
      />
    </>
  );
};
