# Firmaza — prototipo funcional

Notarización en línea (RON) en español, para el mercado latino. Este es un
prototipo **real y funcional** (no un mockup estático): sube documentos,
verifica identidad, cobra, conecta a firmante y notario por video en vivo
(WebRTC), captura la firma electrónica y guarda un registro de auditoría —
todo corriendo de verdad.

## Por qué no tiene `node_modules`

El sandbox donde lo construí no tiene salida a `registry.npmjs.org` (bloqueado
403), así que todo el backend está escrito con **módulos nativos de Node.js
únicamente** — sin Express, sin SDKs de Stripe/Square. Esto es una ventaja
real para ti: no hay que instalar nada, corre con `node server.js` en
cualquier lugar con Node 18+, y es más fácil de auditar.

## Cómo probarlo ahora mismo

```bash
node server.js
# abre http://localhost:8080
```

- `/` — la landing page (marketing)
- `/app` — el flujo del firmante: subir documento → verificar identidad → pagar → video con notario → firmar → confirmación
- `/notario` — el panel donde tus notarios con RON activo toman sesiones de la cola y entran a la videollamada

Sin ninguna variable de entorno configurada, **todo funciona en modo demo**:
el pago no cobra de verdad, la verificación de identidad queda marcada como
"modo de prueba", pero puedes recorrer el flujo completo de principio a fin,
incluyendo una videollamada real por WebRTC entre dos pestañas/dispositivos
(`/app` y `/notario`).

## Qué es real y qué falta conectar

| Pieza | Estado |
|---|---|
| Landing page bilingüe/latina | ✅ Real, terminada |
| Subida de documentos | ✅ Real (se guardan en `data/uploads/`) |
| Firma electrónica (canvas) | ✅ Real, genera PNG + hash de auditoría |
| Videollamada notario↔firmante | ✅ Real (WebRTC + señalización propia), sirve para probar; para producción hace falta un servidor TURN (ver abajo) |
| Cola de notarios | ✅ Real, editable en `data/notaries.json` |
| Pagos con **Square** | 🔶 Código real (Payment Links API vía REST), necesita tu `SQUARE_ACCESS_TOKEN` y `SQUARE_LOCATION_ID` de developer.squareup.com |
| Verificación de identidad (KBA + ID) | 🔶 Punto de integración listo (`runIdentityVerification` en `server.js`), falta elegir proveedor (Stripe Identity, Persona, IDenfy) y sus llaves |
| RON con **BlueNotary** | 🔶 No se pudo conectar todavía — ver más abajo |

## Sobre BlueNotary

Investigué su sitio para integrarlo directo y **no tienen una API pública de
autoservicio** con documentación técnica abierta (a diferencia de Square o
Stripe, donde te creas una cuenta y ya tienes llaves). Su integración es
comercial: hay que contactar a su equipo (bluenotary.us /
bluenotaryonline.com/for-businesses), y ellos entregan credenciales +
documentación específica después de un acuerdo. Eso solo lo puedes hacer tú
directamente con ellos.

Dejé el molde listo en `integrations/bluenotary.js` con las preguntas exactas
que deberías hacerles (¿redirect o embed?, ¿pueden usar tu propia red de
notarios ya certificados en RON, o exigen la de ellos?, cómo notifican que
terminó la sesión). En cuanto tengas esa documentación, lo conecto.

Mientras tanto, el sitio usa **su propio sistema de videollamada** (WebRTC
con servidores STUN de Google, sin costo) para que el flujo completo
funcione de verdad hoy mismo.

## Para producción real, todavía falta

1. **Dominio**: `firmaza.com` y `notarydeconfianza.com` están registrados por
   terceros (aparecen en venta vía Sedo/parking). Ninguna herramienta que
   tengo puede comprarlos por ti — esa compra/negociación la tienes que
   hacer tú directamente (o me confirmas otro nombre disponible y seguimos).
2. **Hosting**: este servidor necesita un proceso Node.js siempre encendido
   (usa polling largo para la señalización de video y guarda archivos en
   disco), así que **no es compatible con Netlify/Vercel en su modo
   "funciones serverless"** — esos apagan el proceso entre peticiones. Te
   recomiendo Render, Railway, Fly.io o un VPS pequeño (Digital Ocean,
   Linode) con Node 18+. Puedo desplegarlo en cuanto conectes uno de esos y
   me des acceso.
3. **TURN server**: STUN (gratis) alcanza para probar en la misma red; para
   que la videollamada funcione de forma confiable a través de internet en
   producción, hace falta un servidor TURN (ej. Twilio Network Traversal,
   Cloudflare Calls, o un `coturn` propio).
4. **Cumplimiento legal de RON**: cada estado tiene sus propias reglas para
   notarización remota (retención de grabación de audio/video, a veces años;
   requisitos del proveedor de tecnología; tipo de verificación de identidad
   aceptada). Vale la pena que un abogado revise esto antes de operar con
   dinero y documentos reales — el aviso "Notario ≠ Notary Public" que
   incluí en el sitio es un primer paso, no un sustituto de esa revisión.
5. **Base de datos real**: ahora mismo todo se guarda en archivos JSON
   (`data/sessions.json`) — perfecto para probar, pero para producción con
   tráfico real conviene Postgres/SQLite con transacciones.

## Estructura del proyecto

```
server.js              servidor completo (rutas, pagos, firma, señalización WebRTC)
integrations/
  bluenotary.js         molde para conectar BlueNotary cuando tengas sus credenciales
data/
  notaries.json          tu lista de notarios con RON activo (reemplaza el ejemplo)
  sessions.json           base de datos de sesiones (se crea sola)
  uploads/                documentos y firmas subidos
public/
  index.html              landing page
  app.html + js/app.js    flujo del firmante
  notario.html + js/notario.js   panel del notario
  css/style.css           estilos (con soporte de tema claro/oscuro)
.env.example              variables de entorno (copia a .env y llena)
```
