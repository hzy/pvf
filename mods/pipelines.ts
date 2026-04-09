import type { PvfPipelineConfig } from "@pvf/pvf-mod";

import { CHORO_PARTSET_SKILL_UP_MOD_ID } from "./2_3_choro_partset_skill_up/src/index.ts";
import { EXAMPLE_WILD_STRAWBERRY_HP_UP_MOD_ID } from "./example_wild_strawberry_hp_up/src/index.ts";
import { SOLDOROS_DOLL_MOD_ID } from "./soldoros_doll/src/index.ts";

export const pipelineDefinitions = [
  {
    id: "wild-strawberry-only",
    description: "Small example pipeline that boosts Wild Strawberry healing from 60 to 600.",
    mods: [
      {
        id: EXAMPLE_WILD_STRAWBERRY_HP_UP_MOD_ID,
      },
    ],
  },
  {
    id: "demo",
    description:
      "Demo multi-mod pipeline: visible strawberry buff first, then the Choro support generator.",
    mods: [
      {
        id: EXAMPLE_WILD_STRAWBERRY_HP_UP_MOD_ID,
      },
      {
        id: SOLDOROS_DOLL_MOD_ID,
      },
      {
        id: CHORO_PARTSET_SKILL_UP_MOD_ID,
      },
    ],
  },
] as const satisfies readonly PvfPipelineConfig[];

export const defaultPipelineId = "demo";

export const pipelineDefinitionsById = new Map<string, PvfPipelineConfig>(
  pipelineDefinitions.map((pipeline) => [pipeline.id, pipeline]),
);
