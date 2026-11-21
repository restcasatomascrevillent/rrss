import { screen } from '@testing-library/react';
import type { UserEvent } from '@testing-library/user-event';

// Las acciones secundarias de una página viven en el menú «⋯» (MoreMenu).
// Estas ayudas lo abren y pulsan o devuelven una de sus acciones.

/** Abre el menú «⋯» con ese data-testid. */
export async function openMoreMenu(user: UserEvent, menuTestId: string): Promise<void> {
  await user.click(await screen.findByTestId(menuTestId));
  await screen.findByRole('menu');
}

/** Abre el menú «⋯» y pulsa la acción. */
export async function chooseMoreAction(user: UserEvent, menuTestId: string, itemTestId: string): Promise<void> {
  await openMoreMenu(user, menuTestId);
  await user.click(await screen.findByTestId(itemTestId));
}

/** Pulsa una acción del menú del editor de una pieza. */
export function chooseEditorAction(user: UserEvent, itemTestId: string): Promise<void> {
  return chooseMoreAction(user, 'editor-more', itemTestId);
}
