// Único sitio donde vive el nombre del producto y los límites compartidos.
export const APP_NAME = 'RRSS';

/**
 * ¿Hay IA de texto conectada en este entorno? La función `ai-generate` solo
 * funciona con un proveedor configurado en el servidor; mientras no lo haya, los
 * botones de redactar, comprobar el tono y proponer el perfil no se enseñan
 * (lo que no funciona no sale en la interfaz). Se activa con
 * `VITE_AI_TEXT_ENABLED=true` en el despliegue que tenga proveedor.
 */
export function aiTextEnabled(): boolean {
  return import.meta.env.VITE_AI_TEXT_ENABLED === 'true';
}

/**
 * ¿Hay copiloto por voz en el editor? Necesita la IA de texto (la tarea
 * `editor.copilot` de `ai-generate`, con proveedor en el servidor) y su propio
 * interruptor, `VITE_AI_VOICE_COPILOT_ENABLED=true`. Sin cualquiera de los dos,
 * el botón «Dictar» no sale. Tampoco sale si el navegador no tiene dictado
 * (Web Speech API): eso lo decide el editor (docs/copiloto-voz.md).
 */
export function aiVoiceCopilotEnabled(): boolean {
  return aiTextEnabled() && import.meta.env.VITE_AI_VOICE_COPILOT_ENABLED === 'true';
}

/**
 * ¿Hay generación de imágenes con IA en este entorno? Igual que el texto: la
 * función `ai-media` solo genera con un modelo de imagen configurado en el
 * servidor; sin él, el botón «Con IA» del editor no se enseña. Se activa con
 * `VITE_AI_IMAGE_ENABLED=true` en el despliegue que lo tenga.
 */
export function aiImageEnabled(): boolean {
  return import.meta.env.VITE_AI_IMAGE_ENABLED === 'true';
}

/**
 * ¿Se puede editar fotos con IA (quitar el fondo, ampliar) en este entorno?
 * Interruptor propio, `VITE_AI_PHOTO_EDIT_ENABLED=true`; además, cada acción
 * solo sale si el servidor tiene un modelo para ella (`ai-media`,
 * `photo.options`). Sin proveedor, esas acciones no aparecen. Lo que se hace
 * sin IA (recortes, luz, color, nitidez, fondo liso) no depende de esto
 * (docs/edicion-fotos.md).
 */
export function aiPhotoEditEnabled(): boolean {
  return import.meta.env.VITE_AI_PHOTO_EDIT_ENABLED === 'true';
}

/**
 * ¿Hay un trabajador de medios (worker/) desplegado que vacíe la cola? Sin él,
 * un reel encargado se quedaría «en cola» para siempre: la pantalla de reels no
 * se enseña (lo que no funciona no sale en la interfaz). Se activa con
 * `VITE_MEDIA_WORKER_ENABLED=true` en el despliegue que tenga trabajador.
 */
export function mediaWorkerEnabled(): boolean {
  return import.meta.env.VITE_MEDIA_WORKER_ENABLED === 'true';
}

/**
 * ¿Se ofrecen subtítulos automáticos en el editor de reels? Interruptor propio,
 * `VITE_REEL_SUBTITLES_ENABLED=true`; además, el servidor tiene que tener
 * OpenAI configurado (`ai-transcribe`, disponibilidad `reelSubtitles`). Sin
 * cualquiera de los dos, los botones no salen; los subtítulos escritos a mano
 * sí (docs/editor-reels.md).
 */
export function reelSubtitlesEnabled(): boolean {
  return import.meta.env.VITE_REEL_SUBTITLES_ENABLED === 'true';
}

/**
 * ¿Hay publicación en redes en este entorno? Hace falta la aplicación de Meta
 * del producto y las funciones `social-connect` y `social-publish` configuradas
 * (docs/publicacion.md). Sin ella no se enseña conectar cuentas ni programar
 * para publicar (lo que no funciona no sale en la interfaz); el calendario de lo
 * ya programado sí se puede ver. Se activa con `VITE_SOCIAL_PUBLISHING_ENABLED=true`.
 */
export function socialPublishingEnabled(): boolean {
  return import.meta.env.VITE_SOCIAL_PUBLISHING_ENABLED === 'true';
}

/**
 * ¿Hay biblioteca con Google Drive en este entorno? Hace falta el cliente OAuth
 * de Google del producto y la función `drive-media` configurada
 * (docs/biblioteca-drive.md). Sin ella no se enseña «Google Drive» en los
 * ajustes ni «Desde Google Drive» en la biblioteca; con ella, añadir fotos de
 * Drive solo sale si la organización tiene una conexión activa. Se activa con
 * `VITE_DRIVE_LIBRARY_ENABLED=true`.
 */
export function driveLibraryEnabled(): boolean {
  return import.meta.env.VITE_DRIVE_LIBRARY_ENABLED === 'true';
}

export const STORAGE_BUCKET = 'brand-media';
/** Tope del cubo (ver supabase/migrations/…_storage_brand_media.sql). */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const ALLOWED_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/quicktime',
  'video/webm',
  'audio/mpeg',
  'audio/mp4',
  'audio/wav',
  'application/pdf',
  'application/json',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
] as const;

export const SOURCE_MIME_TYPES = [
  'application/pdf',
  'text/plain',
  'application/json',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export const LOCALES = [
  { value: 'es', label: 'Español' },
  { value: 'en', label: 'Inglés' },
  { value: 'ca', label: 'Catalán' },
  { value: 'gl', label: 'Gallego' },
  { value: 'eu', label: 'Euskera' },
  { value: 'fr', label: 'Francés' },
  { value: 'pt', label: 'Portugués' },
  { value: 'it', label: 'Italiano' },
  { value: 'de', label: 'Alemán' },
] as const;

export const LOGO_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
