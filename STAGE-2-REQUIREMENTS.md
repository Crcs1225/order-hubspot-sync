# Stage 2 requirements

This checklist summarizes the Stage 2 take-home project in the candidate assessment. It is a reference to the assessment requirements, not a record of completed live testing. See [Implementation answers](STAGE-2-IMPLEMENTATION.md) for what this project implements.

## Scenario

An online store sends an order-created webhook. The integration must create a HubSpot Deal linked to the customer's Contact, creating the Contact when necessary. The sales team needs a simple page showing recent syncs and failures.

## Required work

| Number | Requirement | Expected result |
| --- | --- | --- |
| 22 | Webhook receiver in Node.js/TypeScript | Accept an order webhook, validate its payload, and verify an HMAC signature using a shared secret. |
| 23 | HubSpot sync | Find the Contact by email, create or update it, create a Deal with name, amount, close date and pipeline stage, and associate it with the Contact. |
| 24 | Idempotency | Receiving the same `order_id` twice must not create two Deals. |
| 25 | Reliability | Handle HubSpot 429 and 5xx responses with retry and backoff, and log failures. |
| 26 | Database storage | Save each sync attempt's order ID, status, HubSpot IDs, error and timestamp in SQLite or PostgreSQL. |
| 27 | Frontend dashboard | List the latest 50 sync attempts with their statuses and provide a retry button for failed attempts. |
| 28 | Second language | Use Python, PHP or C# to export HubSpot Deals created in the previous seven days to CSV. |
| 29 | README | Explain setup, architecture, assumptions and improvements that could be made with more time. |

## Optional bonuses

- An n8n workflow reproducing the webhook, sync and duplicate-protection behavior, with an error-notification workflow.
- Docker Compose to run the stack.
- Automated tests for mapping and idempotency.

These are optional additions and do not replace the required work.

## Assessment constraints and submission

- Use a free HubSpot developer test account and test data, not real client data.
- Keep credentials out of the repository.
- AI assistance is allowed, but the candidate must be able to explain every line during Stage 3.
- Submit a public or shared GitHub repository link, plus the n8n JSON if attempted.
- The assessment gives a 72-hour window and estimates approximately four to six hours of work.

The project code is present locally. Creating the test account, configuring credentials, verifying the live integration and submitting a repository remain separate steps.
