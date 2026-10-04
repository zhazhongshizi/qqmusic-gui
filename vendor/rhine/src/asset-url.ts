import cassette from "../assets/archive-cassette.glb?url";
import assembly from "../assets/archive-assembly.glb?url";
export const assetUrl = (path: string) => path.endsWith("archive-assembly.glb") ? assembly : cassette;
