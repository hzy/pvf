import {
  compareArchivePaths,
  getFirstSection,
  replaceTopLevelSection,
  updateListedPathDocument,
} from "@pvf/pvf-mod";
import type { PvfMod, PvfModSession } from "@pvf/pvf-mod";

import {
  EQUIPMENT_LIST_PATH,
  GENERATED_SUPPORT_ID_START,
  SUPPORT_SUMMON_DOLL_NAME,
  SUPPORT_TEMPLATE_PATH,
} from "./constants.ts";
import {
  loadClassPartsets,
  loadEquipmentPathById,
  loadPartsetNameByPath,
  loadPartsetPathByIndex,
  loadSkillEntryBlocksByPartset,
  loadSupportPathsByClass,
  tryFindAiCharacterByName,
} from "./data.ts";
import {
  buildExplainText,
  buildGeneratedSupportName,
  buildGeneratedSupportPath,
  buildSupportSummonSections,
  createSingleStringSection,
  dedupeSkillEntryBlocks,
  mergeSkillDataUpBlocks,
  replaceTopLevelExplain,
  replaceTopLevelSkillDataUp,
  sortGeneratedSupportFiles,
  sortSkippedSupportFiles,
} from "./transform.ts";
import type {
  ChoroPartsetSkillUpModSummary,
  GeneratedSupportFile,
  SkippedSupportFile,
} from "./types.ts";

export function createChoroPartsetSkillUpMod(): PvfMod<ChoroPartsetSkillUpModSummary> {
  return {
    id: "2_3_choro_partset_skill_up",
    async apply(session: PvfModSession): Promise<ChoroPartsetSkillUpModSummary> {
      const equipmentPathById = await loadEquipmentPathById(session);
      const partsetPathByIndex = await loadPartsetPathByIndex(session);
      const classPartsets = await loadClassPartsets(
        session,
        equipmentPathById,
        partsetPathByIndex,
      );
      const supportPathsByClass = await loadSupportPathsByClass(
        session,
        equipmentPathById,
      );

      const allPartsets = [
        ...new Set(Array.from(classPartsets.values()).flat()),
      ].sort(compareArchivePaths);
      const blocksByPartset = await loadSkillEntryBlocksByPartset(
        session,
        allPartsets,
      );
      const partsetNameByPath = await loadPartsetNameByPath(
        session,
        allPartsets,
      );
      const templateDocument = await session.readScriptDocument(SUPPORT_TEMPLATE_PATH);
      const equipmentListDocument = await session.readScriptDocument(
        EQUIPMENT_LIST_PATH,
      );
      const supportSummonApc = await tryFindAiCharacterByName(
        session,
        SUPPORT_SUMMON_DOLL_NAME,
        {
          pathIncludes: "_doll",
        },
      );
      const files: GeneratedSupportFile[] = [];
      const skipped: SkippedSupportFile[] = [];
      let nextEquipmentId = GENERATED_SUPPORT_ID_START;

      for (
        const [className, supportPaths] of [...supportPathsByClass].sort((left, right) =>
          compareArchivePaths(left[1]?.[0] ?? "", right[1]?.[0] ?? "")
        )
      ) {
        const sourcePartsets = classPartsets.get(className) ?? [];

        if (sourcePartsets.length === 0) {
          for (const supportPath of supportPaths) {
            skipped.push({
              className,
              supportPath,
              reason: "No source partsets were listed in event_8382/event_8383.",
            });
          }
          continue;
        }

        const mergedBlocks = dedupeSkillEntryBlocks(
          sourcePartsets.flatMap((partsetPath) => blocksByPartset.get(partsetPath) ?? []),
        );

        if (mergedBlocks.length === 0) {
          for (const supportPath of supportPaths) {
            skipped.push({
              className,
              supportPath,
              reason: "Source partsets did not contain any 3/6/9 skill data up blocks.",
            });
          }
          continue;
        }

        const explainText = buildExplainText(sourcePartsets, partsetNameByPath, {
          includeSupportSummonExplain: supportSummonApc !== undefined,
        });
        const skillDataUpSection = mergeSkillDataUpBlocks(mergedBlocks);

        for (const supportPath of supportPaths) {
          const sourceSupportDocument = await session.readScriptDocument(
            supportPath,
          );
          const usableJobSection = getFirstSection(
            sourceSupportDocument.children,
            "usable job",
          );
          const characterItemCheckSection = getFirstSection(
            sourceSupportDocument.children,
            "character item check",
          );
          const equipmentId = nextEquipmentId;
          const outputPath = buildGeneratedSupportPath(equipmentId);
          let nextDocument = replaceTopLevelSection(
            templateDocument,
            createSingleStringSection("name", buildGeneratedSupportName(className)),
          );

          nextDocument = replaceTopLevelSection(
            nextDocument,
            createSingleStringSection("name2", ""),
          );

          if (usableJobSection) {
            nextDocument = replaceTopLevelSection(nextDocument, usableJobSection);
          }

          if (characterItemCheckSection) {
            nextDocument = replaceTopLevelSection(
              nextDocument,
              characterItemCheckSection,
              ["possible kiri protect", "icon mark"],
            );
          }

          if (supportSummonApc) {
            for (const section of buildSupportSummonSections(supportSummonApc.id)) {
              nextDocument = replaceTopLevelSection(
                nextDocument,
                section,
                ["skill data up", "possible kiri protect", "icon mark"],
              );
            }
          }

          nextDocument = replaceTopLevelExplain(nextDocument, explainText);
          nextDocument = replaceTopLevelSkillDataUp(nextDocument, skillDataUpSection);

          session.writeScriptDocument(outputPath, nextDocument);
          files.push({
            className,
            supportPath,
            equipmentId,
            outputPath,
            sourcePartsets,
            skillEntryCount: mergedBlocks.length,
          });
          nextEquipmentId += 1;
        }
      }

      if (files.length > 0) {
        session.writeScriptDocument(
          EQUIPMENT_LIST_PATH,
          updateListedPathDocument(
            equipmentListDocument,
            "equipment",
            files.map((file) => ({
              id: file.equipmentId,
              path: file.outputPath,
            })),
          ),
        );
      }

      return {
        files: sortGeneratedSupportFiles(files),
        skipped: sortSkippedSupportFiles(skipped),
      };
    },
  };
}
