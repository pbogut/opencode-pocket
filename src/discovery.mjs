import { EventEmitter } from "node:events"
import { networkInterfaces } from "node:os"
import { Bonjour } from "bonjour-service"

const SERVICE_NAME = /^opencode-(\d+)$/

function normalizeAddress(value) {
  return value?.replace(/^::ffff:/, "").split("%")[0] || ""
}

export function localAddresses(interfaces = networkInterfaces()) {
  const addresses = new Set(["127.0.0.1", "::1"])
  for (const items of Object.values(interfaces)) {
    for (const item of items || []) addresses.add(normalizeAddress(item.address))
  }
  return addresses
}

export function openCodeService(service, addresses = localAddresses()) {
  const match = service?.type === "http" && service?.protocol !== "udp" && service?.name?.match(SERVICE_NAME)
  if (!match || Number(service.port) !== Number(match[1])) return null
  const advertised = [...(service.addresses || []), service.referer?.address].map(normalizeAddress).filter(Boolean)
  if (advertised.length && !advertised.some((address) => addresses.has(address))) return null
  return {
    url: `http://127.0.0.1:${service.port}`,
    serviceName: service.name,
    port: Number(service.port),
  }
}

export class OpenCodeDiscovery extends EventEmitter {
  constructor(options = {}) {
    super()
    this.Bonjour = options.Bonjour || Bonjour
    this.addresses = options.addresses || localAddresses()
    this.bonjour = null
    this.browser = null
    this.timer = null
  }

  start() {
    if (this.browser) return
    this.bonjour = new this.Bonjour({}, (error) => this.emit("error", error))
    this.browser = this.bonjour.find({ type: "http", protocol: "tcp" }, (service) => {
      const endpoint = openCodeService(service, this.addresses)
      if (endpoint) this.emit("up", endpoint)
    })
    this.browser.on("down", (service) => {
      const endpoint = openCodeService(service, this.addresses)
      if (endpoint) this.emit("down", endpoint)
    })
    this.timer = setInterval(() => {
      this.browser?.expire()
      this.browser?.update()
    }, 5_000)
    this.timer.unref?.()
  }

  stop() {
    clearInterval(this.timer)
    this.timer = null
    this.browser?.stop()
    this.browser = null
    this.bonjour?.destroy()
    this.bonjour = null
  }
}
