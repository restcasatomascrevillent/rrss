import { toast } from 'sonner';
import { Card, CardBody, CardHeader, Field, Select } from '@/components/ui';
import { useBrand, useOrg } from '@/features/orgs/context';
import type { BrandAiMode } from '@/lib/database.types';
import { translateError } from '@/lib/errors';
import { useSetAiMode } from './api';

const MODE_HELP: Record<BrandAiMode, string> = {
  api: 'En el editor aparece «Redactar con IA» si la plataforma tiene un servicio de IA configurado.',
  agency:
    'Los textos y las piezas los prepara la agencia que gestiona la marca: en el editor aparece «Pedir a la agencia» y la sección Encargos.',
};

/** Ajuste de la marca: cómo se redactan los textos con IA. Lo cambia quien gestiona la marca. */
export function AiModeCard() {
  const { org } = useOrg();
  const { brand, can } = useBrand();
  const canManage = can('manage');
  const setMode = useSetAiMode(org.id, brand.id);

  return (
    <Card>
      <CardHeader title="Redacción con IA" description={MODE_HELP[brand.ai_mode]} />
      <CardBody>
        <Field label="Quién redacta">
          {(props) => (
            <Select
              {...props}
              value={brand.ai_mode}
              disabled={!canManage || setMode.isPending}
              onChange={(e) =>
                setMode.mutate(e.target.value as BrandAiMode, {
                  onSuccess: () => toast.success('Ajuste guardado'),
                  onError: (error) => toast.error(translateError(error)),
                })
              }
              data-testid="brand-ai-mode"
            >
              <option value="api">El servicio de IA de la plataforma</option>
              <option value="agency">La agencia, por encargo</option>
            </Select>
          )}
        </Field>
      </CardBody>
    </Card>
  );
}
