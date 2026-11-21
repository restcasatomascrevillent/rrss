import { useState, type Dispatch } from 'react';
import { cn } from '@/lib/utils';
import type { PostCopy } from '../../document';
import type { NetworkFormatSpec } from '../../networks';
import { LENGTH_UNIT_NOTE } from '../../textUnits';
import { copyCounters, formatTagList, parseTagList, type CopyCounter } from '../copy';
import type { EditorAction } from '../history';
import { Labeled } from './controls';

interface CopyPanelProps {
  copy: PostCopy;
  spec: NetworkFormatSpec | undefined;
  networkName: string;
  readOnly: boolean;
  dispatch: Dispatch<EditorAction>;
}

const FIELD = 'w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm disabled:opacity-60';

function Counter({ counter }: { counter: CopyCounter | undefined }) {
  if (!counter) return null;
  return (
    <p
      className={cn('text-xs', counter.over ? 'font-medium text-danger' : 'text-muted')}
      data-testid={`counter-${counter.field}`}
    >
      {counter.max !== undefined ? `${counter.value} / ${counter.max}` : `${counter.value} · sin límite conocido`}
      {counter.provenance === 'unverified' && ' (límite sin confirmar)'}
      {counter.over && ' · te pasas del límite'}
      {counter.note && <span className="block">{counter.note}</span>}
    </p>
  );
}

/** Texto que acompaña a la pieza: pie, hashtags, menciones y texto alternativo, con sus contadores. */
export function CopyPanel({ copy, spec, networkName, readOnly, dispatch }: CopyPanelProps) {
  const counters = Object.fromEntries(copyCounters(copy, spec).map((c) => [c.field, c])) as Record<
    CopyCounter['field'],
    CopyCounter
  >;
  // Hashtags y menciones se escriben como texto libre y se leen al salir del campo.
  const [hashtags, setHashtags] = useState<string | null>(null);
  const [mentions, setMentions] = useState<string | null>(null);
  const set = (patch: Partial<PostCopy>, key?: string) => dispatch({ type: 'setCopy', patch, ...(key ? { key } : {}) });
  const checkpoint = () => dispatch({ type: 'checkpoint' });

  return (
    <div className="space-y-4" data-testid="copy-panel">
      <p className="text-xs text-muted">
        Límites de {networkName}. Lo que la red no publica no se cuenta como límite. {LENGTH_UNIT_NOTE}
      </p>
      <Labeled label="Pie de la publicación">
        {(id) => (
          <>
            <textarea
              id={id}
              rows={6}
              maxLength={10_000}
              className={FIELD}
              value={copy.caption}
              disabled={readOnly}
              onChange={(e) => set({ caption: e.target.value }, 'caption')}
              onBlur={checkpoint}
              data-testid="copy-caption"
            />
            <Counter counter={counters.caption} />
          </>
        )}
      </Labeled>
      <Labeled label="Hashtags">
        {(id) => (
          <>
            <input
              id={id}
              className={FIELD}
              placeholder="#otoño #menu"
              value={hashtags ?? formatTagList(copy.hashtags, '#')}
              disabled={readOnly}
              onChange={(e) => setHashtags(e.target.value)}
              onBlur={() => {
                if (hashtags !== null) set({ hashtags: parseTagList(hashtags, '#').slice(0, 100) });
                setHashtags(null);
              }}
              data-testid="copy-hashtags"
            />
            <Counter counter={counters.hashtags} />
          </>
        )}
      </Labeled>
      <Labeled label="Menciones">
        {(id) => (
          <>
            <input
              id={id}
              className={FIELD}
              placeholder="@cuenta"
              value={mentions ?? formatTagList(copy.mentions, '@')}
              disabled={readOnly}
              onChange={(e) => setMentions(e.target.value)}
              onBlur={() => {
                if (mentions !== null) set({ mentions: parseTagList(mentions, '@').slice(0, 100) });
                setMentions(null);
              }}
              data-testid="copy-mentions"
            />
            <Counter counter={counters.mentions} />
          </>
        )}
      </Labeled>
      <Labeled label="Texto alternativo (describe la imagen para quien no la ve)">
        {(id) => (
          <>
            <textarea
              id={id}
              rows={3}
              maxLength={2000}
              className={FIELD}
              value={copy.altText}
              disabled={readOnly}
              onChange={(e) => set({ altText: e.target.value }, 'altText')}
              onBlur={checkpoint}
              data-testid="copy-alt"
            />
            <Counter counter={counters.altText} />
          </>
        )}
      </Labeled>
    </div>
  );
}
