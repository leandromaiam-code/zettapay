/* ZettaPay theme toggle — light is default. Persists choice in localStorage.
   Inject the button into [data-theme-mount] or right before the first .btn-primary
   in the nav. Safe to load deferred; FOUC handled by inline head snippet. */
(function () {
  'use strict';

  var KEY = 'zp-theme';
  var root = document.documentElement;

  function current() {
    return root.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }

  function apply(theme) {
    if (theme === 'dark') root.setAttribute('data-theme', 'dark');
    else root.removeAttribute('data-theme');
    try { localStorage.setItem(KEY, theme); } catch (e) {}
  }

  function toggle() { apply(current() === 'dark' ? 'light' : 'dark'); }

  function buildButton() {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-toggle';
    btn.setAttribute('aria-label', 'Toggle color theme');
    btn.setAttribute('title', 'Toggle light / dark');
    btn.innerHTML = ''
      + '<svg class="icon-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      +   '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'
      + '</svg>'
      + '<svg class="icon-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
      +   '<circle cx="12" cy="12" r="4"/>'
      +   '<path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>'
      + '</svg>';
    btn.addEventListener('click', toggle);
    return btn;
  }

  function mount() {
    if (document.querySelector('.theme-toggle')) return;
    var slot = document.querySelector('[data-theme-mount]');
    var btn = buildButton();
    if (slot) {
      slot.appendChild(btn);
      return;
    }
    /* Fallback: insert into the first nav before the first CTA, else into body top. */
    var nav = document.querySelector('nav');
    if (nav) {
      var actions = nav.querySelector('.flex.items-center.gap-3:last-child') || nav;
      var cta = actions.querySelector('.btn-primary');
      if (cta) actions.insertBefore(btn, cta);
      else actions.appendChild(btn);
      return;
    }
    document.body.insertBefore(btn, document.body.firstChild);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

  /* Expose for any inline buttons that may want to bind directly. */
  window.ZettaPayTheme = { apply: apply, toggle: toggle, current: current };
})();
