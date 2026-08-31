/* ProviderRegistry (spec §9) — provider names live here, nowhere else.
   Controllers never branch on provider names. */

import { Errors } from "../errors/http-error.js";
import { assertAIProvider } from "./providers/provider-interface.js";

export function createProviderRegistry() {
  const providers = new Map();

  return {
    register(name, provider) {
      providers.set(name, assertAIProvider(provider, name));
      return this;
    },
    has(name) {
      return providers.has(name);
    },
    get(name) {
      const p = providers.get(name);
      if (!p) throw Errors.providerNotFound(name);
      return p;
    },
    names() {
      return Array.from(providers.keys());
    }
  };
}
