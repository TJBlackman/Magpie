import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';
import type { Plugin } from 'vite';

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
    plugins: [tailwindcss(), noInnerHtml()],
  }),
  manifest: ({ browser, manifestVersion }) => {
    const common = {
      name: 'Magpie',
      description: 'Collects shiny streaming video (HLS, DASH, plain files) and every file of a Reddit post, and saves it to disk. For media you own or have permission to save.',
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
            // data_collection_permissions arrived in Firefox 140, and 142 on Android.
            strict_min_version: '140.0',
            data_collection_permissions: { required: ['none'] },
          },
          gecko_android: { strict_min_version: '142.0' },
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

/**
 * Magpie never uses dangerouslySetInnerHTML, but react-dom still ships the two
 * innerHTML writes behind it, and Mozilla's validator warns about each one. This
 * swaps them for a throw. The build fails if a React update moves them.
 */
function noInnerHtml(): Plugin {
  const write = '(domElement.innerHTML = key)';
  return {
    name: 'magpie:no-inner-html',
    enforce: 'pre',
    transform(code, id) {
      if (!id.split('?')[0].endsWith('react-dom-client.production.js')) return;
      const found = code.split(write).length - 1;
      if (found !== 2) throw new Error(`react-dom changed: expected 2 innerHTML writes, found ${found}`);
      return code.replaceAll(write, '(function () { throw Error("dangerouslySetInnerHTML is disabled in Magpie"); })()');
    },
  };
}
