import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';

import { TOAST_MS } from '../theme/tokens';
import { initialState, reducer } from './reducer';
import type { Action, State } from './types';

/**
 * One in-memory store for the whole app: React context + `useReducer`.
 * Chosen over zustand because (a) the prototype is literally one `setState` object,
 * so a single reducer is a 1:1 transcription, (b) the reducer is a plain pure
 * function, so the store tests import it directly with no React or renderer in the
 * way, and (c) it adds no dependency to an app that must not grow a runtime it does
 * not need. Nothing is persisted — reloading resets to `initialState`, as in the
 * prototype.
 */
const StateContext = createContext<State | null>(null);
const DispatchContext = createContext<React.Dispatch<Action> | null>(null);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Toasts live ~2.2 s (prototype `toastMsg`). Keyed by `toastSeq` so a replacement
  // toast restarts the clock instead of inheriting the previous one's remainder.
  useEffect(() => {
    if (!state.toast) return;
    const seq = state.toastSeq;
    const timer = setTimeout(() => dispatch({ type: 'clearToast', seq }), TOAST_MS);
    return () => clearTimeout(timer);
  }, [state.toast, state.toastSeq]);

  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>{children}</DispatchContext.Provider>
    </StateContext.Provider>
  );
}

export function useStore(): State {
  const state = useContext(StateContext);
  if (!state) throw new Error('useStore must be used inside <StoreProvider>');
  return state;
}

export function useDispatch(): React.Dispatch<Action> {
  const dispatch = useContext(DispatchContext);
  if (!dispatch) throw new Error('useDispatch must be used inside <StoreProvider>');
  return dispatch;
}

/** Convenience wrapper for screens that need both halves. */
export function useAppState() {
  const state = useStore();
  const dispatch = useDispatch();
  return useMemo(() => ({ state, dispatch }), [state, dispatch]);
}
