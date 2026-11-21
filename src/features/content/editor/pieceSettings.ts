// Renombrar la pieza y cambiar su red y formato: qué ha cambiado (lógica pura).

export interface SettingsChanges {
  title?: string;
  /** Red y formato se cambian juntos. Si la pieza estaba aprobada, vuelve a borrador. */
  target?: { network: string; format: string };
}

export interface PieceSettings {
  title: string;
  network: string;
  format: string;
}

/** Qué ha cambiado respecto a lo guardado; vacío si nada. */
export function settingsChanges(current: PieceSettings, next: PieceSettings): SettingsChanges {
  const changes: SettingsChanges = {};
  if (next.title.trim() !== current.title) changes.title = next.title;
  if (next.network !== current.network || next.format !== current.format) {
    changes.target = { network: next.network, format: next.format };
  }
  return changes;
}
