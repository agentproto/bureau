/**
 * notify/ — connect-free outbound alert transports for the browser product
 * family. One-shot senders (no provider lifecycle, no webhooks) so a CLI alert
 * or daemon notification fires and returns. WhatsApp today; telegram/email slot
 * in as sibling modules.
 */

export * from "./whatsapp.js"
