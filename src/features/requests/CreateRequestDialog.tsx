import { ImagePlus, X } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button, Dialog, Field, Input, Select, Textarea } from '@/components/ui';
import { ImagePickerDialog } from '@/features/content/editor/AssetPickerDialog';
import { targetLabel } from '@/features/content/labels';
import { formatsOf, getFormatSpec, NETWORKS } from '@/features/content/networks';
import { useAssetsByIds } from '@/features/library/api';
import type { ContentItemRow } from '@/lib/database.types';
import { translateError } from '@/lib/errors';
import { MAX_REFERENCE_ASSETS, useRequestMutations } from './api';
import { MEDIA_KIND_LABEL, requestPaths } from './labels';

interface CreateRequestDialogProps {
  organizationId: string;
  brandId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Encargo sobre una pieza que ya existe: la red y el formato son los suyos. */
  content?: Pick<ContentItemRow, 'id' | 'title' | 'network' | 'format'>;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Nuevo encargo: qué se pide, para qué red y formato, con qué recursos y para cuándo. */
export function CreateRequestDialog({
  organizationId,
  brandId,
  open,
  onOpenChange,
  content,
}: CreateRequestDialogProps) {
  const navigate = useNavigate();
  const { create } = useRequestMutations(brandId);
  const [title, setTitle] = useState(content?.title ?? '');
  const [brief, setBrief] = useState('');
  const [network, setNetwork] = useState<string>(content?.network ?? NETWORKS[0]!.id);
  const [format, setFormat] = useState<string>(content?.format ?? formatsOf(NETWORKS[0]!.id)[0]!.format);
  const [mediaKind, setMediaKind] = useState<'image' | 'video' | ''>('');
  const [desiredDate, setDesiredDate] = useState('');
  const [references, setReferences] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const spec = getFormatSpec(network, format);
  const referenceRows = useAssetsByIds(brandId, references);
  const names = useMemo(
    () => new Map((referenceRows.data ?? []).map((a) => [a.id, a.file_name])),
    [referenceRows.data],
  );

  function changeNetwork(next: string) {
    setNetwork(next);
    setFormat(formatsOf(next)[0]?.format ?? '');
    setMediaKind('');
  }

  function reset() {
    setTitle(content?.title ?? '');
    setBrief('');
    setDesiredDate('');
    setReferences([]);
    setMediaKind('');
    setError(null);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    create
      .mutateAsync({
        brandId,
        title,
        brief,
        network,
        format,
        mediaKind: mediaKind || null,
        referenceAssetIds: references,
        desiredDate: desiredDate || null,
        contentId: content?.id ?? null,
      })
      .then(
        (request) => {
          toast.success('Encargo enviado');
          onOpenChange(false);
          reset();
          navigate(requestPaths(organizationId, brandId).item(request.id));
        },
        (e: unknown) => setError(translateError(e)),
      );
  }

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={onOpenChange}
        title={content ? 'Pedir a la agencia' : 'Nuevo encargo'}
        description={
          content
            ? 'Cuenta qué necesitas para esta pieza. Te avisaremos aquí cuando esté el borrador para revisarlo.'
            : 'Cuenta qué publicación necesitas. Quien prepara los contenidos de la marca te entregará un borrador para revisar.'
        }
        size="lg"
        footer={
          <>
            <Button variant="secondary" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" form="create-request" loading={create.isPending} data-testid="request-submit">
              Enviar encargo
            </Button>
          </>
        }
      >
        <form id="create-request" onSubmit={submit} className="space-y-4">
          <Field label="Título" hint="Un resumen corto, para la lista de encargos.">
            {(props) => (
              <Input
                {...props}
                value={title}
                maxLength={200}
                onChange={(e) => setTitle(e.target.value)}
                data-testid="request-title"
                required
              />
            )}
          </Field>
          <Field label="Qué necesitas" hint="Qué se anuncia, el tono, qué no puede faltar…" error={error}>
            {(props) => (
              <Textarea
                {...props}
                rows={6}
                value={brief}
                maxLength={5000}
                onChange={(e) => setBrief(e.target.value)}
                data-testid="request-brief"
                required
              />
            )}
          </Field>
          {content ? (
            <p className="text-sm text-muted" data-testid="request-target-fixed">
              Para la pieza «{content.title}» · {targetLabel(content.network, content.format)}
            </p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Red">
                {(props) => (
                  <Select
                    {...props}
                    value={network}
                    onChange={(e) => changeNetwork(e.target.value)}
                    data-testid="request-network"
                  >
                    {NETWORKS.map((n) => (
                      <option key={n.id} value={n.id}>
                        {n.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Formato">
                {(props) => (
                  <Select
                    {...props}
                    value={format}
                    onChange={(e) => {
                      setFormat(e.target.value);
                      setMediaKind('');
                    }}
                    data-testid="request-format"
                  >
                    {formatsOf(network).map((f) => (
                      <option key={f.format} value={f.format}>
                        {f.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Tipo de pieza" optional>
                {(props) => (
                  <Select
                    {...props}
                    value={mediaKind}
                    onChange={(e) => setMediaKind(e.target.value as 'image' | 'video' | '')}
                    data-testid="request-media"
                  >
                    <option value="">Lo que encaje mejor</option>
                    {(spec?.media ?? []).map((m) => (
                      <option key={m} value={m}>
                        {MEDIA_KIND_LABEL[m]}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            </div>
          )}
          <Field label="Para cuándo" optional>
            {(props) => (
              <Input
                {...props}
                type="date"
                min={today()}
                value={desiredDate}
                onChange={(e) => setDesiredDate(e.target.value)}
                data-testid="request-date"
              />
            )}
          </Field>
          <div className="space-y-2">
            <p className="text-sm font-medium">Recursos de referencia</p>
            {references.length > 0 && (
              <ul className="flex flex-wrap gap-2" data-testid="request-references">
                {references.map((id) => (
                  <li key={id}>
                    <span className="inline-flex items-center gap-1 rounded-full bg-subtle py-1 pl-3 pr-1 text-xs">
                      {names.get(id) ?? 'Recurso'}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        aria-label={`Quitar ${names.get(id) ?? 'recurso'}`}
                        onClick={() => setReferences((list) => list.filter((r) => r !== id))}
                      >
                        <X className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setPicking(true)}
              disabled={references.length >= MAX_REFERENCE_ASSETS}
              data-testid="request-add-reference"
            >
              <ImagePlus className="h-4 w-4" aria-hidden />
              Añadir de la biblioteca
            </Button>
          </div>
        </form>
      </Dialog>
      <ImagePickerDialog
        brandId={brandId}
        libraryPath={`/o/${organizationId}/m/${brandId}/biblioteca`}
        open={picking}
        onOpenChange={setPicking}
        onPick={(asset) => {
          setReferences((list) => (list.includes(asset.id) ? list : [...list, asset.id]));
          setPicking(false);
        }}
      />
    </>
  );
}
