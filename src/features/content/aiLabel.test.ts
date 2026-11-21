import { describe, expect, it } from 'vitest';
import { aiContentReasons, describeAiReasons } from './aiLabel';
import { DOCUMENT_SCHEMA_VERSION, contentDocumentSchema, type ContentDocumentInput } from './document';

const ASSET = '11111111-1111-4111-8111-111111111111';
const AI_ASSET = '22222222-2222-4222-8222-222222222222';
const GENERATION = '33333333-3333-4333-8333-333333333333';

function doc(extra: Partial<ContentDocumentInput> = {}) {
  return contentDocumentSchema.parse({
    schemaVersion: DOCUMENT_SCHEMA_VERSION,
    canvas: { aspectRatio: '1:1', width: 1080, height: 1080 },
    ...extra,
  });
}

const image = (
  id: string,
  source: { kind: 'asset'; assetId: string } | { kind: 'generation'; generationId: string },
) => ({
  id,
  type: 'image' as const,
  x: 0,
  y: 0,
  width: 100,
  height: 100,
  source,
});

const assets = [
  { id: ASSET, provenance: {} },
  { id: AI_ASSET, provenance: { type: 'ai_generation', generation_id: GENERATION } },
];

describe('marca de contenido generado con IA', () => {
  it('un documento sin nada de IA no lleva marca', () => {
    expect(aiContentReasons(doc({ pages: [{ id: 'p1', name: '', layers: [image('foto', { kind: 'asset', assetId: ASSET })] }] }), assets)).toEqual([]);
  });

  it('marca el texto redactado con IA y las capas generadas o que usan imágenes generadas', () => {
    const reasons = aiContentReasons(
      doc({
        copy: { caption: 'Hola', aiGenerated: true },
        pages: [{ id: 'p1', name: '', layers: [
          image('a', { kind: 'asset', assetId: AI_ASSET }),
          image('b', { kind: 'generation', generationId: GENERATION }),
          image('c', { kind: 'asset', assetId: ASSET }),
          {
            id: 't',
            type: 'text',
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            text: 'x',
            fontFamily: 'Inter',
            fontSize: 20,
            color: '#000000',
            aiGenerated: true,
          },
        ] }],
      }),
      assets,
    );
    expect(reasons.map((r) => r.kind)).toEqual(['caption', 'asset', 'generation', 'layer']);
    expect(describeAiReasons(reasons)).toBe('Generado con IA: el texto de la publicación y 3 imágenes o capas.');
  });

  it('los documentos antiguos (sin los campos nuevos) se leen igual', () => {
    const parsed = doc({ copy: { caption: 'Hola' } });
    expect('aiGenerated' in parsed.copy).toBe(false);
    expect(aiContentReasons(parsed)).toEqual([]);
    expect(describeAiReasons([])).toBe('');
  });
});
