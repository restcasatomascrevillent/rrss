// Transcripción SIMULADA: solo para pruebas (Node) y para la prueba de extremo
// a extremo en local (con la guarda de `AI_E2E_SIMULATED_PROVIDER`). No escucha
// nada: devuelve un texto fijo por trozo que dice su número y su duración, para
// poder comprobar que cada trozo vuelve a su sitio. Va marcado como simulado.
import { AiProviderFailure, type AiProvider, type AiProviderRequest, type AiProviderResult } from '../contract.ts';
import { chunkSeconds, TRANSCRIPTION_UNIT } from './openai.ts';

export const SIMULATED_TRANSCRIPTION_MODEL = 'transcripcion-simulada';

export interface SimulatedTranscription extends AiProvider {
  readonly calls: AiProviderRequest[];
}

export function createSimulatedTranscriptionProvider(
  options: { failWith?: () => Error | null } = {},
): SimulatedTranscription {
  const calls: AiProviderRequest[] = [];
  return {
    id: 'simulated',
    calls,
    estimateUsage: (request) => ({ [TRANSCRIPTION_UNIT]: chunkSeconds(request.input.audio?.chunks ?? []) }),
    async generate(request): Promise<AiProviderResult> {
      calls.push(request);
      const failure = options.failWith?.();
      if (failure) throw failure;
      if (request.task !== 'transcription') throw new AiProviderFailure('unsupported_task', 'Solo transcribe');
      const chunks = request.input.audio?.chunks ?? [];
      return {
        output: {
          segments: chunks.map((chunk, index) => ({
            index,
            text: `[simulado] Frase ${index + 1} de ${chunks.length} (${chunk.seconds.toFixed(1)} s)`,
          })),
        },
        usage: { [TRANSCRIPTION_UNIT]: chunkSeconds(chunks) },
      };
    },
  };
}
