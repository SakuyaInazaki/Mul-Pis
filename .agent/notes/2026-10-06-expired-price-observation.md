# Expired native-CNY price observation

The accounting-only campaign now checks a live native-CNY profile at both request reservation and response/unknown disposition. If the reviewed quote expires while a request is open, the host retains transport identity, reported usage and uncertainty, but classifies that request's CNY fee as unpriced rather than applying the expired quote. Cached numeric reservation estimates for the still-open request are cleared from status; earlier requests genuinely settled while the profile was current retain their settled observations. Expiry does not block another provider transport or make an unknown fee free.

Offline fake-clock tests cover expiry before reservation, between reservation and received response, between reservation and failed transport, and preservation of an earlier settled request after the cutoff. No credential or provider request was made for these tests.
