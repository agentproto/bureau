/**
 * One-shot WhatsApp Cloud API send — a thin, connect-free transport.
 *
 * Deliberately NOT a full messaging-platform WhatsApp provider: that one
 * auto-connects and runs a webhook listener in its constructor (a long-running
 * service shape that would hang a fire-and-forget CLI alert). This is a stateless
 * `fetch` over the Cloud API — call it and it's done. Zero deps beyond `fetch`,
 * so it stays inside the standalone browser product family.
 *
 * Free-form text/document only delivers inside the 24h customer-service window —
 * the recipient must message the Business number once to open it.
 */

export interface WhatsAppCredentials {
  phoneNumberId: string
  accessToken: string
  /** Graph API version, default v21.0. */
  apiVersion?: string
}

export interface WhatsAppSendResult {
  id?: string
}

function apiRoot(creds: WhatsAppCredentials): string {
  const version = creds.apiVersion ?? "v21.0"
  return `https://graph.facebook.com/${version}/${creds.phoneNumberId}`
}

/** POST a message payload, throwing a readable error on a non-2xx. */
async function postMessage(
  creds: WhatsAppCredentials,
  body: Record<string, unknown>
): Promise<WhatsAppSendResult> {
  const res = await fetch(`${apiRoot(creds)}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${creds.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  })
  const json = (await res.json().catch(() => null)) as {
    messages?: Array<{ id?: string }>
    error?: unknown
  } | null
  if (!res.ok)
    throw new Error(
      `whatsapp send ${res.status}: ${JSON.stringify(json?.error ?? json).slice(0, 200)}`
    )
  return { id: json?.messages?.[0]?.id }
}

/** Send a plain text message. */
export function sendWhatsAppText(
  creds: WhatsAppCredentials,
  to: string,
  text: string
): Promise<WhatsAppSendResult> {
  return postMessage(creds, {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { preview_url: false, body: text },
  })
}

/** Upload raw bytes as WhatsApp media and return the media id (id-send avoids
 *  needing a public URL for e.g. a generated PDF). */
async function uploadMedia(
  creds: WhatsAppCredentials,
  bytes: Uint8Array,
  filename: string,
  mime: string
): Promise<string> {
  const form = new FormData()
  form.append("messaging_product", "whatsapp")
  form.append("type", mime)
  // Copy into a fresh ArrayBuffer-backed view — Blob's BlobPart rejects a
  // SharedArrayBuffer-backed Uint8Array (which the input type allows).
  form.append(
    "file",
    new Blob([new Uint8Array(bytes)], { type: mime }),
    filename
  )
  const res = await fetch(`${apiRoot(creds)}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${creds.accessToken}` },
    body: form,
  })
  const json = (await res.json().catch(() => null)) as {
    id?: string
    error?: unknown
  } | null
  if (!res.ok || !json?.id)
    throw new Error(
      `whatsapp media upload ${res.status}: ${JSON.stringify(json?.error ?? json).slice(0, 200)}`
    )
  return json.id
}

export interface WhatsAppDocument {
  /** Send by public link (https) — mutually exclusive with `bytes`. */
  link?: string
  /** Send by uploading raw bytes (e.g. a local PDF) — uploaded then sent by id. */
  bytes?: Uint8Array
  /** File name shown to the recipient. */
  filename: string
  caption?: string
  /** MIME type for an uploaded document, default application/pdf. */
  mime?: string
}

/** Send a document — by https link, or by uploading raw bytes first. */
export async function sendWhatsAppDocument(
  creds: WhatsAppCredentials,
  to: string,
  doc: WhatsAppDocument
): Promise<WhatsAppSendResult> {
  const mime = doc.mime ?? "application/pdf"
  const document = doc.link
    ? { link: doc.link, filename: doc.filename, caption: doc.caption }
    : {
        id: await uploadMedia(
          creds,
          doc.bytes ??
            (() => {
              throw new Error("sendWhatsAppDocument: provide `link` or `bytes`")
            })(),
          doc.filename,
          mime
        ),
        filename: doc.filename,
        caption: doc.caption,
      }
  return postMessage(creds, {
    messaging_product: "whatsapp",
    to,
    type: "document",
    document,
  })
}

/** Send an image by uploading raw bytes (e.g. a challenge screenshot) — it
 *  renders inline in the chat rather than as a downloadable file. */
export async function sendWhatsAppImage(
  creds: WhatsAppCredentials,
  to: string,
  img: { bytes: Uint8Array; mime?: string; caption?: string; filename?: string }
): Promise<WhatsAppSendResult> {
  const mime = img.mime ?? "image/png"
  const id = await uploadMedia(
    creds,
    img.bytes,
    img.filename ?? "challenge.png",
    mime
  )
  return postMessage(creds, {
    messaging_product: "whatsapp",
    to,
    type: "image",
    image: { id, caption: img.caption },
  })
}
