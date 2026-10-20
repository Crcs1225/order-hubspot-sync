import { setTimeout as sleep } from 'node:timers/promises';
import { dealProperties, type Order } from './order.js';

interface RecordResult { id: string }
interface SearchResult { results: RecordResult[] }
export class HubSpotError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export class HubSpot {
  constructor(private token: string, private pipeline: string, private stage: string,
    private fetcher: typeof fetch = fetch, private wait: (ms: number) => Promise<unknown> = sleep) {}

  private async request<T>(path: string, method: string, body?: unknown, safeToRetry = true): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await this.fetcher(`https://api.hubapi.com${path}`, {
          method, headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15000),
        });
      } catch {
        if (!safeToRetry || attempt === 3) throw new Error('HubSpot network error or timeout.');
        await this.wait(1000 * 2 ** attempt); continue;
      }
      if (response.ok) {
        const text = await response.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }
      const retryable = response.status === 429 || response.status >= 500;
      // A failed create may already have committed. Never repeat it blindly.
      if (retryable && (safeToRetry || response.status === 429) && attempt < 3) {
        const header = response.headers.get('Retry-After');
        const delay = header ? (Number.isFinite(Number(header)) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : NaN;
        await response.text();
        await this.wait(Number.isFinite(delay) ? Math.max(0, delay) : 1000 * 2 ** attempt);
        continue;
      }
      // Do not persist API response bodies: they may contain customer data or secrets.
      throw new HubSpotError(response.status, `HubSpot HTTP ${response.status}. Check token scopes, pipeline/stage and account settings.`);
    }
  }

  async upsertContact(order: Order): Promise<string> {
    const c = order.customer;
    const properties = { email: c.email.toLowerCase(), firstname: c.first_name, lastname: c.last_name, phone: c.phone };
    const found = await this.request<SearchResult>('/crm/v3/objects/contacts/search', 'POST', {
      filterGroups: [{ filters: [{ propertyName: 'email', operator: 'EQ', value: properties.email }] }], limit: 1,
    });
    const existing = found.results[0]?.id;
    if (existing) {
      await this.request(`/crm/v3/objects/contacts/${encodeURIComponent(existing)}`, 'PATCH', { properties });
      return existing;
    }
    try {
      return (await this.request<RecordResult>('/crm/v3/objects/contacts', 'POST', { properties }, false)).id;
    } catch (error) {
      // Email is unique in HubSpot. A concurrent create or delayed search index can yield 409.
      if (!(error instanceof HubSpotError) || error.status !== 409) throw error;
      const contact = await this.request<RecordResult>(`/crm/v3/objects/contacts/${encodeURIComponent(properties.email)}?idProperty=email`, 'GET');
      await this.request(`/crm/v3/objects/contacts/${contact.id}`, 'PATCH', { properties });
      return contact.id;
    }
  }
  async findDeal(orderId: string): Promise<string | undefined> {
    const result = await this.request<SearchResult>('/crm/v3/objects/deals/search', 'POST', {
      filterGroups: [{ filters: [{ propertyName: 'dealname', operator: 'EQ', value: `Order ${orderId}` }] }], limit: 2,
    });
    if (result.results.length > 1) throw new Error('Multiple deals match this order. Resolve them in HubSpot before retrying.');
    return result.results[0]?.id;
  }
  async createDeal(order: Order): Promise<string> {
    return (await this.request<RecordResult>('/crm/v3/objects/deals', 'POST', {
      properties: dealProperties(order, this.pipeline, this.stage),
    }, false)).id;
  }
  async associate(deal: string, contact: string) {
    await this.request(`/crm/v4/objects/deals/${encodeURIComponent(deal)}/associations/default/contacts/${encodeURIComponent(contact)}`, 'PUT');
  }
}
