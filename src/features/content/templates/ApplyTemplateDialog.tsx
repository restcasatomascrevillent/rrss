import { useState } from 'react';
import { Button, Dialog } from '@/components/ui';
import type { ContentDocument } from '../document';
import type { BrandTemplate } from './api';
import { TemplatePicker } from './TemplatePicker';

interface ApplyTemplateDialogProps {
  orgId: string;
  brandId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: { network: string; format: string };
  /** La pieza ya tiene capas: se avisa de que se sustituyen (Ctrl+Z las recupera). */
  hasDesign: boolean;
  onApply: (document: ContentDocument, template: BrandTemplate) => void;
}

/** «Empezar desde una plantilla» dentro del editor: sustituye el diseño en un paso que se puede deshacer. */
export function ApplyTemplateDialog({
  orgId,
  brandId,
  open,
  onOpenChange,
  target,
  hasDesign,
  onApply,
}: ApplyTemplateDialogProps) {
  const [chosen, setChosen] = useState<BrandTemplate | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="Empezar desde una plantilla"
      description="Las fotos de la plantilla se quedan para que las sustituyas; el texto, el pie y los hashtags son una guía."
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button
            disabled={!chosen?.document}
            onClick={() => {
              if (!chosen?.document) return;
              onApply(chosen.document, chosen);
              onOpenChange(false);
              setChosen(null);
            }}
            data-testid="template-apply"
          >
            Usar esta plantilla
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {hasDesign && (
          <p className="text-xs text-warning" data-testid="template-replace-warning">
            Sustituye el diseño actual por el de la plantilla. Con Ctrl+Z lo recuperas.
          </p>
        )}
        <TemplatePicker
          orgId={orgId}
          brandId={brandId}
          target={target}
          selectedId={chosen?.id ?? null}
          onSelect={setChosen}
        />
      </div>
    </Dialog>
  );
}
