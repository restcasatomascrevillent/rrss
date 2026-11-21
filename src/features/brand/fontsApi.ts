import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { STORAGE_BUCKET } from '@/config/app';
import type { BrandFontRow, FontStyle, ReelFontInfo } from '@/lib/database.types';
import { unwrap } from '@/lib/errors';
import { buildStoragePath } from '@/lib/files';
import { supabase } from '@/lib/supabase';
import {
  browserFontEnvironment,
  FONT_FORMATS,
  fontFormatFromName,
  registerBrandFonts,
  validateFontFile,
  type FontEnvironment,
  type FontLoadReport,
} from './fonts';

export const fontKeys = {
  list: (brandId: string) => ['brand', brandId, 'fonts'] as const,
  reel: (brandId: string) => ['brand', brandId, 'fonts', 'reel'] as const,
};

export function useBrandFonts(brandId: string) {
  return useQuery({
    queryKey: fontKeys.list(brandId),
    queryFn: async (): Promise<BrandFontRow[]> =>
      unwrap(
        await supabase
          .from('brand_fonts')
          .select('*')
          .eq('brand_id', brandId)
          .order('family')
          .order('weight')
          .order('style'),
      ),
  });
}

/** Tipografía que usarán los reels: null si la marca no tiene .ttf/.otf (se usa la de reserva). */
export function useReelFont(brandId: string) {
  return useQuery({
    queryKey: fontKeys.reel(brandId),
    queryFn: async (): Promise<ReelFontInfo | null> =>
      (unwrap(await supabase.rpc('brand_reel_font_info', { p_brand_id: brandId })) as ReelFontInfo[])[0] ?? null,
  });
}

export interface NewBrandFont {
  file: File;
  family: string;
  weight: number;
  style: FontStyle;
  licenseConfirmed: boolean;
  licenseNote?: string;
}

export async function uploadBrandFont(organizationId: string, brandId: string, input: NewBrandFont): Promise<void> {
  const invalid = validateFontFile(input.file);
  if (invalid) throw new Error(invalid);
  if (!input.licenseConfirmed) throw new Error('Confirma que la marca tiene licencia para usar esta tipografía.');
  const format = fontFormatFromName(input.file.name)!;
  const { mime } = FONT_FORMATS[format];
  const path = buildStoragePath(organizationId, brandId, 'fonts', input.file.name);
  // El tipo se fija por la extensión: los navegadores no lo dan de forma fiable para las fuentes.
  const upload = await supabase.storage.from(STORAGE_BUCKET).upload(path, input.file, { contentType: mime });
  if (upload.error) throw upload.error;
  const inserted = await supabase.from('brand_fonts').insert({
    brand_id: brandId,
    organization_id: organizationId,
    family: input.family.trim(),
    weight: input.weight,
    style: input.style,
    format,
    storage_path: path,
    file_name: input.file.name.slice(0, 255),
    mime_type: mime,
    bytes: input.file.size,
    license_confirmed: true,
    license_note: input.licenseNote?.trim() || null,
  });
  if (inserted.error) {
    await supabase.storage.from(STORAGE_BUCKET).remove([path]);
    throw inserted.error;
  }
}

export function useBrandFontMutations(organizationId: string, brandId: string) {
  const queryClient = useQueryClient();
  const onSuccess = () => queryClient.invalidateQueries({ queryKey: fontKeys.list(brandId) });
  const upload = useMutation({
    mutationFn: (input: NewBrandFont) => uploadBrandFont(organizationId, brandId, input),
    onSuccess,
  });
  const remove = useMutation({
    mutationFn: async (font: Pick<BrandFontRow, 'id' | 'storage_path'>) => {
      const rows = unwrap(await supabase.from('brand_fonts').delete().eq('id', font.id).select('id'));
      if (rows.length === 0) throw { code: '42501', message: 'permission denied' };
      const { error } = await supabase.storage.from(STORAGE_BUCKET).remove([font.storage_path]);
      if (error) throw error;
    },
    onSuccess,
  });
  return { upload, remove };
}

async function downloadFont(font: BrandFontRow): Promise<ArrayBuffer> {
  const { data, error } = await supabase.storage.from(STORAGE_BUCKET).download(font.storage_path);
  if (error || !data) throw error ?? new Error(`No se ha podido descargar «${font.file_name}».`);
  return data.arrayBuffer();
}

// Lo ya registrado en esta pestaña: no se descarga dos veces al volver al editor.
const registered = new Set<string>();

/**
 * Carga en el navegador los archivos de la marca (con `FontFace`) y espera a
 * que estén listos. La usa el editor antes de dibujar y antes de exportar.
 */
export function loadBrandFonts(
  fonts: readonly BrandFontRow[],
  env: FontEnvironment | null = browserFontEnvironment(),
): Promise<FontLoadReport> {
  if (!env || fonts.length === 0) return Promise.resolve({ loaded: [], failed: [] });
  return registerBrandFonts(fonts, downloadFont, env, registered);
}

export type BrandFontFacesState =
  | { status: 'loading'; families: string[]; failed: FontLoadReport['failed'] }
  | { status: 'ready'; families: string[]; failed: FontLoadReport['failed'] };

/** Tipografías de la marca cargadas en el navegador: el editor no dibuja hasta que están (o han fallado). */
export function useBrandFontFaces(brandId: string): BrandFontFacesState & { fonts: BrandFontRow[] } {
  const query = useBrandFonts(brandId);
  const fonts = useMemo(() => query.data ?? [], [query.data]);
  const key = fonts.map((font) => font.id).join(',');
  const [state, setState] = useState<{ key: string; failed: FontLoadReport['failed'] } | null>(null);

  useEffect(() => {
    if (query.isPending) return;
    let active = true;
    void loadBrandFonts(fonts).then((report) => {
      if (active) setState({ key, failed: report.failed });
    });
    return () => {
      active = false;
    };
    // `key` resume la lista de archivos.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, query.isPending]);

  const failedIds = new Set((state?.failed ?? []).map((f) => f.id));
  const families = [...new Set(fonts.filter((font) => !failedIds.has(font.id)).map((font) => font.family))];
  // Si no se pueden leer las tipografías (error de red), el editor no se bloquea: dibuja con las de reserva.
  const ready = query.isError || (!query.isPending && (fonts.length === 0 || state?.key === key));
  return { status: ready ? 'ready' : 'loading', families, failed: state?.failed ?? [], fonts };
}
