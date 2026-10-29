import { useEffect, useRef, useState } from 'preact/hooks';
import type { CreateIssueResponse, Reporter } from '@annotate/shared';

export interface FormInput {
  title: string;
  notes: string;
  reporter: Reporter;
}

interface FormProps {
  side: 'an-left' | 'an-right';
  /** Object URL of the selection PNG; null when capture failed. */
  previewUrl: string | null;
  captureError?: string | null;
  /** Saved or prefilled reporter. When null, Name and Email fields are shown. */
  reporter: Reporter | null;
  /** Partial prefill for the Name/Email fields. */
  reporterDraft: Partial<Reporter>;
  /** Rejects with an Error (message shown to the user) when the submit fails. */
  submit(input: FormInput): Promise<void>;
  onCancel(): void;
}

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function Form({ side, previewUrl, captureError, reporter, reporterDraft, submit, onCancel }: FormProps) {
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [name, setName] = useState(reporter?.name ?? reporterDraft.name ?? '');
  const [email, setEmail] = useState(reporter?.email ?? reporterDraft.email ?? '');
  const [askReporter, setAskReporter] = useState(!reporter);
  const [status, setStatus] = useState<'editing' | 'submitting' | 'error'>('editing');
  const [error, setError] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  busyRef.current = status === 'submitting';

  useEffect(() => {
    // autofocus doesn't fire for content inserted later into a shadow root.
    const t = setTimeout(() => notesRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, []);

  const doSubmit = async () => {
    if (status === 'submitting') return;
    setStatus('submitting');
    setError('');
    try {
      const who: Reporter = askReporter ? { name: name.trim(), email: email.trim() } : reporter!;
      await submit({ title: title.trim(), notes: notes.trim(), reporter: who });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setStatus('error');
    }
  };

  const onSubmit = (e: Event) => {
    e.preventDefault();
    if (!notes.trim()) {
      notesRef.current?.focus();
      return;
    }
    void doSubmit();
  };

  const requestSubmit = () => {
    const form = formRef.current;
    if (!form) return;
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else if (form.reportValidity()) onSubmit(new Event('submit'));
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      requestSubmit();
    }
  };

  // Esc cancels wherever focus is (e.g. on <body> after clicking Send), except while the
  // user is typing in one of the page's own fields.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || busyRef.current) return;
      const path = e.composedPath();
      const inPanel = !!panelRef.current && path.includes(panelRef.current);
      const t = path[0];
      if (!inPanel && t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      onCancel();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  const busy = status === 'submitting';

  return (
    <div ref={panelRef} class={`an-panel ${side}`} role="dialog" aria-label="Report an issue" data-annotate="form">
      <div class="an-panel-head">
        <h2>Report an issue</h2>
        <button type="button" class="an-x" aria-label="Cancel" onClick={onCancel} disabled={busy}>
          ×
        </button>
      </div>
      <form ref={formRef} class="an-form" onSubmit={onSubmit} onKeyDown={onKeyDown}>
        <div class="an-preview">
          {previewUrl ? (
            <img src={previewUrl} alt="Selected area" />
          ) : (
            <div class="an-preview-missing">
              Screenshot unavailable{captureError ? ` (${captureError})` : ''}. You can still send your notes.
            </div>
          )}
        </div>

        <div class="an-field">
          <label for="an-title">Title (optional)</label>
          <input id="an-title" value={title} maxLength={120} onInput={(e) => setTitle(e.currentTarget.value)} readOnly={busy} />
        </div>

        <div class="an-field">
          <label for="an-notes">What's wrong?</label>
          <textarea
            id="an-notes"
            ref={notesRef}
            required
            value={notes}
            placeholder="Describe the issue, what you expected, and any steps to reproduce."
            onInput={(e) => setNotes(e.currentTarget.value)}
            readOnly={busy}
          />
        </div>

        {askReporter ? (
          <div class="an-row">
            <div class="an-field">
              <label for="an-name">Your name</label>
              <input
                id="an-name"
                ref={nameRef}
                required
                autoComplete="name"
                value={name}
                onInput={(e) => setName(e.currentTarget.value)}
                readOnly={busy}
              />
            </div>
            <div class="an-field">
              <label for="an-email">Email</label>
              <input
                id="an-email"
                type="email"
                required
                autoComplete="email"
                value={email}
                onInput={(e) => setEmail(e.currentTarget.value)}
                readOnly={busy}
              />
            </div>
          </div>
        ) : (
          <div class="an-as">
            Reporting as <strong>{reporter!.name}</strong>{' '}
            <button
              type="button"
              class="an-link"
              onClick={() => {
                setAskReporter(true);
                setTimeout(() => nameRef.current?.focus(), 0);
              }}
            >
              not you?
            </button>
          </div>
        )}

        {status === 'error' && (
          <div class="an-error" role="alert">
            <span>{error}</span>
            <button type="button" onClick={requestSubmit}>
              Retry
            </button>
          </div>
        )}

        <div class="an-actions">
          <span class="an-hint-keys">{isMac ? '⌘' : 'Ctrl'}+Enter to send · Esc to cancel</span>
          <button type="submit" class="an-btn" disabled={busy}>
            {busy && <span class="an-spinner" aria-hidden="true" />}
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}

interface SuccessProps {
  side: 'an-left' | 'an-right';
  result: CreateIssueResponse;
  onReportAnother(): void;
  onShowPin(): void;
  onClose(): void;
}

export function Success({ side, result, onReportAnother, onShowPin, onClose }: SuccessProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div class={`an-panel ${side}`} role="status" data-annotate="success">
      <div class="an-success">
        <div class="an-success-title">
          <span class="an-check">✓</span>
          <span>#{result.number} created</span>
          <button type="button" class="an-x" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div class="an-success-actions">
          {result.shortUrl && (
            <a class="an-btn" href={result.shortUrl} target="_blank" rel="noopener noreferrer">
              View in Trello
            </a>
          )}
          <button type="button" class="an-btn an-ghost" onClick={onReportAnother}>
            Report another
          </button>
          <button type="button" class="an-link" onClick={onShowPin}>
            Show pin
          </button>
        </div>
      </div>
    </div>
  );
}
