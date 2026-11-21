// Familia tipográfica lista para CSS (`font-family` o la propiedad `font`): con
// comillas si lleva espacios, como hace Konva. Sin Konva, para poder usarla en
// el campo de texto sobre el lienzo y en sus pruebas. (exporter.ts tiene la
// misma función; se pueden unificar cuando no haya trabajo en paralelo allí.)
export function cssFontFamily(family: string): string {
  return family
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
    .map((name) => (/^["'].*["']$/.test(name) || !/\s/.test(name) ? name : `"${name}"`))
    .join(', ');
}
