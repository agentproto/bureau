/**
 * JSON-RPC 2.0 wire-format types — vendored.
 *
 * Pure protocol shapes (no runtime, no deps), kept local so browser-core
 * stays standalone-publishable rather than depending on an app `core`
 * package just for two type aliases. The shapes follow the spec exactly:
 * https://www.jsonrpc.org/specification
 */

/** Identifier shape used for JSON-RPC request/response correlation. */
export type JsonRpcId = string | number | null

/** Standard JSON-RPC 2.0 error envelope. */
export interface JsonRpcErrorBody {
  code: number
  message: string
  data?: unknown
}

/**
 * Request frame. `jsonrpc` is technically required by the 2.0 spec but
 * many embedded clients omit it — we accept either. `id` is absent for
 * notifications (server doesn't reply).
 */
export interface JsonRpcRequest<TParams = unknown> {
  jsonrpc?: "2.0"
  id?: JsonRpcId
  method: string
  params?: TParams
}

/** Successful response frame. */
export interface JsonRpcSuccess<TResult = unknown> {
  jsonrpc: "2.0"
  id: JsonRpcId
  result: TResult
}

/** Error response frame. */
export interface JsonRpcError {
  jsonrpc: "2.0"
  id: JsonRpcId
  error: JsonRpcErrorBody
}

/**
 * Union response — either success or error. Generic in TResult so typed
 * clients can narrow by checking which discriminant is present.
 */
export type JsonRpcResponse<TResult = unknown> =
  | JsonRpcSuccess<TResult>
  | JsonRpcError
