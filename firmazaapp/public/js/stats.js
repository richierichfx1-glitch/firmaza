// Estadísticas propias de Firmaza (sin cookies): manda una visita al cargar
// la página, con su tiempo de carga. Ver POST /api/t en server.js.
(function () {
  function send() {
    try {
      var nav = (performance.getEntriesByType && performance.getEntriesByType('navigation')[0]) || null;
      var load = nav && nav.loadEventEnd > 0 ? nav.loadEventEnd : (performance.now ? performance.now() : null);
      var payload = JSON.stringify({
        path: location.pathname,
        referrer: document.referrer || '',
        ref: new URLSearchParams(location.search).get('ref') || '',
        loadMs: load != null ? Math.round(load) : null,
        ttfbMs: nav ? Math.round(nav.responseStart) : null,
      });
      if (navigator.sendBeacon) navigator.sendBeacon('/api/t', payload);
      else fetch('/api/t', { method: 'POST', body: payload, keepalive: true });
    } catch (e) { /* las estadísticas nunca deben romper la página */ }
  }
  if (document.readyState === 'complete') setTimeout(send, 0);
  else window.addEventListener('load', function () { setTimeout(send, 0); });
})();
