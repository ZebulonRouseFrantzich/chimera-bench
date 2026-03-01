import type { EnginePlugin } from "./engine-plugin.ts";
import { ENGINE_PLUGIN_API_VERSION } from "./engine-plugin.ts";

const ENGINE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_ENGINE_ID_LENGTH = 128;

export interface EngineCatalog {
  list(): readonly EnginePlugin[];
  getById(id: string): EnginePlugin | undefined;
}

export function createEngineCatalog(
  plugins: readonly EnginePlugin[],
): EngineCatalog {
  const orderedPlugins = Object.freeze([...plugins]);
  const pluginsById = new Map<string, EnginePlugin>();

  for (const plugin of orderedPlugins) {
    if (!isValidEngineId(plugin.id)) {
      throw new Error(
        `Engine plugin id '${plugin.id}' is invalid. Use lowercase alphanumeric and single dashes only.`,
      );
    }

    if (plugin.apiVersion !== ENGINE_PLUGIN_API_VERSION) {
      throw new Error(
        `Engine plugin '${plugin.id}' targets API version ${plugin.apiVersion}, expected ${ENGINE_PLUGIN_API_VERSION}.`,
      );
    }

    if (pluginsById.has(plugin.id)) {
      throw new Error(`Engine plugin id '${plugin.id}' is registered more than once.`);
    }

    pluginsById.set(plugin.id, plugin);
  }

  return {
    list(): readonly EnginePlugin[] {
      return [...orderedPlugins];
    },
    getById(id: string): EnginePlugin | undefined {
      return pluginsById.get(id);
    },
  };
}

function isValidEngineId(id: string): boolean {
  if (id.length === 0 || id.length > MAX_ENGINE_ID_LENGTH) {
    return false;
  }

  return ENGINE_ID_PATTERN.test(id);
}
