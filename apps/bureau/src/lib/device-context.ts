/**
 * The paired device that authorized the request being served. `authorize`
 * resolves it once per `/mcp` request; tools that touch sessions or cookies read
 * it back (per-device grants) without every handler threading a parameter.
 */

import { AsyncLocalStorage } from "node:async_hooks"

export interface DeviceIdentity {
  /** The AIP-59 device fingerprint: the key per-device grants are stored under. */
  fingerprint: string
  name: string
  /** True when the device reached Bureau over a remote paired channel. */
  remote?: boolean
}

const storage = new AsyncLocalStorage<DeviceIdentity>()

export function runAsDevice<T>(device: DeviceIdentity, fn: () => T): T {
  return storage.run(device, fn)
}

/** The device of the request in flight, or undefined outside a device-authorized request. */
export function currentDevice(): DeviceIdentity | undefined {
  return storage.getStore()
}
