import { AppConfig } from "../config/appConfig";

type EarlyEntryConfig = Pick<
  AppConfig,
  | "earlyEntryPrimarySecondsBeforeClose"
  | "earlyEntryPrimaryMinMovePct"
  | "earlyEntrySecondarySecondsBeforeClose"
  | "earlyEntrySecondaryMinMovePct"
  | "earlyEntryOrderSecondsBeforeClose"
>;

export type EarlyEntryStage = {
  name: string;
  label: string;
  secondsBeforeClose: number;
  minMovePct: number | null;
};

export function getEarlyEntryStages(config: EarlyEntryConfig): EarlyEntryStage[] {
  return [
    {
      name: "primary",
      label: "primary early entry",
      secondsBeforeClose: config.earlyEntryPrimarySecondsBeforeClose,
      minMovePct: config.earlyEntryPrimaryMinMovePct,
    },
    {
      name: "secondary",
      label: "secondary early entry",
      secondsBeforeClose: config.earlyEntrySecondarySecondsBeforeClose,
      minMovePct: config.earlyEntrySecondaryMinMovePct,
    },
    {
      name: "final",
      label: "final early entry",
      secondsBeforeClose: config.earlyEntryOrderSecondsBeforeClose,
      minMovePct: null,
    },
  ];
}

export function selectDueEarlyEntryStage(
  stages: EarlyEntryStage[],
  attemptedStages: Set<string>,
  secondsLeft: number
): EarlyEntryStage | null {
  const dueStages = stages
    .filter((stage) => secondsLeft <= stage.secondsBeforeClose && !attemptedStages.has(stage.name))
    .sort((a, b) => a.secondsBeforeClose - b.secondsBeforeClose);

  return dueStages[0] ?? null;
}

export function markDueEarlyEntryStagesAttempted(
  stages: EarlyEntryStage[],
  attemptedStages: Set<string>,
  selectedStage: EarlyEntryStage
): void {
  for (const stage of stages) {
    if (stage.secondsBeforeClose >= selectedStage.secondsBeforeClose) {
      attemptedStages.add(stage.name);
    }
  }
}
