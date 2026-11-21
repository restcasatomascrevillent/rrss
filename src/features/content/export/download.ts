/** Descarga un archivo generado en el navegador con el nombre dado. */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = window.document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  link.style.display = 'none';
  window.document.body.appendChild(link);
  link.click();
  link.remove();
  // Margen para que el navegador empiece la descarga antes de soltar la dirección.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
