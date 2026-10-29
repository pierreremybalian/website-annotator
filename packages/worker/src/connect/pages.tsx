/** @jsxImportSource hono/jsx */
import { AlertIcon, CheckIcon, Data, Layout, LinkIcon, PlusIcon, Script, TerminalIcon, TrelloMark } from './layout';
import { boardsJs, callbackJs } from './client';

/** Same hash as the client script, so a board created in the page gets the same tile color later. */
function hue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

const RequestedBy = (props: { host: string | null }) =>
  props.host ? (
    <div class="chip" title="The site that opened this window">
      <LinkIcon />
      <span>
        Requested by <b>{props.host}</b>
      </span>
    </div>
  ) : null;

/** CLI mode: show that a terminal asked for this, and its label, so a lured link stands out. */
const RequestedByTerminal = (props: { label: string | null }) => (
  <div class="chip" title="The terminal that opened this page">
    <TerminalIcon />
    <span>
      Requested by your terminal{props.label ? <> · <b>{props.label}</b></> : null}
    </span>
  </div>
);

// Step 1 ---------------------------------------------------------------------

export const StartPage = (props: {
  nonce: string;
  siteName: string | null;
  openerHost: string | null;
  authorizeUrl: string;
  reconnect: boolean;
  /** Opened by the CLI (/connect?cli=…). */
  cli: { label: string | null } | null;
}) => {
  if (props.cli) {
    return (
      <Layout title="Connect your terminal" nonce={props.nonce} step={1}>
        <main>
          <h1>Connect your terminal to Trello</h1>
          <p class="lead">
            Log in with Trello, then link an existing project or connect a new board. Your terminal gets a key for that project. Your Trello login stays
            here.
          </p>
          <RequestedByTerminal label={props.cli.label} />
          <a class="btn btn-trello" href={props.authorizeUrl} id="login">
            <TrelloMark />
            Log in with Trello
          </a>
          <p class="fine">Only continue if you just ran annotate in your own terminal. Whoever started this link gets access to the project you pick.</p>
        </main>
      </Layout>
    );
  }
  const site = props.siteName ?? 'your site';
  return (
    <Layout title="Connect to Trello" nonce={props.nonce} step={1}>
      <main>
        <h1>
          {props.reconnect ? 'Reconnect' : 'Connect'} {site} to Trello
        </h1>
        <p class="lead">Log in with Trello and pick a board. Every piece of feedback from {site} then shows up there as a card.</p>
        <RequestedBy host={props.openerHost} />
        <a class="btn btn-trello" href={props.authorizeUrl} id="login">
          <TrelloMark />
          Log in with Trello
        </a>
        <p class="fine">No keys to copy. Annotate adds cards as you and keeps their status in sync. You can revoke access anytime in your Trello settings.</p>
      </main>
    </Layout>
  );
};

// Step 2: return from Trello --------------------------------------------------

export const CallbackPage = (props: { nonce: string; s: string; retryUrl: string }) => (
  <Layout title="Logging in" nonce={props.nonce} step={1}>
    <main>
      <div id="working" class="center" role="status">
        <div class="spinner" />
        <h1>Finishing login…</h1>
        <p class="lead">Checking your Trello account.</p>
      </div>
      <div id="failed" class="center" hidden>
        <div class="badge err">
          <AlertIcon />
        </div>
        <h1 id="errTitle">Something went wrong</h1>
        <p class="lead" id="errText" role="alert" />
        <div class="actions">
          <a class="btn btn-trello" id="retry" href={props.retryUrl}>
            <TrelloMark />
            Try again
          </a>
          <button class="btn btn-quiet" type="button" data-close>
            Close window
          </button>
        </div>
      </div>
    </main>
    <Data value={{ s: props.s }} />
    <Script nonce={props.nonce} js={callbackJs} />
  </Layout>
);

// Step 3: board picker --------------------------------------------------------

export interface BoardsPageProps {
  nonce: string;
  s: string;
  siteName: string | null;
  openerOrigin: string | null;
  openerHost: string | null;
  boards: { id: string; name: string }[];
  newBoardName: string;
  /** No site name was given, so the new board is named after the Site URL the user types. */
  nameFromSite: boolean;
  /** Standalone use (no opener): ask for the site URL. */
  askSiteUrl: boolean;
  siteUrl: string | null;
  /** Reconnect: preselect the project's current board. */
  currentBoardId: string | null;
  /** Opened by the CLI: also offer the existing projects; `mode` decides which section comes first. */
  cli: { mode: 'connect' | 'link'; label: string | null; projects: LinkableProject[] } | null;
}

export interface LinkableProject {
  id: string;
  name: string;
  boardName: string;
  origins: string[];
}

const LinkSection = (props: { projects: LinkableProject[]; first: boolean }) => (
  <section class="section" aria-labelledby="linkTitle">
    <h2 class="section-title" id="linkTitle">
      Link an existing project
    </h2>
    {props.projects.length ? (
      <div class="rows" id="projects">
        {props.projects.map((pr) => (
          <div class="row project">
            <span class="tile" style={{ background: `hsl(${hue(pr.name)} 55% 48%)` }}>
              {(pr.name.trim()[0] ?? '?').toUpperCase()}
            </span>
            <span class="name">
              {pr.name}
              <span class="sub">Board: {pr.boardName}</span>
              <span class="sub">{pr.origins.length ? pr.origins.map((o) => o.replace(/^https?:\/\//, '')).join(', ') : 'No sites yet'}</span>
            </span>
            <button type="button" class="link-btn" data-link={pr.id} aria-label={`Link ${pr.name}`}>
              Link
            </button>
          </div>
        ))}
      </div>
    ) : (
      <p class="empty" id="noProjects">
        No projects yet. Connect a new board {props.first ? 'below' : 'above'}.
      </p>
    )}
  </section>
);

const createSub = (name: string) => `“${name}” with New, In progress, Ready for review and Done lists`;

export const BoardsPage = (p: BoardsPageProps) => {
  const linkFirst = p.cli?.mode === 'link';
  const link = p.cli ? <LinkSection projects={p.cli.projects} first={linkFirst} /> : null;
  const feedbackFrom = p.siteName ? <>Feedback from {p.siteName} will show up there as cards.</> : <>Feedback from your site will show up there as cards.</>;
  return (
  <Layout title={p.cli ? 'Connect your terminal' : 'Choose a board'} nonce={p.nonce} step={2}>
    <div id="picker">
      <main>
        {p.cli ? (
          <>
            <h1>Connect your terminal</h1>
            <p class="lead">
              {linkFirst ? 'Link an existing project, or connect a new Trello board.' : 'Connect a new Trello board, or link an existing project.'} Your terminal gets
              a key for the project you choose.
            </p>
            <RequestedByTerminal label={p.cli.label} />
          </>
        ) : (
          <>
            <h1>Choose a board</h1>
            <p class="lead">{p.siteName ? <>Feedback from {p.siteName} will show up here as cards.</> : <>Feedback from your site will show up here as cards.</>}</p>
            <RequestedBy host={p.openerHost} />
          </>
        )}
        {linkFirst ? link : null}
        {p.cli ? (
          <>
            <h2 class="section-title" id="newTitle">
              Connect a new board
            </h2>
            <p class="section-sub">{feedbackFrom}</p>
          </>
        ) : null}
        {p.askSiteUrl ? (
          <div class="fields">
            <label class="field wide">
              <span>Site URL</span>
              <input type="url" id="siteUrl" value={p.siteUrl ?? ''} placeholder="https://example.com" autocomplete="url" inputmode="url" required />
            </label>
          </div>
        ) : null}

        <button type="button" class="row create" id="create">
          <span class="tile">
            <PlusIcon />
          </span>
          <span class="name">
            <span id="createTitle">Create a new board for me</span>
            <span class="sub" id="createSub">
              {createSub(p.newBoardName)}
            </span>
          </span>
        </button>

        <div class="section-label" id="boardsLabel" hidden={p.boards.length === 0}>
          Or use one of your boards
        </div>
        {p.boards.length > 8 ? <input class="filter" id="filter" type="search" placeholder="Find a board" aria-label="Find a board" autocomplete="off" /> : null}
        <div class="rows" id="boards" role="radiogroup" aria-label="Your Trello boards">
          {p.boards.map((b) => (
            <label class="row" data-name={b.name.toLowerCase()}>
              <input type="radio" name="board" value={b.id} />
              <span class="tile" style={{ background: `hsl(${hue(b.name)} 55% 48%)` }}>
                {(b.name.trim()[0] ?? '?').toUpperCase()}
              </span>
              <span class="name">{b.name}</span>
              <span class="dot" />
            </label>
          ))}
        </div>
        {p.boards.length === 0 ? (
          <p class="empty" id="noBoards">
            You don’t have any boards here yet, so let us create one for you.
          </p>
        ) : null}
        {p.cli && !linkFirst ? link : null}
      </main>

      <footer class="bar">
        <div id="msg" class="msg" role="alert" hidden />
        <div class="fields" id="fields" hidden>
          <label class="field">
            <span>New issues go to</span>
            <select id="newList" />
          </label>
          <label class="field">
            <span>Mark resolved when moved to</span>
            <select id="doneList" />
          </label>
          <label class="field wide">
            <span>Ready for review list</span>
            <select id="reviewList" />
          </label>
        </div>
        <p class="hint" id="hint">
          {linkFirst ? 'Or pick a board to connect it as a new project.' : 'Pick a board to continue.'}
        </p>
        <button type="button" class="btn btn-primary" id="connect" disabled>
          Connect
        </button>
      </footer>
    </div>

    {/* Success: the popup reports back to the page that opened it, then closes. */}
    <main id="doneOpener" class="center" hidden>
      <div class="badge pop">
        <CheckIcon />
      </div>
      <h1>
        Connected to <span data-k="board" />{'\u00a0'}✓
      </h1>
      <p class="lead">You can close this window.</p>
      <div class="actions">
        <button class="btn btn-quiet" type="button" data-close>
          Close window
        </button>
      </div>
    </main>

    {/* Success, standalone: show the embed snippet and the activation link. */}
    <main id="doneManual" hidden>
      <div class="badge pop">
        <CheckIcon />
      </div>
      <h1 class="center">
        Connected to <span data-k="board" />{'\u00a0'}✓
      </h1>
      <p class="lead center" id="lostOpener" hidden>
        We couldn’t reach the window that opened this one, so here’s how to finish by hand.
      </p>
      <div class="copy-block">
        <div class="copy-head">
          <b>1. Add this to your site</b>
          <button class="ghost" type="button" data-copy="snippet">
            Copy
          </button>
        </div>
        <pre class="code" id="snippet" />
        <p class="fine">Paste it into the &lt;head&gt; of every page, or your site builder’s “custom code” setting.</p>
      </div>
      <div class="copy-block" id="activationBlock">
        <div class="copy-head">
          <b>2. Turn on feedback mode</b>
          <button class="ghost" type="button" data-copy="activation">
            Copy
          </button>
        </div>
        <pre class="code" id="activation" />
        <p class="fine">Whoever opens this link once gets feedback mode in that browser. Share it with your team and clients; regular visitors won’t see a thing.</p>
      </div>
      <div class="actions">
        <a class="btn btn-quiet" id="boardLink" href="#" target="_blank" rel="noopener noreferrer">
          Open the board in Trello
        </a>
      </div>
    </main>

    {/* Success, CLI: the keys went to the terminal, which is polling for them. */}
    {p.cli ? (
      <main id="doneCli" class="center" hidden>
        <div class="badge pop">
          <CheckIcon />
        </div>
        <h1 id="cliTitle">Connected{'\u00a0'}✓</h1>
        <p class="lead">Return to your terminal. You can close this tab.</p>
        <div class="actions">
          <a class="btn btn-quiet" id="cliBoardLink" href="#" target="_blank" rel="noopener noreferrer">
            Open the board in Trello
          </a>
        </div>
      </main>
    ) : null}

    <Data
      value={{ s: p.s, openerOrigin: p.openerOrigin, currentBoardId: p.currentBoardId, newBoardName: p.newBoardName, nameFromSite: p.nameFromSite, cli: !!p.cli }}
    />
    <Script nonce={p.nonce} js={boardsJs} />
  </Layout>
  );
};

// Errors ----------------------------------------------------------------------

export const ErrorPage = (props: { nonce: string; title: string; message: string }) => (
  <Layout title={props.title} nonce={props.nonce}>
    <main class="center">
      <div class="badge err">
        <AlertIcon />
      </div>
      <h1>{props.title}</h1>
      <p class="lead">{props.message}</p>
      <div class="actions">
        <button class="btn btn-quiet" type="button" data-close>
          Close window
        </button>
      </div>
    </main>
  </Layout>
);
