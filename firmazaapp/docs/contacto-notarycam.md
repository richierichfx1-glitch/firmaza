# Contacto con NotaryCam — licencia White-Label RON

Preparado para Ricardo Vivas (Firmaza / firmaza.com). Esto **no lo puedo enviar yo** — el
formulario pide tus datos de contacto y arranca una conversación comercial real, así que
tienes que llenarlo y enviarlo tú mismo.

## Paso 1 — Formulario de contacto

URL: https://www.notarycam.com/resources/contact-us/

Es un formulario de campos fijos (no tiene cuadro de texto libre), así que estas son las
respuestas sugeridas para cada campo:

| Campo | Qué poner |
|---|---|
| First name | Ricardo |
| Last name | Vivas |
| Company Name | Firmaza (Richie Tax LLC) |
| Email | richierichfx1@gmail.com |
| Mobile | *(tu número)* |
| ¿Qué solución te interesa discutir? | **Software Licensing** |
| ¿Qué tipo de servicio te interesa? | **General Notary Services** |
| ¿Cuántas notarizaciones haces al mes? | Elige la estimación más realista para el arranque — probablemente **10-49** si es lanzamiento |
| ¿Eres Stewart Agent? | **No** (a menos que ya trabajes con Stewart Title, que no es el caso) |

Después de enviarlo, un representante de ventas empresariales te va a contactar
(probablemente por correo o llamada) para agendar una conversación.

## Paso 2 — Correo de seguimiento con las preguntas técnicas

El formulario no tiene espacio para detalle, así que en cuanto te respondan (o si prefieres
adelantarte y mandarlo por correo directamente), aquí está el mensaje ya redactado en inglés
— es lo que un equipo de ventas de EE.UU. va a esperar recibir:

---

**Subject:** Software Licensing inquiry — bring-your-own notary network (Firmaza)

Hi,

I'm reaching out about NotaryCam's Software Licensing option for remote online notarization.
A few specifics about what I'm looking for:

1. **Notary network**: I already have my own network of bilingual (Spanish/English)
   notaries who are actively commissioned for RON in their states. Can we confirm in
   writing that the Software Licensing model lets us use our own notaries on your
   platform, rather than routing sessions to NotaryCam's own notary pool?

2. **API access**: I'd like access to your full API v4 documentation
   (apidocs.notarycam.com) along with sandbox/test credentials before committing to an
   annual contract, so my developer can validate the integration first.

3. **Session flow**: Can you walk me through the exact endpoint(s) for creating a
   notarization session — what data we send (signer info, document, assigned notary) and
   what we get back (session URL, transaction ID)?

4. **Webhooks / completion**: How are we notified when a session finishes, and what does
   that payload include — the sealed/notarized document, journal entry, and the
   audio/video recording? How long do you retain the recording, and can we also store our
   own copy?

5. **Pricing**: Please share the actual pricing structure — per-transaction fee, per-seat
   / per-notary fee, or a monthly minimum — rather than a general quote call. I'd like the
   full breakdown before scheduling a call.

6. **State coverage**: Which states does our license cover for RON, and does that align
   with where our current notaries are already commissioned?

Company: Firmaza (Richie Tax LLC)
Contact: Ricardo Vivas — richierichfx1@gmail.com
Website: https://firmaza.com

Thanks,
Ricardo

---

## Notas

- El punto **más importante** a confirmar antes de firmar nada es el #1 — si NotaryCam no
  permite usar tu propia red de notarios, entonces pierdes justo lo que hace diferente a
  Firmaza (notarios bilingües propios), y en ese caso conviene comparar con NotaryLive
  (Whitelabel API), OneNotary o Stavvy en vez de firmar con NotaryCam.
- Guarda cualquier credencial de API que te den en `.env` (nunca en el código ni en GitHub)
  — mismo patrón que ya usamos con Square. El molde ya está listo en
  `integrations/notarycam.js` para cuando tengas las credenciales reales.
- Si el contrato incluye un mínimo mensual o anual, vale la pena confirmarlo por escrito
  antes de firmar — muchas plataformas RON empresariales cobran una cuota base
  independientemente del volumen.
