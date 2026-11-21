# 03 · Generación de vídeo por API (investigación, 16/11/2026)

Solo investigación. Precios en USD, tarifas de lista, antes de impuestos. «SV» = sin verificar en fuente oficial (solo terceros). Los modelos y precios cambian cada semana: revalidar antes de contratar.

## 1. Higgsfield

**Qué es.** Plataforma de creación de imagen/vídeo con IA que además vende un producto API aparte. Modelos propios (Soul 2, Soul Cinema, DoP, Marketing Studio Image, Genjutsu, Cinema Studio 4.0) y de terceros (Kling, Seedance, Wan, MiniMax, LTX, PixVerse, Grok, Recraft, Ideogram). Más de 50 modelos. [higgsfield.ai/blog/higgsfield-api](https://higgsfield.ai/blog/higgsfield-api), [open.higgsfield.ai](https://open.higgsfield.ai/)

**API pública: sí, autoservicio.**
- Clave creada en una consola; se muestra una sola vez. Nuevas claves: 20 peticiones concurrentes (sube con el volumen recargado). Fuente: blog oficial.
- Prepago en dólares, sin suscripción; mínimo de recarga 5 USD (SV, guía de terceros). Los fondos caducan al año. Solo se cobran generaciones completadas (fallidas o moderadas no).
- Asíncrona: petición, id, polling o webhook. Los ficheros se guardan «al menos 7 días»: hay que copiarlos a nuestro Storage.
- Un plan de la web NO da acceso a la API ni cambia su precio. Ojo: una FAQ de terceros dice que la API va en el plan Studio; contradice al blog oficial (prevalece el blog).

**Precios (desde, por segundo).** Hay dos cifras oficiales que no coinciden entre sí; úsese el rango y consúltese la ficha de cada modelo.

| Modelo | Blog API | Página open.higgsfield.ai |
|---|---|---|
| Kling 3.0 | 0,112 | (Kling 4.0 Flash 0,094 / Kling 4.0 0,126) |
| Seedance 2.5 | 0,0738 | 0,118 |
| Seedance 2.0 | 0,9332 (probable error) | 0,080 |
| Wan 3.0 | 0,20 | 0,038 (hasta 30 s, audio nativo) |
| MiniMax H3 | 0,13 | 0,130 (hasta 15 s, 2K) |
| LTX 2.5 Pro | 0,17 | 0,120 |

Kling 4.0 Flash: 720p, 3–20 s, 9:16 soportado (página oficial). Un artículo de Higgsfield (14/10/2026) da Kling 3.0 Standard 720p sin audio a 0,084/s. La divergencia indica que el precio varía con resolución/audio y que se actualiza a menudo.

**Términos** ([higgsfield.ai/terms](https://higgsfield.ai/terms), actualizados 23/10/2026):
- Salidas: «no reclama propiedad» y se pueden usar comercialmente («productos comerciales, anuncios y trabajo para clientes», blog oficial). §4.4.
- §1.2 y §11: licencia para «construir y operar aplicaciones para tus usuarios finales» → nuestro caso encaja.
- §11.5 prohíbe sublicenciar, revender, redistribuir o dar el acceso de forma independiente, y actuar de mero «pass-through» sin valor añadido. Nuestro producto añade marca, guion, cupo, publicación: encaja, pero nunca exponer un endpoint genérico de generación al cliente.
- §1.5: pueden cambiar los límites «sin previo aviso» (throttling, suspensión). §11.9: pueden suspender el acceso.
- §4.4: la empresa puede usar inputs/outputs para entrenar sus modelos, salvo clientes enterprise con contrato. **Riesgo RGPD**: fotos de clientes (y personas que salgan) irían a un tercero que puede entrenar.
- §5.1/4.2: prohíbe personas reales sin consentimiento; §5.2: circunvenir filtros; §8: se aplican las políticas de uso de los proveedores de cada modelo.
- Ubicación del tratamiento y RGPD: las condiciones no lo dicen (remiten a la política de privacidad, no leída). **SV: región UE, DPA, subencargados.**

**MCP / CLI / skills.** Existen, pero son para uso personal con cuenta de Higgsfield, no para el producto: CLI (`higgsfield auth login`) y skills (`npx skills add higgsfield-ai/skills`) para agentes de código; MCP hospedado en `mcp.higgsfield.ai/mcp` con OAuth (SV: solo blogs de terceros). Gastan créditos del plan web, no el saldo API, y la ayuda oficial pide suscripción de pago. [Ayuda](https://higgsfield.ai/creator-hub/help-center/integrations/how-do-i-connect-higgsfield-to-ai-agent). No sirven para el servidor.

**Valoración.** Es un agregador (como fal/Replicate) con modelos propios de foto/estilo. Ventajas: una sola clave, precios competitivos, 9:16, audio nativo en varios modelos. Desventajas frente a fal: más reciente, documentación de API menos contrastada, cláusula de entrenamiento, sin datos de región UE, cláusulas de reventa más estrictas. No es obligatorio para nuestro caso.

## 2. Alternativas con API

| Proveedor | API pública | Precio/seg (fuente) | Máx. y formato | I2V / V2V / audio | Notas |
|---|---|---|---|---|---|
| **Runway** | Sí, créditos 0,01 USD | Gen-4 Turbo 0,05; Gen-4.5 0,12; Veo 3.1 0,40 con audio / 0,20 sin; Kling 3.0 Std 0,09–0,13; Wan 3 0,05–0,20; Seedance 2.0 0,14–0,40; Hailuo 3 0,10–0,15 ([docs](https://docs.dev.runwayml.com/guides/pricing/)) | no listado en la página de precios | I2V sí; V2V (Aleph 2 0,28); audio según modelo | Runway ofrece también modelos de terceros con una sola clave; créditos por proyecto |
| **Google Veo** | Gemini API: **los Veo 3.1 Preview se apagaron el 22/10/2026**; sustituto Gemini Omni 1.2 Flash o Veo GA en la plataforma empresarial ([aistudio.google.com/docs/video](https://aistudio.google.com/docs/video)) | Omni 1.2 Flash: ~0,023 (360p), ~0,07 (720p), ~0,104 (1080p), ~0,209 (4K); hasta 15 s con audio nativo ([precios](https://aistudio.google.com/docs/pricing)). Veo 3.1 en Vertex 0,20–0,40 (SV, agregadores) | Omni hasta 15 s | I2V y V2V (Omni), audio sí | Vertex permite regiones UE (SV: confirmar Veo en europe-west). SynthID |
| **OpenAI Sora** | **Cerrada**: API y Sora 2 apagadas el 24/09/2026, sin sustituto ([doc](https://developers.openai.com/api/docs/models/sora-2)) | — | — | — | Descartada |
| **Kling** | Sí, paquetes prepago (SV: rondas de 5 000 unidades desde 700 USD, 180 días sin traspaso; fuente: artículo de Higgsfield) | Vía fal: v2.6 0,07; v3 0,14 ([fal](https://fal.ai/pricing)); vía Runway 0,09–0,17 | 9:16 sí; Kling 4 hasta 30 s (Higgsfield) | I2V, V2V (O3), audio sí | Página oficial no localizada: SV condiciones y residencia (empresa china) |
| **Luma Ray 3.2** | Sí, pago por uso, sin SLA ([lumalabs.ai/api/pricing](https://lumalabs.ai/api/pricing)) | I2V 5 s: 360p 0,20 / 540p 0,50 / 720p 1,00 / 1080p 4,00 (créditos; artículo de Higgsfield da 0,30 por 5 s a 720p) | 9:16 sí; bloques de 5 s; V2V hasta 20 s | I2V, V2V, Reframe 9:16 | Condiciones comerciales no listadas en la página: SV |
| **Pika** | Plataforma dev.pika.art («API Club») | SV (precios no recuperables) | — | — | Sin dato fiable; sin interés para el producto |
| **MiniMax Hailuo** | Vía fal: H3 Max 0,05 / H3 Max Turbo 0,025; vía Runway Hailuo 3 0,10–0,15 | | 2K, hasta 15 s (Higgsfield) | I2V sí | Barato |
| **Seedance (ByteDance)** | Vía fal (tokens: 2.0 Fast 0,0112/1k, Mini 0,007/1k); vía Runway 2.0 Mini 0,07–0,15; 2.5 0,20–1,10 | | hasta 15–30 s | I2V, audio | Condiciones de ByteDance y UE: SV |
| **Wan (Alibaba)** | Vía Runway/Higgsfield/Replicate (Wan 2.1 720p 0,25/s en Replicate, [precios](https://replicate.com/pricing)); Wan 3.0 desde 0,038 (Higgsfield) | | hasta 30 s | audio nativo en 3.0 | Pesos abiertos en versiones antiguas, SV licencia |
| **fal.ai** | Sí, 1000+ endpoints, pago por segundo ([fal.ai/pricing](https://fal.ai/pricing)) | Kling v3 0,14; MiniMax H3 Max 0,05; Seedance por tokens | según modelo | según modelo | Agregador: SV acuerdo DPA y región UE |
| **Replicate** | Sí, por tiempo de ejecución (modelos públicos) | Wan 2.1 480p 0,09 / 720p 0,25; Kling/Hailuo/Veo: ver ficha | | | Residencia y términos no listados: SV |

Sobre condiciones comunes (SV por proveedor): marca de agua (Veo añade SynthID invisible; el resto no consta), filtros con personas reales (Higgsfield y Veo restringen, verificar por modelo), uso comercial (Higgsfield y Runway permiten; el resto sin leer).

## 3. Avatares y voz

- **HeyGen**: API prepago aparte de los planes web; sin créditos gratuitos desde febrero 2026; concurrencia 10 vídeos; créditos caducan a los 12 meses ([ayuda](https://help.heygen.com/en/articles/10060327-new-heygen-api-plans)). Tabla de precio por minuto (SV, solo en un fragmento de buscador): Avatar IV foto 2,31; Avatar IV gemelo 4,83; Avatar V 7,20; Avatar III 0,60 USD/min.
- **Synthesia**: Basic 0 (10 min/mes), Starter 19/mes, Pro 89/mes, Enterprise a medida; 140+ idiomas (el español no se nombra) ([synthesia.io/pricing](https://www.synthesia.io/pricing)). Qué plan incluye API: SV.
- **ElevenLabs**: TTS 0,08 USD/1 000 caracteres (v4, v3, Multilingual v2) y 0,04 (Turbo/Flash); planes Starter 6/mes, Creator 22/mes, Pro 99/mes ([precios API](https://elevenlabs.io/pricing/api)). Uso comercial solo en planes de pago, la salida es del cliente ([términos](https://elevenlabs.io/terms)); incrustarlo en un producto de terceros requiere revisar sus «OEM Terms» (no leídos). **Residencia UE solo en Enterprise** ([doc](https://elevenlabs.io/docs/overview/administration/data-residency)); almacenamiento en UE, pero tratamiento puede salir salvo con Zero Retention. Voces en español de España: la página no las nombra: SV (probar la biblioteca).
- Encaje: avatares hablando a cámara no encajan con negocios locales (restaurante, tienda) que se anuncian con comida, local y producto. Voz en off sí puede aportar, pero no es prioritaria.

## 4. Alternativa sin IA generativa (plantillas con fotos y clips reales)

| Opción | Precio | Notas |
|---|---|---|
| **Remotion** (React, encaja con nuestro stack) | Gratis para personas y empresas de hasta 3 personas. Licencia de empresa: «Creators» 25 USD/mes por puesto, o «Automators» 0,01 USD por render (bloques de 1 000 = 10 USD) con **mínimo 100 USD/mes**; Enterprise desde 500/mes ([licencia](https://www.remotion.dev/docs/license/pricing.md)) | Un SaaS que renderiza automáticamente entra en «Automators» si somos más de 3. Hay que renderizar en servidor propio (Remotion Lambda/Cloud Run o contenedor): coste de cómputo aparte, no medido |
| **Creatomate** | Essential 45/mes (2 000 créditos, ~289 vídeos de 30 s en vertical 720p), Growth 108, Beyond 274; API en todos los planes ([precios](https://creatomate.com/pricing)) | Plantillas JSON + API; 1080p sin cifra |
| **Shotstack** | Pago por uso 0,20/min; Starter 39/mes (250 min, 0,156/min); Pro 99 ([precios](https://shotstack.io/pricing/)) | Región UE y marca de agua en sandbox: SV |
| **FFmpeg** | Gratis (LGPL/GPL según compilación) | Más trabajo propio; sin editor de plantillas |

**Cuándo compensa.** Si el reel parte de fotos/clips reales del cliente, un montaje con texto, transiciones y música: coste marginal casi cero, resultado determinista, nada de alucinaciones con la comida, sin enviar datos de personas a un proveedor de IA, sin dependencia de cuotas. La IA generativa compensa solo para movimiento que no existe (animar una foto fija, fondos, planos de ambiente). Lo razonable: plantillas como base y, opcionalmente, animar una foto con I2V barato (5 s) como pieza dentro de la plantilla.

## 5. Música con licencia

- **Epidemic Sound (API para desarrolladores)**: catálogo de 55 000+ pistas; «las plataformas pueden sublicenciar a sus usuarios»; lista segura con YouTube, Instagram, TikTok y Facebook («licenciado globalmente, para siempre»); tier gratuito para pruebas, pago para producción sin precios publicados ([developers](https://www.epidemicsound.com/business/developers/)). Es la opción más alineada con publicar en Instagram/TikTok desde un SaaS. SV: precio y límites.
- **Artlist Music API**, **Mubert** (gratis = no comercial; planes de pago con licencia comercial), **Soundraw business**, **Sonilo**: existen, pero términos sin verificar. Aviso de varias fuentes: «libre de royalties» no es «uso comercial en un SaaS»; muchas bibliotecas prohíben redistribuir dentro de una app. Exigir cláusula de uso en plataformas y redes sociales y de sublicencia a usuarios finales.
- Música de la biblioteca de Instagram/Meta: no usable desde API de publicación para cuentas de empresa (restricción habitual; SV).
- Alternativa sencilla: música propia comprada con licencia ampliada, o generada con IA con cláusula comercial explícita.

## 6. Coste mensual: 12 reels de 10 s = **120 s de vídeo**

Se muestra con 1 intento y con 2 intentos por reel (rechazos/retoques reales).

| Opción | Cálculo | 1 intento | 2 intentos |
|---|---|---|---|
| **Barata**: MiniMax H3 Max Turbo en fal (0,025/s) | 120 × 0,025 | **3,00** | 6,00 |
| Barata alt.: Wan 3.0 en Higgsfield (0,038/s, 480–720p) | 120 × 0,038 | 4,56 | 9,12 |
| **Media**: Kling v3 en fal (0,14/s) | 120 × 0,14 | **16,80** | 33,60 |
| Media alt.: Kling 3.0 Higgsfield (0,112/s) | 120 × 0,112 | 13,44 | 26,88 |
| **Alta**: Veo 3.1 con audio (0,40/s, Runway) | 120 × 0,40 | **48,00** | 96,00 |
| Alta alt.: Kling 3.0 Pro con audio (0,17/s, Runway) | 120 × 0,17 | 20,40 | 40,80 |
| **Sin IA**: Shotstack pago por uso | 12 × 10 s = 2 min × 0,20 | 0,40 | — |
| **Sin IA**: Creatomate Essential | cuota fija | 45,00 | — |
| **Sin IA**: Remotion (Automators) | 12 × 0,01 = 0,12, pero mínimo 100/mes compartido entre todas las marcas | 0,12 (marginal) | — |

Extras por marca/mes: voz en off ElevenLabs (12 × ~250 caracteres = 3 000 × 0,08/1 000) ≈ 0,24; música: SV; almacenamiento y cómputo propio: no medido. Nota técnica: Veo y algunos modelos limitan a 8 s por clip, hay que encadenar 2 clips para 10 s (coste ya contado por segundo; no incluye la unión).

Lectura: con IA, de 3 a 100 USD por marca al mes. La mayor parte del coste real está en reintentos, no en el precio por segundo. Con un cupo mensual por empresa, conviene medir en **segundos generados** y limitar los reintentos.

## Recomendación

1. **Base del producto: montaje con plantillas** (Remotion si ≤3 personas o si el mínimo de 100/mes se reparte bien entre muchas marcas; Shotstack/Creatomate si se prefiere no alojar render). Es el formato más seguro para fotos y clips reales, es barato y no manda datos a terceros de IA.
2. **IA generativa como extra opcional (animar foto, 5–10 s)** mediante **fal.ai o Runway** como primera elección: precios publicados, una clave para muchos modelos, sin cláusulas de reventa tan estrictas conocidas. Modelo por defecto «medio» (Kling v3 / Gen-4.5), «barato» (MiniMax H3 / Wan 3) para borradores. Sin Sora.
3. **Higgsfield**: viable técnicamente y legalmente con salvedades (§11.5, entrenamiento, precios que cambian), pero **no es imprescindible**. Si se quiere probar, hacerlo como un adaptador más detrás de nuestro servicio. No usar su MCP/CLI/skills en producción.
4. Adaptador por proveedor y precio configurable por tabla, con coste por segundo y resolución guardado en cada generación.
5. Música: Epidemic Sound API (verificar contrato) o pistas con licencia ampliada.

## Riesgos

- **RGPD**: fotos del cliente y personas reconocibles enviadas a proveedores en EE. UU./China; Higgsfield puede entrenar con las entradas (§4.4); ElevenLabs solo da UE en Enterprise. Necesitamos DPA, subencargados y base legal (consentimiento del cliente y de las personas que salgan).
- Precios inestables (Kling 4 con promoción hasta el 30/11/2026, Runway/Higgsfield con tarifas que cambian, reportes de variaciones de 40–60 % en Kling): guardar la tarifa en tabla, no en código.
- Modelos que se apagan (Sora el 24/09, Veo 3.1 preview el 22/10): el adaptador debe poder cambiar de modelo sin migrar datos.
- Reventa y «pass-through»: revisar §11.5 de Higgsfield y los términos de los demás si el cliente final ve el nombre del modelo.
- Moderación/filtros que rechazan personas reales; sin marca de agua conocida salvo SynthID en Veo; obligación de avisar de contenido generado por IA (Higgsfield §5.5; legislación UE de transparencia).
- Ficheros temporales (Higgsfield 7 días; Gemini retiene pocos días): descargar al terminar.
- Licencia de Remotion si somos más de 3 personas.

## Preguntas abiertas

1. ¿Región UE y DPA de Higgsfield, fal, Replicate, Runway y Luma? ¿Se pueden desactivar el entrenamiento y la retención?
2. ¿Veo en Vertex en europe-west y su precio oficial actual?
3. ¿Términos de Kling, Luma y Seedance/ByteDance para uso comercial dentro de un SaaS?
4. ¿Precio y límites de la API de Epidemic Sound y permiso para publicar vía API de Instagram?
5. ¿Voces en español de España en ElevenLabs y condiciones OEM?
6. ¿Cuántos reintentos reales por reel y qué proporción de reels necesita IA?
7. ¿Somos más de 3 personas (Remotion)? ¿Quién aloja el render?

## Fuentes

- Higgsfield: [blog API](https://higgsfield.ai/blog/higgsfield-api), [página API](https://open.higgsfield.ai/), [comparativa de precios](https://higgsfield.ai/blog/ai-video-api-pricing-vs-subscriptions), [términos](https://higgsfield.ai/terms), [ayuda MCP/CLI](https://higgsfield.ai/creator-hub/help-center/integrations/how-do-i-connect-higgsfield-to-ai-agent), [skills](https://higgsfield.ai/skills)
- Runway: https://docs.dev.runwayml.com/guides/pricing/
- fal: https://fal.ai/pricing
- Google: https://aistudio.google.com/docs/pricing, https://aistudio.google.com/docs/video; Veo en Vertex (SV): https://www.llmreference.com/model/veo-3.1-generate-001/gcp-vertex-ai
- OpenAI Sora: https://developers.openai.com/api/docs/models/sora-2
- Luma: https://lumalabs.ai/api/pricing
- Replicate: https://replicate.com/pricing
- Kling (SV): https://www.costbench.com/software/ai-media-apis/kling-api/
- Pika (SV): https://experiment.pika.art/blog/pika-api-club
- HeyGen: https://help.heygen.com/en/articles/10060327-new-heygen-api-plans
- Synthesia: https://www.synthesia.io/pricing
- ElevenLabs: https://elevenlabs.io/pricing/api, https://elevenlabs.io/terms, https://elevenlabs.io/docs/overview/administration/data-residency
- Remotion: https://www.remotion.dev/docs/license/pricing.md
- Creatomate: https://creatomate.com/pricing
- Shotstack: https://shotstack.io/pricing/
- Epidemic Sound: https://www.epidemicsound.com/business/developers/
- Música (SV, terceros): https://mubert.com/blog/mubert-api-sublicensing-the-hidden-truth-every-developer-must-know
