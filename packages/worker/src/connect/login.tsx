/** @jsxImportSource hono/jsx */
// Login pages: enter an email, then the 6-digit code from the email (or open its link). Plain inline scripts,
// like the connect pages. No <form> ever submits: CSP has form-action 'none', the scripts post JSON.

import { AlertIcon, Data, Layout, Script } from './layout';

export const LoginPage = (props: { nonce: string; next: string; email: string; signupOpen: boolean }) => (
  <Layout title="Log in" nonce={props.nonce}>
    <main>
      <Data value={{ next: props.next }} />
      <section id="emailStep">
        <h1>Log in to Annotate</h1>
        <p class="lead">We'll email you a link and a 6-digit code. No password needed.</p>
        <p class="msg" id="emailErr" hidden />
        <form class="stack" id="emailForm" novalidate>
          <input type="email" id="email" name="email" autocomplete="email" placeholder="you@agency.com" value={props.email} required autofocus />
          <button class="btn btn-primary" type="submit" id="send">
            Email me a login code
          </button>
        </form>
      </section>
      <section id="codeStep" hidden>
        <h1>Check your email</h1>
        <p class="lead">
          We sent a code to <b id="sentTo" />. Enter it here, or open the link in the email.
        </p>
        <p class="msg" id="codeErr" hidden />
        <form class="stack" id="codeForm" novalidate>
          <input class="code" id="code" inputmode="numeric" autocomplete="one-time-code" maxlength={6} pattern="[0-9]{6}" aria-label="6-digit code" />
          <button class="btn btn-primary" type="submit" id="verify">
            Log in
          </button>
        </form>
        <div class="link-row">
          Wrong address or no email?
          <button type="button" id="back">
            Start again
          </button>
        </div>
      </section>
      {props.signupOpen ? null : <p class="fine">Annotate is invite-only for now: ask your agency to add you.</p>}
    </main>
    <Script nonce={props.nonce} js={loginJs} />
  </Layout>
);

export const VerifyPage = (props: { nonce: string; token: string }) => (
  <Layout title="Log in" nonce={props.nonce}>
    <main class="center">
      <Data value={{ t: props.token }} />
      <h1>Continue to Annotate</h1>
      <p class="lead">One click to finish logging in.</p>
      <p class="msg" id="err" hidden />
      <div class="actions">
        <button class="btn btn-primary" type="button" id="go">
          Log in
        </button>
      </div>
    </main>
    <Script nonce={props.nonce} js={verifyJs} />
  </Layout>
);

export const LoginErrorPage = (props: { nonce: string; title: string; message: string }) => (
  <Layout title={props.title} nonce={props.nonce}>
    <main class="center">
      <div class="badge err">
        <AlertIcon />
      </div>
      <h1>{props.title}</h1>
      <p class="lead">{props.message}</p>
      <div class="actions">
        <a class="btn btn-primary" href="/login">
          Log in again
        </a>
      </div>
    </main>
  </Layout>
);

/** POST JSON, resolve with the JSON body, reject with the API's error message. */
const postJs = /* js */ `
  function post(url, body) {
    return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' })
      .then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (j) {
          if (!r.ok) throw new Error(j.error || 'Something went wrong. Try again.');
          return j;
        });
      });
  }
  function show(el, text) { el.textContent = text; el.hidden = !text; }
`;

const loginJs = /* js */ `
(function () {
  var cfg = JSON.parse(document.getElementById('cfg').textContent);
  ${postJs}
  var $ = function (id) { return document.getElementById(id); };
  var poll = null;

  function loggedIn(next) {
    if (poll) clearInterval(poll);
    location.replace(next || cfg.next);
  }

  $('emailForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var email = $('email').value.trim();
    if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) { show($('emailErr'), 'Enter your email address.'); return; }
    show($('emailErr'), '');
    $('send').disabled = true;
    post('/login/start', { email: email, next: cfg.next }).then(function () {
      $('sentTo').textContent = email;
      $('emailStep').hidden = true;
      $('codeStep').hidden = false;
      $('code').focus();
      // The link may be opened in another tab of this browser: carry on here once it's used.
      poll = setInterval(function () {
        fetch('/login/status', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (s) { if (s.loggedIn) loggedIn(); }, function () {});
      }, 3000);
    }, function (err) { show($('emailErr'), err.message); }).then(function () { $('send').disabled = false; });
  });

  function submitCode() {
    var code = $('code').value.replace(/\\D/g, '');
    if (code.length !== 6) { show($('codeErr'), 'Enter the 6 digits from the email.'); return; }
    $('verify').disabled = true;
    post('/login/code', { code: code }).then(function (r) { loggedIn(r.next); }, function (err) {
      show($('codeErr'), err.message);
      $('code').value = '';
      $('code').focus();
      $('verify').disabled = false;
    });
  }
  $('codeForm').addEventListener('submit', function (e) { e.preventDefault(); submitCode(); });
  $('code').addEventListener('input', function () {
    this.value = this.value.replace(/\\D/g, '').slice(0, 6);
    if (this.value.length === 6) submitCode();
  });
  $('back').addEventListener('click', function () {
    if (poll) clearInterval(poll);
    $('codeStep').hidden = true;
    $('emailStep').hidden = false;
    show($('codeErr'), '');
    $('email').focus();
  });
})();
`;

const verifyJs = /* js */ `
(function () {
  var cfg = JSON.parse(document.getElementById('cfg').textContent);
  ${postJs}
  // Keep the one-time link out of the history.
  history.replaceState(null, '', location.pathname);
  var go = document.getElementById('go');
  go.addEventListener('click', function () {
    go.disabled = true;
    post('/login/verify', { t: cfg.t }).then(function (r) { location.replace(r.next); }, function (err) {
      show(document.getElementById('err'), err.message);
    });
  });
})();
`;
