import { ImageOff } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';

// Miniatura de una imagen de la biblioteca.
//
// NO lleva `crossOrigin` a propósito: las miniaturas se piden como <img>
// normal (ver src/lib/corsImage.ts) y el lienzo del editor pide la misma URL
// con `fetch` en modo CORS y `cache: 'no-store'`, así que no comparten caché.
// Añadirle `crossOrigin` aquí no rompería nada, pero tampoco hace falta, y
// cambiar la petición de la miniatura es justo lo que el arreglo evita tocar.

interface ThumbImageProps {
  url: string;
  /** Lado en píxeles con el que se reserva el hueco (evita saltos al cargar). Por defecto 256. */
  size?: number;
  className?: string;
  fit?: 'cover' | 'contain';
}

export function ThumbImage({ url, size = 256, className, fit = 'cover' }: ThumbImageProps) {
  // La ficha se vuelve a montar al cambiar de URL (clave): el fallo no se arrastra a otra imagen.
  const [failed, setFailed] = useState<string | null>(null);
  if (failed === url) {
    return (
      <span
        role="img"
        aria-label="No se pudo cargar la imagen"
        className={cn('flex h-full w-full items-center justify-center bg-subtle text-muted', className)}
        data-testid="thumb-error"
      >
        <ImageOff className="h-6 w-6" aria-hidden />
      </span>
    );
  }
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      width={size}
      height={size}
      onError={() => setFailed(url)}
      className={cn('h-full w-full', fit === 'cover' ? 'object-cover' : 'object-contain', className)}
    />
  );
}
