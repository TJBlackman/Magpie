import { browser } from 'wxt/browser';

/**
 * Make the extension's own segment fetches look like they came from the page:
 * Referer and Origin set to the page. CDNs commonly 403 without them.
 *
 * Chrome: declarativeNetRequest session rules keyed by host.
 * Firefox: blocking webRequest listener that rewrites our own requests.
 */
const rules = new Map<string, { referer: string; origin: string }>();

export async function setHeaderRule(host: string, referer: string, origin: string): Promise<void> {
  rules.set(host, { referer, origin });
  if (import.meta.env.FIREFOX) {
    ensureFirefoxListener();
    return;
  }
  await setChromeRule(host, referer, origin);
}

/* Chrome */
const ruleIds = new Map<string, number>();
let nextId = 1000;

async function setChromeRule(host: string, referer: string, origin: string) {
  const dnr = (browser as unknown as { declarativeNetRequest?: typeof chrome.declarativeNetRequest }).declarativeNetRequest;
  if (!dnr) return;
  let id = ruleIds.get(host);
  if (!id) {
    id = nextId++;
    ruleIds.set(host, id);
  }
  const requestHeaders: chrome.declarativeNetRequest.ModifyHeaderInfo[] = [];
  if (referer) requestHeaders.push({ header: 'Referer', operation: 'set', value: referer });
  if (origin) requestHeaders.push({ header: 'Origin', operation: 'set', value: origin });
  if (requestHeaders.length === 0) return;
  const extensionHost = new URL(browser.runtime.getURL('')).hostname;
  await dnr.updateSessionRules({
    removeRuleIds: [id],
    addRules: [
      {
        id,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders },
        condition: {
          urlFilter: `||${host}/`,
          // Only our own fetches (initiated from the extension origin), never the page's.
          initiatorDomains: [extensionHost],
          resourceTypes: ['xmlhttprequest', 'other', 'media'],
        },
      },
    ],
  });
}

/* Firefox */
let firefoxListening = false;
function ensureFirefoxListener() {
  if (firefoxListening) return;
  firefoxListening = true;
  const self = browser.runtime.getURL('');
  browser.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      const d = details as unknown as { originUrl?: string; documentUrl?: string; tabId: number };
      const fromUs = (d.originUrl ?? d.documentUrl ?? '').startsWith(self) || (d.tabId === -1 && !d.originUrl);
      if (!fromUs) return {};
      let host = '';
      try {
        host = new URL(details.url).host;
      } catch {
        return {};
      }
      const rule = rules.get(host);
      if (!rule) return {};
      const headers = (details.requestHeaders ?? []).filter((h) => !/^(referer|origin)$/i.test(h.name));
      if (rule.referer) headers.push({ name: 'Referer', value: rule.referer });
      if (rule.origin) headers.push({ name: 'Origin', value: rule.origin });
      return { requestHeaders: headers };
    },
    { urls: ['<all_urls>'] },
    ['blocking', 'requestHeaders'],
  );
}
