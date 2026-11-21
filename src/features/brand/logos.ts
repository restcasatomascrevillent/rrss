/**
 * Logotipos subidos en el editor del perfil que todavía no forman parte de
 * ninguna versión guardada. Si la persona los quita o se va sin guardar, hay
 * que borrarlos de la biblioteca para que no queden sin enlazar a nada.
 */

/** Ids pendientes que de verdad hay que borrar: los que no se están guardando. */
export function logosToDiscard(pending: ReadonlySet<string>, saving: ReadonlySet<string>): string[] {
  return [...pending].filter((id) => !saving.has(id));
}

/** Quita de los pendientes los que ya están guardados en el perfil. */
export function settleSaved(pending: Set<string>, savedIds: readonly string[]): void {
  for (const id of savedIds) pending.delete(id);
}
