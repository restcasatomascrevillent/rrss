# Decisiones de la Fase 2 · Estudio creativo con IA

Fecha: 17/11/2026. Sale de los seis informes de `investigacion-fase2/` (16/11/2026) y de una segunda comprobación hecha hoy en fuentes oficiales. Nada de lo que sigue está contratado ni programado: es el plano para decidir y, después, poner la clave.

Cómo leer las marcas: **[OF]** leído en la página oficial por los informes · **[OF 17/11]** comprobado hoy (enlaces en el apartado 8) · **[SV]** sin verificar: no se da por cierto. Precios en dólares (USD), tarifa pública, sin impuestos. «UE» significa que el proveedor se compromete a procesar dentro de la Unión Europea, no solo a firmar un contrato.

## 1. Resumen de una página

### Arquitectura recomendada

| Servicio | Opción recomendada | Alternativa preparada |
|---|---|---|
| Texto y orquestación | Claude Sonnet 5.5 (redacta) y Haiku 5.5 (comprueba) a través de Google Cloud Vertex AI, multi-región UE | Gemini 3.8 Flash en la misma cuenta; Mistral Large 4 por su dirección UE |
| Imagen | Gemini 3.1 Flash Image («Nano Banana 2») en Vertex AI, UE | FLUX.2 por la dirección UE de Black Forest Labs, solo con baja de entrenamiento por escrito |
| Vídeo generado con IA | Apagado por defecto. Si se activa: Gemini Omni 1.2 Flash en Vertex AI (misma cuenta) | Runway; fal.ai para modelos baratos |
| Reels por plantillas | **Implementado:** FFmpeg directo dentro de nuestro trabajador de medios (`worker/`) | Remotion en el mismo trabajador (plantillas animadas; licencia de empresa a partir de 4 personas); Creatomate o Shotstack |
| Editor por capas | Construirlo: documento propio + Konva (gratis) | Comprar Polotno (exige React 19 y presupuesto) |
| Exportación en servidor | El mismo dibujo del editor, ejecutado en un navegador sin pantalla dentro del trabajador | skia-canvas (sin navegador) en el trabajador o en una función de Vercel |
| Trabajador de medios y cola | Contenedor en Fly.io (Fráncfort), encendido solo cuando hay trabajo; la cola `jobs` que ya existe | Cloud Run Jobs en Europa (misma cuenta de Google); Render Fráncfort |
| Verificador de marca | Reglas sin IA primero (bloquean) y juez con IA después (Haiku; Sonnet si hay duda) | Gemini Flash como juez; solo reglas |
| Fuentes de marca | El modelo lee el PDF; el trabajador descarga la web; vectores con Gemini Embedding 2 (UE) | Mistral OCR; Firecrawl o Jina para webs difíciles |
| Música | API de Epidemic Sound (pedir precio de producción) | Audio subido por el cliente con declaración de derechos |
| Ortografía y moderación | Dentro de la comprobación con IA (UE) + detectores propios de datos personales | LanguageTool (Alemania o alojado por nosotros); Azure Content Safety |

Con esto, **una sola cuenta de Google Cloud cubre texto, comprobación, vectores, imagen y vídeo con IA**, todo salvo el vídeo con compromiso de proceso en la UE.

### Coste mensual de IA por marca (estimación, no medida)

Base de los informes: 60 publicaciones al mes con 3 variantes de texto, 4 propuestas de imagen por publicación (240 imágenes) y 12 reels de 10 segundos. Las imágenes son casi todo el coste; una publicación hecha con la foto real del cliente, sin generar imagen, cuesta prácticamente cero.

| Concepto | Ajustado | Recomendado | Alto |
|---|---|---|---|
| Texto | Haiku en todo: ≈ 0,2 | Sonnet + Haiku: ≈ 1–2 | Opus en todo: ≈ 3–7 |
| Imagen (240) | Nano Banana (0,039), sin repetir: 9,4 | Nano Banana 2 a 2K (0,101), un tercio repetido: 36,4 | Igual, todo repetido una vez: 48,5 |
| Comprobación con IA | ≈ 0,1 | ≈ 2 | ≈ 6 |
| Reels por plantillas | 0 | 0 | 0 |
| Vídeo con IA | Apagado: 0 | 6 clips de 5 s, 2 intentos, 720p: 4,2 | 12 reels de 10 s, 2 intentos, 1080p: 25 |
| **Total por marca y mes** | **≈ 10 USD** | **≈ 44 USD** | **≈ 85 USD** |

El texto incluye el recargo regional del 10 % y un 25 % por la llamada de planificación. Los precios de imagen y vídeo son los de la API de Gemini; la tarifa de Vertex AI no se pudo leer hoy [SV]. El modelo «Nano Banana» del escenario ajustado se apaga el 15/03/2027 [OF 17/11]. Palanca principal: generar 2 propuestas en vez de 4 reduce el total recomendado a unos 26 USD.

### Coste fijo de infraestructura (al mes, para todas las marcas)

| Pieza | Coste | Nota |
|---|---|---|
| Supabase Pro (producción) | 25 USD | Obligatorio para archivos de más de 50 MB [OF] |
| Vercel Pro | 20 USD | El plan gratuito no admite uso comercial (dato del plan por fases; [SV] en estos informes) |
| Trabajador en Fly.io | ≈ 2 USD | Supuesto de 20 empresas con 2 marcas; solo paga cuando trabaja |
| Almacenamiento extra | 2,5 USD (mes 3) → 16 USD (mes 12) | Mismo supuesto, sin política de borrado |
| Google Cloud | 0 fijo | Se paga por uso |
| FFmpeg (reels) | 0 | Es lo implementado. Remotion, solo si se adopta como alternativa: gratis hasta 3 personas en la empresa; si no, mínimo de 100 USD al mes [OF] |
| Música (Epidemic Sound) | Sin precio público | Hay nivel gratuito para pruebas [OF 17/11] |
| **Total de partida** | **≈ 47 USD al mes** | Sin música (los reels con FFmpeg no pagan licencia) |

### Decisiones que solo puede tomar el dueño

| # | Decisión | Opción por defecto si no se dice nada |
|---|---|---|
| 1 | Criterio de datos | «UE por defecto» (apartado 3). Relajarlo se decide por organización, no para todo el producto |
| 2 | Vídeo generado con IA | Apagado; se activa por organización con un aviso de que ese material puede salir de la UE |
| 3 | Dónde vive el trabajador de medios | Fly.io en Fráncfort |
| 4 | Si se quieren reels con plantillas animadas (Remotion) | No: se sigue con FFmpeg, que ya está construido y no tiene licencia. Remotion pediría saber cuántas personas tiene la empresa (gratis hasta 3; con más, 100 USD al mes) |
| 5 | Cupo mensual de IA | Propuesta: 45 USD por cada marca activa de la organización (escenario recomendado), revisable con el primer mes de consumo real. Se anota en USD, que es como facturan los proveedores |
| 6 | Música | Abrir cuenta gratuita de Epidemic Sound y pedir precio; mientras, audio del cliente |
| 7 | Prueba ciega antes de fijar proveedores | Sí, con tope de 100 USD (apartado 6) |
| 8 | Consulta con abogado | Sí, antes de vender a terceros (apartado 5) |

El editor ya está decidido (construir, apartado 4); solo hay que aceptar su plazo de 4 a 8 semanas.

## 2. Fichas por servicio

Columnas: precio · dónde se procesan los datos y si entrenan con lo enviado · condiciones para usarlo dentro de nuestro producto · esfuerzo de integración · riesgo.

### 2.1 Texto y orquestación

| Opción | Precio (por millón de tokens, entrada / salida) | Datos | Uso en nuestro producto | Esfuerzo | Riesgo |
|---|---|---|---|---|---|
| **Claude en Vertex AI, UE** | Sonnet 5.5: 2 / 10; Haiku 5.5: 0,10 / 0,50; +10 % por dirección regional [OF] | UE: Sonnet 5.5, Haiku 5.5 y Opus 5.5 figuran en la multi-región UE [OF 17/11]. Google no entrena sin permiso [OF 17/11] | Anthropic permite integrarlo y prohíbe revender el acceso [OF]; en Vertex rigen además las condiciones de Google Cloud [SV] | Medio: acceso con cuenta de servicio de Google desde la función del servidor | Que caché, lectura de PDF y lotes funcionen igual que en la API directa [SV] |
| Gemini en Vertex AI, UE | 3.8 Flash: 0,75 / 3,75 (se duplica el 01/01/2027); 4 Hydrogen: 1,50 / 7,50 [OF] | UE [OF 17/11]; no entrena sin permiso | Condiciones de Google Cloud [SV en detalle] | Bajo: misma cuenta | Precios con subidas ya anunciadas |
| Mistral Large 4, dirección UE | 0,70 / 2,10 [OF], +10 % por la dirección UE [OF 17/11] | La inferencia se queda en la UE; cuentas, facturación y estadísticas pueden salir [OF 17/11]. No entrena con datos de la API de pago (leído solo en resumen) [SV] | [SV] | Medio: otra cuenta; la dirección UE no admite lotes, archivos ni agentes [OF 17/11] | Lista de modelos de la región no publicada |
| Claude por la API directa de Anthropic | Igual, sin recargo; lotes −50 % | **Fuera de la UE**: inferencia solo «global» o «EE. UU.», y datos guardados solo en EE. UU. [OF 17/11]. No entrena; contrato de tratamiento incluido [OF] | Igual | Bajo: una clave | Solo válida si se relaja el criterio |

**Recomendación.** Claude por Vertex AI en la UE: es la combinación que los informes eligieron por precio y capacidades, y hoy se ha confirmado que está disponible con proceso en la UE, cosa que el informe 01 dejaba abierta. La calidad en español de España no está medida: el modelo definitivo sale de la prueba ciega (apartado 6), y cambiarlo es cambiar un dato en el registro de modelos. El patrón es el previsto: la IA propone un plan en JSON y nuestro motor lo ejecuta, en pasos cortos encolados.

**Qué contratar.** Cuenta de Google Cloud con facturación, un proyecto, Vertex AI activado, los modelos de Claude habilitados en su catálogo y una cuenta de servicio. **Clave:** el archivo JSON de esa cuenta de servicio, guardado como secreto de las funciones de Supabase.

**Sin verificar.** Cuotas iniciales de una cuenta nueva; paridad de funciones de Claude en Vertex; Claude en el perfil UE de Amazon Bedrock (la página oficial remite a la ficha de cada modelo, no leída).

### 2.2 Imagen

| Opción | Precio por imagen | Datos | Uso en nuestro producto | Esfuerzo | Riesgo |
|---|---|---|---|---|---|
| **Gemini 3.1 Flash Image («Nano Banana 2») en Vertex AI, UE** | 0,067 (1K) / 0,101 (2K) [OF 17/11, tarifa de la API de Gemini] | UE [OF 17/11]; no entrena sin permiso | Condiciones de Google Cloud | Bajo: misma cuenta; respuesta inmediata | Marca invisible de IA en el resultado [SV] |
| Gemini 2.5 Flash Image («Nano Banana») en Vertex AI, UE | 0,039 [OF 17/11] | UE [OF 17/11] | Igual | Bajo | Se apaga el 15/03/2027 |
| FLUX.2 pro, dirección UE de Black Forest Labs | ≈ 0,075 (2 MP con una foto de referencia) [OF] | Encaminado solo a regiones UE [OF 17/11], **pero sus condiciones les permiten entrenar con lo enviado** [OF]; la baja se pide por correo [SV] | Solo dentro de nuestra aplicación [OF] | Medio: asíncrono; el resultado caduca a los 10 minutos [OF 17/11] | Fotos de clientes entrenando modelos ajenos |
| Ideogram 4.0 / OpenAI gpt-image | 0,03–0,10 [OF] / ≈ 0,013–0,053 [SV] | Región UE no encontrada / sin confirmar para imagen [SV] | Ideogram: uso comercial libre [OF] | Medio | Solo si se relaja el criterio; fuertes en texto dentro de la imagen |

**Recomendación.** Nano Banana 2 en Vertex AI: es el único modelo de imagen actual con proceso en la UE documentado y sin fecha de retirada. El logotipo, los textos y los colores **no se le piden al modelo**: los coloca nuestro editor encima, que es lo único que garantiza la marca y el texto legible. Recortar y reencuadrar la foto real se hace en el trabajador, sin IA.

**Cambio respecto al informe 02.** Su escenario «medio» usaba Nano Banana 2.1 (0,034), que no figura en la lista UE. Con el modelo que sí figura, 240 imágenes cuestan 16–24 USD en vez de 8–12.

**Qué contratar.** Nada más que la cuenta de Google Cloud de 2.1. **Sin verificar:** tarifa propia de Vertex; si Nano Banana 2.1, 2 Lite y Pro llegarán a la UE; calidad con fotos de hostelería.

### 2.3 Vídeo generado con IA

| Opción | Precio por segundo | Datos | Uso en nuestro producto | Esfuerzo | Riesgo |
|---|---|---|---|---|---|
| **Gemini Omni 1.2 Flash en Vertex AI** | ≈ 0,07 (720p) / 0,104 (1080p); hasta 15 s con sonido [OF 17/11, tarifa de la API de Gemini] | **Región UE no confirmada**: no figura en la lista de residencia [OF 17/11]. No entrena sin permiso | Condiciones de Google Cloud | Bajo: misma cuenta; asíncrono | Modelos de vídeo de Google retirados con poco aviso (Veo 3.1 de prueba, 22/10/2026) |
| Runway | Gen-4 Turbo 0,05; Gen-4.5 0,12; modelos de terceros 0,09–0,40 [OF] | EE. UU.; UE «a petición» [SV]. Contrato de tratamiento con cláusulas tipo publicado; entrenamiento [SV] | Uso comercial permitido [OF] | Medio | Créditos y tarifas cambiantes |
| fal.ai (Kling v3, MiniMax H3) | 0,14 / 0,025 [OF] | Sin región UE; su contrato no cubre los «modelos excluidos» y el contenido pasa al fabricante del modelo, varios de ellos chinos [OF] | No exponer su API al cliente final [OF] | Medio | El más débil en datos |

Descartados: Sora (cerrada el 24/09/2026 [OF]) y Higgsfield (puede entrenar con lo enviado y no dice dónde procesa [OF]).

**Recomendación.** Ningún generador de vídeo cumple hoy «UE por defecto», así que nace **apagado**. Cada organización lo activa aceptando un aviso, sirve solo para animar una foto de producto o del local, de 5 a 10 segundos, y el sistema rechaza material con personas reconocibles. Entre los tres, Google va primero porque es la misma cuenta y el mismo contrato y no entrena; la calidad se decide en la prueba ciega. El cupo de vídeo se mide en segundos generados y limita los reintentos.

**Qué contratar.** Con Google, nada nuevo. Runway y fal: cuenta de prepago y clave de API, solo para la prueba. **Sin verificar:** Veo y Omni en regiones europeas (un usuario informa de errores al pedir Veo en Europa); precio en Vertex.

### 2.4 Reels por plantillas (material real)

| Opción | Precio | Datos | Uso en nuestro producto | Esfuerzo | Riesgo |
|---|---|---|---|---|---|
| **FFmpeg directo en nuestro trabajador (implementado)** | Gratis | No salen | Licencia según la compilación [SV] | Medio: hecho (`media.reel.template`) | Solo zoom, fundidos, rótulos y música |
| Remotion en nuestro trabajador (alternativa) | Gratis hasta 3 personas; si no, 0,01 por vídeo con mínimo de 100 al mes [OF] | No salen de nuestra infraestructura | Un producto que monta vídeos automáticamente entra en esa licencia (interpretación del informe; confirmar) [SV] | Alto: 3–5 plantillas animadas | Tiempo de montaje sin medir |
| Creatomate / Shotstack | 45 al mes (2.000 créditos) / 0,20 por minuto [OF] | Servicio externo; región UE [SV] | API en todos los planes | Bajo | El resultado no es idéntico a nuestro editor |

**Lo implementado.** Los informes recomendaban Remotion para las plantillas y FFmpeg para unir, comprimir y poner la música. Se construyó **todo con FFmpeg directo** en el trabajador (`worker/`, trabajo `media.reel.template`, probado con archivos reales y dentro del contenedor) para no depender de la licencia de Remotion: coste de licencia cero, sin inventos sobre la comida y sin enviar nada a terceros. El precio es que las plantillas se limitan a zoom, fundidos, rótulos y música. **Alternativa:** Remotion en el mismo trabajador, leyendo el documento de capas con el tiempo como parámetro, si se quieren plantillas animadas más ricas; exige confirmar por escrito la licencia (gratis hasta 3 personas en la empresa; si no, licencia de empresa) y un prototipo de que el dibujo del editor se anima bien dentro de Remotion. **Qué contratar:** nada.

### 2.5 Editor por capas

| Opción | Precio | Datos | Licencia | Esfuerzo | Riesgo |
|---|---|---|---|---|---|
| **Construir: documento propio + Konva** | 0 | Todo en nuestro sistema | Libre (MIT) [OF] | Alto: 4–8 semanas según el informe | Texto editable, guías y móvil se hacen a mano |
| Polotno | Sin precio público: «de pocos cientos a 20–30 mil o más» [OF 17/11] | Editor en nuestro sistema | Comercial, por presupuesto | Bajo en editor; antes hay que pasar a React 19 [OF] | Dependencia de un proveedor y de su formato |
| IMG.LY CE.SDK | Solo con presupuesto [OF] | En nuestro sistema | Comercial; sin clave, marca de agua [OF] | Medio | Formato propio; el más caro previsiblemente |

Recomendación y razones en el apartado 4. **Qué contratar:** nada. **Sin verificar:** rendimiento en móvil de cualquiera de las tres.

### 2.6 Exportación en servidor

| Opción | Precio | Datos | Esfuerzo | Riesgo |
|---|---|---|---|---|
| **Navegador sin pantalla (Chromium) en el trabajador, con el mismo dibujo del editor** | Incluido en el trabajador | UE (Fráncfort) | Medio | Arranque de unos segundos; tiempos sin medir |
| skia-canvas en el trabajador o en una función de Vercel | 0 de licencia [OF] | UE si se fija la región de la función | Medio | Pequeñas diferencias de texto con el navegador |
| Servicio externo (Creatomate, Bannerbear, Templated) | 39–49 al mes por 1.000–2.000 imágenes [OF] | Externo; región [SV] | Bajo | Motor distinto: lo exportado no coincide con lo editado |

**Recomendación.** Navegador sin pantalla dentro del trabajador. Los informes se contradecían: el 04 proponía una función de Vercel con skia-canvas y el 05 un contenedor aparte. Se resuelve a favor del contenedor porque el vídeo lo exige de todos modos (el trabajador con FFmpeg ya existe), porque es el mismo motor de dibujo del propio editor (y, si algún día se adopta Remotion, este trae ese mismo navegador) y porque coincide con la arquitectura escrita (`01-arquitectura.md`). La función de Vercel queda como plan B solo para imagen. Lo que no cabe en ningún caso es una función de Supabase (2 segundos de procesador, 256 MB [OF]). «Idéntico» se comprueba con capturas de referencia por plantilla.

### 2.7 Trabajador de medios y cola

| Opción | Precio al mes | Datos | Esfuerzo | Riesgo |
|---|---|---|---|---|
| **Fly.io, Fráncfort, bajo demanda** | ≈ 2 de cómputo; parada solo cuesta el disco [OF] | UE | Medio: imagen Docker, despertar con una llamada | Una sola máquina procesa en fila |
| Cloud Run Jobs, región europea | ≈ 0–2,3 (cifras leídas vía buscador) [SV] | UE | Medio-alto: la llamada desde Supabase pide identificación de Google | No abre cuenta nueva; precios por confirmar |
| Render, Fráncfort, siempre encendido | 50 [OF] | UE | Bajo | Caro para poco uso |

**Recomendación.** Fly.io con la cola `jobs` propia (ya hecha y probada); no pasar a un servicio de colas ni a un orquestador, que duplicarían lo que existe. La cola avisa al trabajador al entrar un trabajo y un reloj cada minuto recoge lo que se pierda. El trabajador entra en la base de datos con un permiso limitado, no con la clave general. **Qué contratar:** cuenta de Fly.io con tarjeta y una aplicación en Fráncfort. **Clave:** token de despliegue (en GitHub) y un secreto compartido para despertarlo. **Sin verificar:** tiempos reales (medir con 5 vídeos), disco y duración máxima de una máquina.

### 2.8 Verificador de marca

| Opción | Precio | Datos | Esfuerzo | Riesgo |
|---|---|---|---|---|
| **Reglas sin IA + juez con IA (Haiku; Sonnet si hay duda), en Vertex UE** | Reglas: 0. Juez: ≈ 0,03 por pieza; hasta 0,10 con Sonnet en todo (estimación) | UE | Medio-alto: tabla de formatos por red, contraste, paleta, palabras vetadas, rúbrica | Fiabilidad del juez sin medir |
| Juez con Gemini Flash | Parecido | UE | Igual | Igual |
| Solo reglas | 0 | No sale nada | Medio | No ve tono, público ni estilo de imagen |

**Recomendación.** Dos niveles: las reglas se ejecutan siempre y bloquean; el juez devuelve «cumple, dudoso o no cumple» con la cita literal que lo justifica, y lo dudoso va a una persona. Lo más fiable es impedir el error al crear (paleta y tipografías cerradas en el editor). La interfaz dirá «ayuda a revisar», nunca «garantiza». **Qué contratar:** nada nuevo. **Sin verificar:** límites de texto y zonas seguras de varias redes (van en una tabla con fecha de revisión, no en el código); licencias de algunas bibliotecas.

### 2.9 Extracción de fuentes de marca

| Opción | Precio | Datos | Esfuerzo | Riesgo |
|---|---|---|---|---|
| **Propia: el modelo lee el PDF, el trabajador descarga la web, vectores con Gemini Embedding 2** | Manual de 40 páginas: 0,12–0,24 una vez; vectores: 0,20 por millón de tokens [OF] | UE [OF 17/11] | Medio | Webs que bloquean la descarga |
| Mistral OCR | 4 por 1.000 páginas (versión 4.1, API de Mistral) [OF] | En la lista UE de Vertex figura una versión anterior (25.05) [OF 17/11]; la 4.1 iría por la dirección UE de Mistral | Medio | Solo si el PDF escaneado se lee mal |
| Firecrawl / Jina Reader | 19 al mes por 5.000 páginas / gratis con límite [OF] | Región [SV] | Bajo | Otro proveedor para algo que es público |

**Recomendación.** Vía propia. De cada marca se destila un perfil corto (unos 6.000 tokens, pocas páginas de texto) que acompaña a cada petición; la búsqueda por vectores se reserva para fuentes grandes (catálogos, preguntas frecuentes). Lo descargado se trata siempre como dato, nunca como instrucción. **Qué contratar:** nada nuevo. **Sin verificar:** lectura de PDF por Claude dentro de Vertex; calidad de los vectores en español.

### 2.10 Música

| Opción | Precio | Datos | Uso en nuestro producto | Esfuerzo | Riesgo |
|---|---|---|---|---|---|
| **API de Epidemic Sound** | Nivel gratuito para prototipo, alta inmediata; producción sin precio público [OF 17/11] | Recibe búsquedas, no material del cliente [SV] | «Se admite sublicenciar a los usuarios»; lista segura en Instagram, TikTok, Facebook y YouTube [OF 17/11] | Medio | Precio desconocido; condiciones concretas por leer |
| Audio subido por el cliente | 0 | No sale | El cliente declara que tiene los derechos | Bajo | Declaraciones falsas |
| Biblioteca propia comprada | Variable | No sale | «Libre de derechos» no equivale a poder redistribuirla en un producto [SV] | Bajo | Reclamaciones |

**Recomendación.** Epidemic Sound: es la única cuya página oficial confirma las dos cosas que necesitamos (sublicenciar a nuestros usuarios y publicar en redes). Integrar con el nivel gratuito y no lanzar reels con su música hasta tener el precio por escrito; mientras, audio del cliente. **Qué contratar:** cuenta de desarrollador. **Clave:** su clave de API. **Sin verificar:** precio, límites y si la música de Instagram puede usarse al publicar por API.

### 2.11 Ortografía y moderación

| Opción | Precio | Datos | Esfuerzo | Riesgo |
|---|---|---|---|---|
| **Dentro de la comprobación con IA + detectores propios de teléfonos, correos y DNI** | ≈ 0 añadido | UE | Bajo | Menos repetible que una herramienta dedicada |
| LanguageTool | API de pago sin precio visible, servidores en Alemania [OF]; o gratis alojándolo nosotros | UE | Medio: otro servicio que mantener | Falsos avisos con nombres de platos |
| OpenAI (moderación gratuita) / Azure Content Safety | 0 / 5.000 textos e imágenes gratis al mes [OF] | OpenAI fuera del criterio UE; región de Azure [SV] | Bajo | Otro proveedor recibiendo fotos |

**Recomendación.** Empezar sin proveedor nuevo: el juez de 2.8 señala faltas y contenido no publicable citando el fragmento exacto, y los datos personales se detectan con reglas. El informe 06 proponía LanguageTool alojado por nosotros; se deja como alternativa porque añade un servicio encendido siempre, y la prueba del apartado 6 dirá si hace falta. Perspective (Google) cierra el 31/12/2026: no usar.

## 3. Protección de datos

### Qué sale hacia cada proveedor en el diseño recomendado

| Proveedor | Qué recibe | ¿Personas reconocibles? | Dónde se procesa | ¿Entrena con ello? |
|---|---|---|---|---|
| Supabase | Todo: cuentas, perfiles, fotos, vídeos | Sí | Región UE del proyecto | No aplica |
| Vertex AI: texto, juez, vectores | Perfil de marca, encargos, textos, manual en PDF, web de la marca | Solo si aparecen en lo enviado | UE [OF 17/11] | No sin permiso [OF 17/11] |
| Vertex AI: imagen | Fotos del cliente como base, logotipo, instrucciones | Sí, si la foto las tiene: exige consentimiento anotado | UE [OF 17/11] | No sin permiso |
| Vertex AI: vídeo (opcional) | Una foto o clip corto y la instrucción | Bloqueado por diseño | Sin confirmar | No sin permiso |
| Fly.io (trabajador) | Fotos y vídeos de paso, para exportar y montar | Sí, de paso; no se guardan | UE (Fráncfort) | No aplica |
| Epidemic Sound | Búsquedas de música | No | [SV] | — |
| FFmpeg, Konva (y Remotion si se adopta) | Nada: son programas que corren en nuestro sistema | — | — | — |

### Diseño «UE por defecto»

1. **La regla vive en los datos, no en la buena voluntad.** Cada modelo del registro lleva anotado dónde procesa y si entrena; cada organización lleva su política («solo UE» por defecto). El servicio de IA se niega a usar un modelo que no cumpla la política de esa organización.
2. **Siempre la dirección regional de la UE, nunca la global.** La dirección global de Google no da garantía de residencia [OF 17/11]. En Vertex se dejan apagados el registro de peticiones y la caché duradera [OF 17/11].
3. **Mínimo dato.** Los encargos no llevan datos personales. Al subir una foto se marca si hay personas reconocibles; esas fotos no salen nunca hacia un proveedor de fuera de la UE.
4. **Nada se queda fuera.** El resultado se copia de inmediato a nuestro almacenamiento; no se depende de enlaces temporales del proveedor.
5. **Rastro.** Cada generación guarda proveedor, modelo y región, para poder responder a un cliente qué salió y adónde.

Supabase, Google, Vercel y Fly.io son empresas de EE. UU. con centros de datos en la UE: el criterio aplicado es dónde se procesa, no la nacionalidad del proveedor. Si el abogado pidiera además proveedor europeo, las piezas preparadas son Mistral para el texto y un servidor de Hetzner (Alemania, desde 5,49 € al mes [OF]) para el trabajador; para imagen, el único europeo estudiado (Black Forest Labs) entrena con lo enviado salvo baja expresa.

### Quién queda fuera con ese criterio y qué pasaría al relajarlo a «contrato de tratamiento y sin entrenamiento»

| Proveedor | Por qué queda fuera hoy | ¿Entraría al relajar? |
|---|---|---|
| Anthropic, API directa | Inferencia global o EE. UU.; datos guardados en EE. UU. [OF 17/11] | Sí: no entrena y trae contrato [OF] |
| OpenAI (texto, imagen, moderación) | Región Europa solo para clientes y servicios «elegibles»; imagen y moderación sin confirmar [SV] | Sí: no entrena con la API [OF 17/11] |
| Black Forest Labs (FLUX) | Procesa en la UE, pero puede entrenar con lo enviado [OF] | Solo con la baja de entrenamiento por escrito |
| Runway | EE. UU.; UE «a petición» [SV] | Probable; falta leer si entrena |
| fal.ai y Replicate | Sin región UE; fal no cubre los «modelos excluidos»; Replicate sin contrato visible [OF] | fal solo en modelos cubiertos; Replicate no |
| Higgsfield | Puede entrenar; no dice dónde procesa [OF] | No |
| Kling, Seedance, MiniMax, Wan | Empresas chinas; condiciones sin leer [SV] | No, hasta leer su contrato |
| Ideogram, Recraft, Stability, Leonardo, Freepik | Región UE no encontrada [SV] | Caso a caso |
| ElevenLabs (voz) | UE solo en el plan Enterprise [OF] | Sí en teoría; la voz no es prioritaria |
| Creatomate, Shotstack, Bannerbear, Trigger.dev | Región de datos sin confirmar [SV] | No hacen falta |

**Qué se ganaría relajando.** Sencillez (Claude con una sola clave, sin el 10 % regional y con lotes a mitad de precio), mejor texto dentro de la imagen (Ideogram, gpt-image), moderación gratuita y más modelos de vídeo. **Qué costaría:** transferir datos fuera de la UE obliga a apoyarse en cláusulas tipo, a evaluar esa transferencia y a declarar a cada cliente la lista de proveedores; algunos clientes lo rechazarán. Por eso la propuesta es mantener «solo UE» como norma y permitir la excepción organización a organización, que el diseño ya soporta. En cualquiera de los dos criterios hace falta nuestro propio contrato de tratamiento con cada cliente.

## 4. Editor: construir o comprar

**Decisión: construir**, con un documento de capas propio y Konva.

1. **El documento es el producto.** La IA propone un plan en JSON y ese mismo JSON es la pieza guardada, con sus reglas para pasar de 1:1 a 4:5 y 9:16. Con un editor comprado habría que traducir en cada paso entre nuestro plan y el formato del proveedor.
2. **El cliente no es diseñador.** Necesita cambiar un texto, sustituir la foto, mover el logotipo y ver los tres formatos. Un editor guiado, con tipografías y colores cerrados a los de la marca, da mejor resultado que un lienzo libre y es más fiable que revisar después (conclusión del informe 06).
3. **Lo que se ve es lo que se exporta.** El mismo código de dibujo corre en el navegador del usuario y en el del trabajador (2.6). Con Polotno o IMG.LY ese motor es de ellos.
4. **Coste y dependencia.** Konva es libre y gratuito; Polotno no publica precio [OF 17/11] e IMG.LY tampoco.

**Efecto de estar en React 18.** Polotno exige React 19 y la versión actual del adaptador `react-konva` también; para React 18 solo queda una versión antigua de mantenimiento incierto [OF]. Se esquiva usando **Konva directamente, sin adaptador de React**: el paquete de dibujo tiene que ser independiente de React de todos modos, porque también corre en el servidor. Así construir no obliga a migrar; comprar sí. Subir a React 19 queda como tarea de mantenimiento aparte.

**Alcance de la primera versión.** Panel de capas en HTML (da además accesibilidad con teclado), mover, escalar, ocultar, editar texto en un cuadro superpuesto, sustituir imagen, deshacer, tres formatos con retoque por formato, versiones como copias inmutables y aviso si otra persona guardó antes. Fuera: dibujo libre, edición simultánea, efectos.

**Riesgo y salida.** Si a las 4 semanas el texto editable o el móvil no alcanzan la calidad necesaria, se pide presupuesto a Polotno y se convierte nuestro documento al suyo; al ser nuestro el formato, el cambio no pierde las piezas guardadas.

## 5. Obligaciones legales que afectan al diseño

Esto no es asesoría legal: es lo que los informes y las fuentes dicen, para preparar la consulta con un abogado.

| Norma | Qué exige | Desde cuándo | Efecto en el producto |
|---|---|---|---|
| Reglamento europeo de IA, art. 50.4 | Quien publica imagen, audio o vídeo generado o manipulado que parezca real debe decirlo [OF] | 02/08/2026: ya se aplica | Campo «generado con IA» por pieza y por capa; rótulo visible opcional; aviso antes de aprobar |
| Reglamento europeo de IA, art. 50.2 | Quien ofrece un sistema generativo debe marcar la salida de forma legible por máquinas [OF] | 02/08/2026. Los sistemas ya en el mercado antes de esa fecha tienen hasta el 02/12/2026 (Reglamento 2026/1744, leído hoy en el resumen de un despacho; texto oficial no leído) [SV] | Como el producto sale después, contar con que aplica desde el primer día: conservar la marca del generador y añadir una credencial propia al exportar |
| Ley española de IA | Sancionaría no etiquetar; en trámite en las Cortes, no vigente [SV] | Pendiente | Diseñar el etiquetado como obligatorio |
| Publicidad | La comunicación comercial debe distinguirse; la encubierta está prohibida [SV] | Vigente | Marcar colaboraciones pagadas |
| Normas de las redes | Meta etiqueta lo que detecta o se declara; TikTok y YouTube exigen declarar lo realista generado [OF; la norma de TikTok, SV] | Vigente | Al publicar, enviar el aviso de cada red (en TikTok existe el campo `is_aigc`) |

Además: guardar quién revisó y aprobó cada pieza (la revisión humana cuenta), rechazar la generación de personas reales o de su parecido, y avisar de que una imagen generada sin aportación humana puede no tener derechos de autor [SV].

**Preguntas para el abogado**

1. ¿Somos «proveedor», «responsable del despliegue» o ambos, usando modelos de terceros? ¿Quién marca y quién avisa: nosotros o el cliente que publica?
2. ¿Nos alcanza el plazo del 02/12/2026 o, por salir después del 02/08/2026, todo aplica desde el lanzamiento?
3. ¿Basta la aprobación del cliente como «revisión humana»? ¿El texto de un negocio en sus redes entra en el art. 50.4?
4. Estado de la ley española y si añade obligaciones propias de etiquetado.
5. Nuestro contrato de tratamiento con los clientes, la lista de proveedores, la base legal para fotos con empleados o clientes y qué cambia si una organización acepta proveedores de fuera de la UE.
6. Derechos de autor, de marca y de imagen sobre lo generado, y qué indemnización dan los proveedores.
7. Cláusulas de responsabilidad si el verificador da por buena una pieza que no lo era.
8. Licencias: tipografías de marca subidas al servidor, música sublicenciada, la compilación de FFmpeg del contenedor y, si se adopta, Remotion.

## 6. Plan de pruebas de calidad antes de fijar proveedores

**Método.** Prueba ciega con encargos reales de dos marcas distintas. Quien valora no sabe qué proveedor hizo cada pieza y el orden se baraja. Valoran el dueño y una persona de cada marca. Con proveedores de fuera de la UE solo se usa material sin personas.

| Bloque | Casos | Candidatos | Piezas |
|---|---|---|---|
| Texto | 20 encargos (10 por marca), 3 variantes | Claude Sonnet 5.5, Gemini 3.8 Flash, Mistral Large 4 | 60 respuestas |
| Imagen | 20 casos: 10 con foto real de base, 6 desde cero, 4 con texto dentro | Nano Banana 2 (UE), FLUX.2 pro (dirección UE), Ideogram o gpt-image como referencia de fuera | 60 imágenes, repetidas una vez: 120 |
| Vídeo con IA | 6 fotos (3 por marca) animadas 5 s | Omni 1.2 Flash, Runway Gen-4.5, Kling v3 (fal) | 18 clips, dos intentos: 36 |
| Verificador | Los 60 textos más 10 con fallos puestos a propósito | Juez Haiku y juez Sonnet frente a una persona; LanguageTool en ortografía | 70 juicios, tres veces cada uno |

**Qué se mide.** En cada pieza: «la publicaría tal cual / con retoques / no». En texto: tono de la marca, palabras vetadas, datos inventados (platos, precios, horarios) y español de España. En imagen: si respeta el producto real, defectos visibles y texto legible. En vídeo: movimiento creíble y deformaciones. En todos: tiempo, coste real facturado y rechazos del proveedor. En el verificador: acuerdo con la persona corregido por azar, fallos puestos que detecta y variación entre repeticiones.

**Cuánto cuesta.** Texto, menos de 2 USD. Imagen, hasta 12 USD (120 imágenes a 0,05–0,10). Vídeo, unos 22 USD (60 segundos por proveedor a 0,10–0,14). Verificador, unos 2 USD. **Total en torno a 40 USD**; con las recargas mínimas de prepago, reservar **100 USD** como tope. Tiempo de las personas: media jornada del dueño y un par de horas de cada marca.

**Regla de decisión.** Gana la opción UE salvo que una de fuera sea claramente mejor en «la publicaría tal cual»; en ese caso se documenta como excepción para quien acepte relajar el criterio.

## 7. Orden de activación

| Paso | Cuenta | Qué desbloquea | Qué hay que entregar |
|---|---|---|---|
| 1 | Supabase: proyecto nuevo en región UE; plan Pro al entrar el vídeo | Desplegar la Fase 1 y todo lo demás | Dirección del proyecto y sus claves |
| 2 | Vercel Pro | Publicar la aplicación | Acceso al proyecto |
| 3 | Google Cloud: facturación, proyecto, Vertex AI, modelos de Claude habilitados | Texto, verificador con IA, fuentes de marca, imagen y, si se activa, vídeo con IA: la mayor parte de la fase con una sola cuenta | Archivo JSON de la cuenta de servicio |
| 4 | Fly.io | Exportación idéntica, reels por plantillas, FFmpeg y lectura de webs | Token de despliegue |
| 5 | Cuentas de prueba: Mistral, Black Forest Labs, Runway, fal y una entre Ideogram u OpenAI | La prueba ciega del apartado 6 | Una clave por cuenta, con saldo mínimo |
| 6 | Epidemic Sound (desarrollador) y petición de precio | Música en los reels | Clave de API |
| 7 | Remotion: solo si se adopta como alternativa a FFmpeg y la empresa pasa de 3 personas | Plantillas de reel animadas | Confirmación escrita |
| 8 | Abogado | Vender a terceros con el etiquetado y los contratos resueltos | Respuestas del apartado 5 |

Sin esperar a ninguna cuenta se puede avanzar en el documento de capas con sus versiones, el editor, las reglas sin IA del verificador y la tabla de formatos por red. El trámite de Meta para publicar (Fase 3) conviene iniciarlo ya porque su plazo no depende de nosotros.

## 8. Notas

**Comprobado hoy (17/11/2026) en fuente oficial**

- Claude Sonnet 5.5, Haiku 5.5 y Opus 5.5, Gemini 3.1 y 2.5 Flash Image, los vectores de Gemini y Mistral OCR figuran en la multi-región UE de Vertex AI; Veo, Omni, Imagen y Nano Banana 2.1 no figuran: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/data-residency
- Google no entrena con datos del cliente sin permiso; qué guarda y cómo apagarlo: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/data-governance
- La API directa de Anthropic solo ofrece inferencia «global» o «EE. UU.» y guarda en EE. UU.: https://platform.claude.com/docs/en/manage-claude/data-residency
- Mistral: direcciones regionales UE y EE. UU., +10 %, sin lotes, archivos ni agentes: https://docs.mistral.ai/inference/regional-inference
- Black Forest Labs: dirección `api.eu.bfl.ai` limitada a regiones UE; resultados que caducan a los 10 minutos: https://docs.bfl.ai/api_integration/integration_guidelines
- Nombres y precios de los modelos de imagen y de Omni: https://aistudio.google.com/docs/pricing (los últimos 11.663 caracteres de la página no se leyeron)
- OpenAI no entrena con datos de la API: https://developers.openai.com/api/docs/guides/your-data
- Polotno sigue sin precio público: https://polotno.com/pricing · Epidemic Sound: https://www.epidemicsound.com/business/developers/
- Reglamento (UE) 2026/1744, resumen de un despacho, no el texto oficial: https://www.cuatrecasas.com/es/spain/propiedad-intelectual/art/se-publica-reglamento-omnibus-digital-ia

**Intentado y sigue sin verificar.** Veo y Omni en regiones europeas (existen en Vertex, pero las celdas de región de https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/locations no se pudieron leer); precios de Vertex (página cortada); Claude en el perfil UE de Amazon Bedrock; alcance de la región Europa de OpenAI para imagen y moderación; región UE y entrenamiento en Runway y fal; texto oficial del Reglamento 2026/1744.

**Contradicciones entre informes y cómo se han resuelto**

1. Dónde se exporta la imagen (función de Vercel o contenedor): contenedor (2.6).
2. Vídeo con IA: el informe 03 ponía primero a fal o Runway; con el criterio de datos delegado pasa primero Google, y la función nace apagada (2.3).
3. Precio de imagen: el informe 02 costeaba un modelo que no está en la UE; se recalcula con el que sí (2.2).
4. OpenAI en Europa: un informe decía que la inferencia seguía en EE. UU. y otro que había región europea. Su anuncio habla de proceso en la región para servicios elegibles, sin confirmar imagen ni moderación: queda fuera por defecto.
5. Ortografía y moderación: el informe 06 proponía LanguageTool propio y la moderación de OpenAI; se sustituyen por la comprobación con IA en la UE (2.11).

**Instrucciones dirigidas a agentes encontradas en páginas web (ignoradas).** La documentación de Black Forest Labs abre con una frase para herramientas automáticas que pide leer antes su índice de páginas; no se siguió. Los informes 01 y 04 ya anotaron que una página de la documentación de Supabase pedía a los agentes enviar un informe de opinión; tampoco se siguió.

**Pendiente de este documento.** `ESTADO.md` no se ha tocado; cuando el dueño decida, sus nueve preguntas de la Fase 2 deben actualizarse con lo resuelto aquí.
