import { createPvfModRegistry } from "@pvf/pvf-mod";

import { choroPartsetSkillUpModDefinition } from "./2_3_choro_partset_skill_up/src/index.ts";
import { exampleWildStrawberryHpUpModDefinition } from "./example_wild_strawberry_hp_up/src/index.ts";
import { soldorosDollModDefinition } from "./soldoros_doll/src/index.ts";

export const modDefinitions = [
  exampleWildStrawberryHpUpModDefinition,
  soldorosDollModDefinition,
  choroPartsetSkillUpModDefinition,
] as const;

export const modRegistry = createPvfModRegistry(modDefinitions);
