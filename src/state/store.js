/* Minimal store — dispatch → reducer → state → notify subscribers. */

import { reducer, initialState } from "./machine.js";

export function createStore(preloaded) {
  let state = preloaded || initialState;
  const listeners = new Set();

  return {
    getState: () => state,
    dispatch(action) {
      const prev = state;
      const next = reducer(prev, action);
      if (next !== prev) {
        state = next;
        listeners.forEach((fn) => fn(state, prev, action));
      }
      return action;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }
  };
}
