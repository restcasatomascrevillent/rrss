import { Trash2, Type, Upload } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  ErrorState,
  Field,
  Input,
  Notice,
  Select,
  Spinner,
} from '@/components/ui';
import { mediaWorkerEnabled } from '@/config/app';
import type { BrandFontRow, FontStyle } from '@/lib/database.types';
import { translateError } from '@/lib/errors';
import { formatBytes } from '@/lib/utils';
import { FONT_ACCEPT, FONT_WEIGHTS, guessFontFromFileName, validateFontFile } from './fonts';
import { useBrandFontFaces, useBrandFontMutations, useReelFont } from './fontsApi';

const LICENSE_NOTICE =
  'Las tipografías tienen licencia. Sube solo las que la marca puede usar en sus publicaciones (y, si las hay, en vídeo). Quien la sube lo declara; la aplicación no puede comprobarlo.';

/** Archivos de fuente de la marca: los usa el editor (primero en el selector) y, los .ttf/.otf, los reels. */
export function BrandFontsCard({
  organizationId,
  brandId,
  canManage,
}: {
  organizationId: string;
  brandId: string;
  canManage: boolean;
}) {
  const faces = useBrandFontFaces(brandId);
  const { upload, remove } = useBrandFontMutations(organizationId, brandId);
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [family, setFamily] = useState('');
  const [weight, setWeight] = useState(400);
  const [style, setStyle] = useState<FontStyle>('normal');
  const [license, setLicense] = useState(false);
  const [note, setNote] = useState('');
  const [removing, setRemoving] = useState<BrandFontRow | null>(null);
  const listPending = faces.status === 'loading' && faces.fonts.length === 0;

  function choose(files: FileList | null) {
    const chosen = files?.[0];
    if (!chosen) return;
    const invalid = validateFontFile(chosen);
    if (invalid) {
      toast.error(invalid);
      return;
    }
    const guess = guessFontFromFileName(chosen.name);
    setFile(chosen);
    setFamily(guess.family);
    setWeight(guess.weight);
    setStyle(guess.style);
    setLicense(false);
    setNote('');
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!file) return;
    upload.mutate(
      { file, family, weight, style, licenseConfirmed: license, licenseNote: note },
      {
        onSuccess: () => {
          toast.success(`Tipografía «${family}» añadida`);
          setFile(null);
        },
        onError: (e) => toast.error(translateError(e)),
      },
    );
  }

  return (
    <Card>
      <CardHeader
        title="Tipografías de la marca"
        description="Archivos .woff2, .woff, .ttf u .otf. El editor las ofrece primero y las carga antes de dibujar y de exportar."
        action={
          canManage && (
            <Button variant="secondary" onClick={() => inputRef.current?.click()} data-testid="font-choose">
              <Upload className="h-4 w-4" aria-hidden />
              Subir tipografía
            </Button>
          )
        }
      />
      <CardBody className="space-y-4">
        <Notice tone="warning">{LICENSE_NOTICE}</Notice>
        {canManage && (
          <input
            ref={inputRef}
            type="file"
            accept={FONT_ACCEPT}
            className="sr-only"
            aria-label="Archivo de la tipografía"
            data-testid="font-file-input"
            onChange={(e) => {
              choose(e.target.files);
              e.target.value = '';
            }}
          />
        )}
        {file && (
          <form onSubmit={submit} className="space-y-3 rounded-xl border border-border p-4" data-testid="font-form">
            <p className="text-sm">
              <span className="font-medium">{file.name}</span> · {formatBytes(file.size)}
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Familia">
                {(props) => (
                  <Input
                    {...props}
                    value={family}
                    maxLength={100}
                    onChange={(e) => setFamily(e.target.value)}
                    required
                  />
                )}
              </Field>
              <Field label="Peso">
                {(props) => (
                  <Select {...props} value={weight} onChange={(e) => setWeight(Number(e.target.value))}>
                    {FONT_WEIGHTS.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Estilo">
                {(props) => (
                  <Select {...props} value={style} onChange={(e) => setStyle(e.target.value as FontStyle)}>
                    <option value="normal">Redonda</option>
                    <option value="italic">Cursiva</option>
                  </Select>
                )}
              </Field>
            </div>
            <Field label="Licencia (opcional)" hint="Por ejemplo, de dónde sale o el número de licencia.">
              {(props) => <Input {...props} value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />}
            </Field>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4"
                checked={license}
                onChange={(e) => setLicense(e.target.checked)}
                data-testid="font-license"
              />
              Declaro que la marca tiene licencia para usar esta tipografía en sus publicaciones.
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setFile(null)}>
                Cancelar
              </Button>
              <Button
                type="submit"
                loading={upload.isPending}
                disabled={!license || !family.trim()}
                data-testid="font-upload"
              >
                Añadir tipografía
              </Button>
            </div>
          </form>
        )}
        {mediaWorkerEnabled() && <ReelFontLine brandId={brandId} />}
      </CardBody>
      {listPending ? (
        <Spinner />
      ) : faces.fonts.length === 0 ? (
        <p className="border-t border-border px-5 py-6 text-sm text-muted">
          Todavía no hay tipografías propias: el editor usa las del perfil (si están instaladas en el equipo) y las
          genéricas.
        </p>
      ) : (
        <ul className="divide-y divide-border border-t border-border" data-testid="fonts-list">
          {faces.fonts.map((font) => {
            const failed = faces.failed.find((f) => f.id === font.id);
            return (
              <li key={font.id} className="flex items-center gap-3 px-5 py-3">
                <Type className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p
                    className="truncate text-base"
                    style={{
                      fontFamily: `"${font.family}", sans-serif`,
                      fontWeight: font.weight,
                      fontStyle: font.style,
                    }}
                  >
                    {font.family} — Aa Bb Cc 123
                  </p>
                  <p className="truncate text-xs text-muted">
                    {font.weight} · {font.style === 'italic' ? 'cursiva' : 'redonda'} · .{font.format} ·{' '}
                    {formatBytes(font.bytes)}
                    {font.license_note && ` · ${font.license_note}`}
                  </p>
                  {failed && <p className="text-xs text-danger">No se ha podido cargar: {failed.reason}</p>}
                </div>
                {(font.format === 'ttf' || font.format === 'otf') && <Badge tone="neutral">También en vídeo</Badge>}
                {canManage && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Eliminar la tipografía ${font.family} ${font.weight}`}
                    onClick={() => setRemoving(font)}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {faces.status === 'loading' && faces.fonts.length > 0 && (
        <p className="px-5 pb-3 text-xs text-muted">Cargando las tipografías…</p>
      )}
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="¿Eliminar esta tipografía?"
        description={`Los textos que usen «${removing?.family}» se dibujarán con la tipografía de reserva.`}
        confirmLabel="Eliminar"
        loading={remove.isPending}
        onConfirm={() =>
          removing &&
          remove.mutate(removing, {
            onSuccess: () => {
              setRemoving(null);
              toast.success('Tipografía eliminada');
            },
            onError: (e) => {
              setRemoving(null);
              toast.error(translateError(e));
            },
          })
        }
      />
    </Card>
  );
}

/** Qué tipografía usan los reels de la marca (solo .ttf/.otf) o que se usa la de reserva. */
export function ReelFontLine({ brandId }: { brandId: string }) {
  const reel = useReelFont(brandId);
  if (reel.isPending) return null;
  if (reel.isError) return <ErrorState error={reel.error} onRetry={() => void reel.refetch()} />;
  return (
    <p className="text-sm text-muted" data-testid="reel-font">
      {reel.data
        ? `Los textos de los reels usan «${reel.data.family}» (${reel.data.weight}, .${reel.data.format}).`
        : 'Los textos de los reels usan la tipografía de reserva del trabajador: para usar la de la marca hace falta un archivo .ttf u .otf.'}
    </p>
  );
}
