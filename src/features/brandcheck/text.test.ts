import {
  extractHashtags,
  extractMentions,
  findEmojis,
  findPhrase,
  pieceHashtagKeys,
  publishedText,
  tagKey,
  textLength,
} from './text';

describe('findPhrase', () => {
  it('ignora mayúsculas y tildes, y devuelve la posición en el original', () => {
    const text = 'Hoy: CAFÉ y cafe.';
    const m = findPhrase(text, 'café');
    expect(m.map((x) => [x.start, x.end, x.found])).toEqual([
      [5, 9, 'CAFÉ'],
      [12, 16, 'cafe'],
    ]);
  });
  it('solo palabra completa', () => {
    expect(findPhrase('baratísimo y barato', 'barato')).toHaveLength(1);
    expect(findPhrase('desbarato', 'barato')).toHaveLength(0);
    expect(findPhrase('barato2', 'barato')).toHaveLength(0);
  });
  it('expresiones de varias palabras con espacios irregulares', () => {
    const m = findPhrase('El mejor  precio\ngarantizado', 'mejor precio');
    expect(m).toHaveLength(1);
    expect(m[0]!.found).toBe('mejor  precio');
  });
  it('conserva la ñ: año no coincide con ano', () => {
    expect(findPhrase('el ano', 'año')).toHaveLength(0);
    expect(findPhrase('el AÑO', 'año')).toHaveLength(1);
  });
  it('una frase vacía no coincide con nada', () => {
    expect(findPhrase('hola', '  ')).toEqual([]);
  });
  it('coincide con signos en la frase', () => {
    expect(findPhrase('¡Oferta 2x1!', '2x1')).toHaveLength(1);
  });
});

describe('hashtags y menciones', () => {
  it('extrae hashtags con tildes y posición, sin contar numéricos ni URLs con #', () => {
    const tags = extractHashtags('Rico #Paella #ñam #2026 a#b &#39;');
    expect(tags.map((t) => t.value)).toEqual(['Paella', 'ñam']);
    expect(tags[0]!.start).toBe(5);
  });
  it('extrae menciones y no cuenta correos', () => {
    const m = extractMentions('Con @casa.tomas y @otro_1 escribe a hola@correo.es');
    expect(m.map((t) => t.value)).toEqual(['casa.tomas', 'otro_1']);
  });
  it('tagKey iguala mayúsculas, tildes y símbolo', () => {
    expect(tagKey('#Menú')).toBe(tagKey('menu'));
  });
  it('une hashtags del pie y añadidos sin duplicar', () => {
    expect(pieceHashtagKeys('Hola #Menu', ['menú', '#Vino', 'vino'])).toEqual(['menu', 'vino']);
  });
  it('publishedText añade solo los que faltan', () => {
    expect(publishedText('Hola #a', ['a', 'b'])).toBe('Hola #a\n\n#b');
    expect(publishedText('Hola', [])).toBe('Hola');
  });
});

describe('longitud y emojis', () => {
  it('cuenta según la unidad', () => {
    const s = 'a😀👨‍👩‍👧';
    expect(textLength(s, 'utf16')).toBe(1 + 2 + 8);
    expect(textLength(s, 'codepoints')).toBe(1 + 1 + 5);
    expect(textLength(s, 'graphemes')).toBe(3);
  });
  it('cuenta cada secuencia de emoji como uno y no cuenta ©, dígitos ni #', () => {
    const found = findEmojis('Hola 😀 © 1 # 👍🏽 ❤️ 🇪🇸 👨‍👩‍👧');
    expect(found.map((f) => f.emoji)).toEqual(['😀', '👍🏽', '❤️', '🇪🇸', '👨‍👩‍👧']);
  });
});
