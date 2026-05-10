/* global document, window */
(function () {
	'use strict';

	var INIT_FLAG = '__zettapayWpInit';
	var BOUND_FLAG = '__zettapayWpBound';
	var SELECTOR = 'a.zettapay-btn[data-zettapay-modal="true"]';
	var openOverlay = null;

	function closeModal() {
		if (!openOverlay) return;
		var node = openOverlay;
		openOverlay = null;
		document.removeEventListener('keydown', onKeyDown);
		if (node.parentNode) node.parentNode.removeChild(node);
	}

	function onKeyDown(ev) {
		if (ev.key === 'Escape' || ev.keyCode === 27) closeModal();
	}

	function openCheckoutModal(href) {
		closeModal();
		var overlay = document.createElement('div');
		overlay.className = 'zettapay-modal';
		overlay.setAttribute('role', 'dialog');
		overlay.setAttribute('aria-modal', 'true');
		overlay.setAttribute('aria-label', 'ZettaPay checkout');

		var frame = document.createElement('div');
		frame.className = 'zettapay-modal__frame';

		var iframe = document.createElement('iframe');
		iframe.className = 'zettapay-modal__iframe';
		iframe.src = href;
		iframe.setAttribute('allow', 'clipboard-read; clipboard-write');
		iframe.setAttribute('title', 'ZettaPay checkout');

		var close = document.createElement('button');
		close.type = 'button';
		close.className = 'zettapay-modal__close';
		close.setAttribute('aria-label', 'Fechar checkout');
		close.innerHTML = '&times;';
		close.addEventListener('click', closeModal);

		overlay.addEventListener('click', function (ev) {
			if (ev.target === overlay) closeModal();
		});

		frame.appendChild(iframe);
		frame.appendChild(close);
		overlay.appendChild(frame);
		document.body.appendChild(overlay);
		openOverlay = overlay;
		document.addEventListener('keydown', onKeyDown);
	}

	function bind(el) {
		if (el[BOUND_FLAG]) return;
		el[BOUND_FLAG] = true;
		el.addEventListener('click', function (ev) {
			var href = el.getAttribute('href');
			if (!href) return;
			ev.preventDefault();
			openCheckoutModal(href);
		});
	}

	function scan(root) {
		var nodes = (root || document).querySelectorAll(SELECTOR);
		for (var i = 0; i < nodes.length; i++) bind(nodes[i]);
	}

	function init() {
		if (window[INIT_FLAG]) return;
		window[INIT_FLAG] = true;
		scan(document);
		if (typeof window.MutationObserver !== 'undefined') {
			var obs = new window.MutationObserver(function (records) {
				for (var i = 0; i < records.length; i++) {
					var added = records[i].addedNodes;
					for (var j = 0; j < added.length; j++) {
						var n = added[j];
						if (n.nodeType !== 1) continue;
						if (n.matches && n.matches(SELECTOR)) bind(n);
						if (n.querySelectorAll) scan(n);
					}
				}
			});
			obs.observe(document.body, { childList: true, subtree: true });
		}
	}

	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', init);
	} else {
		init();
	}
})();
