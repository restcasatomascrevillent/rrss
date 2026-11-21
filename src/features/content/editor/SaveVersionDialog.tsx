import { useState, type FormEvent } from 'react';
import { Button, Dialog, Field, Textarea } from '@/components/ui';
import type { DocumentIssue } from '../document';

interface SaveVersionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  saving: boolean;
  /** Problemas del documento que impidieron guardar, si los hubo. */
  issues: DocumentIssue[];
  onSave: (note: string) => void;
}

export function SaveVersionDialog({ open, onOpenChange, saving, issues, onSave }: SaveVersionDialogProps) {
  const [note, setNote] = useState('');

  function submit(event: FormEvent) {
    event.preventDefault();
    onSave(note.trim());
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setNote('');
        onOpenChange(next);
      }}
      title="Guardar versión"
      description="Se guarda como versión nueva; las anteriores siguen en el historial. Si estaba aprobada, vuelve a borrador."
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Nota" optional hint="Qué has cambiado, para quien revise después.">
          {(props) => (
            <Textarea
              {...props}
              rows={3}
              maxLength={500}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              data-testid="save-note"
            />
          )}
        </Field>
        {issues.length > 0 && (
          <div role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
            <p className="font-medium">No se puede guardar: el documento tiene errores.</p>
            <ul className="mt-1 list-disc pl-5">
              {issues.slice(0, 5).map((issue) => (
                <li key={`${issue.path}-${issue.message}`}>{issue.message}</li>
              ))}
            </ul>
          </div>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button type="submit" loading={saving} data-testid="save-confirm">
            Guardar versión
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
