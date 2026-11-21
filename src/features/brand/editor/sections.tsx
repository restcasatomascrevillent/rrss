import type { ReactNode } from 'react';
import { Field, Input, Select, Textarea } from '@/components/ui';
import { LOCALES } from '@/config/app';
import { MAX_EMOJIS_LIMIT, normalizeHashtags, type BrandProfileData } from '../profile';
import { RowListInput, StringListInput } from './inputs';

export interface SectionProps {
  value: BrandProfileData;
  onChange: (value: BrandProfileData) => void;
  disabled?: boolean;
}

function Stack({ children }: { children: ReactNode }) {
  return <div className="space-y-6">{children}</div>;
}

export function BusinessSection({ value, onChange, disabled }: SectionProps) {
  const set = (patch: Partial<BrandProfileData['business']>) =>
    onChange({ ...value, business: { ...value.business, ...patch } });
  return (
    <Stack>
      <Field
        label="Descripción del negocio"
        hint="Qué hacéis, para quién y qué os hace distintos. Con dos o tres frases basta."
      >
        {(p) => (
          <Textarea
            {...p}
            rows={4}
            maxLength={4000}
            disabled={disabled}
            value={value.business.description}
            onChange={(e) => set({ description: e.target.value })}
            data-testid="profile-description"
          />
        )}
      </Field>
      <RowListInput
        label="Productos o servicios"
        rows={value.business.products}
        onChange={(products) => set({ products })}
        newRow={() => ({ name: '', description: '' })}
        addLabel="Añadir producto o servicio"
        disabled={disabled}
        fields={[
          { key: 'name', label: 'Nombre', placeholder: 'Nombre', width: 'narrow' },
          { key: 'description', label: 'Descripción', placeholder: 'Descripción breve', width: 'normal' },
        ]}
      />
      <StringListInput
        label="Ubicaciones y zonas comerciales"
        values={value.business.locations}
        onChange={(locations) => set({ locations })}
        placeholder="Ciudad, barrio o zona de reparto"
        disabled={disabled}
      />
      <StringListInput
        label="Propuestas de valor"
        hint="Las razones por las que os eligen."
        values={value.business.valueProps}
        onChange={(valueProps) => set({ valueProps })}
        placeholder="P. ej. Entrega en 24 horas"
        disabled={disabled}
      />
    </Stack>
  );
}

export function AudienceSection({ value, onChange, disabled }: SectionProps) {
  return (
    <Stack>
      <RowListInput
        label="Público objetivo"
        hint="Cada grupo de personas al que os dirigís."
        rows={value.audience.segments}
        onChange={(segments) => onChange({ ...value, audience: { segments } })}
        newRow={() => ({ name: '', description: '' })}
        addLabel="Añadir público"
        disabled={disabled}
        fields={[
          { key: 'name', label: 'Público', placeholder: 'P. ej. Familias de la zona', width: 'narrow' },
          { key: 'description', label: 'Descripción', placeholder: 'Qué buscan, qué les importa', width: 'normal' },
        ]}
      />
      <StringListInput
        label="Objetivos en redes"
        values={value.goals}
        onChange={(goals) => onChange({ ...value, goals })}
        placeholder="P. ej. Conseguir más reservas"
        disabled={disabled}
        testId="profile-goals"
      />
    </Stack>
  );
}

export function VoiceSection({ value, onChange, disabled }: SectionProps) {
  const set = (patch: Partial<BrandProfileData['voice']>) =>
    onChange({ ...value, voice: { ...value.voice, ...patch } });
  return (
    <Stack>
      <StringListInput
        label="Tono"
        values={value.voice.tone}
        onChange={(tone) => set({ tone })}
        placeholder="P. ej. Cercano, experto, con humor"
        disabled={disabled}
        testId="profile-tone"
      />
      <Field label="Personalidad" hint="Si la marca fuera una persona, ¿cómo hablaría?" optional>
        {(p) => (
          <Textarea
            {...p}
            maxLength={2000}
            disabled={disabled}
            value={value.voice.personality}
            onChange={(e) => set({ personality: e.target.value })}
          />
        )}
      </Field>
      <StringListInput
        label="Valores"
        values={value.voice.values}
        onChange={(values) => set({ values })}
        placeholder="P. ej. Sostenibilidad"
        disabled={disabled}
      />
      <StringListInput
        label="Mensajes clave"
        hint="Las ideas que deben repetirse en la comunicación."
        values={value.voice.keyMessages}
        onChange={(keyMessages) => set({ keyMessages })}
        maxLength={500}
        disabled={disabled}
      />
      <StringListInput
        label="Expresiones que sí usáis"
        values={value.voice.allowedPhrases}
        onChange={(allowedPhrases) => set({ allowedPhrases })}
        disabled={disabled}
      />
      <StringListInput
        label="Expresiones prohibidas"
        hint="Palabras o frases que nunca deben aparecer."
        values={value.voice.forbiddenPhrases}
        onChange={(forbiddenPhrases) => set({ forbiddenPhrases })}
        disabled={disabled}
      />
    </Stack>
  );
}

/**
 * Reglas de publicación que comprueba el verificador de marca: hashtags
 * obligatorios y recomendados, llamadas a la acción y política de emojis.
 * Va en la pestaña «Voz» del perfil, aparte de `VoiceSection` para no alargar el asistente de alta.
 */
export function PublishingRulesSection({ value, onChange, disabled }: SectionProps) {
  const set = (patch: Partial<BrandProfileData['voice']>) =>
    onChange({ ...value, voice: { ...value.voice, ...patch } });
  const { hashtags, emojis } = value.voice;
  const policy = emojis.allowed === null ? 'undefined' : emojis.allowed ? 'yes' : 'no';
  return (
    <Stack>
      <StringListInput
        label="Hashtags obligatorios"
        hint="Tienen que aparecer en cada publicación; si falta alguno, la pieza no es apta. Sin la almohadilla."
        values={hashtags.required}
        onChange={(required) => set({ hashtags: { ...hashtags, required: normalizeHashtags(required) } })}
        placeholder="P. ej. MiMarca"
        disabled={disabled}
        maxLength={100}
        testId="profile-hashtags-required"
      />
      <StringListInput
        label="Hashtags recomendados"
        hint="Conviene usarlos; si faltan, solo se avisa."
        values={hashtags.recommended}
        onChange={(recommended) => set({ hashtags: { ...hashtags, recommended: normalizeHashtags(recommended) } })}
        placeholder="P. ej. CocinaDeMercado"
        disabled={disabled}
        maxLength={100}
        testId="profile-hashtags-recommended"
      />
      <StringListInput
        label="Llamadas a la acción"
        hint="Frases con las que invitáis a actuar. Basta con que el texto lleve una."
        values={value.voice.callsToAction}
        onChange={(callsToAction) => set({ callsToAction })}
        placeholder="P. ej. Reserva tu mesa"
        disabled={disabled}
        maxLength={200}
        testId="profile-ctas"
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Emojis" hint="Si no lo indicáis, el verificador no comprueba los emojis.">
          {(p) => (
            <Select
              {...p}
              disabled={disabled}
              value={policy}
              onChange={(e) =>
                set({
                  emojis: {
                    ...emojis,
                    allowed: e.target.value === 'undefined' ? null : e.target.value === 'yes',
                  },
                })
              }
              data-testid="profile-emoji-policy"
            >
              <option value="undefined">Sin definir</option>
              <option value="yes">Se pueden usar</option>
              <option value="no">No se usan</option>
            </Select>
          )}
        </Field>
        {emojis.allowed !== false && (
          <Field label="Máximo de emojis por publicación" hint="Déjalo vacío si no hay máximo." optional>
            {(p) => (
              <Input
                {...p}
                type="number"
                inputMode="numeric"
                min={0}
                max={MAX_EMOJIS_LIMIT}
                step={1}
                disabled={disabled}
                value={emojis.max ?? ''}
                onChange={(e) => {
                  const n = e.target.value === '' ? null : Math.round(Number(e.target.value));
                  set({
                    emojis: {
                      ...emojis,
                      max: n === null || !Number.isFinite(n) ? null : Math.min(MAX_EMOJIS_LIMIT, Math.max(0, n)),
                    },
                  });
                }}
                data-testid="profile-emoji-max"
              />
            )}
          </Field>
        )}
      </div>
    </Stack>
  );
}

/** Colores, tipografías y notas de estilo. Los logotipos los gestiona cada pantalla (necesitan subir archivos). */
export function VisualSection({ value, onChange, disabled }: SectionProps) {
  const set = (patch: Partial<BrandProfileData['visual']>) =>
    onChange({ ...value, visual: { ...value.visual, ...patch } });
  return (
    <Stack>
      <RowListInput
        label="Colores de marca"
        rows={value.visual.colors}
        onChange={(colors) => set({ colors })}
        newRow={() => ({ name: '', hex: '#4338CA', role: '' })}
        addLabel="Añadir color"
        disabled={disabled}
        testId="profile-add-color"
        fields={[
          { key: 'hex', label: 'Color', type: 'color', width: 'narrow' },
          { key: 'name', label: 'Nombre', placeholder: 'Nombre', width: 'narrow' },
          { key: 'role', label: 'Uso', placeholder: 'Principal, fondo, acento…', width: 'narrow' },
        ]}
      />
      <RowListInput
        label="Tipografías"
        hint="Indica la licencia para saber dónde se puede usar cada fuente."
        rows={value.visual.fonts}
        onChange={(fonts) => set({ fonts })}
        newRow={() => ({ family: '', usage: '', license: '' })}
        addLabel="Añadir tipografía"
        disabled={disabled}
        fields={[
          { key: 'family', label: 'Familia', placeholder: 'Familia', width: 'narrow' },
          { key: 'usage', label: 'Uso', placeholder: 'Titulares, texto…', width: 'narrow' },
          { key: 'license', label: 'Licencia', placeholder: 'Licencia', width: 'narrow' },
        ]}
      />
      <Field label="Notas de estilo" hint="Cómo deben verse las imágenes: luz, encuadres, lo que evitar…" optional>
        {(p) => (
          <Textarea
            {...p}
            maxLength={2000}
            disabled={disabled}
            value={value.visual.styleNotes}
            onChange={(e) => set({ styleNotes: e.target.value })}
          />
        )}
      </Field>
    </Stack>
  );
}

export function ChannelsSection({ value, onChange, disabled }: SectionProps) {
  return (
    <Stack>
      <RowListInput
        label="Redes sociales que usáis"
        hint="Solo es información de la marca: conectar las cuentas para publicar llegará más adelante."
        rows={value.channels}
        onChange={(channels) => onChange({ ...value, channels })}
        newRow={() => ({ platform: '', handle: '', url: '' })}
        addLabel="Añadir red"
        disabled={disabled}
        fields={[
          { key: 'platform', label: 'Red', placeholder: 'Instagram, LinkedIn…', width: 'narrow' },
          { key: 'handle', label: 'Usuario', placeholder: '@usuario', width: 'narrow' },
          { key: 'url', label: 'Enlace', placeholder: 'https://…', type: 'url', width: 'narrow' },
        ]}
      />
      <Field label="Idioma principal">
        {(p) => (
          <Select
            {...p}
            disabled={disabled}
            value={value.languages.primary}
            onChange={(e) => onChange({ ...value, languages: { ...value.languages, primary: e.target.value } })}
          >
            {LOCALES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
            {!LOCALES.some((l) => l.value === value.languages.primary) && (
              <option value={value.languages.primary}>{value.languages.primary}</option>
            )}
          </Select>
        )}
      </Field>
      <StringListInput
        label="Otros idiomas"
        hint="Escribe el código de cada idioma: en (inglés), fr (francés), ca (catalán)…"
        values={value.languages.others}
        onChange={(others) => onChange({ ...value, languages: { ...value.languages, others } })}
        maxLength={10}
        disabled={disabled}
      />
    </Stack>
  );
}

export function ContextSection({ value, onChange, disabled }: SectionProps) {
  return (
    <Stack>
      <RowListInput
        label="Competidores"
        rows={value.competitors}
        onChange={(competitors) => onChange({ ...value, competitors })}
        newRow={() => ({ name: '', url: '' })}
        addLabel="Añadir competidor"
        disabled={disabled}
        fields={[
          { key: 'name', label: 'Nombre', placeholder: 'Nombre', width: 'normal' },
          { key: 'url', label: 'Enlace', placeholder: 'https://…', type: 'url', width: 'normal' },
        ]}
      />
      <RowListInput
        label="Referencias"
        hint="Cuentas o campañas que os gustan."
        rows={value.references}
        onChange={(references) => onChange({ ...value, references })}
        newRow={() => ({ url: '', note: '' })}
        addLabel="Añadir referencia"
        disabled={disabled}
        fields={[
          { key: 'url', label: 'Enlace', placeholder: 'https://…', type: 'url', width: 'normal' },
          { key: 'note', label: 'Qué os gusta', placeholder: 'Qué os gusta', width: 'normal' },
        ]}
      />
      <StringListInput
        label="Restricciones legales"
        hint="Avisos obligatorios, sectores regulados…"
        values={value.restrictions.legal}
        onChange={(legal) => onChange({ ...value, restrictions: { ...value.restrictions, legal } })}
        disabled={disabled}
      />
      <StringListInput
        label="Restricciones publicitarias"
        hint="Lo que no se puede prometer ni mostrar."
        values={value.restrictions.advertising}
        onChange={(advertising) => onChange({ ...value, restrictions: { ...value.restrictions, advertising } })}
        disabled={disabled}
      />
    </Stack>
  );
}
