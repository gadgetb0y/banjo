/**
 * Finds the calendars or address books on a DAV account (RFC 6764 service
 * discovery, then RFC 4791 / RFC 6352 home sets), so the owner can pick one
 * for CALDAV_CALENDAR_URL or CARDDAV_ADDRESSBOOK_URL. Used by
 * scripts/dav-check.ts; Banjo itself is configured with one URL of each. The
 * one runtime lookup is discoverCalendarUserAddresses below, which finds the
 * owner's own addresses for skipping invitations they declined.
 */

import { davRequest, okProps, parseMultistatus, textOf, type DavCredentials } from './davHttp.js';

export type CollectionKind = 'calendar' | 'addressbook';

export interface DiscoveredCollection {
  url: string;
  displayName: string;
}

const XML_HEADERS = { 'Content-Type': 'application/xml; charset=utf-8' };

const KINDS = {
  calendar: { wellKnown: '/.well-known/caldav', homeSet: '<c:calendar-home-set/>', homeSetProp: 'calendar-home-set' },
  addressbook: { wellKnown: '/.well-known/carddav', homeSet: '<card:addressbook-home-set/>', homeSetProp: 'addressbook-home-set' },
} as const;

async function propfind(url: string, credentials: DavCredentials, depth: '0' | '1', props: string) {
  const response = await davRequest({
    method: 'PROPFIND',
    url,
    credentials,
    headers: { ...XML_HEADERS, Depth: depth },
    body: `<?xml version="1.0" encoding="utf-8"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:card="urn:ietf:params:xml:ns:carddav">
  <d:prop>${props}</d:prop>
</d:propfind>`,
  });
  // Resolve hrefs against where we ended up, after any redirect.
  return { baseUrl: response.url || url, responses: parseMultistatus(await response.text()) };
}

/**
 * Guards the app password: discovery follows hrefs the server hands back,
 * and each request carries Basic auth. The same host, or a sibling under
 * the same parent domain (iCloud's caldav.icloud.com points at
 * p52-caldav.icloud.com), is the same service; anything else is refused.
 */
function assertSameService(url: string, serverUrl: string): void {
  const host = new URL(url).hostname;
  const serverHost = new URL(serverUrl).hostname;
  if (host === serverHost) return;
  const parent = (h: string) => h.split('.').slice(1).join('.');
  if (parent(serverHost).includes('.') && parent(host) === parent(serverHost)) return;
  throw new Error(`${serverUrl} pointed discovery at ${host}, an unrelated host — not sending the app password there`);
}

function hrefIn(prop: unknown): string | undefined {
  if (!prop || typeof prop !== 'object') return undefined;
  const hrefs = (prop as { href?: unknown[] }).href;
  return textOf(hrefs?.[0]);
}

/**
 * Lists the `kind` collections for `credentials` on the server at `serverUrl`
 * (e.g. https://caldav.fastmail.com or https://carddav.fastmail.com).
 * Calendars that hold only tasks (VTODO) are left out.
 */
export async function discoverCollections(serverUrl: string, credentials: DavCredentials, kind: CollectionKind): Promise<DiscoveredCollection[]> {
  const { wellKnown, homeSet, homeSetProp } = KINDS[kind];

  const start = new URL(wellKnown, serverUrl).toString();
  const principalLookup = await propfind(start, credentials, '0', '<d:current-user-principal/>');
  const principalHref = principalLookup.responses.map((r) => hrefIn(okProps(r)['current-user-principal'])).find(Boolean);
  if (!principalHref) throw new Error(`No current-user-principal found at ${start}`);
  const principalUrl = new URL(principalHref, principalLookup.baseUrl).toString();
  assertSameService(principalUrl, serverUrl);

  const homeLookup = await propfind(principalUrl, credentials, '0', homeSet);
  const homeHref = homeLookup.responses.map((r) => hrefIn(okProps(r)[homeSetProp])).find(Boolean);
  if (!homeHref) throw new Error(`No ${homeSetProp} found for principal ${principalUrl}`);
  const homeUrl = new URL(homeHref, homeLookup.baseUrl).toString();
  assertSameService(homeUrl, serverUrl);

  const listing = await propfind(homeUrl, credentials, '1', '<d:displayname/><d:resourcetype/><c:supported-calendar-component-set/>');

  const collections: DiscoveredCollection[] = [];
  for (const response of listing.responses) {
    const props = okProps(response);
    const resourceType = props.resourcetype;
    const isKind = !!resourceType && typeof resourceType === 'object' && kind in resourceType;
    if (!isKind) continue;
    if (kind === 'calendar' && props['supported-calendar-component-set']) {
      // Skip task-only (VTODO) collections when the server says what a collection holds.
      if (!JSON.stringify(props['supported-calendar-component-set']).includes('VEVENT')) continue;
    }
    collections.push({
      url: new URL(response.href, listing.baseUrl).toString(),
      displayName: textOf(props.displayname) ?? '(unnamed)',
    });
  }
  return collections;
}

/**
 * The calendar owner's own addresses (RFC 6638 calendar-user-address-set on
 * their principal), lowercased without "mailto:" — what invitations are
 * addressed to, which on Fastmail can be every alias across custom domains
 * rather than the login. Found from the calendar collection itself, so it
 * needs no server URL beyond CALDAV_CALENDAR_URL. Throws when the server
 * doesn't say; the caller falls back.
 */
export async function discoverCalendarUserAddresses(collectionUrl: string, credentials: DavCredentials): Promise<string[]> {
  const principalLookup = await propfind(collectionUrl, credentials, '0', '<d:current-user-principal/>');
  const principalHref = principalLookup.responses.map((r) => hrefIn(okProps(r)['current-user-principal'])).find(Boolean);
  if (!principalHref) throw new Error(`No current-user-principal found at ${collectionUrl}`);
  const principalUrl = new URL(principalHref, principalLookup.baseUrl).toString();
  assertSameService(principalUrl, collectionUrl);

  const addressLookup = await propfind(principalUrl, credentials, '0', '<c:calendar-user-address-set/>');
  const prop = addressLookup.responses.map((r) => okProps(r)['calendar-user-address-set']).find(Boolean);
  const hrefs = prop && typeof prop === 'object' ? ((prop as { href?: unknown[] }).href ?? []) : [];
  const addresses = hrefs
    .map((h) => textOf(h)?.trim())
    .filter((h): h is string => !!h && /^mailto:/i.test(h))
    .map((h) => h.replace(/^mailto:/i, '').toLowerCase());
  if (!addresses.length) throw new Error(`No calendar-user-address-set mailto: addresses for principal ${principalUrl}`);
  return [...new Set(addresses)];
}
