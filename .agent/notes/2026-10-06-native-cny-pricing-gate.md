# Native-CNY billing gate for future campaign requests

The private campaign now checks the connected DeepSeek account's billing currency with a read-only account API request before constructing a request budget or starting a model session. Only a live, host-verified CNY peak-price profile is accepted. USD, mixed, unavailable, or stale pricing evidence fails closed; no guessed foreign-exchange rate or off-peak discount is used.

New request reservations use the published CNY peak quotes for the configured model: 2 CNY per million input cache-miss tokens, 0.04 CNY per million cache-hit tokens, and 8 CNY per million output tokens. The budget internally normalizes the custom SDK quote table by the verified table ratio, which is a price-table mapping, not a currency conversion. Historical settled amounts and unknown reservations remain unchanged under the same global campaign ceiling.

The verified profile is a safe metadata-only record in encrypted budget status and the authenticated carry audit. The account response body, balance amount, and credential are never serialized. Offline tests use a synthetic account response and make no provider calls.
