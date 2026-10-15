export function sseEvent(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`
}

export class SSEClient {
  constructor(response, onClose = () => {}) {
    this.response = response
    this.onClose = onClose
    this.blocked = false
    this.pending = null
    this.closed = false
    this.handleDrain = () => this.drain()
    response.on("drain", this.handleDrain)
  }

  write(frame) {
    if (this.closed) return false
    if (this.blocked) {
      if (this.pending === null) {
        this.pending = frame
        return true
      }
      this.destroy()
      return false
    }

    try {
      if (!this.response.write(frame)) this.blocked = true
      return true
    } catch {
      this.destroy()
      return false
    }
  }

  drain() {
    if (this.closed) return
    this.blocked = false
    if (this.pending === null) return
    const frame = this.pending
    this.pending = null
    this.write(frame)
  }

  finish(method) {
    if (this.closed) return false
    this.closed = true
    this.pending = null
    this.response.off("drain", this.handleDrain)
    this.onClose()
    method?.call(this.response)
    return true
  }

  detach() {
    return this.finish()
  }

  end() {
    return this.finish(this.response.end)
  }

  destroy() {
    return this.finish(this.response.destroy)
  }
}
