export class Modality {
  constructor(config) {
    if (config && config.attention && config.cognition) {
      this._attention = config.attention
      this._cognition = config.cognition
      this._mode = 'attention'
      this._isModal = true
    } else {
      this._attention = null
      this._cognition = null
      this._mode = null
      this._isModal = false
    }
  }

  get isModal() {
    return this._isModal
  }

  get mode() {
    return this._mode
  }

  get model() {
    if (!this._isModal) return null
    return this._mode === 'attention' ? this._attention : this._cognition
  }

  stepUp(reason) {
    const previous = this._mode
    if (this._isModal) this._mode = 'cognition'
    return { previous, current: this._mode }
  }

  stepDown(reason) {
    const previous = this._mode
    if (this._isModal) this._mode = 'attention'
    return { previous, current: this._mode }
  }

  toolDefinitions() {
    return [
      {
        name: 'step_up',
        description:
          'Shift from attention mode to cognition mode. Call this when you are being directly addressed, need to engage substantively, or the moment calls for your full voice and personality. This re-runs the current turn with a more capable model.',
        input_schema: {
          type: 'object',
          properties: {
            reason: {
              type: 'string',
              description: 'Why you are shifting to cognition mode.',
            },
          },
          required: ['reason'],
        },
      },
      {
        name: 'step_down',
        description:
          'Shift from cognition mode back to attention mode. Call this when the conversation has gone quiet, the thread has shifted to other participants, or monitoring mode is sufficient. Takes effect on the next turn.',
        input_schema: {
          type: 'object',
          properties: {
            reason: {
              type: 'string',
              description: 'Why you are shifting back to attention mode.',
            },
          },
          required: ['reason'],
        },
      },
    ]
  }

  executeTool(name, input) {
    if (name === 'step_up') {
      const previous = this._mode
      const { current } = this.stepUp(input.reason)
      const changed = previous !== current
      return {
        output: `Shifted from ${previous} to ${current}. Reason: ${input.reason}`,
        _stepUp: changed,
      }
    }

    if (name === 'step_down') {
      const previous = this._mode
      const { current } = this.stepDown(input.reason)
      return {
        output: `Shifted from ${previous} to ${current}. Reason: ${input.reason}`,
      }
    }

    return null
  }
}
