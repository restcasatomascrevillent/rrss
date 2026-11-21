# 06 · Verificador de marca, formatos por red y obligaciones legales

Fecha de la investigación: 16/11/2026. No es asesoría legal. Leyenda: **[OF]** = leído en documentación oficial en esta sesión; **[SV]** = sin verificar en fuente oficial (solo fuentes secundarias o sin fuente); **[?]** = fuentes en conflicto.

## 1. Formatos por red

Hallazgo general: la documentación oficial de las API suele dar medidas de vídeo e imagen, pero casi nunca da «caracteres visibles antes de ver más», ni zonas seguras. Esos datos son de fuentes secundarias y deben tratarse como orientativos. El verificador debe leerlos de una tabla de configuración versionada (fecha de revisión por celda), no del código.

| Red / formato | Medidas y proporción | Peso y duración | Texto, hashtags, menciones, alt | Fuente |
|---|---|---|---|---|
| **Instagram · publicación** | JPEG, ancho 320–1440 px, proporción 4:5 a 1,91:1, sRGB | 8 MB | Pie 2.200 car., 30 hashtags, 20 menciones; alt hasta 1.000 car. (solo imagen única o imagen dentro de carrusel); 3 colaboradores máx. | [OF] [IG User Media](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media) |
| **Instagram · carrusel** | Hasta 20 elementos (imagen/vídeo); los reels no entran en carruseles | — | El pie del carrusel no admite alt por vídeo | [OF] misma |
| **Instagram · reel** | MP4/MOV, H.264/HEVC, 23–60 fps, proporción 0,01:1 a 10:1 (recomendado 9:16), ancho máx. 1920, AAC ≤48 kHz | 3 s a 15 min; 300 MB; 25 Mbps máx. | Mismo pie; alt no admitido; portada JPEG 8 MB | [OF] misma |
| **Instagram · historia** | Imagen JPEG 8 MB (9:16 recomendado); vídeo 9:16 recomendado | Vídeo 3–60 s, 100 MB | Sin colaboradores | [OF] misma |
| Instagram · «ver más» | Se cita ~125 car. visibles | — | — | [SV] solo blogs ([ejemplo](https://www.sendible.com/insights/instagram-character-limit)) |
| **Facebook · reel (API)** | 9:16; mín. 540×960, recomendado 1080×1920; MP4, H.264/H.265, 24–60 fps, AAC 48 kHz ≥128 kbps | 3–90 s (60 s si va como historia de página); peso no indicado | `description` admite hashtags, límite no indicado | [OF] [Reels publishing](https://developers.facebook.com/docs/video-api/guides/reels-publishing) |
| Facebook · publicación de página | Límites de texto y foto no figuran en la guía oficial leída; programación entre 10 min y 30 días | — | — | [OF parcial](https://developers.facebook.com/docs/pages-api/posts); resto [SV] |
| **TikTok · vídeo (Content Posting API)** | MP4/WebM/MOV; H.264 (rec.), H.265, VP8, VP9; 23–60 fps; lado 360–4096 px | Hasta 10 min por API (3 min para todos los creadores, 5/10 min según cuenta); 4 GB | `title` 2.200 runas UTF-16; #/@ deben ir separados por espacio; `is_aigc` marca «creador etiquetó como IA»; `brand_content_toggle` para colaboración pagada | [OF] [media](https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide), [direct post](https://developers.tiktok.com/doc/content-posting-api-reference-direct-post) |
| TikTok · fotos | WebP/JPEG, hasta 1080p, 20 MB por imagen; límites de nº y texto: no leídos (otra página de referencia) | — | — | [OF parcial] |
| **LinkedIn · página** | Posts API admite texto, imagen, vídeo, documento, artículo, multi-imagen, encuesta; carrusel orgánico NO soportado (solo patrocinado) | — | Menciones `@[Nombre](urn:li:organization:…)` con coincidencia exacta y sensible a mayúsculas; hashtags en el texto. Límite de 3.000 car. y corte ~210 (escritorio) / ~140 (móvil) | [OF] [Posts API](https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api); límites de texto y vídeo [SV] ([ejemplo](https://eden.so/blog/linkedin-character-limits/)) |
| **X** | Imagen JPG/PNG/GIF/WEBP; GIF recomendado ≤1280×1080; vídeo 32×32 a 1280×1024, proporción 1:3 a 3:1, ≤60 fps, H.264 + AAC-LC | Imagen 5 MB; GIF 15 MB; vídeo post 0,5 s–20 min y 8 GB (cuenta estándar), hasta 125 min y 16 GB (Premium) | Longitud del post y hashtags: no figuran en la página leída | [OF] [media best practices](https://docs.x.com/x-api/media/quickstart/best-practices); texto [SV] |
| **YouTube Shorts** | Vertical; máx. 1080p subido | Hasta 3 min; título máx. 100 car. | Descripción/hashtags: no indicados en la página leída | [OF parcial] [Shorts](https://support.google.com/youtube/answer/10059070) |
| **Pinterest** | Proporción 2:3 (1000×1500); PNG/JPEG; imagen hasta 20 MB (escritorio) / 32 MB (app); vídeo 1:2 a 1,91:1, MP4/MOV/M4V | Título hasta 100 car. (primeros ~40 visibles); descripción 800; vídeo 4 s–15 min, 2 GB | Alt: no cubierto | [OF] pero es la página de **anuncios** ([specs](https://help.pinterest.com/business/article/pinterest-product-specs)); aplicar a pins orgánicos es [SV] |
| **Google Business Profile** | Foto de publicación 4:3; JPG/PNG 10 KB–5 MB | Resumen ~1.500 car. | `topicType` STANDARD/EVENT/OFFER/ALERT; CTA BOOK/ORDER/SHOP/LEARN_MORE/SIGN_UP/CALL; la API solo admite `sourceUrl` en el medio | API [OF] ([LocalPost](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts)); medidas y 1.500 car. [SV] ([ejemplo](https://www.ayrshare.com/docs/media-guidelines/google-business-profile.md)) |

**Zonas seguras en vídeo vertical.** No hay cifra oficial publicada que haya podido leer. La cifra más citada, atribuida a la guía de reels de Meta, es dejar libre el 14 % superior (~270 px), el 35 % inferior (~670 px) y ~6 % por lado en 1080×1920 [SV] ([Hopper](https://www.hopperhq.com/blog/instagram-reel-size/)). Otras guías dan cajas distintas (1080×1420, 900×1400). Propuesta: una sola caja conservadora, configurable, y avisar «orientativo».

**Conflictos a resolver con una prueba real:** vídeo de Pinterest (5 vs 15 min según la página); alt de Instagram en la app (100 recomendado vs 1.000 de la API); proporción mínima de reels (0,01:1 vs 0,1:1 en historias según la misma página).

## 2. Verificador sin IA (reglas comprobables)

Todas devuelven `pasa / no pasa / no aplicable` con el dato medido y la regla que lo exige (trazable).

| Comprobación | Método | Biblioteca (licencia) |
|---|---|---|
| Contraste de color | WCAG 2.2: 4,5:1 texto normal, 3:1 texto grande (≥18 pt o 14 pt negrita) y 3:1 en gráficos [OF](https://www.w3.org/TR/WCAG22/#contrast-minimum). Los logotipos están exentos | Fórmula propia (10 líneas) o culori |
| Distancia de color a la paleta | Delta E 2000 (CIEDE2000) entre colores dominantes y colores de marca; umbral configurable por marca | **culori** MIT (incluye `differenceCiede2000`) [OF](https://github.com/Evercoder/culori) |
| Paleta dominante de una imagen | Cuantizar en servidor (reducir tamaño, mediana/k-means, pasar a Lab) | `sharp` (Apache-2.0), `node-vibrant`, `colorthief`: licencias [SV], confirmar en repo |
| Logotipo y zona de respeto | Coincidencia de plantilla/rasgos contra el logotipo del perfil y margen mínimo en múltiplos de la altura del logo | OpenCV.js (Apache-2.0) [SV]; el logotipo propio tiene fondo conocido, lo que hace viable una plantilla. Con IA solo si la plantilla falla |
| Tipografías | Solo es comprobable en piezas **generadas por el propio SaaS** (HTML/SVG/lienzo): se lee la fuente declarada. En imagen ya rasterizada no es fiable sin IA: marcar «no verificable» | `fontkit`/`opentype.js` [SV] para validar que el archivo de fuente existe |
| Palabras y temas vetados | Normalizar (minúsculas, sin tildes, lematización simple), coincidencia por palabra completa y frases; temas vetados necesitan lista de sinónimos o IA | Código propio; `snowball`/`natural` [SV] |
| Longitud, hashtags, menciones, enlaces | Contar con la tabla de la sección 1; contar caracteres como la red (UTF-16 en TikTok) | Código propio, `Intl.Segmenter` |
| Emojis | Contar y listar; comparar con tope de la marca | `emoji-regex` (MIT) [SV] |
| Legibilidad en español | Fernández-Huerta: L = 206,84 − 0,60·P − 1,02·F (P = sílabas/100 palabras, F = palabras/frase). INFLESZ: reinterpreta Szigriszt-Pazos con escala propia [SV](https://xlinguae.eu/files/XLinguae1_2024_12.pdf). Tramos de dificultad distintos según fuente: usar solo como indicador relativo | Código propio; falta contador de sílabas en español (regla de separación silábica) |
| Ortografía y gramática | LanguageTool: núcleo LGPL-2.1+ y puede autoalojarse (Java 17) [OF](https://github.com/languagetool-org/languagetool). API de pago: tramos de 100 a 10.000 llamadas/día, 60.000 car. por petición, servidores en Alemania, precios no visibles en la página [OF parcial](https://languagetool.org/proofreading-api). | Autoalojado = coste de servidor; API de pago = pedir presupuesto |
| Formato técnico del medio | Medir ancho, alto, proporción, peso, duración y códec con ffprobe | `sharp`, `ffprobe` (LGPL/GPL según compilación: abogado) |
| Procedencia | Leer y verificar manifiesto C2PA del archivo de entrada | `c2pa-node` / `c2pa-web`, MIT; node 22+ [OF](https://github.com/contentauth/c2pa-js) |

## 3. Verificador con IA

**Cuándo hace falta:** tono de voz, público, coherencia con el perfil, temas vetados por significado (no por palabra), si una imagen respeta normas de estilo («fondo limpio», «sin personas»), si el logotipo se ve o se deforma, y revisión de afirmaciones.

**Diseño recomendado**
- Una rúbrica por dimensión, con criterios binarios o escala corta (1–4) con anclas escritas, no «puntúa de 1 a 10». Salida estructurada con JSON validado: `{criterio, veredicto, cita_textual, razón_corta}`. La cita textual permite comprobar la afirmación automáticamente (que exista en la pieza); regla del producto «lo que se afirma debe poder comprobarse».
- Ejemplos del propio cliente: 3–5 piezas aprobadas y 3–5 rechazadas (con motivo) del historial, elegidas por similitud de red y tema; versionadas con el perfil.
- El juez nunca decide solo: devuelve «cumple / dudoso / no cumple»; «dudoso» va a persona. Las reglas del apartado 2 se ejecutan antes y sus resultados se pasan al juez como hechos medidos.
- Pedir una explicación **después** del veredicto no mejora la fiabilidad por sí sola; sí ayuda exigir cita.

**Cómo medir la fiabilidad** (fuentes secundarias, tratar umbrales como heurística)
1. Conjunto de calibración etiquetado por personas (≥ 50–100 piezas por marca grande; para una marca nueva, usar el histórico de aprobaciones).
2. Acuerdo corregido por azar (kappa de Cohen), no porcentaje bruto; reportar ambos [SV](https://arxiv.org/abs/2606.19544).
3. Repetir cada juicio 3 veces: medir variación.
4. Sesgo de posición/orden cuando se comparan variantes: evaluar en ambos órdenes.
5. Repetir el conjunto tras cualquier cambio de modelo, prompt o rúbrica.
6. Mostrar en la interfaz la «confianza medida» de cada comprobación, no una cifra inventada.

**Visión:** los modelos de Claude aceptan imágenes hasta 8000×8000 px [OF](https://platform.claude.com/docs/en/build-with-claude/vision). Útil para «¿hay logotipo?», «¿texto legible?», «¿encaja con la paleta?»; no sustituye al Delta E ni al contraste, que son medibles.

**Qué aprender del mercado (fuentes de marketing, nivel [SV])**
- Canva: controles de marca que limitan fuentes y colores a los admitidos (prevención, no comprobación posterior) [fuente](https://www.computerworld.com/article/1620901/canva-adds-ai-powered-design-tools-to-its-visual-worksuite.html).
- Frontify: comprobaciones automáticas de activos contra las directrices con lista de incidencias y puntuación [fuente](https://frontify.com/en/guide/ai-tools-for-brand-management).
- Writer y Typeface: aplicación de voz y guía de estilo; no hallé documentación técnica comparable.
- Aprendizaje: limitar al crear (paleta cerrada, fuentes cerradas) es más fiable que detectar después; combinar ambos.

## 4. Moderación y seguridad

| Servicio | Datos | Fuente |
|---|---|---|
| OpenAI `omni-moderation-latest` | Gratuito; texto e imagen (hasta 20 MB); sin audio. Con imagen: autolesión, sexual, violencia; el resto de categorías solo texto (si envías solo imagen, devuelven 0) | [OF](https://developers.openai.com/api/docs/guides/moderation) |
| Azure AI Content Safety | Nivel gratuito 5.000 textos y 5.000 imágenes/mes; precio de pago no visible | [OF parcial](https://azure.microsoft.com/en-us/pricing/details/cognitive-services/content-safety/) |
| Perspective API (Google) | Cierra el 31/12/2026; no usar | [SV](https://getstream.io/blog/perspective-api-alternative/) |

Hallazgo: los datos pasan a un tercero fuera de la UE (OpenAI): revisar con el abogado el contrato de tratamiento y la transferencia.

**Qué bloquear antes de publicar (propuesta):** vetados de la marca; datos personales detectables (teléfonos, correos, DNI) en el texto; enlaces a dominios no autorizados; imágenes marcadas por moderación; promesas de salud o precios sin base [SV, criterio del producto]; menores en imágenes generadas con IA; personas reales o parecido de personas reales sin consentimiento; contenido comercial sin identificar como publicidad (ver sección 5).

## 5. Obligaciones legales (UE y España)

### 5.1 Reglamento de IA, artículo 50 [OF](https://artificialintelligenceact.eu/article/50/)
- **50(2) proveedores de IA generativa:** marcar la salida sintética (audio, imagen, vídeo, texto) en formato legible por máquina y detectable. No se aplica a edición asistida estándar.
- **50(4) responsables del despliegue:** revelar los *deepfakes* (imagen, audio, vídeo generados o manipulados que parezcan reales); en obras claramente artísticas, creativas o de ficción basta con una revelación que no estorbe. También texto generado y publicado para informar al público sobre asuntos de interés público, salvo revisión humana con responsabilidad editorial.
- **Fechas:** 50(1), 50(3), 50(4) se aplican desde el **02/08/2026** (vigente). La única prórroga de la Omnibus de IA, Reglamento (UE) 2026/1744 (publicado el 24/07/2026, en vigor el 27/07/2026 según firmas jurídicas) es para 50(2): **02/12/2026**, y según Orrick **solo para sistemas ya comercializados antes del 02/08/2026** [SV](https://www.orrick.com/en/Insights/2026/07/EU-AI-Act-Update-Digital-Omnibus-Finalizes-8-Compliance-Changes). No pude leer el texto de EUR-Lex: confirmar la fecha y el alcance con el abogado.
- **Código de buenas prácticas** sobre marcado y etiquetado: versión final publicada el 10/06/2026, voluntario; incluye iconos europeos de etiquetado [OF](https://digital-strategy.ec.europa.eu/en/news/commission-publishes-code-practice-marking-and-labelling-ai-generated-content).
- **Consecuencia para el SaaS:** el SaaS es, probablemente, responsable del despliegue (y proveedor de un sistema que integra modelos de terceros): hay que decidir con el abogado quién es proveedor de qué. Un cliente que publica una imagen realista generada es quien debe revelarla. El producto debe tener un campo «generado con IA» por pieza y rastrear cuándo hubo revisión humana.

### 5.2 España
- **Anteproyecto de ley para el buen uso y la gobernanza de la IA:** aprobado por el Consejo de Ministros el 11/03/2025; enviado a las Cortes (BOCG 12/06/2026, enmiendas hasta 30/06/2026); **pendiente, no vigente** hasta donde he podido comprobar. Prevé que no etiquetar contenido generado o manipulado sea infracción grave y multas de hasta 35 millones de euros [SV](https://www.legaltoday.com/actualidad-juridica/noticias-de-derecho/el-gobierno-aprueba-una-ley-para-el-uso-etico-de-la-ia-que-obliga-a-identificar-contenido-generado-con-ella-2025-03-11/), AESIA como supervisora.
- **Publicidad e influencers:** Real Decreto 444/2024: «usuario de especial relevancia» si ingresos ≥ 300.000 € (art. 3) y audiencia ≥ 1 M de seguidores en una red o 2 M entre varias, con ≥ 24 vídeos al año (art. 4) [OF](https://www.boe.es/buscar/act.php?id=BOE-A-2024-8716). Estos usuarios quedan sujetos a obligaciones de la Ley 13/2022 (art. 94 y siguientes). La comunicación comercial debe diferenciarse claramente (art. 121.3) y se prohíbe la encubierta (art. 122.3) [SV](https://www.legaltoday.com/opinion/articulos-de-opinion/la-cnmc-sanciona-la-emision-de-comunicaciones-comerciales-audiovisuales-encubiertas-en-las-que-no-se-advierte-de-forma-clara-que-poseen-caracter-publicitario-2026-06-15/). Un restaurante pequeño casi nunca llega a esos umbrales, pero la publicidad encubierta se rige también por la Ley de Competencia Desleal [SV]. El Código de conducta de Autocontrol/AEA/IAB (versión vigente desde 01/10/2025) es de autorregulación: vincula a sus socios y adheridos [SV](https://www.cuatrecasas.com/es/latam/propiedad-intelectual/art/nuevo-codigo-conducta-publicidad-influencers-contenido-claves-practicas).
- **Derechos de autor:** en España y la UE la protección va ligada a la creación humana; el resultado puramente generado sin aportación humana significativa es en general desprotegido, sin sentencias de referencia [SV](https://oficinaeconomicagalicia.xunta.gal/en/faqs-ambitos/does-ai-generated-content-have-copyright/). No pude leer fuentes oficiales (Ministerio de Cultura, texto refundido). Derecho de imagen y parecido: no investigado a fondo; consultar.

### 5.3 Etiquetas por plataforma
| Red | Qué exige / hace | Fuente |
|---|---|---|
| Meta | Etiqueta «AI info» cuando detecta indicadores estándar de la industria o cuando la persona lo declara; la metodología sigue cambiando | [OF](https://transparency.meta.com/governance/tracking-impact/labeling-ai-content/) |
| TikTok | Exige etiquetar contenido realista generado por IA; detecta C2PA; la API tiene `is_aigc`; anuncios con regla más estricta | Newsroom [SV](https://newsroom.tiktok.com/tiktok-ssa-shares-more-ways-to-spot-shape-and-understand-ai-generated-content?lang=en-ZA); API [OF] |
| YouTube | Declarar contenido realista alterado o sintético (persona haciendo algo que no hizo, evento real alterado, escena realista inventada); no hace falta para generación de ideas, guion, título o miniatura; puede etiquetar automáticamente por C2PA; incumplir reiteradamente puede acarrear sanciones | [OF](https://support.google.com/youtube/answer/14328491) |
| LinkedIn | Muestra el icono C2PA si el archivo trae credenciales firmadas; no detecta IA por sí mismo | [OF](https://www.linkedin.com/help/linkedin/answer/a6282984) |
| X, Pinterest, GBP | No investigado | — |

**C2PA:** las credenciales viajan en el archivo y varias redes las leen; se pierden si se recomprime o exporta sin ellas. Propuesta: conservar las credenciales del generador al subir y añadir una en la salida del SaaS (c2pa-node firma, MIT).

## 6. Propuesta de primera versión del verificador

**A. Sin IA (coste marginal ≈ 0; se ejecuta siempre y bloquea).** En este orden:
1. Formato técnico del medio frente a la red de destino (peso, proporción, duración, códec).
2. Longitud del texto, hashtags, menciones, enlaces (tabla de la sección 1).
3. Palabras y frases vetadas; hashtags obligatorios/prohibidos; CTA obligatoria presente.
4. Ortografía y gramática (LanguageTool autoalojado primero).
5. Contraste WCAG del texto sobre fondo en piezas generadas por el SaaS.
6. Delta E de la paleta dominante frente a la paleta de marca.
7. Número de emojis y mayúsculas; legibilidad Fernández-Huerta (solo aviso).
8. Moderación gratuita (OpenAI) de texto e imagen y detección de datos personales.
9. Campo «generado con IA» por pieza + lectura de credenciales C2PA del archivo; aviso si falta etiqueta de plataforma.
10. Logotipo por plantilla y respeto de zona segura (aviso, no bloqueo).

**B. Con IA (solo tras A; «dudoso» va a persona).** Coste por pieza con precios de Anthropic del 16/11/2026: Haiku 5.5 a 0,10 $/MTok de entrada y 0,50 $/MTok de salida, Sonnet 5.5 a 2 $ y 10 $ [OF](https://platform.claude.com/docs/en/about-claude/pricing). Supuestos míos: 2.500 tokens de entrada (perfil + rúbrica + pieza), 400 de salida y una imagen de ~1.600 tokens; Batch API tiene un 50 % de descuento.

| Comprobación | Modelo | Coste aprox. por pieza y variante |
|---|---|---|
| 1. Tono de voz y público (texto, con ejemplos del cliente) | Haiku 5.5 | ≈ 0,0005 $ |
| 2. Mismo, modelo de más calidad (si Haiku da «dudoso») | Sonnet 5.5 | ≈ 0,009 $ |
| 3. Temas vetados por significado y afirmaciones arriesgadas | Haiku 5.5 | ≈ 0,0005 $ |
| 4. Imagen frente a normas de estilo (visión) | Sonnet 5.5 | ≈ 0,012 $ (texto + imagen) |
| 5. Logotipo/legibilidad si la plantilla falla | Sonnet 5.5 | ≈ 0,008 $ |

Una pieza con 6 variantes por red pasando todo el nivel B con Sonnet ronda 0,07–0,10 $; con Haiku en texto y Sonnet solo en imagen, ~0,03 $. Estas cifras son estimaciones propias, no medidas: medir con el conjunto de calibración antes de fijar precio al cliente.

## 7. Riesgos legales y preguntas para el abogado
1. ¿El SaaS es «proveedor» o «responsable del despliegue» según el art. 50, dado que usa modelos de terceros y entrega texto/imagen a clientes? ¿Quién marca y quién revela?
2. Alcance exacto de la prórroga a 02/12/2026 para 50(2) (¿solo sistemas ya comercializados?), y si afecta a nuestras versiones nuevas.
3. ¿Texto generado y publicado por una empresa en su canal cuenta como «asunto de interés público» (50(4))? ¿Basta la revisión humana del cliente?
4. Estado y contenido final de la ley española; ¿añade obligaciones al etiquetado (siglas «AI») y quién las sufre?
5. Publicidad: cuándo un post de restaurante es comunicación comercial identificable, qué rótulo usar, y si hay obligaciones propias de la página si colabora con personas influyentes.
6. Titularidad y exposición por infracción de derechos de autor, de marcas y de imagen en resultados generados; indemnización contractual de los proveedores de modelos.
7. RGPD: moderación enviada a terceros fuera de la UE, y fotos de personas en el perfil de marca.
8. Si el verificador falla («aprobó» algo ilegal): cláusulas de responsabilidad y lenguaje de la interfaz («ayuda a revisar», nunca «garantiza el cumplimiento»).

## 8. Preguntas abiertas / no verificado
- Límites de texto y «ver más» de Facebook, LinkedIn, X, Pinterest orgánico, YouTube (descripción) y GBP: sin fuente oficial leída.
- Zonas seguras: sin cifra oficial; valores de terceros.
- Precios de LanguageTool API y de Azure Content Safety de pago: no visibles.
- Escalas de legibilidad (bandas de INFLESZ y Fernández-Huerta) en fuente primaria (Barrio-Cantalejo, 2008).
- Licencias de sharp, node-vibrant, colorthief, OpenCV.js, emoji-regex, fontkit: de memoria; confirmar en cada repositorio.
- Texto de EUR-Lex del Reglamento (UE) 2026/1744 y del artículo 113.
- Reglas actuales de X, Pinterest y GBP sobre contenido generado por IA.
- Fortaleza real de Canva/Adobe/Writer/Typeface en comprobación de marca: solo material comercial.

## 9. Fuentes (todas consultadas el 16/11/2026)
Instagram media: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/media · Facebook reels: https://developers.facebook.com/docs/video-api/guides/reels-publishing · Facebook páginas: https://developers.facebook.com/docs/pages-api/posts · TikTok: https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide y https://developers.tiktok.com/doc/content-posting-api-reference-direct-post · LinkedIn: https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api · X: https://docs.x.com/x-api/media/quickstart/best-practices · YouTube Shorts: https://support.google.com/youtube/answer/10059070 · YouTube IA: https://support.google.com/youtube/answer/14328491 · Pinterest: https://help.pinterest.com/business/article/pinterest-product-specs · GBP: https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts · WCAG 2.2: https://www.w3.org/TR/WCAG22/ · culori: https://github.com/Evercoder/culori · LanguageTool: https://github.com/languagetool-org/languagetool y https://languagetool.org/proofreading-api · c2pa-js: https://github.com/contentauth/c2pa-js · LinkedIn C2PA: https://www.linkedin.com/help/linkedin/answer/a6282984 · Meta etiquetas: https://transparency.meta.com/governance/tracking-impact/labeling-ai-content/ · OpenAI moderación: https://developers.openai.com/api/docs/guides/moderation · Azure: https://azure.microsoft.com/en-us/pricing/details/cognitive-services/content-safety/ · Anthropic precios y visión: https://platform.claude.com/docs/en/about-claude/pricing , https://platform.claude.com/docs/en/build-with-claude/vision · Art. 50: https://artificialintelligenceact.eu/article/50/ · Código de buenas prácticas: https://digital-strategy.ec.europa.eu/en/news/commission-publishes-code-practice-marking-and-labelling-ai-generated-content · Omnibus: https://www.orrick.com/en/Insights/2026/07/EU-AI-Act-Update-Digital-Omnibus-Finalizes-8-Compliance-Changes · RD 444/2024: https://www.boe.es/buscar/act.php?id=BOE-A-2024-8716 · Fiabilidad de jueces LLM: https://arxiv.org/abs/2606.19544 (solo extractos).
