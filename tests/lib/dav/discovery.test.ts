import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverCollections } from '../../../src/lib/dav/discovery.js';

const ms = (body: string) =>
  new Response(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${body}</D:multistatus>`, { status: 207 });

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === 'https://caldav.example.com/.well-known/caldav') {
        return ms(`<D:response><D:href>/dav/calendars/</D:href><D:propstat><D:prop>
          <D:current-user-principal><D:href>/dav/principals/user/me@example.com/</D:href></D:current-user-principal>
        </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
      }
      if (url === 'https://caldav.example.com/dav/principals/user/me@example.com/') {
        return ms(`<D:response><D:href>/dav/principals/user/me@example.com/</D:href><D:propstat><D:prop>
          <C:calendar-home-set><D:href>/dav/calendars/user/me@example.com/</D:href></C:calendar-home-set>
        </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
      }
      if (url === 'https://caldav.example.com/dav/calendars/user/me@example.com/') {
        return ms(`
          <D:response><D:href>/dav/calendars/user/me@example.com/</D:href><D:propstat><D:prop>
            <D:resourcetype><D:collection/></D:resourcetype>
          </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
          <D:response><D:href>/dav/calendars/user/me@example.com/abc-123/</D:href><D:propstat><D:prop>
            <D:displayname>Personal</D:displayname>
            <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
            <C:supported-calendar-component-set><C:comp name="VEVENT"/><C:comp name="VTODO"/></C:supported-calendar-component-set>
          </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
          <D:response><D:href>/dav/calendars/user/me@example.com/tasks/</D:href><D:propstat><D:prop>
            <D:displayname>Tasks</D:displayname>
            <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
            <C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set>
          </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
      }
      if (url === 'https://carddav.example.com/.well-known/carddav') {
        return ms(`<D:response><D:href>/dav/</D:href><D:propstat><D:prop>
          <D:current-user-principal><D:href>/dav/principals/user/me@example.com/</D:href></D:current-user-principal>
        </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
      }
      if (url === 'https://carddav.example.com/dav/principals/user/me@example.com/') {
        return ms(`<D:response><D:href>/dav/principals/user/me@example.com/</D:href><D:propstat><D:prop>
          <CARD:addressbook-home-set xmlns:CARD="urn:ietf:params:xml:ns:carddav"><D:href>/dav/addressbooks/user/me@example.com/</D:href></CARD:addressbook-home-set>
        </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
      }
      if (url === 'https://carddav.example.com/dav/addressbooks/user/me@example.com/') {
        return ms(`
          <D:response><D:href>/dav/addressbooks/user/me@example.com/</D:href><D:propstat><D:prop>
            <D:resourcetype><D:collection/></D:resourcetype>
          </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>
          <D:response><D:href>/dav/addressbooks/user/me@example.com/Default/</D:href><D:propstat><D:prop>
            <D:displayname>Personal</D:displayname>
            <D:resourcetype><D:collection/><CARD:addressbook xmlns:CARD="urn:ietf:params:xml:ns:carddav"/></D:resourcetype>
          </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
      }
      return new Response('', { status: 404 });
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('discoverCollections', () => {
  it('follows principal → calendar home → event calendars, skipping the home itself and task-only lists', async () => {
    const calendars = await discoverCollections('https://caldav.example.com', { username: 'me@example.com', password: 'pw' }, 'calendar');
    expect(calendars).toEqual([{ displayName: 'Personal', url: 'https://caldav.example.com/dav/calendars/user/me@example.com/abc-123/' }]);
  });

  it('finds address books the same way, from the CardDAV well-known URL', async () => {
    const books = await discoverCollections('https://carddav.example.com', { username: 'me@example.com', password: 'pw' }, 'addressbook');
    expect(books).toEqual([{ displayName: 'Personal', url: 'https://carddav.example.com/dav/addressbooks/user/me@example.com/Default/' }]);
  });
});

describe('discoverCollections across hosts', () => {
  // A home set on a sibling host, the way iCloud answers (caldav.icloud.com → p52-caldav.icloud.com).
  function serverWithHomeAt(homeUrl: string) {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://caldav.icloud.com/.well-known/caldav') {
        return ms(`<D:response><D:href>/</D:href><D:propstat><D:prop>
          <D:current-user-principal><D:href>/123/principal/</D:href></D:current-user-principal>
        </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
      }
      if (url === 'https://caldav.icloud.com/123/principal/') {
        return ms(`<D:response><D:href>/123/principal/</D:href><D:propstat><D:prop>
          <C:calendar-home-set><D:href>${homeUrl}</D:href></C:calendar-home-set>
        </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
      }
      return ms(`<D:response><D:href>/123/calendars/home/</D:href><D:propstat><D:prop>
        <D:displayname>Home</D:displayname><D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
      </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`);
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it("follows a home set on a sibling host of the server's, as iCloud's is", async () => {
    serverWithHomeAt('https://p52-caldav.icloud.com:443/123/calendars/');
    const calendars = await discoverCollections('https://caldav.icloud.com', { username: 'me@icloud.com', password: 'pw' }, 'calendar');
    expect(calendars).toEqual([{ displayName: 'Home', url: 'https://p52-caldav.icloud.com/123/calendars/home/' }]);
  });

  it('refuses to send the app password to an unrelated host a server points at', async () => {
    const fetchMock = serverWithHomeAt('https://collector.example.net/123/calendars/');
    await expect(discoverCollections('https://caldav.icloud.com', { username: 'me@icloud.com', password: 'pw' }, 'calendar')).rejects.toThrow(
      /collector\.example\.net/,
    );
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).hostname)).not.toContain('collector.example.net');
  });
});
