import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, Card, CardBody, CardHeader } from '@/components/ui';
import type { ProfileSourceText } from '@/features/ai/api';
import { ProfileProposalDialog } from '@/features/ai/ProfileProposalDialog';
import { translateError } from '@/lib/errors';
import { useSources } from './api';
import type { BrandProfileData } from './profile';
import { fetchSourceTexts, pickProposalSources } from './sourceText';

// Proponer el perfil con IA a partir de las fuentes. El texto de cada fuente
// (PDF, Word, texto, web) lo extrae antes el trabajador, sin IA; aquí se envía
// el de todas las fuentes con texto listo, las más recientes primero, hasta los
// topes de la propuesta. Si ninguna tiene texto todavía, este bloque no aparece
// (lo que no funciona no sale en la interfaz).

export function ProfileProposalFromSources({
  brandId,
  currentProfile,
  onAccept,
  blockedReason,
}: {
  brandId: string;
  currentProfile: BrandProfileData | null;
  /** Si no se puede proponer ahora (por ejemplo, hay cambios sin guardar), el motivo. */
  blockedReason?: string;
  onAccept: (profile: BrandProfileData, acceptedFields: string[]) => void;
}) {
  const sources = useSources(brandId);
  const { chosen, left } = pickProposalSources(sources.data ?? []);
  const analyzing = (sources.data ?? []).filter((s) => s.status === 'pending' || s.status === 'processing').length;
  const [loaded, setLoaded] = useState<ProfileSourceText[] | null>(null);
  const [reading, setReading] = useState(false);

  if (chosen.length === 0) return null;

  async function open() {
    setReading(true);
    try {
      const rows = await fetchSourceTexts(chosen.map((s) => s.id));
      setLoaded(rows.map((row) => ({ title: row.title, text: row.extracted_text ?? '' })));
    } catch (error) {
      toast.error(translateError(error));
    } finally {
      setReading(false);
    }
  }

  const notes = [
    blockedReason,
    left.length > 0 &&
      `No caben todas: se envían las ${chosen.length} más recientes y quedan fuera ${left.length} (${left
        .map((s) => `«${s.title}»`)
        .join(', ')}).`,
    analyzing > 0 && `${analyzing === 1 ? 'Hay 1 fuente' : `Hay ${analyzing} fuentes`} extrayendo su texto todavía.`,
  ].filter(Boolean);

  return (
    <Card>
      <CardHeader
        title="Proponer el perfil con IA"
        description={`La IA lee el texto extraído de las fuentes (${chosen.length}) y propone un perfil; tú eliges qué aceptar y se guarda como versión nueva.`}
        action={
          <Button
            variant="secondary"
            onClick={() => void open()}
            loading={reading}
            disabled={Boolean(blockedReason)}
            title={blockedReason}
            data-testid="profile-ai-propose"
          >
            <Sparkles className="h-4 w-4" aria-hidden />
            Proponer
          </Button>
        }
      />
      {notes.length > 0 && (
        <CardBody className="space-y-1">
          {notes.map((note) => (
            <p key={String(note)} className="text-sm text-muted">
              {note}
            </p>
          ))}
        </CardBody>
      )}
      <ProfileProposalDialog
        brandId={brandId}
        sources={loaded ?? []}
        open={loaded !== null}
        onOpenChange={(value) => !value && setLoaded(null)}
        currentProfile={currentProfile}
        onAccept={(profile, info) => onAccept(profile, info.acceptedFields)}
      />
    </Card>
  );
}
