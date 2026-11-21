import { ClipboardList, Send } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button } from '@/components/ui';
import { useBrand, useOrg } from '@/features/orgs/context';
import type { ContentItemRow } from '@/lib/database.types';
import { useRequestForContent } from './api';
import { CreateRequestDialog } from './CreateRequestDialog';
import { REQUEST_STATUS_LABEL, REQUEST_STATUS_TONE, isClosed, requestPaths } from './labels';

type Item = Pick<ContentItemRow, 'id' | 'title' | 'network' | 'format' | 'archived_at'>;

/** En la cabecera del editor: de qué encargo viene la pieza, si viene de alguno. */
export function ContentRequestOrigin({ item }: { item: Item }) {
  const { org } = useOrg();
  const { brand } = useBrand();
  const request = useRequestForContent(brand.id, item.id);
  if (!request.data) return null;
  return (
    <Link
      to={requestPaths(org.id, brand.id).item(request.data.id)}
      className="inline-flex items-center gap-1 text-primary hover:underline"
      data-testid="editor-request-link"
    >
      <ClipboardList className="h-3.5 w-3.5" aria-hidden />
      Encargo «{request.data.title}»
      <Badge tone={REQUEST_STATUS_TONE[request.data.status]}>{REQUEST_STATUS_LABEL[request.data.status]}</Badge>
    </Link>
  );
}

/**
 * En el panel de texto del editor, con la marca en modo agencia: «Pedir a la
 * agencia» crea un encargo enlazado a esta pieza. Si ya tiene uno abierto, no se
 * ofrece otro (la base de datos tampoco lo admite).
 */
export function AskAgencyButton({ item }: { item: Item }) {
  const { org } = useOrg();
  const { brand, can } = useBrand();
  const [open, setOpen] = useState(false);
  const request = useRequestForContent(brand.id, item.id);
  if (brand.ai_mode !== 'agency' || !can('comment') || item.archived_at) return null;
  if (request.isPending || (request.data && !isClosed(request.data.status))) return null;
  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)} data-testid="ask-agency">
        <Send className="h-4 w-4" aria-hidden />
        Pedir a la agencia
      </Button>
      <CreateRequestDialog
        organizationId={org.id}
        brandId={brand.id}
        open={open}
        onOpenChange={setOpen}
        content={item}
      />
    </>
  );
}
