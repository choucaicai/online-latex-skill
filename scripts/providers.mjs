// Add a provider here after implementing the adapter contract in docs/platform-integration-sop.md.
// Keep credentials and account-specific identifiers in the adapter's local state, never in this registry.
export const PROVIDER_REGISTRY = Object.freeze({
  overleaf: {
    label: 'Overleaf',
    module: './overleaf.mjs',
    exportName: 'OverleafBackend',
    hosts: ['overleaf.com', 'www.overleaf.com'],
    dependencies: ['claudeleaf', 'playwright-core'],
    capabilities: { mainFile: false, projectVersions: false },
    projectIdFromUrl: url => url.pathname.match(/\/project\/([a-f\d]{24})(?:\/|$)/i)?.[1],
  },
  texpage: {
    label: 'TeXPage',
    module: './texpage.mjs',
    exportName: 'TexpageBackend',
    hosts: ['texpage.com', 'www.texpage.com'],
    dependencies: ['playwright-core'],
    capabilities: { mainFile: true, projectVersions: true },
    projectIdFromUrl: url => url.searchParams.get('projectKey') ||
      url.pathname.match(/[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}/i)?.[0],
  },
});

export const PROVIDERS = Object.freeze(Object.keys(PROVIDER_REGISTRY));

export function providerForUrl(url) {
  return PROVIDERS.find(id => PROVIDER_REGISTRY[id].hosts.includes(url.hostname.toLowerCase()));
}

export async function loadBackend(provider, home) {
  const definition = PROVIDER_REGISTRY[provider];
  if (!definition) throw new Error(`Unknown provider: ${provider}`);
  const module = await import(new URL(definition.module, import.meta.url));
  return new module[definition.exportName](home);
}

export function providerDependencies() {
  return [...new Set(Object.values(PROVIDER_REGISTRY).flatMap(p => p.dependencies))];
}
