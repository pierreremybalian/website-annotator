// Widget-internal contracts between App (agent A) and Pins/anchor (agent B).
import type { Anchor, Comment, CreateIssueMeta, CreateIssueResponse, IssueContext, IssueDetail, IssueSummary, Rect, Reporter } from '@annotate/shared';

/** Implemented in api.ts. */
export interface WidgetApi {
  createIssue(meta: CreateIssueMeta, selection: Blob, context: Blob): Promise<CreateIssueResponse>;
  listIssues(pageUrl: string, all?: boolean): Promise<IssueSummary[]>;
  getIssue(id: string): Promise<IssueDetail>;
  addComment(id: string, text: string, reporter: Reporter): Promise<Comment>;
  /** 0.2: POST /v1/issues/:id/confirm. */
  confirmIssue(id: string, reporter: Reporter): Promise<IssueSummary>;
  /** 0.2: POST /v1/issues/:id/reopen. */
  reopenIssue(id: string, text: string, reporter: Reporter): Promise<IssueSummary>;
}

/** Implemented in capture/anchor.ts. */
export interface AnchorApi {
  /** Area mode. rect is in viewport coordinates (as drawn by the user). exclude = the widget's shadow host. */
  createAnchor(rect: Rect, exclude: Element): Anchor;
  /** 0.2, element mode: anchor to exactly this element (mode 'element', relative {0,0,1,1}). */
  createElementAnchor(el: Element): Anchor;
  /**
   * Current viewport-coordinate rect for an anchor.
   * detached = the element couldn't be found (or its text changed), rect is the old absolute position.
   * hidden = the element exists but isn't visible at this screen size (display:none, zero size, visibility:hidden);
   *          rect is meaningless and the pin should not be drawn.
   */
  resolveAnchor(anchor: Anchor): { rect: Rect; detached: boolean; hidden: boolean };
}

/** Implemented in capture/context.ts (0.2). */
export interface ContextApi {
  /** Element context for the picked element (or the anchor element in area mode), plus window.AnnotateContext. */
  captureContext(el: Element | null): IssueContext;
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
  /** 0.2: draw pins (when false, only the panel can show). */
  showPins: boolean;
  /** 0.2: the "Issues on this page" panel (Pins owns it; App toggles it from the launcher menu). */
  panelOpen: boolean;
  onPanelOpenChange(open: boolean): void;
}

declare global {
  interface Window {
    /** Early console-error buffer filled by the WP plugin's inline <head> catcher (max 20, oldest first). */
    __annotateErrors?: import('@annotate/shared').ConsoleEntry[];
    /** Small public API so the WP admin bar (or anything else) can drive the widget. */
    Annotate?: { open(): void; showPins(on: boolean): void };
    /** 0.2: page-level context set by a platform adapter (WP plugin, Astro integration). */
    AnnotateContext?: import('@annotate/shared').PageContext;
  }
}
