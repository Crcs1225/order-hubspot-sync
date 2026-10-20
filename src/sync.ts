import type { Order } from './order.js';
import { Store } from './store.js';
import { HubSpotError } from './hubspot.js';

export interface CRM {
  upsertContact(order: Order): Promise<string>;
  findDeal(orderId: string): Promise<string | undefined>;
  createDeal(order: Order): Promise<string>;
  associate(deal: string, contact: string): Promise<void>;
}

export class SyncService {
  private active = new Set<string>();
  constructor(private store: Store, private crm: CRM) {}

  async process(incoming: Order) {
    if (this.active.has(incoming.order_id)) throw new Error('Order is already processing.');
    this.active.add(incoming.order_id);
    try {
      const saved = this.store.save(incoming);
      const order: Order = JSON.parse(saved.payload); // First accepted payload wins.
      const attempt = this.store.begin(order.order_id);
      let contact = saved.contact_id; let deal = saved.deal_id; let uncertain = Boolean(saved.uncertain);
      const persist = (synced = false) => this.store.update(order.order_id, contact, deal, synced, uncertain);
      if (saved.synced) return this.store.finish(attempt, 'duplicate', contact, deal);
      try {
        contact = await this.crm.upsertContact(order); persist();
        if (!deal) {
          deal = await this.crm.findDeal(order.order_id) ?? null;
          if (deal) { uncertain = false; persist(); }
          if (!deal && uncertain) throw new Error('Previous deal creation has an uncertain outcome. Retry later to find it; do not create another deal. See README recovery steps.');
          if (!deal) {
            uncertain = true; persist(); // Persist before the request, including across crashes.
            try { deal = await this.crm.createDeal(order); }
            catch (error) {
              // A request timeout does not prove that the remote create was rejected.
              if (error instanceof HubSpotError && error.status >= 400 && error.status < 500 && error.status !== 408) {
                uncertain = false; persist();
              }
              throw error;
            }
            uncertain = false; persist();
          }
        }
        await this.crm.associate(deal, contact);
        persist(true);
        return this.store.finish(attempt, 'success', contact, deal);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown sync failure';
        console.error(`Sync failed for ${order.order_id}: ${message}`);
        return this.store.finish(attempt, 'failed', contact, deal, message);
      }
    } finally { this.active.delete(incoming.order_id); }
  }
}
