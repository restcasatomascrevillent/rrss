import { Eye, FileText, Globe, Link2, RefreshCw, Trash2, Upload } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import {
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  Dialog,
  ErrorState,
  Input,
  Notice,
  Spinner,
} from '@/components/ui';
import { SOURCE_MIME_TYPES } from '@/config/app';
import type { KnowledgeSourceListRow, KnowledgeSourceRow } from '@/lib/database.types';
import { translateError } from '@/lib/errors';
import { formatBytes, formatDate } from '@/lib/utils';
import { normalizeUrl, useSourceMutations, useSources } from './api';
import { describeExtraction, extractionDetail, SOURCE_STATUS, useRequestExtraction, useSourceText } from './sourceText';
import { SOURCES_NOTICE } from './sourcesNotice';

export function SourcesCard({
  organizationId,
  brandId,
  canManage,
}: {
  organizationId: string;
  brandId: string;
  canManage: boolean;
}) {
  const sources = useSources(brandId);
  const { addUrl, upload, remove } = useSourceMutations(organizationId, brandId);
  const inputRef = useRef<HTMLInputElement>(null);
  const [url, setUrl] = useState('');
  const [removing, setRemoving] = useState<KnowledgeSourceRow | null>(null);
  const [viewing, setViewing] = useState<KnowledgeSourceListRow | null>(null);
  const reanalyze = useRequestExtraction(brandId);

  function submitUrl(event: FormEvent) {
    event.preventDefault();
    addUrl.mutate(url, {
      onSuccess: () => {
        setUrl('');
        toast.success('Web añadida');
      },
      onError: (e) => toast.error(translateError(e)),
    });
  }

  async function uploadFiles(files: FileList) {
    for (const file of Array.from(files)) {
      try {
        await upload.mutateAsync(file);
        toast.success(`«${file.name}» añadido`);
      } catch (e) {
        toast.error(translateError(e));
      }
    }
  }

  return (
    <Card>
      <CardHeader
        title="Fuentes de conocimiento"
        description="El manual de marca, la web y los documentos de los que sale la identidad de la marca."
      />
      <CardBody className="space-y-4">
        <Notice>{SOURCES_NOTICE}</Notice>
        {canManage && (
          <div className="flex flex-col gap-3 lg:flex-row">
            <form onSubmit={submitUrl} className="flex flex-1 gap-2">
              <Input
                type="text"
                inputMode="url"
                aria-label="Dirección de la página web"
                placeholder="https://tumarca.com"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                data-testid="source-url"
              />
              <Button
                type="submit"
                variant="secondary"
                loading={addUrl.isPending}
                disabled={!normalizeUrl(url)}
                data-testid="source-url-add"
              >
                <Link2 className="h-4 w-4" aria-hidden />
                Añadir web
              </Button>
            </form>
            <Button variant="secondary" onClick={() => inputRef.current?.click()} loading={upload.isPending}>
              <Upload className="h-4 w-4" aria-hidden />
              Subir documento
            </Button>
            <input
              ref={inputRef}
              type="file"
              multiple
              accept={SOURCE_MIME_TYPES.join(',')}
              className="sr-only"
              aria-label="Subir documentos de la marca"
              data-testid="source-file-input"
              onChange={(e) => {
                if (e.target.files) void uploadFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </div>
        )}
      </CardBody>
      {sources.isPending ? (
        <Spinner />
      ) : sources.isError ? (
        <ErrorState error={sources.error} onRetry={() => void sources.refetch()} />
      ) : sources.data.length === 0 ? (
        <p className="border-t border-border px-5 py-6 text-sm text-muted">
          Todavía no hay fuentes. Un manual de marca en PDF es un buen comienzo.
        </p>
      ) : (
        <ul className="divide-y divide-border border-t border-border" data-testid="sources-list">
          {sources.data.map((source) => {
            const Icon = source.kind === 'website' ? Globe : FileText;
            const status = SOURCE_STATUS[source.status];
            const summary = source.status === 'ready' ? describeExtraction(source) : '';
            return (
              <li key={source.id} className="flex items-center gap-3 px-5 py-3" data-testid="source-item">
                <Icon className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{source.title}</p>
                  <p className="truncate text-xs text-muted">
                    {source.url ?? (source.bytes !== null ? formatBytes(source.bytes) : '')} ·{' '}
                    {formatDate(source.created_at)}
                    {summary && ` · ${summary}`}
                  </p>
                  {source.error && (
                    <p
                      className={source.status === 'failed' ? 'text-xs text-danger' : 'text-xs text-muted'}
                      data-testid="source-error"
                    >
                      {source.error}
                    </p>
                  )}
                </div>
                <Badge tone={status.tone}>{status.label}</Badge>
                {source.status === 'ready' && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Ver el texto extraído de ${source.title}`}
                    onClick={() => setViewing(source)}
                  >
                    <Eye className="h-4 w-4" aria-hidden />
                  </Button>
                )}
                {canManage && (source.status === 'failed' || source.status === 'ready') && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Volver a extraer el texto de ${source.title}`}
                    loading={reanalyze.isPending && reanalyze.variables === source.id}
                    onClick={() =>
                      reanalyze.mutate(source.id, {
                        onSuccess: () => toast.success('Se volverá a extraer el texto'),
                        onError: (e) => toast.error(translateError(e)),
                      })
                    }
                  >
                    <RefreshCw className="h-4 w-4" aria-hidden />
                  </Button>
                )}
                {canManage && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Eliminar la fuente ${source.title}`}
                    onClick={() => setRemoving(source)}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <SourceTextDialog brandId={brandId} source={viewing} onClose={() => setViewing(null)} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="¿Eliminar esta fuente?"
        description={`«${removing?.title}» dejará de formar parte del conocimiento de la marca. No se puede deshacer.`}
        confirmLabel="Eliminar"
        loading={remove.isPending}
        onConfirm={() =>
          removing &&
          remove.mutate(removing, {
            onSuccess: () => {
              setRemoving(null);
              toast.success('Fuente eliminada');
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

/** El texto extraído, para revisarlo antes de que lo lea la IA. Solo lectura: si no es correcto, se cambia la fuente. */
function SourceTextDialog({
  brandId,
  source,
  onClose,
}: {
  brandId: string;
  source: KnowledgeSourceListRow | null;
  onClose: () => void;
}) {
  const text = useSourceText(brandId, source?.id ?? null, source?.extracted_at ?? null);
  const detail = source ? extractionDetail(source) : {};
  return (
    <Dialog
      open={source !== null}
      onOpenChange={(open) => !open && onClose()}
      size="lg"
      title={source ? `Texto de «${source.title}»` : 'Texto extraído'}
      description="Extraído sin IA. Es lo que leerá la propuesta de perfil."
    >
      {source && (
        <div className="space-y-3">
          <p className="text-xs text-muted">{describeExtraction(source)}</p>
          {detail.truncated && (
            <Notice tone="warning">El texto era más largo y se ha recortado al máximo que se guarda.</Notice>
          )}
          {Array.isArray(detail.pages) && detail.pages.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer">Páginas leídas ({detail.pages.length})</summary>
              <ul className="mt-1 list-disc pl-5">
                {detail.pages.map((page) => (
                  <li key={page.url} className="break-all">
                    {page.url}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {detail.skipped && detail.skipped.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer">Páginas omitidas ({detail.skipped.length})</summary>
              <ul className="mt-1 list-disc pl-5">
                {detail.skipped.map((page) => (
                  <li key={page.url} className="break-all">
                    {page.url}: {page.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {text.isPending ? (
            <Spinner label="Cargando el texto…" />
          ) : text.isError ? (
            <ErrorState error={text.error} onRetry={() => void text.refetch()} />
          ) : (
            <pre
              className="max-h-[50vh] overflow-auto whitespace-pre-wrap rounded-lg bg-subtle p-3 font-sans text-sm"
              data-testid="source-text"
              tabIndex={0}
            >
              {text.data?.extracted_text ?? ''}
            </pre>
          )}
        </div>
      )}
    </Dialog>
  );
}
