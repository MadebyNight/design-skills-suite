export class JobStore {
  #jobs = new Map()

  create(job) {
    this.#jobs.set(job.jobId, structuredClone(job))
    return this.get(job.jobId)
  }

  get(jobId) {
    return this.#jobs.has(jobId) ? structuredClone(this.#jobs.get(jobId)) : null
  }

  list(predicate = () => true) {
    return [...this.#jobs.values()]
      .filter(job => predicate(job))
      .map(job => structuredClone(job))
  }

  transition(jobId, status, patch = {}) {
    const job = this.get(jobId)
    if (!job) return null
    const next = { ...job, ...patch, status }
    this.#jobs.set(jobId, next)
    return structuredClone(next)
  }

  listWaitingForModel(modelId) {
    return this.list(job => job.kind === 'analysis' && job.status === 'waiting_for_model' && job.modelId === modelId)
  }

  requeueWaitingForModel(modelId) {
    return this.listWaitingForModel(modelId)
      .map(job => this.transition(job.jobId, 'queued'))
  }

  clear() {
    this.#jobs.clear()
  }
}
