import type { PvfRegisteredMod } from "@pvf/pvf-mod";

import { STACKABLE_PATHS } from "./constants.ts";
import { createChoroPartsetSkillUpMod } from "./mod.ts";
import type {
  ChoroPartsetSkillUpModSummary,
  GeneratedSupportFile,
  SkippedSupportFile,
} from "./types.ts";

export const CHORO_PARTSET_SKILL_UP_MOD_ID = "2_3_choro_partset_skill_up";
export const choroPartsetSkillUpModDefinition: PvfRegisteredMod<
  undefined,
  ChoroPartsetSkillUpModSummary
> = {
  id: CHORO_PARTSET_SKILL_UP_MOD_ID,
  description: "Generates merged 3/6/9 piece Choro support items from existing partset data.",
  create() {
    return createChoroPartsetSkillUpMod();
  },
};

export { createChoroPartsetSkillUpMod, STACKABLE_PATHS };
export type { ChoroPartsetSkillUpModSummary, GeneratedSupportFile, SkippedSupportFile };
