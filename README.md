# Generation API contracts and client

Private `@reliquary/api` 0.1.0 contains the existing generation contracts, runtime validators, a request-injected TypeScript client and a bounded fetch transport. The [OpenAPI document](contracts/generation.openapi.json) uses the explicit OpenAPI 3.1.1 / JSON Schema 2020-12 compatibility baseline.

Pin the reviewed `vendor/api-client-0.1.0.tgz` artifact in the consumer's package manifest and lockfile. Updating the package requires an explicit version and integrity update; this release does not depend on a public registry.

```ts
import { createGenerationClient, createGenerationTransport } from '@reliquary/api';

const transport = createGenerationTransport({
  origin: 'https://app.reliqua.ai',
  apiKey: process.env.GENERATION_API_KEY, // existing orders:write workspace key
});
const generation = createGenerationClient(transport.request);
const catalog = await generation.catalog();
```

The client provides `catalog`, `quote`, `create`, `orders`, `detail`, `cancel` and `downloadPath`. Public catalogue reads need no key. An approved account reviews the quote's configuration, price and expiry before explicitly calling `create(quoteId, originalRequestKey)`. Preserve that quote and its 16–80 character `Idempotency-Key` if the result is ambiguous. The transport never retries mutations automatically. Cancellation can remain asynchronous; read the resulting order state.

Browser callers reuse their existing same-origin session transport:

```ts
const generation = createGenerationClient(
  (path, init) => platformApi.request(path, init),
  { audience: 'browser' },
);
```

That transport owns session cookies, approved mutation origins, XSRF and session expiry. API-key routes use `/api/v1/dataset-orders`; browser routes use `/api/batch/orders`. Browser order responses include billing and browser delivery URLs; key responses omit that receipt. `catalog()` and `quote()` preserve the common response format. List responses contain the newest 100 owned orders and expose no cursor.

For key downloads, `transport.download(orderId, deliveryId, fileName, { offset, maxBytes })` returns bytes and content metadata. Each read is bounded to at most 256 KiB by the client, checks 200/206 and validates partial ranges. The server also permits full-file responses; the client bound is not a server range limit. Resolve identifiers from owned detail and verify file size/digest when assembling an artifact.

Catalogue visibility, account permission, ordering gates, execution capacity, delivery, verification and financial settlement are separate facts. This package documents the existing workflow and does not enable services or guarantee live ordering. Structural schemas complement runtime checks for configuration identity, resolved delivery links, unique identifiers, monetary precision and receipt sums. Existing runtime contracts and workload qualification remain authoritative.

```sh
npm ci
npm test
npm pack
```

Checks use Node's test runner, structural OpenAPI reference/operation assertions and synthetic examples through the shipped runtime validators. They make no live requests or orders.
