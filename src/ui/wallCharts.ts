/** Office whiteboards that show charts are laid out with uids starting with this. */
export const OFFICE_CHART_UID_PREFIX = "office-chart-";

import type { WallChartKey } from "../officeSettings.js";

/**
 * Which whiteboard (combined-layout furniture uid) draws which chart slot from the office
 * settings. The overflow office (camera 3) copies
 * the main office's layout, so it has boards in the same places; the main office's left board is
 * swapped for the kanban (see MAIN_OFFICE_KANBAN_UID).
 */
export const WALL_CHART_BOARDS: Record<WallChartKey, string> = {
  officeRight: `camera1-${OFFICE_CHART_UID_PREFIX}right`,
  boardroom: "camera2-board-whiteboard",
  office2Left: `camera3-${OFFICE_CHART_UID_PREFIX}left`,
  office2Right: `camera3-${OFFICE_CHART_UID_PREFIX}right`,
};

/** The main office's left chart board (in the office layout) becomes the kanban there. */
export const MAIN_OFFICE_KANBAN_UID = `${OFFICE_CHART_UID_PREFIX}left`;

export type { WallChartKey };
