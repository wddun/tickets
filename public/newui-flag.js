/* Opt-in switch for the redesigned dashboard. ?newui=1 turns it on and
   remembers it; ?newui=0 turns it off. Runs in <head> so the class is set
   before first paint. With the flag off nothing here touches the page. */
(function () {
  var on = false;
  try {
    var q = new URLSearchParams(location.search).get('newui');
    if (q === '1') localStorage.setItem('wtsNewUI', '1');
    else if (q === '0') localStorage.removeItem('wtsNewUI');
    on = localStorage.getItem('wtsNewUI') === '1';
  } catch (e) {}
  window.__newui = on;
  if (!on) return;
  document.documentElement.classList.add('newui');
  var l = document.createElement('link');
  l.rel = 'stylesheet';
  l.href = '/newui.css';
  document.head.appendChild(l);
})();
