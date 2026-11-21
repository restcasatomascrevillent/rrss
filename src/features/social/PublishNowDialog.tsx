import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button, Dialog, Field, Notice, Select } from '@/components/ui';
import { STATUS_LABEL } from '@/features/content/status';
import { contentKeys } from '@/features/content/api';
import { translateError } from '@/lib/errors';
import {
  kickPublisher,
  publishableExportsOf,
  publishNowRequest,
  socialKeys,
  useCalendarContent,
  useContentPublication,
  usePublishableMedia,
  useSocialAccounts,
} from './api';
import { HOLD_REASON_TEXT, PUBLISHABLE_TARGETS } from './calendar';

interface PublishNowDialogProps {
  brandId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contentId: string;
  /** Cuenta ya elegida (diálogo de programar). Sin ella, la primera conectada de la red. */
  accountId?: string;
  /**
   * Recursos ya elegidos (diálogo de programar). Sin ellos, la exportación JPEG
   * de la versión aprobada (en un carrusel, la de cada página, en su orden).
   */
  assetIds?: string[];
  /**
   * Exporta la versión aprobada a JPEG (una imagen por página) y la guarda en la
   * biblioteca; devuelve los recursos en el orden de las páginas. Solo el editor
   * puede (la exportación la hace el navegador).
   */
  exportVersion?: () => Promise<string[]>;
  /** Enlace al editor de la pieza, para cuando falta la exportación y aquí no se puede hacer. */
  editorPath?: string;
}

type Phase = 'confirm' | 'exporting' | 'publishing';

const POLL_MS = 2000;
const SLOW_AFTER_MS = 90_000;

/**
 * «Publicar ahora»: confirma en un paso, exporta si falta, pone la pieza en el
 * calendario con la hora actual, pide al publicador que la procese ya y enseña
 * el progreso (se sondea el estado cada pocos segundos; no hay tiempo real).
 * Las garantías de siempre las impone la base de datos: aquí solo se explica.
 */
export function PublishNowDialog({
  brandId,
  open,
  onOpenChange,
  contentId,
  accountId: forcedAccount,
  assetIds: forcedAssets,
  exportVersion,
  editorPath,
}: PublishNowDialogProps) {
  const qc = useQueryClient();
  const content = useCalendarContent(brandId, contentId, open);
  const accounts = useSocialAccounts(brandId, open);
  const media = usePublishableMedia(brandId, open);
  const [phase, setPhase] = useState<Phase>('confirm');
  const [started, setStarted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const startedAt = useRef(0);
  const publication = useContentPublication(brandId, contentId, open, started ? POLL_MS : false);

  const item = content.data ?? null;
  const live = (accounts.data ?? []).filter((a) => a.network === item?.network && a.status === 'active');
  const accountId = forcedAccount ?? choice ?? live[0]?.id ?? '';
  const account = (accounts.data ?? []).find((a) => a.id === accountId) ?? null;
  const pub = publication.data ?? null;

  const exported =
    item && media.data && item.format !== 'reel'
      ? publishableExportsOf(media.data, item.id, item.current_version, item.format)
      : null;
  const existing = pub?.media_asset_ids ?? [];
  const exportable = item?.format === 'post' || item?.format === 'carousel';
  let assetIds: string[] = forcedAssets ?? [];
  if (assetIds.length === 0 && exportable) assetIds = exported?.map((a) => a.id) ?? [];
  if (assetIds.length === 0 && item && item.format === 'reel') assetIds = existing;
  const needsExport = assetIds.length === 0 && exportable && Boolean(exportVersion);

  // Por qué todavía no se puede (se dice antes de pedir confirmación).
  let blocker: string | null = null;
  if (item && !started) {
    if (item.archived_at) blocker = 'La pieza está archivada.';
    else if (item.status !== 'approved')
      blocker = `Solo se publica lo aprobado y ahora está en «${STATUS_LABEL[item.status]}».`;
    else if (!PUBLISHABLE_TARGETS.has(`${item.network}:${item.format}`))
      blocker = 'Este formato todavía no se publica automáticamente.';
    else if (!accountId) blocker = HOLD_REASON_TEXT.no_account;
    else if (assetIds.length === 0 && !needsExport)
      blocker =
        item.format === 'post'
          ? `Falta la exportación JPEG de la versión ${item.current_version}: expórtala desde el editor (Exportar imagen → JPEG, guardar en la biblioteca).`
          : item.format === 'carousel'
            ? `Faltan las exportaciones JPEG de las páginas de la versión ${item.current_version}: expórtalas desde el editor (Exportar el carrusel, guardar en la biblioteca).`
            : HOLD_REASON_TEXT.no_media;
  }

  // La hora de salida del sondeo largo: pasado un rato se avisa de que sigue en curso.
  useEffect(() => {
    if (!started) return;
    const timer = setTimeout(() => setSlow(true), SLOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [started, pub?.status]);

  const status = started ? (pub?.status ?? 'scheduled') : null;
  const done = status === 'published';
  const failed = status === 'failed';
  const held = started && status === 'planned';
  const inProgress = started && !done && !failed && !held;

  useEffect(() => {
    if (done || failed || held) {
      void qc.invalidateQueries({ queryKey: socialKeys.calendar(brandId) });
      void qc.invalidateQueries({ queryKey: contentKeys.all(brandId) });
    }
  }, [done, failed, held, qc, brandId]);

  const run = async () => {
    if (!item || !accountId) return;
    setError(null);
    setSlow(false);
    try {
      let ids = assetIds;
      if (needsExport && exportVersion) {
        setPhase('exporting');
        ids = await exportVersion();
        await qc.invalidateQueries({ queryKey: socialKeys.media(brandId) });
      }
      setPhase('publishing');
      const created = await publishNowRequest({
        contentId: item.id,
        accountId,
        mediaAssetIds: ids,
        contentVersion: item.current_version,
        publicationId: pub?.id ?? null,
      });
      qc.setQueryData(socialKeys.contentPublication(brandId, contentId), created);
      startedAt.current = Date.now();
      setStarted(true);
      if (created.status === 'scheduled') void kickPublisher(created.id);
      void qc.invalidateQueries({ queryKey: socialKeys.calendar(brandId) });
    } catch (e) {
      setError(translateError(e));
      setPhase('confirm');
      setStarted(false);
    }
  };

  const close = (next: boolean) => {
    if (!next) {
      setPhase('confirm');
      setStarted(false);
      setError(null);
      setSlow(false);
    }
    onOpenChange(next);
  };

  const working = phase !== 'confirm' && !started;

  return (
    <Dialog
      open={open}
      onOpenChange={close}
      title="Publicar ahora"
      description={item ? `${item.title} · versión aprobada ${item.current_version}` : undefined}
      footer={
        done || held ? (
          <Button onClick={() => close(false)} data-testid="publish-now-close">
            Cerrar
          </Button>
        ) : failed ? (
          <>
            <Button variant="secondary" onClick={() => close(false)}>
              Cerrar
            </Button>
            <Button onClick={() => void run()} data-testid="publish-now-retry">
              Reintentar
            </Button>
          </>
        ) : inProgress ? (
          <Button variant="secondary" onClick={() => close(false)}>
            Cerrar (sigue en segundo plano)
          </Button>
        ) : (
          <>
            <Button variant="secondary" onClick={() => close(false)} disabled={working}>
              Cancelar
            </Button>
            <Button
              onClick={() => void run()}
              loading={working}
              disabled={!item || Boolean(blocker)}
              data-testid="publish-now-confirm"
            >
              Publicar ahora
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3" data-testid="publish-now">
        {!started && blocker && (
          <Notice tone="warning">
            <span data-testid="publish-now-blocker">{blocker}</span>
            {editorPath && exportable && item?.status === 'approved' && (
              <>
                {' '}
                <a href={editorPath} className="text-primary underline">
                  Abrir en el editor
                </a>
              </>
            )}
          </Notice>
        )}

        {!started && !blocker && (
          <>
            {!forcedAccount && live.length > 1 && (
              <Field label="Cuenta">
                {(props) => (
                  <Select {...props} value={accountId} onChange={(e) => setChoice(e.target.value)}>
                    {live.map((a) => (
                      <option key={a.id} value={a.id}>
                        @{a.username || a.external_id}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            )}
            <p className="text-sm" data-testid="publish-now-warning">
              Se publicará ahora en @{account?.username || account?.external_id || '…'}. No se puede deshacer desde
              aquí.
            </p>
            {needsExport && (
              <p className="text-sm text-muted" data-testid="publish-now-export-note">
                {item?.format === 'carousel'
                  ? `La versión ${item.current_version} aún no tiene sus páginas exportadas: se exportarán a JPEG (una imagen por página, en orden) y se guardarán en la biblioteca en este mismo paso.`
                  : `La versión ${item?.current_version} aún no tiene su imagen exportada: se exportará a JPEG y se guardará en la biblioteca en este mismo paso.`}
              </p>
            )}
            {!needsExport && item?.format === 'carousel' && assetIds.length > 0 && (
              <p className="text-sm text-muted" data-testid="publish-now-pages">
                Se publican {assetIds.length} imágenes, en el orden de las páginas.
              </p>
            )}
          </>
        )}

        {phase === 'exporting' && !started && (
          <p role="status" className="text-sm" data-testid="publish-now-exporting">
            {item?.format === 'carousel' ? 'Exportando las páginas…' : 'Exportando la imagen…'}
          </p>
        )}
        {phase === 'publishing' && !started && (
          <p role="status" className="text-sm">
            Preparando la publicación…
          </p>
        )}

        {inProgress && (
          <div role="status" data-testid="publish-now-progress">
            <p className="text-sm font-medium">Publicando…</p>
            {slow && (
              <p className="mt-1 text-xs text-muted">
                Sigue en curso (Instagram puede tardar con vídeos). Puedes cerrar: el estado se ve en el calendario.
              </p>
            )}
          </div>
        )}

        {done && pub && (
          <Notice>
            <span className="font-medium" data-testid="publish-now-done">
              Publicada
            </span>
            {pub.external_url ? (
              <>
                {' · '}
                <a
                  href={pub.external_url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1 text-primary underline"
                  data-testid="publish-now-link"
                >
                  Ver en la red <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              </>
            ) : null}
          </Notice>
        )}

        {failed && (
          <Notice tone="warning">
            <span data-testid="publish-now-failed">
              No se ha publicado{pub?.last_error ? `: ${pub.last_error}` : '.'}
            </span>
          </Notice>
        )}
        {held && pub?.hold_reason && (
          <Notice tone="warning">
            <span data-testid="publish-now-held">No se publica: {HOLD_REASON_TEXT[pub.hold_reason]}</span>
          </Notice>
        )}

        {error && (
          <p className="text-sm text-danger" role="alert" data-testid="publish-now-error">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
