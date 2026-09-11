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
| RON con **Proof.com** | ✅ Conectado de verdad — ver más abajo (⚠️ el correo que Proof le manda al firmante es mayormente en inglés fijo, ver nota abajo) |
| RON con **BlueNotary** | 🔶 No se pudo conectar todavía (queda como respaldo) — ver más abajo |
| Dominio `firmaza.com` | ✅ Comprado, apuntado por DNS a Render, con certificado SSL activo |
| Hosting | ✅ Desplegado en Render (plan gratuito) |

## Sobre Proof.com (el proveedor de RON que sí quedó conectado)

A diferencia de BlueNotary y NotaryCam (ambos exigen pasar por su equipo de
ventas empresariales antes de darte credenciales), la cuenta de negocio de
Proof.com para "Firmaza" (organización `ord7gqygz`) **sí tiene autoservicio
real**: Settings → API Keys genera una llave al instante.

Cómo funciona: cuando un firmante sube su documento y paga en `/app`,
`server.js` llama a `POST /api/sessions/:id/notarize`, que crea una
transacción real en Proof.com (`integrations/proof.js`). Proof le manda al
firmante un correo (y SMS si dejó teléfono) para conectarse por video con un
notario y completar la notarización — esa videollamada ocurre dentro de la
app de Proof, no en el WebRTC propio de Firmaza. `server.js` recibe los
eventos de estado (enviado, en reunión, completado) en
`POST /webhooks/proof`, ya registrado contra `https://firmaza.com/webhooks/proof`.

**Importante — quién notaría:** el plan actual (self-serve) de la cuenta no
incluye la función "in-house notaries" (eso requiere actualizar de plan —
está bloqueado en Settings → Notary Settings del panel de Proof for
Notaries). Mientras no se actualice, las transacciones las puede tomar
*cualquier* notario disponible de la Red de Proof, no exclusivamente
Ricardo. Se puede acotar por estado comisionado con
`PROOF_ALLOWED_NOTARY_STATES` (ej. `MO`), pero eso no garantiza que sea él
específicamente. Ver la nota completa en `integrations/proof.js`.

**Importante — idioma del correo que recibe el firmante:** la API de
Proof.com no tiene ningún parámetro de idioma/locale. Lo único que Firmaza
controla es el asunto (`message_subject`) y el mensaje del cuerpo
(`message_to_signer`) — ambos ya están en español en `integrations/proof.js`.
El resto de la plantilla (saludo "Hi [nombre],", la sección "How it works",
el "Signer Checklist", el aviso de no reenviar el correo y el pie "About
Proof" con las marcas Proof/Notarize) la genera Proof.com en inglés fijo y
no se puede traducir vía API — es una limitación de su plataforma, no del
código de Firmaza. Tampoco es blanco-etiqueta al 100%: ese pie de página
expone "Proof" y "Notarize" en vez de mostrar solo "Firmaza". Si esto
importa mucho, las únicas vías son (a) revisar si el panel Settings →
Brand customization de Proof for Notaries permite ocultar esas marcas o
cambiar el idioma de la plantilla (no confirmado — requiere que entres tú
con tu sesión), o (b) escribirle a soporte de Proof para pedirlo
directamente. La parte buena: la videollamada de notarización SÍ soporta
español — el firmante puede pedir "Comunícate con un notario
hispanohablante" en la pantalla de la reunión y lo conectan con un notario
que habla español (ver
https://support.proof.com/hc/en-us/articles/20011382358935). El mensaje en
español que manda Firmaza ahora se lo recuerda al firmante.

## Sobre BlueNotary (respaldo, sin conectar)

Investigué su sitio para integrarlo directo y **no tienen una API pública de
autoservicio** con documentación técnica abierta (a diferencia de Square o
Proof.com, donde te creas una cuenta y ya tienes llaves). Su integración es
comercial: hay que contactar a su equipo (bluenotary.us /
bluenotaryonline.com/for-businesses), y ellos entregan credenciales +
documentación específica después de un acuerdo. Como Proof.com ya quedó
conectado y funcionando, esto queda como respaldo por si algún día quieres
comparar proveedores — no es necesario perseguirlo.

Dejé el molde listo en `integrations/bluenotary.js` con las preguntas exactas
que habría que hacerles si se retoma.

## Para producción real, todavía falta

1. ~~**Dominio**~~ — ✅ Listo: `firmaza.com` está comprado y apuntando por DNS
   al servicio en Render, con certificado SSL activo.
2. ~~**Hosting**~~ — ✅ Listo: desplegado en Render (plan gratuito). Un push a
   la rama principal del repo despliega automáticamente.
3. **TURN server**: STUN (gratis) alcanza para probar en la misma red; para
   que la videollamada propia (WebRTC, usada solo como respaldo/demo) funcione
   de forma confiable a través de internet, hace falta un servidor TURN (ej.
   Twilio Network Traversal, Cloudflare Calls, o un `coturn` propio). Con
   Proof.com conectado, la videollamada real de producción ya no depende de
   esto — la maneja Proof.
4. **Cumplimiento legal de RON**: cada estado tiene sus propias reglas para
   notarización remota (retención de grabación de audio/video, a veces años;
   requisitos del proveedor de tecnología; tipo de verificación de identidad
   aceptada). Vale la pena que un abogado revise esto antes de operar con
   dinero y documentos reales — el aviso "Notario ≠ Notary Public" que
   incluí en el sitio es un primer paso, no un sustituto de esa revisión.
5. **Base de datos real**: ahora mismo todo se guarda en archivos JSON
   (`data/sessions.json`) — perfecto para probar, pero para producción con
   tráfico real conviene Postgres/SQLite con transacciones.
6. **Plan de Proof.com**: si quieres que las notarizaciones las tome
   específicamente tú (Ricardo) y no cualquier notario de su red, hay que
   actualizar del plan self-serve actual al que incluye "in-house notaries"
   (ver nota en `integrations/proof.js`).

## Estructura del proyecto

```
server.js              servidor completo (rutas, pagos, firma, señalización WebRTC)
integrations/
  proof.js               integración real con Proof.com (RON) — activa
  bluenotary.js          molde para conectar BlueNotary (respaldo, sin conectar)
  notarycam.js            molde para conectar NotaryCam (respaldo, sin conectar)
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
