// Tiny inline scripts for the connect pages. Plain ES2017, no build step.
// Each page embeds its data in <script type="application/json" id="cfg">.

import { CREATE_REVIEW_LIST, REVIEW_LIST_NAME, REVIEW_RE } from './util';

/** Shared by every page: [data-close] buttons close the popup, [data-copy="id"] buttons copy #id's text. */
export const commonJs = /* js */ `
(function () {
  function copy(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) {}
      document.body.removeChild(ta);
      ok ? resolve() : reject(new Error('copy failed'));
    });
  }
  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!(t instanceof Element)) return;
    if (t.closest('[data-close]')) { window.close(); return; }
    var b = t.closest('[data-copy]');
    if (!b) return;
    var src = document.getElementById(b.getAttribute('data-copy'));
    if (!src) return;
    copy(src.textContent).then(function () {
      b.textContent = 'Copied';
      setTimeout(function () { b.textContent = 'Copy'; }, 1600);
    }, function () {
      var r = document.createRange(); r.selectNodeContents(src);
      var sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
      b.textContent = 'Press ⌘C / Ctrl+C';
    });
  });
})();
`;

/** /connect/callback: take #token from the fragment, hand it to the Worker, go on to the board picker. */
export const callbackJs = /* js */ `
(function () {
  var cfg = JSON.parse(document.getElementById('cfg').textContent);
  var params = new URLSearchParams(location.hash.replace(/^#/, ''));
  var token = params.get('token') || '';
  // Get the token out of the address bar and history right away.
  if (location.hash) history.replaceState(null, '', location.pathname + location.search);

  function fail(title, text, canRetry) {
    document.getElementById('working').hidden = true;
    document.getElementById('errTitle').textContent = title;
    document.getElementById('errText').textContent = text;
    document.getElementById('retry').hidden = !canRetry;
    document.getElementById('failed').hidden = false;
  }

  if (!token) {
    fail("Trello access wasn't granted", 'Annotate needs permission to add cards to your board. Try again and click Allow on the Trello page.', true);
    return;
  }

  fetch('/connect/session', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ s: cfg.s, token: token })
  }).then(function (r) {
    return r.json().catch(function () { return {}; }).then(function (j) {
      if (r.ok) { location.replace('/connect/boards?s=' + encodeURIComponent(cfg.s)); return; }
      var msg = j.error || 'Something went wrong (' + r.status + '). Please try again.';
      if (r.status === 410) fail('This window has expired', msg, false);
      else if (r.status === 403) fail('This account can’t connect', msg, true);
      else if (r.status === 401) fail('Trello login didn’t work', msg, true);
      else fail('Something went wrong', msg, true);
    });
  }, function () {
    fail('Connection problem', 'We couldn’t reach the server. Check your connection and try again.', true);
  });
})();
`;

/** /connect/boards: board picker, list defaults, create-a-board, finish, success; CLI mode: link a project. */
export const boardsJs = /* js */ `
(function () {
  'use strict';
  var cfg = JSON.parse(document.getElementById('cfg').textContent);
  function $(id) { return document.getElementById(id); }
  var boardsEl = $('boards'), newSel = $('newList'), doneSel = $('doneList'), reviewSel = $('reviewList'), fields = $('fields');
  var btn = $('connect'), hint = $('hint'), msg = $('msg'), siteInput = $('siteUrl'), createBtn = $('create'), projectsEl = $('projects');
  var selected = null, listsReady = false, busy = false, seq = 0, boardLists = [];
  var REVIEW_RE = ${REVIEW_RE}, CREATE_REVIEW = ${JSON.stringify(CREATE_REVIEW_LIST)};
  var CREATE_REVIEW_LABEL = ${JSON.stringify(`Create “${REVIEW_LIST_NAME}” list`)};
  var CREATE_SUB = ' with New, In progress, ${REVIEW_LIST_NAME} and Done lists';

  function api(method, path, body) {
    return fetch(path, {
      method: method,
      credentials: 'same-origin',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok) throw new Error(j.error || 'Something went wrong (' + r.status + '). Please try again.');
        return j;
      });
    }, function () {
      throw new Error('We couldn’t reach the server. Check your connection and try again.');
    });
  }
  function showError(text) { msg.textContent = text || ''; msg.hidden = !text; }
  function setHint(text) { hint.textContent = text || ''; hint.hidden = !text; }
  function refresh() {
    btn.disabled = busy || !selected || !listsReady;
    if (projectsEl) Array.prototype.forEach.call(projectsEl.querySelectorAll('[data-link]'), function (b) { b.disabled = busy; });
  }
  function siteValue() {
    if (!siteInput) return '';
    var v = siteInput.value.trim();
    if (v && !/^https?:\\/\\//i.test(v)) v = 'https://' + v;
    try { return v ? new URL(v).href : ''; } catch (e) { return ''; }
  }
  function hue(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h % 360; }

  function fill(sel, lists, value) {
    sel.textContent = '';
    lists.forEach(function (l) {
      var o = document.createElement('option');
      o.value = l.id; o.textContent = l.name;
      sel.appendChild(o);
    });
    if (value) sel.value = value;
  }

  // Review list: any list but the new/done ones, or create one on Connect.
  function fillReview(lists, value) {
    fill(reviewSel, lists);
    var o = document.createElement('option');
    o.value = CREATE_REVIEW; o.textContent = CREATE_REVIEW_LABEL;
    reviewSel.appendChild(o);
    reviewSel.value = value || CREATE_REVIEW;
  }
  function reviewClashes() { return reviewSel.value === newSel.value || reviewSel.value === doneSel.value; }
  // Changing the new/done list onto the review list moves the review choice to the next best one.
  function fixReview() {
    if (!reviewClashes()) return;
    var match = boardLists.filter(function (l) { return l.id !== newSel.value && l.id !== doneSel.value && REVIEW_RE.test(l.name); })[0];
    reviewSel.value = match ? match.id : CREATE_REVIEW;
  }
  newSel.addEventListener('change', fixReview);
  doneSel.addEventListener('change', fixReview);

  function showLists(data) {
    var lists = data.lists || [];
    if (lists.length < 2) {
      fields.hidden = true; listsReady = false;
      setHint(lists.length
        ? 'This board has only one list. Add another list in Trello, or let us create a new board.'
        : 'This board has no lists yet. Add some in Trello, or let us create a new board.');
    } else {
      boardLists = lists;
      fill(newSel, lists, data.defaults.newListId);
      fill(doneSel, lists, data.defaults.doneListId);
      fillReview(lists, data.defaults.reviewListId);
      fixReview();
      fields.hidden = false; listsReady = true; setHint('');
    }
    refresh();
  }

  function select(id) {
    selected = id; listsReady = false; fields.hidden = true;
    showError(''); setHint('Loading lists…'); refresh();
    var mine = ++seq;
    api('GET', '/connect/lists?s=' + encodeURIComponent(cfg.s) + '&board=' + encodeURIComponent(id))
      .then(function (data) { if (mine === seq) showLists(data); })
      .catch(function (e) { if (mine === seq) { setHint(''); showError(e.message); } });
  }

  function makeRow(board) {
    var label = document.createElement('label');
    label.className = 'row';
    label.setAttribute('data-name', board.name.toLowerCase());
    var input = document.createElement('input');
    input.type = 'radio'; input.name = 'board'; input.value = board.id;
    var tile = document.createElement('span');
    tile.className = 'tile'; tile.style.background = 'hsl(' + hue(board.name) + ' 55% 48%)';
    tile.textContent = (board.name.trim()[0] || '?').toUpperCase();
    var name = document.createElement('span');
    name.className = 'name'; name.textContent = board.name;
    var dot = document.createElement('span');
    dot.className = 'dot';
    label.appendChild(input); label.appendChild(tile); label.appendChild(name); label.appendChild(dot);
    return label;
  }

  boardsEl.addEventListener('change', function (e) {
    if (e.target && e.target.name === 'board') select(e.target.value);
  });

  // Standalone: name the new board after the site as it's typed.
  if (siteInput && cfg.nameFromSite) siteInput.addEventListener('input', function () {
    if (createBtn.disabled) return;
    var v = siteValue();
    var name = v ? 'Website feedback – ' + new URL(v).host : cfg.newBoardName;
    $('createSub').textContent = '“' + name + '”' + CREATE_SUB;
  });

  var filter = $('filter');
  if (filter) filter.addEventListener('input', function () {
    var q = filter.value.trim().toLowerCase();
    Array.prototype.forEach.call(boardsEl.querySelectorAll('.row'), function (r) {
      r.hidden = !!q && r.getAttribute('data-name').indexOf(q) < 0;
    });
  });

  createBtn.addEventListener('click', function () {
    if (busy) return;
    busy = true; createBtn.disabled = true; refresh(); showError('');
    $('createTitle').textContent = 'Creating your board…';
    var body = { s: cfg.s };
    if (siteValue()) body.siteUrl = siteValue();
    api('POST', '/connect/boards', body).then(function (data) {
      var row = makeRow(data.board);
      boardsEl.insertBefore(row, boardsEl.firstChild);
      var empty = $('noBoards'); if (empty) empty.hidden = true;
      var label = $('boardsLabel'); if (label) label.hidden = false;
      row.querySelector('input').checked = true;
      $('createTitle').textContent = 'Board created';
      $('createSub').textContent = '“' + data.board.name + '” is ready. Click Connect to finish.';
      busy = false; selected = data.board.id; seq++;
      showLists(data);
      btn.focus();
    }).catch(function (e) {
      busy = false; createBtn.disabled = false; refresh();
      $('createTitle').textContent = 'Create a new board for me';
      showError(e.message);
    });
  });

  btn.addEventListener('click', function () {
    if (btn.disabled) return;
    showError('');
    var body = { s: cfg.s, boardId: selected, newListId: newSel.value, doneListIds: [doneSel.value], reviewListId: reviewSel.value };
    if (body.newListId === doneSel.value) { showError('Pick a different list for resolved issues than for new ones.'); return; }
    if (reviewClashes()) { showError('Pick a different list for issues ready for review than for new or resolved ones.'); reviewSel.focus(); return; }
    if (siteInput) {
      var v = siteValue();
      if (!v) { showError('Enter your site’s address, like https://example.com.'); siteInput.focus(); return; }
      body.siteUrl = v;
    }
    busy = true; refresh(); btn.textContent = 'Connecting…';
    api('POST', '/connect/finish', body).then(finished).catch(function (e) {
      busy = false; btn.textContent = 'Connect'; refresh(); showError(e.message);
    });
  });

  function setText(root, key, text) {
    Array.prototype.forEach.call(root.querySelectorAll('[data-k="' + key + '"]'), function (el) { el.textContent = text; });
  }

  // CLI mode: link an existing project.
  if (projectsEl) projectsEl.addEventListener('click', function (e) {
    var b = e.target instanceof Element ? e.target.closest('[data-link]') : null;
    if (!b || busy) return;
    showError('');
    busy = true; refresh(); b.textContent = 'Linking…';
    api('POST', '/connect/link', { s: cfg.s, projectId: b.getAttribute('data-link') }).then(finished).catch(function (err) {
      busy = false; b.textContent = 'Link'; refresh(); showError(err.message);
    });
  });

  function finished(res) {
    $('picker').hidden = true;
    Array.prototype.forEach.call(document.querySelectorAll('.steps i'), function (i) { i.className = 'on'; });
    if (res.cli) {
      // The keys went to the terminal; nothing secret comes back to this page.
      var r = res.cli;
      $('cliTitle').textContent = (r.action === 'linked' ? 'Linked to ' + r.projectName : 'Connected to ' + r.boardName) + '\u00a0✓';
      $('cliBoardLink').href = r.boardUrl;
      $('doneCli').hidden = false;
      return;
    }
    var m = res.message;
    var opener = null;
    try { opener = window.opener; } catch (e) {}
    if (cfg.openerOrigin && opener && !opener.closed) {
      try {
        opener.postMessage(m, cfg.openerOrigin);
        var ok = $('doneOpener');
        setText(ok, 'board', m.boardName);
        ok.hidden = false;
        setTimeout(function () { window.close(); }, 1200);
        return;
      } catch (e) { /* fall back to the manual instructions below */ }
    }
    var view = $('doneManual');
    setText(view, 'board', m.boardName);
    $('snippet').textContent = res.snippet;
    if (res.activationUrl) $('activation').textContent = res.activationUrl;
    else $('activationBlock').hidden = true;
    $('boardLink').href = m.boardUrl;
    $('lostOpener').hidden = !cfg.openerOrigin;
    view.hidden = false;
  }

  if (cfg.currentBoardId) {
    var current = boardsEl.querySelector('input[value="' + CSS.escape(cfg.currentBoardId) + '"]');
    if (current) {
      current.checked = true;
      current.parentNode.scrollIntoView({ block: 'nearest' });
      select(cfg.currentBoardId);
    }
  }
})();
`;
