export function createEventStream(createSource, listeners) {
  let source = null
  let generation = 0

  function connect() {
    if (source) return false
    const next = createSource()
    const currentGeneration = ++generation
    source = next

    for (const [type, listener] of Object.entries(listeners)) {
      next.addEventListener(type, (event) => {
        if (source !== next || generation !== currentGeneration) return
        listener(event)
      })
    }
    return true
  }

  function disconnect() {
    if (!source) return false
    const previous = source
    source = null
    generation += 1
    previous.close()
    return true
  }

  return { connect, disconnect }
}

export function createLatestRequest(request) {
  let active = null

  function cancel() {
    const previous = active
    active = null
    previous?.abort()
  }

  async function run(...args) {
    cancel()
    const controller = new AbortController()
    active = controller
    try {
      const result = await request(controller.signal, ...args)
      return active === controller ? result : undefined
    } catch (error) {
      if (active !== controller || error?.name === "AbortError") return undefined
      throw error
    } finally {
      if (active === controller) active = null
    }
  }

  return { run, cancel }
}
