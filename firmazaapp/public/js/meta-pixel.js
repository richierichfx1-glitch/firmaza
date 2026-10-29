// Píxel de Meta (Facebook/Instagram) de Firmaza — mide qué anuncios traen
// visitas y notarizaciones pagadas. Conjunto de datos "Firmaza.com" en el
// portafolio comercial "Firmaza · Notario Público en Línea".
//
// Solo se incluye en páginas informativas (inicio, guías, términos,
// privacidad, versión en inglés). NO se carga en /cuenta, /notario ni en el
// panel de admin. En /app solo se carga justo después de un pago confirmado,
// para registrar la compra (ver trackMetaPurchase en js/app.js), y sin
// PageView: así Meta nunca ve los pasos donde el firmante sube su documento
// o captura sus datos.
//
// autoConfig=false apaga la detección automática de clics y metadatos de la
// página: Meta solo recibe los eventos que mandamos nosotros.
(function () {
  var PIXEL_ID = '2708956929522061';
  try {
    /* eslint-disable */
    !function(f,b,e,v,n,t,s)
    {if(f.fbq)return;n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};
    if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
    n.queue=[];t=b.createElement(e);t.async=!0;
    t.src=v;s=b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t,s)}(window, document,'script',
    'https://connect.facebook.net/en_US/fbevents.js');
    /* eslint-enable */
    window.fbq('set', 'autoConfig', false, PIXEL_ID);
    window.fbq('init', PIXEL_ID);
    if (!window.FIRMAZA_PIXEL_NO_PAGEVIEW) window.fbq('track', 'PageView');
  } catch (e) { /* el píxel nunca debe romper la página */ }
})();
