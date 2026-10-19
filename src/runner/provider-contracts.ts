/**
 * The one place that names providers.
 *
 * Importing this module registers every built-in provider request contract.
 * `src/runner/pi.ts` imports it for the side effect and then works only through
 * the registry, so adding or removing a vendor touches this file and that
 * vendor's own module.
 */
import "./deepseek-request-contract.ts";
