/** The toolbar's issues-done timeline: this many windows of this many minutes, oldest first, ending now */
export const DONE_TIMELINE_WINDOWS = 12;
export const DONE_TIMELINE_WINDOW_MINUTES = 10;

export type IssuesDone = {
  /** Issues done in each window, oldest first; the last window ends at `endsAt` */
  windows: number[];
  endsAt: string;
  /** Every issue ever done, for the total beside the chart */
  total: number;
  /** Issues done in the last few minutes, so the office can cheer each one as it lands */
  recent: Array<{
    id: string;
    identifier: string | null;
    title: string;
    completedAt: string | null;
    /** The assigned agent's name, credited with it */
    doneBy: string | null;
  }>;
};
