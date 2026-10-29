// Widget-internal contracts between App (agent A) and Pins/anchor (agent B).
import type { Anchor, Comment, CreateIssueMeta, CreateIssueResponse, IssueDetail, IssueSummary, Rect, Reporter } from '@annotate/shared';

/** Implemented in api.ts. */
export interface WidgetApi {
  createIssue(meta: CreateIssueMeta, selection: Blob, context: Blob): Promise<CreateIssueResponse>;
  listIssues(pageUrl: string, all?: boolean): Promise<IssueSummary[]>;
  getIssue(id: string): Promise<IssueDetail>;
  addComment(id: string, text: string, reporter: Reporter): Promise<Comment>;
}

/** Implemented in capture/anchor.ts. */
export interface AnchorApi {
  /** rect is in viewport coordinates (as drawn by the user). exclude = the widget's shadow host. */
  createAnchor(rect: Rect, exclude: Element): Anchor;
  /** Current viewport-coordinate rect for an anchor, and whether it fell back to the absolute position. */
  resolveAnchor(anchor: Anchor): { rect: Rect; detached: boolean };
}

/** Props for ui/Pins.tsx. Pins render inside the widget's shadow root using position: fixed. */
export interface PinsProps {
  api: WidgetApi;
  /** Current page URL to list pins for (location.href). */
  pageUrl: string;
  /** Saved reporter; when null the reply box asks for name + email first. */
  reporter: Reporter | null;
  onReporterChange(reporter: Reporter): void;
  showResolved: boolean;
  /** Incremented by App after a new issue is created, to trigger a refetch. */
  refreshKey: number;
  /** Issue to open immediately (e.g. right after submitting); optional. */
  openIssueId?: string | null;
}

declare global {
  interface Window {
    /** Early console-error buffer filled by the WP plugin's inline <head> catcher (max 20, oldest first). */
    __annotateErrors?: import('@annotate/shared').ConsoleEntry[];
    /** Small public API so the WP admin bar (or anything else) can drive the widget. */
    Annotate?: { open(): void; showPins(on: boolean): void };
  }
}
