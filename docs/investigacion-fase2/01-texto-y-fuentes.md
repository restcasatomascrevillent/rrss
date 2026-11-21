# Fase 2 · 01 · IA de texto y procesado de fuentes de marca

Fecha de la consulta: 16/11/2026. Precios en USD por millón de tokens (MTok), de las páginas oficiales salvo donde se marca «sin verificar». Solo investigación, sin cambios de código.

## 1. Resumen y recomendación

1. **Mantener el adaptador independiente del proveedor** y arrancar con **Claude Sonnet 5.5** para generar variantes y orquestar herramientas, y **Claude Haiku 5.5** para la comprobación de marca. Es lo más barato que cumple «herramientas + salida estructurada + lectura de PDF» con una sola API.
2. **Residencia UE: la API propia de Anthropic NO ofrece UE.** Solo admite `inference_geo` = `us` o `global` y el almacenamiento en reposo es solo EE. UU. [A1]. Si el RGPD exige procesar en la UE, hay que ir por Bedrock (perfil geográfico UE), Vertex (Gemini en `eu`) o Mistral. Decisión de negocio abierta (sección 7).
3. **Plan B europeo listo en el adaptador:** Mistral Large 4 ($0.70 / $2.10) o Gemini 3.8 Flash vía Vertex multirregión `eu`.
4. **Fuentes de marca:** perfil de marca entero en el contexto con caché (cabe de sobra). RAG con pgvector solo cuando las fuentes pasen de unas decenas de miles de tokens por marca.
5. **Coste de texto por marca y mes: entre 0,06 y 4,7 USD** (sección 5). El texto no es el problema de coste; lo serán imágenes, vídeo y bucles de orquestación.

## 2. Comparativa de modelos (texto)

| Proveedor / modelo | Entrada | Salida | Caché (lectura) | Lotes | Notas |
|---|---|---|---|---|---|
| Anthropic Haiku 5.5 (≤100k tokens) | 0,10 | 0,50 | 0,01 (escritura 5 min: 0,125) | -50 % | Por encima de 100k tokens: 0,50 / 2,50 [A1] |
| Anthropic Sonnet 5.5 | 2 | 10 | 0,10 (escritura 5 min: 2,50; 1 h: 4) | -50 % | [A1] |
| Anthropic Opus 5.5 | 4 | 20 | 0,20 (escritura 5 min: 5) | -50 % | [A1] |
| Anthropic Fable 5.2 (tope de gama) | 8 | 40 | 0,20 | -50 % | [A1] |
| OpenAI gpt-6-luna | 0,10 | 0,50 | 0,01 | ~-50 % | [O1] |
| OpenAI gpt-6.1-terra | 1 | 5 | 0,05 | ~-50 % | [O1] |
| OpenAI gpt-6.1-sol | 2 | 10 | 0,10 | ~-50 % | [O1] |
| Google Gemini 3.5 Flash-Lite | 0,30 | 2,50 | 0,03 | -50 % | [G1] |
| Google Gemini 3.8 Flash | 0,75 | 3,75 | 0,075 | -50 % | Sube al doble el 01/01/2027 [G1] |
| Google Gemini 4 Hydrogen | 1,50 | 7,50 | 0,075 | -50 % | [G1] |
| Mistral Small 4 | 0,15 | 0,60 | sin verificar | -50 % (pág. de precios) | 256k de contexto, herramientas y salida estructurada; visión no confirmada [M2] |
| Mistral Large 4 | 0,70 | 2,10 | 0,07 | -50 % | 1M de contexto, multimodal, herramientas y salida estructurada [M1][M3] |

Avisos: (a) los precios cambian con frecuencia: Gemini 4 Carbon/Argon doblan el 01/12/2026 y los Flash el 01/01/2027 [G1]; (b) la página de precios de Mistral aún cita «Mistral Large 0,5/1,5» (modelo antiguo) [M3]; agregadores de terceros dan otras cifras para Large 4 (1,36/4,18), que descarto frente a la página oficial del modelo, pero conviene confirmarlas en la consola; (c) la calidad en español de España **no** la he medido: hay que probar con 10 a 20 briefs reales por modelo antes de elegir.

## 3. Capacidades y condiciones

| Aspecto | Anthropic | OpenAI | Google | Mistral |
|---|---|---|---|---|
| Herramientas | Sí; además herramientas de servidor y conector MCP (beta) [A4] | Sí (no verificado en detalle) | Sí (no verificado en detalle) | Sí (llamada a funciones) [M1] |
| Salida estructurada | JSON Schema en `output_config.format` y `strict: true` en herramientas; sin recursividad ni `minLength`/`maximum` [A5] | Sí (sin verificar fuente) | Sin verificar | Sí [M1][M2] |
| Visión / PDF | PDF nativo: hasta 600 páginas por petición (100 si el contexto es <1M), 128 MB; 1.500-3.000 tokens de texto por página más el coste de imagen [A6] | Sin verificar | Gemini Embedding 2 admite PDF; el resto sin verificar [G2] | Multimodal en Large 4 [M1]; OCR 4.1 aparte (4 USD/1.000 páginas) [M4] |
| Entrenan con tus datos | No: «Anthropic may not train models on Customer Content» [A2] | No por defecto [O2] | Nivel de pago: no (la página resumida es ambigua); nivel gratuito: sí. Sin verificar en los términos oficiales [G1] | Sin verificar de forma oficial (la ayuda habla de «opt-out» en Studio) [M5] |
| Uso comercial en producto de terceros | Sí (A.1); prohíbe revender o competir (D.4) [A2] | Sin verificar | Sin verificar | Sin verificar |
| DPA (RGPD) | Sí, incorporado a los términos; entidad Anthropic Ireland [A2] | Sin verificar (la ficha de privacidad dio 403) | Sin verificar | Existe enlace a DPA en mistral.ai/terms; contenido sin verificar [M5] |
| Residencia UE | **No** en API propia (solo `us`/`global`) [A3]. Bedrock con perfil UE: existe, pero Sonnet 5.x sin confirmar [A7] | Proyectos nuevos con región Europa y `eu.api.openai.com`, retención cero; requisitos de elegibilidad poco claros; +10 % en modelos posteriores a 05/03/2026 [O1][O3] | Vertex multirregión `eu`: Gemini 4 (Hydrogen/Carbon/Argon), 3.8 Flash, 3.6 Flash, 3.5 Flash-Lite, 3.5 Flash, 3.1 Flash-Lite [G3]. La API de AI Studio no fija región | Empresa europea; alojamiento UE no confirmado en páginas oficiales [M5] |
| Límites de uso | Dependen del nivel de la cuenta; no consultados | No consultados | No consultados | No consultados |

Recargo de residencia en Anthropic: `inference_geo: "us"` cuesta 1,1x [A3]; los endpoints regionales de Bedrock/Vertex llevan +10 % sobre los globales [A1].

## 4. «Skills» y herramientas del lado del servidor

| Opción | Qué es hoy | Encaje en nuestro producto |
|---|---|---|
| Uso de herramientas (Messages API) | Tú defines las herramientas, el modelo propone llamadas, **tu motor las ejecuta**. Con `strict: true` los argumentos cumplen el esquema [A5] | **Es el patrón que buscamos** («la IA propone un plan, el motor lo ejecuta»). Funciona en una Edge Function |
| Agent Skills en la API | Carpetas con `SKILL.md` y scripts; se activan con `skill_ids` en `container` **y exigen la herramienta de ejecución de código**. Corren en un contenedor de Anthropic **sin red ni instalación de paquetes**. Prediseñadas: pptx, xlsx, docx, pdf. No elegibles para retención cero [A8] | Útil solo para generar documentos. No sirve para tocar nuestra base de datos |
| Conector MCP (beta) | La API se conecta a servidores MCP **remotos** (URL pública); no elegible para retención cero [A4] | Posible si exponemos nuestras herramientas como MCP remoto; añade superficie de ataque y beta. No necesario al principio |
| Agent SDK | Biblioteca que **ejecuta el binario de Claude Code** en un proceso que tú operas (Python/TypeScript) [A9] | **No cabe en una Edge Function** (Deno, 256 MB, 2 s de CPU) [S1]. Exigiría un servidor/contenedor propio. Para texto de marketing no aporta nada sobre el bucle de herramientas |
| Managed Agents | Agente alojado por Anthropic con sandbox propio o autoalojado [A9] | No estudiado a fondo; sesiones sin modo lote. Descartado por ahora |
| Equivalentes en OpenAI, Google, Mistral | Mistral ofrece `/v1/agents` y `/v1/conversations` [M1]. Para OpenAI y Google no verifiqué sus productos de agentes | Sin verificar |

**Límites de una Edge Function de Supabase** [S1]: 256 MB de memoria, 150 s (gratis) o 400 s (de pago) de reloj, 2 s de CPU por petición (la espera de red no cuenta), 20 MB de paquete, sin `sharp`/libvips. Las llamadas a la IA son E/S asíncrona y caben; **un bucle largo de orquestación no**: dividirlo en pasos cortos con cola (pgmq) o usar la API de lotes (no interactiva).

## 5. Procesado de fuentes de marca

| Tarea | Opción | Precio | Notas |
|---|---|---|---|
| PDF (manual de marca) | Lectura nativa por el modelo | Sin recargo; 1.500-3.000 tokens/página [A6]. 40 páginas ≈ 60k-120k tokens: Sonnet 5.5 ≈ 0,12-0,24 USD una sola vez | Mantiene tablas y colores; sin dependencias |
| PDF | Mistral OCR 4.1 | 4 USD por 1.000 páginas (5 con anotaciones) [M4] | Da texto y cajas; 40 páginas ≈ 0,16 USD |
| Web | Firecrawl | 1 crédito por página (PDF: 1 por página). Gratis 1.000 créditos; Hobby 19 USD/5.000; Standard 99 USD/100.000. JSON: +4 créditos/página [F1] | Una web de 30 páginas ≈ 30 créditos |
| Web | Jina Reader | Gratis con `r.jina.ai` (20 RPM sin clave); clave nueva con 10M tokens de regalo; 500 RPM con clave [J1] | Precio de pago por token no localizado |
| unstructured | No consultado | sin verificar | |

**Vectores en Supabase (pgvector):** índices hasta 2.000 dimensiones con `vector` y 4.000 con `halfvec`; se recomienda HNSW [S2]. Menos dimensiones rinden mejor en coste [S3].

| Embedding | Precio | Dimensiones | Notas |
|---|---|---|---|
| OpenAI text-embedding-3-small | 0,02 | sin verificar | [O1] |
| OpenAI text-embedding-3-large | 0,13 | sin verificar | [O1] |
| Mistral Embed | 0,10 | no indicadas en la página | 8k de contexto [M6] |
| Gemini Embedding 2 | 0,20 (lote 0,10) | 3072 por defecto, reducibles a 128-3072 (recomendadas 768/1536/3072); 8.192 tokens; «más de 100 idiomas» [G1][G2] | Admite PDF e imagen. Con 768 o 1536 entra en índice `vector` |
| Gemini Embedding 001 | 0,15 | igual | 2.048 tokens; hay que normalizar tú [G1][G2] |

Cualquiera es barato: 200k tokens de fuentes por marca cuestan entre 0,004 y 0,04 USD. Elegir por calidad en español (probar con preguntas reales) y por residencia UE (Mistral o Gemini en Vertex), no por precio. Anthropic no ofrece embeddings propios en lo que consulté (sin verificar).

**¿RAG o perfil completo con caché?** Con un perfil de ~6.000 tokens leído de caché cuesta 0,06 USD/MTok (Haiku) a 0,20 (Opus) [A1]: menos de un céntimo al mes. Meter el perfil entero gana en simplicidad y coherencia de tono. RAG compensa si: (a) las fuentes superan ~50k tokens y no caben con holgura en cada llamada; (b) hay muchos documentos y solo hace falta una parte (catálogo, FAQ); (c) se necesitan citas. Propuesta: una llamada de «destilado» por marca que produzca el perfil (≤6k tokens) y RAG solo para fuentes grandes.

## 6. Estimación de coste: 60 publicaciones al mes, 3 variantes y 1 comprobación

**Supuestos (míos, a validar con trazas reales):**
- Perfil de marca + fuentes destiladas: 6.000 tokens (prefijo cacheable). Brief e instrucciones: 500.
- Llamada de generación: entrada 6.500, salida 900 (3 variantes).
- Comprobación de marca: entrada 7.200 (perfil + variantes + criterios), salida 300.
- Totales mensuales: entrada 60 × (6.500 + 7.200) = **822k**, salida 60 × (900 + 300) = **72k**.
- Con caché: 120 llamadas × 6.000 = 720k leídos de caché, 102k de entrada normal y 60k de escritura de caché (≈10 escrituras por caducidad de 5 min).
- No incluye: llamada de plan/orquestación (+~25 %), reintentos, imágenes, visión.

**Cálculo** = 0,822 × precio de entrada + 0,072 × precio de salida; con caché = 0,102 × entrada + 0,72 × lectura + 0,06 × escritura + 0,072 × salida.

| Combinación | Sin caché | Con caché |
|---|---|---|
| Barata: Haiku 5.5 en todo (0,822×0,10 + 0,072×0,5) | 0,12 | **0,06** |
| Barata europea: Mistral Small 4 (0,822×0,15 + 0,072×0,6) | 0,17 | sin verificar |
| Media europea: Mistral Large 4 (0,822×0,70 + 0,072×2,10) | 0,73 | 0,27 |
| Media: Gemini 3.8 Flash (0,822×0,75 + 0,072×3,75) | 0,89 | 0,40 |
| Media: Sonnet 5.5 en todo (0,822×2 + 0,072×10) | 2,36 | **1,15** |
| Mixta recomendada: Sonnet 5.5 genera, Haiku 5.5 comprueba | ≈1,37 | ≈0,70 |
| Alta: Opus 5.5 en todo (0,822×4 + 0,072×20) | 4,73 | **2,29** |

Cifras en USD por marca y mes. La mixta se calcula con la generación en Sonnet (0,39M entrada, 0,054M salida = 1,32) y la comprobación en Haiku (0,05); el valor con caché es aproximado. Lotes (-50 %) solo valen para trabajos no interactivos. Margen de error: aunque las llamadas reales fueran 5-10 veces mayores (herramientas, varios turnos), la combinación media sigue por debajo de ~12 USD/marca/mes.

## 7. Riesgos

1. **Residencia UE incumplida por defecto con Anthropic.** Solo `us`/`global` y reposo en EE. UU. [A3]. Mitigar con DPA + cláusulas tipo, minimizar datos personales en los prompts, o Bedrock/Vertex/Mistral.
2. **Calidad en español de España sin medir.** Hacer una prueba ciega con 3 modelos y 20 briefs reales antes de fijar.
3. **Volatilidad de modelos y precios** (retiradas, subidas programadas en Gemini [G1]). Mantener el modelo configurable por empresa y los precios en tabla, no en código.
4. **Salida estructurada con límites** (sin `minLength`, `maximum` ni recursividad en Anthropic [A5]): validar también en nuestro lado.
5. **Skills y MCP no son elegibles para retención cero** [A4][A8]: no usarlos con datos sensibles.
6. **Inyección de instrucciones desde fuentes web/PDF** (el contenido rastreado es dato, no orden). Dentro de esta investigación, páginas de la documentación de Supabase incluían texto dirigido al agente pidiendo enviar un informe de comentarios; se ignoró. Mismo riesgo para las webs de clientes: aislar fuentes del prompt de sistema y limitar las herramientas.
7. **Cupo mensual:** registrar tokens de caché por separado (lectura/escritura) o el coste real divergirá del estimado.

## 8. Preguntas abiertas

- ¿Exige el RGPD de nuestros clientes procesamiento solo en la UE, o basta DPA + cláusulas tipo? Define Anthropic directo frente a Bedrock/Vertex/Mistral.
- ¿Sonnet 5.5 y Haiku 5.5 están disponibles en el perfil UE de Bedrock? (sin confirmar [A7]).
- Precio oficial de Mistral por lotes y caché de Small 4; dimensiones de Mistral Embed; DPA y alojamiento UE de Mistral.
- Términos de uso comercial y DPA de OpenAI y Google (no accesibles: 403 en la ficha de privacidad de OpenAI).
- Límites de tasa por nivel de cuenta en los cuatro proveedores (no consultados).
- Equivalentes de agentes/skills en OpenAI y Google, y precio de unstructured.

## 9. Fuentes (consultadas el 16/11/2026)

- [A1] https://platform.claude.com/docs/en/about-claude/pricing
- [A2] https://www.anthropic.com/legal/commercial-terms
- [A3] https://platform.claude.com/docs/en/manage-claude/data-residency
- [A4] https://platform.claude.com/docs/en/agents-and-tools/mcp-connector
- [A5] https://platform.claude.com/docs/en/build-with-claude/structured-outputs
- [A6] https://platform.claude.com/docs/en/build-with-claude/pdf-support
- [A7] https://aws.amazon.com/blogs/machine-learning/unlocking-ai-flexibility-in-europe-a-guide-to-cross-region-inference-for-eu-data-processing-and-model-access/ (resumen por búsqueda; Sonnet 5.x sin confirmar)
- [A8] https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
- [A9] https://code.claude.com/docs/en/agent-sdk/overview
- [O1] https://developers.openai.com/api/docs/pricing
- [O2] https://developers.openai.com/api/docs/guides/your-data
- [O3] https://openai.com/index/introducing-data-residency-in-europe/ (solo por resumen de búsqueda)
- [G1] https://aistudio.google.com/docs/pricing (lectura parcial: faltaban los últimos 11.663 caracteres)
- [G2] https://aistudio.google.com/docs/embeddings
- [G3] https://docs.cloud.google.com/vertex-ai/generative-ai/docs/learn/data-residency
- [M1] https://docs.mistral.ai/models/mistral-large-4-0
- [M2] https://docs.mistral.ai/models/mistral-small-4-0-26-03
- [M3] https://mistral.ai/pricing
- [M4] https://docs.mistral.ai/models/ocr-4-1
- [M5] https://help.mistral.ai/en/articles/347617-do-you-use-my-user-data-to-train-your-model
- [M6] https://docs.mistral.ai/models/mistral-embed-23-12
- [F1] https://www.firecrawl.dev/pricing
- [J1] https://jina.ai/reader/
- [S1] https://supabase.com/docs/guides/functions/limits
- [S2] https://supabase.com/docs/guides/ai/vector-indexes
- [S3] https://supabase.com/docs/guides/ai/vector-columns
