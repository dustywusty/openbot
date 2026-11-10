import { opendots } from "./opendots";
import { openduet } from "./openduet";
import { openmuse } from "./openmuse";
import { useSkinId } from "./store";
import type { Skin, SkinId } from "./types";

/** The appearance has its own name; the saved default id and product name stay unchanged. */
const openbot: Skin = {
  id: "openbot",
  name: "CopilotKit",
  description: "The standard look, with your conversations in a sidebar.",
  botLook: "orb",
};

/** Keyed by every id in `SKIN_IDS`, so a skin cannot be listed without being registered. */
export const SKINS: Record<SkinId, Skin> = {
  openbot,
  openduet,
  opendots,
  openmuse,
};

export function useActiveSkin(): Skin {
  return SKINS[useSkinId()];
}
