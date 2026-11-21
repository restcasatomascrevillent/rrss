// Estado del editor de reels con deshacer y rehacer.
//
// Cada cambio es una función pura sobre el proyecto (ops.ts). Los cambios
// seguidos con la misma clave `merge` (escribir en un campo, arrastrar un
// clip) cuentan como UN paso: se deshacen de una vez.
import type { ReelProject } from './project';

export const HISTORY_LIMIT = 100;

export type Selection =
  { kind: 'clip'; id: string } | { kind: 'text'; id: string } | { kind: 'music' } | { kind: 'subtitles' } | null;

export interface EditorState {
  project: ReelProject;
  past: ReelProject[];
  future: ReelProject[];
  selection: Selection;
  /** Clave del último cambio, para juntar los seguidos. */
  lastMerge: string | null;
}

export type EditorAction =
  | { type: 'change'; change: (project: ReelProject) => ReelProject; merge?: string; select?: Selection }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'select'; selection: Selection }
  /** Corta la fusión de cambios (al soltar un arrastre o salir de un campo). */
  | { type: 'commit' }
  /** Empieza de nuevo con otro proyecto (al guardar o restaurar una versión). */
  | { type: 'reset'; project: ReelProject };

export function initEditor(project: ReelProject): EditorState {
  return { project, past: [], future: [], selection: null, lastMerge: null };
}

/** ¿Sigue existiendo lo elegido en este proyecto? */
function validSelection(selection: Selection, project: ReelProject): Selection {
  if (!selection) return null;
  if (selection.kind === 'clip') return project.plan.clips.some((c) => c.id === selection.id) ? selection : null;
  if (selection.kind === 'text') return project.plan.texts.some((t) => t.id === selection.id) ? selection : null;
  if (selection.kind === 'music') return project.plan.music ? selection : null;
  return selection;
}

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case 'change': {
      const next = action.change(state.project);
      if (next === state.project) {
        return action.select !== undefined ? { ...state, selection: action.select } : state;
      }
      const merging = action.merge !== undefined && action.merge === state.lastMerge;
      const past = merging ? state.past : [...state.past, state.project].slice(-HISTORY_LIMIT);
      return {
        project: next,
        past,
        future: [],
        selection: validSelection(action.select !== undefined ? action.select : state.selection, next),
        lastMerge: action.merge ?? null,
      };
    }
    case 'undo': {
      const previous = state.past[state.past.length - 1];
      if (!previous) return state;
      return {
        project: previous,
        past: state.past.slice(0, -1),
        future: [state.project, ...state.future],
        selection: validSelection(state.selection, previous),
        lastMerge: null,
      };
    }
    case 'redo': {
      const [next, ...rest] = state.future;
      if (!next) return state;
      return {
        project: next,
        past: [...state.past, state.project],
        future: rest,
        selection: validSelection(state.selection, next),
        lastMerge: null,
      };
    }
    case 'select':
      return { ...state, selection: validSelection(action.selection, state.project), lastMerge: null };
    case 'commit':
      return state.lastMerge === null ? state : { ...state, lastMerge: null };
    case 'reset':
      return initEditor(action.project);
  }
}
