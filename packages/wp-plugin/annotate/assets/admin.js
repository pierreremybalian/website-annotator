/**
 * Settings → Annotate: Connect/Reconnect popup, postMessage → REST save, Disconnect, Copy link.
 */
(function () {
	'use strict';

	const cfg = window.annotateAdmin;
	if (!cfg) {
		return;
	}

	let endpointOrigin = '';
	try {
		endpointOrigin = new URL(cfg.endpoint).origin;
	} catch (e) {
		endpointOrigin = '';
	}

	const root = document.querySelector('.annotate-connection');
	const messageEl = root && root.querySelector('[data-annotate-message]');
	const blockedEl = root && root.querySelector('[data-annotate-blocked]');
	const fallbackLink = root && root.querySelector('[data-annotate-fallback]');
	let busy = false;

	function setMessage(text, isError) {
		if (!messageEl) {
			return;
		}
		messageEl.textContent = text || '';
		messageEl.classList.toggle('is-error', !!isError);
	}

	function connectUrl(reconnect) {
		let url =
			cfg.endpoint +
			'/connect?origin=' + encodeURIComponent(window.location.origin) +
			'&name=' + encodeURIComponent(cfg.siteName || '') +
			'&site=' + encodeURIComponent(cfg.homeUrl || '');
		if (reconnect && cfg.projectKey && cfg.accessKey) {
			url +=
				'&project=' + encodeURIComponent(cfg.projectKey) +
				'&access=' + encodeURIComponent(cfg.accessKey);
		}
		return url;
	}

	function showBlocked(url) {
		if (!blockedEl || !fallbackLink) {
			return;
		}
		fallbackLink.href = url;
		blockedEl.hidden = false;
	}

	function openPopup(url) {
		const width = 520;
		const height = 720;
		const baseX = window.screenX !== undefined ? window.screenX : window.screenLeft || 0;
		const baseY = window.screenY !== undefined ? window.screenY : window.screenTop || 0;
		const outerW = window.outerWidth || screen.width;
		const outerH = window.outerHeight || screen.height;
		const left = Math.max(0, Math.round(baseX + (outerW - width) / 2));
		const top = Math.max(0, Math.round(baseY + (outerH - height) / 2));
		// No "noopener": the popup needs window.opener to post the result back.
		const features =
			'popup=yes,width=' + width + ',height=' + height + ',left=' + left + ',top=' + top +
			',resizable=yes,scrollbars=yes';

		if (blockedEl) {
			blockedEl.hidden = true;
		}

		let popup = null;
		try {
			popup = window.open(url, 'annotate-connect', features);
		} catch (e) {
			popup = null;
		}
		if (!popup || popup.closed || typeof popup.closed === 'undefined') {
			showBlocked(url);
			return;
		}
		try {
			popup.focus();
		} catch (e) {
			// Ignore.
		}
		setMessage(cfg.i18n.waiting);
	}

	function request(method, body) {
		const init = {
			method: method,
			credentials: 'same-origin',
			headers: { 'X-WP-Nonce': cfg.nonce, Accept: 'application/json' },
		};
		if (body) {
			init.headers['Content-Type'] = 'application/json';
			init.body = JSON.stringify(body);
		}
		return fetch(cfg.restUrl, init).then(function (res) {
			return res
				.json()
				.catch(function () {
					return {};
				})
				.then(function (data) {
					if (!res.ok) {
						throw new Error((data && data.message) || 'HTTP ' + res.status);
					}
					return data;
				});
		});
	}

	function reloadPage() {
		window.location.assign(cfg.pageUrl);
	}

	function saveConnection(data) {
		busy = true;
		setMessage(cfg.i18n.saving);
		request('POST', {
			projectKey: data.projectKey,
			accessKey: data.accessKey,
			boardName: typeof data.boardName === 'string' ? data.boardName : '',
			boardUrl: typeof data.boardUrl === 'string' ? data.boardUrl : '',
			endpoint: typeof data.endpoint === 'string' ? data.endpoint : '',
		})
			.then(reloadPage)
			.catch(function (err) {
				busy = false;
				setMessage(cfg.i18n.saveFailed + ' ' + err.message, true);
			});
	}

	function disconnect() {
		if (!window.confirm(cfg.i18n.confirmDisconnect)) {
			return;
		}
		busy = true;
		setMessage(cfg.i18n.disconnecting);
		request('DELETE')
			.then(reloadPage)
			.catch(function (err) {
				busy = false;
				setMessage(cfg.i18n.disconnectFailed + ' ' + err.message, true);
			});
	}

	// Result from the connect popup. Only trust the configured Worker's origin.
	window.addEventListener('message', function (event) {
		if (!endpointOrigin || event.origin !== endpointOrigin) {
			return;
		}
		const data = event.data;
		if (!data || typeof data !== 'object' || data.type !== 'annotate:connected') {
			return;
		}
		if (typeof data.projectKey !== 'string' || !data.projectKey || typeof data.accessKey !== 'string' || !data.accessKey) {
			return;
		}
		if (busy) {
			return;
		}
		if (blockedEl) {
			blockedEl.hidden = true;
		}
		saveConnection(data);
	});

	function copyText(input, button) {
		const done = function () {
			const label = cfg.i18n.copy;
			button.textContent = cfg.i18n.copied;
			window.setTimeout(function () {
				button.textContent = label;
			}, 1500);
		};
		const fallback = function () {
			input.focus();
			input.select();
			try {
				if (document.execCommand('copy')) {
					done();
				}
			} catch (e) {
				// Leave the text selected so it can be copied by hand.
			}
		};
		if (navigator.clipboard && window.isSecureContext) {
			navigator.clipboard.writeText(input.value).then(done, fallback);
		} else {
			fallback();
		}
	}

	document.addEventListener('click', function (event) {
		const target = event.target instanceof Element ? event.target : null;
		if (!target) {
			return;
		}

		const actionEl = target.closest('[data-annotate-action]');
		if (actionEl) {
			event.preventDefault();
			if (busy) {
				return;
			}
			const action = actionEl.getAttribute('data-annotate-action');
			if (action === 'connect') {
				openPopup(connectUrl(false));
			} else if (action === 'reconnect') {
				openPopup(connectUrl(true));
			} else if (action === 'disconnect') {
				disconnect();
			}
			return;
		}

		const copyEl = target.closest('[data-annotate-copy]');
		if (copyEl) {
			event.preventDefault();
			const input = document.getElementById(copyEl.getAttribute('data-annotate-copy'));
			if (input) {
				copyText(input, copyEl);
			}
		}
	});

	// Show the activation link only while "Access links" is ticked.
	const accessToggle = document.getElementById('annotate-access-links');
	const accessLink = document.querySelector('[data-annotate-access-link]');
	if (accessToggle && accessLink) {
		accessToggle.addEventListener('change', function () {
			accessLink.hidden = !accessToggle.checked;
		});
	}
})();
