# n8n bonus: signed order sync and failure notifications

The exports implement an **alternative** to the TypeScript receiver for the webhook, HubSpot sync and idempotency bonus. They call HubSpot directly rather than forwarding to the app. The main app still provides SQLite history and the sales dashboard; executions of this alternative workflow appear in n8n, not the app dashboard.

## Start n8n

Configure the project's `.env` first, including a real `WEBHOOK_SECRET`. With Docker Desktop running:

```powershell
docker compose --profile automation up -d n8n
```

Open **http://localhost:5678** and create the local owner account. The `n8n_data` volume retains the account, credentials and execution data. The Compose configuration permits the crypto module and environment-variable access for these trusted local workflows. It disables secure cookies only for this localhost HTTP demo. Do not expose this instance publicly with these settings.

If you use a different self-hosted n8n instance, enable `NODE_FUNCTION_ALLOW_BUILTIN=crypto`, `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` and supply `WEBHOOK_SECRET`, `HUBSPOT_PIPELINE`, `HUBSPOT_DEAL_STAGE` and `N8N_FAILURE_WEBHOOK_URL`. In external task-runner deployments, the crypto allowlist must also be configured on the runner.

## One-time HubSpot setup

Create a private-app token in a developer test account with Contact and Deal read/write scopes. Use the internal pipeline and stage IDs from that account.

This workflow uses an additional **unique Deal property**, `store_order_id`. Create it once using HubSpot's API explorer or a separate authenticated API client:

```http
POST https://api.hubapi.com/crm/v3/properties/deals
Authorization: Bearer <test-account-token>
Content-Type: application/json
```

```json
{
  "groupName": "dealinformation",
  "name": "store_order_id",
  "label": "Store order ID",
  "type": "string",
  "fieldType": "text",
  "hasUniqueValue": true
}
```

Property creation requires `crm.schemas.deals.write`; use that scope for setup and remove it afterward if no longer needed. If the property already exists, verify that it has `hasUniqueValue: true`. Do not recreate or delete existing account properties blindly.

## Import and configure

1. Import [error-notification.json](error-notification.json) and [order-sync.json](order-sync.json) through **Import from File**. Both exports are inactive.
2. Create one **Header Auth** credential named `HubSpot private app`, with header name `Authorization` and value `Bearer <your-test-account-token>`.
3. Select that credential in **Upsert contact**, **Upsert deal** and **Associate contact**. Export files intentionally contain no token or credential IDs.
4. Set `N8N_FAILURE_WEBHOOK_URL` in `.env` to a receiver that you control, then recreate the n8n container so it receives the new environment value. Configure any receiver authentication in the **Notify failure** node using an n8n credential; never put it in the committed JSON.
5. In the main workflow's **Settings > Error workflow**, select **Stage 2 - Failure notification**. Selecting it manually avoids relying on instance-specific workflow IDs.
6. Publish/activate the main workflow. An Error Trigger workflow does not need its own webhook or scheduled activation. Error workflows run for failed automatic executions; clicking a node manually is not the same trigger path.

Do not attach the error workflow until its destination is configured. Importing these files alone sends no notifications.

## Send a signed order

The sample sender accepts an optional target URL after the order ID:

```powershell
cmd /c npm run send-order -- N8N-10482 http://localhost:5678/webhook/stage2-orders
```

Run that command twice and check HubSpot. Both responses should contain the same Deal ID. The workflow returns `success` for both deliveries: the second delivery updates the existing uniquely identified record rather than creating another one.

To use the test webhook, click **Listen for test event** and substitute `/webhook-test/stage2-orders`. Use a different order-ID prefix from the TypeScript demo: the main app uses Deal-name recovery, while this workflow uses the unique property. Do not alternate both implementations for the same order ID.

## Workflow behavior

```text
Webhook (raw body)
  -> Validate payload and constant-time HMAC
  -> Valid?
      false -> 400/401/413 response
      true  -> Upsert Contact by email
            -> Check batch response
            -> Upsert Deal by unique store_order_id
            -> Check batch response
            -> Associate Contact
            -> 200 response

Failed automatic execution
  -> Error Trigger workflow
  -> POST a failure notification to the configured receiver
```

Batch upserts allow create-or-update behavior without separate search/create races. Because HubSpot enforces uniqueness on the Deal's order-ID property, the same create-or-update operation can be safely retried. HTTP nodes have four total attempts separated by two seconds, and 15-second timeouts. These native n8n retries use a fixed delay, separate from the main app's exponential backoff. Partial batch errors are checked before continuing.

The error notification includes the workflow name, execution ID/URL and last node. It does not include the API token, customer payload or raw API error body. Handled invalid-input responses are not failed executions and therefore do not notify.

This bonus upserts records for duplicate deliveries; unlike the main app's first-payload-wins policy, a changed payload for the same order ID updates the existing Deal and Contact. It does not add dashboard/database functionality to n8n.

## Validation

`npm test` executes the exported validator with synthetic raw bytes and checks the workflow graph, upsert keys, retry settings and Error Trigger. The JSON is generated deterministically with:

```powershell
node n8n/build-workflows.mjs
```

The n8n engine and actual HubSpot account still need an integration test: import both workflows, configure the property and credentials, submit the order twice, and cause an automatic execution failure to verify notification delivery to your receiver. Local unit tests do not establish import/runtime compatibility or actual delivery.

References: [raw-body Webhook option](https://docs.n8n.io/integrations/builtin/core-nodes/n8n-nodes-base.webhook/), [binary buffers](https://docs.n8n.io/code/cookbook/code-node/get-binary-data-buffer/), [error workflows](https://docs.n8n.io/flow-logic/error-handling/), [HubSpot Deals API](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/deals/guide).
