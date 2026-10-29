# @annotate/shared

TypeScript contracts shared by the widget and the Worker: API request and response shapes (`CreateIssueMeta`, `IssueSummary`, `IssueDetail`, `Comment`, `ProjectStatus`, `ApiError`), the pin `Anchor`, `CaptureEnv`, header names, the `?annotate=` activation param, the widget's `data-*` config, and the `annotate:connected` message the Connect popup posts.

Types only, with no runtime code. Change a contract here first; `pnpm typecheck` then shows every place that has to follow.
