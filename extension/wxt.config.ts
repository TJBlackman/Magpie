import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// Chrome builds as MV3 (service worker + offscreen document hosts the engine).
// Firefox builds as MV2 (`--mv2`): persistent background page hosts the engine
// directly, host permissions are granted at install, webRequestBlocking is
// available for setting Referer on our own segment fetches.
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: '.',
  outDir: 'dist',
  imports: false,
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: ({ browser, manifestVersion }) => {
    const common = {
      name: 'Magpie',
      description: 'Collects shiny streaming video (HLS, DASH, plain files) and saves it to disk.',
      // unlimitedStorage: downloads are assembled in OPFS, which is otherwise capped at 10 GiB.
      permissions: ['webRequest', 'downloads', 'storage', 'unlimitedStorage', 'tabs'],
      host_permissions: ['<all_urls>'],
    };
    if (browser === 'firefox') {
      return {
        ...common,
        permissions: [...common.permissions, 'webRequestBlocking'],
        browser_specific_settings: {
          gecko: {
            id: 'magpie@trevorblackman.dev',
            strict_min_version: '115.0',
            data_collection_permissions: { required: ['none'] },
          },
        },
      };
    }
    return {
      ...common,
      permissions: [
        ...common.permissions,
        'offscreen',
        'declarativeNetRequest',
        'scripting',
      ],
      minimum_chrome_version: '116',
      ...(manifestVersion === 3 ? {} : {}),
    };
  },
});
