/* Redesigned settings layout, active only with ?newui=1.
   It does not re-render anything: after the old code builds its sections,
   this moves the existing blocks into task-oriented groups. Element ids,
   .dirty-scope wrappers and the single Save bar are untouched, so every save
   and re-render path keeps working. */
(function () {
  if (!window.__newui) return;

  var GROUPS = [
    { key: 'basics', label: 'Basics', desc: 'Name, date, place and look of the event.' },
    { key: 'signup', label: 'Sign-up', desc: 'How people get a ticket, what you ask them, and what happens when it is full.' },
    { key: 'emails', label: 'Emails & notifications', desc: 'What attendees are sent, and when.' },
    { key: 'money', label: 'Tickets & money', desc: 'Price, discounts, payments, returns and expiry.' },
    { key: 'door', label: 'Door & scanning', desc: 'Check-in behaviour and what happens at the entrance.' },
    { key: 'team', label: 'Team & access', desc: 'Who can manage this event and what they have done.' },
    { key: 'advanced', label: 'Advanced', desc: 'Integrations, copying this event and deleting it.' }
  ];
  var LEGACY_TAB_GROUP = {
    'tab-general': 'basics', 'tab-fields': 'signup', 'tab-registration': 'signup', 'tab-waitlist': 'signup',
    'tab-email': 'emails', 'tab-notifications': 'emails', 'tab-discounts': 'money', 'tab-payments': 'money',
    'tab-access': 'team', 'tab-api': 'advanced', 'tab-danger': 'advanced'
  };
  var GENERAL_BY_FIELD = {
    editEventName: ['basics', 'Event details'], editEventTime: ['basics', 'Event details'],
    editEventEndTime: ['basics', 'Event details'], editEventTimezone: ['basics', 'Event details'],
    editEventLocName: ['basics', 'Place'], editEventLocAddress: ['basics', 'Place'],
    editEventColor: ['basics', 'Look'], editEventImage: ['basics', 'Look'],
    editEventCapacity: ['signup', 'Capacity'],
    editEventTicketPrice: ['money', 'Price'],
    editEventTicketExpiresAt: ['money', 'Ticket expiry'], editEventTicketExpiryMode: ['money', 'Ticket expiry'],
    editEventTicketExpiryLimit: ['money', 'Ticket expiry'], editEventTicketExpiryPromotesWaitlist: ['money', 'Ticket expiry'],
    editEventAllowReentry: ['door', 'Check-in'], scanResultDurationToggle: ['door', 'Check-in'],
    editEventShuttleLink: ['door', 'Integrations at the door'], editEventWalletLockScreen: ['door', 'Apple Wallet']
  };
  var REG_SEGMENTS = [
    ['signup', 'Public registration'], ['door', 'At-door sales'], ['emails', 'Confirmation emails'],
    ['signup', 'Signup limits'], ['money', 'Ticket returns'], ['signup', 'Registration page look']
  ];

  var ORDER = {
    basics: ['Event details', 'Place', 'Look'],
    signup: ['Public registration', 'Capacity', 'Waitlist', 'Custom Fields', 'Signup limits', 'Registration page look'],
    emails: ['Ticket Email', 'Confirmation emails', 'Notifications'],
    money: ['Price', 'Discount Codes', 'Payments', 'Ticket returns', 'Ticket expiry'],
    door: ['At-door sales', 'Check-in', 'Apple Wallet', 'Integrations at the door'],
    advanced: ['API Access', 'Duplicate this event', 'Danger Zone']
  };

  var state = { active: 'basics', pages: {}, navBtns: {} };

  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function addBlock(groupKey, title, nodes, tab, opts) {
    var page = state.pages[groupKey];
    var block = el('section', 'nu-block' + (tab ? ' dirty-scope' : ''));
    if (tab) block.dataset.tab = tab;
    if (opts && opts.id) block.id = opts.id;
    if (title) block.appendChild(el('h3', 'nu-block-title', esc(title)));
    nodes.forEach(function (n) { block.appendChild(n); });
    page.appendChild(block);
    return block;
  }

  function mergeInto(map, groupKey, title, node) {
    var k = groupKey + '|' + title;
    if (!map[k]) map[k] = { group: groupKey, title: title, nodes: [] };
    map[k].nodes.push(node);
  }

  function flushMap(map, tab) {
    Object.keys(map).forEach(function (k) {
      var m = map[k];
      addBlock(m.group, m.title, m.nodes, tab);
    });
  }

  function fieldKey(child) {
    var f = child.querySelector('input[id],select[id],textarea[id]');
    return f ? f.id : null;
  }

  function splitGeneral(sec) {
    var kids = Array.prototype.slice.call(sec.children);
    var map = {}, afterRule = [];
    var seenRule = false;
    kids.forEach(function (c) {
      if (c.classList.contains('modal-section-title') || (c.classList.contains('settings-hint') && !seenRule)) { c.remove(); return; }
      if (c.tagName === 'HR') { seenRule = true; c.remove(); return; }
      if (seenRule) { afterRule.push(c); return; }
      var hit = GENERAL_BY_FIELD[fieldKey(c)];
      if (!hit) hit = ['basics', 'Event details'];
      mergeInto(map, hit[0], hit[1], c);
    });
    flushMap(map, 'tab-general');
    if (afterRule.length) {
      var sub = afterRule[0];
      if (sub.classList.contains('settings-subhead')) sub.remove();
      addBlock('advanced', 'Duplicate this event', afterRule.filter(function (n) { return n.parentNode; }), null);
    }
  }

  function splitRegistration(sec) {
    var segs = [[]];
    Array.prototype.slice.call(sec.children).forEach(function (c) {
      if (c.classList.contains('modal-section-title')) { c.remove(); return; }
      if (c.tagName === 'HR') { c.remove(); segs.push([]); return; }
      segs[segs.length - 1].push(c);
    });
    segs.forEach(function (nodes, i) {
      var def = REG_SEGMENTS[i];
      if (!def || !nodes.length) return;
      nodes.forEach(function (n) { if (n.classList.contains('settings-subhead')) n.remove(); });
      addBlock(def[0], def[1], nodes.filter(function (n) { return n.parentNode; }), 'tab-registration');
    });
  }

  function moveWhole(sec, groupKey) {
    var t = sec.querySelector('.modal-section-title');
    var title = t ? t.textContent.replace('BETA', '').trim() : null;
    var beta = t && t.querySelector('.beta-pill');
    if (t) t.remove();
    var block = addBlock(groupKey, title, [], sec.classList.contains('dirty-scope') ? null : null);
    block.classList.add('nu-block-whole');
    block.appendChild(sec);
    sec.classList.add('nu-moved');
    if (beta) block.querySelector('.nu-block-title').insertAdjacentHTML('beforeend', '<span class="beta-pill">BETA</span>');
    return block;
  }

  function setActive(key, scrollTo) {
    if (!state.pages[key]) key = 'basics';
    state.active = key;
    Object.keys(state.pages).forEach(function (k) {
      state.pages[k].hidden = k !== key;
      state.navBtns[k].classList.toggle('active', k === key);
      state.navBtns[k].setAttribute('aria-current', k === key ? 'page' : 'false');
    });
    var g = GROUPS.filter(function (x) { return x.key === key; })[0];
    var h = document.getElementById('nuPageTitle');
    if (h && g) h.textContent = g.label;
    var d = document.getElementById('nuPageDesc');
    if (d && g) d.textContent = g.desc;
    var main = document.getElementById('main');
    if (scrollTo) {
      scrollTo.scrollIntoView({ block: 'center' });
      scrollTo.classList.add('nu-flash');
      setTimeout(function () { scrollTo.classList.remove('nu-flash'); }, 1600);
    } else if (main) main.scrollTop = 0;
    try { sessionStorage.setItem('nuGroup', key); } catch (e) {}
  }

  function refreshDirty() {
    var labels = [];
    GROUPS.forEach(function (g) {
      var page = state.pages[g.key];
      var dirty = page && page.querySelector('.nu-dirty');
      var btn = state.navBtns[g.key];
      if (btn) btn.classList.toggle('has-dirty', !!dirty);
      if (dirty) labels.push(g.label);
    });
    var t = document.querySelector('.settings-save-bar-text');
    if (t) t.textContent = labels.length ? 'Unsaved changes in ' + labels.join(', ') : 'You have unsaved changes';
  }

  function buildIndex() {
    var items = [];
    GROUPS.forEach(function (g) {
      var page = state.pages[g.key];
      if (!page) return;
      page.querySelectorAll('.nu-block-title, .settings-subhead, .settings-toggle-title, label[for], .modal-section-title').forEach(function (n) {
        var text = n.textContent.replace(/\s+/g, ' ').replace('?', '').trim();
        if (text.length < 3 || text.length > 80) return;
        items.push({ group: g.key, groupLabel: g.label, text: text, node: n.closest('.settings-toggle, .nu-block') && n.classList.contains('settings-toggle-title') ? n.closest('.settings-toggle') : n });
      });
    });
    return items;
  }

  function wireSearch() {
    var input = document.getElementById('nuSearch');
    var box = document.getElementById('nuSearchResults');
    if (!input || input.dataset.wired) return;
    input.dataset.wired = '1';
    var index = [];
    function run() {
      var q = input.value.trim().toLowerCase();
      if (!q) { box.hidden = true; box.innerHTML = ''; return; }
      if (!index.length) index = buildIndex();
      var hits = index.filter(function (i) { return i.text.toLowerCase().indexOf(q) !== -1; }).slice(0, 8);
      box.innerHTML = hits.length ? hits.map(function (h, n) {
        return '<button type="button" class="nu-result" data-i="' + n + '"><span>' + esc(h.text) + '</span><small>' + esc(h.groupLabel) + '</small></button>';
      }).join('') : '<div class="nu-result-empty">No settings match.</div>';
      box.hidden = false;
      box._hits = hits;
    }
    input.addEventListener('input', function () { index = []; run(); });
    box.addEventListener('click', function (e) {
      var b = e.target.closest('.nu-result');
      if (!b) return;
      var h = box._hits[+b.dataset.i];
      input.value = ''; box.hidden = true;
      setActive(h.group, h.node);
    });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { input.value = ''; box.hidden = true; input.blur(); }
      if (e.key === 'Enter' && box._hits && box._hits[0]) { var h = box._hits[0]; input.value = ''; box.hidden = true; setActive(h.group, h.node); }
    });
    if (!window.__nuKeys) {
      window.__nuKeys = true;
      document.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
          var i = document.getElementById('nuSearch');
          if (i) { e.preventDefault(); i.focus(); i.select(); }
        }
      });
    }
  }

  function val(id) { var n = document.getElementById(id); return n ? n.value : ''; }

  function previewHtml() {
    var name = val('editEventName') || 'Untitled event';
    var start = val('editEventTime');
    var when = '';
    if (start) {
      var d = new Date(start);
      if (!isNaN(d)) when = d.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    }
    var venue = [val('editEventLocName'), val('editEventLocAddress')].filter(Boolean).join(' - ');
    var price = parseFloat(val('editEventTicketPrice'));
    var cap = val('editEventCapacity');
    var color = val('editEventColor') || '#6366f1';
    return '<div class="nu-preview-card" style="--nu-pv:' + esc(color) + '">' +
      '<div class="nu-preview-bar"></div>' +
      '<div class="nu-preview-body"><div class="nu-preview-name">' + esc(name) + '</div>' +
      '<div class="nu-preview-line">' + esc(when || 'No date set') + '</div>' +
      '<div class="nu-preview-line">' + esc(venue || 'No venue set') + '</div>' +
      '<div class="nu-preview-meta"><span>' + (price > 0 ? '$' + price.toFixed(2) : 'Free') + '</span><span>' + (cap ? esc(cap) + ' spots' : 'Unlimited spots') + '</span></div></div></div>';
  }

  function installPreview() {
    var page = state.pages.basics;
    var host = el('aside', 'nu-preview');
    host.innerHTML = '<div class="nu-preview-label">Preview</div><div class="nu-preview-slot"></div>' +
      '<div class="nu-preview-note">How this event reads on a ticket. Updates as you type.</div>';
    page.insertBefore(host, page.firstChild);
    function paint() { host.querySelector('.nu-preview-slot').innerHTML = previewHtml(); }
    paint();
    document.getElementById('settingsContent').addEventListener('input', paint);
    document.getElementById('settingsContent').addEventListener('change', paint);
  }

  function restructure() {
    var content = document.getElementById('settingsContent');
    if (!content || !content.querySelector('#tab-general')) return;
    var sections = {};
    content.querySelectorAll(':scope > .settings-section').forEach(function (s) { sections[s.id] = s; });

    var stash = el('div'); stash.id = 'nuStash'; stash.hidden = true;
    var pages = el('div', 'nu-pages');
    state.pages = {};
    GROUPS.forEach(function (g) {
      var p = el('div', 'nu-page'); p.id = 'nu-g-' + g.key; p.hidden = true;
      state.pages[g.key] = p; pages.appendChild(p);
    });

    if (sections['tab-general']) splitGeneral(sections['tab-general']);
    if (sections['tab-fields']) moveWhole(sections['tab-fields'], 'signup');
    if (sections['tab-registration']) splitRegistration(sections['tab-registration']);
    if (sections['tab-waitlist']) moveWhole(sections['tab-waitlist'], 'signup');
    if (sections['tab-email']) moveWhole(sections['tab-email'], 'emails');
    if (sections['tab-notifications']) moveWhole(sections['tab-notifications'], 'emails');
    if (sections['tab-discounts']) moveWhole(sections['tab-discounts'], 'money');
    if (sections['tab-payments']) moveWhole(sections['tab-payments'], 'money');
    if (sections['tab-access']) moveWhole(sections['tab-access'], 'team');
    if (sections['tab-api']) moveWhole(sections['tab-api'], 'advanced');
    if (sections['tab-danger']) moveWhole(sections['tab-danger'], 'advanced');

    Object.keys(sections).forEach(function (id) { if (sections[id].parentNode === content) stash.appendChild(sections[id]); });
    // Sections whose children were split keep their ids for any code that looks them up.
    content.innerHTML = '';
    content.appendChild(el('div', 'nu-page-head', '<h2 id="nuPageTitle"></h2><p id="nuPageDesc"></p>'));
    content.appendChild(pages);
    content.appendChild(stash);

    GROUPS.forEach(function (g) {
      var p = state.pages[g.key];
      if (!p.querySelector('.nu-block')) p.appendChild(el('div', 'settings-empty', 'Nothing to configure here.'));
    });
    Object.keys(ORDER).forEach(function (gk) {
      var page = state.pages[gk];
      var blocks = Array.prototype.slice.call(page.querySelectorAll(':scope > .nu-block'));
      var rank = function (b) {
        var t = (b.querySelector('.nu-block-title') || {}).textContent || '';
        for (var i = 0; i < ORDER[gk].length; i++) if (t.indexOf(ORDER[gk][i]) === 0) return i;
        return 99;
      };
      blocks.map(function (b, i) { return { b: b, i: i, r: rank(b) }; })
        .sort(function (x, y) { return x.r - y.r || x.i - y.i; })
        .forEach(function (x) { page.appendChild(x.b); });
    });
    installPreview();

    var saved = null;
    try { saved = sessionStorage.getItem('nuGroup'); } catch (e) {}
    setActive(state.pendingGroup || saved || 'basics');
    state.pendingGroup = null;
    refreshDirty();
    wireSearch();

    if (!content.dataset.nuDirty) {
      content.dataset.nuDirty = '1';
      var mark = function (e) {
        if (e.target.closest('[data-no-dirty]')) return;
        var scope = e.target.closest('.dirty-scope');
        if (scope) { scope.classList.add('nu-dirty'); refreshDirty(); }
      };
      content.addEventListener('input', mark);
      content.addEventListener('change', mark);
    }
  }

  function decorateShell() {
    var nav = document.querySelector('.settings-nav');
    if (!nav) return;
    nav.innerHTML = '';
    state.navBtns = {};
    GROUPS.forEach(function (g) {
      var b = el('button', 'settings-nav-item', '<span>' + esc(g.label) + '</span><i class="nu-dot" aria-hidden="true"></i>');
      b.type = 'button'; b.id = 'navfor-nu-' + g.key;
      b.addEventListener('click', function () { setActive(g.key); });
      nav.appendChild(b); state.navBtns[g.key] = b;
    });
    var sb = document.querySelector('.settings-sidebar');
    if (sb && !document.getElementById('nuSearch')) {
      var wrap = el('div', 'nu-search',
        '<input id="nuSearch" type="search" placeholder="Search settings" autocomplete="off" aria-label="Search settings">' +
        '<kbd>Ctrl K</kbd><div id="nuSearchResults" class="nu-results" hidden></div>');
      sb.insertBefore(wrap, nav);
    }
    var title = document.querySelector('.settings-page-header h1');
    if (title) title.textContent = 'Settings';
  }

  // Legacy deep links (?tab ids, onclick handlers, initialTab) resolve to the right group.
  window.switchSettingsTab = function (btn, tabId) {
    var group = LEGACY_TAB_GROUP[tabId];
    if (!group) return;
    if (!state.pages[group]) { state.pendingGroup = group; return; }
    var target = document.getElementById(tabId);
    if (target && !state.pages[group].contains(target)) target = null;
    setActive(group, target);
  };
  window.initSettingsScrollSpy = function () {};

  var origShow = window.showSettingsView;
  window.showSettingsView = async function (id, initialTab) {
    try { sessionStorage.removeItem('nuGroup'); } catch (e) {}
    state.pendingGroup = initialTab ? LEGACY_TAB_GROUP[initialTab] : null;
    var p = origShow.apply(this, arguments);
    decorateShell();
    return p;
  };

  var origLoad = window.loadAccessData;
  window.loadAccessData = async function () {
    var r = await origLoad.apply(this, arguments);
    restructure();
    return r;
  };

  var origMark = window.markSettingsDirty;
  window.markSettingsDirty = function () { var r = origMark.apply(this, arguments); refreshDirty(); return r; };
  var origClear = window.clearSettingsDirty;
  window.clearSettingsDirty = function (tab) {
    var r = origClear.apply(this, arguments);
    document.querySelectorAll('.nu-dirty').forEach(function (b) { if (b.dataset.tab === tab) b.classList.remove('nu-dirty'); });
    refreshDirty();
    return r;
  };
  var origHide = window.hideSettingsSaveBar;
  window.hideSettingsSaveBar = function () {
    var r = origHide.apply(this, arguments);
    document.querySelectorAll('.nu-dirty').forEach(function (b) { b.classList.remove('nu-dirty'); });
    refreshDirty();
    return r;
  };
})();
