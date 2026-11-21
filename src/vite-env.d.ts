/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Moneda de cuenta de la IA (ISO 4217). Sin ella, los importes van en «unidades de cuenta». */
  readonly VITE_AI_ACCOUNT_CURRENCY?: string;
  /** `true` si el servidor tiene un proveedor de IA de texto: enseña redactar, comprobar tono y proponer perfil. */
  readonly VITE_AI_TEXT_ENABLED?: string;
  /** `true` si el servidor tiene un modelo de imagen: enseña «Con IA» en el editor. */
  readonly VITE_AI_IMAGE_ENABLED?: string;
  /** `true` (junto con VITE_AI_TEXT_ENABLED) enseña el copiloto por voz del editor, si el navegador tiene dictado. */
  readonly VITE_AI_VOICE_COPILOT_ENABLED?: string;
  /** `true` si el servidor tiene modelos de edición de fotos con IA: enseña «Quitar el fondo» y «Ampliar». */
  readonly VITE_AI_PHOTO_EDIT_ENABLED?: string;
  /** `true` si hay un trabajador de medios desplegado: enseña la pantalla de reels de la biblioteca. */
  readonly VITE_MEDIA_WORKER_ENABLED?: string;
  /** `true` para ofrecer subtítulos automáticos en el editor de reels (además, OpenAI en el servidor). */
  readonly VITE_REEL_SUBTITLES_ENABLED?: string;
  /** `true` si hay aplicación de Meta y publicador configurados: enseña conectar cuentas y programar para publicar. */
  readonly VITE_SOCIAL_PUBLISHING_ENABLED?: string;
  /** `true` si hay cliente OAuth de Google y la función drive-media: enseña Google Drive en ajustes y biblioteca. */
  readonly VITE_DRIVE_LIBRARY_ENABLED?: string;
  /** `true` si las funciones de pago (Stripe) están desplegadas y configuradas: enseña contratar y cambiar de plan. */
  readonly VITE_BILLING_ENABLED?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
