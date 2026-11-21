import { STICKER_LABEL, type StickerKind } from '../canvas/stickers';

/** Lista para añadir una figura sencilla (estrella, corazón, flecha…) como pegatina. */
export function AddStickerSelect({
  disabled,
  onAdd,
}: {
  disabled?: boolean;
  onAdd: (shape: StickerKind) => void;
}) {
  return (
    <select
      aria-label="Añadir figura o pegatina"
      data-testid="add-sticker"
      className="h-8 rounded-md border border-border bg-surface px-2 text-sm disabled:opacity-60"
      disabled={disabled}
      value=""
      onChange={(event) => {
        if (event.target.value) onAdd(event.target.value as StickerKind);
      }}
    >
      <option value="">Figuras…</option>
      {(Object.keys(STICKER_LABEL) as StickerKind[]).map((shape) => (
        <option key={shape} value={shape}>
          {STICKER_LABEL[shape]}
        </option>
      ))}
    </select>
  );
}
