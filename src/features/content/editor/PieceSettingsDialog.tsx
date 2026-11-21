import { useState, type FormEvent } from 'react';
import { Button, Dialog, Field, Input, Notice, Select } from '@/components/ui';
import type { ContentStatus } from '@/lib/database.types';
import type { AspectRatio } from '../document';
import { allowedCanvasRatios, formatsOf, getFormatSpec, NETWORKS } from '../networks';
import { settingsChanges, type PieceSettings, type SettingsChanges } from './pieceSettings';

interface PieceSettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: PieceSettings;
  status: ContentStatus;
  /** Proporción del lienzo, para avisar si el formato nuevo no la admite. */
  canvasRatio: AspectRatio;
  saving: boolean;
  /** Devuelve un mensaje de error para enseñarlo, o null si se ha guardado. */
  onSave: (changes: SettingsChanges) => Promise<string | null>;
}

/**
 * Renombrar la pieza y cambiar su red y formato (la API ya lo permite). Se
 * monta al abrirse, así que siempre parte de lo guardado.
 */
export function PieceSettingsDialog({
  open,
  onOpenChange,
  current,
  status,
  canvasRatio,
  saving,
  onSave,
}: PieceSettingsDialogProps) {
  const [draft, setDraft] = useState(current);
  const [error, setError] = useState<string | null>(null);

  const formats = formatsOf(draft.network);
  const changes = settingsChanges(current, draft);
  const retargeting = changes.target !== undefined;
  const spec = getFormatSpec(draft.network, draft.format);
  const media = spec?.media.includes('image') ? 'image' : spec?.media[0];
  const allowed = spec ? allowedCanvasRatios(spec, media) : null;
  const ratioMismatch = retargeting && allowed !== null && !allowed.ratios.includes(canvasRatio);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!changes.title && !changes.target) {
      onOpenChange(false);
      return;
    }
    setError(null);
    void onSave(changes).then((message) => {
      if (message) setError(message);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Nombre, red y formato"
      description="El nombre solo lo ve el equipo. La red y el formato deciden los límites que se comprueban."
    >
      <form onSubmit={submit} className="space-y-4" data-testid="piece-settings">
        <Field label="Nombre" error={error}>
          {(props) => (
            <Input
              {...props}
              value={draft.title}
              maxLength={200}
              onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              data-testid="piece-title"
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Red">
            {(props) => (
              <Select
                {...props}
                value={draft.network}
                onChange={(e) =>
                  setDraft({ ...draft, network: e.target.value, format: formatsOf(e.target.value)[0]?.format ?? '' })
                }
                data-testid="piece-network"
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
                value={draft.format}
                onChange={(e) => setDraft({ ...draft, format: e.target.value })}
                data-testid="piece-format"
              >
                {formats.map((f) => (
                  <option key={f.format} value={f.format}>
                    {f.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        {retargeting && status === 'approved' && (
          <Notice tone="warning">
            <span data-testid="piece-back-to-draft">
              Está aprobada: al cambiar la red o el formato vuelve a borrador y habrá que aprobarla otra vez.
            </span>
          </Notice>
        )}
        {ratioMismatch && (
          <Notice>
            El diseño es {canvasRatio} y este formato no admite esa proporción. Después, cámbiala en «Diseño» (sin
            ninguna capa elegida).
          </Notice>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button type="submit" loading={saving} data-testid="piece-settings-save">
            Guardar
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
