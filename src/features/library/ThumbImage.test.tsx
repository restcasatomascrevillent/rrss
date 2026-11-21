import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ThumbImage } from './ThumbImage';

describe('ThumbImage', () => {
  it('carga en diferido, con tamaño reservado y sin crossOrigin (no toca el arreglo de CORS)', () => {
    const { container } = render(<ThumbImage url="https://r2.test/a.jpg?sig=1" />);
    const img = container.querySelector('img')!;
    expect(img).toHaveAttribute('loading', 'lazy');
    expect(img).toHaveAttribute('decoding', 'async');
    expect(img).toHaveAttribute('width', '256');
    expect(img).toHaveAttribute('height', '256');
    expect(img).toHaveAttribute('src', 'https://r2.test/a.jpg?sig=1');
    expect(img).not.toHaveAttribute('crossorigin');
  });

  it('si la imagen falla, sale un marcador en vez de un hueco', () => {
    const { container } = render(<ThumbImage url="https://r2.test/rota.jpg" />);
    fireEvent.error(container.querySelector('img')!);
    expect(screen.getByTestId('thumb-error')).toHaveAccessibleName('No se pudo cargar la imagen');
    expect(container.querySelector('img')).toBeNull();
  });

  it('una URL nueva vuelve a intentarlo', () => {
    const { container, rerender } = render(<ThumbImage url="https://r2.test/rota.jpg" />);
    fireEvent.error(container.querySelector('img')!);
    rerender(<ThumbImage url="https://r2.test/buena.jpg" />);
    expect(container.querySelector('img')).toHaveAttribute('src', 'https://r2.test/buena.jpg');
  });
});
